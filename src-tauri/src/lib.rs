mod native;

use native::{
    CredentialKind, CredentialMetadata, CredentialVault, DestinationMetadata, DestinationStore,
    DownloadReceipt, DownloadRequest, Downloader, KeyringVault, NativeError, NativeResult,
    RunPodHttpRequest, RunPodHttpResponse, RunPodTransport, WorkerApi, WorkerHttpResponse,
    WorkerSession,
};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;
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
}

impl NativeState {
    fn new() -> NativeResult<Self> {
        let vault: Arc<dyn CredentialVault> = Arc::new(KeyringVault);
        let destination = DestinationStore::default();
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
) -> NativeResult<Option<DestinationMetadata>> {
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
        return tauri::async_runtime::spawn_blocking(move || {
            destination.validate_and_bind(&selected)
        })
        .await
        .map_err(|_| {
            NativeError::new(
                "native_task_failed",
                "The destination could not be verified.",
            )
        })?
        .map(Some);
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
) -> NativeResult<DestinationMetadata> {
    let destination = state.destination.clone();
    tauri::async_runtime::spawn_blocking(move || destination.validate_and_bind(Path::new(&path)))
        .await
        .map_err(|_| {
            NativeError::new(
                "native_task_failed",
                "The destination could not be verified.",
            )
        })?
}

#[tauri::command]
fn bind_worker_session(state: State<'_, NativeState>, pod_id: String) -> NativeResult<Value> {
    serde_json::to_value(state.session.bind(&pod_id)?).map_err(|_| {
        NativeError::new(
            "native_serialization_failed",
            "Worker session metadata could not be encoded.",
        )
    })
}

#[tauri::command]
fn clear_worker_session(state: State<'_, NativeState>) -> NativeResult<()> {
    state.session.clear()
}

#[tauri::command]
fn bind_runpod_profile(
    state: State<'_, NativeState>,
    template_id: String,
    network_volume_id: String,
) -> NativeResult<()> {
    state.runpod.bind_profile(&template_id, &network_volume_id)
}

#[tauri::command]
async fn runpod_inventory_http(
    state: State<'_, NativeState>,
    url: String,
) -> NativeResult<RunPodHttpResponse> {
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
) -> NativeResult<RunPodHttpResponse> {
    state
        .runpod
        .execute(RunPodHttpRequest::post(
            native::runpod::RunPodOperation::CreatePod,
            url,
            body,
        ))
        .await
}

#[tauri::command]
async fn runpod_get_pod_http(
    state: State<'_, NativeState>,
    url: String,
) -> NativeResult<RunPodHttpResponse> {
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
async fn download_artifact(
    state: State<'_, NativeState>,
    request: DownloadRequest,
) -> NativeResult<DownloadReceipt> {
    state.downloader.download_and_acknowledge(request).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = NativeState::new().expect("ImageForge secure native state failed to initialize");
    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            app_environment,
            credential_metadata,
            replace_credential,
            choose_destination,
            validate_destination,
            bind_worker_session,
            clear_worker_session,
            bind_runpod_profile,
            runpod_inventory_http,
            runpod_list_pods_http,
            runpod_create_pod_http,
            runpod_get_pod_http,
            runpod_terminate_pod_http,
            worker_health,
            worker_status,
            worker_create_batch,
            worker_get_batch,
            worker_pause_batch,
            worker_resume_batch,
            worker_cancel_batch,
            worker_retry_failed,
            download_artifact,
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
}
