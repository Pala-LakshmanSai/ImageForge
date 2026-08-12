use super::session::{validate_pod_id, WorkerSessionPin};
use super::{CredentialKind, CredentialVault, NativeError, NativeResult, WorkerSession};
use futures_util::StreamExt;
use image::{guess_format, load_from_memory_with_format, ImageFormat};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

const MAX_JSON_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PREVIEW_BYTES: usize = 4 * 1024 * 1024;
const _: () = assert!(MAX_PREVIEW_BYTES < MAX_JSON_RESPONSE_BYTES);
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
const IMAGEFORGE_WORKER_IMAGE_DIGEST: &str =
    "ghcr.io/pala-lakshmansai/imageforge-worker@sha256:5606ac29b07f85b831bba1e6aa359d32b99c55027679eb871f0166fa3bd3773e";
const IMAGEFORGE_MODEL_ID: &str = "Comfy-Org/Mage-Flow";
const IMAGEFORGE_MODEL_REVISION: &str = "d8c99241f6fa80fbd453014234af2bf337ea21e6";
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
    pub client_submission_id: String,
    #[serde(default)]
    pub admission_mode: AdmissionMode,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AdmissionMode {
    Foreground,
    Queue,
}

impl Default for AdmissionMode {
    fn default() -> Self {
        Self::Foreground
    }
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

/// Narrow peer-consent input for an already public GPU-switch request.  The
/// renderer may name only the observed switch, its own current session and an
/// approve/deny decision; native constructs the fixed authenticated route.
/// In particular, it does not compare the input session to `waiting_for`:
/// the worker deduplicates by authenticated principal and accepts any live
/// session belonging to the eligible peer principal.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioGpuSwitchResponseInput {
    pub switch_id: String,
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

/// Native-only ordinary Stop finalization plan. The private finalization UUID
/// is never serialized through Tauri; it exists only long enough for the
/// pinned worker Finalize request and the matching native provider delete
/// authority.
#[derive(Debug, Clone)]
pub(crate) struct NativeWorkerNormalStopFinalizePlanV1 {
    pub operation_id: String,
    pub request_id: String,
    pub session_id: String,
    pub pod_id: String,
    pub finalization_id: String,
    pub expected_server_instance_id: String,
}

/// The normal Stop journal has already committed before this POST is issued.
/// A malformed/transport/5xx response is therefore deliberately ambiguous:
/// the caller must preserve the worker guard and never infer that Finalize did
/// not arrive. Only a structurally valid 4xx Studio rejection is proven to
/// have performed no finalization mutation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeWorkerNormalStopFinalizeOutcomeV1 {
    Finalized,
    Rejected,
    Uncertain,
}

/// The native-only, byte-identical worker request used to admit a coordinated
/// GPU switch. It is deliberately not a Tauri command type: the renderer
/// supplies only the reviewed begin input and native derives every field from
/// durable inventory, worker-session, and queue evidence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NativeWorkerGpuSwitchCreateRequestV1 {
    pub switch_id: String,
    pub session_id: String,
    pub old_pod_id: String,
    pub old_gpu_id: String,
    pub old_gpu_display_name: String,
    pub initial_target_gpu_id: String,
    pub initial_target_gpu_display_name: String,
    pub initial_replacement_attempt_id: String,
    pub expected_batch_id: Option<String>,
    pub inventory_observed_at: String,
}

/// Holds the pinned origin, exact canonical request bytes, and short-lived
/// bearer token from preflight until the one permitted socket write. It is
/// crate-private and intentionally neither serializable nor debuggable so a
/// caller cannot accidentally surface the token or raw request through IPC.
pub(crate) struct NativeWorkerGpuSwitchCreatePreparedV1 {
    pin: WorkerSessionPin,
    request: NativeWorkerGpuSwitchCreateRequestV1,
    canonical_body: Vec<u8>,
    canonical_body_sha256: String,
    credential_binding_sha256: String,
    session_binding_sha256: String,
    worker_token: String,
}

impl NativeWorkerGpuSwitchCreatePreparedV1 {
    pub(crate) fn request(&self) -> &NativeWorkerGpuSwitchCreateRequestV1 {
        &self.request
    }

    pub(crate) fn canonical_body(&self) -> &[u8] {
        &self.canonical_body
    }

    pub(crate) fn canonical_body_sha256(&self) -> &str {
        &self.canonical_body_sha256
    }

    pub(crate) fn credential_binding_sha256(&self) -> &str {
        &self.credential_binding_sha256
    }

    pub(crate) fn session_binding_sha256(&self) -> &str {
        &self.session_binding_sha256
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(crate) struct NativeWorkerGpuSwitchParticipantV1 {
    pub session_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(crate) struct NativeWorkerGpuSwitchBatchOwnerV1 {
    pub display_name: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativeWorkerGpuSwitchStateV1 {
    Pending,
    Approved,
    Denied,
    Expired,
    Cancelled,
    Pausing,
    ReadyToDelete,
    DeleteIntent,
    ReplacementReady,
    Completed,
    NeedsAttention,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativeWorkerGpuSwitchReasonV1 {
    PeerDenied,
    ResponseTimeout,
    RequesterCancelled,
    RequesterExpired,
    GenerationStarted,
    BatchChanged,
    StopStarted,
    TargetChangedPreDelete,
    PauseFailed,
    ReplacementMismatch,
    CompletionFailed,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativeWorkerGpuSwitchBatchStateV1 {
    Running,
    Paused,
    Interrupted,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(crate) struct NativeWorkerGpuSwitchRequestViewV1 {
    pub schema_version: u8,
    pub switch_id: String,
    pub old_pod_id: String,
    pub old_gpu_id: String,
    pub old_gpu_display_name: String,
    pub initial_target_gpu_id: String,
    pub initial_target_gpu_display_name: String,
    pub initial_replacement_attempt_id: String,
    pub requester: NativeWorkerGpuSwitchParticipantV1,
    pub state: NativeWorkerGpuSwitchStateV1,
    pub reason: Option<NativeWorkerGpuSwitchReasonV1>,
    pub requested_at: String,
    pub response_deadline: String,
    pub ready_to_delete_at: Option<String>,
    pub waiting_for: Vec<NativeWorkerGpuSwitchParticipantV1>,
    pub approved_by: Vec<NativeWorkerGpuSwitchParticipantV1>,
    pub denied_by: Vec<NativeWorkerGpuSwitchParticipantV1>,
    pub batch_id: Option<String>,
    pub batch_owner: Option<NativeWorkerGpuSwitchBatchOwnerV1>,
    pub batch_state_at_finalization: Option<NativeWorkerGpuSwitchBatchStateV1>,
    pub replacement_attempt_id: Option<String>,
    pub replacement_attempt_revision: Option<u64>,
    pub replacement_pod_id: Option<String>,
    pub actual_target_gpu_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(crate) struct NativeWorkerGpuSwitchCreateResponseV1 {
    pub schema_version: u8,
    pub request: NativeWorkerGpuSwitchRequestViewV1,
    pub requester_user_id: String,
    pub principal_binding_id: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(crate) struct NativeWorkerGpuSwitchOwnerLookupV1 {
    pub schema_version: u8,
    pub switch_id: String,
    pub state: NativeWorkerGpuSwitchStateV1,
    pub requester_user_id: String,
    pub principal_binding_id: String,
    pub finalization_id: Option<String>,
    pub terminal_tombstone_sha256: Option<String>,
    pub replacement_attempt_id: Option<String>,
    pub replacement_attempt_revision: Option<u64>,
    pub replacement_pod_id: Option<String>,
    pub actual_target_gpu_id: Option<String>,
}

/// Strict safe projection returned by the public Switch lookup.  It contains
/// no requester, principal binding, finalization, or tombstone evidence; the
/// native coordinator uses it first for non-terminal state refresh and falls
/// back to the owner-only route only when this projection is absent.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(crate) struct NativeWorkerGpuSwitchPublicLookupV1 {
    pub schema_version: u8,
    pub switch_id: String,
    pub state: NativeWorkerGpuSwitchStateV1,
    pub replacement_attempt_id: Option<String>,
    pub replacement_attempt_revision: Option<u64>,
    pub replacement_pod_id: Option<String>,
    pub actual_target_gpu_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NativeWorkerGpuSwitchErrorV1 {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NativeWorkerGpuSwitchCreateResultV1 {
    Created(NativeWorkerGpuSwitchCreateResponseV1),
    Rejected(NativeWorkerGpuSwitchErrorV1),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NativeWorkerGpuSwitchOwnerLookupResultV1 {
    Found(NativeWorkerGpuSwitchOwnerLookupV1),
    NotFound,
    Rejected(NativeWorkerGpuSwitchErrorV1),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NativeWorkerGpuSwitchPublicLookupResultV1 {
    Found(NativeWorkerGpuSwitchPublicLookupV1),
    NotFound,
    Rejected(NativeWorkerGpuSwitchErrorV1),
}

/// Strict owner-only runtime proof returned by the replacement worker.  The
/// outer worker contract intentionally uses snake_case while the nested CUDA
/// device mirrors the NVML/CUDA inspector's camelCase schema.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeWorkerCudaDeviceIdentityV1 {
    pub device_index: u8,
    pub nvml_uuid: String,
    pub pci_device_id: String,
    pub cuda_name: String,
    pub total_memory_bytes: u64,
    pub compute_capability_major: u8,
    pub compute_capability_minor: u8,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(crate) struct NativeWorkerGpuSwitchRuntimeIdentityV1 {
    pub schema_version: u8,
    pub switch_id: String,
    pub principal_binding_id: String,
    pub server_instance_id: String,
    pub runtime_pod_id: String,
    pub runtime_volume_id: String,
    pub runtime_data_center_id: String,
    pub data_root_binding_sha256: String,
    pub expected_provider_gpu_id: String,
    pub device_count: u8,
    pub cuda_device: NativeWorkerCudaDeviceIdentityV1,
    pub image_digest: String,
    pub model_id: String,
    pub model_revision: String,
    pub create_contract_revision: u8,
    pub create_marker_sha256: String,
    pub replacement_attempt_id: String,
    pub replacement_attempt_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NativeWorkerGpuSwitchRuntimeIdentityResultV1 {
    Found(NativeWorkerGpuSwitchRuntimeIdentityV1),
    Rejected(NativeWorkerGpuSwitchErrorV1),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeGpuRuntimeMinimumComputeCapabilityV1 {
    major: u8,
    minor: u8,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeGpuRuntimeIdentityRecordV1 {
    provider_gpu_id: String,
    cuda_names: Vec<String>,
    pci_device_ids: Vec<String>,
    minimum_memory_bytes: u64,
    minimum_compute_capability: NativeGpuRuntimeMinimumComputeCapabilityV1,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeGpuRuntimeIdentityContractV1 {
    schema_version: u8,
    identities: Vec<NativeGpuRuntimeIdentityRecordV1>,
}

/// Native-only follow-up commands for an already durable GPU-switch request.
/// None of these values cross Tauri IPC: the command layer derives every UUID,
/// Pod binding, hash and replacement identity from the switch journal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NativeWorkerGpuSwitchOwnerActionV1 {
    Finalize {
        finalization_id: String,
    },
    DeleteIntent {
        finalization_id: String,
    },
    Adopt {
        finalization_id: String,
        replacement_attempt_id: String,
        replacement_attempt_revision: u64,
        replacement_pod_id: String,
        target_gpu_id: String,
        create_marker_sha256: String,
        create_intent_sha256: String,
        create_wire_body_sha256: String,
    },
    Complete {
        finalization_id: String,
        replacement_attempt_id: String,
        replacement_attempt_revision: u64,
        replacement_pod_id: String,
    },
    Cancel {
        finalization_id: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NativeWorkerGpuSwitchOwnerActionResultV1 {
    /// The operation received an exact HTTP success and the owner-only lookup
    /// subsequently returned a valid, authenticated state projection.
    Owner(NativeWorkerGpuSwitchOwnerLookupV1),
    /// A fully received typed worker rejection. It is safe to surface only as
    /// a local parked state; no automatic mutation retry is allowed.
    Rejected(NativeWorkerGpuSwitchErrorV1),
    /// The socket/response/owner lookup boundary is ambiguous. The caller
    /// must persist an attention record and reconcile through an explicit
    /// Resume, never resend this action opportunistically.
    Uncertain,
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
    StudioGpuSwitchResponse,
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
    RespondToGpuSwitch {
        switch_id: Uuid,
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
                | Self::StudioGpuSwitchResponse
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
            | Self::StudioGpuSwitchResponse
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

    pub async fn studio_respond_to_gpu_switch(
        &self,
        input: StudioGpuSwitchResponseInput,
    ) -> NativeResult<WorkerHttpResponse> {
        let switch_id = parse_studio_uuid(&input.switch_id, "gpu_switch_not_found")?;
        let session_id = parse_studio_uuid(&input.session_id, "studio_session_id_invalid")?;
        self.execute_studio_request(studio_gpu_switch_response_plan(
            switch_id,
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

    /// Re-read the authoritative Studio projection immediately before a
    /// native-owned ordinary Stop finalization. The renderer's revision and
    /// IDs are only compare-and-swap intent; the worker decides whether the
    /// exact approved consent is still live.
    pub(crate) async fn prepare_native_normal_stop_finalization(
        &self,
        input: &super::gpu_pod::NativeGpuNormalStopV1,
        operation_id: String,
    ) -> NativeResult<NativeWorkerNormalStopFinalizePlanV1> {
        let response = self.studio_status(&input.session_id).await?;
        if response.status != StatusCode::OK.as_u16() {
            return Err(NativeError::new(
                "stop_request_in_progress",
                "The GPU Stop request is no longer ready for finalization.",
            ));
        }
        let projection: StudioStateProjection =
            serde_json::from_value(response.body).map_err(|_| worker_response_invalid())?;
        if projection.server_instance_id != input.expected_server_instance_id
            || projection.coordination_revision != input.expected_coordination_revision
        {
            return Err(NativeError::retryable(
                "stop_request_in_progress",
                "The GPU Stop request changed. Refresh and confirm it again.",
            ));
        }
        normal_stop_worker_switch_veto(&projection)?;
        let stop = projection.stop_request.ok_or_else(|| {
            NativeError::new(
                "stop_request_in_progress",
                "The GPU Stop request is no longer ready for finalization.",
            )
        })?;
        if stop.request_id != input.stop_request_id
            || stop.pod_id != input.pod_id
            || stop.requester.session_id != input.session_id
            || stop.state != StudioStopRequestState::Approved
            || stop.finalization_id.is_some()
            || stop.finalization_expires_at.is_some()
        {
            return Err(NativeError::new(
                "stop_request_in_progress",
                "The GPU Stop request is no longer ready for finalization.",
            ));
        }
        Ok(NativeWorkerNormalStopFinalizePlanV1 {
            operation_id,
            request_id: input.stop_request_id.clone(),
            session_id: input.session_id.clone(),
            pod_id: input.pod_id.clone(),
            finalization_id: Uuid::new_v4().to_string(),
            expected_server_instance_id: input.expected_server_instance_id.clone(),
        })
    }

    /// Send one pinned ordinary Stop Finalize request. `WorkerApi` validates
    /// the returned finalizing projection against every private plan field
    /// before this method returns, so the provider delete path cannot be
    /// reached on a stale/mismatched consent response.
    pub(crate) async fn execute_native_normal_stop_finalization(
        &self,
        plan: &NativeWorkerNormalStopFinalizePlanV1,
    ) -> NativeResult<NativeWorkerNormalStopFinalizeOutcomeV1> {
        let response = match self
            .studio_finalize_stop_request(StudioFinalizeStopInput {
                request_id: plan.request_id.clone(),
                session_id: plan.session_id.clone(),
                pod_id: plan.pod_id.clone(),
                finalization_id: plan.finalization_id.clone(),
            })
            .await
        {
            Ok(response) => response,
            // Any error after we enter this method might occur after the
            // request crossed the socket boundary (for example malformed 2xx
            // JSON or a response-body loss), so recovery must fail closed.
            Err(_) => return Ok(NativeWorkerNormalStopFinalizeOutcomeV1::Uncertain),
        };
        if response.status == StatusCode::OK.as_u16() {
            Ok(NativeWorkerNormalStopFinalizeOutcomeV1::Finalized)
        } else if (400..500).contains(&response.status) {
            Ok(NativeWorkerNormalStopFinalizeOutcomeV1::Rejected)
        } else {
            Ok(NativeWorkerNormalStopFinalizeOutcomeV1::Uncertain)
        }
    }

    /// Re-read the authoritative finalizing Stop marker before native creates
    /// a provider DELETE authority. The finalization POST's response is one
    /// proof, but this strict follow-up prevents a stale local command from
    /// deleting after the worker has transitioned to a conflicting Switch or
    /// a different server epoch.
    pub(crate) async fn verify_native_normal_stop_finalization(
        &self,
        plan: &NativeWorkerNormalStopFinalizePlanV1,
    ) -> NativeResult<()> {
        let response = self.studio_status(&plan.session_id).await?;
        if response.status != StatusCode::OK.as_u16() {
            return Err(NativeError::new(
                "stop_request_in_progress",
                "The GPU Stop request is no longer ready for deletion.",
            ));
        }
        let projection: StudioStateProjection =
            serde_json::from_value(response.body).map_err(|_| worker_response_invalid())?;
        validate_native_normal_stop_finalizing_projection(plan, &projection)
    }

    /// Performs the non-mutating half of native Switch-create admission. The
    /// returned plan holds the exact worker-session pin and canonical request
    /// bytes. The switch journal must commit `send_pending`, then
    /// `sent_uncertain`, before `execute_gpu_switch_create` is called.
    pub(crate) async fn prepare_gpu_switch_create(
        &self,
        request: NativeWorkerGpuSwitchCreateRequestV1,
    ) -> NativeResult<NativeWorkerGpuSwitchCreatePreparedV1> {
        validate_gpu_switch_create_request(&request)?;
        let pin = self.session.pin().await?;
        ensure_pin_matches_pod(&pin, &request.old_pod_id)?;
        let worker_token = self.worker_token()?;
        let canonical_body = canonical_gpu_switch_create_body(&request)?;
        let canonical_body_sha256 = sha256_hex(&canonical_body);
        let credential_binding_sha256 =
            sha256_text_with_domain("imageforge-gpu-switch-worker-credential-v1", &worker_token);
        let session_binding_sha256 =
            sha256_text_with_domain("imageforge-gpu-switch-worker-session-v1", pin.pod_id());
        Ok(NativeWorkerGpuSwitchCreatePreparedV1 {
            pin,
            request,
            canonical_body,
            canonical_body_sha256,
            credential_binding_sha256,
            session_binding_sha256,
            worker_token,
        })
    }

    /// Execute exactly one already-durable Switch-create request. Network
    /// loss, malformed/ambiguous responses, or an unexpected success status
    /// are deliberately returned as `gpu_switch_worker_create_uncertain`; the
    /// caller must park and resolve through owner lookup, never retry here.
    pub(crate) async fn execute_gpu_switch_create(
        &self,
        prepared: NativeWorkerGpuSwitchCreatePreparedV1,
    ) -> NativeResult<NativeWorkerGpuSwitchCreateResultV1> {
        let NativeWorkerGpuSwitchCreatePreparedV1 {
            pin,
            request,
            canonical_body,
            worker_token,
            ..
        } = prepared;
        let url = pin.endpoint("/v1/studio/gpu-switches")?;
        let response = self
            .client
            .request(Method::POST, url)
            .header(ACCEPT, "application/json")
            .header(AUTHORIZATION, format!("Bearer {worker_token}"))
            .header(CONTENT_TYPE, "application/json")
            .body(canonical_body)
            .send()
            .await
            .map_err(|_| worker_gpu_switch_create_uncertain())?;
        let status = response.status();
        let bytes = read_bounded(response, MAX_STUDIO_RESPONSE_BYTES)
            .await
            .map_err(|_| worker_gpu_switch_create_uncertain())?;
        reject_gpu_switch_secret_reflection(&self.vault, &bytes, &worker_token)?;
        if status == StatusCode::CREATED {
            let created: NativeWorkerGpuSwitchCreateResponseV1 =
                strict_gpu_switch_json(&bytes).map_err(|_| gpu_switch_worker_response_invalid())?;
            validate_gpu_switch_create_response(&created, &request)?;
            return Ok(NativeWorkerGpuSwitchCreateResultV1::Created(created));
        }
        let error = parse_gpu_switch_error(status, &bytes)?;
        Ok(NativeWorkerGpuSwitchCreateResultV1::Rejected(error))
    }

    /// Strict public Switch lookup. This is deliberately attempted before the
    /// private owner route during ordinary sync so the safe live projection is
    /// enough for consent/pause state and private IDs are fetched only for an
    /// absent public projection or a terminal proof boundary.
    pub(crate) async fn gpu_switch_public_lookup(
        &self,
        switch_id: &str,
        session_id: &str,
        expected_pod_id: &str,
    ) -> NativeResult<NativeWorkerGpuSwitchPublicLookupResultV1> {
        let switch_id = parse_studio_uuid(switch_id, "gpu_switch_not_found")?;
        let session_id = parse_studio_uuid(session_id, "studio_session_id_invalid")?;
        validate_pod_id(expected_pod_id)?;
        let pin = self.session.pin().await?;
        ensure_pin_matches_pod(&pin, expected_pod_id)?;
        let worker_token = self.worker_token()?;
        let mut url = pin.endpoint(&format!("/v1/studio/gpu-switches/{switch_id}"))?;
        url.query_pairs_mut()
            .append_pair("session_id", &session_id.to_string());
        let response = self
            .client
            .request(Method::GET, url)
            .header(ACCEPT, "application/json")
            .header(AUTHORIZATION, format!("Bearer {worker_token}"))
            .send()
            .await
            .map_err(|_| worker_gpu_switch_lookup_unavailable())?;
        let status = response.status();
        let bytes = read_bounded(response, MAX_STUDIO_RESPONSE_BYTES)
            .await
            .map_err(|_| worker_gpu_switch_lookup_unavailable())?;
        reject_gpu_switch_secret_reflection(&self.vault, &bytes, &worker_token)
            .map_err(|_| worker_gpu_switch_lookup_unavailable())?;
        if status == StatusCode::OK {
            let lookup: NativeWorkerGpuSwitchPublicLookupV1 = strict_gpu_switch_json(&bytes)
                .map_err(|_| worker_gpu_switch_lookup_unavailable())?;
            validate_gpu_switch_public_lookup(&lookup, &switch_id.to_string())
                .map_err(|_| worker_gpu_switch_lookup_unavailable())?;
            return Ok(NativeWorkerGpuSwitchPublicLookupResultV1::Found(lookup));
        }
        let error = parse_gpu_switch_error(status, &bytes)
            .map_err(|_| worker_gpu_switch_lookup_unavailable())?;
        if error.code == "gpu_switch_request_not_found" {
            Ok(NativeWorkerGpuSwitchPublicLookupResultV1::NotFound)
        } else {
            Ok(NativeWorkerGpuSwitchPublicLookupResultV1::Rejected(error))
        }
    }

    /// Owner-only recovery lookup for an exact unresolved Switch-create. Its
    /// query pair is constructed by native code after path validation; callers
    /// can never inject an origin, query, or arbitrary worker route.
    pub(crate) async fn gpu_switch_owner_lookup(
        &self,
        switch_id: &str,
        session_id: &str,
        expected_pod_id: &str,
    ) -> NativeResult<NativeWorkerGpuSwitchOwnerLookupResultV1> {
        let switch_id = parse_studio_uuid(switch_id, "gpu_switch_not_found")?;
        let session_id = parse_studio_uuid(session_id, "studio_session_id_invalid")?;
        validate_pod_id(expected_pod_id)?;
        let pin = self.session.pin().await?;
        ensure_pin_matches_pod(&pin, expected_pod_id)?;
        let worker_token = self.worker_token()?;
        let mut url = pin.endpoint(&format!("/v1/internal/gpu-switches/{switch_id}/owner"))?;
        url.query_pairs_mut()
            .append_pair("session_id", &session_id.to_string());
        let response = self
            .client
            .request(Method::GET, url)
            .header(ACCEPT, "application/json")
            .header(AUTHORIZATION, format!("Bearer {worker_token}"))
            .send()
            .await
            .map_err(|_| worker_gpu_switch_lookup_unavailable())?;
        let status = response.status();
        let bytes = read_bounded(response, MAX_STUDIO_RESPONSE_BYTES)
            .await
            .map_err(|_| worker_gpu_switch_lookup_unavailable())?;
        reject_gpu_switch_secret_reflection(&self.vault, &bytes, &worker_token)
            .map_err(|_| worker_gpu_switch_lookup_unavailable())?;
        if status == StatusCode::OK {
            let lookup: NativeWorkerGpuSwitchOwnerLookupV1 = strict_gpu_switch_json(&bytes)
                .map_err(|_| worker_gpu_switch_lookup_unavailable())?;
            validate_gpu_switch_owner_lookup(&lookup, &switch_id.to_string())
                .map_err(|_| worker_gpu_switch_lookup_unavailable())?;
            return Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Found(lookup));
        }
        let error = parse_gpu_switch_error(status, &bytes)
            .map_err(|_| worker_gpu_switch_lookup_unavailable())?;
        if error.code == "gpu_switch_request_not_found" {
            Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::NotFound)
        } else {
            Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Rejected(error))
        }
    }

    /// Fetch the replacement worker's owner-only runtime identity over the
    /// exact pinned replacement-Pod origin.  No URL, principal, Pod identity,
    /// or device assertion is accepted from the renderer.  A structurally or
    /// semantically invalid success is the same fail-closed unavailable state
    /// as an unreadable response; a complete typed worker rejection retains
    /// its authoritative safe code.
    pub(crate) async fn gpu_switch_runtime_identity(
        &self,
        switch_id: &str,
        session_id: &str,
        expected_pod_id: &str,
    ) -> NativeResult<NativeWorkerGpuSwitchRuntimeIdentityResultV1> {
        let switch_id = parse_studio_uuid(switch_id, "gpu_switch_not_found")?;
        let session_id = parse_studio_uuid(session_id, "studio_session_id_invalid")?;
        validate_pod_id(expected_pod_id)?;
        let pin = self.session.pin().await?;
        ensure_pin_matches_pod(&pin, expected_pod_id)?;
        let worker_token = self.worker_token()?;
        let mut url = pin.endpoint(&format!(
            "/v1/internal/gpu-switches/{switch_id}/runtime-identity"
        ))?;
        url.query_pairs_mut()
            .append_pair("session_id", &session_id.to_string());
        let response = self
            .client
            .request(Method::GET, url)
            .header(ACCEPT, "application/json")
            .header(AUTHORIZATION, format!("Bearer {worker_token}"))
            .send()
            .await
            .map_err(|_| worker_gpu_switch_runtime_identity_unavailable())?;
        let status = response.status();
        let bytes = read_bounded(response, MAX_STUDIO_RESPONSE_BYTES)
            .await
            .map_err(|_| worker_gpu_switch_runtime_identity_unavailable())?;
        reject_gpu_switch_secret_reflection(&self.vault, &bytes, &worker_token)
            .map_err(|_| worker_gpu_switch_runtime_identity_unavailable())?;
        map_gpu_switch_runtime_identity_response(status, &bytes, &switch_id.to_string())
    }

    /// Execute one native-derived follow-up action against an already bound
    /// GPU-switch request. The renderer never supplies a route, body, token,
    /// finalization ID, or provider identity. A successful action is not
    /// trusted from its broad Studio response alone: it is followed by the
    /// exact owner-only lookup before any local state can advance.
    pub(crate) async fn gpu_switch_owner_action(
        &self,
        switch_id: &str,
        session_id: &str,
        expected_pod_id: &str,
        action: NativeWorkerGpuSwitchOwnerActionV1,
    ) -> NativeResult<NativeWorkerGpuSwitchOwnerActionResultV1> {
        let switch_id = parse_studio_uuid(switch_id, "gpu_switch_not_found")?;
        let session_id = parse_studio_uuid(session_id, "studio_session_id_invalid")?;
        validate_pod_id(expected_pod_id)?;
        let (route_suffix, payload) = gpu_switch_owner_action_payload(&session_id, &action)?;
        let pin = self.session.pin().await?;
        ensure_pin_matches_pod(&pin, expected_pod_id)?;
        let worker_token = self.worker_token()?;
        let canonical_body = super::gpu_inventory::jcs_value(&payload)
            .map_err(|_| gpu_switch_worker_response_invalid())?;
        let url = pin.endpoint(&format!(
            "/v1/studio/gpu-switches/{switch_id}/{route_suffix}"
        ))?;
        let response = match self
            .client
            .request(Method::POST, url)
            .header(ACCEPT, "application/json")
            .header(AUTHORIZATION, format!("Bearer {worker_token}"))
            .header(CONTENT_TYPE, "application/json")
            .body(canonical_body)
            .send()
            .await
        {
            Ok(response) => response,
            Err(_) => return Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Uncertain),
        };
        let status = response.status();
        let bytes = match read_bounded(response, MAX_STUDIO_RESPONSE_BYTES).await {
            Ok(bytes) => bytes,
            Err(_) => return Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Uncertain),
        };
        if reject_gpu_switch_secret_reflection(&self.vault, &bytes, &worker_token).is_err() {
            return Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Uncertain);
        }
        if status != StatusCode::OK {
            return parse_gpu_switch_error(status, &bytes)
                .map(NativeWorkerGpuSwitchOwnerActionResultV1::Rejected);
        }
        // Success without a parseable JSON envelope is ambiguous: the worker
        // may have committed before an intermediary truncated the response.
        if strict_gpu_switch_json::<Value>(&bytes).is_err() {
            return Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Uncertain);
        }
        match self
            .gpu_switch_owner_lookup(
                &switch_id.to_string(),
                &session_id.to_string(),
                expected_pod_id,
            )
            .await
        {
            Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Found(owner)) => {
                Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Owner(owner))
            }
            Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::Rejected(_))
            | Ok(NativeWorkerGpuSwitchOwnerLookupResultV1::NotFound)
            | Err(_) => Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Uncertain),
        }
    }

    /// Settle exactly one durable `sent_uncertain` create. Unlike ordinary
    /// cancel this sends the original canonical create request inside the
    /// worker's tombstone-producing route, so a response-loss draft can never
    /// be mistaken for an unsent request or retried with a fresh switch ID.
    pub(crate) async fn gpu_switch_settle_create(
        &self,
        request: NativeWorkerGpuSwitchCreateRequestV1,
    ) -> NativeResult<NativeWorkerGpuSwitchOwnerActionResultV1> {
        validate_gpu_switch_create_request(&request)?;
        let switch_id = parse_studio_uuid(&request.switch_id, "gpu_switch_not_found")?;
        let pin = self.session.pin().await?;
        ensure_pin_matches_pod(&pin, &request.old_pod_id)?;
        let worker_token = self.worker_token()?;
        let create_request =
            serde_json::from_slice::<Value>(&canonical_gpu_switch_create_body(&request)?)
                .map_err(|_| gpu_switch_worker_response_invalid())?;
        let body = super::gpu_inventory::jcs_value(&json!({
            "schema_version": 1,
            "action": "cancel",
            "create_request": create_request,
        }))
        .map_err(|_| gpu_switch_worker_response_invalid())?;
        let url = pin.endpoint(&format!(
            "/v1/internal/gpu-switches/{switch_id}/settle-create"
        ))?;
        let response = match self
            .client
            .request(Method::POST, url)
            .header(ACCEPT, "application/json")
            .header(AUTHORIZATION, format!("Bearer {worker_token}"))
            .header(CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
        {
            Ok(response) => response,
            Err(_) => return Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Uncertain),
        };
        let status = response.status();
        let bytes = match read_bounded(response, MAX_STUDIO_RESPONSE_BYTES).await {
            Ok(bytes) => bytes,
            Err(_) => return Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Uncertain),
        };
        if reject_gpu_switch_secret_reflection(&self.vault, &bytes, &worker_token).is_err() {
            return Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Uncertain);
        }
        if status != StatusCode::OK {
            return parse_gpu_switch_error(status, &bytes)
                .map(NativeWorkerGpuSwitchOwnerActionResultV1::Rejected);
        }
        let owner: NativeWorkerGpuSwitchOwnerLookupV1 = match strict_gpu_switch_json(&bytes) {
            Ok(value) => value,
            Err(_) => return Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Uncertain),
        };
        if validate_gpu_switch_owner_lookup(&owner, &switch_id.to_string()).is_err() {
            return Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Uncertain);
        }
        Ok(NativeWorkerGpuSwitchOwnerActionResultV1::Owner(owner))
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

    /// Owner-only exact submission lookup. The ID is validated before it ever
    /// becomes a URL segment, and the worker's generic 404 projection keeps a
    /// foreign caller from learning whether another user's key exists.
    pub async fn get_submission(
        &self,
        client_submission_id: Uuid,
    ) -> NativeResult<WorkerHttpResponse> {
        self.request_json(
            Method::GET,
            &format!("/v1/submissions/{client_submission_id}"),
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
        // Operation and HTTP status only. A rejected worker response otherwise
        // reports neither which call failed nor what the worker answered, so a
        // boot that never leaves "booting" gives no way to tell a still-loading
        // worker from an unreachable or contract-broken one.
        if let Err(error) = validate_worker_envelope(status, &body) {
            super::error::trace_rejected_checks(
                "worker_envelope",
                &[&format!("{operation:?}"), &format!("http_{}", status.as_u16())],
            );
            return Err(error);
        }
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
            project_worker_error(status, &body)?
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
    gpu_switch_request: Option<NativeWorkerGpuSwitchRequestViewV1>,
    gpu_switch_can_respond: bool,
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

pub(crate) fn parse_submission_uuid(value: &str) -> NativeResult<Uuid> {
    let parsed = Uuid::parse_str(value).map_err(|_| {
        NativeError::new(
            "client_submission_id_invalid",
            "The batch submission identifier is invalid.",
        )
    })?;
    if parsed.get_version() != Some(uuid::Version::Random) || parsed.to_string() != value {
        return Err(NativeError::new(
            "client_submission_id_invalid",
            "The batch submission identifier is invalid.",
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

fn studio_gpu_switch_response_plan(
    switch_id: Uuid,
    session_id: Uuid,
    decision: StudioStopDecision,
) -> StudioRequestPlan {
    StudioRequestPlan {
        method: Method::POST,
        path: format!("/v1/studio/gpu-switches/{switch_id}/responses"),
        body: Some(json!({
            "schema_version": 1,
            "session_id": session_id,
            "decision": decision,
        })),
        authenticated: true,
        operation: WorkerOperation::StudioGpuSwitchResponse,
        binding: StudioResponseBinding::RespondToGpuSwitch {
            switch_id,
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
            "gpu_switch_request",
            "gpu_switch_can_respond",
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
    if let Some(gpu_switch) = body
        .get("gpu_switch_request")
        .filter(|value| !value.is_null())
    {
        require_exact_keys(
            gpu_switch,
            &[
                "schema_version",
                "switch_id",
                "old_pod_id",
                "old_gpu_id",
                "old_gpu_display_name",
                "initial_target_gpu_id",
                "initial_target_gpu_display_name",
                "initial_replacement_attempt_id",
                "requester",
                "state",
                "reason",
                "requested_at",
                "response_deadline",
                "ready_to_delete_at",
                "waiting_for",
                "approved_by",
                "denied_by",
                "batch_id",
                "batch_owner",
                "batch_state_at_finalization",
                "replacement_attempt_id",
                "replacement_attempt_revision",
                "replacement_pod_id",
                "actual_target_gpu_id",
            ],
        )?;
        require_exact_keys(
            gpu_switch
                .get("requester")
                .ok_or_else(worker_response_invalid)?,
            &["session_id", "display_name"],
        )?;
        if let Some(batch_owner) = gpu_switch
            .get("batch_owner")
            .filter(|value| !value.is_null())
        {
            require_exact_keys(batch_owner, &["display_name"])?;
        }
        for key in ["waiting_for", "approved_by", "denied_by"] {
            for participant in gpu_switch
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
    if let Some(gpu_switch) = projection.gpu_switch_request.as_ref() {
        validate_gpu_switch_request_view(gpu_switch)?;
        if gpu_switch
            .waiting_for
            .iter()
            .any(|participant| participant.session_id == current_session_id)
            && !projection.gpu_switch_can_respond
        {
            return Err(worker_response_invalid());
        }
    }
    if projection.gpu_switch_can_respond
        && (projection
            .gpu_switch_request
            .as_ref()
            .is_none_or(|request| {
                request.state != NativeWorkerGpuSwitchStateV1::Pending
                    || projection.current_session.availability != StudioAvailability::Foreground
                    || request.requester.session_id == current_session_id
            }))
    {
        return Err(worker_response_invalid());
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
        | StudioResponseBinding::RespondToGpuSwitch { session_id, .. }
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
        StudioResponseBinding::RespondToGpuSwitch { switch_id, .. } => {
            // Do not compare `waiting_for` here. The worker resolves peer
            // eligibility by authenticated principal, so another foreground
            // session for the same peer principal is valid and must retain
            // its exact responding session in `approved_by`/`denied_by`.
            let request = state
                .gpu_switch_request
                .as_ref()
                .ok_or_else(studio_response_mismatch)?;
            if request.switch_id != switch_id.to_string() {
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

/// A normal Stop can only become provider-delete authority when the worker has
/// no live Switch marker. Pending/approved consent is a request-level veto;
/// every later nonterminal Switch state is a durable mutation veto.
fn normal_stop_worker_switch_veto(projection: &StudioStateProjection) -> NativeResult<()> {
    let Some(request) = projection.gpu_switch_request.as_ref() else {
        return Ok(());
    };
    match request.state {
        NativeWorkerGpuSwitchStateV1::Denied
        | NativeWorkerGpuSwitchStateV1::Expired
        | NativeWorkerGpuSwitchStateV1::Cancelled
        | NativeWorkerGpuSwitchStateV1::Completed => Ok(()),
        NativeWorkerGpuSwitchStateV1::Pending | NativeWorkerGpuSwitchStateV1::Approved => {
            Err(NativeError::new(
                "gpu_switch_request_in_progress",
                "A GPU switch request is already in progress.",
            ))
        }
        NativeWorkerGpuSwitchStateV1::Pausing
        | NativeWorkerGpuSwitchStateV1::ReadyToDelete
        | NativeWorkerGpuSwitchStateV1::DeleteIntent
        | NativeWorkerGpuSwitchStateV1::ReplacementReady
        | NativeWorkerGpuSwitchStateV1::NeedsAttention => Err(NativeError::new(
            "gpu_switch_pending",
            "A coordinated GPU switch is already in progress.",
        )),
    }
}

/// Validate the strict post-Finalize worker state without a transport. Keeping
/// this pure makes the native DELETE boundary directly testable: every private
/// plan field and any concurrent Switch marker must still agree immediately
/// before the provider authority is minted.
fn validate_native_normal_stop_finalizing_projection(
    plan: &NativeWorkerNormalStopFinalizePlanV1,
    projection: &StudioStateProjection,
) -> NativeResult<()> {
    if projection.server_instance_id != plan.expected_server_instance_id {
        return Err(NativeError::new(
            "stop_request_in_progress",
            "The ImageForge worker changed before the GPU could be deleted.",
        ));
    }
    normal_stop_worker_switch_veto(projection)?;
    let stop = projection.stop_request.as_ref().ok_or_else(|| {
        NativeError::new(
            "stop_request_in_progress",
            "The GPU Stop request is no longer ready for deletion.",
        )
    })?;
    if stop.request_id != plan.request_id
        || stop.requester.session_id != plan.session_id
        || stop.pod_id != plan.pod_id
        || stop.state != StudioStopRequestState::Finalizing
        || stop.finalization_id.as_deref() != Some(plan.finalization_id.as_str())
        || stop.finalization_expires_at.is_none()
    {
        return Err(NativeError::new(
            "stop_request_in_progress",
            "The GPU Stop request is no longer ready for deletion.",
        ));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeWorkerGpuSwitchErrorEnvelopeWireV1 {
    schema_version: u8,
    error: NativeWorkerGpuSwitchErrorWireV1,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeWorkerGpuSwitchErrorWireV1 {
    code: String,
    message: String,
    details: Value,
}

fn validate_gpu_switch_create_request(
    request: &NativeWorkerGpuSwitchCreateRequestV1,
) -> NativeResult<()> {
    parse_studio_uuid(&request.switch_id, "gpu_switch_not_found")?;
    parse_studio_uuid(&request.session_id, "studio_session_id_invalid")?;
    parse_studio_uuid(
        &request.initial_replacement_attempt_id,
        "gpu_switch_transition_invalid",
    )?;
    if let Some(batch_id) = request.expected_batch_id.as_deref() {
        parse_studio_uuid(batch_id, "gpu_switch_transition_invalid")?;
    }
    validate_pod_id(&request.old_pod_id)?;
    for value in [
        &request.old_gpu_id,
        &request.old_gpu_display_name,
        &request.initial_target_gpu_id,
        &request.initial_target_gpu_display_name,
    ] {
        validate_gpu_switch_identity(value)?;
    }
    if request.old_gpu_id == request.initial_target_gpu_id {
        return Err(gpu_switch_worker_response_invalid());
    }
    validate_studio_timestamp(&request.inventory_observed_at)
        .map_err(|_| gpu_switch_worker_response_invalid())
}

fn canonical_gpu_switch_create_body(
    request: &NativeWorkerGpuSwitchCreateRequestV1,
) -> NativeResult<Vec<u8>> {
    let value = json!({
        "schema_version": 1,
        "switch_id": request.switch_id,
        "session_id": request.session_id,
        "old_pod_id": request.old_pod_id,
        "old_gpu_id": request.old_gpu_id,
        "old_gpu_display_name": request.old_gpu_display_name,
        "initial_target_gpu_id": request.initial_target_gpu_id,
        "initial_target_gpu_display_name": request.initial_target_gpu_display_name,
        "initial_replacement_attempt_id": request.initial_replacement_attempt_id,
        "expected_batch_id": request.expected_batch_id,
        "inventory_observed_at": request.inventory_observed_at,
    });
    super::gpu_inventory::jcs_value(&value)
        .map(|body| body.into_bytes())
        .map_err(|_| gpu_switch_worker_response_invalid())
}

fn gpu_switch_owner_action_payload(
    session_id: &Uuid,
    action: &NativeWorkerGpuSwitchOwnerActionV1,
) -> NativeResult<(&'static str, Value)> {
    let session_id = session_id.to_string();
    let parse_finalization = |value: &str| {
        parse_studio_uuid(value, "gpu_switch_finalization_mismatch").map(|value| value.to_string())
    };
    match action {
        NativeWorkerGpuSwitchOwnerActionV1::Finalize { finalization_id } => Ok((
            "finalize",
            json!({
                "schema_version": 1,
                "session_id": session_id,
                "finalization_id": parse_finalization(finalization_id)?,
            }),
        )),
        NativeWorkerGpuSwitchOwnerActionV1::DeleteIntent { finalization_id } => Ok((
            "delete-intent",
            json!({
                "schema_version": 1,
                "session_id": session_id,
                "finalization_id": parse_finalization(finalization_id)?,
            }),
        )),
        NativeWorkerGpuSwitchOwnerActionV1::Adopt {
            finalization_id,
            replacement_attempt_id,
            replacement_attempt_revision,
            replacement_pod_id,
            target_gpu_id,
            create_marker_sha256,
            create_intent_sha256,
            create_wire_body_sha256,
        } => {
            let replacement_attempt_id =
                parse_studio_uuid(replacement_attempt_id, "gpu_switch_adoption_mismatch")?
                    .to_string();
            if *replacement_attempt_revision == 0
                || *replacement_attempt_revision > MAX_JSON_SAFE_INTEGER
                || validate_pod_id(replacement_pod_id).is_err()
                || !valid_gpu_switch_identity(target_gpu_id)
                || !valid_lower_sha256(create_marker_sha256)
                || !valid_lower_sha256(create_intent_sha256)
                || !valid_lower_sha256(create_wire_body_sha256)
            {
                return Err(gpu_switch_worker_response_invalid());
            }
            Ok((
                "adopt",
                json!({
                    "schema_version": 1,
                    "session_id": session_id,
                    "finalization_id": parse_finalization(finalization_id)?,
                    "replacement_attempt_id": replacement_attempt_id,
                    "replacement_attempt_revision": replacement_attempt_revision,
                    "replacement_pod_id": replacement_pod_id,
                    "target_gpu_id": target_gpu_id,
                    "create_contract_revision": 1,
                    "create_marker_sha256": create_marker_sha256,
                    "create_intent_sha256": create_intent_sha256,
                    "create_wire_body_sha256": create_wire_body_sha256,
                }),
            ))
        }
        NativeWorkerGpuSwitchOwnerActionV1::Complete {
            finalization_id,
            replacement_attempt_id,
            replacement_attempt_revision,
            replacement_pod_id,
        } => {
            let replacement_attempt_id =
                parse_studio_uuid(replacement_attempt_id, "gpu_switch_completion_not_ready")?
                    .to_string();
            if *replacement_attempt_revision == 0
                || *replacement_attempt_revision > MAX_JSON_SAFE_INTEGER
                || validate_pod_id(replacement_pod_id).is_err()
            {
                return Err(gpu_switch_worker_response_invalid());
            }
            Ok((
                "complete",
                json!({
                    "schema_version": 1,
                    "session_id": session_id,
                    "finalization_id": parse_finalization(finalization_id)?,
                    "replacement_attempt_id": replacement_attempt_id,
                    "replacement_attempt_revision": replacement_attempt_revision,
                    "replacement_pod_id": replacement_pod_id,
                }),
            ))
        }
        NativeWorkerGpuSwitchOwnerActionV1::Cancel { finalization_id } => {
            let finalization_id = finalization_id
                .as_deref()
                .map(parse_finalization)
                .transpose()?;
            Ok((
                "cancel",
                json!({
                    "schema_version": 1,
                    "session_id": session_id,
                    "finalization_id": finalization_id,
                }),
            ))
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn sha256_text_with_domain(domain: &str, value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain.as_bytes());
    hasher.update(b"\n");
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())
}

fn strict_gpu_switch_json<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ()> {
    if bytes.is_empty() || bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Err(());
    }
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let decoded = T::deserialize(&mut deserializer).map_err(|_| ())?;
    deserializer.end().map_err(|_| ())?;
    Ok(decoded)
}

fn reject_gpu_switch_secret_reflection(
    vault: &Arc<dyn CredentialVault>,
    bytes: &[u8],
    worker_token: &str,
) -> NativeResult<()> {
    let body =
        serde_json::from_slice::<Value>(bytes).map_err(|_| gpu_switch_worker_response_invalid())?;
    let runpod_key = vault.load(CredentialKind::RunpodApiKey).ok();
    reject_secret_reflection(&body, Some(worker_token), runpod_key.as_deref())
        .map_err(|_| gpu_switch_worker_response_invalid())
}

fn parse_gpu_switch_error(
    status: StatusCode,
    bytes: &[u8],
) -> NativeResult<NativeWorkerGpuSwitchErrorV1> {
    let envelope: NativeWorkerGpuSwitchErrorEnvelopeWireV1 =
        strict_gpu_switch_json(bytes).map_err(|_| gpu_switch_worker_response_invalid())?;
    if envelope.schema_version != 1 || envelope.error.details != Value::Null {
        return Err(gpu_switch_worker_response_invalid());
    }
    let Some((expected_status, expected_message)) = gpu_switch_error_spec(&envelope.error.code)
    else {
        return Err(gpu_switch_worker_response_invalid());
    };
    if status != expected_status || envelope.error.message != expected_message {
        return Err(gpu_switch_worker_response_invalid());
    }
    Ok(NativeWorkerGpuSwitchErrorV1 {
        code: envelope.error.code,
        message: envelope.error.message,
    })
}

/// Parse one complete runtime-identity response after the transport has
/// finished reading it.  Keeping this seam pure lets the native tests model
/// a fake worker's success, typed rejection, malformed/mismatched response,
/// and response-loss outcomes without weakening the pinned HTTP client.
fn map_gpu_switch_runtime_identity_response(
    status: StatusCode,
    bytes: &[u8],
    expected_switch_id: &str,
) -> NativeResult<NativeWorkerGpuSwitchRuntimeIdentityResultV1> {
    if status == StatusCode::OK {
        let identity: NativeWorkerGpuSwitchRuntimeIdentityV1 = strict_gpu_switch_json(bytes)
            .map_err(|_| worker_gpu_switch_runtime_identity_unavailable())?;
        validate_gpu_switch_runtime_identity(&identity, expected_switch_id)?;
        return Ok(NativeWorkerGpuSwitchRuntimeIdentityResultV1::Found(
            identity,
        ));
    }
    let error = parse_gpu_switch_error(status, bytes)
        .map_err(|_| worker_gpu_switch_runtime_identity_unavailable())?;
    Ok(NativeWorkerGpuSwitchRuntimeIdentityResultV1::Rejected(
        error,
    ))
}

fn gpu_switch_error_spec(code: &str) -> Option<(StatusCode, &'static str)> {
    Some(match code {
        "gpu_switch_request_not_found" => (
            StatusCode::NOT_FOUND,
            "The GPU switch request does not exist.",
        ),
        "gpu_switch_request_in_progress" => (
            StatusCode::CONFLICT,
            "Another GPU switch request is already in progress.",
        ),
        "gpu_switch_identity_mismatch" => (
            StatusCode::CONFLICT,
            "The GPU switch ID cannot be used for different request details.",
        ),
        "gpu_switch_response_conflict" => (
            StatusCode::CONFLICT,
            "This user already sent a different GPU switch response.",
        ),
        "gpu_switch_response_not_allowed" => (
            StatusCode::CONFLICT,
            "This user cannot respond to the GPU switch request.",
        ),
        "gpu_switch_approval_pending" => (
            StatusCode::CONFLICT,
            "GPU switch approval is still pending.",
        ),
        "gpu_switch_not_approved" => (
            StatusCode::CONFLICT,
            "The GPU switch request is not approved for finalization.",
        ),
        "gpu_switch_finalization_mismatch" => (
            StatusCode::CONFLICT,
            "The GPU switch finalization identity does not match.",
        ),
        "gpu_switch_cancel_not_allowed" => (
            StatusCode::CONFLICT,
            "The GPU switch cannot be cancelled after delete intent.",
        ),
        "gpu_switch_adoption_mismatch" => (
            StatusCode::CONFLICT,
            "The replacement worker identity does not match the GPU switch.",
        ),
        "gpu_switch_batch_changed" => (
            StatusCode::CONFLICT,
            "The active batch no longer matches the GPU switch preflight.",
        ),
        "gpu_switch_completion_not_ready" => (
            StatusCode::CONFLICT,
            "The replacement worker is not ready to complete the GPU switch.",
        ),
        "gpu_switch_current_pod_unverified" => (
            StatusCode::CONFLICT,
            "The current worker Pod identity is not authoritative.",
        ),
        "gpu_switch_local_receipts_pending" => (
            StatusCode::CONFLICT,
            "Local image receipts must settle before changing compute.",
        ),
        "stop_request_in_progress" => (
            StatusCode::CONFLICT,
            "A coordinated GPU Stop request is already in progress.",
        ),
        "gpu_switch_requester_not_foreground" => (
            StatusCode::LOCKED,
            "The GPU switch requester must remain foreground.",
        ),
        "switch_owner_unavailable" => (
            StatusCode::LOCKED,
            "The active batch owner is not available to approve this GPU switch.",
        ),
        "gpu_switch_queue_dispatch_uncertain" => (
            StatusCode::LOCKED,
            "The local queue submission must be reconciled before changing compute.",
        ),
        "gpu_stop_pending" => (
            StatusCode::LOCKED,
            "GPU Stop is finalizing; a GPU switch is temporarily blocked.",
        ),
        "gpu_switch_pending" => (
            StatusCode::LOCKED,
            "A finalized GPU switch blocks this worker operation.",
        ),
        "queue_switch_pending" => (
            StatusCode::LOCKED,
            "A GPU switch is awaiting consent; the local queue remains parked.",
        ),
        "gpu_switch_store_corrupt" => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Worker GPU switch history is unavailable. Repair the shared volume before changing compute.",
        ),
        "gpu_switch_runtime_identity_unavailable" => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Worker runtime identity is unavailable. Repair the ImageForge template before changing compute.",
        ),
        "gpu_control_guard_conflict" => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Worker GPU control history conflicts. Repair the shared volume before changing compute.",
        ),
        _ => return None,
    })
}

fn validate_gpu_switch_create_response(
    response: &NativeWorkerGpuSwitchCreateResponseV1,
    request: &NativeWorkerGpuSwitchCreateRequestV1,
) -> NativeResult<()> {
    if response.schema_version != 1 {
        return Err(gpu_switch_worker_response_invalid());
    }
    validate_gpu_switch_user_id(&response.requester_user_id)?;
    parse_studio_uuid(
        &response.principal_binding_id,
        "gpu_switch_worker_response_invalid",
    )?;
    validate_gpu_switch_request_view(&response.request)?;
    let view = &response.request;
    if view.switch_id != request.switch_id
        || view.requester.session_id != request.session_id
        || view.old_pod_id != request.old_pod_id
        || view.old_gpu_id != request.old_gpu_id
        || view.old_gpu_display_name != request.old_gpu_display_name
        || view.initial_target_gpu_id != request.initial_target_gpu_id
        || view.initial_target_gpu_display_name != request.initial_target_gpu_display_name
        || view.initial_replacement_attempt_id != request.initial_replacement_attempt_id
    {
        return Err(gpu_switch_worker_response_invalid());
    }
    Ok(())
}

fn validate_gpu_switch_request_view(view: &NativeWorkerGpuSwitchRequestViewV1) -> NativeResult<()> {
    if view.schema_version != 1 {
        return Err(gpu_switch_worker_response_invalid());
    }
    for identifier in [&view.switch_id, &view.initial_replacement_attempt_id] {
        parse_studio_uuid(identifier, "gpu_switch_worker_response_invalid")?;
    }
    validate_pod_id(&view.old_pod_id).map_err(|_| gpu_switch_worker_response_invalid())?;
    for identity in [
        &view.old_gpu_id,
        &view.old_gpu_display_name,
        &view.initial_target_gpu_id,
        &view.initial_target_gpu_display_name,
    ] {
        validate_gpu_switch_identity(identity)?;
    }
    if view.old_gpu_id == view.initial_target_gpu_id {
        return Err(gpu_switch_worker_response_invalid());
    }
    validate_gpu_switch_participant(&view.requester)?;
    validate_studio_timestamp(&view.requested_at)?;
    validate_studio_timestamp(&view.response_deadline)?;
    if let Some(timestamp) = view.ready_to_delete_at.as_deref() {
        validate_studio_timestamp(timestamp)?;
    }
    for participants in [&view.waiting_for, &view.approved_by, &view.denied_by] {
        validate_gpu_switch_participants(participants)?;
    }
    if let Some(batch_id) = view.batch_id.as_deref() {
        parse_studio_uuid(batch_id, "gpu_switch_worker_response_invalid")?;
    }
    if view
        .batch_owner
        .as_ref()
        .is_some_and(|owner| !valid_studio_display_name(&owner.display_name))
        || (view.batch_id.is_some() != view.batch_owner.is_some())
    {
        return Err(gpu_switch_worker_response_invalid());
    }
    let replacement = (
        view.replacement_attempt_id.as_deref(),
        view.replacement_attempt_revision,
        view.replacement_pod_id.as_deref(),
        view.actual_target_gpu_id.as_deref(),
    );
    let replacement_complete = replacement.0.is_some()
        && replacement.1.is_some()
        && replacement.2.is_some()
        && replacement.3.is_some();
    if replacement_complete
        != (replacement.0.is_some()
            || replacement.1.is_some()
            || replacement.2.is_some()
            || replacement.3.is_some())
    {
        return Err(gpu_switch_worker_response_invalid());
    }
    if let Some(attempt_id) = replacement.0 {
        parse_studio_uuid(attempt_id, "gpu_switch_worker_response_invalid")?;
    }
    if replacement
        .1
        .is_some_and(|revision| revision == 0 || revision > MAX_JSON_SAFE_INTEGER)
        || replacement
            .2
            .is_some_and(|pod_id| validate_pod_id(pod_id).is_err())
        || replacement
            .3
            .is_some_and(|gpu_id| !valid_gpu_switch_identity(gpu_id))
    {
        return Err(gpu_switch_worker_response_invalid());
    }
    let finalized = matches!(
        view.state,
        NativeWorkerGpuSwitchStateV1::Pausing
            | NativeWorkerGpuSwitchStateV1::ReadyToDelete
            | NativeWorkerGpuSwitchStateV1::DeleteIntent
            | NativeWorkerGpuSwitchStateV1::ReplacementReady
            | NativeWorkerGpuSwitchStateV1::NeedsAttention
    );
    if view.batch_id.is_none() && view.batch_state_at_finalization.is_some()
        || (finalized && view.batch_id.is_some() && view.batch_state_at_finalization.is_none())
        || (!finalized && view.batch_state_at_finalization.is_some())
        || matches!(
            view.state,
            NativeWorkerGpuSwitchStateV1::Denied
                | NativeWorkerGpuSwitchStateV1::Expired
                | NativeWorkerGpuSwitchStateV1::Cancelled
                | NativeWorkerGpuSwitchStateV1::Completed
        )
    {
        return Err(gpu_switch_worker_response_invalid());
    }
    let expected_reason = match view.state {
        NativeWorkerGpuSwitchStateV1::Pending | NativeWorkerGpuSwitchStateV1::Approved => None,
        NativeWorkerGpuSwitchStateV1::Pausing => {
            if matches!(
                view.reason,
                None | Some(NativeWorkerGpuSwitchReasonV1::RequesterCancelled)
            ) {
                view.reason
            } else {
                return Err(gpu_switch_worker_response_invalid());
            }
        }
        NativeWorkerGpuSwitchStateV1::ReadyToDelete
        | NativeWorkerGpuSwitchStateV1::DeleteIntent
        | NativeWorkerGpuSwitchStateV1::ReplacementReady => None,
        NativeWorkerGpuSwitchStateV1::NeedsAttention => {
            Some(NativeWorkerGpuSwitchReasonV1::PauseFailed)
        }
        NativeWorkerGpuSwitchStateV1::Denied
        | NativeWorkerGpuSwitchStateV1::Expired
        | NativeWorkerGpuSwitchStateV1::Cancelled
        | NativeWorkerGpuSwitchStateV1::Completed => {
            return Err(gpu_switch_worker_response_invalid())
        }
    };
    if view.reason != expected_reason {
        return Err(gpu_switch_worker_response_invalid());
    }
    let fixed_point = matches!(
        view.state,
        NativeWorkerGpuSwitchStateV1::ReadyToDelete
            | NativeWorkerGpuSwitchStateV1::DeleteIntent
            | NativeWorkerGpuSwitchStateV1::ReplacementReady
    );
    if fixed_point != view.ready_to_delete_at.is_some()
        || replacement_complete != (view.state == NativeWorkerGpuSwitchStateV1::ReplacementReady)
    {
        return Err(gpu_switch_worker_response_invalid());
    }
    if view.state == NativeWorkerGpuSwitchStateV1::NeedsAttention
        && (view.batch_id.is_none()
            || view.batch_owner.is_none()
            || view.batch_state_at_finalization != Some(NativeWorkerGpuSwitchBatchStateV1::Running))
    {
        return Err(gpu_switch_worker_response_invalid());
    }
    if view.state == NativeWorkerGpuSwitchStateV1::Pausing
        && view.reason == Some(NativeWorkerGpuSwitchReasonV1::RequesterCancelled)
        && (view.batch_id.is_none()
            || view.batch_state_at_finalization != Some(NativeWorkerGpuSwitchBatchStateV1::Running))
    {
        return Err(gpu_switch_worker_response_invalid());
    }
    Ok(())
}

fn validate_gpu_switch_public_lookup(
    lookup: &NativeWorkerGpuSwitchPublicLookupV1,
    expected_switch_id: &str,
) -> NativeResult<()> {
    if lookup.schema_version != 1 || lookup.switch_id != expected_switch_id {
        return Err(gpu_switch_worker_response_invalid());
    }
    parse_studio_uuid(&lookup.switch_id, "gpu_switch_worker_response_invalid")?;
    validate_gpu_switch_lookup_identity(
        lookup.state,
        lookup.replacement_attempt_id.as_deref(),
        lookup.replacement_attempt_revision,
        lookup.replacement_pod_id.as_deref(),
        lookup.actual_target_gpu_id.as_deref(),
        None,
        None,
        false,
    )
}

fn validate_gpu_switch_owner_lookup(
    lookup: &NativeWorkerGpuSwitchOwnerLookupV1,
    expected_switch_id: &str,
) -> NativeResult<()> {
    if lookup.schema_version != 1 || lookup.switch_id != expected_switch_id {
        return Err(gpu_switch_worker_response_invalid());
    }
    parse_studio_uuid(&lookup.switch_id, "gpu_switch_worker_response_invalid")?;
    validate_gpu_switch_user_id(&lookup.requester_user_id)?;
    parse_studio_uuid(
        &lookup.principal_binding_id,
        "gpu_switch_worker_response_invalid",
    )?;
    if let Some(finalization_id) = lookup.finalization_id.as_deref() {
        parse_studio_uuid(finalization_id, "gpu_switch_worker_response_invalid")?;
    }
    if lookup
        .terminal_tombstone_sha256
        .as_deref()
        .is_some_and(|value| !valid_lower_sha256(value))
    {
        return Err(gpu_switch_worker_response_invalid());
    }
    let terminal = matches!(
        lookup.state,
        NativeWorkerGpuSwitchStateV1::Denied
            | NativeWorkerGpuSwitchStateV1::Expired
            | NativeWorkerGpuSwitchStateV1::Cancelled
            | NativeWorkerGpuSwitchStateV1::Completed
    );
    if terminal != lookup.terminal_tombstone_sha256.is_some() {
        return Err(gpu_switch_worker_response_invalid());
    }
    validate_gpu_switch_lookup_identity(
        lookup.state,
        lookup.replacement_attempt_id.as_deref(),
        lookup.replacement_attempt_revision,
        lookup.replacement_pod_id.as_deref(),
        lookup.actual_target_gpu_id.as_deref(),
        lookup.finalization_id.as_deref(),
        lookup.terminal_tombstone_sha256.as_deref(),
        true,
    )
}

fn validate_gpu_switch_lookup_identity(
    state: NativeWorkerGpuSwitchStateV1,
    replacement_attempt_id: Option<&str>,
    replacement_attempt_revision: Option<u64>,
    replacement_pod_id: Option<&str>,
    actual_target_gpu_id: Option<&str>,
    finalization_id: Option<&str>,
    terminal_tombstone_sha256: Option<&str>,
    require_private_proofs: bool,
) -> NativeResult<()> {
    let replacement = (
        replacement_attempt_id,
        replacement_attempt_revision,
        replacement_pod_id,
        actual_target_gpu_id,
    );
    let complete = replacement.0.is_some()
        && replacement.1.is_some()
        && replacement.2.is_some()
        && replacement.3.is_some();
    if complete
        != (replacement.0.is_some()
            || replacement.1.is_some()
            || replacement.2.is_some()
            || replacement.3.is_some())
    {
        return Err(gpu_switch_worker_response_invalid());
    }
    if let Some(value) = replacement.0 {
        parse_studio_uuid(value, "gpu_switch_worker_response_invalid")?;
    }
    if replacement
        .1
        .is_some_and(|revision| revision == 0 || revision > MAX_JSON_SAFE_INTEGER)
        || replacement
            .2
            .is_some_and(|value| validate_pod_id(value).is_err())
        || replacement
            .3
            .is_some_and(|value| !valid_gpu_switch_identity(value))
    {
        return Err(gpu_switch_worker_response_invalid());
    }
    let terminal = matches!(
        state,
        NativeWorkerGpuSwitchStateV1::Denied
            | NativeWorkerGpuSwitchStateV1::Expired
            | NativeWorkerGpuSwitchStateV1::Cancelled
            | NativeWorkerGpuSwitchStateV1::Completed
    );
    if terminal_tombstone_sha256.is_some_and(|value| !valid_lower_sha256(value))
        || (terminal_tombstone_sha256.is_some() && !terminal)
        || (require_private_proofs
            && ((finalization_id.is_some()
                && matches!(
                    state,
                    NativeWorkerGpuSwitchStateV1::Pending
                        | NativeWorkerGpuSwitchStateV1::Approved
                        | NativeWorkerGpuSwitchStateV1::Denied
                        | NativeWorkerGpuSwitchStateV1::Expired
                        | NativeWorkerGpuSwitchStateV1::Cancelled
                ))
                || (finalization_id.is_none()
                    && matches!(
                        state,
                        NativeWorkerGpuSwitchStateV1::Pausing
                            | NativeWorkerGpuSwitchStateV1::ReadyToDelete
                            | NativeWorkerGpuSwitchStateV1::DeleteIntent
                            | NativeWorkerGpuSwitchStateV1::ReplacementReady
                            | NativeWorkerGpuSwitchStateV1::Completed
                    ))))
        || matches!(
            state,
            NativeWorkerGpuSwitchStateV1::ReplacementReady
                | NativeWorkerGpuSwitchStateV1::Completed
        ) != complete
        || matches!(
            state,
            NativeWorkerGpuSwitchStateV1::Denied
                | NativeWorkerGpuSwitchStateV1::Expired
                | NativeWorkerGpuSwitchStateV1::Cancelled
        ) && complete
    {
        return Err(gpu_switch_worker_response_invalid());
    }
    if let Some(finalization_id) = finalization_id {
        parse_studio_uuid(finalization_id, "gpu_switch_worker_response_invalid")?;
    }
    Ok(())
}

fn validate_gpu_switch_participant(
    participant: &NativeWorkerGpuSwitchParticipantV1,
) -> NativeResult<()> {
    parse_studio_uuid(
        &participant.session_id,
        "gpu_switch_worker_response_invalid",
    )?;
    if !valid_studio_display_name(&participant.display_name) {
        return Err(gpu_switch_worker_response_invalid());
    }
    Ok(())
}

fn validate_gpu_switch_participants(
    participants: &[NativeWorkerGpuSwitchParticipantV1],
) -> NativeResult<()> {
    if participants.len() > MAX_STUDIO_PARTICIPANTS {
        return Err(gpu_switch_worker_response_invalid());
    }
    let mut previous: Option<(&str, &str)> = None;
    let mut ids = std::collections::HashSet::new();
    for participant in participants {
        validate_gpu_switch_participant(participant)?;
        let key = (
            participant.display_name.as_str(),
            participant.session_id.as_str(),
        );
        if previous.is_some_and(|prior| prior >= key)
            || !ids.insert(participant.session_id.as_str())
        {
            return Err(gpu_switch_worker_response_invalid());
        }
        previous = Some(key);
    }
    Ok(())
}

fn valid_studio_display_name(value: &str) -> bool {
    value.trim() == value
        && !value.is_empty()
        && value.chars().count() <= MAX_STUDIO_DISPLAY_NAME_CHARS
        && !value.chars().any(char::is_control)
}

fn validate_gpu_switch_identity(value: &str) -> NativeResult<()> {
    if valid_gpu_switch_identity(value) {
        Ok(())
    } else {
        Err(gpu_switch_worker_response_invalid())
    }
}

fn valid_gpu_switch_identity(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=128).contains(&bytes.len())
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.iter().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b' ' | b'.' | b'_' | b'(' | b')' | b'+' | b':' | b'-')
        })
}

fn valid_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_nvml_uuid(value: &str) -> bool {
    value.len() == 40
        && value.starts_with("GPU-")
        && value[4..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn valid_pci_device_id(value: &str) -> bool {
    value.len() == 6
        && value.starts_with("0x")
        && value[2..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_gpu_switch_runtime_identity(
    identity: &NativeWorkerGpuSwitchRuntimeIdentityV1,
    expected_switch_id: &str,
) -> NativeResult<()> {
    let invalid = worker_gpu_switch_runtime_identity_unavailable;
    if identity.schema_version != 1
        || identity.switch_id != expected_switch_id
        || parse_studio_uuid(
            &identity.switch_id,
            "gpu_switch_runtime_identity_unavailable",
        )
        .is_err()
        || parse_studio_uuid(
            &identity.principal_binding_id,
            "gpu_switch_runtime_identity_unavailable",
        )
        .is_err()
        || parse_studio_uuid(
            &identity.server_instance_id,
            "gpu_switch_runtime_identity_unavailable",
        )
        .is_err()
        || validate_pod_id(&identity.runtime_pod_id).is_err()
        || identity.runtime_volume_id.is_empty()
        || identity.runtime_volume_id.as_bytes().len() > 128
        || identity
            .runtime_volume_id
            .bytes()
            .any(|byte| byte < 0x21 || byte > 0x7e)
        || identity.runtime_data_center_id != "EU-RO-1"
        || !valid_lower_sha256(&identity.data_root_binding_sha256)
        || validate_gpu_display_name(&identity.expected_provider_gpu_id).is_err()
        || identity.device_count != 1
        || identity.cuda_device.device_index != 0
        || !valid_nvml_uuid(&identity.cuda_device.nvml_uuid)
        || !valid_pci_device_id(&identity.cuda_device.pci_device_id)
        || validate_gpu_display_name(&identity.cuda_device.cuda_name).is_err()
        || identity.cuda_device.total_memory_bytes == 0
        || identity.cuda_device.total_memory_bytes > MAX_JSON_SAFE_INTEGER
        || !(1..=99).contains(&identity.cuda_device.compute_capability_major)
        || identity.cuda_device.compute_capability_minor > 99
        || identity.image_digest != IMAGEFORGE_WORKER_IMAGE_DIGEST
        || identity.model_id != IMAGEFORGE_MODEL_ID
        || identity.model_revision != IMAGEFORGE_MODEL_REVISION
        || identity.create_contract_revision != 1
        || !valid_lower_sha256(&identity.create_marker_sha256)
        || parse_studio_uuid(
            &identity.replacement_attempt_id,
            "gpu_switch_runtime_identity_unavailable",
        )
        .is_err()
        || identity.replacement_attempt_revision == 0
        || identity.replacement_attempt_revision > MAX_JSON_SAFE_INTEGER
    {
        return Err(invalid());
    }

    let contract: NativeGpuRuntimeIdentityContractV1 = serde_json::from_str(include_str!(
        "../../../contracts/gpu-runtime-identities-v1.json"
    ))
    .map_err(|_| invalid())?;
    if contract.schema_version != 1 || !(1..=32).contains(&contract.identities.len()) {
        return Err(invalid());
    }
    for (index, record) in contract.identities.iter().enumerate() {
        if validate_gpu_display_name(&record.provider_gpu_id).is_err()
            || !(1..=16).contains(&record.cuda_names.len())
            || !(1..=16).contains(&record.pci_device_ids.len())
            || record.minimum_memory_bytes == 0
            || record.minimum_memory_bytes > MAX_JSON_SAFE_INTEGER
            || !(1..=99).contains(&record.minimum_compute_capability.major)
            || record.minimum_compute_capability.minor > 99
            || contract.identities[..index]
                .iter()
                .any(|prior| prior.provider_gpu_id == record.provider_gpu_id)
            || record
                .cuda_names
                .iter()
                .enumerate()
                .any(|(name_index, name)| {
                    validate_gpu_display_name(name).is_err()
                        || record.cuda_names[..name_index].contains(name)
                })
            || record
                .pci_device_ids
                .iter()
                .enumerate()
                .any(|(pci_index, pci)| {
                    !valid_pci_device_id(pci) || record.pci_device_ids[..pci_index].contains(pci)
                })
        {
            return Err(invalid());
        }
    }
    let mapping = contract
        .identities
        .iter()
        .find(|record| record.provider_gpu_id == identity.expected_provider_gpu_id)
        .ok_or_else(invalid)?;
    let actual_capability = (
        identity.cuda_device.compute_capability_major,
        identity.cuda_device.compute_capability_minor,
    );
    let minimum_capability = (
        mapping.minimum_compute_capability.major,
        mapping.minimum_compute_capability.minor,
    );
    if !mapping.cuda_names.contains(&identity.cuda_device.cuda_name)
        || !mapping
            .pci_device_ids
            .contains(&identity.cuda_device.pci_device_id)
        || identity.cuda_device.total_memory_bytes < mapping.minimum_memory_bytes
        || actual_capability < minimum_capability
    {
        return Err(invalid());
    }
    Ok(())
}

pub(crate) fn gpu_switch_runtime_identity_sha256(
    identity: &NativeWorkerGpuSwitchRuntimeIdentityV1,
) -> NativeResult<String> {
    let value = serde_json::to_value(identity)
        .map_err(|_| worker_gpu_switch_runtime_identity_unavailable())?;
    let canonical = super::gpu_inventory::jcs_value(&value)
        .map_err(|_| worker_gpu_switch_runtime_identity_unavailable())?;
    Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
}

fn validate_gpu_switch_user_id(value: &str) -> NativeResult<()> {
    let bytes = value.as_bytes();
    if (1..=64).contains(&bytes.len())
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        Ok(())
    } else {
        Err(gpu_switch_worker_response_invalid())
    }
}

fn gpu_switch_worker_response_invalid() -> NativeError {
    NativeError::new(
        "gpu_switch_worker_response_invalid",
        "The worker returned an invalid GPU switch coordination response.",
    )
}

fn worker_gpu_switch_create_uncertain() -> NativeError {
    NativeError::new(
        "gpu_switch_worker_create_uncertain",
        "The GPU switch request may have reached the worker. Resume switch to reconcile it.",
    )
}

fn worker_gpu_switch_lookup_unavailable() -> NativeError {
    NativeError::new(
        "gpu_switch_worker_response_invalid",
        "The worker could not provide a valid GPU switch recovery response.",
    )
}

fn worker_gpu_switch_runtime_identity_unavailable() -> NativeError {
    NativeError::new(
        "gpu_switch_runtime_identity_unavailable",
        "Worker runtime identity is unavailable. Repair the ImageForge template before changing compute.",
    )
}

fn validate_create_batch(input: &CreateBatchInput) -> NativeResult<()> {
    if input.prompts.is_empty()
        || input.base_seed
            > MAX_JSON_SAFE_INTEGER.saturating_sub(input.prompts.len().saturating_sub(1) as u64)
    {
        return Err(NativeError::new(
            "batch_invalid",
            "A batch must contain at least one prompt and a valid base seed.",
        ));
    }
    parse_submission_uuid(&input.client_submission_id)?;
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
        "client_submission_id": input.client_submission_id,
        "admission_mode": input.admission_mode,
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
    if !status.is_success() {
        validate_worker_error_envelope_shape(body)?;
    }
    Ok(())
}

/// Error responses are a contract boundary too: never pass an arbitrary
/// worker object through merely because it happens to contain a string `code`.
/// The Python handler now always emits the exact nullable-details form, which
/// normalizes to the renderer's strict `{error:{code,message,details}}`
/// projection below. Submission errors are deliberately stricter because
/// their null details protect key/owner existence from becoming an oracle.
fn validate_worker_error_envelope_shape(body: &Value) -> NativeResult<()> {
    require_exact_keys(body, &["schema_version", "error"])?;
    if body.get("schema_version").and_then(Value::as_u64) != Some(1) {
        return Err(worker_response_invalid());
    }
    let error = body
        .get("error")
        .and_then(Value::as_object)
        .ok_or_else(worker_response_invalid)?;
    if error.len() != 3
        || !error.contains_key("code")
        || !error.contains_key("message")
        || !error.contains_key("details")
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
    error
        .get("message")
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty() && value.len() <= 500 && !value.chars().any(char::is_control)
        })
        .ok_or_else(worker_response_invalid)?;
    if let Some(details) = error.get("details") {
        if !details.is_null() && !details.is_object() {
            return Err(worker_response_invalid());
        }
    }
    if matches!(
        code,
        "submission_conflict" | "submission_not_found" | "submission_store_corrupt"
    ) && error.get("details") != Some(&Value::Null)
    {
        return Err(worker_response_invalid());
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
        | WorkerOperation::StudioGpuSwitchResponse
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
    validate_status_shape(body)?;
    let mut projected = project_object(
        body,
        &["schema_version", "ready", "active_batch", "permissions"],
    )?;
    project_nested(
        &mut projected,
        "permissions",
        &[
            "can_create",
            "can_manage_active",
            "is_owner",
            "create_block_reason",
        ],
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

/// `/v1/status` controls whether the local queue may attempt admission, so it
/// is intentionally parsed as a closed shape rather than a permissive subset.
/// In particular, `create_block_reason` distinguishes an actionable shared
/// Stop finalization from a non-retryable corrupt submission history.
fn validate_status_shape(body: &Value) -> NativeResult<()> {
    require_exact_keys(
        body,
        &["schema_version", "ready", "active_batch", "permissions"],
    )?;
    if body.get("schema_version").and_then(Value::as_u64) != Some(1) {
        return Err(worker_response_invalid());
    }
    if !body.get("ready").is_some_and(Value::is_boolean) {
        return Err(worker_response_invalid());
    }
    let permissions = body
        .get("permissions")
        .ok_or_else(worker_response_invalid)?;
    // The worker's `StatusPermissions` also carries the GPU-switch pair. It is
    // validated here and dropped in projection: the renderer decides switch
    // eligibility through the native GPU-switch path, so widening the IPC
    // surface would add a second authority for the same question.
    require_exact_keys(
        permissions,
        &[
            "can_create",
            "can_manage_active",
            "is_owner",
            "create_block_reason",
            "can_switch",
            "switch_block_code",
        ],
    )?;
    let permissions = permissions
        .as_object()
        .ok_or_else(worker_response_invalid)?;
    for key in ["can_create", "can_manage_active", "is_owner"] {
        if !permissions.get(key).is_some_and(Value::is_boolean) {
            return Err(worker_response_invalid());
        }
    }
    if !permissions.get("can_switch").is_some_and(Value::is_boolean) {
        return Err(worker_response_invalid());
    }
    // Deliberately structural rather than an enumerated literal set. The block
    // codes are a worker-owned vocabulary that this projection discards, so
    // pinning the list here would turn every future worker code into the same
    // total `/v1/status` rejection this check was added to fix.
    let switch_block_code = permissions
        .get("switch_block_code")
        .ok_or_else(worker_response_invalid)?;
    if !switch_block_code.is_null()
        && !switch_block_code.as_str().is_some_and(|code| {
            !code.is_empty()
                && code.len() <= 64
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
        })
    {
        return Err(worker_response_invalid());
    }
    let block_reason = permissions
        .get("create_block_reason")
        .ok_or_else(worker_response_invalid)?;
    if !block_reason.is_null()
        && !matches!(
            block_reason.as_str(),
            Some("gpu_stop_pending" | "submission_store_corrupt")
        )
    {
        return Err(worker_response_invalid());
    }
    let can_create = permissions
        .get("can_create")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let can_manage_active = permissions
        .get("can_manage_active")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let is_owner = permissions
        .get("is_owner")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if can_create && !block_reason.is_null() {
        return Err(worker_response_invalid());
    }
    let active = body.get("active_batch").filter(|value| !value.is_null());
    if let Some(active) = active {
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
        let active: StudioActiveBatchProjection =
            serde_json::from_value(active.clone()).map_err(|_| worker_response_invalid())?;
        validate_studio_active_batch(&active)?;
    }
    let status_semantically_invalid = (active.is_some() && can_create)
        || (is_owner && active.is_none())
        || (can_manage_active && !is_owner)
        || (body.get("ready").and_then(Value::as_bool) == Some(true)
            && active.is_none()
            && !can_create
            && block_reason.is_null())
        || (active.is_some() && block_reason.as_str() == Some("gpu_stop_pending"));
    if status_semantically_invalid {
        return Err(worker_response_invalid());
    }
    Ok(())
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
    // Version-1 manifests predate durable client submission IDs. Preserve the
    // field on the desktop wire as nullable for those legacy records while
    // validating every new value. The private fingerprint/envelope fields are
    // intentionally never selected into this projection.
    let client_submission_id = match body.get("client_submission_id") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(value)) => {
            parse_submission_uuid(value).map_err(|_| worker_response_invalid())?;
            Value::String(value.clone())
        }
        Some(_) => return Err(worker_response_invalid()),
    };
    projected.insert("client_submission_id".into(), client_submission_id);
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

fn project_worker_error(status: StatusCode, body: &Value) -> NativeResult<Value> {
    validate_worker_error_envelope_shape(body)?;
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
    let expected_status = match code {
        "submission_store_corrupt" => Some(StatusCode::SERVICE_UNAVAILABLE),
        "submission_conflict" => Some(StatusCode::CONFLICT),
        "submission_not_found" => Some(StatusCode::NOT_FOUND),
        "queue_stop_pending" | "batch_busy" | "gpu_stop_pending" => Some(StatusCode::LOCKED),
        _ => None,
    };
    if expected_status.is_some_and(|expected| expected != status) {
        return Err(worker_response_invalid());
    }
    let details = match code {
        "queue_stop_pending" => {
            let details = error.get("details").ok_or_else(worker_response_invalid)?;
            require_exact_keys(details, &["request_id", "requester", "state", "expires_at"])?;
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
                .filter(|state| matches!(*state, "pending" | "approved"))
                .ok_or_else(worker_response_invalid)?;
            let expires_at = details
                .get("expires_at")
                .and_then(Value::as_str)
                .ok_or_else(worker_response_invalid)?;
            validate_studio_timestamp(expires_at)?;
            json!({
                "request_id": request_id,
                "requester": requester,
                "state": state,
                "expires_at": expires_at,
            })
        }
        "submission_store_corrupt" => {
            if error.get("details") != Some(&Value::Null)
                || message
                    != "Worker submission history is unavailable. Repair the shared volume before starting generation."
            {
                return Err(worker_response_invalid());
            }
            Value::Null
        }
        "submission_conflict" | "submission_not_found" => {
            if error.get("details") != Some(&Value::Null) {
                return Err(worker_response_invalid());
            }
            Value::Null
        }
        _ => Value::Null,
    };
    Ok(json!({"error": {"code": code, "message": message, "details": details}}))
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
    if error.len() != 3
        || !error.contains_key("code")
        || !error.contains_key("message")
        || !error.contains_key("details")
    {
        return Err(worker_response_invalid());
    }
    if !error
        .get("details")
        .is_some_and(|details| details.is_null() || details.is_object())
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
            "gpu_switch_request": null,
            "gpu_switch_can_respond": false,
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

    fn pending_gpu_switch_fixture() -> Value {
        let mut state = studio_state_fixture();
        state["sessions"] = json!([
            state["sessions"][0].clone(),
            state["sessions"][1].clone(),
            {
                "session_id": "44444444-4444-4444-8444-444444444444",
                "display_name": "Sujal mobile",
                "availability": "foreground",
                "expires_at": "2026-08-03T10:20:45.123Z"
            }
        ]);
        state["current_session"] = state["sessions"][2].clone();
        state["gpu_switch_request"] = json!({
            "schema_version": 1,
            "switch_id": "77777777-7777-4777-8777-777777777777",
            "old_pod_id": "shared-pod-1",
            "old_gpu_id": "NVIDIA RTX 4090",
            "old_gpu_display_name": "RTX 4090",
            "initial_target_gpu_id": "NVIDIA L4",
            "initial_target_gpu_display_name": "NVIDIA L4",
            "initial_replacement_attempt_id": "88888888-8888-4888-8888-888888888888",
            "requester": {
                "session_id": "22222222-2222-4222-8222-222222222222",
                "display_name": "Lakshman"
            },
            "state": "pending",
            "reason": null,
            "requested_at": "2026-08-03T10:20:30.123Z",
            "response_deadline": "2026-08-03T10:21:00.123Z",
            "ready_to_delete_at": null,
            "waiting_for": [{
                "session_id": "33333333-3333-4333-8333-333333333333",
                "display_name": "Sujal"
            }],
            "approved_by": [],
            "denied_by": [],
            "batch_id": null,
            "batch_owner": null,
            "batch_state_at_finalization": null,
            "replacement_attempt_id": null,
            "replacement_attempt_revision": null,
            "replacement_pod_id": null,
            "actual_target_gpu_id": null
        });
        state["gpu_switch_can_respond"] = json!(true);
        state
    }

    fn uuid4(value: &str) -> Uuid {
        parse_studio_uuid(value, "test_uuid_invalid").unwrap()
    }

    fn normal_stop_finalization_plan() -> NativeWorkerNormalStopFinalizePlanV1 {
        NativeWorkerNormalStopFinalizePlanV1 {
            operation_id: "44444444-4444-4444-8444-444444444444".to_owned(),
            request_id: "55555555-5555-4555-8555-555555555555".to_owned(),
            session_id: "22222222-2222-4222-8222-222222222222".to_owned(),
            pod_id: "shared-pod-1".to_owned(),
            finalization_id: "66666666-6666-4666-8666-666666666666".to_owned(),
            expected_server_instance_id: "11111111-1111-4111-8111-111111111111".to_owned(),
        }
    }

    fn finalizing_stop_projection() -> StudioStateProjection {
        let mut state = studio_state_fixture();
        state["stop_request"]["state"] = json!("finalizing");
        state["stop_request"]["waiting_for"] = json!([]);
        state["stop_request"]["approved_by"] = json!([{
            "session_id": "33333333-3333-4333-8333-333333333333",
            "display_name": "Sujal"
        }]);
        state["stop_request"]["finalization_expires_at"] = json!("2026-08-03T10:20:45.123Z");
        state["stop_request"]["finalization_id"] = json!("66666666-6666-4666-8666-666666666666");
        serde_json::from_value(state).expect("finalizing Stop fixture must deserialize")
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
            client_submission_id: "00000000-0000-4000-8000-000000000001".into(),
            admission_mode: AdmissionMode::Foreground,
        })
        .is_ok());
        let long_prompt = format!("DO-NOT-ECHO-THIS-{}", "x".repeat(5_000));
        assert!(validate_create_batch(&CreateBatchInput {
            prompts: vec![long_prompt],
            base_seed: 0,
            references: vec![],
            aspect_ratio: "16:9".into(),
            client_submission_id: "00000000-0000-4000-8000-000000000001".into(),
            admission_mode: AdmissionMode::Foreground,
        })
        .is_ok());
        for prompts in [vec![], vec![" ".into()], vec!["contains\0null".into()]] {
            let error = validate_create_batch(&CreateBatchInput {
                prompts,
                base_seed: 0,
                references: vec![],
                aspect_ratio: "16:9".into(),
                client_submission_id: "00000000-0000-4000-8000-000000000001".into(),
                admission_mode: AdmissionMode::Foreground,
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
            client_submission_id: "00000000-0000-4000-8000-000000000001".into(),
            admission_mode: AdmissionMode::Queue,
        });
        assert_eq!(payload["prompts"][0], "guided frame");
        assert_eq!(payload["base_seed"], 17);
        assert_eq!(payload["aspect_ratio"], "1:1");
        assert_eq!(payload["references"][0]["name"], "anchor.png");
        assert_eq!(payload["references"][0]["mime_type"], "image/png");
        assert_eq!(payload["references"][0]["data_hex"], "89504e47");
        assert!(payload["references"][0].get("bytes").is_none());
        assert_eq!(
            payload["client_submission_id"],
            "00000000-0000-4000-8000-000000000001"
        );
        assert_eq!(payload["admission_mode"], "queue");
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
        assert!(projected["client_submission_id"].is_null());
        assert!(projected.get("cleanup_tombstones").is_none());

        let mut owner_manifest = manifest.clone();
        owner_manifest["client_submission_id"] = json!("00000000-0000-4000-8000-000000000002");
        owner_manifest["request_fingerprint"] = json!("must-not-cross");
        owner_manifest["private_envelope"] = json!({"owner_user_id": "must-not-cross"});
        let owner_projection =
            project_worker_success(WorkerOperation::Manifest, &owner_manifest).unwrap();
        assert_eq!(
            owner_projection["client_submission_id"],
            "00000000-0000-4000-8000-000000000002"
        );
        assert!(owner_projection.get("request_fingerprint").is_none());
        assert!(owner_projection.get("private_envelope").is_none());
    }

    #[test]
    fn worker_errors_are_sanitized_and_saved_secret_reflection_is_rejected() {
        let error = json!({
            "schema_version": 1,
            "error": {"code": "batch_busy", "message": "Another batch is active.", "details": {"owner": "Owner"}}
        });
        validate_worker_envelope(StatusCode::LOCKED, &error).unwrap();
        assert_eq!(
            project_worker_error(StatusCode::LOCKED, &error).unwrap(),
            json!({"error": {"code": "batch_busy", "message": "Another batch is active.", "details": null}})
        );
        let mut injected = error.clone();
        injected["error"]["traceback"] = json!("must not cross");
        assert_eq!(
            validate_worker_envelope(StatusCode::LOCKED, &injected)
                .unwrap_err()
                .code,
            "worker_response_invalid"
        );
        let mut missing_details = error.clone();
        missing_details["error"]
            .as_object_mut()
            .unwrap()
            .remove("details");
        assert_eq!(
            validate_worker_envelope(StatusCode::LOCKED, &missing_details)
                .unwrap_err()
                .code,
            "worker_response_invalid"
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
    fn status_permissions_carry_the_switch_fields_the_worker_actually_sends() {
        // `StatusPermissions` in the 0.1.3 worker also carries `can_switch`
        // and `switch_block_code`. Rejecting them stalls every `/v1/status`
        // poll, which blocks Generate entirely. The renderer contract stays
        // the four documented keys, so the extra pair is validated here and
        // dropped in projection rather than widening the IPC surface.
        let status = json!({
            "schema_version": 1,
            "ready": true,
            "active_batch": null,
            "permissions": {
                "can_create": true,
                "can_manage_active": false,
                "is_owner": false,
                "create_block_reason": null,
                "can_switch": true,
                "switch_block_code": null
            }
        });
        let projected = project_worker_success(WorkerOperation::Status, &status).unwrap();
        assert_eq!(
            projected,
            json!({
                "schema_version": 1,
                "ready": true,
                "active_batch": null,
                "permissions": {
                    "can_create": true,
                    "can_manage_active": false,
                    "is_owner": false,
                    "create_block_reason": null
                }
            })
        );

        let mut blocked = status.clone();
        blocked["permissions"]["can_switch"] = json!(false);
        blocked["permissions"]["switch_block_code"] = json!("gpu_switch_pending");
        assert!(project_worker_success(WorkerOperation::Status, &blocked).is_ok());

        // A closed shape stays closed: an unknown key is still a rejection.
        let mut unknown = status.clone();
        unknown["permissions"]["future_flag"] = json!(true);
        assert_eq!(
            project_worker_success(WorkerOperation::Status, &unknown)
                .unwrap_err()
                .code,
            "worker_response_invalid"
        );

        let mut wrong_type = status.clone();
        wrong_type["permissions"]["can_switch"] = json!("yes");
        assert_eq!(
            project_worker_success(WorkerOperation::Status, &wrong_type)
                .unwrap_err()
                .code,
            "worker_response_invalid"
        );
    }

    #[test]
    fn status_and_submission_corruption_envelopes_match_the_python_queue_contract() {
        // This is the exact Python `StatusResponse`/WorkerError wire shape
        // used when a v2 submission envelope cannot be trusted. Keep the
        // native projection strict so a corrupt poll never turns into a
        // retryable busy response in the TypeScript scheduler.
        let status = json!({
            "schema_version": 1,
            "ready": true,
            "active_batch": null,
            "permissions": {
                "can_create": false,
                "can_manage_active": false,
                "is_owner": false,
                "create_block_reason": "submission_store_corrupt",
                "can_switch": false,
                "switch_block_code": null
            }
        });
        // The projection is the renderer contract, which stays the four
        // documented permission keys even though the worker sends six.
        let projected = json!({
            "schema_version": 1,
            "ready": true,
            "active_batch": null,
            "permissions": {
                "can_create": false,
                "can_manage_active": false,
                "is_owner": false,
                "create_block_reason": "submission_store_corrupt"
            }
        });
        validate_worker_envelope(StatusCode::OK, &status).unwrap();
        assert_eq!(
            project_worker_success(WorkerOperation::Status, &status).unwrap(),
            projected
        );

        let mut finalizing_stop = status.clone();
        finalizing_stop["permissions"]["create_block_reason"] = json!("gpu_stop_pending");
        let mut finalizing_stop_projected = projected.clone();
        finalizing_stop_projected["permissions"]["create_block_reason"] = json!("gpu_stop_pending");
        assert_eq!(
            project_worker_success(WorkerOperation::Status, &finalizing_stop).unwrap(),
            finalizing_stop_projected
        );

        let mut unexpected_reason = status.clone();
        unexpected_reason["permissions"]["create_block_reason"] = json!("batch_busy");
        assert_eq!(
            project_worker_success(WorkerOperation::Status, &unexpected_reason)
                .unwrap_err()
                .code,
            "worker_response_invalid"
        );
        let mut missing_reason = status.clone();
        missing_reason["permissions"]
            .as_object_mut()
            .unwrap()
            .remove("create_block_reason");
        assert_eq!(
            project_worker_success(WorkerOperation::Status, &missing_reason)
                .unwrap_err()
                .code,
            "worker_response_invalid"
        );

        let corruption = json!({
            "schema_version": 1,
            "error": {
                "code": "submission_store_corrupt",
                "message": "Worker submission history is unavailable. Repair the shared volume before starting generation.",
                "details": null
            }
        });
        validate_worker_envelope(StatusCode::SERVICE_UNAVAILABLE, &corruption).unwrap();
        assert_eq!(
            project_worker_error(StatusCode::SERVICE_UNAVAILABLE, &corruption).unwrap(),
            json!({
                "error": {
                    "code": "submission_store_corrupt",
                    "message": "Worker submission history is unavailable. Repair the shared volume before starting generation.",
                    "details": null
                }
            })
        );
        let mut leaked_details = corruption.clone();
        leaked_details["error"]["details"] = json!({"path": "/shared/private"});
        assert_eq!(
            validate_worker_envelope(StatusCode::SERVICE_UNAVAILABLE, &leaked_details)
                .unwrap_err()
                .code,
            "worker_response_invalid"
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
    fn all_seven_studio_transport_plans_have_exact_method_path_auth_and_body() {
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

        let gpu_switch = uuid4("77777777-7777-4777-8777-777777777777");
        let switch_response =
            studio_gpu_switch_response_plan(gpu_switch, session_id, StudioStopDecision::Approve);
        assert_studio_plan(
            &switch_response,
            Method::POST,
            "/v1/studio/gpu-switches/77777777-7777-4777-8777-777777777777/responses",
            Some(json!({
                "schema_version": 1,
                "session_id": session_id,
                "decision": "approve",
            })),
            WorkerOperation::StudioGpuSwitchResponse,
            None,
        );
    }

    #[test]
    fn gpu_switch_peer_response_uses_worker_capability_not_waiting_session_identity() {
        let alternate_peer_session = uuid4("44444444-4444-4444-8444-444444444444");
        let switch_id = uuid4("77777777-7777-4777-8777-777777777777");
        let alternate_peer = pending_gpu_switch_fixture();
        let projected = project_studio_state(&alternate_peer)
            .expect("worker-computed alternate peer capability must project");
        assert_eq!(projected["gpu_switch_can_respond"], Value::Bool(true));
        assert!(bind_studio_response(
            WorkerHttpResponse {
                status: 200,
                body: projected,
            },
            StudioResponseBinding::RespondToGpuSwitch {
                switch_id,
                session_id: alternate_peer_session,
            },
        )
        .is_ok());

        let mut requester = pending_gpu_switch_fixture();
        requester["current_session"] = requester["sessions"][0].clone();
        requester["gpu_switch_can_respond"] = json!(true);
        assert_eq!(
            project_studio_state(&requester).unwrap_err().code,
            "worker_response_invalid"
        );

        let mut approved = pending_gpu_switch_fixture();
        approved["gpu_switch_request"]["state"] = json!("approved");
        approved["gpu_switch_request"]["waiting_for"] = json!([]);
        approved["gpu_switch_request"]["approved_by"] = json!([{
            "session_id": "44444444-4444-4444-8444-444444444444",
            "display_name": "Sujal mobile"
        }]);
        approved["gpu_switch_can_respond"] = json!(false);
        assert!(project_studio_state(&approved).is_ok());
        approved["gpu_switch_can_respond"] = json!(true);
        assert_eq!(
            project_studio_state(&approved).unwrap_err().code,
            "worker_response_invalid"
        );
    }

    #[test]
    fn public_gpu_switch_lookup_accepts_live_pausing_without_private_finalization_proof() {
        let switch_id = "77777777-7777-4777-8777-777777777777";
        let pausing = NativeWorkerGpuSwitchPublicLookupV1 {
            schema_version: 1,
            switch_id: switch_id.to_owned(),
            state: NativeWorkerGpuSwitchStateV1::Pausing,
            replacement_attempt_id: None,
            replacement_attempt_revision: None,
            replacement_pod_id: None,
            actual_target_gpu_id: None,
        };
        assert!(validate_gpu_switch_public_lookup(&pausing, switch_id).is_ok());

        let mut partial = pausing;
        partial.state = NativeWorkerGpuSwitchStateV1::ReplacementReady;
        partial.replacement_attempt_id = Some("88888888-8888-4888-8888-888888888888".to_owned());
        assert_eq!(
            validate_gpu_switch_public_lookup(&partial, switch_id)
                .unwrap_err()
                .code,
            "gpu_switch_worker_response_invalid"
        );
    }

    fn runtime_identity_fixture(switch_id: &str) -> NativeWorkerGpuSwitchRuntimeIdentityV1 {
        NativeWorkerGpuSwitchRuntimeIdentityV1 {
            schema_version: 1,
            switch_id: switch_id.to_owned(),
            principal_binding_id: "88888888-8888-4888-8888-888888888888".to_owned(),
            server_instance_id: "99999999-9999-4999-8999-999999999999".to_owned(),
            runtime_pod_id: "replacement-pod-1".to_owned(),
            runtime_volume_id: "kdqerqkwdh".to_owned(),
            runtime_data_center_id: "EU-RO-1".to_owned(),
            data_root_binding_sha256:
                "1111111111111111111111111111111111111111111111111111111111111111".to_owned(),
            expected_provider_gpu_id: "NVIDIA GeForce RTX 4090".to_owned(),
            device_count: 1,
            cuda_device: NativeWorkerCudaDeviceIdentityV1 {
                device_index: 0,
                nvml_uuid: "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".to_owned(),
                pci_device_id: "0x2684".to_owned(),
                cuda_name: "NVIDIA GeForce RTX 4090".to_owned(),
                total_memory_bytes: 24_000_000_000,
                compute_capability_major: 8,
                compute_capability_minor: 9,
            },
            image_digest: IMAGEFORGE_WORKER_IMAGE_DIGEST.to_owned(),
            model_id: IMAGEFORGE_MODEL_ID.to_owned(),
            model_revision: IMAGEFORGE_MODEL_REVISION.to_owned(),
            create_contract_revision: 1,
            create_marker_sha256:
                "2222222222222222222222222222222222222222222222222222222222222222".to_owned(),
            replacement_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_owned(),
            replacement_attempt_revision: 1,
        }
    }

    #[test]
    fn runtime_identity_fake_transport_covers_success_loss_rejection_and_mismatch() {
        let switch_id = "77777777-7777-4777-8777-777777777777";
        let identity = runtime_identity_fixture(switch_id);
        let body = serde_json::to_vec(&identity).unwrap();

        assert!(matches!(
            map_gpu_switch_runtime_identity_response(StatusCode::OK, &body, switch_id),
            Ok(NativeWorkerGpuSwitchRuntimeIdentityResultV1::Found(found)) if found == identity
        ));

        let malformed = br#"{"schema_version":1,"switch_id":"broken"}"#;
        assert_eq!(
            map_gpu_switch_runtime_identity_response(StatusCode::OK, malformed, switch_id)
                .unwrap_err()
                .code,
            "gpu_switch_runtime_identity_unavailable"
        );

        let mut mismatch = identity.clone();
        mismatch.switch_id = "88888888-8888-4888-8888-888888888888".to_owned();
        assert_eq!(
            map_gpu_switch_runtime_identity_response(
                StatusCode::OK,
                &serde_json::to_vec(&mismatch).unwrap(),
                switch_id,
            )
            .unwrap_err()
            .code,
            "gpu_switch_runtime_identity_unavailable"
        );

        let rejected = json!({
            "schema_version": 1,
            "error": {
                "code": "gpu_switch_request_not_found",
                "message": "The GPU switch request does not exist.",
                "details": null
            }
        });
        assert!(matches!(
            map_gpu_switch_runtime_identity_response(
                StatusCode::NOT_FOUND,
                &serde_json::to_vec(&rejected).unwrap(),
                switch_id,
            ),
            Ok(NativeWorkerGpuSwitchRuntimeIdentityResultV1::Rejected(error))
                if error.code == "gpu_switch_request_not_found"
        ));

        let loss = worker_transport_error(WorkerTransportFailure::Response);
        assert_eq!(loss.code, "worker_network_error");
        assert!(loss.retryable);
    }

    #[test]
    fn runtime_identity_is_strictly_mapped_and_uses_mixed_wire_naming() {
        let switch_id = "77777777-7777-4777-8777-777777777777";
        let identity = NativeWorkerGpuSwitchRuntimeIdentityV1 {
            schema_version: 1,
            switch_id: switch_id.to_owned(),
            principal_binding_id: "88888888-8888-4888-8888-888888888888".to_owned(),
            server_instance_id: "99999999-9999-4999-8999-999999999999".to_owned(),
            runtime_pod_id: "replacement-pod-1".to_owned(),
            runtime_volume_id: "kdqerqkwdh".to_owned(),
            runtime_data_center_id: "EU-RO-1".to_owned(),
            data_root_binding_sha256:
                "1111111111111111111111111111111111111111111111111111111111111111".to_owned(),
            expected_provider_gpu_id: "NVIDIA GeForce RTX 4090".to_owned(),
            device_count: 1,
            cuda_device: NativeWorkerCudaDeviceIdentityV1 {
                device_index: 0,
                nvml_uuid: "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".to_owned(),
                pci_device_id: "0x2684".to_owned(),
                cuda_name: "NVIDIA GeForce RTX 4090".to_owned(),
                total_memory_bytes: 24_000_000_000,
                compute_capability_major: 8,
                compute_capability_minor: 9,
            },
            image_digest: IMAGEFORGE_WORKER_IMAGE_DIGEST.to_owned(),
            model_id: IMAGEFORGE_MODEL_ID.to_owned(),
            model_revision: IMAGEFORGE_MODEL_REVISION.to_owned(),
            create_contract_revision: 1,
            create_marker_sha256:
                "2222222222222222222222222222222222222222222222222222222222222222".to_owned(),
            replacement_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_owned(),
            replacement_attempt_revision: 1,
        };
        validate_gpu_switch_runtime_identity(&identity, switch_id).unwrap();
        let wire = serde_json::to_value(&identity).unwrap();
        assert!(wire.get("runtime_pod_id").is_some());
        assert!(wire["cuda_device"].get("deviceIndex").is_some());
        assert!(wire["cuda_device"].get("device_index").is_none());
        assert!(gpu_switch_runtime_identity_sha256(&identity).is_ok());

        let mut wrong_device = identity.clone();
        wrong_device.cuda_device.pci_device_id = "0x0000".to_owned();
        assert_eq!(
            validate_gpu_switch_runtime_identity(&wrong_device, switch_id)
                .unwrap_err()
                .code,
            "gpu_switch_runtime_identity_unavailable"
        );
        let mut unknown = wire;
        unknown["cuda_device"]["unexpected"] = json!(true);
        assert!(
            strict_gpu_switch_json::<NativeWorkerGpuSwitchRuntimeIdentityV1>(
                &serde_json::to_vec(&unknown).unwrap()
            )
            .is_err()
        );

        let contract: Value = serde_json::from_str(include_str!(
            "../../../contracts/gpu-runtime-identities-v1.json"
        ))
        .unwrap();
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../contracts/gpu-runtime-identities-v1.vectors.json"
        ))
        .unwrap();
        assert_eq!(contract, vectors);
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
    fn normal_stop_finalization_marker_accepts_only_the_exact_private_plan() {
        let plan = normal_stop_finalization_plan();
        let projection = finalizing_stop_projection();
        assert!(validate_native_normal_stop_finalizing_projection(&plan, &projection).is_ok());

        let mut wrong_server = projection.clone();
        wrong_server.server_instance_id = "77777777-7777-4777-8777-777777777777".to_owned();
        assert_eq!(
            validate_native_normal_stop_finalizing_projection(&plan, &wrong_server)
                .unwrap_err()
                .code,
            "stop_request_in_progress"
        );

        let mut wrong_finalization = projection;
        wrong_finalization
            .stop_request
            .as_mut()
            .expect("fixture has a Stop request")
            .finalization_id = Some("88888888-8888-4888-8888-888888888888".to_owned());
        assert_eq!(
            validate_native_normal_stop_finalizing_projection(&plan, &wrong_finalization)
                .unwrap_err()
                .code,
            "stop_request_in_progress"
        );
    }

    #[test]
    fn normal_stop_finalization_marker_rejects_a_concurrent_worker_switch() {
        let plan = normal_stop_finalization_plan();
        let mut state = studio_state_fixture();
        state["stop_request"]["state"] = json!("finalizing");
        state["stop_request"]["waiting_for"] = json!([]);
        state["stop_request"]["approved_by"] = json!([{
            "session_id": "33333333-3333-4333-8333-333333333333",
            "display_name": "Sujal"
        }]);
        state["stop_request"]["finalization_expires_at"] = json!("2026-08-03T10:20:45.123Z");
        state["stop_request"]["finalization_id"] = json!("66666666-6666-4666-8666-666666666666");
        let switch = pending_gpu_switch_fixture();
        state["gpu_switch_request"] = switch["gpu_switch_request"].clone();
        state["gpu_switch_can_respond"] = json!(false);
        let projection: StudioStateProjection =
            serde_json::from_value(state).expect("concurrent Switch fixture must deserialize");

        assert_eq!(
            validate_native_normal_stop_finalizing_projection(&plan, &projection)
                .unwrap_err()
                .code,
            "gpu_switch_request_in_progress"
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
