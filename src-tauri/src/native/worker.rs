use super::session::{validate_pod_id, WorkerSessionPin};
use super::{CredentialKind, CredentialVault, NativeError, NativeResult, WorkerSession};
use futures_util::StreamExt;
use image::{guess_format, load_from_memory_with_format, ImageFormat};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

const MAX_JSON_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PREVIEW_BYTES: usize = 4 * 1024 * 1024;
const MAX_BATCH_REFERENCES: usize = 8;
const MAX_REFERENCE_BYTES: usize = 8 * 1024 * 1024;
const MAX_REFERENCE_TOTAL_BYTES: usize = 32 * 1024 * 1024;
const MAX_REFERENCE_PIXELS: u64 = 64_000_000;
const MAX_STUDIO_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_STUDIO_SESSIONS: usize = 16;
const MAX_STUDIO_PARTICIPANTS: usize = 16;
const MAX_STUDIO_DISPLAY_NAME_CHARS: usize = 80;
const MAX_STUDIO_TIMESTAMP_BYTES: usize = 32;
const MAX_STUDIO_TTL_SECONDS: u64 = 300;
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const WORKER_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const WORKER_REQUEST_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateBatchInput {
    pub prompts: Vec<String>,
    pub base_seed: u64,
    #[serde(default)]
    pub references: Vec<ReferenceInput>,
    #[serde(default = "default_aspect_ratio")]
    pub aspect_ratio: String,
}

fn default_aspect_ratio() -> String {
    "16:9".to_owned()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReferenceInput {
    pub name: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StudioAvailability {
    Foreground,
    Background,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StudioStopDecision {
    Approve,
    Deny,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioHeartbeatInput {
    pub session_id: String,
    pub availability: StudioAvailability,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCreateStopRequestInput {
    pub request_id: String,
    pub session_id: String,
    pub pod_id: String,
    pub gpu_display_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioStopResponseInput {
    pub request_id: String,
    pub session_id: String,
    pub decision: StudioStopDecision,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioFinalizeStopInput {
    pub request_id: String,
    pub session_id: String,
    pub pod_id: String,
    pub finalization_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCancelStopInput {
    pub request_id: String,
    pub session_id: String,
    pub pod_id: String,
    pub finalization_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerHttpResponse {
    pub status: u16,
    pub body: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerPreviewResponse {
    pub content_type: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub bytes: Vec<u8>,
}

#[derive(Clone)]
pub struct WorkerApi {
    client: Client,
    vault: Arc<dyn CredentialVault>,
    session: WorkerSession,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkerOperation {
    Health,
    Status,
    Manifest,
    Receipt,
    StudioHeartbeat,
    StudioStatus,
    StudioCreateStopRequest,
    StudioStopResponse,
    StudioFinalizeStop,
    StudioCancelStop,
}

#[derive(Debug, Clone, Copy)]
enum StudioStopRoute {
    Responses,
    Finalize,
    Cancel,
}

#[derive(Debug, Clone)]
enum StudioResponseBinding {
    Heartbeat {
        session_id: Uuid,
        availability: StudioAvailability,
    },
    Status {
        session_id: Uuid,
    },
    CreateStop {
        request_id: Uuid,
        session_id: Uuid,
        pod_id: String,
        gpu_display_name: String,
    },
    RespondToStop {
        request_id: Uuid,
        session_id: Uuid,
    },
    FinalizeStop {
        request_id: Uuid,
        session_id: Uuid,
        pod_id: String,
        finalization_id: Uuid,
    },
    CancelStop {
        request_id: Uuid,
        session_id: Uuid,
        pod_id: String,
    },
}

#[derive(Debug, Clone)]
struct StudioRequestPlan {
    method: Method,
    path: String,
    body: Option<Value>,
    authenticated: bool,
    operation: WorkerOperation,
    binding: StudioResponseBinding,
    expected_pod_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkerTransportFailure {
    Timeout,
    Request,
    Response,
}

impl WorkerOperation {
    fn response_limit(self) -> usize {
        if matches!(
            self,
            Self::StudioHeartbeat
                | Self::StudioStatus
                | Self::StudioCreateStopRequest
                | Self::StudioStopResponse
                | Self::StudioFinalizeStop
                | Self::StudioCancelStop
        ) {
            MAX_STUDIO_RESPONSE_BYTES
        } else {
            MAX_JSON_RESPONSE_BYTES
        }
    }

    fn studio_success_status(self) -> Option<StatusCode> {
        match self {
            Self::StudioCreateStopRequest => Some(StatusCode::CREATED),
            Self::StudioHeartbeat
            | Self::StudioStatus
            | Self::StudioStopResponse
            | Self::StudioFinalizeStop
            | Self::StudioCancelStop => Some(StatusCode::OK),
            _ => None,
        }
    }

    fn is_studio(self) -> bool {
        self.studio_success_status().is_some()
    }
}

impl WorkerApi {
    pub fn new(vault: Arc<dyn CredentialVault>, session: WorkerSession) -> NativeResult<Self> {
        let client = Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(WORKER_CONNECT_TIMEOUT)
            .timeout(WORKER_REQUEST_TIMEOUT)
            .user_agent("ImageForge/0.1 desktop")
            .build()
            .map_err(|_| {
                NativeError::new(
                    "http_client_unavailable",
                    "The secure worker client could not be initialized.",
                )
            })?;
        Ok(Self {
            client,
            vault,
            session,
        })
    }

    pub async fn health(&self) -> NativeResult<WorkerHttpResponse> {
        self.request_json(
            Method::GET,
            "/v1/health",
            None,
            false,
            WorkerOperation::Health,
        )
        .await
    }

    pub async fn status(&self) -> NativeResult<WorkerHttpResponse> {
        self.request_json(
            Method::GET,
            "/v1/status",
            None,
            true,
            WorkerOperation::Status,
        )
        .await
    }

    pub async fn studio_heartbeat(
        &self,
        input: StudioHeartbeatInput,
    ) -> NativeResult<WorkerHttpResponse> {
        let session_id = parse_studio_uuid(&input.session_id, "studio_session_id_invalid")?;
        self.execute_studio_request(studio_heartbeat_plan(session_id, input.availability))
            .await
    }

    pub async fn studio_status(&self, session_id: &str) -> NativeResult<WorkerHttpResponse> {
        let session_id = parse_studio_uuid(session_id, "studio_session_id_invalid")?;
        self.execute_studio_request(studio_status_plan(session_id))
            .await
    }

    pub async fn studio_create_stop_request(
        &self,
        input: StudioCreateStopRequestInput,
    ) -> NativeResult<WorkerHttpResponse> {
        let request_id = parse_studio_uuid(&input.request_id, "stop_request_id_invalid")?;
        let session_id = parse_studio_uuid(&input.session_id, "studio_session_id_invalid")?;
        validate_pod_id(&input.pod_id)?;
        validate_gpu_display_name(&input.gpu_display_name)?;
        let pod_id = input.pod_id;
        let gpu_display_name = input.gpu_display_name;
        self.execute_studio_request(studio_create_stop_plan(
            request_id,
            session_id,
            pod_id,
            gpu_display_name,
        ))
        .await
    }

    pub async fn studio_respond_to_stop_request(
        &self,
        input: StudioStopResponseInput,
    ) -> NativeResult<WorkerHttpResponse> {
        let request_id = parse_studio_uuid(&input.request_id, "stop_request_id_invalid")?;
        let session_id = parse_studio_uuid(&input.session_id, "studio_session_id_invalid")?;
        self.execute_studio_request(studio_stop_response_plan(
            request_id,
            session_id,
            input.decision,
        ))
        .await
    }

    pub async fn studio_finalize_stop_request(
        &self,
        input: StudioFinalizeStopInput,
    ) -> NativeResult<WorkerHttpResponse> {
        let request_id = parse_studio_uuid(&input.request_id, "stop_request_id_invalid")?;
        let session_id = parse_studio_uuid(&input.session_id, "studio_session_id_invalid")?;
        validate_pod_id(&input.pod_id)?;
        let pod_id = input.pod_id;
        let finalization_id =
            parse_studio_uuid(&input.finalization_id, "stop_finalization_id_invalid")?;
        self.execute_studio_request(studio_finalize_stop_plan(
            request_id,
            session_id,
            pod_id,
            finalization_id,
        ))
        .await
    }

    pub async fn studio_cancel_stop_request(
        &self,
        input: StudioCancelStopInput,
    ) -> NativeResult<WorkerHttpResponse> {
        let request_id = parse_studio_uuid(&input.request_id, "stop_request_id_invalid")?;
        let session_id = parse_studio_uuid(&input.session_id, "studio_session_id_invalid")?;
        validate_pod_id(&input.pod_id)?;
        let pod_id = input.pod_id;
        let finalization_id = input
            .finalization_id
            .as_deref()
            .map(|value| parse_studio_uuid(value, "stop_finalization_id_invalid"))
            .transpose()?;
        self.execute_studio_request(studio_cancel_stop_plan(
            request_id,
            session_id,
            pod_id,
            finalization_id,
        ))
        .await
    }

    pub async fn create_batch(&self, input: CreateBatchInput) -> NativeResult<WorkerHttpResponse> {
        validate_create_batch(&input)?;
        self.request_json(
            Method::POST,
            "/v1/batches",
            Some(create_batch_payload(&input)),
            true,
            WorkerOperation::Manifest,
        )
        .await
    }

    pub async fn get_batch(&self, batch_id: Uuid) -> NativeResult<WorkerHttpResponse> {
        self.request_json(
            Method::GET,
            &format!("/v1/batches/{batch_id}"),
            None,
            true,
            WorkerOperation::Manifest,
        )
        .await
    }

    pub async fn pause(&self, batch_id: Uuid) -> NativeResult<WorkerHttpResponse> {
        self.mutate_batch(batch_id, "pause").await
    }

    pub async fn resume(&self, batch_id: Uuid) -> NativeResult<WorkerHttpResponse> {
        self.mutate_batch(batch_id, "resume").await
    }

    pub async fn cancel(&self, batch_id: Uuid) -> NativeResult<WorkerHttpResponse> {
        self.mutate_batch(batch_id, "cancel").await
    }

    pub async fn retry_failed(&self, batch_id: Uuid) -> NativeResult<WorkerHttpResponse> {
        self.mutate_batch(batch_id, "retry-failed").await
    }

    /// Fetch one generated preview through the native authenticated boundary.
    /// The renderer never receives the worker bearer token or an arbitrary URL.
    pub async fn preview(&self, batch_id: Uuid, index: u64) -> NativeResult<WorkerPreviewResponse> {
        validate_index(index)?;
        let pin = self.session.pin().await?;
        let url = pin.endpoint(&format!("/v1/batches/{batch_id}/previews/{index}"))?;
        let token = self.worker_token()?;
        let response = self
            .client
            .get(url)
            .header(AUTHORIZATION, format!("Bearer {token}"))
            .header(ACCEPT, "image/webp")
            .send()
            .await
            .map_err(|_| {
                NativeError::retryable(
                    "worker_network_error",
                    "The ImageForge preview could not be reached.",
                )
            })?;
        let status = response.status();
        if status != StatusCode::OK {
            // Preserve a redacted worker error message where possible, but
            // never pass an arbitrary response body to the renderer.
            let body = read_bounded(response, 64 * 1024).await?;
            if let Ok(value) = serde_json::from_slice::<Value>(&body) {
                let runpod_key = self.vault.load(CredentialKind::RunpodApiKey).ok();
                reject_secret_reflection(&value, Some(&token), runpod_key.as_deref())?;
                if let Some(message) = value
                    .get("error")
                    .and_then(Value::as_object)
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .filter(|message| !message.is_empty() && message.len() <= 500)
                {
                    return Err(NativeError::retryable(
                        "preview_request_failed",
                        message.to_owned(),
                    ));
                }
            }
            return Err(NativeError::retryable(
                "preview_request_failed",
                format!(
                    "The worker could not provide preview {index} (HTTP {}).",
                    status.as_u16()
                ),
            ));
        }

        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| {
                NativeError::new(
                    "preview_metadata_mismatch",
                    "The worker preview did not declare an image/webp content type.",
                )
            })?;
        if content_type != "image/webp" {
            return Err(NativeError::new(
                "preview_metadata_mismatch",
                "The worker returned a non-WebP preview.",
            ));
        }
        let checksum = response
            .headers()
            .get("x-imageforge-sha256")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| {
                NativeError::new(
                    "preview_metadata_mismatch",
                    "The worker preview did not declare a checksum.",
                )
            })?;
        validate_checksum(&checksum)?;
        let declared_size = response.content_length().ok_or_else(|| {
            NativeError::new(
                "preview_metadata_mismatch",
                "The worker preview did not declare a byte count.",
            )
        })?;
        if declared_size == 0 || declared_size > MAX_PREVIEW_BYTES as u64 {
            return Err(NativeError::new(
                "preview_size_invalid",
                "The worker preview exceeded the safe preview size limit.",
            ));
        }
        let bytes = read_bounded(response, MAX_PREVIEW_BYTES).await?;
        if bytes.len() as u64 != declared_size
            || !is_webp(&bytes)
            || hex::encode(Sha256::digest(&bytes)) != checksum
        {
            return Err(NativeError::new(
                "preview_checksum_mismatch",
                "The worker preview failed image, size, or checksum validation.",
            ));
        }
        let runpod_key = self.vault.load(CredentialKind::RunpodApiKey).ok();
        let reflected_secret = [Some(token.as_str()), runpod_key.as_deref()]
            .into_iter()
            .flatten()
            .filter(|secret| !secret.is_empty())
            .any(|secret| {
                bytes
                    .windows(secret.len())
                    .any(|window| window == secret.as_bytes())
            });
        if reflected_secret {
            return Err(NativeError::new(
                "worker_secret_reflection",
                "The worker preview was rejected because it exposed saved credential material.",
            ));
        }
        Ok(WorkerPreviewResponse {
            content_type,
            sha256: checksum,
            size_bytes: declared_size,
            bytes,
        })
    }

    pub(crate) async fn acknowledge_with_pin(
        &self,
        pin: &WorkerSessionPin,
        batch_id: Uuid,
        index: u64,
        sha256: &str,
        size_bytes: u64,
    ) -> NativeResult<WorkerHttpResponse> {
        validate_index(index)?;
        validate_checksum(sha256)?;
        if size_bytes == 0 {
            return Err(NativeError::new(
                "receipt_invalid",
                "A download receipt must contain a positive byte count.",
            ));
        }
        self.request_json_with_pin(
            pin,
            Method::POST,
            &format!("/v1/batches/{batch_id}/receipts"),
            Some(json!({
                "receipts": [{"index": index, "sha256": sha256, "size_bytes": size_bytes}]
            })),
            true,
            WorkerOperation::Receipt,
        )
        .await
    }

    pub(crate) fn client(&self) -> &Client {
        &self.client
    }

    pub(crate) fn session(&self) -> &WorkerSession {
        &self.session
    }

    pub(crate) fn worker_token(&self) -> NativeResult<String> {
        self.vault.load(CredentialKind::WorkerToken)
    }

    pub(crate) fn saved_secrets(&self) -> NativeResult<Vec<String>> {
        let mut secrets = vec![self.worker_token()?];
        if let Ok(runpod_key) = self.vault.load(CredentialKind::RunpodApiKey) {
            secrets.push(runpod_key);
        }
        Ok(secrets)
    }

    async fn mutate_batch(&self, batch_id: Uuid, action: &str) -> NativeResult<WorkerHttpResponse> {
        debug_assert!(matches!(
            action,
            "pause" | "resume" | "cancel" | "retry-failed"
        ));
        self.request_json(
            Method::POST,
            &format!("/v1/batches/{batch_id}/{action}"),
            None,
            true,
            WorkerOperation::Manifest,
        )
        .await
    }

    async fn request_json(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        authenticated: bool,
        operation: WorkerOperation,
    ) -> NativeResult<WorkerHttpResponse> {
        let pin = self.session.pin().await?;
        self.request_json_with_pin(&pin, method, path, body, authenticated, operation)
            .await
    }

    async fn execute_studio_request(
        &self,
        plan: StudioRequestPlan,
    ) -> NativeResult<WorkerHttpResponse> {
        let response = if let Some(expected_pod_id) = plan.expected_pod_id.as_deref() {
            // Hold the session gate from target comparison until the response
            // is fully read and projected. A concurrent refresh cannot rebind
            // finalize/cancel to a replacement Pod midway through the guard.
            let pin = self.session.pin().await?;
            ensure_pin_matches_pod(&pin, expected_pod_id)?;
            self.request_json_with_pin(
                &pin,
                plan.method,
                &plan.path,
                plan.body,
                plan.authenticated,
                plan.operation,
            )
            .await?
        } else {
            self.request_json(
                plan.method,
                &plan.path,
                plan.body,
                plan.authenticated,
                plan.operation,
            )
            .await?
        };
        bind_studio_response(response, plan.binding)
    }

    async fn request_json_with_pin(
        &self,
        pin: &WorkerSessionPin,
        method: Method,
        path: &str,
        body: Option<Value>,
        authenticated: bool,
        operation: WorkerOperation,
    ) -> NativeResult<WorkerHttpResponse> {
        let url = pin.endpoint(path)?;
        let mut builder = self
            .client
            .request(method, url)
            .header(ACCEPT, "application/json");
        let worker_token = authenticated.then(|| self.worker_token()).transpose()?;
        if let Some(credential) = worker_token.as_deref() {
            builder = builder.header(AUTHORIZATION, format!("Bearer {credential}"));
        }
        if let Some(body) = body {
            builder = builder.header(CONTENT_TYPE, "application/json").json(&body);
        }
        let response = builder.send().await.map_err(map_worker_request_error)?;
        let status = response.status();
        let bytes = read_bounded(response, operation.response_limit()).await?;
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).map_err(|_| {
                NativeError::new(
                    "worker_response_invalid",
                    "The ImageForge worker returned malformed JSON.",
                )
            })?
        };
        let reflected_worker_token = worker_token
            .clone()
            .or_else(|| self.vault.load(CredentialKind::WorkerToken).ok());
        let runpod_key = self.vault.load(CredentialKind::RunpodApiKey).ok();
        reject_secret_reflection(
            &body,
            reflected_worker_token.as_deref(),
            runpod_key.as_deref(),
        )?;
        validate_worker_envelope(status, &body)?;
        if let Some(expected) = operation.studio_success_status() {
            if status.is_success() && status != expected {
                return Err(worker_response_invalid());
            }
        }
        let body = if status.is_success() {
            project_worker_success(operation, &body)?
        } else if operation.is_studio() {
            project_studio_error(status, &body)?
        } else {
            project_worker_error(&body)?
        };
        Ok(WorkerHttpResponse {
            status: status.as_u16(),
            body,
        })
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct StudioStateProjection {
    schema_version: u64,
    server_instance_id: String,
    coordination_revision: u64,
    server_time: String,
    presence_ttl_seconds: u64,
    response_ttl_seconds: u64,
    finalization_ttl_seconds: u64,
    current_session: StudioSessionProjection,
    sessions: Vec<StudioSessionProjection>,
    active_batch: Option<StudioActiveBatchProjection>,
    stop_request: Option<StudioStopRequestProjection>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct StudioSessionProjection {
    session_id: String,
    display_name: String,
    availability: StudioAvailability,
    expires_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct StudioParticipantProjection {
    session_id: String,
    display_name: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum StudioActiveBatchState {
    Running,
    Paused,
    Interrupted,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct StudioBatchOwnerProjection {
    user_id: String,
    display_name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct StudioBatchProgressProjection {
    total: u64,
    completed: u64,
    downloaded: u64,
    failed: u64,
    cancelled: u64,
    processed: u64,
    current_index: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct StudioActiveBatchProjection {
    batch_id: String,
    owner: StudioBatchOwnerProjection,
    state: StudioActiveBatchState,
    progress: StudioBatchProgressProjection,
    pause_requested: bool,
    cancel_requested: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum StudioStopRequestState {
    Pending,
    Approved,
    Denied,
    Expired,
    Cancelled,
    Finalizing,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum StudioStopReason {
    PeerDenied,
    ResponseTimeout,
    RequesterCancelled,
    RequesterExpired,
    GenerationStarted,
    FinalizationExpired,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct StudioStopRequestProjection {
    request_id: String,
    pod_id: String,
    gpu_display_name: String,
    requester: StudioParticipantProjection,
    state: StudioStopRequestState,
    reason: Option<StudioStopReason>,
    requested_at: String,
    response_deadline: String,
    finalization_expires_at: Option<String>,
    waiting_for: Vec<StudioParticipantProjection>,
    approved_by: Vec<StudioParticipantProjection>,
    denied_by: Vec<StudioParticipantProjection>,
    finalization_id: Option<String>,
}

fn parse_studio_uuid(value: &str, code: &'static str) -> NativeResult<Uuid> {
    let parsed = Uuid::parse_str(value)
        .map_err(|_| NativeError::new(code, "The studio coordination identifier is invalid."))?;
    if parsed.get_version() != Some(uuid::Version::Random) || parsed.to_string() != value {
        return Err(NativeError::new(
            code,
            "The studio coordination identifier is invalid.",
        ));
    }
    Ok(parsed)
}

fn studio_session_path(session_id: Uuid) -> String {
    format!("/v1/studio/sessions/{session_id}")
}

fn studio_stop_action_path(request_id: Uuid, route: StudioStopRoute) -> String {
    let action = match route {
        StudioStopRoute::Responses => "responses",
        StudioStopRoute::Finalize => "finalize",
        StudioStopRoute::Cancel => "cancel",
    };
    format!("/v1/studio/stop-requests/{request_id}/{action}")
}

fn studio_heartbeat_plan(session_id: Uuid, availability: StudioAvailability) -> StudioRequestPlan {
    StudioRequestPlan {
        method: Method::PUT,
        path: studio_session_path(session_id),
        body: Some(json!({"availability": availability})),
        authenticated: true,
        operation: WorkerOperation::StudioHeartbeat,
        binding: StudioResponseBinding::Heartbeat {
            session_id,
            availability,
        },
        expected_pod_id: None,
    }
}

fn studio_status_plan(session_id: Uuid) -> StudioRequestPlan {
    StudioRequestPlan {
        method: Method::GET,
        path: studio_session_path(session_id),
        body: None,
        authenticated: true,
        operation: WorkerOperation::StudioStatus,
        binding: StudioResponseBinding::Status { session_id },
        expected_pod_id: None,
    }
}

fn studio_create_stop_plan(
    request_id: Uuid,
    session_id: Uuid,
    pod_id: String,
    gpu_display_name: String,
) -> StudioRequestPlan {
    StudioRequestPlan {
        method: Method::POST,
        path: "/v1/studio/stop-requests".to_owned(),
        body: Some(json!({
            "request_id": request_id,
            "session_id": session_id,
            "pod_id": pod_id,
            "gpu_display_name": gpu_display_name,
        })),
        authenticated: true,
        operation: WorkerOperation::StudioCreateStopRequest,
        binding: StudioResponseBinding::CreateStop {
            request_id,
            session_id,
            pod_id: pod_id.clone(),
            gpu_display_name,
        },
        expected_pod_id: Some(pod_id),
    }
}

fn studio_stop_response_plan(
    request_id: Uuid,
    session_id: Uuid,
    decision: StudioStopDecision,
) -> StudioRequestPlan {
    StudioRequestPlan {
        method: Method::POST,
        path: studio_stop_action_path(request_id, StudioStopRoute::Responses),
        body: Some(json!({
            "session_id": session_id,
            "decision": decision,
        })),
        authenticated: true,
        operation: WorkerOperation::StudioStopResponse,
        binding: StudioResponseBinding::RespondToStop {
            request_id,
            session_id,
        },
        expected_pod_id: None,
    }
}

fn studio_finalize_stop_plan(
    request_id: Uuid,
    session_id: Uuid,
    pod_id: String,
    finalization_id: Uuid,
) -> StudioRequestPlan {
    StudioRequestPlan {
        method: Method::POST,
        path: studio_stop_action_path(request_id, StudioStopRoute::Finalize),
        // pod_id is a native-only target assertion. The strict worker body
        // remains the documented session/finalization pair.
        body: Some(json!({
            "session_id": session_id,
            "finalization_id": finalization_id,
        })),
        authenticated: true,
        operation: WorkerOperation::StudioFinalizeStop,
        binding: StudioResponseBinding::FinalizeStop {
            request_id,
            session_id,
            pod_id: pod_id.clone(),
            finalization_id,
        },
        expected_pod_id: Some(pod_id),
    }
}

fn studio_cancel_stop_plan(
    request_id: Uuid,
    session_id: Uuid,
    pod_id: String,
    finalization_id: Option<Uuid>,
) -> StudioRequestPlan {
    StudioRequestPlan {
        method: Method::POST,
        path: studio_stop_action_path(request_id, StudioStopRoute::Cancel),
        // pod_id pins the native transport and response but is deliberately
        // excluded from the worker's deny-unknown-fields request model.
        body: Some(json!({
            "session_id": session_id,
            "finalization_id": finalization_id,
        })),
        authenticated: true,
        operation: WorkerOperation::StudioCancelStop,
        binding: StudioResponseBinding::CancelStop {
            request_id,
            session_id,
            pod_id: pod_id.clone(),
        },
        expected_pod_id: Some(pod_id),
    }
}

fn validate_gpu_display_name(value: &str) -> NativeResult<()> {
    if value.is_empty()
        || value.len() > 80
        || value.trim() != value
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b' ' | b'.' | b'_' | b'(' | b')' | b'+' | b'-')
        })
    {
        return Err(NativeError::new(
            "gpu_display_name_invalid",
            "The GPU display name is invalid.",
        ));
    }
    Ok(())
}

fn ensure_pin_matches_pod(pin: &WorkerSessionPin, pod_id: &str) -> NativeResult<()> {
    let endpoint = pin.endpoint("/v1/health")?;
    let expected_host = format!("{pod_id}-8000.proxy.runpod.net");
    if endpoint.host_str() != Some(expected_host.as_str()) {
        return Err(NativeError::new(
            "worker_session_changed",
            "The verified ImageForge Pod changed before the exact-Pod coordination request could be sent.",
        ));
    }
    Ok(())
}

fn validate_studio_timestamp(value: &str) -> NativeResult<()> {
    let bytes = value.as_bytes();
    let digits = |range: std::ops::Range<usize>| {
        bytes
            .get(range)
            .is_some_and(|slice| slice.iter().all(u8::is_ascii_digit))
    };
    let valid_shape = bytes.len() <= MAX_STUDIO_TIMESTAMP_BYTES
        && bytes.len() == 24
        && digits(0..4)
        && bytes.get(4) == Some(&b'-')
        && digits(5..7)
        && bytes.get(7) == Some(&b'-')
        && digits(8..10)
        && bytes.get(10) == Some(&b'T')
        && digits(11..13)
        && bytes.get(13) == Some(&b':')
        && digits(14..16)
        && bytes.get(16) == Some(&b':')
        && digits(17..19)
        && bytes.get(19) == Some(&b'.')
        && digits(20..23)
        && bytes.get(23) == Some(&b'Z');
    let component = |range: std::ops::Range<usize>| -> Option<u32> {
        std::str::from_utf8(bytes.get(range)?)
            .ok()?
            .parse::<u32>()
            .ok()
    };
    if !valid_shape {
        return Err(worker_response_invalid());
    }
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        component(0..4),
        component(5..7),
        component(8..10),
        component(11..13),
        component(14..16),
        component(17..19),
    ) else {
        return Err(worker_response_invalid());
    };
    let maximum_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_gregorian_leap_year(year) => 29,
        2 => 28,
        _ => return Err(worker_response_invalid()),
    };
    if year == 0 || !(1..=maximum_day).contains(&day) || hour > 23 || minute > 59 || second > 59 {
        return Err(worker_response_invalid());
    }
    Ok(())
}

fn is_gregorian_leap_year(year: u32) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

fn validate_studio_display_name(value: &str) -> NativeResult<()> {
    if value.trim() != value
        || value.is_empty()
        || value.chars().count() > MAX_STUDIO_DISPLAY_NAME_CHARS
        || value.chars().any(char::is_control)
    {
        return Err(worker_response_invalid());
    }
    Ok(())
}

fn validate_safe_identity(value: &str) -> NativeResult<()> {
    if value.trim() != value
        || value.is_empty()
        || value.len() > 200
        || value.chars().any(char::is_control)
    {
        return Err(worker_response_invalid());
    }
    Ok(())
}

fn require_exact_keys(value: &Value, keys: &[&str]) -> NativeResult<()> {
    let object = value.as_object().ok_or_else(worker_response_invalid)?;
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Err(worker_response_invalid());
    }
    Ok(())
}

fn validate_studio_state_shape(body: &Value) -> NativeResult<()> {
    require_exact_keys(
        body,
        &[
            "schema_version",
            "server_instance_id",
            "coordination_revision",
            "server_time",
            "presence_ttl_seconds",
            "response_ttl_seconds",
            "finalization_ttl_seconds",
            "current_session",
            "sessions",
            "active_batch",
            "stop_request",
        ],
    )?;
    require_exact_keys(
        body.get("current_session")
            .ok_or_else(worker_response_invalid)?,
        &["session_id", "display_name", "availability", "expires_at"],
    )?;
    for session in body
        .get("sessions")
        .and_then(Value::as_array)
        .ok_or_else(worker_response_invalid)?
    {
        require_exact_keys(
            session,
            &["session_id", "display_name", "availability", "expires_at"],
        )?;
    }
    if let Some(active) = body.get("active_batch").filter(|value| !value.is_null()) {
        require_exact_keys(
            active,
            &[
                "batch_id",
                "owner",
                "state",
                "progress",
                "pause_requested",
                "cancel_requested",
            ],
        )?;
        require_exact_keys(
            active.get("owner").ok_or_else(worker_response_invalid)?,
            &["user_id", "display_name"],
        )?;
        require_exact_keys(
            active.get("progress").ok_or_else(worker_response_invalid)?,
            &[
                "total",
                "completed",
                "downloaded",
                "failed",
                "cancelled",
                "processed",
                "current_index",
            ],
        )?;
    }
    if let Some(stop) = body.get("stop_request").filter(|value| !value.is_null()) {
        require_exact_keys(
            stop,
            &[
                "request_id",
                "pod_id",
                "gpu_display_name",
                "requester",
                "state",
                "reason",
                "requested_at",
                "response_deadline",
                "finalization_expires_at",
                "waiting_for",
                "approved_by",
                "denied_by",
                "finalization_id",
            ],
        )?;
        require_exact_keys(
            stop.get("requester").ok_or_else(worker_response_invalid)?,
            &["session_id", "display_name"],
        )?;
        for key in ["waiting_for", "approved_by", "denied_by"] {
            for participant in stop
                .get(key)
                .and_then(Value::as_array)
                .ok_or_else(worker_response_invalid)?
            {
                require_exact_keys(participant, &["session_id", "display_name"])?;
            }
        }
    }
    Ok(())
}

fn validate_studio_session(session: &StudioSessionProjection) -> NativeResult<()> {
    parse_studio_uuid(&session.session_id, "worker_response_invalid")?;
    validate_studio_display_name(&session.display_name)?;
    validate_studio_timestamp(&session.expires_at)
}

fn validate_studio_participant(participant: &StudioParticipantProjection) -> NativeResult<()> {
    parse_studio_uuid(&participant.session_id, "worker_response_invalid")?;
    validate_studio_display_name(&participant.display_name)
}

fn validate_studio_participants(participants: &[StudioParticipantProjection]) -> NativeResult<()> {
    if participants.len() > MAX_STUDIO_PARTICIPANTS {
        return Err(worker_response_invalid());
    }
    let mut ids = std::collections::HashSet::with_capacity(participants.len());
    for participant in participants {
        validate_studio_participant(participant)?;
        if !ids.insert(participant.session_id.as_str()) {
            return Err(worker_response_invalid());
        }
    }
    Ok(())
}

fn validate_studio_active_batch(batch: &StudioActiveBatchProjection) -> NativeResult<()> {
    parse_studio_uuid(&batch.batch_id, "worker_response_invalid")?;
    validate_safe_identity(&batch.owner.user_id)?;
    validate_studio_display_name(&batch.owner.display_name)?;
    let progress = &batch.progress;
    if progress.total == 0
        || [
            progress.total,
            progress.completed,
            progress.downloaded,
            progress.failed,
            progress.cancelled,
            progress.processed,
        ]
        .into_iter()
        .any(|value| value > MAX_JSON_SAFE_INTEGER)
        || progress.completed > progress.total
        || progress.downloaded > progress.completed
        || progress.failed > progress.total
        || progress.cancelled > progress.total
        || progress.processed > progress.total
        || progress.completed + progress.failed + progress.cancelled != progress.processed
        || progress
            .current_index
            .is_some_and(|index| index == 0 || index > progress.total)
    {
        return Err(worker_response_invalid());
    }
    Ok(())
}

fn validate_studio_stop_request(
    stop: &mut StudioStopRequestProjection,
    current_session_id: &str,
) -> NativeResult<()> {
    parse_studio_uuid(&stop.request_id, "worker_response_invalid")?;
    validate_pod_id(&stop.pod_id).map_err(|_| worker_response_invalid())?;
    validate_gpu_display_name(&stop.gpu_display_name).map_err(|_| worker_response_invalid())?;
    validate_studio_participant(&stop.requester)?;
    validate_studio_timestamp(&stop.requested_at)?;
    validate_studio_timestamp(&stop.response_deadline)?;
    if let Some(timestamp) = stop.finalization_expires_at.as_deref() {
        validate_studio_timestamp(timestamp)?;
    }
    validate_studio_participants(&stop.waiting_for)?;
    validate_studio_participants(&stop.approved_by)?;
    validate_studio_participants(&stop.denied_by)?;
    if let Some(finalization_id) = stop.finalization_id.as_deref() {
        parse_studio_uuid(finalization_id, "worker_response_invalid")?;
    }

    let requester_is_current = stop.requester.session_id == current_session_id;
    let field_state_valid = match stop.state {
        StudioStopRequestState::Pending => {
            stop.reason.is_none()
                && stop.finalization_expires_at.is_none()
                && stop.finalization_id.is_none()
                && stop.denied_by.is_empty()
        }
        StudioStopRequestState::Approved => {
            stop.reason.is_none()
                && stop.finalization_expires_at.is_none()
                && stop.finalization_id.is_none()
                && stop.waiting_for.is_empty()
                && stop.denied_by.is_empty()
        }
        StudioStopRequestState::Denied => {
            stop.reason == Some(StudioStopReason::PeerDenied)
                && stop.finalization_expires_at.is_none()
                && stop.finalization_id.is_none()
                && !stop.denied_by.is_empty()
        }
        StudioStopRequestState::Expired => {
            matches!(
                stop.reason,
                Some(StudioStopReason::ResponseTimeout | StudioStopReason::FinalizationExpired)
            ) && stop.finalization_expires_at.is_none()
                && stop.finalization_id.is_none()
        }
        StudioStopRequestState::Cancelled => {
            matches!(
                stop.reason,
                Some(
                    StudioStopReason::RequesterCancelled
                        | StudioStopReason::RequesterExpired
                        | StudioStopReason::GenerationStarted
                )
            ) && stop.finalization_expires_at.is_none()
                && stop.finalization_id.is_none()
        }
        StudioStopRequestState::Finalizing => {
            stop.reason.is_none()
                && stop.finalization_expires_at.is_some()
                && stop.waiting_for.is_empty()
                && stop.denied_by.is_empty()
                && (!requester_is_current || stop.finalization_id.is_some())
        }
    };
    if !field_state_valid {
        return Err(worker_response_invalid());
    }

    let requester_id = stop.requester.session_id.as_str();
    let mut participant_ids = std::collections::HashSet::new();
    for participant in stop
        .waiting_for
        .iter()
        .chain(&stop.approved_by)
        .chain(&stop.denied_by)
    {
        if participant.session_id == requester_id
            || !participant_ids.insert(participant.session_id.as_str())
        {
            return Err(worker_response_invalid());
        }
    }

    if stop.state == StudioStopRequestState::Finalizing && !requester_is_current {
        // finalization_id is an exact-session deletion grant. Even if a
        // compromised or stale worker reflects a well-formed value to a peer,
        // the native boundary never lets it cross into that renderer.
        stop.finalization_id = None;
    }
    Ok(())
}

fn project_studio_state(body: &Value) -> NativeResult<Value> {
    validate_studio_state_shape(body)?;
    let mut projection: StudioStateProjection =
        serde_json::from_value(body.clone()).map_err(|_| worker_response_invalid())?;
    if projection.schema_version != 1
        || projection.coordination_revision > MAX_JSON_SAFE_INTEGER
        || ![
            projection.presence_ttl_seconds,
            projection.response_ttl_seconds,
            projection.finalization_ttl_seconds,
        ]
        .into_iter()
        .all(|ttl| (1..=MAX_STUDIO_TTL_SECONDS).contains(&ttl))
    {
        return Err(worker_response_invalid());
    }
    parse_studio_uuid(&projection.server_instance_id, "worker_response_invalid")?;
    validate_studio_timestamp(&projection.server_time)?;
    validate_studio_session(&projection.current_session)?;
    if projection.sessions.is_empty() || projection.sessions.len() > MAX_STUDIO_SESSIONS {
        return Err(worker_response_invalid());
    }
    let mut session_ids = std::collections::HashSet::with_capacity(projection.sessions.len());
    for session in &projection.sessions {
        validate_studio_session(session)?;
        if !session_ids.insert(session.session_id.as_str()) {
            return Err(worker_response_invalid());
        }
    }
    if !projection
        .sessions
        .iter()
        .any(|session| session == &projection.current_session)
    {
        return Err(worker_response_invalid());
    }
    if let Some(batch) = projection.active_batch.as_ref() {
        validate_studio_active_batch(batch)?;
    }
    let current_session_id = projection.current_session.session_id.clone();
    if let Some(stop) = projection.stop_request.as_mut() {
        validate_studio_stop_request(stop, &current_session_id)?;
    }
    serde_json::to_value(projection).map_err(|_| worker_response_invalid())
}

fn bind_studio_response(
    response: WorkerHttpResponse,
    binding: StudioResponseBinding,
) -> NativeResult<WorkerHttpResponse> {
    if !(200..300).contains(&response.status) {
        return Ok(response);
    }
    let state: StudioStateProjection =
        serde_json::from_value(response.body.clone()).map_err(|_| worker_response_invalid())?;
    validate_studio_response_binding(&state, &binding)?;
    Ok(response)
}

fn validate_studio_response_binding(
    state: &StudioStateProjection,
    binding: &StudioResponseBinding,
) -> NativeResult<()> {
    let expected_session_id = match binding {
        StudioResponseBinding::Heartbeat { session_id, .. }
        | StudioResponseBinding::Status { session_id }
        | StudioResponseBinding::CreateStop { session_id, .. }
        | StudioResponseBinding::RespondToStop { session_id, .. }
        | StudioResponseBinding::FinalizeStop { session_id, .. }
        | StudioResponseBinding::CancelStop { session_id, .. } => session_id.to_string(),
    };
    if state.current_session.session_id != expected_session_id {
        return Err(studio_response_mismatch());
    }

    match binding {
        StudioResponseBinding::Heartbeat { availability, .. } => {
            if state.current_session.availability != *availability {
                return Err(studio_response_mismatch());
            }
        }
        StudioResponseBinding::Status { .. } => {}
        StudioResponseBinding::CreateStop {
            request_id,
            pod_id,
            gpu_display_name,
            ..
        } => {
            let stop = state
                .stop_request
                .as_ref()
                .ok_or_else(studio_response_mismatch)?;
            if stop.request_id != request_id.to_string()
                || stop.requester.session_id != expected_session_id
                || stop.requester.display_name != state.current_session.display_name
                || stop.pod_id != *pod_id
                || stop.gpu_display_name != *gpu_display_name
            {
                return Err(studio_response_mismatch());
            }
        }
        StudioResponseBinding::RespondToStop { request_id, .. } => {
            let stop = state
                .stop_request
                .as_ref()
                .ok_or_else(studio_response_mismatch)?;
            if stop.request_id != request_id.to_string() {
                return Err(studio_response_mismatch());
            }
        }
        StudioResponseBinding::FinalizeStop {
            request_id,
            pod_id,
            finalization_id,
            ..
        } => {
            let stop = state
                .stop_request
                .as_ref()
                .ok_or_else(studio_response_mismatch)?;
            let expected_finalization_id = finalization_id.to_string();
            if stop.request_id != request_id.to_string()
                || stop.requester.session_id != expected_session_id
                || stop.requester.display_name != state.current_session.display_name
                || stop.pod_id != *pod_id
                || stop.state != StudioStopRequestState::Finalizing
                || stop.finalization_id.as_deref() != Some(expected_finalization_id.as_str())
                || stop.finalization_expires_at.is_none()
            {
                return Err(studio_response_mismatch());
            }
        }
        StudioResponseBinding::CancelStop {
            request_id, pod_id, ..
        } => {
            let stop = state
                .stop_request
                .as_ref()
                .ok_or_else(studio_response_mismatch)?;
            if stop.request_id != request_id.to_string()
                || stop.requester.session_id != expected_session_id
                || stop.requester.display_name != state.current_session.display_name
                || stop.pod_id != *pod_id
                || !matches!(
                    stop.state,
                    StudioStopRequestState::Denied
                        | StudioStopRequestState::Expired
                        | StudioStopRequestState::Cancelled
                )
                || stop.finalization_id.is_some()
                || stop.finalization_expires_at.is_some()
            {
                return Err(studio_response_mismatch());
            }
        }
    }
    Ok(())
}

fn studio_response_mismatch() -> NativeError {
    NativeError::new(
        "worker_response_mismatch",
        "The worker coordination response did not match the submitted request.",
    )
}

fn validate_create_batch(input: &CreateBatchInput) -> NativeResult<()> {
    if input.prompts.is_empty()
        || input.base_seed
            > (i64::MAX as u64).saturating_sub(input.prompts.len().saturating_sub(1) as u64)
    {
        return Err(NativeError::new(
            "batch_invalid",
            "A batch must contain at least one prompt and a valid base seed.",
        ));
    }
    if input
        .prompts
        .iter()
        .any(|prompt| prompt.trim().is_empty() || prompt.chars().any(|character| character == '\0'))
    {
        return Err(NativeError::new(
            "batch_invalid",
            "Each prompt must contain text and no embedded null character.",
        ));
    }
    if !matches!(
        input.aspect_ratio.as_str(),
        "16:9" | "1:1" | "9:16" | "4:3" | "3:4"
    ) {
        return Err(NativeError::new(
            "batch_invalid",
            "The selected aspect ratio is not supported.",
        ));
    }
    if input.references.len() > MAX_BATCH_REFERENCES
        || input
            .references
            .iter()
            .map(|reference| reference.bytes.len())
            .sum::<usize>()
            > MAX_REFERENCE_TOTAL_BYTES
        || input
            .references
            .iter()
            .any(|reference| !validate_reference(reference))
    {
        return Err(NativeError::new(
            "batch_reference_invalid",
            "Each image reference must be a supported, decodable image within the safe batch size.",
        ));
    }
    Ok(())
}

fn create_batch_payload(input: &CreateBatchInput) -> Value {
    let references = input
        .references
        .iter()
        .map(|reference| {
            json!({
                "name": reference.name,
                "mime_type": reference.mime_type,
                "data_hex": hex::encode(&reference.bytes),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "prompts": input.prompts,
        "base_seed": input.base_seed,
        "aspect_ratio": input.aspect_ratio,
        "references": references,
    })
}

fn validate_reference(reference: &ReferenceInput) -> bool {
    if reference.name.trim().is_empty()
        || reference.name.len() > 255
        || reference.name.contains('\0')
        || reference.name.contains('/')
        || reference.name.contains('\\')
        || reference.bytes.is_empty()
        || reference.bytes.len() > MAX_REFERENCE_BYTES
    {
        return false;
    }
    let expected_format = match reference.mime_type.as_str() {
        "image/jpeg" => ImageFormat::Jpeg,
        "image/png" => ImageFormat::Png,
        "image/webp" => ImageFormat::WebP,
        _ => return false,
    };
    if guess_format(&reference.bytes).ok() != Some(expected_format) {
        return false;
    }
    let Ok(image) = load_from_memory_with_format(&reference.bytes, expected_format) else {
        return false;
    };
    u64::from(image.width()) * u64::from(image.height()) <= MAX_REFERENCE_PIXELS
}

pub(crate) fn validate_index(index: u64) -> NativeResult<()> {
    if index == 0 {
        return Err(NativeError::new(
            "image_index_invalid",
            "Image indices must be positive.",
        ));
    }
    Ok(())
}

pub(crate) fn validate_checksum(value: &str) -> NativeResult<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(NativeError::new(
            "checksum_invalid",
            "The worker returned an invalid SHA-256 checksum.",
        ));
    }
    Ok(())
}

fn is_webp(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
}

fn validate_worker_envelope(status: StatusCode, body: &Value) -> NativeResult<()> {
    let schema = body.get("schema_version").and_then(Value::as_u64);
    if schema != Some(1) {
        return Err(NativeError::new(
            "worker_schema_mismatch",
            "The worker API version is incompatible with this ImageForge app.",
        ));
    }
    if !status.is_success()
        && body
            .get("error")
            .and_then(Value::as_object)
            .and_then(|error| error.get("code"))
            .and_then(Value::as_str)
            .is_none()
    {
        return Err(NativeError::new(
            "worker_response_invalid",
            "The worker returned an invalid error response.",
        ));
    }
    Ok(())
}

fn project_worker_success(operation: WorkerOperation, body: &Value) -> NativeResult<Value> {
    match operation {
        WorkerOperation::Health => project_health(body),
        WorkerOperation::Status => project_status(body),
        WorkerOperation::Manifest => project_manifest(body),
        WorkerOperation::Receipt => Ok(json!({"schema_version": 1})),
        WorkerOperation::StudioHeartbeat
        | WorkerOperation::StudioStatus
        | WorkerOperation::StudioCreateStopRequest
        | WorkerOperation::StudioStopResponse
        | WorkerOperation::StudioFinalizeStop
        | WorkerOperation::StudioCancelStop => project_studio_state(body),
    }
}

fn project_health(body: &Value) -> NativeResult<Value> {
    let mut projected = project_object(
        body,
        &[
            "schema_version",
            "service",
            "version",
            "phase",
            "phase_progress",
            "process",
            "model",
            "gpu",
        ],
    )?;
    project_nested(&mut projected, "process", &["status", "uptime_ms"])?;
    project_nested(
        &mut projected,
        "model",
        &["id", "revision", "precision", "status"],
    )?;
    project_nested(
        &mut projected,
        "gpu",
        &["state", "available", "approved", "device_count"],
    )?;
    Ok(Value::Object(projected))
}

fn project_status(body: &Value) -> NativeResult<Value> {
    let mut projected = project_object(
        body,
        &["schema_version", "ready", "active_batch", "permissions"],
    )?;
    project_nested(
        &mut projected,
        "permissions",
        &["can_create", "can_manage_active", "is_owner"],
    )?;
    if !projected.get("active_batch").is_some_and(Value::is_null) {
        let mut active = project_object(
            projected
                .get("active_batch")
                .ok_or_else(worker_response_invalid)?,
            &[
                "batch_id",
                "owner",
                "state",
                "progress",
                "pause_requested",
                "cancel_requested",
            ],
        )?;
        project_nested(&mut active, "owner", &["user_id", "display_name"])?;
        project_nested(
            &mut active,
            "progress",
            &[
                "total",
                "completed",
                "downloaded",
                "failed",
                "cancelled",
                "processed",
                "current_index",
            ],
        )?;
        projected.insert("active_batch".into(), Value::Object(active));
    }
    Ok(Value::Object(projected))
}

fn project_manifest(body: &Value) -> NativeResult<Value> {
    let mut projected = project_object(
        body,
        &[
            "schema_version",
            "batch_id",
            "owner",
            "state",
            "created_at",
            "updated_at",
            "completed_at",
            "interrupted_at",
            "pause_requested",
            "cancel_requested",
            "settings",
            "images",
            "progress",
        ],
    )?;
    project_nested(&mut projected, "owner", &["user_id", "display_name"])?;
    project_nested(
        &mut projected,
        "progress",
        &[
            "total",
            "completed",
            "downloaded",
            "failed",
            "cancelled",
            "processed",
            "current_index",
        ],
    )?;
    if let Some(settings) = body.get("settings") {
        let settings = project_object(settings, &["width", "height"])?;
        projected.insert("settings".into(), Value::Object(settings));
    }
    let images = projected
        .get("images")
        .and_then(Value::as_array)
        .ok_or_else(worker_response_invalid)?
        .iter()
        .map(project_image)
        .collect::<NativeResult<Vec<_>>>()?;
    projected.insert("images".into(), Value::Array(images));
    if let Some(references) = body.get("references") {
        let references = references
            .as_array()
            .ok_or_else(worker_response_invalid)?
            .iter()
            .map(project_reference)
            .collect::<NativeResult<Vec<_>>>()?;
        projected.insert("references".into(), Value::Array(references));
    }
    Ok(Value::Object(projected))
}

fn project_reference(value: &Value) -> NativeResult<Value> {
    Ok(Value::Object(project_object(
        value,
        &["name", "mime_type", "size_bytes", "sha256", "filename"],
    )?))
}

fn project_image(value: &Value) -> NativeResult<Value> {
    let mut image = project_object(
        value,
        &[
            "index",
            "prompt",
            "seed",
            "status",
            "attempts",
            "retry_rounds",
            "filename",
            "sha256",
            "size_bytes",
            "generation_ms",
            "error",
            "receipt",
        ],
    )?;
    project_optional_nested(&mut image, "error", &["code", "message"])?;
    project_optional_nested(
        &mut image,
        "receipt",
        &["sha256", "size_bytes", "acknowledged_at"],
    )?;
    Ok(Value::Object(image))
}

fn project_worker_error(body: &Value) -> NativeResult<Value> {
    let error = body
        .get("error")
        .and_then(Value::as_object)
        .ok_or_else(worker_response_invalid)?;
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 100)
        .ok_or_else(worker_response_invalid)?;
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 500)
        .ok_or_else(worker_response_invalid)?;
    Ok(json!({"error": {"code": code, "message": message, "details": null}}))
}

fn project_studio_error(status: StatusCode, body: &Value) -> NativeResult<Value> {
    require_exact_keys(body, &["schema_version", "error"])?;
    if body.get("schema_version").and_then(Value::as_u64) != Some(1) {
        return Err(worker_response_invalid());
    }
    let error_value = body.get("error").ok_or_else(worker_response_invalid)?;
    let error = error_value
        .as_object()
        .ok_or_else(worker_response_invalid)?;
    if error.len() < 2
        || error.len() > 3
        || !error.contains_key("code")
        || !error.contains_key("message")
        || error
            .keys()
            .any(|key| !matches!(key.as_str(), "code" | "message" | "details"))
    {
        return Err(worker_response_invalid());
    }
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 100
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        })
        .ok_or_else(worker_response_invalid)?;
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty() && value.len() <= 500 && !value.chars().any(char::is_control)
        })
        .ok_or_else(worker_response_invalid)?;
    let expected_status = match code {
        "authentication_required" => Some(StatusCode::UNAUTHORIZED),
        "studio_session_not_found" | "stop_request_not_found" => Some(StatusCode::NOT_FOUND),
        "stop_request_in_progress"
        | "stop_request_identity_mismatch"
        | "stop_response_conflict"
        | "stop_response_not_allowed"
        | "stop_request_not_approved"
        | "stop_approval_pending"
        | "finalization_mismatch" => Some(StatusCode::CONFLICT),
        "stop_blocked_by_active_batch" | "gpu_stop_pending" => Some(StatusCode::LOCKED),
        "validation_error" | "request_validation_failed" => Some(StatusCode::UNPROCESSABLE_ENTITY),
        "studio_session_limit" => Some(StatusCode::TOO_MANY_REQUESTS),
        _ => None,
    };
    if expected_status.is_some_and(|expected| expected != status) {
        return Err(worker_response_invalid());
    }
    let details = match code {
        "stop_blocked_by_active_batch" => {
            let details = error.get("details").ok_or_else(worker_response_invalid)?;
            require_exact_keys(details, &["owner", "completed", "total"])?;
            let owner = details
                .get("owner")
                .and_then(Value::as_str)
                .ok_or_else(worker_response_invalid)?;
            validate_studio_display_name(owner)?;
            let completed = details
                .get("completed")
                .and_then(Value::as_u64)
                .filter(|value| *value <= MAX_JSON_SAFE_INTEGER)
                .ok_or_else(worker_response_invalid)?;
            let total = details
                .get("total")
                .and_then(Value::as_u64)
                .filter(|value| (1..=MAX_JSON_SAFE_INTEGER).contains(value))
                .ok_or_else(worker_response_invalid)?;
            if completed > total {
                return Err(worker_response_invalid());
            }
            json!({"owner": owner, "completed": completed, "total": total})
        }
        "gpu_stop_pending" => {
            let details = error.get("details").ok_or_else(worker_response_invalid)?;
            require_exact_keys(details, &["request_id", "requester", "expires_at"])?;
            let request_id = details
                .get("request_id")
                .and_then(Value::as_str)
                .ok_or_else(worker_response_invalid)?;
            parse_studio_uuid(request_id, "worker_response_invalid")?;
            let requester = details
                .get("requester")
                .and_then(Value::as_str)
                .ok_or_else(worker_response_invalid)?;
            validate_studio_display_name(requester)?;
            let expires_at = details
                .get("expires_at")
                .and_then(Value::as_str)
                .ok_or_else(worker_response_invalid)?;
            validate_studio_timestamp(expires_at)?;
            json!({
                "request_id": request_id,
                "requester": requester,
                "expires_at": expires_at,
            })
        }
        "stop_request_in_progress" => {
            let details = error.get("details").ok_or_else(worker_response_invalid)?;
            require_exact_keys(details, &["request_id", "requester", "state"])?;
            let request_id = details
                .get("request_id")
                .and_then(Value::as_str)
                .ok_or_else(worker_response_invalid)?;
            parse_studio_uuid(request_id, "worker_response_invalid")?;
            let requester = details
                .get("requester")
                .and_then(Value::as_str)
                .ok_or_else(worker_response_invalid)?;
            validate_studio_display_name(requester)?;
            let state = details
                .get("state")
                .and_then(Value::as_str)
                .filter(|state| matches!(*state, "pending" | "approved" | "finalizing"))
                .ok_or_else(worker_response_invalid)?;
            json!({"request_id": request_id, "requester": requester, "state": state})
        }
        "stop_approval_pending" => {
            let details = error.get("details").ok_or_else(worker_response_invalid)?;
            require_exact_keys(details, &["waiting_for"])?;
            let waiting_for = details
                .get("waiting_for")
                .and_then(Value::as_array)
                .filter(|items| items.len() <= MAX_STUDIO_PARTICIPANTS)
                .ok_or_else(worker_response_invalid)?;
            let mut projected = Vec::with_capacity(waiting_for.len());
            for item in waiting_for {
                let display_name = item.as_str().ok_or_else(worker_response_invalid)?;
                validate_studio_display_name(display_name)?;
                projected.push(display_name);
            }
            json!({"waiting_for": projected})
        }
        "stop_request_not_approved" => {
            let details = error.get("details").ok_or_else(worker_response_invalid)?;
            require_exact_keys(details, &["state"])?;
            let state = details
                .get("state")
                .and_then(Value::as_str)
                .filter(|state| {
                    matches!(
                        *state,
                        "pending" | "approved" | "denied" | "expired" | "cancelled" | "finalizing"
                    )
                })
                .ok_or_else(worker_response_invalid)?;
            json!({"state": state})
        }
        _ => Value::Null,
    };
    Ok(json!({
        "error": {"code": code, "message": message, "details": details},
    }))
}

fn project_object(value: &Value, keys: &[&str]) -> NativeResult<serde_json::Map<String, Value>> {
    let source = value.as_object().ok_or_else(worker_response_invalid)?;
    keys.iter()
        .map(|key| {
            source
                .get(*key)
                .cloned()
                .map(|value| ((*key).to_owned(), value))
                .ok_or_else(worker_response_invalid)
        })
        .collect()
}

fn project_nested(
    object: &mut serde_json::Map<String, Value>,
    key: &str,
    keys: &[&str],
) -> NativeResult<()> {
    let nested = project_object(object.get(key).ok_or_else(worker_response_invalid)?, keys)?;
    object.insert(key.to_owned(), Value::Object(nested));
    Ok(())
}

fn project_optional_nested(
    object: &mut serde_json::Map<String, Value>,
    key: &str,
    keys: &[&str],
) -> NativeResult<()> {
    if !object.get(key).is_some_and(Value::is_null) {
        project_nested(object, key, keys)?;
    }
    Ok(())
}

fn reject_secret_reflection(
    value: &Value,
    worker_token: Option<&str>,
    runpod_key: Option<&str>,
) -> NativeResult<()> {
    let reflected = match value {
        Value::String(candidate) => [worker_token, runpod_key]
            .into_iter()
            .flatten()
            .any(|secret| !secret.is_empty() && candidate.contains(secret)),
        Value::Array(items) => items
            .iter()
            .any(|item| reject_secret_reflection(item, worker_token, runpod_key).is_err()),
        Value::Object(items) => items
            .values()
            .any(|item| reject_secret_reflection(item, worker_token, runpod_key).is_err()),
        _ => false,
    };
    if reflected {
        Err(NativeError::new(
            "worker_secret_reflection",
            "The worker response was rejected because it exposed saved credential material.",
        ))
    } else {
        Ok(())
    }
}

fn worker_response_invalid() -> NativeError {
    NativeError::new(
        "worker_response_invalid",
        "The ImageForge worker returned an invalid response shape.",
    )
}

fn worker_transport_error(failure: WorkerTransportFailure) -> NativeError {
    match failure {
        WorkerTransportFailure::Timeout => {
            NativeError::retryable("worker_timeout", "The ImageForge worker request timed out.")
        }
        WorkerTransportFailure::Request => NativeError::retryable(
            "worker_network_error",
            "The ImageForge worker could not be reached.",
        ),
        WorkerTransportFailure::Response => NativeError::retryable(
            "worker_network_error",
            "The worker response was interrupted.",
        ),
    }
}

fn map_worker_request_error(error: reqwest::Error) -> NativeError {
    if error.is_timeout() {
        worker_transport_error(WorkerTransportFailure::Timeout)
    } else {
        worker_transport_error(WorkerTransportFailure::Request)
    }
}

fn ensure_response_size(
    content_length: Option<u64>,
    bytes_read: usize,
    next_chunk: usize,
    limit: usize,
) -> NativeResult<()> {
    if content_length.is_some_and(|length| length > limit as u64)
        || bytes_read.saturating_add(next_chunk) > limit
    {
        return Err(NativeError::new(
            "worker_response_too_large",
            "The worker returned an unexpectedly large response.",
        ));
    }
    Ok(())
}

async fn read_bounded(response: reqwest::Response, limit: usize) -> NativeResult<Vec<u8>> {
    ensure_response_size(response.content_length(), 0, 0, limit)?;
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| worker_transport_error(WorkerTransportFailure::Response))?;
        ensure_response_size(None, bytes.len(), chunk.len(), limit)?;
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn studio_state_fixture() -> Value {
        json!({
            "schema_version": 1,
            "server_instance_id": "11111111-1111-4111-8111-111111111111",
            "coordination_revision": 7,
            "server_time": "2026-08-03T10:20:30.123Z",
            "presence_ttl_seconds": 15,
            "response_ttl_seconds": 30,
            "finalization_ttl_seconds": 15,
            "current_session": {
                "session_id": "22222222-2222-4222-8222-222222222222",
                "display_name": "Lakshman",
                "availability": "foreground",
                "expires_at": "2026-08-03T10:20:45.123Z"
            },
            "sessions": [
                {
                    "session_id": "22222222-2222-4222-8222-222222222222",
                    "display_name": "Lakshman",
                    "availability": "foreground",
                    "expires_at": "2026-08-03T10:20:45.123Z"
                },
                {
                    "session_id": "33333333-3333-4333-8333-333333333333",
                    "display_name": "Sujal",
                    "availability": "foreground",
                    "expires_at": "2026-08-03T10:20:45.123Z"
                }
            ],
            "active_batch": null,
            "stop_request": {
                "request_id": "55555555-5555-4555-8555-555555555555",
                "pod_id": "shared-pod-1",
                "gpu_display_name": "RTX 4090",
                "requester": {
                    "session_id": "22222222-2222-4222-8222-222222222222",
                    "display_name": "Lakshman"
                },
                "state": "pending",
                "reason": null,
                "requested_at": "2026-08-03T10:20:30.123Z",
                "response_deadline": "2026-08-03T10:21:00.123Z",
                "finalization_expires_at": null,
                "waiting_for": [{
                    "session_id": "33333333-3333-4333-8333-333333333333",
                    "display_name": "Sujal"
                }],
                "approved_by": [],
                "denied_by": [],
                "finalization_id": null
            }
        })
    }

    fn uuid4(value: &str) -> Uuid {
        parse_studio_uuid(value, "test_uuid_invalid").unwrap()
    }

    fn bind_fixture(
        fixture: Value,
        binding: StudioResponseBinding,
    ) -> NativeResult<WorkerHttpResponse> {
        let body = project_studio_state(&fixture)?;
        bind_studio_response(WorkerHttpResponse { status: 200, body }, binding)
    }

    fn assert_binding_mismatch(fixture: Value, binding: StudioResponseBinding) {
        assert_eq!(
            bind_fixture(fixture, binding).unwrap_err().code,
            "worker_response_mismatch"
        );
    }

    fn assert_studio_plan(
        plan: &StudioRequestPlan,
        method: Method,
        path: &str,
        body: Option<Value>,
        operation: WorkerOperation,
        expected_pod_id: Option<&str>,
    ) {
        assert_eq!(plan.method, method);
        assert_eq!(plan.path, path);
        assert_eq!(plan.body, body);
        assert!(plan.authenticated);
        assert_eq!(plan.operation, operation);
        assert_eq!(plan.expected_pod_id.as_deref(), expected_pod_id);
        assert!(plan.path.starts_with("/v1/studio/"));
        assert!(!plan.path.contains("://"));
        assert!(!plan.path.contains('?'));
        assert!(!plan.path.contains('#'));
    }

    #[test]
    fn batch_validation_rejects_only_malformed_prompt_input_without_logging_content() {
        assert!(validate_create_batch(&CreateBatchInput {
            prompts: vec!["A realistic editorial photograph".into()],
            base_seed: 42,
            references: vec![],
            aspect_ratio: "16:9".into(),
        })
        .is_ok());
        let long_prompt = format!("DO-NOT-ECHO-THIS-{}", "x".repeat(5_000));
        assert!(validate_create_batch(&CreateBatchInput {
            prompts: vec![long_prompt],
            base_seed: 0,
            references: vec![],
            aspect_ratio: "16:9".into(),
        })
        .is_ok());
        for prompts in [vec![], vec![" ".into()], vec!["contains\0null".into()]] {
            let error = validate_create_batch(&CreateBatchInput {
                prompts,
                base_seed: 0,
                references: vec![],
                aspect_ratio: "16:9".into(),
            })
            .unwrap_err();
            assert_eq!(error.code, "batch_invalid");
        }
    }

    #[test]
    fn checksum_and_index_contracts_are_exact() {
        assert!(validate_index(1).is_ok());
        assert!(validate_index(500).is_ok());
        assert!(validate_index(501).is_ok());
        assert!(validate_index(0).is_err());
        assert!(validate_checksum(&"a".repeat(64)).is_ok());
        assert!(validate_checksum(&"A".repeat(64)).is_err());
        assert!(validate_checksum("../../file").is_err());
    }

    #[test]
    fn preview_bytes_require_webp_container_and_are_bounded() {
        assert!(is_webp(b"RIFF0000WEBP"));
        assert!(!is_webp(b"RIFF0000JPEG"));
        assert!(!is_webp(b"WEBP"));
        assert!(MAX_PREVIEW_BYTES < MAX_JSON_RESPONSE_BYTES);
    }

    #[test]
    fn reference_validation_requires_supported_decodable_headers_and_safe_names() {
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            1,
            1,
            image::Rgba([0, 0, 0, 0]),
        ))
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
        assert!(validate_reference(&ReferenceInput {
            name: "anchor.png".into(),
            mime_type: "image/png".into(),
            bytes: png.clone()
        }));
        assert!(!validate_reference(&ReferenceInput {
            name: "anchor.svg".into(),
            mime_type: "image/svg+xml".into(),
            bytes: b"<svg/>".to_vec()
        }));
        assert!(!validate_reference(&ReferenceInput {
            name: "../secret.png".into(),
            mime_type: "image/png".into(),
            bytes: vec![1; 24]
        }));
        assert!(!validate_reference(&ReferenceInput {
            name: "empty.png".into(),
            mime_type: "image/png".into(),
            bytes: vec![]
        }));
        let mut truncated = png;
        truncated.truncate(24);
        assert!(!validate_reference(&ReferenceInput {
            name: "truncated.png".into(),
            mime_type: "image/png".into(),
            bytes: truncated,
        }));
    }

    #[test]
    fn native_batch_payload_uses_worker_reference_contract_without_paths_or_secrets() {
        let payload = create_batch_payload(&CreateBatchInput {
            prompts: vec!["guided frame".into()],
            base_seed: 17,
            references: vec![ReferenceInput {
                name: "anchor.png".into(),
                mime_type: "image/png".into(),
                bytes: vec![0x89, 0x50, 0x4e, 0x47],
            }],
            aspect_ratio: "1:1".into(),
        });
        assert_eq!(payload["prompts"][0], "guided frame");
        assert_eq!(payload["base_seed"], 17);
        assert_eq!(payload["aspect_ratio"], "1:1");
        assert_eq!(payload["references"][0]["name"], "anchor.png");
        assert_eq!(payload["references"][0]["mime_type"], "image/png");
        assert_eq!(payload["references"][0]["data_hex"], "89504e47");
        assert!(payload["references"][0].get("bytes").is_none());
    }

    #[test]
    fn native_http_fixtures_project_only_reviewed_worker_contracts() {
        let health = json!({
            "schema_version": 1, "service": "imageforge", "version": "1.0.0",
            "phase": "ready", "phase_progress": 100,
            "process": {"status": "running", "uptime_ms": 1000, "pid": 42},
            "model": {"id": "flux", "revision": "pinned", "precision": "bf16", "status": "ready", "path": "/secret/model"},
            "gpu": {"state": "ready", "available": true, "approved": true, "device_count": 1, "serial": "hidden"},
            "env": {"WORKER_TOKEN": "hidden"}
        });
        let projected = project_worker_success(WorkerOperation::Health, &health).unwrap();
        assert_eq!(
            projected
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            [
                "gpu",
                "model",
                "phase",
                "phase_progress",
                "process",
                "schema_version",
                "service",
                "version"
            ]
        );
        assert!(projected["model"].get("path").is_none());
        assert!(projected.get("env").is_none());

        let manifest = json!({
            "schema_version": 1,
            "batch_id": "00000000-0000-4000-8000-000000000001",
            "owner": {"user_id": "owner", "display_name": "Owner", "token": "hidden"},
            "state": "complete", "created_at": "2026-08-01T00:00:00Z", "updated_at": "2026-08-01T00:01:00Z",
            "completed_at": "2026-08-01T00:01:00Z", "interrupted_at": null,
            "pause_requested": false, "cancel_requested": false,
            "settings": {"width": 720, "height": 1280},
            "images": [{
                "index": 1, "prompt": "safe prompt", "seed": 1, "status": "downloaded", "attempts": 1,
                "retry_rounds": 0, "filename": "000001.jpg", "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "size_bytes": 1024, "generation_ms": 1000, "error": null,
                "receipt": {"sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "size_bytes": 1024,
                    "acknowledged_at": "2026-08-01T00:01:00Z", "user_id": "must-not-cross"},
                "preview_path": "/workspace/previews/1.webp", "attempt_history": [{"raw_error": "hidden"}]
            }],
            "progress": {"total": 1, "completed": 1, "downloaded": 1, "failed": 0, "cancelled": 0, "processed": 1, "current_index": null},
            "cleanup_tombstones": ["hidden"]
        });
        let projected = project_worker_success(WorkerOperation::Manifest, &manifest).unwrap();
        let image = &projected["images"][0];
        assert!(image.get("preview_path").is_none());
        assert!(image.get("attempt_history").is_none());
        assert!(image["receipt"].get("user_id").is_none());
        assert_eq!(projected["settings"], json!({"width": 720, "height": 1280}));
        assert!(projected.get("cleanup_tombstones").is_none());
    }

    #[test]
    fn worker_errors_are_sanitized_and_saved_secret_reflection_is_rejected() {
        let error = json!({
            "schema_version": 1,
            "error": {"code": "batch_busy", "message": "Another batch is active.", "details": {"owner": "Owner"}, "traceback": "raw"}
        });
        validate_worker_envelope(StatusCode::LOCKED, &error).unwrap();
        assert_eq!(
            project_worker_error(&error).unwrap(),
            json!({"error": {"code": "batch_busy", "message": "Another batch is active.", "details": null}})
        );
        let secret = "worker-secret-exact";
        assert_eq!(
            reject_secret_reflection(&json!({"nested": [secret]}), Some(secret), None)
                .unwrap_err()
                .code,
            "worker_secret_reflection"
        );
        assert_eq!(
            reject_secret_reflection(
                &json!({"message": format!("Bearer {secret} leaked")}),
                Some(secret),
                None,
            )
            .unwrap_err()
            .code,
            "worker_secret_reflection"
        );
    }

    #[test]
    fn studio_identifiers_routes_and_gpu_names_are_narrow() {
        let session_id = parse_studio_uuid(
            "22222222-2222-4222-8222-222222222222",
            "studio_session_id_invalid",
        )
        .unwrap();
        let request_id = parse_studio_uuid(
            "55555555-5555-4555-8555-555555555555",
            "stop_request_id_invalid",
        )
        .unwrap();
        assert_eq!(
            studio_session_path(session_id),
            "/v1/studio/sessions/22222222-2222-4222-8222-222222222222"
        );
        assert_eq!(
            studio_stop_action_path(request_id, StudioStopRoute::Responses),
            "/v1/studio/stop-requests/55555555-5555-4555-8555-555555555555/responses"
        );
        assert_eq!(
            studio_stop_action_path(request_id, StudioStopRoute::Finalize),
            "/v1/studio/stop-requests/55555555-5555-4555-8555-555555555555/finalize"
        );
        assert_eq!(
            studio_stop_action_path(request_id, StudioStopRoute::Cancel),
            "/v1/studio/stop-requests/55555555-5555-4555-8555-555555555555/cancel"
        );
        for invalid in [
            "22222222-2222-4222-8222-22222222222A",
            "22222222222242228222222222222222",
            "22222222-2222-1222-8222-222222222222",
            "../sessions/peer",
        ] {
            assert!(parse_studio_uuid(invalid, "studio_session_id_invalid").is_err());
        }
        for accepted in ["RTX 4090", "RTX 2000 Ada", "NVIDIA_RTX-4090 (24GB)"] {
            assert!(validate_gpu_display_name(accepted).is_ok());
        }
        for rejected in ["", " RTX 4090", "RTX/4090", "RTX\n4090", "🔥"] {
            assert!(validate_gpu_display_name(rejected).is_err());
        }
        assert_eq!(
            WorkerOperation::StudioHeartbeat.studio_success_status(),
            Some(StatusCode::OK)
        );
        assert_eq!(
            WorkerOperation::StudioCreateStopRequest.studio_success_status(),
            Some(StatusCode::CREATED)
        );
        assert_eq!(
            WorkerOperation::StudioStatus.response_limit(),
            MAX_STUDIO_RESPONSE_BYTES
        );
    }

    #[test]
    fn all_six_studio_transport_plans_have_exact_method_path_auth_and_body() {
        let session_id = uuid4("22222222-2222-4222-8222-222222222222");
        let request_id = uuid4("55555555-5555-4555-8555-555555555555");
        let finalization_id = uuid4("66666666-6666-4666-8666-666666666666");

        let heartbeat = studio_heartbeat_plan(session_id, StudioAvailability::Foreground);
        assert_studio_plan(
            &heartbeat,
            Method::PUT,
            "/v1/studio/sessions/22222222-2222-4222-8222-222222222222",
            Some(json!({"availability": "foreground"})),
            WorkerOperation::StudioHeartbeat,
            None,
        );

        let status = studio_status_plan(session_id);
        assert_studio_plan(
            &status,
            Method::GET,
            "/v1/studio/sessions/22222222-2222-4222-8222-222222222222",
            None,
            WorkerOperation::StudioStatus,
            None,
        );

        let create = studio_create_stop_plan(
            request_id,
            session_id,
            "shared-pod-1".into(),
            "RTX 4090".into(),
        );
        assert_studio_plan(
            &create,
            Method::POST,
            "/v1/studio/stop-requests",
            Some(json!({
                "request_id": request_id,
                "session_id": session_id,
                "pod_id": "shared-pod-1",
                "gpu_display_name": "RTX 4090",
            })),
            WorkerOperation::StudioCreateStopRequest,
            Some("shared-pod-1"),
        );

        let respond =
            studio_stop_response_plan(request_id, session_id, StudioStopDecision::Approve);
        assert_studio_plan(
            &respond,
            Method::POST,
            "/v1/studio/stop-requests/55555555-5555-4555-8555-555555555555/responses",
            Some(json!({"session_id": session_id, "decision": "approve"})),
            WorkerOperation::StudioStopResponse,
            None,
        );

        let finalize = studio_finalize_stop_plan(
            request_id,
            session_id,
            "shared-pod-1".into(),
            finalization_id,
        );
        assert_studio_plan(
            &finalize,
            Method::POST,
            "/v1/studio/stop-requests/55555555-5555-4555-8555-555555555555/finalize",
            Some(json!({
                "session_id": session_id,
                "finalization_id": finalization_id,
            })),
            WorkerOperation::StudioFinalizeStop,
            Some("shared-pod-1"),
        );
        assert!(finalize
            .body
            .as_ref()
            .is_some_and(|body| body.get("pod_id").is_none()));

        let cancel = studio_cancel_stop_plan(
            request_id,
            session_id,
            "shared-pod-1".into(),
            Some(finalization_id),
        );
        assert_studio_plan(
            &cancel,
            Method::POST,
            "/v1/studio/stop-requests/55555555-5555-4555-8555-555555555555/cancel",
            Some(json!({
                "session_id": session_id,
                "finalization_id": finalization_id,
            })),
            WorkerOperation::StudioCancelStop,
            Some("shared-pod-1"),
        );
        assert!(cancel
            .body
            .as_ref()
            .is_some_and(|body| body.get("pod_id").is_none()));
    }

    #[test]
    fn studio_transport_limits_and_failures_map_to_small_typed_errors() {
        assert_eq!(WORKER_CONNECT_TIMEOUT, Duration::from_secs(10));
        assert_eq!(WORKER_REQUEST_TIMEOUT, Duration::from_secs(45));
        assert_eq!(
            ensure_response_size(
                Some((MAX_STUDIO_RESPONSE_BYTES + 1) as u64),
                0,
                0,
                MAX_STUDIO_RESPONSE_BYTES
            )
            .unwrap_err()
            .code,
            "worker_response_too_large"
        );
        assert_eq!(
            ensure_response_size(
                None,
                MAX_STUDIO_RESPONSE_BYTES,
                1,
                MAX_STUDIO_RESPONSE_BYTES
            )
            .unwrap_err()
            .code,
            "worker_response_too_large"
        );
        assert!(ensure_response_size(
            Some(MAX_STUDIO_RESPONSE_BYTES as u64),
            MAX_STUDIO_RESPONSE_BYTES - 1,
            1,
            MAX_STUDIO_RESPONSE_BYTES,
        )
        .is_ok());

        for (failure, code) in [
            (WorkerTransportFailure::Timeout, "worker_timeout"),
            (WorkerTransportFailure::Request, "worker_network_error"),
            (WorkerTransportFailure::Response, "worker_network_error"),
        ] {
            let error = worker_transport_error(failure);
            assert_eq!(error.code, code);
            assert!(error.retryable);
            assert!(!error.message.contains("http"));
            assert!(!error.message.contains("Bearer"));
        }
    }

    #[test]
    fn stop_request_pod_must_match_the_pinned_worker_session() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let session = WorkerSession::default();
        runtime
            .block_on(session.bind_verified("shared-pod-1"))
            .unwrap();
        let pin = runtime.block_on(session.pin()).unwrap();
        assert!(ensure_pin_matches_pod(&pin, "shared-pod-1").is_ok());
        assert_eq!(
            ensure_pin_matches_pod(&pin, "replacement-pod")
                .unwrap_err()
                .code,
            "worker_session_changed"
        );
    }

    #[test]
    fn exact_pod_pin_blocks_rebind_until_the_coordination_request_finishes() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let session = WorkerSession::default();
            session.bind_verified("shared-pod-1").await.unwrap();
            let pin = session.pin().await.unwrap();

            let replacement_session = session.clone();
            let replacement = tokio::spawn(async move {
                replacement_session
                    .bind_verified("replacement-pod")
                    .await
                    .unwrap();
            });
            tokio::task::yield_now().await;
            assert!(!replacement.is_finished());
            assert!(ensure_pin_matches_pod(&pin, "shared-pod-1").is_ok());
            assert_eq!(
                ensure_pin_matches_pod(&pin, "replacement-pod")
                    .unwrap_err()
                    .code,
                "worker_session_changed"
            );

            drop(pin);
            replacement.await.unwrap();
            let replacement_pin = session.pin().await.unwrap();
            assert!(ensure_pin_matches_pod(&replacement_pin, "replacement-pod").is_ok());
            assert_eq!(
                ensure_pin_matches_pod(&replacement_pin, "shared-pod-1")
                    .unwrap_err()
                    .code,
                "worker_session_changed"
            );
        });
    }

    #[test]
    fn studio_state_projection_is_exact_bounded_and_typed() {
        let fixture = studio_state_fixture();
        let projected = project_worker_success(WorkerOperation::StudioStatus, &fixture).unwrap();
        assert_eq!(projected, fixture);

        let mut extra = fixture.clone();
        extra["current_session"]["credential"] = json!("must-not-cross");
        assert_eq!(
            project_studio_state(&extra).unwrap_err().code,
            "worker_response_invalid"
        );

        let mut stale_uuid = fixture.clone();
        stale_uuid["server_instance_id"] = json!("11111111-1111-1111-8111-111111111111");
        assert_eq!(
            project_studio_state(&stale_uuid).unwrap_err().code,
            "worker_response_invalid"
        );

        let mut excessive_ttl = fixture;
        excessive_ttl["presence_ttl_seconds"] = json!(301);
        assert_eq!(
            project_studio_state(&excessive_ttl).unwrap_err().code,
            "worker_response_invalid"
        );
    }

    #[test]
    fn finalization_grant_is_exact_requester_only_and_state_fields_are_coherent() {
        let mut finalizing = studio_state_fixture();
        finalizing["stop_request"]["state"] = json!("finalizing");
        finalizing["stop_request"]["waiting_for"] = json!([]);
        finalizing["stop_request"]["approved_by"] = json!([{
            "session_id": "33333333-3333-4333-8333-333333333333",
            "display_name": "Sujal"
        }]);
        finalizing["stop_request"]["finalization_expires_at"] = json!("2026-08-03T10:20:45.123Z");
        finalizing["stop_request"]["finalization_id"] =
            json!("66666666-6666-4666-8666-666666666666");

        let requester_view = project_studio_state(&finalizing).unwrap();
        assert_eq!(
            requester_view["stop_request"]["finalization_id"],
            "66666666-6666-4666-8666-666666666666"
        );

        let mut leaked_peer_view = finalizing.clone();
        leaked_peer_view["current_session"] = leaked_peer_view["sessions"][1].clone();
        let redacted = project_studio_state(&leaked_peer_view).unwrap();
        assert!(redacted["stop_request"]["finalization_id"].is_null());

        let mut malformed_leak = leaked_peer_view;
        malformed_leak["stop_request"]["finalization_id"] = json!("not-a-grant");
        assert_eq!(
            project_studio_state(&malformed_leak).unwrap_err().code,
            "worker_response_invalid"
        );

        let mut requester_missing_grant = finalizing.clone();
        requester_missing_grant["stop_request"]["finalization_id"] = Value::Null;
        assert_eq!(
            project_studio_state(&requester_missing_grant)
                .unwrap_err()
                .code,
            "worker_response_invalid"
        );

        let mut requester_missing_expiry = finalizing;
        requester_missing_expiry["stop_request"]["finalization_expires_at"] = Value::Null;
        assert_eq!(
            project_studio_state(&requester_missing_expiry)
                .unwrap_err()
                .code,
            "worker_response_invalid"
        );

        for (state, reason, finalization_expires_at, finalization_id) in [
            ("pending", json!("peer_denied"), Value::Null, Value::Null),
            (
                "approved",
                Value::Null,
                json!("2026-08-03T10:20:45.123Z"),
                Value::Null,
            ),
            (
                "cancelled",
                json!("response_timeout"),
                Value::Null,
                Value::Null,
            ),
            (
                "expired",
                json!("requester_cancelled"),
                Value::Null,
                Value::Null,
            ),
            (
                "pending",
                Value::Null,
                Value::Null,
                json!("66666666-6666-4666-8666-666666666666"),
            ),
        ] {
            let mut invalid = studio_state_fixture();
            invalid["stop_request"]["state"] = json!(state);
            invalid["stop_request"]["reason"] = reason;
            invalid["stop_request"]["finalization_expires_at"] = finalization_expires_at;
            invalid["stop_request"]["finalization_id"] = finalization_id;
            assert_eq!(
                project_studio_state(&invalid).unwrap_err().code,
                "worker_response_invalid",
                "state {state} must reject incoherent finalization/reason fields"
            );
        }
    }

    #[test]
    fn studio_timestamps_require_real_utc_millisecond_calendar_values() {
        for valid in [
            "2000-02-29T00:00:00.000Z",
            "2024-02-29T23:59:59.999Z",
            "2026-04-30T12:30:45.123Z",
            "9999-12-31T23:59:59.999Z",
        ] {
            assert!(validate_studio_timestamp(valid).is_ok(), "{valid}");
        }
        for invalid in [
            "0000-01-01T00:00:00.000Z",
            "1900-02-29T00:00:00.000Z",
            "2026-00-01T00:00:00.000Z",
            "2026-13-01T00:00:00.000Z",
            "2026-01-00T00:00:00.000Z",
            "2026-02-29T00:00:00.000Z",
            "2026-02-31T00:00:00.000Z",
            "2026-04-31T00:00:00.000Z",
            "2026-12-01T24:00:00.000Z",
            "2026-12-01T23:60:00.000Z",
            "2026-12-01T23:59:60.000Z",
            "2026-12-01T23:59:59Z",
            "2026-12-01T23:59:59.000+00:00",
        ] {
            assert!(validate_studio_timestamp(invalid).is_err(), "{invalid}");
        }

        let mut invalid_state = studio_state_fixture();
        invalid_state["server_time"] = json!("2026-02-31T10:20:30.123Z");
        assert_eq!(
            project_studio_state(&invalid_state).unwrap_err().code,
            "worker_response_invalid"
        );
    }

    #[test]
    fn every_studio_operation_rejects_a_valid_envelope_for_another_session() {
        let expected_session = uuid4("22222222-2222-4222-8222-222222222222");
        let request_id = uuid4("55555555-5555-4555-8555-555555555555");
        let finalization_id = uuid4("66666666-6666-4666-8666-666666666666");
        let bindings = [
            StudioResponseBinding::Heartbeat {
                session_id: expected_session,
                availability: StudioAvailability::Foreground,
            },
            StudioResponseBinding::Status {
                session_id: expected_session,
            },
            StudioResponseBinding::CreateStop {
                request_id,
                session_id: expected_session,
                pod_id: "shared-pod-1".into(),
                gpu_display_name: "RTX 4090".into(),
            },
            StudioResponseBinding::RespondToStop {
                request_id,
                session_id: expected_session,
            },
            StudioResponseBinding::FinalizeStop {
                request_id,
                session_id: expected_session,
                pod_id: "shared-pod-1".into(),
                finalization_id,
            },
            StudioResponseBinding::CancelStop {
                request_id,
                session_id: expected_session,
                pod_id: "shared-pod-1".into(),
            },
        ];
        for binding in bindings {
            let mut misrouted = studio_state_fixture();
            misrouted["current_session"] = misrouted["sessions"][1].clone();
            assert_binding_mismatch(misrouted, binding);
        }

        assert_binding_mismatch(
            studio_state_fixture(),
            StudioResponseBinding::Heartbeat {
                session_id: expected_session,
                availability: StudioAvailability::Background,
            },
        );
    }

    #[test]
    fn stop_operation_responses_are_bound_to_the_submitted_request() {
        let session_id = uuid4("22222222-2222-4222-8222-222222222222");
        let request_id = uuid4("55555555-5555-4555-8555-555555555555");
        let finalization_id = uuid4("66666666-6666-4666-8666-666666666666");

        let create = StudioResponseBinding::CreateStop {
            request_id,
            session_id,
            pod_id: "shared-pod-1".into(),
            gpu_display_name: "RTX 4090".into(),
        };
        assert!(bind_fixture(studio_state_fixture(), create.clone()).is_ok());
        for (field, value) in [
            ("request_id", json!("77777777-7777-4777-8777-777777777777")),
            ("pod_id", json!("replacement-pod")),
            ("gpu_display_name", json!("RTX 5090")),
        ] {
            let mut mismatch = studio_state_fixture();
            mismatch["stop_request"][field] = value;
            assert_binding_mismatch(mismatch, create.clone());
        }
        let mut wrong_requester = studio_state_fixture();
        wrong_requester["stop_request"]["requester"] = json!({
            "session_id": "44444444-4444-4444-8444-444444444444",
            "display_name": "Another requester"
        });
        assert_binding_mismatch(wrong_requester, create);

        let respond = StudioResponseBinding::RespondToStop {
            request_id,
            session_id,
        };
        assert!(bind_fixture(studio_state_fixture(), respond.clone()).is_ok());
        let mut wrong_response_request = studio_state_fixture();
        wrong_response_request["stop_request"]["request_id"] =
            json!("77777777-7777-4777-8777-777777777777");
        assert_binding_mismatch(wrong_response_request, respond);

        let mut finalizing = studio_state_fixture();
        finalizing["stop_request"]["state"] = json!("finalizing");
        finalizing["stop_request"]["waiting_for"] = json!([]);
        finalizing["stop_request"]["approved_by"] = json!([{
            "session_id": "33333333-3333-4333-8333-333333333333",
            "display_name": "Sujal"
        }]);
        finalizing["stop_request"]["finalization_expires_at"] = json!("2026-08-03T10:20:45.123Z");
        finalizing["stop_request"]["finalization_id"] =
            json!("66666666-6666-4666-8666-666666666666");
        let finalize = StudioResponseBinding::FinalizeStop {
            request_id,
            session_id,
            pod_id: "shared-pod-1".into(),
            finalization_id,
        };
        assert!(bind_fixture(finalizing.clone(), finalize.clone()).is_ok());
        assert_binding_mismatch(studio_state_fixture(), finalize.clone());
        let mut wrong_finalize_pod = finalizing.clone();
        wrong_finalize_pod["stop_request"]["pod_id"] = json!("replacement-pod");
        assert_binding_mismatch(wrong_finalize_pod, finalize.clone());
        finalizing["stop_request"]["finalization_id"] =
            json!("77777777-7777-4777-8777-777777777777");
        assert_binding_mismatch(finalizing, finalize);

        let mut cancelled = studio_state_fixture();
        cancelled["stop_request"]["state"] = json!("cancelled");
        cancelled["stop_request"]["reason"] = json!("requester_cancelled");
        let cancel = StudioResponseBinding::CancelStop {
            request_id,
            session_id,
            pod_id: "shared-pod-1".into(),
        };
        assert_binding_mismatch(studio_state_fixture(), cancel.clone());
        assert!(bind_fixture(cancelled.clone(), cancel.clone()).is_ok());
        let mut wrong_cancel_pod = cancelled.clone();
        wrong_cancel_pod["stop_request"]["pod_id"] = json!("replacement-pod");
        assert_binding_mismatch(wrong_cancel_pod, cancel.clone());
        cancelled["stop_request"]["request_id"] = json!("77777777-7777-4777-8777-777777777777");
        assert_binding_mismatch(cancelled, cancel);
    }

    #[test]
    fn studio_error_projection_preserves_only_safe_coordination_details() {
        let blocked = json!({
            "schema_version": 1,
            "error": {
                "code": "stop_blocked_by_active_batch",
                "message": "Finish or cancel the active batch before stopping the GPU.",
                "details": {"owner": "Sujal", "completed": 120, "total": 450}
            }
        });
        assert_eq!(
            project_studio_error(StatusCode::LOCKED, &blocked).unwrap(),
            json!({"error": blocked["error"]})
        );
        assert_eq!(
            project_studio_error(StatusCode::CONFLICT, &blocked)
                .unwrap_err()
                .code,
            "worker_response_invalid"
        );

        let general = json!({
            "schema_version": 1,
            "error": {
                "code": "internal_error",
                "message": "The worker could not complete the request.",
                "details": {"error_id": "safe-diagnostic", "path": "/workspace/private"}
            }
        });
        assert_eq!(
            project_studio_error(StatusCode::INTERNAL_SERVER_ERROR, &general).unwrap(),
            json!({
                "error": {
                    "code": "internal_error",
                    "message": "The worker could not complete the request.",
                    "details": null
                }
            })
        );

        let pending = json!({
            "schema_version": 1,
            "error": {
                "code": "gpu_stop_pending",
                "message": "A finalized GPU stop is pending.",
                "details": {
                    "request_id": "55555555-5555-4555-8555-555555555555",
                    "requester": "Lakshman",
                    "expires_at": "2026-08-03T10:20:45.123Z"
                }
            }
        });
        assert_eq!(
            project_studio_error(StatusCode::LOCKED, &pending).unwrap(),
            json!({"error": pending["error"]})
        );

        let approval_pending = json!({
            "schema_version": 1,
            "error": {
                "code": "stop_approval_pending",
                "message": "Every foreground editor must approve.",
                "details": {"waiting_for": ["Sujal"]}
            }
        });
        assert_eq!(
            project_studio_error(StatusCode::CONFLICT, &approval_pending).unwrap(),
            json!({"error": approval_pending["error"]})
        );
    }
}
