mod native;

use native::{
    CredentialKind, CredentialMetadata, CredentialVault, DestinationMetadata, DestinationSelection,
    DestinationStore, DownloadReceipt, DownloadRequest, Downloader, ExportArtifactRequest,
    KeyringVault, LocalArtifactResponse, NativeError, NativeResult, NativeTwoClientSmokeInput,
    ReceiptLedger, RunPodCreateMarkerMetadata, RunPodHttpRequest, RunPodHttpResponse,
    RunPodTransport, WorkerApi, WorkerHttpResponse, WorkerPreviewResponse, WorkerSession,
};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
use tauri::Manager;
use tauri::State;
use tauri::WebviewUrl;
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
    worker: WorkerApi,
    downloader: Downloader,
    control_gate: Arc<tokio::sync::Mutex<()>>,
}

impl NativeState {
    fn new() -> NativeResult<Self> {
        let vault: Arc<dyn CredentialVault> = Arc::new(KeyringVault);
        let destination = DestinationStore::new()?;
        let session = WorkerSession::default();
        let runpod = RunPodTransport::new(vault.clone())?;
        let worker = WorkerApi::new(vault.clone(), session.clone())?;
        let downloader = Downloader::new(worker.clone(), destination.clone());
        Ok(Self {
            vault,
            destination,
            session,
            runpod,
            worker,
            downloader,
            control_gate: Arc::new(tokio::sync::Mutex::new(())),
        })
    }
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
    let _control = state.control_gate.lock().await;
    state.session.clear().await?;
    state.runpod.bind_profile(&template_id, &network_volume_id)
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

#[tauri::command]
async fn runpod_inventory_http(
    state: State<'_, NativeState>,
    url: String,
) -> NativeResult<RunPodHttpResponse> {
    let _control = state.control_gate.lock().await;
    state
        .runpod
        .execute(RunPodHttpRequest::get(
            native::runpod::RunPodOperation::Inventory,
            url,
        ))
        .await
}

#[tauri::command]
async fn runpod_list_pods_http(
    state: State<'_, NativeState>,
    url: String,
) -> NativeResult<RunPodHttpResponse> {
    let _control = state.control_gate.lock().await;
    state
        .runpod
        .execute(RunPodHttpRequest::get(
            native::runpod::RunPodOperation::ListPods,
            url,
        ))
        .await
}

#[tauri::command]
async fn runpod_create_pod_http(
    state: State<'_, NativeState>,
    url: String,
    body: Value,
    create_grant: String,
    emergency_grant: Option<String>,
) -> NativeResult<RunPodHttpResponse> {
    let _control = state.control_gate.lock().await;
    state
        .runpod
        .execute(RunPodHttpRequest::post(
            native::runpod::RunPodOperation::CreatePod,
            url,
            body,
            create_grant,
            emergency_grant,
        ))
        .await
}

#[tauri::command]
async fn runpod_get_pod_http(
    state: State<'_, NativeState>,
    url: String,
) -> NativeResult<RunPodHttpResponse> {
    let _control = state.control_gate.lock().await;
    state
        .runpod
        .execute(RunPodHttpRequest::get(
            native::runpod::RunPodOperation::GetPod,
            url,
        ))
        .await
}

#[tauri::command]
async fn runpod_terminate_pod_http(
    state: State<'_, NativeState>,
    url: String,
) -> NativeResult<RunPodHttpResponse> {
    let _control = state.control_gate.lock().await;
    state
        .runpod
        .execute(RunPodHttpRequest::delete(
            native::runpod::RunPodOperation::TerminatePod,
            url,
        ))
        .await
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
async fn worker_studio_finalize_stop_request(
    state: State<'_, NativeState>,
    input: native::worker::StudioFinalizeStopInput,
) -> NativeResult<WorkerHttpResponse> {
    state.worker.studio_finalize_stop_request(input).await
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
        .manage(state)
        .setup(|app| {
            let smoke_setting = std::env::var("IMAGEFORGE_NATIVE_SMOKE").ok();
            let smoke_mode = matches!(smoke_setting.as_deref(), Some("1" | "two-client"));
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
                let initialization = match two_client_role {
                    Some(role) => format!(
                        "window.__IMAGEFORGE_NATIVE_SMOKE__ = true; window.__IMAGEFORGE_NATIVE_SMOKE_ROLE__ = '{role}';"
                    ),
                    None => "window.__IMAGEFORGE_NATIVE_SMOKE__ = true;".to_string(),
                };
                builder = builder.initialization_script(&initialization);
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
            if two_client_role.is_some() {
                let profile = std::env::var_os("IMAGEFORGE_NATIVE_SMOKE_PROFILE")
                    .map(PathBuf::from)
                    .filter(|path| path.is_absolute())
                    .ok_or_else(|| {
                        std::io::Error::new(
                            std::io::ErrorKind::InvalidInput,
                            "The two-client native smoke profile is not configured.",
                        )
                    })?;
                builder = builder.data_directory(profile);
            }
            builder
                .title("ImageForge")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 650.0)
                .resizable(true)
                .fullscreen(false)
                .center()
                .on_navigation(navigation_allowed)
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()?;
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
            runpod_inventory_http,
            runpod_list_pods_http,
            runpod_create_pod_http,
            runpod_get_pod_http,
            runpod_terminate_pod_http,
            worker_health,
            worker_status,
            worker_studio_heartbeat,
            worker_studio_status,
            worker_studio_create_stop_request,
            worker_studio_respond_to_stop_request,
            worker_studio_finalize_stop_request,
            worker_studio_cancel_stop_request,
            worker_create_batch,
            worker_get_batch,
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
            native_smoke_result,
            native_two_client_smoke_exchange,
        ])
        .run(tauri::generate_context!())
        .expect("ImageForge native host failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
