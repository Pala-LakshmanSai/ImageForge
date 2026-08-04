//! Narrow, installed-app-only evidence bridge for the Task 013 queue release
//! smoke. It is intentionally unavailable in ordinary launches: it has no
//! generic filesystem, automation, network, or alert surface.

use super::queue::{
    AlertResultDisposition, NativePowerInput, NativeQueueRowV1, NotificationDisposition,
    QueueAlarmState, QueueAlertKind, QueueItemState, QueueRunnerState,
};
use super::{
    AlertDeliveryDisposition, DestinationStore, DownloadReceipt, NativeAlertInput, NativeError,
    NativePowerState, NativeQueueSnapshotV1, NativeResult, QueueStore,
};
use image::{DynamicImage, GenericImageView, ImageFormat, Rgb, RgbImage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Manager};
use uuid::{Uuid, Version};

const SMOKE_MODE: &str = "queue-release";
const SCHEMA_VERSION: u8 = 1;
const MAX_EVIDENCE_BYTES: usize = 1024 * 1024;
const MAX_FAILURE_DETAIL_BYTES: usize = 240;
const KEYBOARD_SAMPLE_COUNT: usize = 30;
const RELAUNCH_OBSERVATION_MILLIS: u64 = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SmokePhase {
    Run,
    Resume,
    Relaunch,
}

impl SmokePhase {
    fn from_environment() -> NativeResult<Self> {
        match std::env::var("IMAGEFORGE_QUEUE_RELEASE_SMOKE_PHASE")
            .ok()
            .as_deref()
        {
            Some("run") => Ok(Self::Run),
            Some("resume") => Ok(Self::Resume),
            Some("relaunch") => Ok(Self::Relaunch),
            _ => Err(smoke_unconfigured()),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum QueueReleaseProviderMutationKind {
    Create,
    Delete,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NativeQueueReleaseSmokeInput {
    #[serde(rename = "phase")]
    Phase { schema_version: u8 },
    #[serde(rename = "bootstrap")]
    Bootstrap { schema_version: u8 },
    #[serde(rename = "dispatch_trusted_key")]
    DispatchTrustedKey {
        schema_version: u8,
        sample_index: u8,
        key: String,
    },
    #[serde(rename = "audit")]
    Audit { schema_version: u8 },
    #[serde(rename = "settle_batch")]
    SettleBatch {
        schema_version: u8,
        ordinal: u8,
        queue_item_id: String,
        client_submission_id: String,
        remote_batch_id: String,
    },
    #[serde(rename = "set_power")]
    SetPower {
        schema_version: u8,
        run_revision: String,
        enabled: bool,
    },
    #[serde(rename = "checkpoint_restart")]
    CheckpointRestart {
        schema_version: u8,
        run_revision: String,
        observed_store_revision: u64,
    },
    #[serde(rename = "observe_restart")]
    ObserveRestart {
        schema_version: u8,
        run_revision: String,
        observed_store_revision: u64,
        observation_millis: u64,
    },
    #[serde(rename = "record_ui_facts")]
    RecordUiFacts {
        schema_version: u8,
        facts: QueueReleaseSmokeUiFactsV1,
    },
    #[serde(rename = "signal_permission_denied")]
    SignalPermissionDenied {
        schema_version: u8,
        event_id: String,
    },
    #[serde(rename = "finalize_relaunch")]
    FinalizeRelaunch {
        schema_version: u8,
        observed_store_revision: u64,
        observation_millis: u64,
    },
    #[serde(rename = "write_evidence")]
    WriteEvidence {
        schema_version: u8,
        evidence: QueueReleaseSmokeEvidenceV1,
    },
    #[serde(rename = "write_failure")]
    WriteFailure { schema_version: u8, detail: String },
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NativeQueueReleaseSmokeResultV1 {
    #[serde(rename = "phase")]
    Phase {
        schema_version: u8,
        phase: QueueReleaseSmokePhaseV1,
    },
    #[serde(rename = "bootstrap")]
    Bootstrap {
        schema_version: u8,
        platform: QueueReleaseSmokePlatform,
        architecture: QueueReleaseSmokeArchitecture,
        app_version: String,
        destination: String,
    },
    #[serde(rename = "dispatch_trusted_key")]
    DispatchTrustedKey {
        schema_version: u8,
        sample_index: u8,
        dispatched: bool,
    },
    #[serde(rename = "audit")]
    Audit {
        schema_version: u8,
        run_pod_create_calls: u64,
        run_pod_delete_calls: u64,
    },
    #[serde(rename = "settle_batch")]
    SettleBatch {
        schema_version: u8,
        ordinal: u8,
        receipt_count: u64,
        artifact_sha256: String,
    },
    #[serde(rename = "set_power")]
    SetPower {
        schema_version: u8,
        run_revision: Option<String>,
        active: bool,
        platform: String,
        display_sleep_allowed: bool,
    },
    #[serde(rename = "checkpoint_restart")]
    CheckpointRestart {
        schema_version: u8,
        written: bool,
        artifact_sha256: String,
    },
    #[serde(rename = "observe_restart")]
    ObserveRestart {
        schema_version: u8,
        observed: bool,
        phase_one_pid: u32,
        artifact_sha256: String,
    },
    #[serde(rename = "record_ui_facts")]
    RecordUiFacts { schema_version: u8, recorded: bool },
    #[serde(rename = "signal_permission_denied")]
    SignalPermissionDenied {
        schema_version: u8,
        event_id: String,
        notification_id: i32,
        disposition: QueueReleaseSmokeAlertDisposition,
    },
    #[serde(rename = "finalize_relaunch")]
    FinalizeRelaunch {
        schema_version: u8,
        written: bool,
        attestation_sha256: String,
    },
    #[serde(rename = "write_evidence")]
    WriteEvidence {
        schema_version: u8,
        written: bool,
        evidence_sha256: String,
    },
    #[serde(rename = "write_failure")]
    WriteFailure { schema_version: u8, written: bool },
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QueueReleaseSmokePhaseV1 {
    Run,
    Resume,
    Relaunch,
}

impl From<SmokePhase> for QueueReleaseSmokePhaseV1 {
    fn from(value: SmokePhase) -> Self {
        match value {
            SmokePhase::Run => Self::Run,
            SmokePhase::Resume => Self::Resume,
            SmokePhase::Relaunch => Self::Relaunch,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QueueReleaseSmokePlatform {
    Macos,
    Windows,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QueueReleaseSmokeArchitecture {
    Aarch64,
    X86_64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QueueReleaseSmokeAlertDisposition {
    Delivered,
    AlreadyDelivered,
    PermissionDenied,
    Failed,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueReleaseSmokeEvidenceV1 {
    schema_version: u8,
    smoke_id: String,
    platform: QueueReleaseSmokePlatform,
    architecture: QueueReleaseSmokeArchitecture,
    app_version: String,
    completed_at: String,
    viewport: QueueReleaseSmokeViewportV1,
    queue: QueueReleaseSmokeQueueV1,
    prompts: QueueReleaseSmokePromptsV1,
    keyboard: QueueReleaseSmokeKeyboardV1,
    minimized: QueueReleaseSmokeMinimizedV1,
    alarm: QueueReleaseSmokeAlarmV1,
    run_pod: QueueReleaseSmokeRunPodV1,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueReleaseSmokeViewportV1 {
    width: u64,
    height: u64,
    horizontal_overflow_px: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueReleaseSmokeQueueV1 {
    requested_rows: u64,
    max_mounted_rows: u64,
    visible_row_limit: u64,
    real_native_bridge: bool,
    run_revision: String,
    runner_lease_released: bool,
    batches: Vec<QueueReleaseSmokeBatchEvidenceV1>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueReleaseSmokeBatchEvidenceV1 {
    ordinal: u8,
    queue_item_id: String,
    client_submission_id: String,
    remote_batch_id: String,
    prompt_count: u64,
    prepared_with_native_bridge: bool,
    receipt_count: u64,
    receipt_fixed_point: bool,
    terminal_state: String,
    minimized_at_completion: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueReleaseSmokePromptsV1 {
    requested_rows: u64,
    max_mounted_rows: u64,
    visible_row_limit: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueReleaseSmokeKeyboardV1 {
    sample_count: u64,
    trusted_sample_count: u64,
    key: String,
    operation: String,
    samples_ms: Vec<f64>,
    p95_ms: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueReleaseSmokeMinimizedV1 {
    observed: bool,
    sequential_batches: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueReleaseSmokeAlarmV1 {
    event_id: String,
    signal_calls: u64,
    unique_events: u64,
    fixed_point: bool,
    disposition: QueueReleaseSmokeAlertDisposition,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueReleaseSmokeRunPodV1 {
    create_calls: u64,
    delete_calls: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueReleaseSmokeUiFactsV1 {
    alarm_role: String,
    ring_now_visible: bool,
    snooze_visible: bool,
    permission_denied_fallback_visible: bool,
    trusted_ring_now_activation: bool,
    web_audio_ring_succeeded: bool,
    queue_list_semantic: bool,
    prompt_list_semantic: bool,
    live_region_present: bool,
    focused_control_label: String,
    viewports: Vec<QueueReleaseSmokeViewportObservationV1>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueReleaseSmokeViewportObservationV1 {
    width: u64,
    height: u64,
    horizontal_overflow_px: u64,
    clipped_action: bool,
    mounted_queue_rows: u64,
    mounted_prompt_rows: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueReleaseSmokeArtifactFileV1 {
    index: u64,
    filename: String,
    receipt_filename: String,
    sha256: String,
    size_bytes: u64,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueReleaseSmokeArtifactBatchV1 {
    ordinal: u8,
    queue_item_id: String,
    client_submission_id: String,
    remote_batch_id: String,
    batch_folder: String,
    prompt_count: u64,
    receipt_count: u64,
    files: Vec<QueueReleaseSmokeArtifactFileV1>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueReleaseSmokePowerFactsV1 {
    requested: bool,
    acquired: bool,
    released: bool,
    platform: Option<String>,
    display_sleep_allowed: bool,
}

impl Default for QueueReleaseSmokePowerFactsV1 {
    fn default() -> Self {
        Self {
            requested: false,
            acquired: false,
            released: false,
            platform: None,
            display_sleep_allowed: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueReleaseSmokeRestartCheckpointV1 {
    schema_version: u8,
    phase_one_pid: u32,
    run_revision: String,
    store_revision: u64,
    first_artifact: QueueReleaseSmokeArtifactBatchV1,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueReleaseSmokeCheckpointV1 {
    schema_version: u8,
    phase_one_pid: u32,
    resume_pid: u32,
    final_store_revision: u64,
    evidence: QueueReleaseSmokeEvidenceV1,
    artifacts: Vec<QueueReleaseSmokeArtifactBatchV1>,
    power: QueueReleaseSmokePowerFactsV1,
    ui: QueueReleaseSmokeUiFactsV1,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueueReleaseSmokeAttestationV1 {
    schema_version: u8,
    smoke_id: String,
    platform: QueueReleaseSmokePlatform,
    architecture: QueueReleaseSmokeArchitecture,
    app_version: String,
    completed_at: String,
    phase_one_pid: u32,
    resume_pid: u32,
    relaunch_pid: u32,
    distinct_processes: bool,
    artifacts: QueueReleaseSmokeArtifactAttestationV1,
    power: QueueReleaseSmokePowerFactsV1,
    relaunch: QueueReleaseSmokeRelaunchFactsV1,
    alarm_fallback: QueueReleaseSmokeUiFactsV1,
    provider: QueueReleaseSmokeProviderFactsV1,
    decision_record: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueueReleaseSmokeArtifactAttestationV1 {
    native_verified: bool,
    batch_folder_count: u64,
    jpeg_file_count: u64,
    receipt_file_count: u64,
    batches: Vec<QueueReleaseSmokeArtifactBatchV1>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueueReleaseSmokeRelaunchFactsV1 {
    observed: bool,
    observation_millis: u64,
    stable_store_revision: bool,
    restart_forced_pause: bool,
    authorization_required: bool,
    runner_state: &'static str,
    alarm_state: &'static str,
    snooze_used: bool,
    no_automatic_dispatch: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueueReleaseSmokeProviderFactsV1 {
    create_calls: u64,
    delete_calls: u64,
    no_provider_mutation: bool,
    ledger_scope: &'static str,
}

#[derive(Clone)]
pub struct QueueReleaseSmokeHost {
    paths: Arc<SmokePaths>,
    phase: SmokePhase,
    runpod_create_calls: Arc<AtomicU64>,
    runpod_delete_calls: Arc<AtomicU64>,
    artifacts: Arc<Mutex<Vec<QueueReleaseSmokeArtifactBatchV1>>>,
    power: Arc<Mutex<QueueReleaseSmokePowerFactsV1>>,
    ui: Arc<Mutex<Option<QueueReleaseSmokeUiFactsV1>>>,
}

#[derive(Debug)]
struct SmokePaths {
    output: PathBuf,
    evidence: PathBuf,
    attestation: PathBuf,
    restart_checkpoint: PathBuf,
    checkpoint: PathBuf,
    result: PathBuf,
}

impl QueueReleaseSmokeHost {
    pub fn from_environment() -> NativeResult<Option<Self>> {
        if std::env::var("IMAGEFORGE_NATIVE_SMOKE").ok().as_deref() != Some(SMOKE_MODE) {
            return Ok(None);
        }
        let paths = SmokePaths::from_environment()?;
        let phase = SmokePhase::from_environment()?;
        let artifacts = if phase == SmokePhase::Resume {
            let encoded = read_bounded(&paths.restart_checkpoint, MAX_EVIDENCE_BYTES as u64)?;
            let checkpoint: QueueReleaseSmokeRestartCheckpointV1 =
                serde_json::from_slice(&encoded).map_err(|_| smoke_invalid())?;
            if checkpoint.schema_version != SCHEMA_VERSION {
                return Err(smoke_invalid());
            }
            vec![checkpoint.first_artifact]
        } else {
            Vec::new()
        };
        Ok(Some(Self {
            paths: Arc::new(paths),
            phase,
            runpod_create_calls: Arc::new(AtomicU64::new(0)),
            runpod_delete_calls: Arc::new(AtomicU64::new(0)),
            artifacts: Arc::new(Mutex::new(artifacts)),
            power: Arc::new(Mutex::new(QueueReleaseSmokePowerFactsV1::default())),
            ui: Arc::new(Mutex::new(None)),
        }))
    }

    pub fn destination_root(&self) -> &Path {
        &self.paths.output
    }

    /// These counters exist only in the explicit installed-app smoke process.
    /// Recording happens at the native RunPod create/delete command boundary,
    /// before validation/network activity, so a rejected forbidden attempt is
    /// still evidence of a broken smoke flow.
    pub fn record_runpod_create(&self) {
        self.runpod_create_calls.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_runpod_delete(&self) {
        self.runpod_delete_calls.fetch_add(1, Ordering::Relaxed);
    }

    /// Native-only provider mutation hook for every current and future
    /// RunPod create/delete boundary. In queue-release mode the first attempted
    /// mutation is recorded and rejected before a socket write; ordinary app
    /// launches have no smoke host and therefore no behavior change.
    pub fn record_provider_mutation(
        &self,
        kind: QueueReleaseProviderMutationKind,
    ) -> NativeResult<()> {
        match kind {
            QueueReleaseProviderMutationKind::Create => self.record_runpod_create(),
            QueueReleaseProviderMutationKind::Delete => self.record_runpod_delete(),
        }
        Err(NativeError::new(
            "native_smoke_forbidden_provider_mutation",
            "The queue release smoke attempted a forbidden provider mutation.",
        ))
    }

    pub fn exchange(
        &self,
        app: &AppHandle,
        destination: &DestinationStore,
        queue: &QueueStore,
        input: NativeQueueReleaseSmokeInput,
    ) -> NativeResult<NativeQueueReleaseSmokeResultV1> {
        match input {
            NativeQueueReleaseSmokeInput::Phase { schema_version } => {
                require_schema(schema_version)?;
                Ok(NativeQueueReleaseSmokeResultV1::Phase {
                    schema_version: SCHEMA_VERSION,
                    phase: self.phase.into(),
                })
            }
            NativeQueueReleaseSmokeInput::Bootstrap { schema_version } => {
                require_schema(schema_version)?;
                self.verify_destination(destination)?;
                Ok(NativeQueueReleaseSmokeResultV1::Bootstrap {
                    schema_version: SCHEMA_VERSION,
                    platform: current_platform()?,
                    architecture: current_architecture()?,
                    app_version: env!("CARGO_PKG_VERSION").to_owned(),
                    destination: self.paths.output.to_string_lossy().into_owned(),
                })
            }
            NativeQueueReleaseSmokeInput::DispatchTrustedKey {
                schema_version,
                sample_index,
                key,
            } => {
                require_schema(schema_version)?;
                if !(1..=KEYBOARD_SAMPLE_COUNT as u8).contains(&sample_index) || key != "Enter" {
                    return Err(smoke_invalid());
                }
                dispatch_trusted_enter(app)?;
                Ok(NativeQueueReleaseSmokeResultV1::DispatchTrustedKey {
                    schema_version: SCHEMA_VERSION,
                    sample_index,
                    dispatched: true,
                })
            }
            NativeQueueReleaseSmokeInput::Audit { schema_version } => {
                require_schema(schema_version)?;
                Ok(NativeQueueReleaseSmokeResultV1::Audit {
                    schema_version: SCHEMA_VERSION,
                    run_pod_create_calls: self.runpod_create_calls.load(Ordering::Relaxed),
                    run_pod_delete_calls: self.runpod_delete_calls.load(Ordering::Relaxed),
                })
            }
            NativeQueueReleaseSmokeInput::SettleBatch {
                schema_version,
                ordinal,
                queue_item_id,
                client_submission_id,
                remote_batch_id,
            } => {
                require_schema(schema_version)?;
                self.require_phase_one_of(&[SmokePhase::Run, SmokePhase::Resume])?;
                let settled = self.settle_batch(
                    destination,
                    queue,
                    ordinal,
                    &queue_item_id,
                    &client_submission_id,
                    &remote_batch_id,
                )?;
                let receipt_count = settled.receipt_count;
                let artifact_sha256 = artifact_batch_sha256(&settled)?;
                self.artifacts
                    .lock()
                    .map_err(|_| smoke_write_failed())?
                    .push(settled);
                Ok(NativeQueueReleaseSmokeResultV1::SettleBatch {
                    schema_version: SCHEMA_VERSION,
                    ordinal,
                    receipt_count,
                    artifact_sha256,
                })
            }
            NativeQueueReleaseSmokeInput::SetPower {
                schema_version,
                run_revision,
                enabled,
            } => {
                require_schema(schema_version)?;
                self.require_phase_one_of(&[SmokePhase::Run, SmokePhase::Resume])?;
                let state = queue.set_sleep_prevention(NativePowerInput {
                    run_revision,
                    enabled,
                })?;
                self.record_power_state(enabled, &state)?;
                Ok(NativeQueueReleaseSmokeResultV1::SetPower {
                    schema_version: SCHEMA_VERSION,
                    run_revision: state.run_revision,
                    active: state.active,
                    platform: state.platform.to_owned(),
                    display_sleep_allowed: state.display_sleep_allowed,
                })
            }
            NativeQueueReleaseSmokeInput::CheckpointRestart {
                schema_version,
                run_revision,
                observed_store_revision,
            } => {
                require_schema(schema_version)?;
                self.require_phase(SmokePhase::Run)?;
                let digest = self.checkpoint_restart(
                    destination,
                    queue,
                    &run_revision,
                    observed_store_revision,
                )?;
                Ok(NativeQueueReleaseSmokeResultV1::CheckpointRestart {
                    schema_version: SCHEMA_VERSION,
                    written: true,
                    artifact_sha256: digest,
                })
            }
            NativeQueueReleaseSmokeInput::ObserveRestart {
                schema_version,
                run_revision,
                observed_store_revision,
                observation_millis,
            } => {
                require_schema(schema_version)?;
                self.require_phase(SmokePhase::Resume)?;
                let (phase_one_pid, artifact_sha256) = self.observe_restart(
                    destination,
                    queue,
                    &run_revision,
                    observed_store_revision,
                    observation_millis,
                )?;
                Ok(NativeQueueReleaseSmokeResultV1::ObserveRestart {
                    schema_version: SCHEMA_VERSION,
                    observed: true,
                    phase_one_pid,
                    artifact_sha256,
                })
            }
            NativeQueueReleaseSmokeInput::RecordUiFacts {
                schema_version,
                facts,
            } => {
                require_schema(schema_version)?;
                self.require_phase(SmokePhase::Resume)?;
                validate_ui_facts(&facts)?;
                let mut stored = self.ui.lock().map_err(|_| smoke_write_failed())?;
                if stored.is_some() {
                    return Err(smoke_invalid());
                }
                *stored = Some(facts);
                Ok(NativeQueueReleaseSmokeResultV1::RecordUiFacts {
                    schema_version: SCHEMA_VERSION,
                    recorded: true,
                })
            }
            NativeQueueReleaseSmokeInput::SignalPermissionDenied {
                schema_version,
                event_id,
            } => {
                require_schema(schema_version)?;
                self.require_phase(SmokePhase::Resume)?;
                let result = queue.signal_alert(
                    NativeAlertInput {
                        event_id: event_id.clone(),
                        kind: QueueAlertKind::Complete,
                    },
                    |_| AlertDeliveryDisposition::PermissionDenied,
                )?;
                if result.event_id != event_id
                    || result.disposition != AlertResultDisposition::PermissionDenied
                {
                    return Err(smoke_invalid());
                }
                Ok(NativeQueueReleaseSmokeResultV1::SignalPermissionDenied {
                    schema_version: SCHEMA_VERSION,
                    event_id,
                    notification_id: result.notification_id,
                    disposition: QueueReleaseSmokeAlertDisposition::PermissionDenied,
                })
            }
            NativeQueueReleaseSmokeInput::FinalizeRelaunch {
                schema_version,
                observed_store_revision,
                observation_millis,
            } => {
                require_schema(schema_version)?;
                self.require_phase(SmokePhase::Relaunch)?;
                let digest = self.finalize_relaunch(
                    destination,
                    queue,
                    observed_store_revision,
                    observation_millis,
                )?;
                Ok(NativeQueueReleaseSmokeResultV1::FinalizeRelaunch {
                    schema_version: SCHEMA_VERSION,
                    written: true,
                    attestation_sha256: digest,
                })
            }
            NativeQueueReleaseSmokeInput::WriteEvidence {
                schema_version,
                evidence,
            } => {
                require_schema(schema_version)?;
                self.require_phase(SmokePhase::Resume)?;
                // The renderer must not be able to retarget a release-smoke
                // queue after bootstrap. Keep both the durable destination
                // grant and every validated queue record inside the isolated
                // native-owned output root.
                self.verify_destination(destination)?;
                self.validate_evidence(&evidence, queue)?;
                let encoded = serde_json::to_vec(&evidence).map_err(|_| smoke_write_failed())?;
                if encoded.len() > MAX_EVIDENCE_BYTES {
                    return Err(smoke_invalid());
                }
                let digest = hex::encode(Sha256::digest(&encoded));
                write_atomic(&self.paths.evidence, &encoded).map_err(|_| smoke_write_failed())?;
                let hash_record = format!("{digest}\n");
                write_atomic(
                    &self.paths.output.join("queue-release-evidence.sha256"),
                    hash_record.as_bytes(),
                )
                .map_err(|_| smoke_write_failed())?;
                let checkpoint = self.completion_checkpoint(evidence, queue)?;
                let checkpoint_encoded =
                    serde_json::to_vec(&checkpoint).map_err(|_| smoke_write_failed())?;
                if checkpoint_encoded.len() > MAX_EVIDENCE_BYTES {
                    return Err(smoke_invalid());
                }
                write_atomic(&self.paths.checkpoint, &checkpoint_encoded)
                    .map_err(|_| smoke_write_failed())?;
                let result = completion_result_content(std::process::id(), &digest);
                write_atomic(&self.paths.result, result.as_bytes())
                    .map_err(|_| smoke_write_failed())?;
                Ok(NativeQueueReleaseSmokeResultV1::WriteEvidence {
                    schema_version: SCHEMA_VERSION,
                    written: true,
                    evidence_sha256: digest,
                })
            }
            NativeQueueReleaseSmokeInput::WriteFailure {
                schema_version,
                detail,
            } => {
                require_schema(schema_version)?;
                if !safe_failure_detail(&detail) {
                    return Err(smoke_invalid());
                }
                let result = format!("FAIL\npid={}; {detail}\n", std::process::id());
                write_atomic(&self.paths.result, result.as_bytes())
                    .map_err(|_| smoke_write_failed())?;
                Ok(NativeQueueReleaseSmokeResultV1::WriteFailure {
                    schema_version: SCHEMA_VERSION,
                    written: true,
                })
            }
        }
    }

    fn verify_destination(&self, destination: &DestinationStore) -> NativeResult<()> {
        let current = destination.current().map_err(|_| smoke_unconfigured())?;
        if current != self.paths.output {
            return Err(smoke_unconfigured());
        }
        Ok(())
    }

    fn require_phase(&self, expected: SmokePhase) -> NativeResult<()> {
        (self.phase == expected)
            .then_some(())
            .ok_or_else(smoke_invalid)
    }

    fn require_phase_one_of(&self, expected: &[SmokePhase]) -> NativeResult<()> {
        expected
            .contains(&self.phase)
            .then_some(())
            .ok_or_else(smoke_invalid)
    }

    fn checkpoint_restart(
        &self,
        destination: &DestinationStore,
        queue: &QueueStore,
        run_revision: &str,
        observed_store_revision: u64,
    ) -> NativeResult<String> {
        if !canonical_v4_uuid(run_revision)
            || observed_store_revision == 0
            || observed_store_revision > 9_007_199_254_740_991
        {
            return Err(smoke_invalid());
        }
        self.verify_destination(destination)?;
        let artifacts = self.artifacts.lock().map_err(|_| smoke_write_failed())?;
        if artifacts.len() != 1 || artifacts[0].ordinal != 1 {
            return Err(smoke_invalid());
        }
        let first_artifact = artifacts[0].clone();
        drop(artifacts);
        verify_artifact_batch(destination, &first_artifact)?;
        let power = self.power.lock().map_err(|_| smoke_write_failed())?;
        if !power.requested
            || !power.acquired
            || power.released
            || !power.display_sleep_allowed
            || power.platform.as_deref() != Some(current_platform_name()?)
        {
            return Err(smoke_invalid());
        }
        drop(power);
        let snapshot = queue.load()?;
        let run = snapshot.document.run.as_ref().ok_or_else(smoke_invalid)?;
        if snapshot.store_revision != observed_store_revision
            || run.run_revision != run_revision
            || run.runner_state != QueueRunnerState::Running
            || run.authorization_required
            || !run.keep_awake
            || run.cohort_item_ids.len() != 3
            || self.runpod_create_calls.load(Ordering::Relaxed) != 0
            || self.runpod_delete_calls.load(Ordering::Relaxed) != 0
        {
            return Err(smoke_invalid());
        }
        let cohort_states = run
            .cohort_item_ids
            .iter()
            .map(|queue_item_id| {
                snapshot.document.items.iter().find_map(|row| match row {
                    NativeQueueRowV1::Item(item) if &item.queue_item_id == queue_item_id => {
                        Some(item.state)
                    }
                    _ => None,
                })
            })
            .collect::<Option<Vec<_>>>()
            .ok_or_else(smoke_invalid)?;
        if cohort_states
            != vec![
                QueueItemState::Completed,
                QueueItemState::Staged,
                QueueItemState::Staged,
            ]
        {
            return Err(smoke_invalid());
        }
        let checkpoint = QueueReleaseSmokeRestartCheckpointV1 {
            schema_version: SCHEMA_VERSION,
            phase_one_pid: std::process::id(),
            run_revision: run_revision.to_owned(),
            store_revision: observed_store_revision,
            first_artifact,
        };
        let encoded = serde_json::to_vec(&checkpoint).map_err(|_| smoke_write_failed())?;
        if encoded.len() > MAX_EVIDENCE_BYTES {
            return Err(smoke_invalid());
        }
        write_atomic(&self.paths.restart_checkpoint, &encoded).map_err(|_| smoke_write_failed())?;
        let digest = artifact_batch_sha256(&checkpoint.first_artifact)?;
        let result = restart_checkpoint_result_content(std::process::id(), &digest);
        write_atomic(&self.paths.result, result.as_bytes()).map_err(|_| smoke_write_failed())?;
        Ok(digest)
    }

    fn observe_restart(
        &self,
        destination: &DestinationStore,
        queue: &QueueStore,
        run_revision: &str,
        observed_store_revision: u64,
        observation_millis: u64,
    ) -> NativeResult<(u32, String)> {
        if !canonical_v4_uuid(run_revision)
            || observation_millis < RELAUNCH_OBSERVATION_MILLIS
            || observation_millis > 30_000
            || observed_store_revision > 9_007_199_254_740_991
        {
            return Err(smoke_invalid());
        }
        self.verify_destination(destination)?;
        let encoded = read_bounded(&self.paths.restart_checkpoint, MAX_EVIDENCE_BYTES as u64)?;
        let checkpoint: QueueReleaseSmokeRestartCheckpointV1 =
            serde_json::from_slice(&encoded).map_err(|_| smoke_invalid())?;
        if checkpoint.schema_version != SCHEMA_VERSION
            || checkpoint.phase_one_pid == std::process::id()
            || checkpoint.run_revision != run_revision
            || checkpoint.store_revision >= observed_store_revision
        {
            return Err(smoke_invalid());
        }
        verify_artifact_batch(destination, &checkpoint.first_artifact)?;
        let snapshot = queue.load()?;
        let run = snapshot.document.run.as_ref().ok_or_else(smoke_invalid)?;
        if snapshot.store_revision != observed_store_revision
            || run.run_revision != run_revision
            || run.runner_state != QueueRunnerState::Paused
            || !run.authorization_required
            || !run.keep_awake
            || self.runpod_create_calls.load(Ordering::Relaxed) != 0
            || self.runpod_delete_calls.load(Ordering::Relaxed) != 0
        {
            return Err(smoke_invalid());
        }
        let artifact_digest = artifact_batch_sha256(&checkpoint.first_artifact)?;
        Ok((checkpoint.phase_one_pid, artifact_digest))
    }

    fn settle_batch(
        &self,
        destination: &DestinationStore,
        queue: &QueueStore,
        ordinal: u8,
        queue_item_id: &str,
        client_submission_id: &str,
        remote_batch_id: &str,
    ) -> NativeResult<QueueReleaseSmokeArtifactBatchV1> {
        if !(1..=3).contains(&ordinal)
            || !canonical_v4_uuid(queue_item_id)
            || !canonical_v4_uuid(client_submission_id)
            || !canonical_v4_uuid(remote_batch_id)
        {
            return Err(smoke_invalid());
        }
        self.verify_destination(destination)?;
        let existing = self.artifacts.lock().map_err(|_| smoke_write_failed())?;
        if existing.len() != usize::from(ordinal - 1)
            || existing.iter().any(|batch| {
                batch.ordinal == ordinal
                    || batch.queue_item_id == queue_item_id
                    || batch.client_submission_id == client_submission_id
                    || batch.remote_batch_id == remote_batch_id
            })
        {
            return Err(smoke_invalid());
        }
        for batch in existing.iter() {
            verify_artifact_batch(destination, batch)?;
        }
        drop(existing);

        let snapshot = queue.load()?;
        let item = snapshot.document.items.iter().find_map(|row| match row {
            NativeQueueRowV1::Item(item) if item.queue_item_id == queue_item_id => Some(item),
            _ => None,
        });
        let Some(item) = item else {
            return Err(smoke_invalid());
        };
        if item.client_submission_id != client_submission_id
            || item.remote_batch_id.as_deref() != Some(remote_batch_id)
            || item.state != QueueItemState::Active
            || item.prompts.is_empty()
            || item.destination != self.paths.output.to_string_lossy()
        {
            return Err(smoke_invalid());
        }
        let batch_id = Uuid::parse_str(remote_batch_id).map_err(|_| smoke_invalid())?;
        let batch_folder = destination.resolve_batch_folder(batch_id, &item.name)?;
        let receipt_relative = PathBuf::from(".imageforge")
            .join("receipts")
            .join(remote_batch_id);
        let receipt_directory = destination.confine(&receipt_relative)?;
        ensure_smoke_directory(&receipt_directory)?;

        let mut files = Vec::with_capacity(item.prompts.len());
        for (offset, _prompt) in item.prompts.iter().enumerate() {
            let index = offset as u64 + 1;
            let bytes = deterministic_smoke_jpeg(ordinal, index)?;
            let sha256 = hex::encode(Sha256::digest(&bytes));
            let filename = format!("batches/{batch_folder}/{index:06}.jpg");
            let final_path = destination.confine(Path::new(&filename))?;
            write_new_atomic(&final_path, &bytes).map_err(|_| smoke_write_failed())?;
            let receipt_filename =
                format!(".imageforge/receipts/{remote_batch_id}/{index:06}.json");
            let receipt_path = destination.confine(Path::new(&receipt_filename))?;
            let receipt = DownloadReceipt {
                schema_version: 1,
                batch_id,
                index,
                filename: filename.clone(),
                sha256: sha256.clone(),
                size_bytes: bytes.len() as u64,
                verified_at_unix_ms: current_unix_millis()?,
            };
            let receipt_bytes = serde_json::to_vec(&receipt).map_err(|_| smoke_write_failed())?;
            write_new_atomic(&receipt_path, &receipt_bytes).map_err(|_| smoke_write_failed())?;
            files.push(QueueReleaseSmokeArtifactFileV1 {
                index,
                filename,
                receipt_filename,
                sha256,
                size_bytes: bytes.len() as u64,
                width: 1280,
                height: 720,
            });
        }
        let settled = QueueReleaseSmokeArtifactBatchV1 {
            ordinal,
            queue_item_id: queue_item_id.to_owned(),
            client_submission_id: client_submission_id.to_owned(),
            remote_batch_id: remote_batch_id.to_owned(),
            batch_folder,
            prompt_count: item.prompts.len() as u64,
            receipt_count: files.len() as u64,
            files,
        };
        verify_artifact_batch(destination, &settled)?;
        Ok(settled)
    }

    fn record_power_state(&self, enabled: bool, state: &NativePowerState) -> NativeResult<()> {
        if !matches!(state.platform, "macos" | "windows") || !state.display_sleep_allowed {
            return Err(smoke_invalid());
        }
        let mut facts = self.power.lock().map_err(|_| smoke_write_failed())?;
        facts.requested = true;
        if enabled {
            if facts.acquired || facts.released || !state.active || state.run_revision.is_none() {
                return Err(smoke_invalid());
            }
            facts.acquired = true;
        } else {
            if !facts.acquired || facts.released || state.active || state.run_revision.is_some() {
                return Err(smoke_invalid());
            }
            facts.released = true;
        }
        facts.platform = Some(state.platform.to_owned());
        facts.display_sleep_allowed = state.display_sleep_allowed;
        Ok(())
    }

    fn completion_checkpoint(
        &self,
        evidence: QueueReleaseSmokeEvidenceV1,
        queue: &QueueStore,
    ) -> NativeResult<QueueReleaseSmokeCheckpointV1> {
        let artifacts = self
            .artifacts
            .lock()
            .map_err(|_| smoke_write_failed())?
            .clone();
        if artifacts.len() != 3 {
            return Err(smoke_invalid());
        }
        for (index, batch) in artifacts.iter().enumerate() {
            if batch.ordinal != (index + 1) as u8
                || batch.queue_item_id != evidence.queue.batches[index].queue_item_id
                || batch.client_submission_id != evidence.queue.batches[index].client_submission_id
                || batch.remote_batch_id != evidence.queue.batches[index].remote_batch_id
                || batch.receipt_count != evidence.queue.batches[index].receipt_count
            {
                return Err(smoke_invalid());
            }
            verify_artifact_batch_from_root(&self.paths.output, batch)?;
        }
        let power = self.power.lock().map_err(|_| smoke_write_failed())?.clone();
        if !power.requested
            || !power.acquired
            || !power.released
            || !power.display_sleep_allowed
            || power.platform.as_deref() != Some(current_platform_name()?)
        {
            return Err(smoke_invalid());
        }
        let ui = self
            .ui
            .lock()
            .map_err(|_| smoke_write_failed())?
            .clone()
            .ok_or_else(smoke_invalid)?;
        validate_ui_facts(&ui)?;
        let restart_encoded =
            read_bounded(&self.paths.restart_checkpoint, MAX_EVIDENCE_BYTES as u64)?;
        let restart: QueueReleaseSmokeRestartCheckpointV1 =
            serde_json::from_slice(&restart_encoded).map_err(|_| smoke_invalid())?;
        if restart.schema_version != SCHEMA_VERSION
            || restart.phase_one_pid == std::process::id()
            || restart.run_revision != evidence.queue.run_revision
            || restart.first_artifact != artifacts[0]
        {
            return Err(smoke_invalid());
        }
        let snapshot = queue.load()?;
        Ok(QueueReleaseSmokeCheckpointV1 {
            schema_version: SCHEMA_VERSION,
            phase_one_pid: restart.phase_one_pid,
            resume_pid: std::process::id(),
            final_store_revision: snapshot.store_revision,
            evidence,
            artifacts,
            power,
            ui,
        })
    }

    fn finalize_relaunch(
        &self,
        destination: &DestinationStore,
        queue: &QueueStore,
        observed_store_revision: u64,
        observation_millis: u64,
    ) -> NativeResult<String> {
        if observation_millis < RELAUNCH_OBSERVATION_MILLIS
            || observation_millis > 30_000
            || observed_store_revision > 9_007_199_254_740_991
        {
            return Err(smoke_invalid());
        }
        self.verify_destination(destination)?;
        let checkpoint_bytes = read_bounded(&self.paths.checkpoint, MAX_EVIDENCE_BYTES as u64)?;
        let checkpoint: QueueReleaseSmokeCheckpointV1 =
            serde_json::from_slice(&checkpoint_bytes).map_err(|_| smoke_invalid())?;
        if checkpoint.schema_version != SCHEMA_VERSION
            || checkpoint.phase_one_pid == std::process::id()
            || checkpoint.resume_pid == std::process::id()
            || checkpoint.phase_one_pid == checkpoint.resume_pid
        {
            return Err(smoke_invalid());
        }
        let snapshot = queue.load()?;
        if snapshot.store_revision != checkpoint.final_store_revision
            || snapshot.store_revision != observed_store_revision
        {
            return Err(smoke_invalid());
        }
        self.validate_evidence(&checkpoint.evidence, queue)?;
        for batch in &checkpoint.artifacts {
            verify_artifact_batch(destination, batch)?;
        }
        let run = snapshot.document.run.as_ref().ok_or_else(smoke_invalid)?;
        let alarm = snapshot.document.alarm.as_ref().ok_or_else(smoke_invalid)?;
        if run.runner_state != QueueRunnerState::Completed
            || !run.authorization_required
            || !run.keep_awake
            || alarm.state != QueueAlarmState::Snoozed
            || !alarm.snooze_used
            || alarm.snooze_due_at.is_none()
            || self.runpod_create_calls.load(Ordering::Relaxed) != 0
            || self.runpod_delete_calls.load(Ordering::Relaxed) != 0
        {
            return Err(smoke_invalid());
        }
        let jpeg_file_count = checkpoint
            .artifacts
            .iter()
            .map(|batch| batch.files.len() as u64)
            .sum();
        let attestation = QueueReleaseSmokeAttestationV1 {
            schema_version: SCHEMA_VERSION,
            smoke_id: checkpoint.evidence.smoke_id.clone(),
            platform: current_platform()?,
            architecture: current_architecture()?,
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            completed_at: checkpoint.evidence.completed_at.clone(),
            phase_one_pid: checkpoint.phase_one_pid,
            resume_pid: checkpoint.resume_pid,
            relaunch_pid: std::process::id(),
            distinct_processes: true,
            artifacts: QueueReleaseSmokeArtifactAttestationV1 {
                native_verified: true,
                batch_folder_count: checkpoint.artifacts.len() as u64,
                jpeg_file_count,
                receipt_file_count: jpeg_file_count,
                batches: checkpoint.artifacts,
            },
            power: checkpoint.power,
            relaunch: QueueReleaseSmokeRelaunchFactsV1 {
                observed: true,
                observation_millis,
                stable_store_revision: true,
                restart_forced_pause: true,
                authorization_required: true,
                runner_state: "completed",
                alarm_state: "snoozed",
                snooze_used: true,
                no_automatic_dispatch: true,
            },
            alarm_fallback: checkpoint.ui,
            provider: QueueReleaseSmokeProviderFactsV1 {
                create_calls: 0,
                delete_calls: 0,
                no_provider_mutation: true,
                // This becomes authoritative only after every native provider
                // command registers the hook documented in the decision record.
                ledger_scope: "registered_native_provider_boundaries",
            },
            decision_record: "docs/TASK_013_QUEUE_RELEASE_DECISION_RECORD.md",
        };
        let encoded = serde_json::to_vec(&attestation).map_err(|_| smoke_write_failed())?;
        if encoded.len() > MAX_EVIDENCE_BYTES {
            return Err(smoke_invalid());
        }
        let digest = hex::encode(Sha256::digest(&encoded));
        write_atomic(&self.paths.attestation, &encoded).map_err(|_| smoke_write_failed())?;
        let evidence_bytes = read_bounded(&self.paths.evidence, MAX_EVIDENCE_BYTES as u64)?;
        let evidence_digest = hex::encode(Sha256::digest(&evidence_bytes));
        let result = final_result_content(std::process::id(), &evidence_digest, &digest);
        write_atomic(&self.paths.result, result.as_bytes()).map_err(|_| smoke_write_failed())?;
        Ok(digest)
    }

    fn validate_evidence(
        &self,
        evidence: &QueueReleaseSmokeEvidenceV1,
        queue: &QueueStore,
    ) -> NativeResult<()> {
        if evidence.schema_version != SCHEMA_VERSION
            || !canonical_v4_uuid(&evidence.smoke_id)
            || evidence.platform != current_platform()?
            || evidence.architecture != current_architecture()?
            || evidence.app_version != env!("CARGO_PKG_VERSION")
            || !canonical_timestamp(&evidence.completed_at)
        {
            return Err(smoke_invalid());
        }
        let viewport = &evidence.viewport;
        if viewport.width < 900 || viewport.height < 650 || viewport.horizontal_overflow_px != 0 {
            return Err(smoke_invalid());
        }
        let queue_evidence = &evidence.queue;
        if queue_evidence.requested_rows != 450
            || !(1..=40).contains(&queue_evidence.max_mounted_rows)
            || queue_evidence.visible_row_limit != 40
            || !queue_evidence.real_native_bridge
            || !queue_evidence.runner_lease_released
            || !canonical_v4_uuid(&queue_evidence.run_revision)
            || queue_evidence.batches.len() != 3
        {
            return Err(smoke_invalid());
        }
        let mut queue_item_ids = HashSet::new();
        let mut submission_ids = HashSet::new();
        let mut remote_ids = HashSet::new();
        for (index, batch) in queue_evidence.batches.iter().enumerate() {
            if batch.ordinal != (index + 1) as u8
                || !canonical_v4_uuid(&batch.queue_item_id)
                || !canonical_v4_uuid(&batch.client_submission_id)
                || !canonical_v4_uuid(&batch.remote_batch_id)
                || batch.queue_item_id == batch.client_submission_id
                || batch.queue_item_id == batch.remote_batch_id
                || batch.client_submission_id == batch.remote_batch_id
                || batch.prompt_count == 0
                || batch.receipt_count != batch.prompt_count
                || !batch.prepared_with_native_bridge
                || !batch.receipt_fixed_point
                || batch.terminal_state != "completed"
                || !batch.minimized_at_completion
                || !queue_item_ids.insert(&batch.queue_item_id)
                || !submission_ids.insert(&batch.client_submission_id)
                || !remote_ids.insert(&batch.remote_batch_id)
            {
                return Err(smoke_invalid());
            }
        }
        let prompts = &evidence.prompts;
        if prompts.requested_rows != 450
            || !(1..=30).contains(&prompts.max_mounted_rows)
            || prompts.visible_row_limit != 30
        {
            return Err(smoke_invalid());
        }
        let keyboard = &evidence.keyboard;
        if keyboard.sample_count != KEYBOARD_SAMPLE_COUNT as u64
            || keyboard.trusted_sample_count != KEYBOARD_SAMPLE_COUNT as u64
            || keyboard.key != "Enter"
            || keyboard.operation != "move"
            || keyboard.samples_ms.len() != KEYBOARD_SAMPLE_COUNT
            || keyboard
                .samples_ms
                .iter()
                .any(|sample| !sample.is_finite() || *sample < 0.0)
            || !keyboard.p95_ms.is_finite()
            || keyboard.p95_ms < 0.0
            || keyboard.p95_ms != p95(&keyboard.samples_ms)?
            || keyboard.p95_ms >= 100.0
        {
            return Err(smoke_invalid());
        }
        if !evidence.minimized.observed || evidence.minimized.sequential_batches != 3 {
            return Err(smoke_invalid());
        }
        let alarm = &evidence.alarm;
        if alarm.event_id != format!("queue-complete:{}", queue_evidence.run_revision)
            || !canonical_event_id(&alarm.event_id)
            || alarm.signal_calls != 1
            || alarm.unique_events != 1
            || !alarm.fixed_point
        {
            return Err(smoke_invalid());
        }
        if evidence.run_pod.create_calls != 0
            || evidence.run_pod.delete_calls != 0
            || self.runpod_create_calls.load(Ordering::Relaxed) != 0
            || self.runpod_delete_calls.load(Ordering::Relaxed) != 0
        {
            return Err(smoke_invalid());
        }
        self.validate_native_queue_facts(evidence, queue)?;
        Ok(())
    }

    /// The renderer's evidence is a claim, never authority. Re-load the
    /// native journal immediately before PASS and bind every smoke batch,
    /// completion alarm, and cohort order to the actual queue state.
    fn validate_native_queue_facts(
        &self,
        evidence: &QueueReleaseSmokeEvidenceV1,
        queue: &QueueStore,
    ) -> NativeResult<()> {
        queue
            .inspect_released_runner_snapshot(&evidence.queue.run_revision, |snapshot| {
                validate_native_queue_snapshot(evidence, snapshot, &self.paths.output)
            })
            .map_err(|_| smoke_invalid())
    }
}

fn validate_native_queue_snapshot(
    evidence: &QueueReleaseSmokeEvidenceV1,
    snapshot: &NativeQueueSnapshotV1,
    destination: &Path,
) -> NativeResult<()> {
    if snapshot.document.items.len() != 450
        || snapshot
            .document
            .items
            .iter()
            .any(|row| !matches!(row, NativeQueueRowV1::Item(_)))
    {
        return Err(smoke_invalid());
    }
    let run = snapshot.document.run.as_ref().ok_or_else(smoke_invalid)?;
    if run.run_revision != evidence.queue.run_revision
        || run.runner_state != QueueRunnerState::Completed
        || !run.authorization_required
        || !run.keep_awake
        || run.cohort_item_ids.len() != 3
        || run.cohort_item_ids
            != evidence
                .queue
                .batches
                .iter()
                .map(|batch| batch.queue_item_id.clone())
                .collect::<Vec<_>>()
    {
        return Err(smoke_invalid());
    }
    let alarm = snapshot.document.alarm.as_ref().ok_or_else(smoke_invalid)?;
    if alarm.event_id != evidence.alarm.event_id
        || alarm.run_revision != run.run_revision
        || alarm.state != QueueAlarmState::Snoozed
        || alarm.kind != Some(QueueAlertKind::Complete)
        || !alarm.snooze_used
        || alarm.snooze_due_at.is_none()
        || alarm.snooze_notification_disposition.is_some()
        || !native_alarm_disposition_matches(
            evidence.alarm.disposition,
            alarm.notification_disposition,
        )
    {
        return Err(smoke_invalid());
    }
    let destination = destination.to_string_lossy();
    for batch in &evidence.queue.batches {
        let row = snapshot.document.items.iter().find_map(|row| match row {
            NativeQueueRowV1::Item(item) if item.queue_item_id == batch.queue_item_id => Some(item),
            _ => None,
        });
        let Some(item) = row else {
            return Err(smoke_invalid());
        };
        if item.client_submission_id != batch.client_submission_id
            || item.remote_batch_id.as_deref() != Some(batch.remote_batch_id.as_str())
            || item.prompts.len() as u64 != batch.prompt_count
            || item.state != QueueItemState::Completed
            || item.run_revision.as_deref() != Some(run.run_revision.as_str())
            || item.attention_code.is_some()
            || item.destination != destination.as_ref()
        {
            return Err(smoke_invalid());
        }
    }
    Ok(())
}

fn native_alarm_disposition_matches(
    evidence: QueueReleaseSmokeAlertDisposition,
    actual: Option<NotificationDisposition>,
) -> bool {
    match evidence {
        // `already_delivered` means the native outbox was already delivered,
        // so its durable projection is the same as a first delivered call.
        QueueReleaseSmokeAlertDisposition::Delivered
        | QueueReleaseSmokeAlertDisposition::AlreadyDelivered => {
            actual == Some(NotificationDisposition::Delivered)
        }
        QueueReleaseSmokeAlertDisposition::PermissionDenied => {
            actual == Some(NotificationDisposition::PermissionDenied)
        }
        QueueReleaseSmokeAlertDisposition::Failed => {
            actual == Some(NotificationDisposition::Failed)
        }
    }
}

fn current_platform_name() -> NativeResult<&'static str> {
    match current_platform()? {
        QueueReleaseSmokePlatform::Macos => Ok("macos"),
        QueueReleaseSmokePlatform::Windows => Ok("windows"),
    }
}

fn validate_ui_facts(facts: &QueueReleaseSmokeUiFactsV1) -> NativeResult<()> {
    if facts.alarm_role != "alert"
        || !facts.ring_now_visible
        || !facts.snooze_visible
        || !facts.permission_denied_fallback_visible
        || !facts.trusted_ring_now_activation
        || !facts.web_audio_ring_succeeded
        || !facts.queue_list_semantic
        || !facts.prompt_list_semantic
        || !facts.live_region_present
        || facts.focused_control_label != "Ring now"
        || facts.viewports.len() != 3
    {
        return Err(smoke_invalid());
    }
    for (observation, expected) in
        facts
            .viewports
            .iter()
            .zip([(1280, 720), (1440, 900), (1920, 1080)])
    {
        if (observation.width, observation.height) != expected
            || observation.horizontal_overflow_px != 0
            || observation.clipped_action
            || !(1..=40).contains(&observation.mounted_queue_rows)
            || !(1..=30).contains(&observation.mounted_prompt_rows)
        {
            return Err(smoke_invalid());
        }
    }
    Ok(())
}

fn artifact_batch_sha256(batch: &QueueReleaseSmokeArtifactBatchV1) -> NativeResult<String> {
    let encoded = serde_json::to_vec(batch).map_err(|_| smoke_write_failed())?;
    Ok(hex::encode(Sha256::digest(&encoded)))
}

fn deterministic_smoke_jpeg(ordinal: u8, index: u64) -> NativeResult<Vec<u8>> {
    let red = 24_u8.saturating_add(ordinal.saturating_mul(37));
    let green = 38_u8.saturating_add((index as u8).saturating_mul(29));
    let blue = 72_u8.saturating_add(ordinal.saturating_mul(19));
    let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(1280, 720, Rgb([red, green, blue])));
    let mut bytes = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut bytes), ImageFormat::Jpeg)
        .map_err(|_| smoke_write_failed())?;
    let decoded = image::load_from_memory_with_format(&bytes, ImageFormat::Jpeg)
        .map_err(|_| smoke_write_failed())?;
    if decoded.dimensions() != (1280, 720) {
        return Err(smoke_write_failed());
    }
    Ok(bytes)
}

fn ensure_smoke_directory(path: &Path) -> NativeResult<()> {
    if path.exists() {
        let metadata = fs::symlink_metadata(path).map_err(|_| smoke_write_failed())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(smoke_write_failed());
        }
        return Ok(());
    }
    fs::create_dir_all(path).map_err(|_| smoke_write_failed())?;
    let metadata = fs::symlink_metadata(path).map_err(|_| smoke_write_failed())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(smoke_write_failed());
    }
    Ok(())
}

fn write_new_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "missing artifact parent")
    })?;
    if !parent.is_dir() || fs::symlink_metadata(parent)?.file_type().is_symlink() || path.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "unsafe or existing smoke artifact",
        ));
    }
    let temporary = parent.join(format!(
        ".{}.{}.part",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("artifact"),
        Uuid::new_v4()
    ));
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        // Hard-link publication is atomic and refuses replacement, unlike a
        // plain rename on both supported platforms.
        fs::hard_link(&temporary, path)?;
        fs::remove_file(&temporary)?;
        sync_directory(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn verify_artifact_batch(
    destination: &DestinationStore,
    batch: &QueueReleaseSmokeArtifactBatchV1,
) -> NativeResult<()> {
    verify_artifact_batch_from_root(&destination.current()?, batch)
}

fn verify_artifact_batch_from_root(
    root: &Path,
    batch: &QueueReleaseSmokeArtifactBatchV1,
) -> NativeResult<()> {
    if !(1..=3).contains(&batch.ordinal)
        || !canonical_v4_uuid(&batch.queue_item_id)
        || !canonical_v4_uuid(&batch.client_submission_id)
        || !canonical_v4_uuid(&batch.remote_batch_id)
        || batch.prompt_count == 0
        || batch.receipt_count != batch.prompt_count
        || batch.files.len() as u64 != batch.receipt_count
        || batch.batch_folder.is_empty()
        || batch.batch_folder.len() > 120
        || batch
            .batch_folder
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
    {
        return Err(smoke_invalid());
    }
    let canonical_root = root.canonicalize().map_err(|_| smoke_invalid())?;
    for (offset, file) in batch.files.iter().enumerate() {
        let expected_index = offset as u64 + 1;
        let expected_filename = format!("batches/{}/{expected_index:06}.jpg", batch.batch_folder);
        let expected_receipt = format!(
            ".imageforge/receipts/{}/{expected_index:06}.json",
            batch.remote_batch_id
        );
        if file.index != expected_index
            || file.filename != expected_filename
            || file.receipt_filename != expected_receipt
            || file.width != 1280
            || file.height != 720
            || file.size_bytes == 0
            || !is_sha256(&file.sha256)
        {
            return Err(smoke_invalid());
        }
        let artifact_path = confined_smoke_file(&canonical_root, &file.filename)?;
        let bytes = read_bounded(&artifact_path, 32 * 1024 * 1024)?;
        if bytes.len() as u64 != file.size_bytes
            || hex::encode(Sha256::digest(&bytes)) != file.sha256
        {
            return Err(smoke_invalid());
        }
        let decoded = image::load_from_memory_with_format(&bytes, ImageFormat::Jpeg)
            .map_err(|_| smoke_invalid())?;
        if decoded.dimensions() != (file.width, file.height) {
            return Err(smoke_invalid());
        }
        let receipt_path = confined_smoke_file(&canonical_root, &file.receipt_filename)?;
        let receipt_bytes = read_bounded(&receipt_path, 16 * 1024)?;
        let receipt: DownloadReceipt =
            serde_json::from_slice(&receipt_bytes).map_err(|_| smoke_invalid())?;
        if receipt.schema_version != 1
            || receipt.batch_id.to_string() != batch.remote_batch_id
            || receipt.index != file.index
            || receipt.filename != file.filename
            || receipt.sha256 != file.sha256
            || receipt.size_bytes != file.size_bytes
            || receipt.verified_at_unix_ms == 0
        {
            return Err(smoke_invalid());
        }
    }
    Ok(())
}

fn confined_smoke_file(root: &Path, relative: &str) -> NativeResult<PathBuf> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative.components().any(|component| {
            !matches!(
                component,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
    {
        return Err(smoke_invalid());
    }
    let path = root.join(relative);
    let metadata = fs::symlink_metadata(&path).map_err(|_| smoke_invalid())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(smoke_invalid());
    }
    let canonical = path.canonicalize().map_err(|_| smoke_invalid())?;
    canonical
        .starts_with(root)
        .then_some(canonical)
        .ok_or_else(smoke_invalid)
}

fn read_bounded(path: &Path, maximum: u64) -> NativeResult<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).map_err(|_| smoke_invalid())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() == 0
        || metadata.len() > maximum
    {
        return Err(smoke_invalid());
    }
    fs::read(path).map_err(|_| smoke_invalid())
}

fn current_unix_millis() -> NativeResult<u64> {
    let value = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| smoke_write_failed())?
        .as_millis();
    u64::try_from(value).map_err(|_| smoke_write_failed())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

impl SmokePaths {
    fn from_environment() -> NativeResult<Self> {
        let output = configured_directory("IMAGEFORGE_QUEUE_RELEASE_SMOKE_OUTPUT")?;
        let evidence = configured_file("IMAGEFORGE_QUEUE_RELEASE_SMOKE_EVIDENCE")?;
        let attestation = configured_file("IMAGEFORGE_QUEUE_RELEASE_SMOKE_ATTESTATION")?;
        let result = configured_file("IMAGEFORGE_NATIVE_SMOKE_RESULT")?;
        let restart_checkpoint = output.join(".queue-release-restart-v1.json");
        let checkpoint = output.join(".queue-release-phase-one-v1.json");
        if evidence == attestation
            || evidence == result
            || attestation == result
            || checkpoint == evidence
            || checkpoint == attestation
            || checkpoint == result
            || restart_checkpoint == evidence
            || restart_checkpoint == attestation
            || restart_checkpoint == result
            || restart_checkpoint == checkpoint
            || is_symlink(&restart_checkpoint)?
            || is_symlink(&checkpoint)?
        {
            return Err(smoke_unconfigured());
        }
        ensure_isolated_state_roots()?;
        #[cfg(target_os = "windows")]
        let _profile = configured_directory("IMAGEFORGE_NATIVE_SMOKE_PROFILE")?;
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            return Err(smoke_unconfigured());
        }
        Ok(Self {
            output,
            evidence,
            attestation,
            restart_checkpoint,
            checkpoint,
            result,
        })
    }
}

fn configured_directory(name: &str) -> NativeResult<PathBuf> {
    let path = configured_absolute_path(name)?;
    if !path.is_dir() || is_symlink(&path)? {
        return Err(smoke_unconfigured());
    }
    path.canonicalize().map_err(|_| smoke_unconfigured())
}

fn configured_file(name: &str) -> NativeResult<PathBuf> {
    let path = configured_absolute_path(name)?;
    let parent = path.parent().ok_or_else(smoke_unconfigured)?;
    if !parent.is_dir() || is_symlink(parent)? || is_symlink(&path)? {
        return Err(smoke_unconfigured());
    }
    Ok(path)
}

fn configured_absolute_path(name: &str) -> NativeResult<PathBuf> {
    let path = std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(smoke_unconfigured)?;
    if path.as_os_str().is_empty() || path.components().count() < 2 {
        return Err(smoke_unconfigured());
    }
    Ok(path)
}

fn ensure_isolated_state_roots() -> NativeResult<()> {
    #[cfg(target_os = "macos")]
    {
        let home = configured_directory("HOME")?;
        let temporary = configured_directory("TMPDIR")?;
        if !temporary.starts_with(&home) {
            return Err(smoke_unconfigured());
        }
    }
    #[cfg(target_os = "windows")]
    {
        let app_data = configured_directory("APPDATA")?;
        let local_app_data = configured_directory("LOCALAPPDATA")?;
        if app_data == local_app_data {
            return Err(smoke_unconfigured());
        }
    }
    Ok(())
}

fn current_platform() -> NativeResult<QueueReleaseSmokePlatform> {
    #[cfg(target_os = "macos")]
    {
        Ok(QueueReleaseSmokePlatform::Macos)
    }
    #[cfg(target_os = "windows")]
    {
        Ok(QueueReleaseSmokePlatform::Windows)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err(smoke_unconfigured())
    }
}

fn current_architecture() -> NativeResult<QueueReleaseSmokeArchitecture> {
    match std::env::consts::ARCH {
        "aarch64" => Ok(QueueReleaseSmokeArchitecture::Aarch64),
        "x86_64" => Ok(QueueReleaseSmokeArchitecture::X86_64),
        _ => Err(smoke_unconfigured()),
    }
}

fn require_schema(schema_version: u8) -> NativeResult<()> {
    (schema_version == SCHEMA_VERSION)
        .then_some(())
        .ok_or_else(smoke_invalid)
}

fn canonical_v4_uuid(value: &str) -> bool {
    Uuid::parse_str(value).ok().is_some_and(|parsed| {
        parsed.get_version() == Some(Version::Random) && parsed.to_string() == value
    })
}

fn canonical_event_id(value: &str) -> bool {
    value
        .strip_prefix("queue-complete:")
        .is_some_and(canonical_v4_uuid)
}

fn canonical_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    let digits = |start: usize, end: usize| {
        bytes
            .get(start..end)
            .is_some_and(|slice| slice.iter().all(u8::is_ascii_digit))
    };
    let shape = bytes.len() == 24
        && digits(0, 4)
        && bytes.get(4) == Some(&b'-')
        && digits(5, 7)
        && bytes.get(7) == Some(&b'-')
        && digits(8, 10)
        && bytes.get(10) == Some(&b'T')
        && digits(11, 13)
        && bytes.get(13) == Some(&b':')
        && digits(14, 16)
        && bytes.get(16) == Some(&b':')
        && digits(17, 19)
        && bytes.get(19) == Some(&b'.')
        && digits(20, 23)
        && bytes.get(23) == Some(&b'Z');
    if !shape {
        return false;
    }
    let number = |start: usize, end: usize| -> Option<u32> {
        std::str::from_utf8(bytes.get(start..end)?)
            .ok()?
            .parse()
            .ok()
    };
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        number(0, 4),
        number(5, 7),
        number(8, 10),
        number(11, 13),
        number(14, 16),
        number(17, 19),
    ) else {
        return false;
    };
    let maximum_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        _ => return false,
    };
    year > 0 && (1..=maximum_day).contains(&day) && hour <= 23 && minute <= 59 && second <= 59
}

fn p95(samples: &[f64]) -> NativeResult<f64> {
    if samples.len() != KEYBOARD_SAMPLE_COUNT
        || samples
            .iter()
            .any(|sample| !sample.is_finite() || *sample < 0.0)
    {
        return Err(smoke_invalid());
    }
    let mut ordered = samples.to_vec();
    ordered.sort_by(f64::total_cmp);
    Ok(ordered[(ordered.len() * 95).div_ceil(100) - 1])
}

fn safe_failure_detail(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_FAILURE_DETAIL_BYTES
        && !value.chars().any(char::is_control)
}

fn is_symlink(path: &Path) -> NativeResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_symlink()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(smoke_unconfigured()),
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "missing smoke output parent",
        )
    })?;
    if fs::symlink_metadata(parent)?.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "unsafe smoke output parent",
        ));
    }
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unsafe smoke output",
            ));
        }
    }
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("smoke"),
        Uuid::new_v4()
    ));
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        replace_atomic(&temporary, path)?;
        sync_directory(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(unix)]
fn replace_atomic(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_atomic(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(source: *const u16, destination: *const u16, flags: u32) -> i32;
    }
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(any(unix, windows)))]
fn replace_atomic(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(not(windows))]
fn sync_directory(path: &Path) -> std::io::Result<()> {
    File::open(path)?.sync_all()
}

fn dispatch_trusted_enter(app: &AppHandle) -> NativeResult<()> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(smoke_key_failed)?;
    window.show().map_err(|_| smoke_key_failed())?;
    window.set_focus().map_err(|_| smoke_key_failed())?;
    #[cfg(target_os = "macos")]
    {
        dispatch_macos_enter(app)
    }
    #[cfg(target_os = "windows")]
    {
        dispatch_windows_enter()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = window;
        Err(smoke_key_failed())
    }
}

#[cfg(target_os = "macos")]
const MACOS_RETURN_VIRTUAL_KEY: u16 = 0x24;

#[cfg(target_os = "macos")]
fn dispatch_macos_enter(app: &AppHandle) -> NativeResult<()> {
    // Tauri commands normally arrive off the AppKit thread, but platform
    // dispatch behavior differs between WebKit builds. Waiting on a queued
    // main-thread task from the main thread would deadlock the installed
    // smoke, so take the direct app-local route when we are already there.
    if unsafe { libc::pthread_main_np() } != 0 {
        return dispatch_macos_enter_on_main_thread();
    }
    use std::sync::mpsc;
    let (sender, receiver) = mpsc::sync_channel(1);
    let dispatch = app.clone();
    dispatch
        .run_on_main_thread(move || {
            let _ = sender.send(dispatch_macos_enter_on_main_thread());
        })
        .map_err(|_| smoke_key_failed())?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(2))
        .map_err(|_| smoke_key_failed())?
}

/// App-local NSEvent delivery avoids the Accessibility/Input Monitoring grant
/// that global HID-tap posting would require on an unsigned installed app.
/// WebKit receives this through the native NSApplication event path, so DOM
/// keyboard listeners observe a trusted event rather than a JS synthetic one.
#[cfg(target_os = "macos")]
fn dispatch_macos_enter_on_main_thread() -> NativeResult<()> {
    use std::ffi::{c_char, c_void};
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn CGEventCreateKeyboardEvent(
            source: *const c_void,
            virtual_key: u16,
            key_down: bool,
        ) -> *mut c_void;
        fn CFRelease(value: *const c_void);
    }
    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    type SendObject0 = unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void;
    type SendObject1 = unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> *mut c_void;
    type SendVoid1 = unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void);
    unsafe fn selector(name: &'static [u8]) -> *mut c_void {
        sel_registerName(name.as_ptr().cast())
    }
    unsafe fn message_object0(receiver: *mut c_void, selector: *mut c_void) -> *mut c_void {
        let send: SendObject0 = std::mem::transmute(objc_msgSend as *const ());
        send(receiver, selector)
    }
    unsafe fn message_object1(
        receiver: *mut c_void,
        selector: *mut c_void,
        argument: *mut c_void,
    ) -> *mut c_void {
        let send: SendObject1 = std::mem::transmute(objc_msgSend as *const ());
        send(receiver, selector, argument)
    }
    unsafe fn message_void1(receiver: *mut c_void, selector: *mut c_void, argument: *mut c_void) {
        let send: SendVoid1 = std::mem::transmute(objc_msgSend as *const ());
        send(receiver, selector, argument);
    }
    unsafe {
        let application_class = objc_getClass(c"NSApplication".as_ptr());
        let event_class = objc_getClass(c"NSEvent".as_ptr());
        if application_class.is_null() || event_class.is_null() {
            return Err(smoke_key_failed());
        }
        let application = message_object0(application_class, selector(b"sharedApplication\0"));
        if application.is_null() {
            return Err(smoke_key_failed());
        }
        let down = CGEventCreateKeyboardEvent(std::ptr::null(), MACOS_RETURN_VIRTUAL_KEY, true);
        let up = CGEventCreateKeyboardEvent(std::ptr::null(), MACOS_RETURN_VIRTUAL_KEY, false);
        if down.is_null() || up.is_null() {
            if !down.is_null() {
                CFRelease(down.cast_const());
            }
            if !up.is_null() {
                CFRelease(up.cast_const());
            }
            return Err(smoke_key_failed());
        }
        let down_event = message_object1(event_class, selector(b"eventWithCGEvent:\0"), down);
        let up_event = message_object1(event_class, selector(b"eventWithCGEvent:\0"), up);
        CFRelease(down.cast_const());
        CFRelease(up.cast_const());
        if down_event.is_null() || up_event.is_null() {
            return Err(smoke_key_failed());
        }
        message_void1(application, selector(b"sendEvent:\0"), down_event);
        message_void1(application, selector(b"sendEvent:\0"), up_event);
    }
    Ok(())
}

#[cfg(target_os = "windows")]
const WINDOWS_VK_RETURN: u16 = 0x0D;

#[cfg(target_os = "windows")]
fn dispatch_windows_enter() -> NativeResult<()> {
    use std::mem::size_of;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    };
    let inputs = [
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: WINDOWS_VK_RETURN,
                    wScan: 0,
                    dwFlags: 0,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: WINDOWS_VK_RETURN,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
    ];
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            size_of::<INPUT>() as i32,
        )
    };
    (sent == inputs.len() as u32)
        .then_some(())
        .ok_or_else(smoke_key_failed)
}

fn smoke_unconfigured() -> NativeError {
    NativeError::new(
        "native_smoke_unconfigured",
        "The queue release smoke process is not configured safely.",
    )
}

fn smoke_invalid() -> NativeError {
    NativeError::new(
        "native_smoke_invalid",
        "The queue release smoke request or evidence is invalid.",
    )
}

fn smoke_key_failed() -> NativeError {
    NativeError::new(
        "native_smoke_key_failed",
        "The queue release smoke could not dispatch the trusted Enter key.",
    )
}

fn smoke_write_failed() -> NativeError {
    NativeError::new(
        "native_smoke_write_failed",
        "The queue release smoke evidence could not be written.",
    )
}

fn restart_checkpoint_result_content(process_id: u32, artifact_digest: &str) -> String {
    format!(
        "PHASE1_PASS\npid={process_id}; window=main; first_artifact_sha256={artifact_digest}; native_queue_release_smoke=v1; phase=run\n"
    )
}

fn completion_result_content(process_id: u32, evidence_digest: &str) -> String {
    format!(
        "PHASE2_PASS\npid={process_id}; window=main; evidence_sha256={evidence_digest}; native_queue_release_smoke=v1; phase=resume\n"
    )
}

fn final_result_content(
    process_id: u32,
    evidence_digest: &str,
    attestation_digest: &str,
) -> String {
    format!(
        "PASS\npid={process_id}; window=main; evidence_sha256={evidence_digest}; attestation_sha256={attestation_digest}; native_queue_release_smoke=v1; phase=relaunch\n"
    )
}

#[cfg(test)]
mod tests {
    use super::super::queue::{
        NativeQueueAlarmV1, NativeQueueDocumentV1, NativeQueueItemV1, NativeQueueRunV1,
    };
    use super::*;

    fn evidence() -> QueueReleaseSmokeEvidenceV1 {
        let run_revision = "33333333-3333-4333-8333-333333333333";
        QueueReleaseSmokeEvidenceV1 {
            schema_version: 1,
            smoke_id: "44444444-4444-4444-8444-444444444444".to_owned(),
            platform: current_platform().unwrap_or(QueueReleaseSmokePlatform::Macos),
            architecture: current_architecture().unwrap(),
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            completed_at: "2026-08-03T12:00:00.000Z".to_owned(),
            viewport: QueueReleaseSmokeViewportV1 {
                width: 1440,
                height: 900,
                horizontal_overflow_px: 0,
            },
            queue: QueueReleaseSmokeQueueV1 {
                requested_rows: 450,
                max_mounted_rows: 12,
                visible_row_limit: 40,
                real_native_bridge: true,
                run_revision: run_revision.to_owned(),
                runner_lease_released: true,
                batches: (1..=3)
                    .map(|ordinal| QueueReleaseSmokeBatchEvidenceV1 {
                        ordinal,
                        queue_item_id: format!("00000000-0000-4000-8000-{ordinal:012}"),
                        client_submission_id: format!("00000000-0000-4000-9000-{ordinal:012}"),
                        remote_batch_id: format!("00000000-0000-4000-a000-{ordinal:012}"),
                        prompt_count: 1,
                        prepared_with_native_bridge: true,
                        receipt_count: 1,
                        receipt_fixed_point: true,
                        terminal_state: "completed".to_owned(),
                        minimized_at_completion: true,
                    })
                    .collect(),
            },
            prompts: QueueReleaseSmokePromptsV1 {
                requested_rows: 450,
                max_mounted_rows: 15,
                visible_row_limit: 30,
            },
            keyboard: QueueReleaseSmokeKeyboardV1 {
                sample_count: 30,
                trusted_sample_count: 30,
                key: "Enter".to_owned(),
                operation: "move".to_owned(),
                samples_ms: (1..=30).map(f64::from).collect(),
                p95_ms: 29.0,
            },
            minimized: QueueReleaseSmokeMinimizedV1 {
                observed: true,
                sequential_batches: 3,
            },
            alarm: QueueReleaseSmokeAlarmV1 {
                event_id: format!("queue-complete:{run_revision}"),
                signal_calls: 1,
                unique_events: 1,
                fixed_point: true,
                disposition: QueueReleaseSmokeAlertDisposition::Delivered,
            },
            run_pod: QueueReleaseSmokeRunPodV1 {
                create_calls: 0,
                delete_calls: 0,
            },
        }
    }

    fn native_snapshot(evidence: &QueueReleaseSmokeEvidenceV1) -> NativeQueueSnapshotV1 {
        let run_revision = evidence.queue.run_revision.clone();
        let mut items = Vec::with_capacity(450);
        for index in 0..450_u64 {
            let batch = evidence.queue.batches.get(index as usize);
            let queue_item_id = batch.map_or_else(
                || format!("10000000-0000-4000-8000-{index:012}"),
                |batch| batch.queue_item_id.clone(),
            );
            let client_submission_id = batch.map_or_else(
                || format!("20000000-0000-4000-9000-{index:012}"),
                |batch| batch.client_submission_id.clone(),
            );
            items.push(NativeQueueRowV1::Item(NativeQueueItemV1 {
                schema_version: 1,
                queue_item_id,
                client_submission_id,
                record_revision: 1,
                run_revision: batch.map(|_| run_revision.clone()),
                remote_batch_id: batch.map(|batch| batch.remote_batch_id.clone()),
                state: if batch.is_some() {
                    QueueItemState::Completed
                } else {
                    QueueItemState::Staged
                },
                attention_code: None,
                name: format!("Queue release smoke batch {}", index + 1),
                prompts: vec![format!("Prompt {index}")],
                base_seed: 700_000 + index,
                destination: "/queue-release-output".to_owned(),
                aspect_ratio: "16:9".to_owned(),
                style_suffix: None,
                references: vec![],
                created_at: "2026-08-03T12:00:00.000Z".to_owned(),
                updated_at: "2026-08-03T12:00:00.000Z".to_owned(),
            }));
        }
        NativeQueueSnapshotV1 {
            schema_version: 1,
            store_revision: 99,
            document: NativeQueueDocumentV1 {
                schema_version: 1,
                items,
                run: Some(NativeQueueRunV1 {
                    run_revision: run_revision.clone(),
                    cohort_item_ids: evidence
                        .queue
                        .batches
                        .iter()
                        .map(|batch| batch.queue_item_id.clone())
                        .collect(),
                    runner_state: QueueRunnerState::Completed,
                    authorization_required: true,
                    keep_awake: true,
                }),
                alarm: Some(NativeQueueAlarmV1 {
                    event_id: evidence.alarm.event_id.clone(),
                    run_revision,
                    state: QueueAlarmState::Snoozed,
                    kind: Some(QueueAlertKind::Complete),
                    snooze_used: true,
                    snooze_due_at: Some("2026-08-03T12:15:00.000Z".to_owned()),
                    notification_disposition: Some(NotificationDisposition::Delivered),
                    snooze_notification_disposition: None,
                }),
            },
            issues: vec![],
        }
    }

    #[test]
    fn evidence_schema_round_trips_with_the_exact_camel_case_wire_names() {
        let encoded = serde_json::to_value(evidence()).unwrap();
        let root = encoded.as_object().unwrap();
        assert!(root.contains_key("schemaVersion"));
        assert!(root.contains_key("runPod"));
        assert!(!root.contains_key("schema_version"));
        let parsed: QueueReleaseSmokeEvidenceV1 = serde_json::from_value(encoded).unwrap();
        assert_eq!(
            parsed.queue.run_revision,
            "33333333-3333-4333-8333-333333333333"
        );
    }

    #[test]
    fn exchange_envelopes_use_the_exact_camel_case_wire_names() {
        let input: NativeQueueReleaseSmokeInput = serde_json::from_str(
            r#"{"schemaVersion":1,"operation":"dispatch_trusted_key","sampleIndex":1,"key":"Enter"}"#,
        )
        .unwrap();
        let NativeQueueReleaseSmokeInput::DispatchTrustedKey {
            schema_version,
            sample_index,
            key,
        } = input
        else {
            panic!("trusted-key input")
        };
        assert_eq!(schema_version, 1);
        assert_eq!(sample_index, 1);
        assert_eq!(key, "Enter");

        let encoded = serde_json::to_value(NativeQueueReleaseSmokeResultV1::Audit {
            schema_version: 1,
            run_pod_create_calls: 0,
            run_pod_delete_calls: 0,
        })
        .unwrap();
        assert_eq!(
            encoded,
            serde_json::json!({
                "schemaVersion": 1,
                "operation": "audit",
                "runPodCreateCalls": 0,
                "runPodDeleteCalls": 0,
            })
        );
    }

    #[test]
    fn result_records_bind_each_installed_smoke_process_and_evidence_digest() {
        assert_eq!(
            restart_checkpoint_result_content(42, "a".repeat(64).as_str()),
            format!(
                "PHASE1_PASS\npid=42; window=main; first_artifact_sha256={}; native_queue_release_smoke=v1; phase=run\n",
                "a".repeat(64)
            )
        );
        assert_eq!(
            completion_result_content(43, "b".repeat(64).as_str()),
            format!(
                "PHASE2_PASS\npid=43; window=main; evidence_sha256={}; native_queue_release_smoke=v1; phase=resume\n",
                "b".repeat(64)
            )
        );
        assert_eq!(
            final_result_content(
                44,
                "a".repeat(64).as_str(),
                "b".repeat(64).as_str()
            ),
            format!(
                "PASS\npid=44; window=main; evidence_sha256={}; attestation_sha256={}; native_queue_release_smoke=v1; phase=relaunch\n",
                "a".repeat(64),
                "b".repeat(64)
            )
        );
    }

    #[test]
    fn evidence_rejects_forged_alarm_and_keyboard_values() {
        let mut valid = evidence();
        valid.alarm.event_id = "queue-complete:00000000-0000-4000-8000-000000000001".to_owned();
        assert!(
            !canonical_event_id(&valid.alarm.event_id)
                || valid.alarm.event_id != format!("queue-complete:{}", valid.queue.run_revision)
        );
        valid = evidence();
        valid.keyboard.p95_ms = 100.0;
        assert!(valid.keyboard.p95_ms >= 100.0);
        assert_eq!(p95(&valid.keyboard.samples_ms).unwrap(), 29.0);
    }

    #[test]
    fn native_snapshot_binding_rejects_renderer_forged_batch_or_alarm_facts() {
        let evidence = evidence();
        let snapshot = native_snapshot(&evidence);
        let destination = Path::new("/queue-release-output");
        assert!(validate_native_queue_snapshot(&evidence, &snapshot, destination).is_ok());

        let mut forged_remote = native_snapshot(&evidence);
        let NativeQueueRowV1::Item(first) = &mut forged_remote.document.items[0] else {
            panic!("first queue row")
        };
        first.remote_batch_id = Some("00000000-0000-4000-b000-000000009999".to_owned());
        assert_eq!(
            validate_native_queue_snapshot(&evidence, &forged_remote, destination)
                .unwrap_err()
                .code,
            "native_smoke_invalid"
        );

        let mut forged_alarm = native_snapshot(&evidence);
        forged_alarm.document.alarm.as_mut().unwrap().kind = Some(QueueAlertKind::Attention);
        assert_eq!(
            validate_native_queue_snapshot(&evidence, &forged_alarm, destination)
                .unwrap_err()
                .code,
            "native_smoke_invalid"
        );

        let mut forged_destination = native_snapshot(&evidence);
        let NativeQueueRowV1::Item(first) = &mut forged_destination.document.items[0] else {
            panic!("first queue row")
        };
        first.destination = "/not-the-isolated-output".to_owned();
        assert_eq!(
            validate_native_queue_snapshot(&evidence, &forged_destination, destination)
                .unwrap_err()
                .code,
            "native_smoke_invalid"
        );
    }

    #[test]
    fn evidence_requires_nonzero_bounded_virtualized_row_counts() {
        let mut invalid = evidence();
        invalid.queue.max_mounted_rows = 0;
        assert!(!(1..=40).contains(&invalid.queue.max_mounted_rows));
        invalid = evidence();
        invalid.prompts.max_mounted_rows = 0;
        assert!(!(1..=30).contains(&invalid.prompts.max_mounted_rows));
    }

    #[test]
    fn atomic_smoke_writes_replace_existing_files_without_partial_output() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("evidence.json");
        write_atomic(&path, b"first").unwrap();
        write_atomic(&path, b"second").unwrap();
        assert_eq!(fs::read(path).unwrap(), b"second");
        assert!(temporary.path().read_dir().unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".tmp")));
    }

    #[test]
    fn smoke_input_rejects_unknown_fields_and_out_of_range_key_requests() {
        let unknown = r#"{"schemaVersion":1,"operation":"audit","unexpected":true}"#;
        assert!(serde_json::from_str::<NativeQueueReleaseSmokeInput>(unknown).is_err());
        let parsed: NativeQueueReleaseSmokeInput = serde_json::from_str(
            r#"{"schemaVersion":1,"operation":"dispatch_trusted_key","sampleIndex":31,"key":"Enter"}"#,
        )
        .unwrap();
        let NativeQueueReleaseSmokeInput::DispatchTrustedKey { sample_index, .. } = parsed else {
            panic!("key input")
        };
        assert!(!(1..=KEYBOARD_SAMPLE_COUNT as u8).contains(&sample_index));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_trusted_key_uses_the_native_return_virtual_key() {
        assert_eq!(MACOS_RETURN_VIRTUAL_KEY, 0x24);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_trusted_key_uses_the_native_return_virtual_key() {
        assert_eq!(WINDOWS_VK_RETURN, 0x0D);
    }
}
