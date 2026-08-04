mod native;

use futures_util::FutureExt;
use native::gpu_selector_perf::{
    GpuSelectorPerfArmResultV1, GpuSelectorPerfArmV1, GpuSelectorPerfCommitV1, GpuSelectorPerfHost,
    GpuSelectorPerfSampleV1,
};
use native::gpu_switch::{
    GpuSwitchService, NativeGpuSwitchAcquireV1, NativeGpuSwitchActualPriceV1,
    NativeGpuSwitchBeginV1, NativeGpuSwitchConfirmAttemptV1,
    NativeGpuSwitchForegroundGrantRequestV1, NativeGpuSwitchForegroundGrantV1,
    NativeGpuSwitchFreshWorkerV1, NativeGpuSwitchKeyV1, NativeGpuSwitchLeaseV1,
    NativeGpuSwitchPhaseV1, NativeGpuSwitchPrepareTargetV1, NativeGpuSwitchProviderCreateIntentV1,
    NativeGpuSwitchProviderReconcileReasonV1, NativeGpuSwitchProviderReconcileV1,
    NativeGpuSwitchReplacementDeleteReasonV1, NativeGpuSwitchReplacementDeleteV1,
    NativeGpuSwitchSnapshotV1, NativeGpuSwitchTerminalProofV1, NativeGpuSwitchTerminalReasonV1,
    NativeGpuSwitchWorkerBindingV1, NativeGpuSwitchWorkerCreateIntentV1,
    NativeGpuSwitchWorkerSyncV1,
};
use native::profile_control::{profile_control_lease_busy, ProfileControlLease};
use native::queue::QueueItemPayloadPurpose;
use native::queue_release_smoke::QueueReleaseProviderMutationKind;
use native::runpod::{NativeRunPodDeleteDispositionV1, NativeRunPodMutationKind};
use native::trusted_input::TrustedInputBroker;
use native::worker::{
    gpu_switch_runtime_identity_sha256, NativeWorkerGpuSwitchCreateRequestV1,
    NativeWorkerGpuSwitchCreateResultV1, NativeWorkerGpuSwitchOwnerActionResultV1,
    NativeWorkerGpuSwitchOwnerActionV1, NativeWorkerGpuSwitchOwnerLookupResultV1,
    NativeWorkerGpuSwitchPublicLookupResultV1, NativeWorkerGpuSwitchRuntimeIdentityResultV1,
    NativeWorkerGpuSwitchStateV1,
};
use native::{
    CredentialKind, CredentialMetadata, CredentialVault, DestinationMetadata, DestinationSelection,
    DestinationStore, DownloadReceipt, DownloadRequest, Downloader, ExportArtifactRequest,
    GpuInventoryService, GpuPodService, KeyringVault, LocalArtifactResponse, NativeAlertInput,
    NativeAlertResult, NativeAutoGpuStartV1, NativeError, NativeGpuInventorySnapshotV1,
    NativeGpuNormalStopResultV1, NativeGpuNormalStopV1, NativeManualGpuActualPriceV1,
    NativeManualGpuStartResultV1, NativeManualGpuStartV1, NativePowerInput, NativePowerState,
    NativeQueueCommitV1, NativeQueueDispatchPayloadV1, NativeQueueItemKey,
    NativeQueueReleaseSmokeInput, NativeQueueReleaseSmokeResultV1, NativeQueueResetInput,
    NativeQueueSnapshotV1, NativeResult, NativeRunKey, NativeRunnerLease,
    NativeTwoClientSmokeInput, QueueReleaseSmokeHost, QueueStore, ReceiptLedger,
    RunPodCreateMarkerMetadata, RunPodTransport, WorkerApi, WorkerHttpResponse,
    WorkerPreviewResponse, WorkerSession,
};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
use tauri::State;
use tauri::WebviewUrl;
use tauri::{AppHandle, Manager, WebviewWindow, WindowEvent};
use tauri_plugin_notification::{NotificationExt, PermissionState};
use uuid::Uuid;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppEnvironment {
    platform: &'static str,
    release_channel: &'static str,
    native_core: bool,
}

#[derive(Clone)]
struct NativeState {
    vault: Arc<dyn CredentialVault>,
    destination: DestinationStore,
    session: WorkerSession,
    runpod: RunPodTransport,
    gpu_inventory: GpuInventoryService,
    gpu_pod: GpuPodService,
    gpu_start_foreground: StartForegroundGate,
    trusted_input: TrustedInputBroker,
    gpu_switch: GpuSwitchService,
    worker: WorkerApi,
    downloader: Downloader,
    queue: QueueStore,
    queue_release_smoke: Option<QueueReleaseSmokeHost>,
    gpu_selector_perf: GpuSelectorPerfHost,
    control_gate: Arc<tokio::sync::Mutex<()>>,
}

/// Process-private Stop continuation binding. The cross-process
/// `profile-control.lock` lease owns the long transaction; this value makes
/// each short Tokio-gate recheck reject a local profile/reset or stale command
/// before its Finalize/DELETE socket boundary.
#[derive(Clone)]
struct NormalStopProfileReservation {
    process_epoch_id: String,
    profile_generation: u64,
}

impl NativeState {
    fn new() -> NativeResult<Self> {
        let queue_release_smoke = QueueReleaseSmokeHost::from_environment()?;
        let vault: Arc<dyn CredentialVault> = Arc::new(KeyringVault);
        let destination = DestinationStore::new()?;
        if let Some(smoke) = &queue_release_smoke {
            // The release harness is the only mode that may bind an output
            // root without a chooser click, and only after its environment
            // was checked for an isolated installed-app smoke process.
            destination.validate_and_bind(smoke.destination_root())?;
        }
        let session = WorkerSession::default();
        let runpod = RunPodTransport::new(vault.clone())?;
        if let Some(smoke) = &queue_release_smoke {
            let smoke = smoke.clone();
            runpod.set_native_mutation_hook(Some(Arc::new(move |kind| {
                smoke.record_provider_mutation(match kind {
                    NativeRunPodMutationKind::Create => QueueReleaseProviderMutationKind::Create,
                    NativeRunPodMutationKind::Delete => QueueReleaseProviderMutationKind::Delete,
                })
            })))?;
        }
        let gpu_inventory = GpuInventoryService::new()?;
        let gpu_pod = GpuPodService::new(gpu_inventory.process_epoch_id());
        let trusted_input = TrustedInputBroker::default();
        let gpu_start_foreground =
            StartForegroundGate::new(gpu_inventory.process_epoch_id(), trusted_input.clone());
        let gpu_switch = GpuSwitchService::new(gpu_inventory.process_epoch_id().to_owned())?;
        let worker = WorkerApi::new(vault.clone(), session.clone())?;
        let downloader = Downloader::new(worker.clone(), destination.clone());
        let queue = QueueStore::new(destination.clone())?;
        let gpu_selector_perf = GpuSelectorPerfHost::from_environment()?;
        Ok(Self {
            vault,
            destination,
            session,
            runpod,
            gpu_inventory,
            gpu_pod,
            gpu_start_foreground,
            trusted_input,
            gpu_switch,
            worker,
            downloader,
            queue,
            queue_release_smoke,
            gpu_selector_perf,
            control_gate: Arc::new(tokio::sync::Mutex::new(())),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GpuStartForegroundAction {
    Auto,
    Selected,
    ConfirmActualPrice,
    SwitchBegin,
    SwitchResume,
}

impl GpuStartForegroundAction {
    fn affirmative_label(self) -> &'static str {
        match self {
            Self::Auto => "Start Auto GPU",
            Self::Selected => "Start selected GPU",
            Self::ConfirmActualPrice => "Accept actual price",
            Self::SwitchBegin => "Switch GPU",
            Self::SwitchResume => "Resume GPU switch",
        }
    }
}

#[derive(Debug, Clone)]
struct StartForegroundPermit {
    id: String,
    action: GpuStartForegroundAction,
    input_sha256: String,
    window_label: String,
    process_epoch_id: String,
    issued_at: Instant,
}

#[derive(Clone)]
struct StartForegroundGate {
    pending: Arc<Mutex<Option<StartForegroundPermit>>>,
    process_epoch_id: String,
    trusted_input: TrustedInputBroker,
    #[cfg(test)]
    test_decision: Arc<Mutex<Option<bool>>>,
}

impl StartForegroundGate {
    fn new(process_epoch_id: String, trusted_input: TrustedInputBroker) -> Self {
        Self {
            pending: Arc::new(Mutex::new(None)),
            process_epoch_id,
            trusted_input,
            #[cfg(test)]
            test_decision: Arc::new(Mutex::new(None)),
        }
    }

    fn request(
        &self,
        window: &WebviewWindow,
        action: GpuStartForegroundAction,
        input_sha256: String,
        description: String,
    ) -> NativeResult<StartForegroundPermit> {
        require_main_gpu_window(window)?;
        if !window_is_foreground(window)? {
            return Err(gpu_start_foreground_required());
        }
        // Consume the native activation before opening the modal confirmation;
        // a user may deliberate longer than the one-second serial lifetime.
        // The post-dialog foreground check below still prevents a background
        // or focus-stolen confirmation from minting authority.
        let _activation_kind = self.trusted_input.consume(window.label(), Instant::now())?;
        let accepted = self.show_native_confirmation(window, action, &description);
        if !accepted || !window_is_foreground(window)? {
            self.trusted_input.invalidate();
            return Err(gpu_start_foreground_required());
        }
        let permit = StartForegroundPermit {
            id: Uuid::new_v4().to_string(),
            action,
            input_sha256,
            window_label: window.label().to_owned(),
            process_epoch_id: self.process_epoch_id.clone(),
            issued_at: Instant::now(),
        };
        *self
            .pending
            .lock()
            .map_err(|_| gpu_start_foreground_required())? = Some(permit.clone());
        Ok(permit)
    }

    fn consume(
        &self,
        permit: &StartForegroundPermit,
        window: &WebviewWindow,
        action: GpuStartForegroundAction,
        input_sha256: &str,
    ) -> NativeResult<()> {
        let stored = self
            .pending
            .lock()
            .map_err(|_| gpu_start_foreground_required())?
            .take()
            .ok_or_else(gpu_start_foreground_required)?;
        if stored.id != permit.id
            || stored.action != action
            || stored.input_sha256 != input_sha256
            || stored.window_label != window.label()
            || stored.process_epoch_id != self.process_epoch_id
            || stored.issued_at.elapsed() >= Duration::from_secs(5)
            || !window_is_foreground(window)?
        {
            return Err(gpu_start_foreground_required());
        }
        Ok(())
    }

    /// A failed read-only final preflight leaves no reachable authority, but
    /// clearing the matching slot makes that fact explicit and prevents an
    /// accepted dialog from surviving until a later command overwrites it.
    fn clear(&self, permit: &StartForegroundPermit) {
        if let Ok(mut pending) = self.pending.lock() {
            if pending
                .as_ref()
                .is_some_and(|stored| stored.id == permit.id)
            {
                *pending = None;
            }
        }
    }

    fn show_native_confirmation(
        &self,
        window: &WebviewWindow,
        action: GpuStartForegroundAction,
        description: &str,
    ) -> bool {
        #[cfg(test)]
        if let Ok(mut decision) = self.test_decision.lock() {
            if let Some(accepted) = decision.take() {
                return accepted;
            }
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            use rfd::{MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
            let title = match action {
                GpuStartForegroundAction::SwitchBegin | GpuStartForegroundAction::SwitchResume => {
                    "Confirm ImageForge GPU switch"
                }
                _ => "Confirm ImageForge GPU start",
            };
            let result = MessageDialog::new()
                .set_title(title)
                .set_description(description)
                .set_level(MessageLevel::Warning)
                .set_buttons(MessageButtons::OkCancelCustom(
                    action.affirmative_label().to_owned(),
                    "Cancel".to_owned(),
                ))
                .set_parent(window)
                .show();
            return matches!(result, MessageDialogResult::Ok)
                || matches!(result, MessageDialogResult::Custom(value) if value == action.affirmative_label());
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (window, action, description);
            false
        }
    }

    #[cfg(test)]
    fn set_test_decision(&self, accepted: bool) {
        *self.test_decision.lock().expect("test foreground lock") = Some(accepted);
    }
}

fn window_is_foreground(window: &WebviewWindow) -> NativeResult<bool> {
    Ok(window
        .is_visible()
        .map_err(|_| gpu_start_foreground_required())?
        && window
            .is_focused()
            .map_err(|_| gpu_start_foreground_required())?
        && !window
            .is_minimized()
            .map_err(|_| gpu_start_foreground_required())?)
}

fn gpu_start_foreground_required() -> NativeError {
    NativeError::new(
        "gpu_start_foreground_required",
        "Use the focused ImageForge Start control to authorize this GPU action.",
    )
}

#[tauri::command]
fn app_environment() -> AppEnvironment {
    AppEnvironment {
        platform: std::env::consts::OS,
        release_channel: "native-beta",
        native_core: true,
    }
}

#[tauri::command]
async fn credential_metadata(
    state: State<'_, NativeState>,
) -> NativeResult<Vec<CredentialMetadata>> {
    let vault = state.vault.clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(vec![
            vault.metadata(CredentialKind::RunpodApiKey)?,
            vault.metadata(CredentialKind::WorkerToken)?,
        ])
    })
    .await
    .map_err(|_| {
        NativeError::new(
            "native_task_failed",
            "Credential status could not be loaded.",
        )
    })?
}

#[tauri::command]
async fn replace_credential(
    state: State<'_, NativeState>,
    kind: CredentialKind,
    value: String,
) -> NativeResult<CredentialMetadata> {
    let vault = state.vault.clone();
    tauri::async_runtime::spawn_blocking(move || vault.replace(kind, &value))
        .await
        .map_err(|_| NativeError::new("native_task_failed", "The credential could not be saved."))?
}

#[tauri::command]
async fn choose_destination(
    state: State<'_, NativeState>,
    default_path: String,
) -> NativeResult<Option<DestinationSelection>> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let mut dialog =
            rfd::AsyncFileDialog::new().set_title("Choose ImageForge downloads folder");
        let default = PathBuf::from(default_path);
        if default.is_dir() {
            dialog = dialog.set_directory(default);
        }
        let Some(folder) = dialog.pick_folder().await else {
            return Ok(None);
        };
        let selected = folder.path().to_path_buf();
        let destination = state.destination.clone();
        tauri::async_runtime::spawn_blocking(move || destination.authorize_selected(&selected))
            .await
            .map_err(|_| {
                NativeError::new(
                    "native_task_failed",
                    "The destination could not be verified.",
                )
            })?
            .map(Some)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (state, default_path);
        Err(NativeError::new(
            "platform_unsupported",
            "Native folder selection is available in the macOS and Windows apps.",
        ))
    }
}

#[tauri::command]
async fn validate_destination(
    state: State<'_, NativeState>,
    path: String,
    chooser_grant: String,
) -> NativeResult<DestinationMetadata> {
    let destination = state.destination.clone();
    tauri::async_runtime::spawn_blocking(move || {
        destination.validate_selected(Path::new(&path), &chooser_grant)
    })
    .await
    .map_err(|_| {
        NativeError::new(
            "native_task_failed",
            "The destination could not be verified.",
        )
    })?
}

#[tauri::command]
async fn restore_destination(
    state: State<'_, NativeState>,
) -> NativeResult<Option<DestinationMetadata>> {
    let destination = state.destination.clone();
    tauri::async_runtime::spawn_blocking(move || destination.restore())
        .await
        .map_err(|_| {
            NativeError::new(
                "native_task_failed",
                "The saved destination could not be restored.",
            )
        })?
}

#[tauri::command]
async fn reveal_destination(
    state: State<'_, NativeState>,
    relative_path: Option<String>,
) -> NativeResult<()> {
    let destination = state.destination.clone();
    tauri::async_runtime::spawn_blocking(move || destination.reveal(relative_path.as_deref()))
        .await
        .map_err(|_| {
            NativeError::new(
                "native_task_failed",
                "The destination could not be revealed.",
            )
        })?
}

#[tauri::command]
async fn write_manifest(
    state: State<'_, NativeState>,
    batch_id: String,
    content: String,
) -> NativeResult<String> {
    let destination = state.destination.clone();
    tauri::async_runtime::spawn_blocking(move || destination.write_manifest(&batch_id, &content))
        .await
        .map_err(|_| NativeError::new("native_task_failed", "The manifest could not be written."))?
}

#[tauri::command]
async fn bind_worker_session(state: State<'_, NativeState>, pod_id: String) -> NativeResult<Value> {
    let _control = state.control_gate.lock().await;
    state.runpod.assert_verified_pod(&pod_id)?;
    serde_json::to_value(state.session.bind_verified(&pod_id).await?).map_err(|_| {
        NativeError::new(
            "native_serialization_failed",
            "Worker session metadata could not be encoded.",
        )
    })
}

#[tauri::command]
async fn clear_worker_session(state: State<'_, NativeState>) -> NativeResult<()> {
    let _control = state.control_gate.lock().await;
    state.session.clear().await
}

#[tauri::command]
async fn bind_runpod_profile(
    state: State<'_, NativeState>,
    template_id: String,
    network_volume_id: String,
) -> NativeResult<()> {
    // Profile binding invalidates every native lifecycle receipt.  It must use
    // the same cross-process lease as Start, Stop, Switch, and the queue so a
    // sibling cannot rebind while one of those actions has captured a profile
    // generation for a final provider/worker boundary.
    let _profile_control_lease = acquire_profile_control_lease().await?;
    with_gpu_profile_control(state.control_gate.as_ref(), || {
        state.gpu_switch.veto_normal_stop_from_disk()
    })
    .await?;
    state.session.clear().await?;
    with_gpu_profile_control(state.control_gate.as_ref(), || {
        // Re-read the durable Switch reservation immediately before mutating
        // the bound profile.  The first check above rejects a sibling's
        // transaction before session reset; this second check closes the local
        // asynchronous seam while the OS lease remains held.
        state.gpu_switch.veto_normal_stop_from_disk()?;
        state
            .runpod
            .bind_profile(&template_id, &network_volume_id)?;
        // A profile bind is the explicit process-local lifecycle reset seam.
        // The transport has already cleared its verified registry; clear
        // selector receipts and Pod observation history together so no
        // prior-profile row can be reused for Start, Stop, or Switch
        // authority. Pod observation owns the generation gate used by its
        // final selector join, so advance it before clearing selector
        // evidence.
        state.gpu_pod.reset_for_profile_binding()?;
        state.gpu_inventory.reset_for_profile_binding()
    })
    .await
}

#[tauri::command]
async fn authorize_runpod_create(state: State<'_, NativeState>) -> NativeResult<String> {
    let _control = state.control_gate.lock().await;
    state.runpod.authorize_create()
}

#[tauri::command]
async fn authorize_emergency_gpu(state: State<'_, NativeState>) -> NativeResult<String> {
    let _control = state.control_gate.lock().await;
    state.runpod.authorize_emergency_gpu()
}

#[tauri::command]
async fn clear_runpod_start_authorization(state: State<'_, NativeState>) -> NativeResult<()> {
    let _control = state.control_gate.lock().await;
    state.runpod.clear_start_authorization()
}

#[tauri::command]
fn runpod_create_marker_metadata(
    state: State<'_, NativeState>,
) -> NativeResult<RunPodCreateMarkerMetadata> {
    state.runpod.create_marker_metadata()
}

#[tauri::command]
async fn resolve_runpod_create_marker(
    state: State<'_, NativeState>,
    attempt_id: String,
    reconciled_pod_id: Option<String>,
) -> NativeResult<()> {
    let _control = state.control_gate.lock().await;
    state
        .runpod
        .resolve_create_marker(&attempt_id, reconciled_pod_id.as_deref())
}

/// Return the last native-owned inventory projection. This command is read
/// only: renderer polling cannot trigger provider catalog reads.
#[tauri::command]
fn gpu_inventory_load(
    window: WebviewWindow,
    state: State<'_, NativeState>,
) -> NativeResult<NativeGpuInventorySnapshotV1> {
    require_main_gpu_window(&window)?;
    state.gpu_inventory.load()
}

/// Arm one installed-only selector performance sample.  The native host
/// rejects this command unless the process was started with the explicit,
/// artifact-bound QA session; production launches never expose a timer or
/// sample authority to the renderer.
#[tauri::command]
fn gpu_selector_perf_arm(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: GpuSelectorPerfArmV1,
) -> NativeResult<GpuSelectorPerfArmResultV1> {
    state.gpu_selector_perf.arm(&window, input)
}

/// Commit one native-started selector performance sample after the harness's
/// double-rAF callback.  Duration and build identity are native-owned; the
/// renderer supplies only the strict ordered mounted-row projection.
#[tauri::command]
fn gpu_selector_perf_commit(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: GpuSelectorPerfCommitV1,
) -> NativeResult<GpuSelectorPerfSampleV1> {
    state.gpu_selector_perf.commit(&window, input)
}

/// Start exactly one native-coalesced catalog observation. The two provider
/// GETs are launched by the native service; the terminal projection is emitted
/// only on the app-scoped `gpu-inventory-v1` channel.
#[tauri::command]
fn gpu_inventory_begin_refresh(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, NativeState>,
    include_emergency_tier: bool,
) -> NativeResult<NativeGpuInventorySnapshotV1> {
    require_main_gpu_window(&window)?;
    state
        .gpu_inventory
        .begin_refresh(app, state.runpod.clone(), include_emergency_tier)
}

/// The sole renderer-visible current-Pod read. It is profile-scoped and
/// coalesced natively; it deliberately does not read catalog inventory, mint
/// a receipt/grant, or expose a provider URL/body to the renderer.
#[tauri::command]
async fn gpu_pod_observe(
    window: WebviewWindow,
    state: State<'_, NativeState>,
) -> NativeResult<native::NativeGpuPodObservationV1> {
    require_main_gpu_window(&window)?;
    // The Pod observer is read-only, but it still owns one profile-scoped
    // provider GET and lifecycle generation.  Taking the same OS lease keeps
    // a second desktop process from starting a heartbeat between an admitted
    // Stop's R+1 and R+2 observations.
    let _profile_control_lease = acquire_profile_control_lease().await?;
    state
        .gpu_pod
        .observe(state.gpu_inventory.clone(), state.runpod.clone())
        .await
}

/// Read the exact persisted input of an ordinary Stop only after it crossed
/// the durable mutation/ambiguity boundary. This is a private-store lookup:
/// it performs no worker or provider request and cannot recover a preflight
/// into a DELETE-capable action.
#[tauri::command]
fn gpu_normal_stop_load(
    window: WebviewWindow,
    state: State<'_, NativeState>,
) -> NativeResult<Option<NativeGpuNormalStopV1>> {
    require_main_gpu_window(&window)?;
    state.gpu_pod.load_normal_stop_recovery()
}

/// The sole native owner of ordinary coordinated Stop deletion. The renderer
/// supplies a strict compare-and-swap intent only; private worker
/// finalization, one-use RunPod authority, and the durable Stop journal stay
/// below this IPC boundary.
#[tauri::command]
async fn gpu_normal_stop(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: NativeGpuNormalStopV1,
) -> NativeResult<NativeGpuNormalStopResultV1> {
    require_main_gpu_window(&window)?;
    native::gpu_pod::validate_normal_stop_input(&input)?;
    // This pure in-memory admission check must precede the profile lease and
    // every Switch/Stop store access. A MAX-1/MAX request cannot reserve the
    // required R+1/R+2 observations, while an old completed replay remains
    // eligible for the later exact journal lookup.
    state
        .gpu_pod
        .assert_new_normal_stop_budget_before_profile_lease(&input)?;
    let Some(_profile_control_lease) = ProfileControlLease::try_acquire().await? else {
        return Err(profile_control_lease_busy());
    };
    let control_gate = state.control_gate.clone();
    let gpu_switch = state.gpu_switch.clone();
    let gpu_pod = state.gpu_pod.clone();
    let gpu_inventory = state.gpu_inventory.clone();
    let runpod = state.runpod.clone();
    let worker = state.worker.clone();
    let reservation =
        capture_normal_stop_profile_reservation(&gpu_inventory, &gpu_pod, &gpu_switch, &runpod)?;

    // The file lease remains held through the transaction. This Tokio gate is
    // deliberately only a short same-process reread; it is never held across
    // a worker or provider socket.
    with_gpu_profile_control(control_gate.as_ref(), || {
        validate_normal_stop_profile_epoch(
            &reservation,
            &gpu_inventory,
            &gpu_pod,
            &gpu_switch,
            &runpod,
        )?;
        gpu_switch.veto_normal_stop_from_disk()
    })
    .await?;

    let expected_input = input.clone();
    let mutation_control_gate = control_gate.clone();
    let mutation_gpu_switch = gpu_switch.clone();
    let mutation_gpu_pod = gpu_pod.clone();
    let mutation_gpu_inventory = gpu_inventory.clone();
    let mutation_runpod = runpod.clone();
    let mutation_check: native::gpu_pod::NativeNormalStopMutationCheckV1 =
        Arc::new(move |_boundary, context| {
            let control_gate = mutation_control_gate.clone();
            let gpu_switch = mutation_gpu_switch.clone();
            let gpu_pod = mutation_gpu_pod.clone();
            let gpu_inventory = mutation_gpu_inventory.clone();
            let runpod = mutation_runpod.clone();
            let reservation = reservation.clone();
            let expected_input = expected_input.clone();
            async move {
                with_gpu_profile_control(control_gate.as_ref(), || {
                    validate_normal_stop_mutation_context(&expected_input, &context)?;
                    validate_normal_stop_profile_epoch(
                        &reservation,
                        &gpu_inventory,
                        &gpu_pod,
                        &gpu_switch,
                        &runpod,
                    )?;
                    // This reload validates CURRENT, retained generations and
                    // both queue-reservation copies under the held native OS
                    // lease, rather than trusting this process's startup view.
                    gpu_switch.veto_normal_stop_from_disk()
                })
                .await
            }
            .boxed()
        });

    gpu_pod
        .normal_stop(gpu_inventory, runpod, worker, input, mutation_check)
        .await
}

/// Read the private ordinary-Start recovery projection without network I/O.
#[tauri::command]
fn gpu_start_load(
    window: WebviewWindow,
    state: State<'_, NativeState>,
) -> NativeResult<Option<NativeManualGpuStartResultV1>> {
    require_main_gpu_window(&window)?;
    state.gpu_inventory.start_load()
}

/// Exact selected-GPU Start. The caller supplies only a prior safe quote;
/// native revalidates it through a fresh inventory/profile observation before
/// any create request and keeps grants/body/provider transport private.
#[tauri::command]
async fn gpu_start_selected(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: NativeManualGpuStartV1,
) -> NativeResult<NativeManualGpuStartResultV1> {
    let input_sha256 = native::gpu_inventory::start_input_sha256(&input)?;
    let permit = state.gpu_start_foreground.request(
        &window,
        GpuStartForegroundAction::Selected,
        input_sha256.clone(),
        format!(
            "Start selected GPU: {} at {} micro-USD per hour. One billed RunPod GPU may be created.",
            input.target_gpu_id, input.confirmed_hourly_price_micro_usd
        ),
    )?;
    // Never hold the profile lease while a native confirmation dialog is
    // waiting for the user.  Once accepted, the lease covers final inventory
    // reads, the durable Start intent, and the one provider POST.
    let _profile_control_lease = match acquire_profile_control_lease().await {
        Ok(lease) => lease,
        Err(error) if error.code == "gpu_switch_lease_busy" => {
            state.gpu_start_foreground.clear(&permit);
            return Err(gpu_start_operation_in_progress());
        }
        Err(error) => {
            state.gpu_start_foreground.clear(&permit);
            return Err(error);
        }
    };
    let gpu_switch = state.gpu_switch.clone();
    if let Err(error) = with_gpu_profile_control(state.control_gate.as_ref(), || {
        gpu_switch.veto_normal_stop_from_disk()
    })
    .await
    {
        state.gpu_start_foreground.clear(&permit);
        return Err(error);
    }
    let inventory = state.gpu_inventory.clone();
    let runpod = state.runpod.clone();
    let foreground = state.gpu_start_foreground.clone();
    let permit_for_consume = permit.clone();
    let window_for_consume = window.clone();
    let input_sha256_for_consume = input_sha256.clone();
    let final_gpu_switch = state.gpu_switch.clone();
    let result = inventory
        .start_selected(app, runpod, input, move || {
            // This is the final durable Switch/reservation reread before the
            // Start service persists its create intent and reaches RunPod.
            final_gpu_switch.veto_normal_stop_from_disk()?;
            foreground.consume(
                &permit_for_consume,
                &window_for_consume,
                GpuStartForegroundAction::Selected,
                &input_sha256_for_consume,
            )
        })
        .await;
    if result.is_err() {
        state.gpu_start_foreground.clear(&permit);
    }
    result
}

/// Receipt-bound Auto Start. Native computes the candidate order itself; no
/// renderer GPU list, provider URL, body, or mutation token is accepted.
#[tauri::command]
async fn gpu_start_auto(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: NativeAutoGpuStartV1,
) -> NativeResult<NativeManualGpuStartResultV1> {
    let input_sha256 = native::gpu_inventory::start_input_sha256(&input)?;
    let permit = state.gpu_start_foreground.request(
        &window,
        GpuStartForegroundAction::Auto,
        input_sha256.clone(),
        "Start Auto GPU with ImageForge's current best eligible GPU. One billed RunPod GPU may be created."
            .to_owned(),
    )?;
    let _profile_control_lease = match acquire_profile_control_lease().await {
        Ok(lease) => lease,
        Err(error) if error.code == "gpu_switch_lease_busy" => {
            state.gpu_start_foreground.clear(&permit);
            return Err(gpu_start_operation_in_progress());
        }
        Err(error) => {
            state.gpu_start_foreground.clear(&permit);
            return Err(error);
        }
    };
    let gpu_switch = state.gpu_switch.clone();
    if let Err(error) = with_gpu_profile_control(state.control_gate.as_ref(), || {
        gpu_switch.veto_normal_stop_from_disk()
    })
    .await
    {
        state.gpu_start_foreground.clear(&permit);
        return Err(error);
    }
    let inventory = state.gpu_inventory.clone();
    let runpod = state.runpod.clone();
    let foreground = state.gpu_start_foreground.clone();
    let permit_for_consume = permit.clone();
    let window_for_consume = window.clone();
    let input_sha256_for_consume = input_sha256.clone();
    let final_gpu_switch = state.gpu_switch.clone();
    let result = inventory
        .start_auto(app, runpod, input, move || {
            final_gpu_switch.veto_normal_stop_from_disk()?;
            foreground.consume(
                &permit_for_consume,
                &window_for_consume,
                GpuStartForegroundAction::Auto,
                &input_sha256_for_consume,
            )
        })
        .await;
    if result.is_err() {
        state.gpu_start_foreground.clear(&permit);
    }
    result
}

/// Accept the exact actual price of a Pod that native already created. It has
/// no provider mutation path and cannot mint a new create authorization.
#[tauri::command]
async fn gpu_start_confirm_actual_price(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: NativeManualGpuActualPriceV1,
) -> NativeResult<NativeManualGpuStartResultV1> {
    let prior = with_gpu_start_foreground(&window, || state.gpu_inventory.start_load())?;
    let (gpu_id, actual_price) = prior
        .as_ref()
        .filter(|result| result.operation_id == input.operation_id)
        .and_then(|result| {
            Some((
                result.pod.as_ref()?.gpu_id.as_str(),
                result.actual_hourly_price_micro_usd?,
            ))
        })
        .ok_or_else(gpu_start_foreground_required)?;
    let input_sha256 = native::gpu_inventory::start_input_sha256(&input)?;
    let permit = state.gpu_start_foreground.request(
        &window,
        GpuStartForegroundAction::ConfirmActualPrice,
        input_sha256.clone(),
        format!(
            "Accept actual price: {gpu_id} at {actual_price} micro-USD per hour. This accepts the actual price for one billed RunPod GPU."
        ),
    )?;
    let _profile_control_lease = match acquire_profile_control_lease().await {
        Ok(lease) => lease,
        Err(error) if error.code == "gpu_switch_lease_busy" => {
            state.gpu_start_foreground.clear(&permit);
            return Err(gpu_start_operation_in_progress());
        }
        Err(error) => {
            state.gpu_start_foreground.clear(&permit);
            return Err(error);
        }
    };
    let result = with_gpu_profile_control(state.control_gate.as_ref(), || {
        state.gpu_switch.veto_normal_stop_from_disk()?;
        state.gpu_start_foreground.consume(
            &permit,
            &window,
            GpuStartForegroundAction::ConfirmActualPrice,
            &input_sha256,
        )?;
        // This command has no provider socket, but the local Start recovery
        // journal still changes profile-scoped authority and must transition
        // under the same lease as ordinary Start.
        state.gpu_switch.veto_normal_stop_from_disk()?;
        state.gpu_inventory.confirm_actual_price(input)
    })
    .await;
    if result.is_err() {
        state.gpu_start_foreground.clear(&permit);
    }
    result
}

/// Return the durable, renderer-safe Switch projection. This command has no
/// worker or provider side effect; a relaunch can inspect a parked draft but
/// cannot regain the old process's authority from it.
#[tauri::command]
async fn gpu_switch_load(
    window: WebviewWindow,
    state: State<'_, NativeState>,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    require_main_gpu_window(&window)?;
    let _profile_control_lease = acquire_profile_control_lease().await?;
    state.gpu_switch.load()
}

/// Mint the short-lived, exact foreground grant that a later Switch begin or
/// Resume may consume. The renderer cannot assert activation or manufacture a
/// grant: the focused native confirmation is consumed before this opaque
/// service handle is returned.
#[tauri::command]
async fn gpu_switch_authorize_foreground(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: NativeGpuSwitchForegroundGrantRequestV1,
) -> NativeResult<NativeGpuSwitchForegroundGrantV1> {
    let input_sha256 = native::gpu_inventory::start_input_sha256(&input).map_err(|_| {
        NativeError::new(
            "gpu_switch_foreground_grant_invalid",
            "The GPU switch authorization request is invalid.",
        )
    })?;
    let (action, description) = match &input {
        NativeGpuSwitchForegroundGrantRequestV1::Begin(request) => (
            GpuStartForegroundAction::SwitchBegin,
            format!(
                "Request a GPU switch to {}. ImageForge will ask active collaborators for consent before any GPU is terminated.",
                request.target_gpu_id
            ),
        ),
        NativeGpuSwitchForegroundGrantRequestV1::Resume(_) => (
            GpuStartForegroundAction::SwitchResume,
            "Resume this GPU switch's read-only recovery. ImageForge will not create or terminate a GPU from this authorization alone."
                .to_owned(),
        ),
    };
    let permit =
        state
            .gpu_start_foreground
            .request(&window, action, input_sha256.clone(), description)?;
    let _profile_control_lease = match acquire_profile_control_lease().await {
        Ok(lease) => lease,
        Err(error) => {
            state.gpu_start_foreground.clear(&permit);
            return Err(error);
        }
    };
    let result = with_gpu_profile_control(state.control_gate.as_ref(), || {
        state
            .gpu_start_foreground
            .consume(&permit, &window, action, &input_sha256)?;
        state.gpu_switch.authorize_foreground(input)
    })
    .await;
    if result.is_err() {
        state.gpu_start_foreground.clear(&permit);
    }
    result
}

/// Begin a GPU switch through native-owned admission only. The public return
/// cannot expose a `planned` success: it is either the worker-bound
/// `consent_pending` record or a durable needs-attention projection. The one
/// worker POST is pinned to the existing authenticated session and has its
/// exact canonical bytes plus send boundary journaled before I/O.
#[tauri::command]
async fn gpu_switch_begin(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: NativeGpuSwitchBeginV1,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    require_main_gpu_window(&window)?;
    let evidence = state.gpu_inventory.switch_begin_evidence(
        &input.observation_id,
        &input.receipt_id,
        &input.target_gpu_id,
        input.confirmed_hourly_price_micro_usd,
    )?;

    // The profile lease covers exactly the cross-store no-gap admission
    // protocol: preflight the expected Task 013 queue generation before
    // consuming the foreground grant, then persist `prepared`, park/release
    // the owned runner, and bind the committed queue revision into `active`.
    // The durable reservation subsequently blocks sibling actions, so the
    // lease is deliberately released before the potentially slow worker
    // transport below.
    let planned = {
        let _profile_control_lease = acquire_profile_control_lease().await?;
        // `GpuSwitchService` retains an in-process projection for normal
        // transitions, but another desktop process may have committed CURRENT
        // after this service started.  Re-read CURRENT plus both reservation
        // copies before consuming the foreground grant or touching QueueStore.
        state.gpu_switch.veto_normal_stop_from_disk()?;
        let queue = state.queue.clone();
        queue.preflight_gpu_switch_park(
            input.queue_expected_store_revision,
            input.queue_run_revision.as_deref(),
        )?;
        with_gpu_profile_control(state.control_gate.as_ref(), || {
            let park_queue = queue.clone();
            with_gpu_start_foreground(&window, || {
                state.gpu_switch.begin_with_queue_park(
                    input.clone(),
                    evidence,
                    move |expected_store_revision, queue_run_revision| {
                        park_queue.park_for_gpu_switch(expected_store_revision, queue_run_revision)
                    },
                )
            })
        })
        .await?
    };
    let record = planned.record.as_ref().ok_or_else(|| {
        NativeError::new(
            "gpu_switch_worker_response_invalid",
            "The GPU switch could not prepare its native worker request.",
        )
    })?;
    let switch_id = record.switch_id.clone();
    let record_revision = record.record_revision;
    let old_pod_id = record.old_pod.pod_id.clone();
    let request = NativeWorkerGpuSwitchCreateRequestV1 {
        switch_id: switch_id.clone(),
        session_id: input.session_id.clone(),
        old_pod_id: old_pod_id.clone(),
        old_gpu_id: record.old_pod.gpu_id.clone(),
        old_gpu_display_name: record.old_pod.gpu_display_name.clone(),
        initial_target_gpu_id: record.initial_target.gpu_id.clone(),
        initial_target_gpu_display_name: record.initial_target.gpu_display_name.clone(),
        initial_replacement_attempt_id: record.initial_target.replacement_attempt_id.clone(),
        expected_batch_id: record.expected_batch_id.clone(),
        inventory_observed_at: record.initial_target.inventory_observed_at.clone(),
    };

    let profile_binding_sha256 = match state.runpod.gpu_switch_profile_binding_sha256() {
        Ok(value) => value,
        Err(_) => {
            return park_gpu_switch_with_profile_control(
                &state,
                &switch_id,
                record_revision,
                "gpu_switch_profile_locked",
            )
            .await;
        }
    };
    let prepared = match state.worker.prepare_gpu_switch_create(request).await {
        Ok(value) => value,
        Err(_) => {
            return park_gpu_switch_with_profile_control(
                &state,
                &switch_id,
                record_revision,
                "gpu_switch_worker_response_invalid",
            )
            .await;
        }
    };
    let canonical_body = match std::str::from_utf8(prepared.canonical_body()) {
        Ok(value) => value.to_owned(),
        Err(_) => {
            return park_gpu_switch_with_profile_control(
                &state,
                &switch_id,
                record_revision,
                "gpu_switch_worker_response_invalid",
            )
            .await;
        }
    };
    let intent = NativeGpuSwitchWorkerCreateIntentV1 {
        profile_binding_sha256,
        credential_binding_sha256: prepared.credential_binding_sha256().to_owned(),
        worker_session_binding_sha256: prepared.session_binding_sha256().to_owned(),
        canonical_body,
        canonical_body_sha256: prepared.canonical_body_sha256().to_owned(),
    };
    // The active reservation replaces the first profile lease while the native
    // worker request is prepared. Immediately before the sole worker-create
    // socket, reacquire the OS lease, prove CURRENT/reservation still match the
    // in-process record, and durably cross send_pending -> sent_uncertain. The
    // lease is released again before network I/O; the active reservation then
    // remains the cross-process blocker during response reconciliation.
    {
        let _profile_control_lease = acquire_profile_control_lease().await?;
        with_gpu_profile_control(state.control_gate.as_ref(), || {
            state.gpu_switch.prepare_worker_create_send_pending(
                &switch_id,
                record_revision,
                intent,
            )?;
            state
                .gpu_switch
                .mark_worker_create_sent_uncertain(&switch_id, record_revision)?;
            Ok(())
        })
        .await?;
    }

    match state.worker.execute_gpu_switch_create(prepared).await {
        Ok(NativeWorkerGpuSwitchCreateResultV1::Created(response)) => {
            bind_gpu_switch_worker_response_with_profile_control(
                &state,
                &switch_id,
                record_revision,
                NativeGpuSwitchWorkerBindingV1 {
                    requester_user_id: response.requester_user_id,
                    principal_binding_id: response.principal_binding_id,
                },
            )
            .await
        }
        Ok(NativeWorkerGpuSwitchCreateResultV1::Rejected(error)) => {
            park_definitive_gpu_switch_create_rejection(&state, &switch_id, record_revision, error)
                .await
        }
        Err(_) => {
            resolve_gpu_switch_create_uncertainty(
                &state,
                &switch_id,
                &input.session_id,
                &old_pod_id,
                record_revision,
                false,
            )
            .await
        }
    }
}

/// A complete validated worker rejection is not transport ambiguity. Persist
/// a non-replayable attention state first, then return the exact allowlisted
/// worker action code to the renderer. Unknown codes are already collapsed by
/// `native_gpu_switch_worker_rejection`.
async fn park_definitive_gpu_switch_create_rejection(
    state: &NativeState,
    switch_id: &str,
    expected_record_revision: u64,
    error: native::worker::NativeWorkerGpuSwitchErrorV1,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    let rejection = native_gpu_switch_worker_rejection(error);
    park_gpu_switch_with_profile_control(
        state,
        switch_id,
        expected_record_revision,
        "gpu_switch_worker_response_invalid",
    )
    .await?;
    Err(rejection)
}

async fn bind_gpu_switch_worker_response_with_profile_control(
    state: &NativeState,
    switch_id: &str,
    expected_record_revision: u64,
    binding: NativeGpuSwitchWorkerBindingV1,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    let _profile_control_lease = acquire_profile_control_lease().await?;
    with_gpu_profile_control(state.control_gate.as_ref(), || {
        state
            .gpu_switch
            .bind_worker_create_response(switch_id, expected_record_revision, binding)
    })
    .await
}

async fn park_gpu_switch_with_profile_control(
    state: &NativeState,
    switch_id: &str,
    expected_record_revision: u64,
    attention_code: &str,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    let _profile_control_lease = acquire_profile_control_lease().await?;
    with_gpu_profile_control(state.control_gate.as_ref(), || {
        state
            .gpu_switch
            .park_with_attention(switch_id, expected_record_revision, attention_code)
    })
    .await
}

/// Resolve worker-create ambiguity through owner lookup first. Initial create
/// response loss never replays. One explicit Resume may replay only after the
/// generic owner 404 and only after native proves the newly prepared request is
/// byte-identical to the persisted UUID/body/session/profile bindings.
async fn resolve_gpu_switch_create_uncertainty(
    state: &NativeState,
    switch_id: &str,
    session_id: &str,
    old_pod_id: &str,
    expected_record_revision: u64,
    allow_identical_replay: bool,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    let lookup = state
        .worker
        .gpu_switch_owner_lookup(switch_id, session_id, old_pod_id)
        .await;
    match lookup {
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Found(found)) => {
            bind_uncertain_gpu_switch_owner_with_profile_control(
                state,
                switch_id,
                expected_record_revision,
                found,
            )
            .await
        }
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::NotFound) if allow_identical_replay => {
            let access = {
                let _profile_control_lease = acquire_profile_control_lease().await?;
                with_gpu_profile_control(state.control_gate.as_ref(), || {
                    state
                        .gpu_switch
                        .uncertain_create_access(switch_id, expected_record_revision)
                })
                .await?
            };
            replay_identical_gpu_switch_create(state, access).await
        }
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::NotFound)
        | Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Rejected(_))
        | Err(_) => {
            park_gpu_switch_with_profile_control(
                state,
                switch_id,
                expected_record_revision,
                "gpu_switch_worker_create_uncertain",
            )
            .await
        }
    }
}

async fn bind_uncertain_gpu_switch_owner_with_profile_control(
    state: &NativeState,
    switch_id: &str,
    expected_record_revision: u64,
    owner: native::worker::NativeWorkerGpuSwitchOwnerLookupV1,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    let _profile_control_lease = acquire_profile_control_lease().await?;
    with_gpu_profile_control(state.control_gate.as_ref(), || {
        let bound = state.gpu_switch.bind_worker_create_response(
            switch_id,
            expected_record_revision,
            NativeGpuSwitchWorkerBindingV1 {
                requester_user_id: owner.requester_user_id.clone(),
                principal_binding_id: owner.principal_binding_id.clone(),
            },
        )?;
        let bound_revision = bound
            .record
            .as_ref()
            .map(|record| record.record_revision)
            .ok_or_else(|| {
                NativeError::new(
                    "gpu_switch_store_unrecoverable",
                    "GPU switch worker binding is unavailable.",
                )
            })?;
        let access = state.gpu_switch.worker_access(switch_id, bound_revision)?;
        apply_gpu_switch_owner_lookup(state, &access, owner)
    })
    .await
}

async fn replay_identical_gpu_switch_create(
    state: &NativeState,
    access: native::gpu_switch::NativeGpuSwitchUncertainCreateAccessV1,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    let request = NativeWorkerGpuSwitchCreateRequestV1 {
        switch_id: access.switch_id.clone(),
        session_id: access.session_id.clone(),
        old_pod_id: access.old_pod_id.clone(),
        old_gpu_id: access.old_gpu_id.clone(),
        old_gpu_display_name: access.old_gpu_display_name.clone(),
        initial_target_gpu_id: access.initial_target_gpu_id.clone(),
        initial_target_gpu_display_name: access.initial_target_gpu_display_name.clone(),
        initial_replacement_attempt_id: access.initial_replacement_attempt_id.clone(),
        expected_batch_id: access.expected_batch_id.clone(),
        inventory_observed_at: access.inventory_observed_at.clone(),
    };
    let profile_binding_sha256 = match state.runpod.gpu_switch_profile_binding_sha256() {
        Ok(binding) => binding,
        Err(_) => {
            return park_gpu_switch_with_profile_control(
                state,
                &access.switch_id,
                access.record_revision,
                "gpu_switch_profile_locked",
            )
            .await
        }
    };
    let prepared = match state.worker.prepare_gpu_switch_create(request).await {
        Ok(prepared) => prepared,
        Err(_) => {
            return park_gpu_switch_with_profile_control(
                state,
                &access.switch_id,
                access.record_revision,
                "gpu_switch_worker_response_invalid",
            )
            .await
        }
    };
    let canonical_body = match std::str::from_utf8(prepared.canonical_body()) {
        Ok(body) => body.to_owned(),
        Err(_) => {
            return park_gpu_switch_with_profile_control(
                state,
                &access.switch_id,
                access.record_revision,
                "gpu_switch_worker_response_invalid",
            )
            .await
        }
    };
    let replay_intent = NativeGpuSwitchWorkerCreateIntentV1 {
        profile_binding_sha256,
        credential_binding_sha256: prepared.credential_binding_sha256().to_owned(),
        worker_session_binding_sha256: prepared.session_binding_sha256().to_owned(),
        canonical_body,
        canonical_body_sha256: prepared.canonical_body_sha256().to_owned(),
    };
    let validation = {
        let _profile_control_lease = acquire_profile_control_lease().await?;
        with_gpu_profile_control(state.control_gate.as_ref(), || {
            state
                .gpu_switch
                .validate_uncertain_create_replay(&access, &replay_intent)
        })
        .await
    };
    if validation.is_err() {
        return park_gpu_switch_with_profile_control(
            state,
            &access.switch_id,
            access.record_revision,
            "gpu_switch_worker_response_invalid",
        )
        .await;
    }
    match state.worker.execute_gpu_switch_create(prepared).await {
        Ok(NativeWorkerGpuSwitchCreateResultV1::Created(response)) => {
            bind_gpu_switch_worker_response_with_profile_control(
                state,
                &access.switch_id,
                access.record_revision,
                NativeGpuSwitchWorkerBindingV1 {
                    requester_user_id: response.requester_user_id,
                    principal_binding_id: response.principal_binding_id,
                },
            )
            .await
        }
        Ok(NativeWorkerGpuSwitchCreateResultV1::Rejected(error)) => {
            park_definitive_gpu_switch_create_rejection(
                state,
                &access.switch_id,
                access.record_revision,
                error,
            )
            .await
        }
        Err(_) => {
            match state
                .worker
                .gpu_switch_owner_lookup(&access.switch_id, &access.session_id, &access.old_pod_id)
                .await
            {
                Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Found(found)) => {
                    bind_uncertain_gpu_switch_owner_with_profile_control(
                        state,
                        &access.switch_id,
                        access.record_revision,
                        found,
                    )
                    .await
                }
                Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::NotFound)
                | Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Rejected(_))
                | Err(_) => {
                    park_gpu_switch_with_profile_control(
                        state,
                        &access.switch_id,
                        access.record_revision,
                        // The one explicit replay socket was already consumed.
                        // Keep the exact request settlement-only so another
                        // Resume cannot issue a second POST.
                        "gpu_switch_worker_response_invalid",
                    )
                    .await
                }
            }
        }
    }
}

async fn resume_sent_uncertain_gpu_switch(
    state: &NativeState,
    switch_id: &str,
) -> NativeResult<()> {
    let access = {
        let _profile_control_lease = acquire_profile_control_lease().await?;
        with_gpu_profile_control(state.control_gate.as_ref(), || {
            state.gpu_switch.sent_uncertain_create_access(switch_id)
        })
        .await?
    };
    let Some(access) = access else {
        return Ok(());
    };
    let _ = resolve_gpu_switch_create_uncertainty(
        state,
        &access.switch_id,
        &access.session_id,
        &access.old_pod_id,
        access.record_revision,
        true,
    )
    .await?;
    Ok(())
}

#[tauri::command]
async fn gpu_switch_acquire(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: NativeGpuSwitchAcquireV1,
) -> NativeResult<NativeGpuSwitchLeaseV1> {
    let switch_id = input.switch_id.clone();
    let (lease, replay_allowed) = {
        let _profile_control_lease = acquire_profile_control_lease().await?;
        with_gpu_profile_control(state.control_gate.as_ref(), || {
            let replay_allowed = state
                .gpu_switch
                .sent_uncertain_resume_replay_allowed(&switch_id)?;
            let lease = with_gpu_start_foreground(&window, || state.gpu_switch.acquire(input))?;
            Ok((lease, replay_allowed))
        })
        .await?
    };
    if lease.held && replay_allowed {
        resume_sent_uncertain_gpu_switch(&state, &switch_id).await?;
    }
    state.gpu_switch.lease_status(&switch_id)
}

#[tauri::command]
async fn gpu_switch_release(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: NativeGpuSwitchKeyV1,
) -> NativeResult<NativeGpuSwitchLeaseV1> {
    require_main_gpu_window(&window)?;
    let _profile_control_lease = acquire_profile_control_lease().await?;
    with_gpu_profile_control(state.control_gate.as_ref(), || {
        state.gpu_switch.release(input)
    })
    .await
}

/// Pull the safe public worker state for an existing switch before touching
/// native-only owner material.  A private owner lookup is a recovery fallback
/// only when there is no current public projection (or a terminal proof is
/// required); renderer-authored worker state never enters this path.
#[tauri::command]
async fn gpu_switch_sync_worker(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: NativeGpuSwitchWorkerSyncV1,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    require_main_gpu_window(&window)?;
    let _profile_control_lease = acquire_profile_control_lease().await?;
    // Capture the exact native worker binding under a short same-process gate,
    // then release it before the pinned Studio GET.  The profile OS lease
    // remains held for the complete transaction.
    let access = with_gpu_profile_control(state.control_gate.as_ref(), || {
        state
            .gpu_switch
            .worker_access(&input.switch_id, input.expected_record_revision)
    })
    .await?;
    if access.session_id != input.session_id {
        return Err(NativeError::new(
            "gpu_switch_transition_invalid",
            "The GPU switch session does not match its native worker binding.",
        ));
    }
    match state
        .worker
        .gpu_switch_public_lookup(&access.switch_id, &access.session_id, &access.old_pod_id)
        .await
    {
        Ok(NativeWorkerGpuSwitchPublicLookupResultV1::Found(public))
            if !matches!(
                public.state,
                NativeWorkerGpuSwitchStateV1::Denied
                    | NativeWorkerGpuSwitchStateV1::Expired
                    | NativeWorkerGpuSwitchStateV1::Cancelled
                    | NativeWorkerGpuSwitchStateV1::Completed
            ) =>
        {
            apply_gpu_switch_public_lookup(&state, &access, public)
        }
        Ok(NativeWorkerGpuSwitchPublicLookupResultV1::Rejected(error)) => {
            Err(native_gpu_switch_worker_rejection(error))
        }
        // A null/terminal public view has no requester binding or tombstone.
        // Fetch the private exact projection only at this proof boundary.
        Ok(NativeWorkerGpuSwitchPublicLookupResultV1::Found(_))
        | Ok(NativeWorkerGpuSwitchPublicLookupResultV1::NotFound) => {
            resolve_gpu_switch_owner_sync(&state, &access).await
        }
        Err(_) => state.gpu_switch.park_with_attention(
            &access.switch_id,
            access.record_revision,
            "gpu_switch_worker_guard_missing",
        ),
    }
}

async fn resolve_gpu_switch_owner_sync(
    state: &NativeState,
    access: &native::gpu_switch::NativeGpuSwitchWorkerAccessV1,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    match state
        .worker
        .gpu_switch_owner_lookup(&access.switch_id, &access.session_id, &access.old_pod_id)
        .await
    {
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Found(owner)) => {
            apply_gpu_switch_owner_lookup(state, access, owner)
        }
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Rejected(error)) => {
            Err(native_gpu_switch_worker_rejection(error))
        }
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::NotFound) | Err(_) => {
            state.gpu_switch.park_with_attention(
                &access.switch_id,
                access.record_revision,
                "gpu_switch_worker_guard_missing",
            )
        }
    }
}

/// Finalize an approved Switch through the native worker pin. The durable
/// finalization UUID is created before the one POST, so response loss is
/// reconciled through the owner lookup and can never mint another request.
#[tauri::command]
async fn gpu_switch_finalize(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: NativeGpuSwitchFreshWorkerV1,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    require_main_gpu_window(&window)?;
    let _profile_control_lease = acquire_profile_control_lease().await?;
    let access = with_gpu_profile_control(state.control_gate.as_ref(), || {
        state
            .gpu_switch
            .worker_access(&input.switch_id, input.expected_record_revision)
    })
    .await?;
    if access.session_id != input.session_id {
        return Err(NativeError::new(
            "gpu_switch_transition_invalid",
            "The GPU switch session does not match its native worker binding.",
        ));
    }
    validate_gpu_switch_fresh_target(&state, &access, &input)?;
    let owner = match classify_gpu_switch_pre_finalize_owner_lookup(
        state
            .worker
            .gpu_switch_owner_lookup(&access.switch_id, &access.session_id, &access.old_pod_id)
            .await,
    )? {
        Some(owner) => owner,
        None => {
            return state.gpu_switch.park_with_attention(
                &access.switch_id,
                access.record_revision,
                "gpu_switch_worker_guard_missing",
            )
        }
    };
    if owner.requester_user_id != access.requester_user_id
        || owner.principal_binding_id != access.principal_binding_id
        || owner.state != NativeWorkerGpuSwitchStateV1::Approved
    {
        return state.gpu_switch.park_with_attention(
            &access.switch_id,
            access.record_revision,
            "gpu_switch_worker_guard_missing",
        );
    }
    let finalizing = with_gpu_profile_control(state.control_gate.as_ref(), || {
        state
            .gpu_switch
            .prepare_worker_finalization(&access.switch_id, access.record_revision)
    })
    .await?;
    let finalization_id = finalizing.finalization_id.clone().ok_or_else(|| {
        NativeError::new(
            "gpu_switch_store_unrecoverable",
            "GPU switch finalization evidence is unavailable.",
        )
    })?;
    match state
        .worker
        .gpu_switch_owner_action(
            &finalizing.switch_id,
            &finalizing.session_id,
            &finalizing.old_pod_id,
            NativeWorkerGpuSwitchOwnerActionV1::Finalize { finalization_id },
        )
        .await
    {
        Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Owner(owner)) => {
            apply_gpu_switch_owner_lookup(&state, &finalizing, owner)
        }
        Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Rejected(error)) => {
            // A complete typed worker rejection is definitive. Preserve its
            // exact safe code rather than disguising it as a transport loss;
            // the durable pausing intent remains available to explicit Sync.
            Err(native_gpu_switch_worker_rejection(error))
        }
        Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Uncertain) | Err(_) => {
            state.gpu_switch.park_with_attention(
                &finalizing.switch_id,
                finalizing.record_revision,
                "gpu_switch_worker_guard_missing",
            )
        }
    }
}

/// A pre-finalization owner lookup has only two ambiguous outcomes: a missing
/// projection and transport failure. A worker's typed rejection is definitive
/// and must reach the renderer intact; parking it as a missing guard would
/// invite an unsafe retry against a known-invalid worker state.
fn classify_gpu_switch_pre_finalize_owner_lookup(
    result: NativeResult<NativeWorkerGpuSwitchOwnerLookupResultV1>,
) -> NativeResult<Option<native::worker::NativeWorkerGpuSwitchOwnerLookupV1>> {
    match result {
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Found(owner)) => Ok(Some(owner)),
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Rejected(error)) => {
            Err(native_gpu_switch_worker_rejection(error))
        }
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::NotFound) | Err(_) => Ok(None),
    }
}

/// Explicit foreground cancellation.  A never-sent `send_pending` draft can
/// terminate locally; a `sent_uncertain` draft must use the worker settlement
/// tombstone; and a bound pre-delete request uses the exact native worker
/// cancel route. Nothing at/after delete intent is silently rolled back.
#[tauri::command]
async fn gpu_switch_cancel(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: NativeGpuSwitchWorkerSyncV1,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    require_main_gpu_window(&window)?;
    let _profile_control_lease = acquire_profile_control_lease().await?;
    let snapshot = state.gpu_switch.load()?;
    let record = snapshot.record.as_ref().ok_or_else(|| {
        NativeError::new(
            "gpu_switch_not_found",
            "The GPU switch record is no longer available.",
        )
    })?;
    if record.switch_id != input.switch_id
        || record.record_revision != input.expected_record_revision
    {
        return Err(NativeError::retryable(
            "gpu_switch_revision_conflict",
            "GPU switch state changed. Reload and choose again.",
        ));
    }
    if matches!(
        record.phase,
        NativeGpuSwitchPhaseV1::DeleteIntent
            | NativeGpuSwitchPhaseV1::DeleteUncertain
            | NativeGpuSwitchPhaseV1::OldAbsent
            | NativeGpuSwitchPhaseV1::CreateIntent
            | NativeGpuSwitchPhaseV1::CreateUncertain
            | NativeGpuSwitchPhaseV1::ReplacementIdentified
            | NativeGpuSwitchPhaseV1::Provisioning
            | NativeGpuSwitchPhaseV1::ReplacementFailed
            | NativeGpuSwitchPhaseV1::ReplacementDeleteIntent
            | NativeGpuSwitchPhaseV1::ReplacementDeleteUncertain
            | NativeGpuSwitchPhaseV1::ReadyPaused
            | NativeGpuSwitchPhaseV1::Completed
            | NativeGpuSwitchPhaseV1::CancelledPreDelete
    ) {
        return Err(NativeError::new(
            "gpu_switch_cancel_not_allowed",
            "The GPU switch cannot be cancelled after delete intent.",
        ));
    }
    let unresolved_planned = record.phase == NativeGpuSwitchPhaseV1::Planned
        || (record.phase == NativeGpuSwitchPhaseV1::NeedsAttention
            && record.blocked_at == Some(NativeGpuSwitchPhaseV1::Planned));
    if unresolved_planned {
        if let Ok(uncertain) = state
            .gpu_switch
            .uncertain_create_access(&input.switch_id, input.expected_record_revision)
        {
            if uncertain.session_id != input.session_id {
                return Err(NativeError::new(
                    "gpu_switch_transition_invalid",
                    "The GPU switch session does not match its native worker binding.",
                ));
            }
            let request = NativeWorkerGpuSwitchCreateRequestV1 {
                switch_id: uncertain.switch_id.clone(),
                session_id: uncertain.session_id,
                old_pod_id: uncertain.old_pod_id,
                old_gpu_id: uncertain.old_gpu_id,
                old_gpu_display_name: uncertain.old_gpu_display_name,
                initial_target_gpu_id: uncertain.initial_target_gpu_id,
                initial_target_gpu_display_name: uncertain.initial_target_gpu_display_name,
                initial_replacement_attempt_id: uncertain.initial_replacement_attempt_id,
                expected_batch_id: uncertain.expected_batch_id,
                inventory_observed_at: uncertain.inventory_observed_at,
            };
            return match state.worker.gpu_switch_settle_create(request).await {
                Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Owner(owner))
                    if owner.state == NativeWorkerGpuSwitchStateV1::Cancelled =>
                {
                    let tombstone = owner.terminal_tombstone_sha256.ok_or_else(|| {
                        NativeError::new(
                            "gpu_switch_worker_response_invalid",
                            "The worker did not provide terminal GPU switch evidence.",
                        )
                    })?;
                    let bound = state.gpu_switch.bind_worker_create_response(
                        &uncertain.switch_id,
                        uncertain.record_revision,
                        NativeGpuSwitchWorkerBindingV1 {
                            requester_user_id: owner.requester_user_id,
                            principal_binding_id: owner.principal_binding_id.clone(),
                        },
                    )?;
                    let bound_record = bound.record.as_ref().ok_or_else(|| {
                        NativeError::new(
                            "gpu_switch_store_unrecoverable",
                            "GPU switch settlement evidence is unavailable.",
                        )
                    })?;
                    state.gpu_switch.terminalize_with_proof(
                        &uncertain.switch_id,
                        bound_record.record_revision,
                        NativeGpuSwitchPhaseV1::CancelledPreDelete,
                        NativeGpuSwitchTerminalProofV1 {
                            terminal_reason: NativeGpuSwitchTerminalReasonV1::RequesterCancelled,
                            principal_binding_id: Some(owner.principal_binding_id),
                            worker_tombstone_sha256: Some(tombstone),
                        },
                    )
                }
                Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Owner(_)) => {
                    state.gpu_switch.park_with_attention(
                        &uncertain.switch_id,
                        uncertain.record_revision,
                        "gpu_switch_worker_create_uncertain",
                    )
                }
                Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Rejected(error)) => {
                    Err(native_gpu_switch_worker_rejection(error))
                }
                Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Uncertain) | Err(_) => {
                    state.gpu_switch.park_with_attention(
                        &uncertain.switch_id,
                        uncertain.record_revision,
                        "gpu_switch_worker_create_uncertain",
                    )
                }
            };
        }
        return with_gpu_start_foreground(&window, || {
            state.gpu_switch.terminalize_with_proof(
                &input.switch_id,
                input.expected_record_revision,
                NativeGpuSwitchPhaseV1::CancelledPreDelete,
                NativeGpuSwitchTerminalProofV1 {
                    terminal_reason: NativeGpuSwitchTerminalReasonV1::LocalDraftCancelled,
                    principal_binding_id: None,
                    worker_tombstone_sha256: None,
                },
            )
        });
    }

    let access = state
        .gpu_switch
        .worker_access(&input.switch_id, input.expected_record_revision)?;
    if access.session_id != input.session_id {
        return Err(NativeError::new(
            "gpu_switch_transition_invalid",
            "The GPU switch session does not match its native worker binding.",
        ));
    }
    match state
        .worker
        .gpu_switch_owner_action(
            &access.switch_id,
            &access.session_id,
            &access.old_pod_id,
            NativeWorkerGpuSwitchOwnerActionV1::Cancel {
                finalization_id: access.finalization_id.clone(),
            },
        )
        .await
    {
        Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Owner(owner)) => {
            apply_gpu_switch_owner_lookup(&state, &access, owner)
        }
        Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Rejected(error)) => {
            Err(native_gpu_switch_worker_rejection(error))
        }
        Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Uncertain) | Err(_) => {
            state.gpu_switch.park_with_attention(
                &access.switch_id,
                access.record_revision,
                "gpu_switch_worker_guard_missing",
            )
        }
    }
}

fn native_gpu_switch_worker_rejection(
    error: native::worker::NativeWorkerGpuSwitchErrorV1,
) -> NativeError {
    let code = match error.code.as_str() {
        "gpu_switch_request_not_found" => "gpu_switch_request_not_found",
        "gpu_switch_request_in_progress" => "gpu_switch_request_in_progress",
        "gpu_switch_identity_mismatch" => "gpu_switch_identity_mismatch",
        "gpu_switch_response_conflict" => "gpu_switch_response_conflict",
        "gpu_switch_response_not_allowed" => "gpu_switch_response_not_allowed",
        "gpu_switch_approval_pending" => "gpu_switch_approval_pending",
        "gpu_switch_not_approved" => "gpu_switch_not_approved",
        "gpu_switch_finalization_mismatch" => "gpu_switch_finalization_mismatch",
        "gpu_switch_cancel_not_allowed" => "gpu_switch_cancel_not_allowed",
        "gpu_switch_adoption_mismatch" => "gpu_switch_adoption_mismatch",
        "gpu_switch_batch_changed" => "gpu_switch_batch_changed",
        "gpu_switch_completion_not_ready" => "gpu_switch_completion_not_ready",
        "gpu_switch_current_pod_unverified" => "gpu_switch_current_pod_unverified",
        "gpu_switch_local_receipts_pending" => "gpu_switch_local_receipts_pending",
        "stop_request_in_progress" => "stop_request_in_progress",
        "gpu_switch_requester_not_foreground" => "gpu_switch_requester_not_foreground",
        "switch_owner_unavailable" => "switch_owner_unavailable",
        "gpu_switch_queue_dispatch_uncertain" => "gpu_switch_queue_dispatch_uncertain",
        "gpu_stop_pending" => "gpu_stop_pending",
        "gpu_switch_pending" => "gpu_switch_pending",
        "queue_switch_pending" => "queue_switch_pending",
        "gpu_switch_store_corrupt" => "gpu_switch_store_corrupt",
        "gpu_switch_runtime_identity_unavailable" => "gpu_switch_runtime_identity_unavailable",
        "gpu_control_guard_conflict" => "gpu_control_guard_conflict",
        _ => "gpu_switch_worker_response_invalid",
    };
    NativeError::new(code, error.message)
}

/// Confirm that the current native selector receipt still describes this
/// switch's immutable target. The renderer's price text is not authority;
/// it can only request this revalidation against the native inventory join.
#[tauri::command]
async fn gpu_switch_confirm_target(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: NativeGpuSwitchPrepareTargetV1,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    require_main_gpu_window(&window)?;
    let _profile_control_lease = acquire_profile_control_lease().await?;
    // The shared OS lease spans the provider revalidation; the Tokio gate only
    // snapshots the local record and is released before that socket work.
    let access = with_gpu_profile_control(state.control_gate.as_ref(), || {
        state
            .gpu_switch
            .worker_access(&input.switch_id, input.expected_record_revision)
    })
    .await?;
    let fresh = state
        .gpu_inventory
        .fresh_switch_target_evidence(
            window.app_handle().clone(),
            &state.runpod,
            &input.observation_id,
            &input.receipt_id,
            &input.target_gpu_id,
            input.confirmed_hourly_price_micro_usd,
        )
        .await?;
    let evidence = fresh.evidence;
    if evidence.old_pod.pod_id != access.old_pod_id {
        return Err(NativeError::new(
            "gpu_switch_old_pod_changed",
            "The current GPU Pod changed before this switch could continue.",
        ));
    }
    if access.current_target.gpu_id != input.target_gpu_id
        || access.current_target.hourly_price_micro_usd != input.confirmed_hourly_price_micro_usd
        || access.current_target.gpu_display_name != evidence.target_gpu_display_name
    {
        return Err(NativeError::new(
            "gpu_switch_price_changed",
            "The selected GPU price changed. Confirm the current price.",
        ));
    }
    // Commit only the native-finally-observed receipt. The renderer's older
    // receipt is intent evidence, never the durable confirmation boundary.
    let fresh_input = NativeGpuSwitchPrepareTargetV1 {
        observation_id: fresh.observation_id,
        receipt_id: fresh.receipt_id,
        ..input
    };
    with_gpu_profile_control(state.control_gate.as_ref(), || {
        state.gpu_switch.confirm_current_target(
            fresh_input,
            evidence.target_gpu_display_name,
            evidence.inventory_observed_at,
        )
    })
    .await
}

/// Perform the one bounded old-Pod deletion transaction. Worker intent and
/// the wire-attempt counter are durable before the DELETE; a 404/204 advances
/// only after a second complete profile observation also proves the exact Pod
/// absent.
#[tauri::command]
async fn gpu_switch_delete_old(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: NativeGpuSwitchFreshWorkerV1,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    require_main_gpu_window(&window)?;
    let _profile_control_lease = acquire_profile_control_lease().await?;
    let mut access = with_gpu_profile_control(state.control_gate.as_ref(), || {
        state
            .gpu_switch
            .worker_access(&input.switch_id, input.expected_record_revision)
    })
    .await?;
    if access.session_id != input.session_id {
        return Err(NativeError::new(
            "gpu_switch_transition_invalid",
            "The GPU switch session does not match its native worker binding.",
        ));
    }
    let current = state.gpu_switch.load()?;
    let current_phase = current
        .record
        .as_ref()
        .filter(|record| {
            record.switch_id == access.switch_id && record.record_revision == access.record_revision
        })
        .map(|record| record.phase)
        .ok_or_else(|| {
            NativeError::retryable(
                "gpu_switch_revision_conflict",
                "GPU switch state changed. Reload before continuing.",
            )
        })?;
    if current_phase == NativeGpuSwitchPhaseV1::ReadyToDelete {
        let fresh = state
            .gpu_inventory
            .fresh_switch_target_evidence(
                window.app_handle().clone(),
                &state.runpod,
                &input.observation_id,
                &input.receipt_id,
                &input.target_gpu_id,
                input.confirmed_hourly_price_micro_usd,
            )
            .await?;
        if fresh.evidence.old_pod.pod_id != access.old_pod_id
            || fresh.evidence.old_pod.gpu_id != access.old_gpu_id
            || access.current_target.gpu_id != input.target_gpu_id
            || access.current_target.hourly_price_micro_usd
                != input.confirmed_hourly_price_micro_usd
        {
            return state.gpu_switch.park_with_attention(
                &access.switch_id,
                access.record_revision,
                "gpu_switch_old_pod_changed",
            );
        }
    } else if !matches!(
        current_phase,
        NativeGpuSwitchPhaseV1::DeleteIntent | NativeGpuSwitchPhaseV1::DeleteUncertain
    ) {
        return Err(NativeError::new(
            "gpu_switch_transition_invalid",
            "That GPU switch action is not valid in its current state.",
        ));
    }

    let exact_old = match state.runpod.native_switch_get_pod(&access.old_pod_id).await {
        Ok(pod) => pod,
        Err(error) => return Err(error),
    };
    if exact_old
        .as_ref()
        .is_some_and(|pod| pod.pod_id != access.old_pod_id || pod.gpu_id != access.old_gpu_id)
    {
        return state.gpu_switch.park_with_attention(
            &access.switch_id,
            access.record_revision,
            "gpu_switch_old_pod_changed",
        );
    }
    if exact_old.is_none() {
        if current_phase == NativeGpuSwitchPhaseV1::ReadyToDelete {
            return state.gpu_switch.park_with_attention(
                &access.switch_id,
                access.record_revision,
                "gpu_switch_old_pod_disappeared_early",
            );
        }
        let listed = state.runpod.native_switch_list_pods().await?;
        if listed.iter().any(|pod| pod.pod_id == access.old_pod_id) {
            return Err(NativeError::new(
                "gpu_switch_provider_response_mismatch",
                "The provider response does not match this GPU switch.",
            ));
        }
        return with_gpu_profile_control(state.control_gate.as_ref(), || {
            state.gpu_switch.advance_with_proof(
                &access.switch_id,
                access.record_revision,
                NativeGpuSwitchPhaseV1::OldAbsent,
            )
        })
        .await;
    }

    if current_phase == NativeGpuSwitchPhaseV1::ReadyToDelete {
        let finalization_id = access.finalization_id.clone().ok_or_else(|| {
            NativeError::new(
                "gpu_switch_store_unrecoverable",
                "GPU switch finalization evidence is unavailable.",
            )
        })?;
        let guard = match state
            .worker
            .gpu_switch_owner_lookup(&access.switch_id, &access.session_id, &access.old_pod_id)
            .await
        {
            Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Found(owner)) => owner,
            Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Rejected(error)) => {
                return Err(native_gpu_switch_worker_rejection(error))
            }
            Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::NotFound) | Err(_) => {
                return state.gpu_switch.park_with_attention(
                    &access.switch_id,
                    access.record_revision,
                    "gpu_switch_worker_guard_missing",
                )
            }
        };
        if guard.state != NativeWorkerGpuSwitchStateV1::ReadyToDelete
            || guard.requester_user_id != access.requester_user_id
            || guard.principal_binding_id != access.principal_binding_id
            || guard.finalization_id.as_deref() != Some(finalization_id.as_str())
        {
            return state.gpu_switch.park_with_attention(
                &access.switch_id,
                access.record_revision,
                "gpu_switch_worker_guard_missing",
            );
        }
        // Final local generation/reservation re-read after the worker guard
        // and immediately before the mutation socket.
        access = state
            .gpu_switch
            .worker_access(&access.switch_id, access.record_revision)?;
        let owner = match state
            .worker
            .gpu_switch_owner_action(
                &access.switch_id,
                &access.session_id,
                &access.old_pod_id,
                NativeWorkerGpuSwitchOwnerActionV1::DeleteIntent { finalization_id },
            )
            .await
        {
            Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Owner(owner)) => owner,
            Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Rejected(error)) => {
                return Err(native_gpu_switch_worker_rejection(error))
            }
            Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Uncertain) | Err(_) => {
                return state.gpu_switch.park_with_attention(
                    &access.switch_id,
                    access.record_revision,
                    "gpu_switch_worker_guard_missing",
                )
            }
        };
        let advanced = apply_gpu_switch_owner_lookup(&state, &access, owner)?;
        let revision = advanced
            .record
            .as_ref()
            .map(|record| record.record_revision)
            .ok_or_else(|| {
                NativeError::new(
                    "gpu_switch_store_unrecoverable",
                    "GPU switch delete intent is unavailable.",
                )
            })?;
        access = state.gpu_switch.worker_access(&input.switch_id, revision)?;
    } else if current_phase == NativeGpuSwitchPhaseV1::DeleteUncertain {
        let resumed = state.gpu_switch.advance_with_proof(
            &access.switch_id,
            access.record_revision,
            NativeGpuSwitchPhaseV1::DeleteIntent,
        )?;
        let revision = resumed
            .record
            .as_ref()
            .map(|record| record.record_revision)
            .ok_or_else(|| {
                NativeError::new(
                    "gpu_switch_store_unrecoverable",
                    "GPU switch delete intent is unavailable.",
                )
            })?;
        access = state.gpu_switch.worker_access(&input.switch_id, revision)?;
    }

    let wire = state
        .gpu_switch
        .prepare_old_delete_wire_attempt(&access.switch_id, access.record_revision)?;
    let wire_revision = wire
        .record
        .as_ref()
        .map(|record| record.record_revision)
        .ok_or_else(|| {
            NativeError::new(
                "gpu_switch_store_unrecoverable",
                "GPU switch delete authority is unavailable.",
            )
        })?;
    let wire_access = state
        .gpu_switch
        .worker_access(&access.switch_id, wire_revision)?;
    let delete_guard = match state
        .worker
        .gpu_switch_owner_lookup(
            &wire_access.switch_id,
            &wire_access.session_id,
            &wire_access.old_pod_id,
        )
        .await
    {
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Found(owner)) => owner,
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Rejected(error)) => {
            return Err(native_gpu_switch_worker_rejection(error))
        }
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::NotFound) | Err(_) => {
            return state.gpu_switch.park_with_attention(
                &wire_access.switch_id,
                wire_access.record_revision,
                "gpu_switch_worker_guard_missing",
            )
        }
    };
    if delete_guard.state != NativeWorkerGpuSwitchStateV1::DeleteIntent
        || delete_guard.requester_user_id != wire_access.requester_user_id
        || delete_guard.principal_binding_id != wire_access.principal_binding_id
        || delete_guard.finalization_id != wire_access.finalization_id
    {
        return state.gpu_switch.park_with_attention(
            &wire_access.switch_id,
            wire_access.record_revision,
            "gpu_switch_worker_guard_missing",
        );
    }
    let wire_access = state
        .gpu_switch
        .worker_access(&wire_access.switch_id, wire_access.record_revision)?;
    state
        .runpod
        .authorize_native_switch_delete(&wire_access.switch_id, &wire_access.old_pod_id)?;
    let disposition = state
        .runpod
        .native_switch_delete_pod(&wire_access.switch_id, &wire_access.old_pod_id)
        .await?;
    if disposition == NativeRunPodDeleteDispositionV1::Uncertain {
        return state.gpu_switch.advance_with_proof(
            &wire_access.switch_id,
            wire_revision,
            NativeGpuSwitchPhaseV1::DeleteUncertain,
        );
    }
    let listed = state.runpod.native_switch_list_pods().await?;
    let exact = state
        .runpod
        .native_switch_get_pod(&access.old_pod_id)
        .await?;
    if exact.is_none() && listed.iter().all(|pod| pod.pod_id != access.old_pod_id) {
        state.gpu_switch.advance_with_proof(
            &wire_access.switch_id,
            wire_revision,
            NativeGpuSwitchPhaseV1::OldAbsent,
        )
    } else {
        state.gpu_switch.advance_with_proof(
            &wire_access.switch_id,
            wire_revision,
            NativeGpuSwitchPhaseV1::DeleteUncertain,
        )
    }
}

/// Store a fresh native replacement quote after the old Pod is absent. This
/// creates no attempt identity and performs no provider mutation.
#[tauri::command]
async fn gpu_switch_prepare_attempt(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: NativeGpuSwitchPrepareTargetV1,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    require_main_gpu_window(&window)?;
    let _profile_control_lease = acquire_profile_control_lease().await?;
    let fresh = state
        .gpu_inventory
        .fresh_switch_replacement_target(
            window.app_handle().clone(),
            &state.runpod,
            &input.observation_id,
            &input.receipt_id,
            &input.target_gpu_id,
            input.confirmed_hourly_price_micro_usd,
        )
        .await?;
    let fresh_input = NativeGpuSwitchPrepareTargetV1 {
        observation_id: fresh.observation_id,
        receipt_id: fresh.receipt_id,
        ..input
    };
    with_gpu_profile_control(state.control_gate.as_ref(), || {
        state.gpu_switch.prepare_attempt(
            fresh_input,
            fresh.target_gpu_display_name,
            fresh.inventory_observed_at,
        )
    })
    .await
}

/// Consume one still-live process-local quote and atomically create the next
/// contiguous attempt identity. No provider socket is opened here.
#[tauri::command]
async fn gpu_switch_confirm_attempt(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: NativeGpuSwitchConfirmAttemptV1,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    require_main_gpu_window(&window)?;
    let _profile_control_lease = acquire_profile_control_lease().await?;
    with_gpu_profile_control(state.control_gate.as_ref(), || {
        state.gpu_switch.confirm_attempt(input)
    })
    .await
}

/// Accept only the exact provider price already persisted for this attempt.
/// Dialog text cannot substitute a different integer or Pod identity.
#[tauri::command]
async fn gpu_switch_confirm_actual_price(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: NativeGpuSwitchActualPriceV1,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    require_main_gpu_window(&window)?;
    let _profile_control_lease = acquire_profile_control_lease().await?;
    with_gpu_profile_control(state.control_gate.as_ref(), || {
        state.gpu_switch.confirm_actual_price(input)
    })
    .await
}

/// Persist one exact replacement-create body before its sole provider POST.
/// Every URL/profile/attempt/hash field is native-derived; response ambiguity
/// becomes durable `create_uncertain` and is never retried here.
#[tauri::command]
async fn gpu_switch_create_replacement(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: NativeGpuSwitchFreshWorkerV1,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    require_main_gpu_window(&window)?;
    let _profile_control_lease = acquire_profile_control_lease().await?;
    let access = state
        .gpu_switch
        .worker_access(&input.switch_id, input.expected_record_revision)?;
    if access.session_id != input.session_id
        || access.current_target.gpu_id != input.target_gpu_id
        || access.current_target.hourly_price_micro_usd != input.confirmed_hourly_price_micro_usd
    {
        return Err(NativeError::new(
            "gpu_switch_transition_invalid",
            "The GPU switch target no longer matches this replacement attempt.",
        ));
    }
    let fresh = state
        .gpu_inventory
        .fresh_switch_replacement_target(
            window.app_handle().clone(),
            &state.runpod,
            &input.observation_id,
            &input.receipt_id,
            &input.target_gpu_id,
            input.confirmed_hourly_price_micro_usd,
        )
        .await?;
    if fresh.target_gpu_display_name != access.current_target.gpu_display_name {
        return Err(NativeError::new(
            "gpu_switch_price_changed",
            "The selected GPU price changed. Confirm the current price.",
        ));
    }
    let existing = state.runpod.native_switch_list_pods().await?;
    if !existing.is_empty() {
        return state.gpu_switch.park_with_peer_pods(
            &access.switch_id,
            access.record_revision,
            existing.into_iter().map(|pod| pod.pod_id).collect(),
        );
    }
    let plan = state.runpod.prepare_native_switch_create(
        &access.switch_id,
        &access.current_target.replacement_attempt_id,
        access.current_target.attempt_revision,
        &access.current_target.gpu_id,
    )?;
    let intent = state.gpu_switch.prepare_replacement_create(
        &access.switch_id,
        access.record_revision,
        NativeGpuSwitchProviderCreateIntentV1 {
            create_marker_sha256: plan.create_marker_sha256.clone(),
            create_intent_sha256: plan.create_intent_sha256.clone(),
            create_wire_body_sha256: plan.create_wire_body_sha256.clone(),
            observation_id: fresh.observation_id,
            receipt_id: fresh.receipt_id,
            inventory_observed_at: fresh.inventory_observed_at,
        },
    )?;
    let intent_revision = intent
        .record
        .as_ref()
        .map(|record| record.record_revision)
        .ok_or_else(|| {
            NativeError::new(
                "gpu_switch_store_unrecoverable",
                "GPU switch create intent is unavailable.",
            )
        })?;
    let durable = state
        .gpu_switch
        .worker_access(&access.switch_id, intent_revision)?;
    let owner = match state
        .worker
        .gpu_switch_owner_lookup(&durable.switch_id, &durable.session_id, &durable.old_pod_id)
        .await
    {
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Found(owner)) => owner,
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Rejected(error)) => {
            return Err(native_gpu_switch_worker_rejection(error))
        }
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::NotFound) | Err(_) => {
            return state.gpu_switch.park_with_attention(
                &durable.switch_id,
                durable.record_revision,
                "gpu_switch_worker_guard_missing",
            )
        }
    };
    if owner.state != NativeWorkerGpuSwitchStateV1::DeleteIntent
        || owner.requester_user_id != durable.requester_user_id
        || owner.principal_binding_id != durable.principal_binding_id
        || owner.finalization_id != durable.finalization_id
    {
        return state.gpu_switch.park_with_attention(
            &durable.switch_id,
            durable.record_revision,
            "gpu_switch_worker_guard_missing",
        );
    }
    let final_access = state
        .gpu_switch
        .worker_access(&durable.switch_id, durable.record_revision)?;
    if final_access.create_marker_sha256.as_deref() != Some(plan.create_marker_sha256.as_str())
        || final_access.create_intent_sha256.as_deref() != Some(plan.create_intent_sha256.as_str())
        || final_access.create_wire_body_sha256.as_deref()
            != Some(plan.create_wire_body_sha256.as_str())
        || final_access.current_target.replacement_attempt_id
            != durable.current_target.replacement_attempt_id
        || final_access.current_target.attempt_revision != durable.current_target.attempt_revision
    {
        return Err(NativeError::new(
            "gpu_control_guard_conflict",
            "GPU profile authority changed before the provider mutation.",
        ));
    }
    match state.runpod.execute_native_switch_create(&plan).await {
        Ok(created) => state.gpu_switch.record_replacement_identified(
            &durable.switch_id,
            durable.record_revision,
            created.pod.pod_id,
            created.pod.gpu_id,
            created.pod.hourly_price_micro_usd,
            created.provider_response_sha256,
        ),
        Err(_) => state
            .gpu_switch
            .mark_replacement_create_uncertain(&durable.switch_id, durable.record_revision),
    }
}

/// Explicitly terminate only the exact failed or unaccepted replacement. The
/// literal confirmation is checked before provider reads, then native persists
/// the cleanup intent before consuming one exact DELETE authority.
#[tauri::command]
async fn gpu_switch_delete_replacement(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: NativeGpuSwitchReplacementDeleteV1,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    require_main_gpu_window(&window)?;
    let expected_confirmation = match input.reason {
        NativeGpuSwitchReplacementDeleteReasonV1::ReplacementFailed => {
            "TERMINATE FAILED REPLACEMENT"
        }
        NativeGpuSwitchReplacementDeleteReasonV1::ActualPriceRejected => {
            "TERMINATE UNACCEPTED REPLACEMENT"
        }
    };
    if input.confirmation != expected_confirmation {
        return Err(NativeError::new(
            "gpu_switch_transition_invalid",
            "The failed replacement confirmation does not match this action.",
        ));
    }
    let _profile_control_lease = acquire_profile_control_lease().await?;
    let access = state
        .gpu_switch
        .worker_access(&input.switch_id, input.expected_record_revision)?;
    if access.replacement_pod_id.as_deref() != Some(input.replacement_pod_id.as_str()) {
        return Err(NativeError::new(
            "gpu_switch_replacement_mismatch",
            "The replacement Pod does not match this GPU switch.",
        ));
    }
    let provider_pod = match state
        .runpod
        .native_switch_get_pod(&input.replacement_pod_id)
        .await
    {
        Ok(pod) => pod,
        // Exact-Pod preflight is part of the destructive boundary.  A
        // timeout/5xx/malformed response cannot be returned as a transient
        // renderer error: persist actionable attention before any intent or
        // DELETE can be attempted, and require explicit reconciliation.
        Err(_) => {
            return state.gpu_switch.park_with_attention(
                &access.switch_id,
                access.record_revision,
                "gpu_switch_replacement_delete_uncertain",
            )
        }
    };
    if provider_pod.as_ref().is_some_and(|pod| {
        pod.pod_id != input.replacement_pod_id || pod.gpu_id != access.current_target.gpu_id
    }) {
        return state.gpu_switch.park_with_attention(
            &access.switch_id,
            access.record_revision,
            "gpu_switch_replacement_mismatch",
        );
    }
    if input.reason == NativeGpuSwitchReplacementDeleteReasonV1::ReplacementFailed
        && provider_pod
            .as_ref()
            .is_some_and(|pod| pod.status == "running")
    {
        return state.gpu_switch.advance_with_proof(
            &access.switch_id,
            access.record_revision,
            NativeGpuSwitchPhaseV1::Provisioning,
        );
    }
    let intent = state.gpu_switch.prepare_replacement_delete(
        &access.switch_id,
        access.record_revision,
        &input.replacement_pod_id,
    )?;
    let intent_revision = intent
        .record
        .as_ref()
        .map(|record| record.record_revision)
        .ok_or_else(|| {
            NativeError::new(
                "gpu_switch_store_unrecoverable",
                "GPU switch replacement cleanup intent is unavailable.",
            )
        })?;
    if provider_pod.is_none() {
        let listed = state.runpod.native_switch_list_pods().await?;
        if listed
            .iter()
            .all(|pod| pod.pod_id != input.replacement_pod_id)
        {
            return state
                .gpu_switch
                .settle_deleted_replacement(&access.switch_id, intent_revision);
        }
        return state
            .gpu_switch
            .mark_replacement_delete_uncertain(&access.switch_id, intent_revision);
    }
    let durable = state
        .gpu_switch
        .worker_access(&access.switch_id, intent_revision)?;
    let worker_guard = match state
        .worker
        .gpu_switch_owner_lookup(&durable.switch_id, &durable.session_id, &durable.old_pod_id)
        .await
    {
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Found(owner)) => owner,
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Rejected(error)) => {
            return Err(native_gpu_switch_worker_rejection(error))
        }
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::NotFound) | Err(_) => {
            return state.gpu_switch.park_with_attention(
                &durable.switch_id,
                durable.record_revision,
                "gpu_switch_worker_guard_missing",
            )
        }
    };
    if worker_guard.state != NativeWorkerGpuSwitchStateV1::DeleteIntent
        || worker_guard.principal_binding_id != durable.principal_binding_id
        || worker_guard.finalization_id != durable.finalization_id
    {
        return state.gpu_switch.park_with_attention(
            &durable.switch_id,
            durable.record_revision,
            "gpu_switch_worker_guard_missing",
        );
    }
    let durable = state
        .gpu_switch
        .worker_access(&durable.switch_id, durable.record_revision)?;
    state
        .runpod
        .authorize_native_switch_delete(&durable.switch_id, &input.replacement_pod_id)?;
    let disposition = state
        .runpod
        .native_switch_delete_pod(&durable.switch_id, &input.replacement_pod_id)
        .await?;
    if disposition == NativeRunPodDeleteDispositionV1::Uncertain {
        return state
            .gpu_switch
            .mark_replacement_delete_uncertain(&durable.switch_id, durable.record_revision);
    }
    let listed = state.runpod.native_switch_list_pods().await?;
    let exact = state
        .runpod
        .native_switch_get_pod(&input.replacement_pod_id)
        .await?;
    if exact.is_none()
        && listed
            .iter()
            .all(|pod| pod.pod_id != input.replacement_pod_id)
    {
        state
            .gpu_switch
            .settle_deleted_replacement(&durable.switch_id, durable.record_revision)
    } else {
        state
            .gpu_switch
            .mark_replacement_delete_uncertain(&durable.switch_id, durable.record_revision)
    }
}

/// Read-only provider reconciliation for an interrupted destructive or create
/// boundary. This command never sends POST/DELETE; it advances only from a
/// complete list plus exact-ID GET proof and otherwise parks or retains the
/// current durable state.
#[tauri::command]
async fn gpu_switch_reconcile_provider(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: NativeGpuSwitchProviderReconcileV1,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    require_main_gpu_window(&window)?;
    let _profile_control_lease = acquire_profile_control_lease().await?;
    let access = state
        .gpu_switch
        .worker_access(&input.switch_id, input.expected_record_revision)?;
    let snapshot = state.gpu_switch.load()?;
    let record = snapshot
        .record
        .as_ref()
        .filter(|record| {
            record.switch_id == access.switch_id && record.record_revision == access.record_revision
        })
        .ok_or_else(|| {
            NativeError::retryable(
                "gpu_switch_revision_conflict",
                "GPU switch state changed. Reload before continuing.",
            )
        })?;
    let phase = record.phase;
    let listed = state.runpod.native_switch_list_pods().await?;
    match phase {
        NativeGpuSwitchPhaseV1::DeleteIntent | NativeGpuSwitchPhaseV1::DeleteUncertain => {
            let exact = state
                .runpod
                .native_switch_get_pod(&access.old_pod_id)
                .await?;
            if exact.is_none() && listed.iter().all(|pod| pod.pod_id != access.old_pod_id) {
                return state.gpu_switch.advance_with_proof(
                    &access.switch_id,
                    access.record_revision,
                    NativeGpuSwitchPhaseV1::OldAbsent,
                );
            }
            if let Some(pod) = exact {
                if pod.pod_id != access.old_pod_id || pod.gpu_id != access.old_gpu_id {
                    return state.gpu_switch.park_with_attention(
                        &access.switch_id,
                        access.record_revision,
                        "gpu_switch_old_pod_changed",
                    );
                }
                if phase == NativeGpuSwitchPhaseV1::DeleteUncertain
                    && matches!(
                        input.reason,
                        NativeGpuSwitchProviderReconcileReasonV1::Resume
                            | NativeGpuSwitchProviderReconcileReasonV1::AfterDelete
                    )
                {
                    return state.gpu_switch.advance_with_proof(
                        &access.switch_id,
                        access.record_revision,
                        NativeGpuSwitchPhaseV1::DeleteIntent,
                    );
                }
            }
            Ok(snapshot)
        }
        NativeGpuSwitchPhaseV1::OldAbsent => {
            if listed.is_empty() {
                Ok(snapshot)
            } else {
                state.gpu_switch.park_with_peer_pods(
                    &access.switch_id,
                    access.record_revision,
                    listed.into_iter().map(|pod| pod.pod_id).collect(),
                )
            }
        }
        NativeGpuSwitchPhaseV1::CreateIntent | NativeGpuSwitchPhaseV1::CreateUncertain => {
            let expected_name = format!(
                "imageforge-switch-{}",
                access.current_target.replacement_attempt_id
            );
            let mut matches = listed
                .iter()
                .filter(|pod| {
                    pod.pod_name == expected_name && pod.gpu_id == access.current_target.gpu_id
                })
                .collect::<Vec<_>>();
            if matches.len() > 1 {
                return state.gpu_switch.park_with_attention(
                    &access.switch_id,
                    access.record_revision,
                    "gpu_switch_replacement_ambiguous",
                );
            }
            if let Some(candidate) = matches.pop() {
                let exact = state
                    .runpod
                    .native_switch_get_pod(&candidate.pod_id)
                    .await?
                    .filter(|pod| {
                        pod.pod_name == expected_name && pod.gpu_id == access.current_target.gpu_id
                    })
                    .ok_or_else(|| {
                        NativeError::new(
                            "gpu_switch_provider_response_mismatch",
                            "The provider response does not match this GPU switch.",
                        )
                    })?;
                return state.gpu_switch.record_replacement_identified(
                    &access.switch_id,
                    access.record_revision,
                    exact.pod_id,
                    exact.gpu_id,
                    exact.hourly_price_micro_usd,
                    exact.provider_response_sha256,
                );
            }
            if phase == NativeGpuSwitchPhaseV1::CreateIntent {
                return state
                    .gpu_switch
                    .mark_replacement_create_uncertain(&access.switch_id, access.record_revision);
            }
            if input.reason == NativeGpuSwitchProviderReconcileReasonV1::ZeroMatchProof {
                return state.gpu_switch.park_with_attention(
                    &access.switch_id,
                    access.record_revision,
                    "gpu_switch_zero_match_unproven",
                );
            }
            Ok(snapshot)
        }
        NativeGpuSwitchPhaseV1::ReplacementIdentified
        | NativeGpuSwitchPhaseV1::Provisioning
        | NativeGpuSwitchPhaseV1::ReplacementFailed => {
            let replacement_pod_id = access.replacement_pod_id.as_deref().ok_or_else(|| {
                NativeError::new(
                    "gpu_switch_replacement_mismatch",
                    "The replacement Pod does not match this GPU switch.",
                )
            })?;
            let exact = state
                .runpod
                .native_switch_get_pod(replacement_pod_id)
                .await?;
            let Some(exact) = exact else {
                return state.gpu_switch.park_with_attention(
                    &access.switch_id,
                    access.record_revision,
                    "gpu_switch_replacement_mismatch",
                );
            };
            if exact.gpu_id != access.current_target.gpu_id {
                return state.gpu_switch.park_with_attention(
                    &access.switch_id,
                    access.record_revision,
                    "gpu_switch_replacement_mismatch",
                );
            }
            if phase == NativeGpuSwitchPhaseV1::Provisioning
                && matches!(exact.status.as_str(), "error" | "exited" | "terminated")
            {
                return state.gpu_switch.advance_with_proof(
                    &access.switch_id,
                    access.record_revision,
                    NativeGpuSwitchPhaseV1::ReplacementFailed,
                );
            }
            if phase == NativeGpuSwitchPhaseV1::ReplacementFailed && exact.status == "running" {
                return state.gpu_switch.advance_with_proof(
                    &access.switch_id,
                    access.record_revision,
                    NativeGpuSwitchPhaseV1::Provisioning,
                );
            }
            Ok(snapshot)
        }
        NativeGpuSwitchPhaseV1::ReplacementDeleteIntent
        | NativeGpuSwitchPhaseV1::ReplacementDeleteUncertain => {
            let replacement_pod_id = access.replacement_pod_id.as_deref().ok_or_else(|| {
                NativeError::new(
                    "gpu_switch_replacement_mismatch",
                    "The replacement Pod does not match this GPU switch.",
                )
            })?;
            let exact = state
                .runpod
                .native_switch_get_pod(replacement_pod_id)
                .await?;
            if exact.is_none() && listed.iter().all(|pod| pod.pod_id != replacement_pod_id) {
                return state
                    .gpu_switch
                    .settle_deleted_replacement(&access.switch_id, access.record_revision);
            }
            if phase == NativeGpuSwitchPhaseV1::ReplacementDeleteUncertain {
                return state.gpu_switch.advance_with_proof(
                    &access.switch_id,
                    access.record_revision,
                    NativeGpuSwitchPhaseV1::ReplacementDeleteIntent,
                );
            }
            Ok(snapshot)
        }
        _ => Ok(snapshot),
    }
}

/// Verify the exact replacement Pod and its owner-only CUDA/NVML runtime
/// projection, then bind the canonical private proof before exposing
/// `ready_paused`.  The renderer supplies only the durable revision key and
/// session; every Pod, principal, attempt, device and profile field comes from
/// native journals or pinned transports.
#[tauri::command]
async fn gpu_switch_verify_replacement(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: NativeGpuSwitchWorkerSyncV1,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    require_main_gpu_window(&window)?;
    let _profile_control_lease = acquire_profile_control_lease().await?;
    let access = with_gpu_profile_control(state.control_gate.as_ref(), || {
        state
            .gpu_switch
            .worker_access(&input.switch_id, input.expected_record_revision)
    })
    .await?;
    if access.session_id != input.session_id {
        return Err(NativeError::new(
            "gpu_switch_transition_invalid",
            "The GPU switch session does not match its native worker binding.",
        ));
    }
    let replacement_pod_id = access.replacement_pod_id.as_deref().ok_or_else(|| {
        NativeError::new(
            "gpu_switch_replacement_mismatch",
            "The replacement Pod does not match this GPU switch.",
        )
    })?;
    let provider_pod = match state.runpod.native_switch_get_pod(replacement_pod_id).await {
        Ok(Some(pod))
            if pod.pod_id == replacement_pod_id
                && pod.gpu_id == access.current_target.gpu_id
                && pod.status == "running" =>
        {
            pod
        }
        Ok(_) => {
            return state.gpu_switch.park_with_attention(
                &access.switch_id,
                access.record_revision,
                "gpu_switch_replacement_mismatch",
            )
        }
        Err(_) => {
            // An exact GET that is throttled, malformed, times out, or fails
            // after replacement creation is not safe to treat as a transient
            // renderer retry. Persist one non-retryable recovery state and do
            // not issue another provider mutation.
            return state.gpu_switch.park_with_attention(
                &access.switch_id,
                access.record_revision,
                "gpu_switch_provider_response_mismatch",
            );
        }
    };
    let binding = state.runpod.gpu_switch_runtime_binding()?;
    let finalization_id = access.finalization_id.clone().ok_or_else(|| {
        NativeError::new(
            "gpu_switch_store_unrecoverable",
            "GPU switch finalization evidence is unavailable.",
        )
    })?;
    let create_marker_sha256 = access.create_marker_sha256.clone().ok_or_else(|| {
        NativeError::new(
            "gpu_switch_store_unrecoverable",
            "GPU switch runtime evidence is unavailable until its local history is repaired.",
        )
    })?;
    let create_intent_sha256 = access.create_intent_sha256.clone().ok_or_else(|| {
        NativeError::new(
            "gpu_switch_store_unrecoverable",
            "GPU switch runtime evidence is unavailable until its local history is repaired.",
        )
    })?;
    let create_wire_body_sha256 = access.create_wire_body_sha256.clone().ok_or_else(|| {
        NativeError::new(
            "gpu_switch_store_unrecoverable",
            "GPU switch runtime evidence is unavailable until its local history is repaired.",
        )
    })?;
    let owner = match state
        .worker
        .gpu_switch_owner_lookup(&access.switch_id, &access.session_id, replacement_pod_id)
        .await
    {
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Found(owner))
            if owner.state == NativeWorkerGpuSwitchStateV1::DeleteIntent =>
        {
            match state
                .worker
                .gpu_switch_owner_action(
                    &access.switch_id,
                    &access.session_id,
                    replacement_pod_id,
                    NativeWorkerGpuSwitchOwnerActionV1::Adopt {
                        finalization_id,
                        replacement_attempt_id: access
                            .current_target
                            .replacement_attempt_id
                            .clone(),
                        replacement_attempt_revision: access.current_target.attempt_revision,
                        replacement_pod_id: replacement_pod_id.to_owned(),
                        target_gpu_id: access.current_target.gpu_id.clone(),
                        create_marker_sha256: create_marker_sha256.clone(),
                        create_intent_sha256,
                        create_wire_body_sha256,
                    },
                )
                .await
            {
                Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Owner(owner)) => owner,
                Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Rejected(error)) => {
                    return Err(native_gpu_switch_worker_rejection(error))
                }
                Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Uncertain) | Err(_) => {
                    return state.gpu_switch.park_with_attention(
                        &access.switch_id,
                        access.record_revision,
                        "gpu_switch_worker_guard_missing",
                    )
                }
            }
        }
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Found(owner)) => owner,
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Rejected(error)) => {
            return Err(native_gpu_switch_worker_rejection(error))
        }
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::NotFound) | Err(_) => {
            return state.gpu_switch.park_with_attention(
                &access.switch_id,
                access.record_revision,
                "gpu_switch_worker_guard_missing",
            )
        }
    };
    if owner.state != NativeWorkerGpuSwitchStateV1::ReplacementReady
        || !owner_replacement_matches_access(&owner, &access)
    {
        return state.gpu_switch.park_with_attention(
            &access.switch_id,
            access.record_revision,
            "gpu_switch_worker_guard_missing",
        );
    }
    let identity = match state
        .worker
        .gpu_switch_runtime_identity(&access.switch_id, &access.session_id, replacement_pod_id)
        .await
    {
        Ok(NativeWorkerGpuSwitchRuntimeIdentityResultV1::Found(identity)) => identity,
        Ok(NativeWorkerGpuSwitchRuntimeIdentityResultV1::Rejected(error))
            if error.code == "gpu_switch_runtime_identity_unavailable" =>
        {
            return state.gpu_switch.park_with_attention(
                &access.switch_id,
                access.record_revision,
                "gpu_switch_runtime_identity_unavailable",
            )
        }
        Ok(NativeWorkerGpuSwitchRuntimeIdentityResultV1::Rejected(error)) => {
            return Err(native_gpu_switch_worker_rejection(error))
        }
        Err(_) => {
            return state.gpu_switch.park_with_attention(
                &access.switch_id,
                access.record_revision,
                "gpu_switch_runtime_identity_unavailable",
            )
        }
    };
    if identity.principal_binding_id != access.principal_binding_id
        || identity.runtime_pod_id != provider_pod.pod_id
        || identity.runtime_volume_id != binding.network_volume_id
        || identity.runtime_data_center_id != binding.data_center_id
        || identity.image_digest != binding.image_digest
        || identity.expected_provider_gpu_id != provider_pod.gpu_id
        || identity.expected_provider_gpu_id != access.current_target.gpu_id
        || identity.replacement_attempt_id != access.current_target.replacement_attempt_id
        || identity.replacement_attempt_revision != access.current_target.attempt_revision
        || identity.create_marker_sha256 != create_marker_sha256
    {
        return state.gpu_switch.park_with_attention(
            &access.switch_id,
            access.record_revision,
            "gpu_switch_runtime_identity_unavailable",
        );
    }
    let runtime_identity_sha256 = gpu_switch_runtime_identity_sha256(&identity)?;
    with_gpu_profile_control(state.control_gate.as_ref(), || {
        state.gpu_switch.bind_verified_runtime_identity(
            &access.switch_id,
            access.record_revision,
            runtime_identity_sha256,
        )
    })
    .await
}

/// Complete only after the exact replacement is still running, the private
/// runtime proof is bound, and the replacement worker reports the matching
/// shared marker. The worker tombstone is committed before native terminal
/// history; response ambiguity parks without replaying the POST.
#[tauri::command]
async fn gpu_switch_complete(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: NativeGpuSwitchWorkerSyncV1,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    require_main_gpu_window(&window)?;
    let _profile_control_lease = acquire_profile_control_lease().await?;
    let access = state
        .gpu_switch
        .worker_access(&input.switch_id, input.expected_record_revision)?;
    if access.session_id != input.session_id || access.runtime_identity_sha256.is_none() {
        return Err(NativeError::new(
            "gpu_switch_runtime_identity_unavailable",
            "The replacement runtime identity is not verified.",
        ));
    }
    let replacement_pod_id = access.replacement_pod_id.as_deref().ok_or_else(|| {
        NativeError::new(
            "gpu_switch_replacement_mismatch",
            "The replacement Pod does not match this GPU switch.",
        )
    })?;
    let provider = state.runpod.native_switch_get_pod(replacement_pod_id).await;
    match provider {
        Ok(Some(pod))
            if pod.pod_id == replacement_pod_id
                && pod.gpu_id == access.current_target.gpu_id
                && pod.status == "running" => {}
        Ok(_) => {
            return state.gpu_switch.park_with_attention(
                &access.switch_id,
                access.record_revision,
                "gpu_switch_completion_failed",
            )
        }
        Err(_) => {
            return state.gpu_switch.park_with_attention(
                &access.switch_id,
                access.record_revision,
                "gpu_switch_completion_failed",
            )
        }
    }
    let owner = match state
        .worker
        .gpu_switch_owner_lookup(&access.switch_id, &access.session_id, replacement_pod_id)
        .await
    {
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Found(owner)) => owner,
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Rejected(error)) => {
            return Err(native_gpu_switch_worker_rejection(error))
        }
        Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::NotFound) | Err(_) => {
            return state.gpu_switch.park_with_attention(
                &access.switch_id,
                access.record_revision,
                "gpu_switch_completion_failed",
            )
        }
    };
    if owner.state != NativeWorkerGpuSwitchStateV1::ReplacementReady
        || !owner_replacement_matches_access(&owner, &access)
    {
        return state.gpu_switch.park_with_attention(
            &access.switch_id,
            access.record_revision,
            "gpu_switch_completion_failed",
        );
    }
    let finalization_id = access.finalization_id.clone().ok_or_else(|| {
        NativeError::new(
            "gpu_switch_store_unrecoverable",
            "GPU switch finalization evidence is unavailable.",
        )
    })?;
    let final_access = state
        .gpu_switch
        .worker_access(&access.switch_id, access.record_revision)?;
    if final_access.runtime_identity_sha256 != access.runtime_identity_sha256
        || final_access.replacement_pod_id != access.replacement_pod_id
    {
        return Err(NativeError::new(
            "gpu_control_guard_conflict",
            "GPU profile authority changed before completion.",
        ));
    }
    match state
        .worker
        .gpu_switch_owner_action(
            &access.switch_id,
            &access.session_id,
            replacement_pod_id,
            NativeWorkerGpuSwitchOwnerActionV1::Complete {
                finalization_id,
                replacement_attempt_id: access.current_target.replacement_attempt_id.clone(),
                replacement_attempt_revision: access.current_target.attempt_revision,
                replacement_pod_id: replacement_pod_id.to_owned(),
            },
        )
        .await
    {
        Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Owner(owner)) => {
            apply_gpu_switch_owner_lookup(&state, &access, owner)
        }
        Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Rejected(error)) => {
            Err(native_gpu_switch_worker_rejection(error))
        }
        Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Uncertain) | Err(_) => {
            state.gpu_switch.park_with_attention(
                &access.switch_id,
                access.record_revision,
                "gpu_switch_completion_failed",
            )
        }
    }
}

fn validate_gpu_switch_fresh_target(
    state: &NativeState,
    access: &native::gpu_switch::NativeGpuSwitchWorkerAccessV1,
    input: &NativeGpuSwitchFreshWorkerV1,
) -> NativeResult<()> {
    let evidence = state.gpu_inventory.switch_begin_evidence(
        &input.observation_id,
        &input.receipt_id,
        &input.target_gpu_id,
        input.confirmed_hourly_price_micro_usd,
    )?;
    if evidence.old_pod.pod_id != access.old_pod_id {
        return Err(NativeError::new(
            "gpu_switch_old_pod_changed",
            "The current GPU Pod changed before this switch could continue.",
        ));
    }
    if access.current_target.gpu_id != input.target_gpu_id
        || access.current_target.hourly_price_micro_usd != input.confirmed_hourly_price_micro_usd
        || access.current_target.gpu_display_name != evidence.target_gpu_display_name
    {
        return Err(NativeError::new(
            "gpu_switch_price_changed",
            "The selected GPU price changed. Confirm the current price.",
        ));
    }
    Ok(())
}

fn apply_gpu_switch_public_lookup(
    state: &NativeState,
    access: &native::gpu_switch::NativeGpuSwitchWorkerAccessV1,
    public: native::worker::NativeWorkerGpuSwitchPublicLookupV1,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    let current = state.gpu_switch.load()?;
    let record = current.record.as_ref().ok_or_else(|| {
        NativeError::new(
            "gpu_switch_not_found",
            "The GPU switch record is no longer available.",
        )
    })?;
    if public.switch_id != access.switch_id
        || record.switch_id != access.switch_id
        || record.record_revision != access.record_revision
    {
        return Err(NativeError::retryable(
            "gpu_switch_revision_conflict",
            "GPU switch state changed. Reload and choose again.",
        ));
    }
    if record.phase == NativeGpuSwitchPhaseV1::NeedsAttention {
        // Read-only Sync never constitutes Resume authorization.
        return Ok(current);
    }
    let next = match public.state {
        NativeWorkerGpuSwitchStateV1::Pending | NativeWorkerGpuSwitchStateV1::Approved => {
            return Ok(current)
        }
        NativeWorkerGpuSwitchStateV1::Pausing => NativeGpuSwitchPhaseV1::Pausing,
        NativeWorkerGpuSwitchStateV1::ReadyToDelete => NativeGpuSwitchPhaseV1::ReadyToDelete,
        NativeWorkerGpuSwitchStateV1::DeleteIntent => NativeGpuSwitchPhaseV1::DeleteIntent,
        NativeWorkerGpuSwitchStateV1::ReplacementReady => {
            if access.finalization_id.is_none()
                || public.replacement_attempt_id.as_deref()
                    != Some(access.current_target.replacement_attempt_id.as_str())
                || public.replacement_attempt_revision
                    != Some(access.current_target.attempt_revision)
                || public.replacement_pod_id != access.replacement_pod_id
                || public.actual_target_gpu_id.as_deref()
                    != Some(access.current_target.gpu_id.as_str())
            {
                return state.gpu_switch.park_with_attention(
                    &access.switch_id,
                    access.record_revision,
                    "gpu_switch_replacement_mismatch",
                );
            }
            // Worker readiness is only a prompt to run the native provider +
            // runtime-identity verifier. Sync must never manufacture the
            // `ready_paused` phase without that private proof.
            return Ok(current);
        }
        NativeWorkerGpuSwitchStateV1::NeedsAttention => {
            return state.gpu_switch.park_with_attention(
                &access.switch_id,
                access.record_revision,
                "gpu_switch_pause_failed",
            )
        }
        NativeWorkerGpuSwitchStateV1::Denied
        | NativeWorkerGpuSwitchStateV1::Expired
        | NativeWorkerGpuSwitchStateV1::Cancelled
        | NativeWorkerGpuSwitchStateV1::Completed => {
            unreachable!("terminal handled by owner proof")
        }
    };
    if record.phase == next {
        return Ok(current);
    }
    state
        .gpu_switch
        .advance_with_proof(&access.switch_id, access.record_revision, next)
}

fn apply_gpu_switch_owner_lookup(
    state: &NativeState,
    access: &native::gpu_switch::NativeGpuSwitchWorkerAccessV1,
    owner: native::worker::NativeWorkerGpuSwitchOwnerLookupV1,
) -> NativeResult<NativeGpuSwitchSnapshotV1> {
    if owner.requester_user_id != access.requester_user_id
        || owner.principal_binding_id != access.principal_binding_id
    {
        return state.gpu_switch.park_with_attention(
            &access.switch_id,
            access.record_revision,
            "gpu_switch_worker_guard_missing",
        );
    }
    let current = state.gpu_switch.load()?;
    let record = current.record.as_ref().ok_or_else(|| {
        NativeError::new(
            "gpu_switch_not_found",
            "The GPU switch record is no longer available.",
        )
    })?;
    if record.switch_id != access.switch_id || record.record_revision != access.record_revision {
        return Err(NativeError::retryable(
            "gpu_switch_revision_conflict",
            "GPU switch state changed. Reload and choose again.",
        ));
    }
    let finalized_state = matches!(
        owner.state,
        NativeWorkerGpuSwitchStateV1::Pausing
            | NativeWorkerGpuSwitchStateV1::ReadyToDelete
            | NativeWorkerGpuSwitchStateV1::DeleteIntent
            | NativeWorkerGpuSwitchStateV1::ReplacementReady
            | NativeWorkerGpuSwitchStateV1::Completed
    );
    if finalized_state
        && (access.finalization_id.is_none()
            || owner.finalization_id.as_deref() != access.finalization_id.as_deref())
    {
        return state.gpu_switch.park_with_attention(
            &access.switch_id,
            access.record_revision,
            "gpu_switch_worker_guard_missing",
        );
    }
    if matches!(
        owner.state,
        NativeWorkerGpuSwitchStateV1::ReplacementReady | NativeWorkerGpuSwitchStateV1::Completed
    ) && !owner_replacement_matches_access(&owner, access)
    {
        // The worker's ready/completed projection is authority only when all
        // four replacement fields match the durable native attempt. In
        // particular, a valid principal/finalization binding alone cannot
        // adopt a different Pod or target after a provider response loss.
        let attention = if record.phase == NativeGpuSwitchPhaseV1::ReadyPaused {
            "gpu_switch_completion_failed"
        } else {
            "gpu_switch_replacement_mismatch"
        };
        return state.gpu_switch.park_with_attention(
            &access.switch_id,
            access.record_revision,
            attention,
        );
    }
    if owner.state == NativeWorkerGpuSwitchStateV1::Completed
        && access.runtime_identity_sha256.is_none()
    {
        return state.gpu_switch.park_with_attention(
            &access.switch_id,
            access.record_revision,
            "gpu_switch_runtime_identity_unavailable",
        );
    }
    let terminal = match owner.state {
        NativeWorkerGpuSwitchStateV1::Denied => Some((
            NativeGpuSwitchPhaseV1::CancelledPreDelete,
            NativeGpuSwitchTerminalReasonV1::PeerDenied,
        )),
        NativeWorkerGpuSwitchStateV1::Expired => Some((
            NativeGpuSwitchPhaseV1::CancelledPreDelete,
            NativeGpuSwitchTerminalReasonV1::ResponseTimeout,
        )),
        NativeWorkerGpuSwitchStateV1::Cancelled => Some((
            NativeGpuSwitchPhaseV1::CancelledPreDelete,
            NativeGpuSwitchTerminalReasonV1::RequesterCancelled,
        )),
        NativeWorkerGpuSwitchStateV1::Completed => Some((
            NativeGpuSwitchPhaseV1::Completed,
            NativeGpuSwitchTerminalReasonV1::ReplacementCompleted,
        )),
        _ => None,
    };
    if let Some((terminal_phase, terminal_reason)) = terminal {
        let tombstone = require_gpu_switch_terminal_tombstone(&owner)?;
        return state.gpu_switch.terminalize_with_proof(
            &access.switch_id,
            access.record_revision,
            terminal_phase,
            NativeGpuSwitchTerminalProofV1 {
                terminal_reason,
                principal_binding_id: Some(access.principal_binding_id.clone()),
                worker_tombstone_sha256: Some(tombstone),
            },
        );
    }
    if record.phase == NativeGpuSwitchPhaseV1::NeedsAttention {
        // A read-only sync is never implicit Resume authority. A blocked
        // record remains parked until the user explicitly acquires it again.
        return Ok(current);
    }
    let next = match owner.state {
        NativeWorkerGpuSwitchStateV1::Pending | NativeWorkerGpuSwitchStateV1::Approved => {
            return Ok(current)
        }
        NativeWorkerGpuSwitchStateV1::Pausing => NativeGpuSwitchPhaseV1::Pausing,
        NativeWorkerGpuSwitchStateV1::ReadyToDelete => NativeGpuSwitchPhaseV1::ReadyToDelete,
        NativeWorkerGpuSwitchStateV1::DeleteIntent => NativeGpuSwitchPhaseV1::DeleteIntent,
        NativeWorkerGpuSwitchStateV1::ReplacementReady => {
            // Exact owner identity still cannot substitute the provider and
            // CUDA/NVML proof. The explicit verify command owns that durable
            // transition.
            return Ok(current);
        }
        NativeWorkerGpuSwitchStateV1::NeedsAttention => {
            return state.gpu_switch.park_with_attention(
                &access.switch_id,
                access.record_revision,
                "gpu_switch_pause_failed",
            )
        }
        NativeWorkerGpuSwitchStateV1::Denied
        | NativeWorkerGpuSwitchStateV1::Expired
        | NativeWorkerGpuSwitchStateV1::Cancelled
        | NativeWorkerGpuSwitchStateV1::Completed => unreachable!(),
    };
    if record.phase == next {
        return Ok(current);
    }
    state
        .gpu_switch
        .advance_with_proof(&access.switch_id, access.record_revision, next)
}

fn require_gpu_switch_terminal_tombstone(
    owner: &native::worker::NativeWorkerGpuSwitchOwnerLookupV1,
) -> NativeResult<String> {
    owner.terminal_tombstone_sha256.clone().ok_or_else(|| {
        NativeError::new(
            "gpu_switch_worker_response_invalid",
            "The worker did not provide terminal GPU switch evidence.",
        )
    })
}

fn owner_replacement_matches_access(
    owner: &native::worker::NativeWorkerGpuSwitchOwnerLookupV1,
    access: &native::gpu_switch::NativeGpuSwitchWorkerAccessV1,
) -> bool {
    owner.replacement_attempt_id.as_deref()
        == Some(access.current_target.replacement_attempt_id.as_str())
        && owner.replacement_attempt_revision == Some(access.current_target.attempt_revision)
        && owner.replacement_pod_id == access.replacement_pod_id
        && owner.actual_target_gpu_id.as_deref() == Some(access.current_target.gpu_id.as_str())
}

fn require_main_gpu_window(window: &WebviewWindow) -> NativeResult<()> {
    require_main_gpu_window_label(window.label())
}

/// Take the process-local GPU gate only for a small synchronous validation or
/// journal transition. The native `profile-control.lock` is the cross-process
/// transaction lease; neither this gate nor the worker's `.gpu-control-v1`
/// marker lock may span provider/worker socket I/O.
async fn with_gpu_profile_control<T>(
    control_gate: &tokio::sync::Mutex<()>,
    action: impl FnOnce() -> NativeResult<T>,
) -> NativeResult<T> {
    let _control = control_gate.lock().await;
    action()
}

/// Acquire the one cross-process lease used by all profile-scoped lifecycle
/// commands.  A caller that has a command-specific contention envelope (the
/// ordinary Start commands do) may map `gpu_switch_lease_busy` at its boundary;
/// all other callers expose the shared Switch lease code unchanged.
async fn acquire_profile_control_lease() -> NativeResult<ProfileControlLease> {
    let Some(lease) = ProfileControlLease::try_acquire().await? else {
        return Err(profile_control_lease_busy());
    };
    Ok(lease)
}

/// Task 014's ordinary Start registry intentionally does not expose the
/// cross-feature Switch lease code.  A held profile lease is instead the
/// registry's single retryable "another GPU operation" outcome.
fn gpu_start_operation_in_progress() -> NativeError {
    NativeError::retryable(
        "gpu_start_operation_in_progress",
        "Another ImageForge GPU operation is already in progress.",
    )
}

fn capture_normal_stop_profile_reservation(
    gpu_inventory: &GpuInventoryService,
    gpu_pod: &GpuPodService,
    gpu_switch: &GpuSwitchService,
    runpod: &RunPodTransport,
) -> NativeResult<NormalStopProfileReservation> {
    let process_epoch_id = gpu_inventory.process_epoch_id().to_owned();
    if gpu_pod.process_epoch_id() != process_epoch_id
        || gpu_switch.process_epoch_id() != process_epoch_id
    {
        return Err(normal_stop_profile_changed());
    }
    Ok(NormalStopProfileReservation {
        process_epoch_id,
        profile_generation: runpod.gpu_control_profile_generation()?,
    })
}

fn validate_normal_stop_profile_epoch(
    reservation: &NormalStopProfileReservation,
    gpu_inventory: &GpuInventoryService,
    gpu_pod: &GpuPodService,
    gpu_switch: &GpuSwitchService,
    runpod: &RunPodTransport,
) -> NativeResult<()> {
    if gpu_inventory.process_epoch_id() != reservation.process_epoch_id
        || gpu_pod.process_epoch_id() != reservation.process_epoch_id
        || gpu_switch.process_epoch_id() != reservation.process_epoch_id
        || runpod.gpu_control_profile_generation()? != reservation.profile_generation
    {
        return Err(normal_stop_profile_changed());
    }
    Ok(())
}

fn validate_normal_stop_mutation_context(
    expected_input: &NativeGpuNormalStopV1,
    context: &native::gpu_pod::NativeNormalStopMutationContextV1,
) -> NativeResult<()> {
    if context.input != *expected_input
        || !canonical_lowercase_uuid_v4(&context.operation_id)
        || !canonical_lowercase_uuid_v4(&context.finalization_id)
    {
        return Err(NativeError::new(
            "gpu_pod_observation_invalid",
            "The GPU Stop action changed before ImageForge could continue safely.",
        ));
    }
    Ok(())
}

fn canonical_lowercase_uuid_v4(value: &str) -> bool {
    Uuid::parse_str(value).ok().is_some_and(|uuid| {
        uuid.get_version() == Some(uuid::Version::Random) && uuid.to_string() == value
    })
}

fn normal_stop_profile_changed() -> NativeError {
    NativeError::new(
        "gpu_switch_profile_locked",
        "The ImageForge GPU profile changed before it could be stopped.",
    )
}

fn require_main_gpu_window_label(label: &str) -> NativeResult<()> {
    if label == "main" {
        Ok(())
    } else {
        Err(gpu_start_foreground_required())
    }
}

/// Keep the foreground boundary testable without a WebView. In particular,
/// `gpu_start_confirm_actual_price` passes the journal read as `access`, so a
/// forged/background caller cannot cause even a recovery-journal read.
fn with_gpu_start_foreground_facts<T>(
    window_label: &str,
    visible: bool,
    focused: bool,
    minimized: bool,
    access: impl FnOnce() -> NativeResult<T>,
) -> NativeResult<T> {
    require_main_gpu_window_label(window_label)?;
    if !visible || !focused || minimized {
        return Err(gpu_start_foreground_required());
    }
    access()
}

fn with_gpu_start_foreground<T>(
    window: &WebviewWindow,
    access: impl FnOnce() -> NativeResult<T>,
) -> NativeResult<T> {
    require_main_gpu_window(window)?;
    let visible = window
        .is_visible()
        .map_err(|_| gpu_start_foreground_required())?;
    let focused = window
        .is_focused()
        .map_err(|_| gpu_start_foreground_required())?;
    let minimized = window
        .is_minimized()
        .map_err(|_| gpu_start_foreground_required())?;
    with_gpu_start_foreground_facts(window.label(), visible, focused, minimized, access)
}

#[tauri::command]
async fn worker_health(state: State<'_, NativeState>) -> NativeResult<WorkerHttpResponse> {
    state.worker.health().await
}

#[tauri::command]
async fn worker_status(state: State<'_, NativeState>) -> NativeResult<WorkerHttpResponse> {
    state.worker.status().await
}

#[tauri::command]
async fn worker_studio_heartbeat(
    state: State<'_, NativeState>,
    input: native::worker::StudioHeartbeatInput,
) -> NativeResult<WorkerHttpResponse> {
    state.worker.studio_heartbeat(input).await
}

#[tauri::command]
async fn worker_studio_status(
    state: State<'_, NativeState>,
    session_id: String,
) -> NativeResult<WorkerHttpResponse> {
    state.worker.studio_status(&session_id).await
}

#[tauri::command]
async fn worker_studio_create_stop_request(
    state: State<'_, NativeState>,
    input: native::worker::StudioCreateStopRequestInput,
) -> NativeResult<WorkerHttpResponse> {
    state.worker.studio_create_stop_request(input).await
}

#[tauri::command]
async fn worker_studio_respond_to_stop_request(
    state: State<'_, NativeState>,
    input: native::worker::StudioStopResponseInput,
) -> NativeResult<WorkerHttpResponse> {
    state.worker.studio_respond_to_stop_request(input).await
}

#[tauri::command]
async fn worker_studio_respond_to_gpu_switch(
    state: State<'_, NativeState>,
    input: native::worker::StudioGpuSwitchResponseInput,
) -> NativeResult<WorkerHttpResponse> {
    state.worker.studio_respond_to_gpu_switch(input).await
}

#[tauri::command]
async fn worker_studio_cancel_stop_request(
    state: State<'_, NativeState>,
    input: native::worker::StudioCancelStopInput,
) -> NativeResult<WorkerHttpResponse> {
    state.worker.studio_cancel_stop_request(input).await
}

#[tauri::command]
async fn worker_create_batch(
    state: State<'_, NativeState>,
    input: native::worker::CreateBatchInput,
) -> NativeResult<WorkerHttpResponse> {
    state.worker.create_batch(input).await
}

fn parse_batch_id(value: &str) -> NativeResult<Uuid> {
    Uuid::parse_str(value).map_err(|_| {
        NativeError::new(
            "batch_id_invalid",
            "The worker returned an invalid batch identifier.",
        )
    })
}

fn navigation_allowed(url: &url::Url) -> bool {
    let production = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"));
    let development = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(5173);
    (production || development)
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && !url.path().contains('\\')
}

#[tauri::command]
async fn worker_get_batch(
    state: State<'_, NativeState>,
    batch_id: String,
) -> NativeResult<WorkerHttpResponse> {
    state.worker.get_batch(parse_batch_id(&batch_id)?).await
}

#[tauri::command]
async fn worker_get_submission(
    state: State<'_, NativeState>,
    client_submission_id: String,
) -> NativeResult<WorkerHttpResponse> {
    let submission_id = native::worker::parse_submission_uuid(&client_submission_id)?;
    state.worker.get_submission(submission_id).await
}

#[tauri::command]
async fn worker_pause_batch(
    state: State<'_, NativeState>,
    batch_id: String,
) -> NativeResult<WorkerHttpResponse> {
    state.worker.pause(parse_batch_id(&batch_id)?).await
}

#[tauri::command]
async fn worker_resume_batch(
    state: State<'_, NativeState>,
    batch_id: String,
) -> NativeResult<WorkerHttpResponse> {
    state.worker.resume(parse_batch_id(&batch_id)?).await
}

#[tauri::command]
async fn worker_cancel_batch(
    state: State<'_, NativeState>,
    batch_id: String,
) -> NativeResult<WorkerHttpResponse> {
    state.worker.cancel(parse_batch_id(&batch_id)?).await
}

#[tauri::command]
async fn worker_retry_failed(
    state: State<'_, NativeState>,
    batch_id: String,
) -> NativeResult<WorkerHttpResponse> {
    state.worker.retry_failed(parse_batch_id(&batch_id)?).await
}

#[tauri::command]
async fn worker_fetch_preview(
    state: State<'_, NativeState>,
    batch_id: String,
    index: u64,
) -> NativeResult<WorkerPreviewResponse> {
    state
        .worker
        .preview(parse_batch_id(&batch_id)?, index)
        .await
}

#[tauri::command]
async fn download_artifact(
    state: State<'_, NativeState>,
    request: DownloadRequest,
) -> NativeResult<DownloadReceipt> {
    state.downloader.download_and_acknowledge(request).await
}

#[tauri::command]
async fn read_local_artifact(
    state: State<'_, NativeState>,
    batch_id: String,
    index: u64,
) -> NativeResult<LocalArtifactResponse> {
    state
        .downloader
        .read_local_artifact(parse_batch_id(&batch_id)?, index)
        .await
}

#[tauri::command]
async fn export_artifact(
    state: State<'_, NativeState>,
    request: ExportArtifactRequest,
) -> NativeResult<Option<String>> {
    let (suggested_name, artifact) = state.downloader.read_export_artifact(&request).await?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let Some(selection) = rfd::AsyncFileDialog::new()
            .set_title("Download ImageForge image")
            .set_file_name(&suggested_name)
            .add_filter("JPEG image", &["jpg", "jpeg"])
            .save_file()
            .await
        else {
            return Ok(None);
        };
        let selected_path = selection.path().to_path_buf();
        let write_path = selected_path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            native::download::write_export_file(&write_path, &artifact.bytes)
        })
        .await
        .map_err(|_| {
            NativeError::new("native_task_failed", "The image copy could not be saved.")
        })??;
        Ok(Some(selected_path.to_string_lossy().into_owned()))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (suggested_name, artifact);
        Err(NativeError::new(
            "platform_unsupported",
            "Image download is available in the macOS and Windows apps.",
        ))
    }
}

#[tauri::command]
async fn read_receipt_ledger(
    state: State<'_, NativeState>,
    batch_id: String,
    batch_name: Option<String>,
) -> NativeResult<ReceiptLedger> {
    state
        .downloader
        .read_receipt_ledger(parse_batch_id(&batch_id)?, batch_name.as_deref())
        .await
}

#[tauri::command]
async fn reconcile_receipts(
    state: State<'_, NativeState>,
    batch_id: String,
) -> NativeResult<ReceiptLedger> {
    state
        .downloader
        .reconcile_receipts(parse_batch_id(&batch_id)?)
        .await
}

#[tauri::command]
async fn queue_load(state: State<'_, NativeState>) -> NativeResult<NativeQueueSnapshotV1> {
    let queue = state.queue.clone();
    tauri::async_runtime::spawn_blocking(move || queue.load())
        .await
        .map_err(|_| {
            NativeError::new("native_task_failed", "The local queue could not be loaded.")
        })?
}

fn enforce_queue_commit_switch_gate(
    gpu_switch: &GpuSwitchService,
    touches_profile_state: bool,
) -> NativeResult<()> {
    if touches_profile_state {
        gpu_switch.veto_queue_action_from_disk()?;
    }
    Ok(())
}

#[tauri::command]
async fn queue_commit(
    state: State<'_, NativeState>,
    input: NativeQueueCommitV1,
) -> NativeResult<NativeQueueSnapshotV1> {
    // Classify the exact delta against the same durable queue generation that
    // `commit` will compare again. A document may contain a current run while
    // changing only `runRevision: null` Next-run rows; those edits remain legal
    // during a coordinated Switch and must not be mistaken for Run/Resume.
    let classifier_queue = state.queue.clone();
    let classifier_input = input.clone();
    let touches_profile_state = tauri::async_runtime::spawn_blocking(move || {
        classifier_queue.commit_touches_profile_state(&classifier_input)
    })
    .await
    .map_err(|_| NativeError::new("native_task_failed", "The local queue could not be saved."))??;
    let _profile_control_lease = if touches_profile_state {
        Some(acquire_profile_control_lease().await?)
    } else {
        None
    };
    enforce_queue_commit_switch_gate(&state.gpu_switch, touches_profile_state)?;
    let queue = state.queue.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if touches_profile_state {
            queue.commit(input)
        } else {
            queue.commit_next_run_only(input)
        }
    })
    .await
    .map_err(|_| NativeError::new("native_task_failed", "The local queue could not be saved."))?
}

#[tauri::command]
async fn queue_reset(
    state: State<'_, NativeState>,
    input: NativeQueueResetInput,
) -> NativeResult<NativeQueueSnapshotV1> {
    let _profile_control_lease = acquire_profile_control_lease().await?;
    state.gpu_switch.veto_queue_action_from_disk()?;
    let queue = state.queue.clone();
    tauri::async_runtime::spawn_blocking(move || queue.reset(input))
        .await
        .map_err(|_| {
            NativeError::new("native_task_failed", "The local queue could not be reset.")
        })?
}

#[tauri::command]
async fn queue_prepare_dispatch(
    state: State<'_, NativeState>,
    input: NativeQueueItemKey,
) -> NativeResult<NativeQueueDispatchPayloadV1> {
    let dispatch = input.purpose == QueueItemPayloadPurpose::Dispatch;
    let _profile_control_lease = if dispatch {
        Some(acquire_profile_control_lease().await?)
    } else {
        None
    };
    if dispatch {
        state.gpu_switch.veto_queue_action_from_disk()?;
    }
    let queue = state.queue.clone();
    tauri::async_runtime::spawn_blocking(move || queue.prepare_dispatch(input))
        .await
        .map_err(|_| {
            NativeError::new(
                "native_task_failed",
                "The queued batch could not be prepared for dispatch.",
            )
        })?
}

#[tauri::command]
async fn queue_acquire_runner(
    state: State<'_, NativeState>,
    input: NativeRunKey,
) -> NativeResult<NativeRunnerLease> {
    let _profile_control_lease = acquire_profile_control_lease().await?;
    state.gpu_switch.veto_queue_action_from_disk()?;
    let queue = state.queue.clone();
    tauri::async_runtime::spawn_blocking(move || queue.acquire_runner(input))
        .await
        .map_err(|_| {
            NativeError::new(
                "native_task_failed",
                "The local queue runner is unavailable.",
            )
        })?
}

#[tauri::command]
async fn queue_release_runner(
    state: State<'_, NativeState>,
    input: NativeRunKey,
) -> NativeResult<NativeRunnerLease> {
    // A release has no provider/worker side effect, but it still changes the
    // scheduler's process ownership.  Serialize it with profile actions; the
    // dedicated Switch park path owns releases while a reservation is active.
    let _profile_control_lease = acquire_profile_control_lease().await?;
    state.gpu_switch.veto_queue_action_from_disk()?;
    let queue = state.queue.clone();
    tauri::async_runtime::spawn_blocking(move || queue.release_runner(input))
        .await
        .map_err(|_| {
            NativeError::new(
                "native_task_failed",
                "The local queue runner is unavailable.",
            )
        })?
}

#[tauri::command]
async fn queue_set_sleep_prevention(
    state: State<'_, NativeState>,
    input: NativePowerInput,
) -> NativeResult<NativePowerState> {
    let queue = state.queue.clone();
    tauri::async_runtime::spawn_blocking(move || queue.set_sleep_prevention(input))
        .await
        .map_err(|_| NativeError::new("native_task_failed", "Keep-awake could not be updated."))?
}

#[tauri::command]
fn queue_signal_alert(
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
    input: NativeAlertInput,
) -> NativeResult<NativeAlertResult> {
    let queue = state.queue.clone();
    queue.signal_alert(input, |copy| match app.notification().permission_state() {
        Ok(PermissionState::Granted) => match app
            .notification()
            .builder()
            .id(copy.notification_id)
            .title(copy.title)
            .body(copy.body)
            .show()
        {
            Ok(()) => native::AlertDeliveryDisposition::Delivered,
            Err(_) => native::AlertDeliveryDisposition::Failed,
        },
        Ok(_) => native::AlertDeliveryDisposition::PermissionDenied,
        Err(_) => native::AlertDeliveryDisposition::Failed,
    })
}

/// Installed-artifact-only Task 013 evidence bridge. The host exposes no
/// queue-release automation in production or in the existing two-client
/// smoke; all filesystem paths and trusted-key behavior remain native-owned.
#[tauri::command]
fn native_queue_release_smoke_exchange(
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
    input: NativeQueueReleaseSmokeInput,
) -> NativeResult<NativeQueueReleaseSmokeResultV1> {
    let smoke = state.queue_release_smoke.as_ref().ok_or_else(|| {
        NativeError::new(
            "native_smoke_disabled",
            "Queue release smoke exchange is only available in its explicit test process.",
        )
    })?;
    smoke.exchange(&app, &state.destination, &state.queue, input)
}

#[tauri::command]
fn native_smoke_result(app: tauri::AppHandle, passed: bool, detail: String) -> NativeResult<()> {
    if !matches!(
        std::env::var("IMAGEFORGE_NATIVE_SMOKE").ok().as_deref(),
        Some("1" | "two-client")
    ) {
        return Err(NativeError::new(
            "native_smoke_disabled",
            "Native smoke reporting is only available in an explicit test process.",
        ));
    }
    if detail.len() > 240 || detail.chars().any(char::is_control) {
        return Err(NativeError::new(
            "native_smoke_invalid",
            "Native smoke detail is invalid.",
        ));
    }
    let path = std::env::var_os("IMAGEFORGE_NATIVE_SMOKE_RESULT").ok_or_else(|| {
        NativeError::new(
            "native_smoke_unconfigured",
            "Native smoke result path is not configured.",
        )
    })?;
    if app.get_webview_window("main").is_none() {
        return Err(NativeError::new(
            "native_smoke_window_missing",
            "The native smoke result requires a live main application window.",
        ));
    }
    let result = if passed { "PASS" } else { "FAIL" };
    let process_id = std::process::id();
    fs::write(
        path,
        format!("{result}\npid={process_id}; window=main; {detail}\n"),
    )
    .map_err(|_| {
        NativeError::new(
            "native_smoke_write_failed",
            "The native smoke result could not be written.",
        )
    })
}

#[tauri::command]
async fn native_two_client_smoke_exchange(input: NativeTwoClientSmokeInput) -> NativeResult<Value> {
    native::smoke::exchange(input).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = NativeState::new().expect("ImageForge secure native state failed to initialize");
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(state)
        .setup(|app| {
            let smoke_setting = std::env::var("IMAGEFORGE_NATIVE_SMOKE").ok();
            let queue_release_smoke = smoke_setting.as_deref() == Some("queue-release");
            let smoke_mode = matches!(smoke_setting.as_deref(), Some("1" | "two-client"))
                || queue_release_smoke;
            let two_client_role = if smoke_setting.as_deref() == Some("two-client") {
                match std::env::var("IMAGEFORGE_NATIVE_SMOKE_ROLE").ok().as_deref() {
                    Some("A") => Some("A"),
                    Some("B") => Some("B"),
                    _ => None,
                }
            } else {
                None
            };
            let mut builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()));
            if smoke_mode {
                let initialization = if queue_release_smoke {
                    "window.__IMAGEFORGE_QUEUE_RELEASE_SMOKE__ = true;".to_string()
                } else {
                    match two_client_role {
                        Some(role) => format!(
                            "window.__IMAGEFORGE_NATIVE_SMOKE__ = true; window.__IMAGEFORGE_NATIVE_SMOKE_ROLE__ = '{role}';"
                        ),
                        None => "window.__IMAGEFORGE_NATIVE_SMOKE__ = true;".to_string(),
                    }
                };
                builder = builder.initialization_script(&initialization);
                if queue_release_smoke {
                    // The installed queue harness measures exact inner viewports;
                    // macOS can persist a titlebar-zoomed state across the
                    // intentional phase-1 process termination. Disable the
                    // zoom affordance for this explicit smoke-only window so
                    // setSize can deterministically control the inner frame.
                    builder = builder.maximizable(false);
                }
            }
            #[cfg(target_os = "macos")]
            if let Some(role) = two_client_role {
                // WKWebView has no data-directory override. Give each smoke
                // role a stable, isolated store so two installed processes
                // cannot accidentally share localStorage or browser state.
                let identifier = match role {
                    "A" => [
                        0x49, 0x46, 0x53, 0x41, 0x20, 0x26, 0x4a, 0x11, 0x91, 0x01, 0xa1,
                        0x01, 0x00, 0x00, 0x00, 0x01,
                    ],
                    _ => [
                        0x49, 0x46, 0x53, 0x42, 0x20, 0x26, 0x4a, 0x11, 0x91, 0x01, 0xb2,
                        0x02, 0x00, 0x00, 0x00, 0x02,
                    ],
                };
                builder = builder.data_store_identifier(identifier);
            }
            #[cfg(target_os = "windows")]
            if two_client_role.is_some() || queue_release_smoke {
                let profile = std::env::var_os("IMAGEFORGE_NATIVE_SMOKE_PROFILE")
                    .map(PathBuf::from)
                    .filter(|path| path.is_absolute())
                    .ok_or_else(|| {
                        std::io::Error::new(
                            std::io::ErrorKind::InvalidInput,
                            "The native smoke profile is not configured.",
                        )
                    })?;
                builder = builder.data_directory(profile);
            }
            let window = builder
                .title("ImageForge")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 650.0)
                .resizable(true)
                .fullscreen(false)
                .center()
                .on_navigation(navigation_allowed)
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()?;
            let selector_perf = app.state::<NativeState>().gpu_selector_perf.clone();
            let trusted_input = app.state::<NativeState>().trusted_input.clone();
            let native_input_hook = native::trusted_input::install(
                &window,
                trusted_input.clone(),
                selector_perf.clone(),
            )
            .ok();
            window.on_window_event(move |event| match event {
                WindowEvent::Focused(false) => {
                    selector_perf.invalidate_native_sample();
                    trusted_input.invalidate();
                    if let Some(hook) = &native_input_hook {
                        hook.invalidate();
                    }
                }
                WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                    selector_perf.invalidate_native_sample();
                    trusted_input.invalidate();
                    if let Some(hook) = &native_input_hook {
                        hook.invalidate();
                        // Resizing/scaling invalidates the old activation and
                        // selector sample, but does not imply that focus was
                        // lost.  Re-arm the already-registered native hook;
                        // each platform callback still checks foreground,
                        // visibility, and focus before recording evidence.
                        hook.activate();
                    }
                }
                WindowEvent::Focused(true) => {
                    if let Some(hook) = &native_input_hook {
                        hook.activate();
                    }
                }
                WindowEvent::Destroyed => {
                    selector_perf.invalidate_native_sample();
                    trusted_input.invalidate();
                    if let Some(hook) = &native_input_hook {
                        hook.remove_on_main_thread();
                    }
                }
                _ => {}
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_environment,
            credential_metadata,
            replace_credential,
            choose_destination,
            validate_destination,
            restore_destination,
            reveal_destination,
            write_manifest,
            bind_worker_session,
            clear_worker_session,
            bind_runpod_profile,
            authorize_runpod_create,
            authorize_emergency_gpu,
            clear_runpod_start_authorization,
            runpod_create_marker_metadata,
            resolve_runpod_create_marker,
            gpu_inventory_load,
            gpu_selector_perf_arm,
            gpu_selector_perf_commit,
            gpu_inventory_begin_refresh,
            gpu_pod_observe,
            gpu_normal_stop_load,
            gpu_normal_stop,
            gpu_start_load,
            gpu_start_auto,
            gpu_start_selected,
            gpu_start_confirm_actual_price,
            gpu_switch_load,
            gpu_switch_authorize_foreground,
            gpu_switch_begin,
            gpu_switch_acquire,
            gpu_switch_release,
            gpu_switch_sync_worker,
            gpu_switch_finalize,
            gpu_switch_cancel,
            gpu_switch_confirm_target,
            gpu_switch_delete_old,
            gpu_switch_prepare_attempt,
            gpu_switch_confirm_attempt,
            gpu_switch_create_replacement,
            gpu_switch_confirm_actual_price,
            gpu_switch_delete_replacement,
            gpu_switch_reconcile_provider,
            gpu_switch_verify_replacement,
            gpu_switch_complete,
            worker_health,
            worker_status,
            worker_studio_heartbeat,
            worker_studio_status,
            worker_studio_create_stop_request,
            worker_studio_respond_to_stop_request,
            worker_studio_respond_to_gpu_switch,
            worker_studio_cancel_stop_request,
            worker_create_batch,
            worker_get_batch,
            worker_get_submission,
            worker_pause_batch,
            worker_resume_batch,
            worker_cancel_batch,
            worker_retry_failed,
            worker_fetch_preview,
            download_artifact,
            read_local_artifact,
            export_artifact,
            read_receipt_ledger,
            reconcile_receipts,
            queue_load,
            queue_commit,
            queue_reset,
            queue_prepare_dispatch,
            queue_acquire_runner,
            queue_release_runner,
            queue_set_sleep_prevention,
            queue_signal_alert,
            native_queue_release_smoke_exchange,
            native_smoke_result,
            native_two_client_smoke_exchange,
        ])
        .run(tauri::generate_context!())
        .expect("ImageForge native host failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn app_environment_reports_real_native_boundary() {
        let environment = app_environment();
        assert!(environment.native_core);
        assert_eq!(environment.release_channel, "native-beta");
    }

    #[test]
    fn batch_ids_are_uuid_only() {
        assert!(parse_batch_id("00000000-0000-4000-8000-000000000001").is_ok());
        assert_eq!(
            parse_batch_id("../../secret").unwrap_err().code,
            "batch_id_invalid"
        );
    }

    #[test]
    fn top_level_navigation_is_restricted_to_the_app_origin() {
        assert!(navigation_allowed(
            &url::Url::parse("tauri://localhost/index.html").unwrap()
        ));
        assert!(navigation_allowed(
            &url::Url::parse("tauri://localhost/assets/index.js").unwrap()
        ));
        assert!(navigation_allowed(
            &url::Url::parse("http://tauri.localhost/").unwrap()
        ));
        assert!(!navigation_allowed(
            &url::Url::parse("https://example.com/").unwrap()
        ));
        assert!(!navigation_allowed(
            &url::Url::parse("http://tauri.localhost/?redirect=https://example.com").unwrap()
        ));
        assert_eq!(
            navigation_allowed(&url::Url::parse("http://127.0.0.1:5173/").unwrap()),
            cfg!(debug_assertions)
        );
    }

    #[test]
    fn actual_price_foreground_gate_blocks_journal_access_for_non_main_or_background_callers() {
        for (label, visible, focused, minimized) in [
            ("secondary", true, true, false),
            ("main", false, true, false),
            ("main", true, false, false),
            ("main", true, true, true),
        ] {
            let journal_accessed = Cell::new(false);
            let error = with_gpu_start_foreground_facts(label, visible, focused, minimized, || {
                journal_accessed.set(true);
                Ok(())
            })
            .unwrap_err();
            assert_eq!(error.code, "gpu_start_foreground_required");
            assert!(!journal_accessed.get(), "{label} must not read the journal");
        }

        let journal_accessed = Cell::new(false);
        with_gpu_start_foreground_facts("main", true, true, false, || {
            journal_accessed.set(true);
            Ok(())
        })
        .unwrap();
        assert!(journal_accessed.get());
    }

    #[test]
    fn ordinary_stop_recovery_load_rejects_a_non_main_window_before_store_access() {
        let store_accessed = Cell::new(false);
        let error = require_main_gpu_window_label("secondary")
            .and_then(|_| {
                store_accessed.set(true);
                Ok(())
            })
            .unwrap_err();
        assert_eq!(error.code, "gpu_start_foreground_required");
        assert!(!store_accessed.get());

        require_main_gpu_window_label("main")
            .and_then(|_| {
                store_accessed.set(true);
                Ok(())
            })
            .unwrap();
        assert!(store_accessed.get());
    }

    #[tokio::test]
    async fn normal_stop_profile_control_gate_releases_before_socket_work() {
        let gate = Arc::new(tokio::sync::Mutex::new(()));
        let (gate_checked_send, gate_checked_receive) = tokio::sync::oneshot::channel();
        with_gpu_profile_control(gate.as_ref(), || {
            gate_checked_send
                .send(())
                .expect("short check entered once");
            Ok::<(), NativeError>(())
        })
        .await
        .expect("short check succeeds");
        gate_checked_receive.await.expect("short check observed");

        // Simulate a worker/provider socket that remains live after the short
        // local check. This test proves only that the Tokio mutex is not held
        // across that socket; it does not claim an unmigrated Start/Switch
        // caller acquires the OS profile-control lease.
        let (socket_started_send, socket_started_receive) = tokio::sync::oneshot::channel();
        let (socket_release_send, socket_release_receive) = tokio::sync::oneshot::channel();
        let socket = tokio::spawn(async move {
            socket_started_send.send(()).expect("socket started once");
            socket_release_receive
                .await
                .expect("release simulated socket");
        });
        socket_started_receive
            .await
            .expect("wait for simulated socket");

        let (competitor_send, competitor_receive) = tokio::sync::oneshot::channel();
        let competitor_gate = gate.clone();
        let competitor = tokio::spawn(async move {
            let _control = competitor_gate.lock().await;
            competitor_send.send(()).expect("competitor entered once");
        });
        tokio::time::timeout(Duration::from_secs(1), competitor_receive)
            .await
            .expect("gate is not held across socket work")
            .expect("competitor notification");

        socket_release_send
            .send(())
            .expect("release simulated socket once");
        socket.await.expect("socket task joined");
        competitor.await.expect("competitor task joined");
    }

    #[test]
    fn active_switch_gate_allows_next_run_only_commit_classification() {
        let temporary = tempfile::tempdir().expect("temporary Switch journal");
        let switch = GpuSwitchService::new_for_test(temporary.path().join("gpu-switch"))
            .expect("test Switch service");
        let observation_id = "00000000-0000-4000-8000-000000000002";
        let receipt_id = "00000000-0000-4000-8000-000000000003";
        let session_id = "00000000-0000-4000-8000-000000000004";
        let target_gpu_id = "NVIDIA GeForce RTX 5090";
        let grant = switch
            .authorize_foreground(
                native::gpu_switch::NativeGpuSwitchForegroundGrantRequestV1::Begin(
                    native::gpu_switch::NativeGpuSwitchBeginGrantRequestV1 {
                        action: native::gpu_switch::NativeGpuSwitchBeginGrantActionV1::Begin,
                        switch_id: native::gpu_switch::RequiredJsonNull,
                        observation_id: observation_id.to_owned(),
                        target_gpu_id: target_gpu_id.to_owned(),
                    },
                ),
            )
            .expect("foreground grant");
        switch
            .begin(
                NativeGpuSwitchBeginV1 {
                    observation_id: observation_id.to_owned(),
                    receipt_id: receipt_id.to_owned(),
                    target_gpu_id: target_gpu_id.to_owned(),
                    confirmed_hourly_price_micro_usd: 700_000,
                    expected_store_revision: 0,
                    session_id: session_id.to_owned(),
                    queue_expected_store_revision: 0,
                    queue_run_revision: None,
                    foreground_grant_id: grant.grant_id,
                },
                native::gpu_switch::NativeGpuSwitchSelectionEvidenceV1 {
                    old_pod: native::gpu_inventory::NativeGpuSwitchPodV1 {
                        pod_id: "old-pod-1".to_owned(),
                        gpu_id: "NVIDIA GeForce RTX 4090".to_owned(),
                        gpu_display_name: "RTX 4090".to_owned(),
                        hourly_price_micro_usd: Some(500_000),
                    },
                    target_gpu_display_name: "RTX 5090".to_owned(),
                    inventory_observed_at: "2026-08-04T00:00:00.000Z".to_owned(),
                    inventory_catalog_sha256:
                        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                            .to_owned(),
                },
            )
            .expect("active local Switch reservation");

        // The queue classifier returns false only for an unchanged current run
        // plus `runRevision: null` staging/editing, so the command deliberately
        // skips the Switch veto for that one contract-authorized delta.
        enforce_queue_commit_switch_gate(&switch, false)
            .expect("Next-run-only edit remains available");
        let blocked = enforce_queue_commit_switch_gate(&switch, true)
            .expect_err("current-run mutation remains blocked");
        assert_eq!(blocked.code, "queue_gpu_switch_pending");
    }

    fn gpu_switch_owner_identity_fixture() -> (
        native::gpu_switch::NativeGpuSwitchWorkerAccessV1,
        native::worker::NativeWorkerGpuSwitchOwnerLookupV1,
    ) {
        let target = native::gpu_switch::NativeGpuSwitchTargetV1 {
            replacement_attempt_id: "10000000-0000-4000-8000-000000000001".to_owned(),
            attempt_revision: 1,
            gpu_id: "NVIDIA L4".to_owned(),
            gpu_display_name: "NVIDIA L4".to_owned(),
            hourly_price_micro_usd: 420_000,
            observation_id: "10000000-0000-4000-8000-000000000002".to_owned(),
            receipt_id: "10000000-0000-4000-8000-000000000003".to_owned(),
            inventory_observed_at: "2026-08-04T00:00:00.000Z".to_owned(),
            price_confirmed_at: "2026-08-04T00:00:00.000Z".to_owned(),
        };
        let access = native::gpu_switch::NativeGpuSwitchWorkerAccessV1 {
            switch_id: "10000000-0000-4000-8000-000000000004".to_owned(),
            record_revision: 5,
            session_id: "10000000-0000-4000-8000-000000000005".to_owned(),
            old_pod_id: "pod-old-1".to_owned(),
            old_gpu_id: "NVIDIA GeForce RTX 4090".to_owned(),
            replacement_pod_id: Some("pod-new-1".to_owned()),
            finalization_id: Some("10000000-0000-4000-8000-000000000006".to_owned()),
            requester_user_id: "lakshman".to_owned(),
            principal_binding_id: "10000000-0000-4000-8000-000000000007".to_owned(),
            current_target: target,
            provider_request_sha256: None,
            provider_response_sha256: None,
            create_marker_sha256: None,
            create_intent_sha256: None,
            create_wire_body_sha256: None,
            runtime_identity_sha256: None,
        };
        let owner = native::worker::NativeWorkerGpuSwitchOwnerLookupV1 {
            schema_version: 1,
            switch_id: access.switch_id.clone(),
            state: NativeWorkerGpuSwitchStateV1::ReplacementReady,
            requester_user_id: access.requester_user_id.clone(),
            principal_binding_id: access.principal_binding_id.clone(),
            finalization_id: access.finalization_id.clone(),
            terminal_tombstone_sha256: None,
            replacement_attempt_id: Some(access.current_target.replacement_attempt_id.clone()),
            replacement_attempt_revision: Some(access.current_target.attempt_revision),
            replacement_pod_id: access.replacement_pod_id.clone(),
            actual_target_gpu_id: Some(access.current_target.gpu_id.clone()),
        };
        (access, owner)
    }

    #[test]
    fn owner_ready_or_completed_projection_requires_all_durable_replacement_fields() {
        let (access, owner) = gpu_switch_owner_identity_fixture();
        assert!(owner_replacement_matches_access(&owner, &access));

        let mut wrong_attempt = owner.clone();
        wrong_attempt.replacement_attempt_id =
            Some("10000000-0000-4000-8000-000000000008".to_owned());
        assert!(!owner_replacement_matches_access(&wrong_attempt, &access));

        let mut wrong_revision = owner.clone();
        wrong_revision.replacement_attempt_revision = Some(2);
        assert!(!owner_replacement_matches_access(&wrong_revision, &access));

        let mut wrong_pod = owner.clone();
        wrong_pod.replacement_pod_id = Some("pod-other-1".to_owned());
        assert!(!owner_replacement_matches_access(&wrong_pod, &access));

        let mut wrong_gpu = owner;
        wrong_gpu.actual_target_gpu_id = Some("NVIDIA RTX 4090".to_owned());
        assert!(!owner_replacement_matches_access(&wrong_gpu, &access));
    }

    #[test]
    fn terminal_worker_owner_without_tombstone_fails_closed() {
        let (_access, mut owner) = gpu_switch_owner_identity_fixture();
        owner.state = NativeWorkerGpuSwitchStateV1::Cancelled;
        owner.terminal_tombstone_sha256 = None;
        let error = require_gpu_switch_terminal_tombstone(&owner)
            .expect_err("terminal owner must carry exact tombstone evidence");
        assert_eq!(error.code, "gpu_switch_worker_response_invalid");

        owner.terminal_tombstone_sha256 = Some("a".repeat(64));
        assert_eq!(
            require_gpu_switch_terminal_tombstone(&owner).unwrap(),
            "a".repeat(64)
        );
    }

    #[test]
    fn definitive_worker_rejections_remain_typed_for_sync_and_finalize() {
        let rejection = native::worker::NativeWorkerGpuSwitchErrorV1 {
            code: "gpu_switch_not_approved".to_owned(),
            message: "Required switch approvals are not complete.".to_owned(),
        };
        let mapped = native_gpu_switch_worker_rejection(rejection);
        assert_eq!(mapped.code, "gpu_switch_not_approved");
        assert_eq!(
            mapped.message,
            "Required switch approvals are not complete."
        );
        assert!(!mapped.retryable);

        let malformed =
            native_gpu_switch_worker_rejection(native::worker::NativeWorkerGpuSwitchErrorV1 {
                code: "unrecognized_but_validated_nowhere".to_owned(),
                message: "safe fallback".to_owned(),
            });
        assert_eq!(malformed.code, "gpu_switch_worker_response_invalid");
    }

    #[test]
    fn pre_finalize_owner_lookup_propagates_definitive_rejection() {
        let error = classify_gpu_switch_pre_finalize_owner_lookup(Ok(
            NativeWorkerGpuSwitchOwnerLookupResultV1::Rejected(
                native::worker::NativeWorkerGpuSwitchErrorV1 {
                    code: "gpu_switch_not_approved".to_owned(),
                    message: "Required switch approvals are not complete.".to_owned(),
                },
            ),
        ))
        .unwrap_err();

        assert_eq!(error.code, "gpu_switch_not_approved");
        assert_eq!(error.message, "Required switch approvals are not complete.");
        assert!(!error.retryable);

        assert!(classify_gpu_switch_pre_finalize_owner_lookup(Ok(
            NativeWorkerGpuSwitchOwnerLookupResultV1::NotFound,
        ))
        .unwrap()
        .is_none());
    }
}
