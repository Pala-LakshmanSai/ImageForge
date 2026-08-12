use super::session::validate_pod_id;
use super::{CredentialKind, CredentialVault, NativeError, NativeResult};
use futures_util::StreamExt;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use url::Url;

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const REST_HOST: &str = "rest.runpod.io";
const INVENTORY_HOST: &str = "api.runpod.io";
const DELETE_GRANT_TTL: Duration = Duration::from_secs(30);
const CREATE_GRANT_TTL: Duration = Duration::from_secs(30);
const EMERGENCY_GPU_ID: &str = "NVIDIA RTX 2000 Ada Generation";
// These values are the native trust boundary for production provisioning.
// The renderer may import a profile, but it must not be able to redirect a
// paid Pod to another template, volume, or worker image.
const IMAGEFORGE_TEMPLATE_ID: &str = "q8sfgixfy2";
const IMAGEFORGE_NETWORK_VOLUME_ID: &str = "ukh207b26r";
const IMAGEFORGE_WORKER_IMAGE: &str =
    "ghcr.io/pala-lakshmansai/imageforge-worker@sha256:5606ac29b07f85b831bba1e6aa359d32b99c55027679eb871f0166fa3bd3773e";
const IMAGEFORGE_VOLUME_MOUNT_PATH: &str = "/workspace";
const IMAGEFORGE_WORKER_PORT: u16 = 8000;

#[derive(Debug, Clone, PartialEq, Eq)]
struct RunPodProfileBinding {
    template_id: String,
    network_volume_id: String,
}

/// Monotonic process-local profile binding epoch. A completed provider read
/// may replace verified Pod authority only if the exact binding generation it
/// started under is still current. This prevents a late response from an old
/// credential/profile binding from repopulating the freshly cleared registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RunPodProfileGeneration(u64);

#[derive(Debug, Clone)]
struct DeleteGrant {
    pod_id: String,
    verified_at: Instant,
}

/// A one-use Task 014 grant. Unlike the legacy delete grant this binds both
/// the durable switch transaction and exact Pod ID, so a prior generic GET
/// can never accidentally authorize a coordinated destructive operation.
#[derive(Debug, Clone)]
struct SwitchDeleteGrant {
    switch_id: String,
    pod_id: String,
    issued_at: Instant,
}

/// One private, single-use ordinary Stop deletion authority. It is distinct
/// from both legacy generic termination and coordinated Switch deletion so a
/// prior list/GET or another operation cannot authorize this socket write.
#[derive(Debug, Clone)]
struct NormalStopDeleteGrant {
    operation_id: String,
    pod_id: String,
    issued_at: Instant,
}

#[derive(Debug, Clone)]
struct ForegroundGrant {
    token: String,
    issued_at: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VerifiedManagedPod {
    pod_name: String,
    gpu_id: String,
    gpu_display_name: String,
    dynamic_catalog_gpu: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedCreateAttempt {
    schema_version: u8,
    attempt_id: String,
    attempted_at_unix_ms: u64,
    pod_name: String,
    gpu_ids: Vec<String>,
    template_id: String,
    network_volume_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunPodCreateMarkerMetadata {
    pub pending: bool,
    pub attempt_id: Option<String>,
    pub attempted_at_unix_ms: Option<u64>,
    pub pod_name: Option<String>,
    pub gpu_id: Option<String>,
    pub pod_id: Option<String>,
}

#[derive(Debug)]
struct CreateMarkerStore {
    directory: PathBuf,
    io: Mutex<()>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunPodOperation {
    Inventory,
    ListPods,
    CreatePod,
    GetPod,
    TerminatePod,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunPodHttpRequest {
    pub operation: RunPodOperation,
    pub method: String,
    pub url: String,
    pub body: Option<Value>,
    pub create_grant: Option<String>,
    pub emergency_grant: Option<String>,
}

impl RunPodHttpRequest {
    pub fn get(operation: RunPodOperation, url: String) -> Self {
        Self {
            operation,
            method: "GET".to_owned(),
            url,
            body: None,
            create_grant: None,
            emergency_grant: None,
        }
    }

    pub fn post(
        operation: RunPodOperation,
        url: String,
        body: Value,
        create_grant: String,
        emergency_grant: Option<String>,
    ) -> Self {
        Self {
            operation,
            method: "POST".to_owned(),
            url,
            body: Some(body),
            create_grant: Some(create_grant),
            emergency_grant,
        }
    }

    pub fn delete(operation: RunPodOperation, url: String) -> Self {
        Self {
            operation,
            method: "DELETE".to_owned(),
            url,
            body: None,
            create_grant: None,
            emergency_grant: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPodHttpResponse {
    pub status: u16,
    pub body: String,
    pub retry_after: Option<String>,
    pub content_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NormalStartListPod {
    id: String,
    name: String,
    template_id: String,
    image_name: String,
    network_volume: NormalStartNetworkVolume,
    volume_mount_path: String,
    interruptible: bool,
    gpu: NormalStartGpu,
    machine: NormalStartMachine,
    gpu_count: u64,
    ports: Vec<String>,
    desired_status: Option<String>,
    status: Option<String>,
    adjusted_cost_per_hr: Option<Box<serde_json::value::RawValue>>,
    cost_per_hr: Option<Box<serde_json::value::RawValue>>,
    created_at: Option<String>,
    last_started_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NormalStartNetworkVolume {
    id: String,
    data_center_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NormalStartGpu {
    id: String,
    display_name: String,
    count: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NormalStartMachine {
    secure_cloud: bool,
    data_center_id: String,
    gpu_type_id: String,
}

impl NormalStartListPod {
    fn is_strictly_safe(&self, profile: &RunPodProfileBinding) -> bool {
        safe_identifier(&self.id, false)
            && safe_identifier(&self.name, true)
            && self.name.starts_with("imageforge-")
            && self.template_id == profile.template_id
            && self.network_volume.id == profile.network_volume_id
            && self.network_volume.data_center_id == "EU-RO-1"
            && self.volume_mount_path == "/workspace"
            && !self.interruptible
            && self.gpu_count == 1
            && self.gpu.count == 1
            && safe_gpu_identifier(&self.gpu.id)
            && safe_gpu_identifier(&self.gpu.display_name)
            && self.machine.secure_cloud
            && self.machine.data_center_id == "EU-RO-1"
            && self.machine.gpu_type_id == self.gpu.id
            && self.ports.len() == 1
            && self.ports.first().is_some_and(|port| port == "8000/http")
            && self.image_name == IMAGEFORGE_WORKER_IMAGE
    }
}

/// Raw catalog bodies stay entirely inside the native boundary.  The selector
/// needs the original JSON number lexemes for price validation, so projecting
/// through `serde_json::Value` here would be a lossy authority boundary.
#[derive(Debug, Clone)]
pub(crate) struct NativeCatalogBody {
    pub body: String,
}

/// The raw create response is likewise private.  The inventory controller
/// extracts the exact adjusted-cost token before returning the small safe
/// manual-start projection to the renderer.
#[derive(Debug, Clone)]
pub(crate) struct NativeCreatedPodResponse {
    pub raw_body: String,
    pub projected_body: String,
}

/// A native-only socket boundary notification. It exists solely so the
/// installed queue release harness can reject paid provider mutations before
/// their first byte is sent; renderer code cannot install or invoke it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeRunPodMutationKind {
    Create,
    Delete,
}

/// A fully profile-validated provider Pod projection for native lifecycle
/// orchestration. It is not a Tauri wire type; the command layer decides which
/// minimal fields, if any, are safe to return to React.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NativeRunPodManagedPodV1 {
    pub pod_id: String,
    pub pod_name: String,
    pub gpu_id: String,
    pub gpu_display_name: String,
    pub hourly_price_micro_usd: Option<u64>,
    pub status: String,
    pub provider_response_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeRunPodDeleteDispositionV1 {
    Deleted,
    NotFound,
    Uncertain,
}

/// Private replacement-create plan assembled exclusively from the bound
/// ImageForge profile and durable switch identity. Neither the body nor its
/// hashes are a renderer capability.
#[derive(Debug, Clone)]
pub(crate) struct NativeRunPodSwitchCreatePlanV1 {
    body: Value,
    canonical_body: String,
    pub request_sha256: String,
    pub create_marker_sha256: String,
    pub create_intent_sha256: String,
    pub create_wire_body_sha256: String,
    pub target_gpu_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NativeRunPodSwitchCreateResultV1 {
    pub pod: NativeRunPodManagedPodV1,
    pub provider_response_sha256: String,
}

/// Immutable profile fields that a replacement worker must report through the
/// owner-only runtime identity route.  This stays native-only and prevents the
/// renderer from supplying a volume, region, image, or model binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NativeRunPodSwitchRuntimeBindingV1 {
    pub network_volume_id: String,
    pub data_center_id: &'static str,
    pub image_digest: &'static str,
}

type NativeRunPodMutationHook =
    Arc<dyn Fn(NativeRunPodMutationKind) -> NativeResult<()> + Send + Sync + 'static>;

#[derive(Clone)]
pub struct RunPodTransport {
    client: Client,
    vault: Arc<dyn CredentialVault>,
    profile: Arc<RwLock<Option<RunPodProfileBinding>>>,
    profile_generation: Arc<Mutex<RunPodProfileGeneration>>,
    /// Owned by `GpuPodService`, not renderer input. It fences verified-Pod
    /// registry replacement when a Stop-owned R+1/R+2 observation supersedes
    /// an already awaited background heartbeat under the same profile.
    pod_observation_generation: Arc<Mutex<u64>>,
    delete_grant: Arc<Mutex<Option<DeleteGrant>>>,
    switch_delete_grant: Arc<Mutex<Option<SwitchDeleteGrant>>>,
    normal_stop_delete_grant: Arc<Mutex<Option<NormalStopDeleteGrant>>>,
    create_grant: Arc<Mutex<Option<ForegroundGrant>>>,
    emergency_grant: Arc<Mutex<Option<ForegroundGrant>>>,
    catalog_dynamic_gpus: Arc<RwLock<HashMap<String, String>>>,
    verified_pods: Arc<RwLock<HashMap<String, VerifiedManagedPod>>>,
    create_marker: Arc<CreateMarkerStore>,
    mutation_hook: Arc<RwLock<Option<NativeRunPodMutationHook>>>,
}

impl RunPodTransport {
    pub fn new(vault: Arc<dyn CredentialVault>) -> NativeResult<Self> {
        Self::new_with_marker_directory(vault, default_marker_directory()?)
    }

    fn new_with_marker_directory(
        vault: Arc<dyn CredentialVault>,
        marker_directory: PathBuf,
    ) -> NativeResult<Self> {
        let client = Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(12))
            .timeout(Duration::from_secs(60))
            .user_agent("ImageForge/0.1 desktop")
            .build()
            .map_err(|_| {
                NativeError::new(
                    "http_client_unavailable",
                    "The secure network client could not be initialized.",
                )
            })?;
        Ok(Self {
            client,
            vault,
            profile: Arc::new(RwLock::new(None)),
            profile_generation: Arc::new(Mutex::new(RunPodProfileGeneration(0))),
            pod_observation_generation: Arc::new(Mutex::new(0)),
            delete_grant: Arc::new(Mutex::new(None)),
            switch_delete_grant: Arc::new(Mutex::new(None)),
            normal_stop_delete_grant: Arc::new(Mutex::new(None)),
            create_grant: Arc::new(Mutex::new(None)),
            emergency_grant: Arc::new(Mutex::new(None)),
            catalog_dynamic_gpus: Arc::new(RwLock::new(HashMap::new())),
            verified_pods: Arc::new(RwLock::new(HashMap::new())),
            create_marker: Arc::new(CreateMarkerStore::new(marker_directory)),
            mutation_hook: Arc::new(RwLock::new(None)),
        })
    }

    pub(crate) fn set_native_mutation_hook(
        &self,
        hook: Option<NativeRunPodMutationHook>,
    ) -> NativeResult<()> {
        *self.mutation_hook.write().map_err(|_| state_error())? = hook;
        Ok(())
    }

    /// Call exactly at the native provider write boundary. The hook is absent
    /// for normal launches; queue-release smoke installs one that records and
    /// rejects the mutation before any socket write.
    pub(crate) fn before_native_mutation(
        &self,
        kind: NativeRunPodMutationKind,
    ) -> NativeResult<()> {
        let hook = self
            .mutation_hook
            .read()
            .map_err(|_| state_error())?
            .clone();
        if let Some(hook) = hook {
            hook(kind)?;
        }
        Ok(())
    }

    #[cfg(test)]
    fn new_for_test(
        vault: Arc<dyn CredentialVault>,
        marker_directory: PathBuf,
    ) -> NativeResult<Self> {
        Self::new_with_marker_directory(vault, marker_directory)
    }

    pub fn bind_profile(&self, template_id: &str, network_volume_id: &str) -> NativeResult<()> {
        if !safe_identifier(template_id, false) || !safe_identifier(network_volume_id, false) {
            return Err(NativeError::new(
                "runpod_profile_invalid",
                "The RunPod template or network-volume identifier is invalid.",
            ));
        }
        validate_approved_profile_ids(template_id, network_volume_id)?;
        if !self
            .create_marker
            .binding_matches(template_id, network_volume_id)?
        {
            return Err(NativeError::new(
                "pod_create_reconciliation_required",
                "The pending Pod create attempt must be reconciled with its original studio profile.",
            ));
        }
        let mut profile = self.profile.write().map_err(|_| state_error())?;
        let mut profile_generation = self.profile_generation.lock().map_err(|_| state_error())?;
        let next_profile_generation = profile_generation
            .0
            .checked_add(1)
            .map(RunPodProfileGeneration)
            .ok_or_else(state_error)?;
        *profile = Some(RunPodProfileBinding {
            template_id: template_id.to_owned(),
            network_volume_id: network_volume_id.to_owned(),
        });
        *profile_generation = next_profile_generation;
        if let Ok(mut grant) = self.delete_grant.lock() {
            *grant = None;
        }
        if let Ok(mut grant) = self.switch_delete_grant.lock() {
            *grant = None;
        }
        if let Ok(mut grant) = self.normal_stop_delete_grant.lock() {
            *grant = None;
        }
        self.clear_start_authorization()?;
        self.catalog_dynamic_gpus
            .write()
            .map_err(|_| state_error())?
            .clear();
        self.verified_pods
            .write()
            .map_err(|_| state_error())?
            .clear();
        Ok(())
    }

    /// Snapshot the monotonic local profile binding epoch without issuing a
    /// provider request. GPU action coordinators capture it before preflight
    /// and recheck it immediately before their destructive socket boundaries.
    pub(crate) fn gpu_control_profile_generation(&self) -> NativeResult<u64> {
        Ok(self.profile_generation.lock().map_err(|_| state_error())?.0)
    }

    /// A private, canonical binding for the immutable profile that a GPU
    /// switch must preserve. The renderer never supplies this value: a
    /// switched Pod can only reuse ImageForge's configured template, image,
    /// volume, mount, secure lane, region, and worker port.
    pub(crate) fn gpu_switch_profile_binding_sha256(&self) -> NativeResult<String> {
        let profile = self
            .profile
            .read()
            .map_err(|_| state_error())?
            .clone()
            .ok_or_else(|| {
                NativeError::new(
                    "gpu_switch_profile_locked",
                    "The ImageForge GPU profile is not available for this switch.",
                )
            })?;
        validate_approved_profile_ids(&profile.template_id, &profile.network_volume_id).map_err(
            |_| {
                NativeError::new(
                    "gpu_switch_profile_locked",
                    "The ImageForge GPU profile changed before this switch could begin.",
                )
            },
        )?;
        let canonical = super::gpu_inventory::jcs_value(&serde_json::json!({
            "schema_version": 1,
            "template_id": profile.template_id,
            "image_identity": IMAGEFORGE_WORKER_IMAGE,
            "network_volume_id": profile.network_volume_id,
            "volume_mount_path": IMAGEFORGE_VOLUME_MOUNT_PATH,
            "worker_port": IMAGEFORGE_WORKER_PORT,
            "cloud": "secure",
            "data_center_id": "EU-RO-1",
            "gpu_count": 1,
            "interruptible": false,
        }))
        .map_err(|_| {
            NativeError::new(
                "gpu_switch_profile_locked",
                "The ImageForge GPU profile could not be bound for this switch.",
            )
        })?;
        Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
    }

    pub(crate) fn gpu_switch_runtime_binding(
        &self,
    ) -> NativeResult<NativeRunPodSwitchRuntimeBindingV1> {
        let profile = self.bound_switch_profile()?;
        Ok(NativeRunPodSwitchRuntimeBindingV1 {
            network_volume_id: profile.network_volume_id,
            data_center_id: "EU-RO-1",
            image_digest: IMAGEFORGE_WORKER_IMAGE,
        })
    }

    pub fn authorize_create(&self) -> NativeResult<String> {
        if self.create_marker.metadata()?.pending {
            return Err(NativeError::new(
                "pod_create_reconciliation_required",
                "A prior Pod create attempt must be reconciled before starting another Pod.",
            ));
        }
        self.issue_grant(&self.create_grant)
    }

    pub fn authorize_emergency_gpu(&self) -> NativeResult<String> {
        self.issue_grant(&self.emergency_grant)
    }

    pub fn clear_start_authorization(&self) -> NativeResult<()> {
        *self.create_grant.lock().map_err(|_| state_error())? = None;
        *self.emergency_grant.lock().map_err(|_| state_error())? = None;
        Ok(())
    }

    pub fn create_marker_metadata(&self) -> NativeResult<RunPodCreateMarkerMetadata> {
        self.create_marker.metadata()
    }

    pub fn resolve_create_marker(
        &self,
        attempt_id: &str,
        reconciled_pod_id: Option<&str>,
    ) -> NativeResult<()> {
        let marker = self.create_marker.metadata()?;
        if marker.attempt_id.as_deref() != Some(attempt_id) {
            return Err(NativeError::new(
                "pod_create_resolution_mismatch",
                "The create-attempt resolution did not match the pending native marker.",
            ));
        }
        if marker.pod_id.is_some() && marker.pod_id.as_deref() != reconciled_pod_id {
            return Err(NativeError::new(
                "pod_create_resolution_mismatch",
                "The exact Pod recorded by the native create attempt must be reconciled before the marker can be cleared.",
            ));
        }
        if let Some(pod_id) = reconciled_pod_id {
            self.assert_verified_pod(pod_id)?;
            if marker
                .pod_id
                .as_deref()
                .is_some_and(|exact| exact != pod_id)
            {
                return Err(NativeError::new(
                    "pod_create_resolution_mismatch",
                    "The reconciled Pod did not match the exact native create marker.",
                ));
            }
            let pods = self.verified_pods.read().map_err(|_| state_error())?;
            let pod = pods.get(pod_id).ok_or_else(state_error)?;
            if Some(pod.pod_name.as_str()) != marker.pod_name.as_deref()
                || !self
                    .create_marker
                    .requested_gpu_ids()?
                    .iter()
                    .any(|gpu_id| gpu_id == &pod.gpu_id)
            {
                return Err(NativeError::new(
                    "pod_create_resolution_mismatch",
                    "The reconciled Pod identity did not match the pending create attempt.",
                ));
            }
        }
        self.create_marker.clear(attempt_id)
    }

    fn issue_grant(&self, slot: &Mutex<Option<ForegroundGrant>>) -> NativeResult<String> {
        let token = uuid::Uuid::new_v4().to_string();
        *slot.lock().map_err(|_| state_error())? = Some(ForegroundGrant {
            token: token.clone(),
            issued_at: Instant::now(),
        });
        Ok(token)
    }

    pub fn assert_verified_pod(&self, pod_id: &str) -> NativeResult<()> {
        validate_pod_id(pod_id)?;
        if self
            .verified_pods
            .read()
            .map_err(|_| state_error())?
            .contains_key(pod_id)
        {
            Ok(())
        } else {
            Err(NativeError::new(
                "worker_pod_unverified",
                "The worker must be verified as the current managed ImageForge Pod first.",
            ))
        }
    }

    /// Fail before reserving an inventory observation when secure storage is
    /// unavailable or corrupt. Otherwise the two catalog workers would erase
    /// the credential error and incorrectly publish a provider-unavailable
    /// fallback snapshot.
    pub(crate) fn assert_catalog_credential(&self) -> NativeResult<()> {
        self.vault.load(CredentialKind::RunpodApiKey).map(|_| ())
    }

    /// Fetch one pinned inventory endpoint without exposing a URL, headers,
    /// provider body, or credential to Tauri IPC.  It validates the transport
    /// envelope and secret-reflection guard while deliberately preserving the
    /// original JSON bytes for the lossless selector decoder.
    pub(crate) async fn native_catalog_datacenters(&self) -> NativeResult<NativeCatalogBody> {
        self.native_catalog_get("https://api.runpod.io/v2/catalog/datacenters")
            .await
    }

    /// See `native_catalog_datacenters`. The query ordering is literal and
    /// pinned by the Task 014 inventory contract.
    pub(crate) async fn native_catalog_gpus(&self) -> NativeResult<NativeCatalogBody> {
        self.native_catalog_get(
            "https://api.runpod.io/v2/catalog/gpus?include=AVAILABILITY&product=POD&count=1&cloud=SECURE&minCudaVersion=13.0",
        )
        .await
    }

    async fn native_catalog_get(&self, raw_url: &str) -> NativeResult<NativeCatalogBody> {
        let url = Url::parse(raw_url).map_err(|_| state_error())?;
        validate_common_url(&url)?;
        validate_inventory(&Method::GET, &url, None)?;
        let credential = self.vault.load(CredentialKind::RunpodApiKey)?;
        let worker_credential = self.vault.load(CredentialKind::WorkerToken).ok();
        let response = self
            .client
            .request(Method::GET, url)
            .header(ACCEPT, "application/json")
            .header(AUTHORIZATION, format!("Bearer {credential}"))
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    NativeError::retryable(
                        "runpod_timeout",
                        "RunPod inventory did not answer before the native deadline.",
                    )
                } else {
                    NativeError::retryable(
                        "runpod_network_error",
                        "RunPod could not be reached over the secure network connection.",
                    )
                }
            })?;
        match response.status().as_u16() {
            200 => {}
            401 | 403 => {
                return Err(NativeError::new(
                    "runpod_auth_failed",
                    "RunPod rejected the saved API credential.",
                ))
            }
            429 => {
                return Err(NativeError::retryable(
                    "runpod_rate_limited",
                    "RunPod inventory is temporarily rate limited.",
                ))
            }
            500..=599 => {
                return Err(NativeError::retryable(
                    "runpod_provider_unavailable",
                    "RunPod inventory is temporarily unavailable.",
                ))
            }
            _ => {
                return Err(NativeError::new(
                    "runpod_response_invalid",
                    "RunPod inventory returned an unexpected response.",
                ))
            }
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(';')
                    .next()
                    .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
            });
        if !content_type {
            return Err(response_invalid());
        }
        let body = read_bounded_body(response, MAX_RESPONSE_BYTES).await?;
        if body.is_empty() {
            return Err(response_invalid());
        }
        // Parse only for structural JSON/secret-reflection validation. Return
        // the untouched text so price fields retain their exact JSON tokens.
        let parsed: Value = serde_json::from_str(&body).map_err(|_| response_invalid())?;
        reject_secret_reflection(
            &parsed,
            [&credential, worker_credential.as_deref().unwrap_or("")],
        )?;
        Ok(NativeCatalogBody { body })
    }

    /// Final normal-manual Start preflight. This is a native-owned profile GET,
    /// distinct from the two catalog reads, and refuses to create beside any
    /// provider-returned Pod rather than guessing whether it is reusable.
    pub(crate) async fn native_preflight_no_managed_pod(&self) -> NativeResult<()> {
        let profile = self
            .profile
            .read()
            .map_err(|_| normal_start_error("gpu_start_profile_locked"))?
            .clone()
            .ok_or_else(|| normal_start_error("gpu_start_profile_locked"))?;
        validate_approved_profile_ids(&profile.template_id, &profile.network_volume_id)
            .map_err(|_| normal_start_error("gpu_start_profile_locked"))?;
        let template_id = url::form_urlencoded::byte_serialize(profile.template_id.as_bytes())
            .collect::<String>();
        let network_volume_id =
            url::form_urlencoded::byte_serialize(profile.network_volume_id.as_bytes())
                .collect::<String>();
        let url = format!(
            "https://rest.runpod.io/v1/pods?computeType=GPU&includeMachine=true&includeNetworkVolume=true&templateId={template_id}&networkVolumeId={network_volume_id}&dataCenterId=EU-RO-1"
        );
        let response = self
            .execute(RunPodHttpRequest::get(RunPodOperation::ListPods, url))
            .await
            .map_err(map_normal_start_preflight_error)?;
        match response.status {
            200 => {}
            401 | 403 => return Err(normal_start_error("gpu_start_provider_auth_failed")),
            429 => return Err(normal_start_error("gpu_start_provider_rate_limited")),
            500..=599 => return Err(normal_start_error("gpu_start_provider_unavailable")),
            _ => return Err(normal_start_error("gpu_start_provider_response_invalid")),
        }
        let pods = parse_normal_start_list_pods(&response.body, &profile)?;
        if pods.is_empty() {
            Ok(())
        } else {
            Err(normal_start_error("gpu_start_existing_pod"))
        }
    }

    /// Read the complete profile-scoped managed-Pod set for a switch/Stop
    /// decision. The URL, profile identifiers and projection checks are all
    /// native-owned; malformed or partial results fail closed rather than
    /// becoming an empty list.
    pub(crate) async fn native_switch_list_pods(
        &self,
    ) -> NativeResult<Vec<NativeRunPodManagedPodV1>> {
        let (pods, dynamic, profile_generation) = self.read_complete_profile_pods().await?;
        self.replace_verified_switch_pods_for_generation(&pods, &dynamic, profile_generation)?;
        Ok(pods)
    }

    /// The ordinary lifecycle projection has a deliberately smaller public
    /// error registry than the coordinated Switch reconciliation path.  Both
    /// routes consume the same complete, profile-pinned list and atomically
    /// replace the verified-Pod registry only after every row validates; only
    /// the safe classification presented to the renderer differs.
    pub(crate) async fn native_pod_observation_list_pods(
        &self,
        observation_generation: u64,
    ) -> NativeResult<Vec<NativeRunPodManagedPodV1>> {
        self.begin_pod_observation_generation(observation_generation)?;
        let (pods, dynamic, profile_generation) = self
            .read_complete_profile_pods()
            .await
            .map_err(map_pod_observation_list_error)?;
        // An overflowing but otherwise valid provider result is useful only
        // as the renderer-safe overflow outcome. It must not replace native
        // verified authority with a set that cannot cross IPC in full.
        self.replace_verified_pod_observation_for_generations(
            &pods,
            &dynamic,
            profile_generation,
            observation_generation,
        )
        .map_err(map_pod_observation_list_error)?;
        Ok(pods)
    }

    async fn read_complete_profile_pods(
        &self,
    ) -> NativeResult<(
        Vec<NativeRunPodManagedPodV1>,
        HashMap<String, String>,
        RunPodProfileGeneration,
    )> {
        let (profile, profile_generation) = self.bound_switch_profile_with_generation()?;
        // RunPod's documented `/v1/pods` response is one complete JSON array
        // rather than a cursor envelope. Treat a future object/cursor shape as
        // invalid instead of silently accepting a partial page; the parser
        // below therefore proves the whole list before any caller decides
        // whether it may replace verified-Pod authority.
        let body = self.native_switch_profile_list_body(&profile).await?;
        let dynamic = self.dynamic_catalog()?;
        let pods = parse_switch_managed_pod_list(&body, &profile, &dynamic)?;
        Ok((pods, dynamic, profile_generation))
    }

    fn begin_pod_observation_generation(&self, observation_generation: u64) -> NativeResult<()> {
        let mut current = self
            .pod_observation_generation
            .lock()
            .map_err(|_| state_error())?;
        if observation_generation < *current {
            return Err(profile_observation_superseded());
        }
        *current = observation_generation;
        Ok(())
    }

    fn replace_verified_pod_observation_for_generations(
        &self,
        pods: &[NativeRunPodManagedPodV1],
        dynamic: &HashMap<String, String>,
        profile_generation: RunPodProfileGeneration,
        observation_generation: u64,
    ) -> NativeResult<bool> {
        if pods.len() > 16 {
            return Ok(false);
        }
        self.replace_verified_switch_pods_for_generations(
            pods,
            dynamic,
            profile_generation,
            Some(observation_generation),
        )?;
        Ok(true)
    }

    async fn native_switch_profile_list_body(
        &self,
        profile: &RunPodProfileBinding,
    ) -> NativeResult<String> {
        let url = Url::parse(&profile_pod_list_url(profile))
            .map_err(|_| switch_provider_response_error())?;
        validate_common_url(&url).map_err(|_| switch_provider_response_error())?;
        validate_list_pods(&Method::GET, &url, None)
            .map_err(|_| switch_provider_response_error())?;
        validate_bound_list_profile(&url, profile).map_err(|_| switch_provider_response_error())?;
        let credential = self
            .vault
            .load(CredentialKind::RunpodApiKey)
            .map_err(map_switch_provider_error)?;
        let worker_credential = self.vault.load(CredentialKind::WorkerToken).ok();
        let response = self
            .client
            .get(url)
            .header(ACCEPT, "application/json")
            .header(AUTHORIZATION, format!("Bearer {credential}"))
            .send()
            .await
            .map_err(|_| {
                NativeError::retryable(
                    "gpu_switch_inventory_unavailable",
                    "Live RunPod GPU state is temporarily unavailable. Refresh before continuing the switch.",
                )
            })?;
        match response.status().as_u16() {
            200 => {}
            429 | 500..=599 => {
                return Err(NativeError::retryable(
                    "gpu_switch_inventory_unavailable",
                    "Live RunPod GPU state is temporarily unavailable. Refresh before continuing the switch.",
                ))
            }
            _ => return Err(switch_provider_response_error()),
        }
        let content_type_is_json = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(';')
                    .next()
                    .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
            });
        if !content_type_is_json {
            return Err(switch_provider_response_error());
        }
        let body = read_bounded_body(response, MAX_RESPONSE_BYTES)
            .await
            .map_err(map_switch_provider_error)?;
        if body.is_empty() {
            return Err(switch_provider_response_error());
        }
        let parsed: Value =
            serde_json::from_str(&body).map_err(|_| switch_provider_response_error())?;
        // The documented endpoint returns one complete JSON array. A future
        // cursor/envelope/pagination shape is not silently treated as an
        // empty first page: native has no verified continuation contract for
        // it, so it is an invalid/partial observation with zero registry
        // mutation.
        validate_complete_profile_list_shape(&parsed)?;
        reject_secret_reflection(
            &parsed,
            [&credential, worker_credential.as_deref().unwrap_or("")],
        )
        .map_err(|_| switch_provider_response_error())?;
        Ok(body)
    }

    fn replace_verified_switch_pods_for_generation(
        &self,
        pods: &[NativeRunPodManagedPodV1],
        dynamic: &HashMap<String, String>,
        profile_generation: RunPodProfileGeneration,
    ) -> NativeResult<()> {
        self.replace_verified_switch_pods_for_generations(pods, dynamic, profile_generation, None)
    }

    fn replace_verified_switch_pods_for_generations(
        &self,
        pods: &[NativeRunPodManagedPodV1],
        dynamic: &HashMap<String, String>,
        profile_generation: RunPodProfileGeneration,
        observation_generation: Option<u64>,
    ) -> NativeResult<()> {
        // Keep the profile read guard through registry replacement. A bind
        // holds the corresponding write guard, advances this generation, and
        // clears the registry; therefore a stale read either writes before
        // that clear or is rejected without changing verified authority.
        let _profile = self.profile.read().map_err(|_| state_error())?;
        let current_generation = *self.profile_generation.lock().map_err(|_| state_error())?;
        if current_generation != profile_generation {
            return Err(profile_observation_superseded());
        }
        if let Some(observation_generation) = observation_generation {
            let current_observation_generation = *self
                .pod_observation_generation
                .lock()
                .map_err(|_| state_error())?;
            if current_observation_generation != observation_generation {
                return Err(profile_observation_superseded());
            }
        }
        let verified = pods
            .iter()
            .map(|pod| {
                (
                    pod.pod_id.clone(),
                    VerifiedManagedPod {
                        pod_name: pod.pod_name.clone(),
                        gpu_id: pod.gpu_id.clone(),
                        gpu_display_name: pod.gpu_display_name.clone(),
                        dynamic_catalog_gpu: dynamic.get(&pod.gpu_id).is_some_and(|expected| {
                            normalize_catalog_name(expected)
                                == normalize_catalog_name(&pod.gpu_display_name)
                        }),
                    },
                )
            })
            .collect::<HashMap<_, _>>();
        *self.verified_pods.write().map_err(|_| state_error())? = verified;
        Ok(())
    }

    /// Exact native GET for one profile-validated Pod. A 404 is kept distinct
    /// from a malformed/ambiguous result so deletion reconciliation never
    /// mistakes a transport failure for absence.
    pub(crate) async fn native_switch_get_pod(
        &self,
        pod_id: &str,
    ) -> NativeResult<Option<NativeRunPodManagedPodV1>> {
        validate_pod_id(pod_id)?;
        let profile = self.bound_switch_profile()?;
        let url = format!(
            "https://rest.runpod.io/v1/pods/{pod_id}?includeMachine=true&includeNetworkVolume=true"
        );
        let response = self
            .execute(RunPodHttpRequest::get(RunPodOperation::GetPod, url))
            .await
            .map_err(map_switch_provider_error)?;
        match response.status {
            200 => parse_switch_managed_pod(&response.body, &profile, &self.dynamic_catalog()?)
                .map(Some),
            404 => Ok(None),
            _ => Err(switch_provider_response_error()),
        }
    }

    /// Mint a one-use delete authority only after the switch journal has
    /// committed the matching destructive intent and native preflight has
    /// validated this exact Pod/profile. The renderer cannot construct either
    /// binding or reuse an ordinary lifecycle GET as authority.
    pub(crate) fn authorize_native_switch_delete(
        &self,
        switch_id: &str,
        pod_id: &str,
    ) -> NativeResult<()> {
        if uuid::Uuid::parse_str(switch_id)
            .ok()
            .filter(|uuid| uuid.get_version() == Some(uuid::Version::Random))
            .is_none()
            || validate_pod_id(pod_id).is_err()
        {
            return Err(switch_provider_response_error());
        }
        *self
            .switch_delete_grant
            .lock()
            .map_err(|_| switch_provider_response_error())? = Some(SwitchDeleteGrant {
            switch_id: switch_id.to_owned(),
            pod_id: pod_id.to_owned(),
            issued_at: Instant::now(),
        });
        Ok(())
    }

    /// Send one exact native DELETE after `authorize_native_switch_delete`
    /// persisted/consumed the matching private authority. Ambiguous responses
    /// are deliberately returned as a third state and never converted to
    /// absence.
    pub(crate) async fn native_switch_delete_pod(
        &self,
        switch_id: &str,
        pod_id: &str,
    ) -> NativeResult<NativeRunPodDeleteDispositionV1> {
        validate_pod_id(pod_id)?;
        let grant = self
            .switch_delete_grant
            .lock()
            .map_err(|_| switch_provider_response_error())?
            .take();
        if !grant.is_some_and(|grant| {
            grant.switch_id == switch_id
                && grant.pod_id == pod_id
                && grant.issued_at.elapsed() <= DELETE_GRANT_TTL
        }) {
            return Err(switch_provider_response_error());
        }
        let url = format!("https://rest.runpod.io/v1/pods/{pod_id}");
        let url = Url::parse(&url).map_err(|_| switch_provider_response_error())?;
        validate_pod_item(&Method::DELETE, &url, None, true)
            .map_err(|_| switch_provider_response_error())?;
        let credential = self.vault.load(CredentialKind::RunpodApiKey)?;
        self.before_native_mutation(NativeRunPodMutationKind::Delete)?;
        let response = self
            .client
            .delete(url)
            .header(ACCEPT, "application/json")
            .header(AUTHORIZATION, format!("Bearer {credential}"))
            .send()
            .await;
        match response {
            Ok(response) => Ok(match response.status().as_u16() {
                204 => NativeRunPodDeleteDispositionV1::Deleted,
                404 => NativeRunPodDeleteDispositionV1::NotFound,
                _ => NativeRunPodDeleteDispositionV1::Uncertain,
            }),
            Err(_) => Ok(NativeRunPodDeleteDispositionV1::Uncertain),
        }
    }

    /// Mint one ordinary Stop DELETE authority only after native has checked
    /// the exact approved worker finalization and persisted its delete intent.
    /// This is deliberately distinct from Switch and legacy delete grants.
    pub(crate) fn authorize_native_normal_stop_delete(
        &self,
        operation_id: &str,
        pod_id: &str,
    ) -> NativeResult<()> {
        if !canonical_uuid_v4(operation_id) || validate_pod_id(pod_id).is_err() {
            return Err(normal_stop_provider_error());
        }
        *self
            .normal_stop_delete_grant
            .lock()
            .map_err(|_| normal_stop_provider_error())? = Some(NormalStopDeleteGrant {
            operation_id: operation_id.to_owned(),
            pod_id: pod_id.to_owned(),
            issued_at: Instant::now(),
        });
        Ok(())
    }

    /// Send the one native-authorized ordinary Stop DELETE. A transport or
    /// non-204/404 result is intentionally ambiguous: callers must preserve
    /// the worker finalization guard and never retry this operation by timer.
    pub(crate) async fn native_normal_stop_delete_pod(
        &self,
        operation_id: &str,
        pod_id: &str,
    ) -> NativeResult<NativeRunPodDeleteDispositionV1> {
        if !canonical_uuid_v4(operation_id) || validate_pod_id(pod_id).is_err() {
            return Err(normal_stop_provider_error());
        }
        let grant = self
            .normal_stop_delete_grant
            .lock()
            .map_err(|_| normal_stop_provider_error())?
            .take();
        if !grant.is_some_and(|grant| {
            grant.operation_id == operation_id
                && grant.pod_id == pod_id
                && grant.issued_at.elapsed() <= DELETE_GRANT_TTL
        }) {
            return Err(normal_stop_provider_error());
        }
        let url = format!("https://rest.runpod.io/v1/pods/{pod_id}");
        let url = Url::parse(&url).map_err(|_| normal_stop_provider_error())?;
        validate_pod_item(&Method::DELETE, &url, None, true)
            .map_err(|_| normal_stop_provider_error())?;
        let credential = self
            .vault
            .load(CredentialKind::RunpodApiKey)
            .map_err(|_| normal_stop_provider_error())?;
        self.before_native_mutation(NativeRunPodMutationKind::Delete)
            .map_err(|_| normal_stop_provider_error())?;
        let response = self
            .client
            .delete(url)
            .header(ACCEPT, "application/json")
            .header(AUTHORIZATION, format!("Bearer {credential}"))
            .send()
            .await;
        match response {
            Ok(response) => Ok(match response.status().as_u16() {
                204 => NativeRunPodDeleteDispositionV1::Deleted,
                404 => NativeRunPodDeleteDispositionV1::NotFound,
                _ => NativeRunPodDeleteDispositionV1::Uncertain,
            }),
            Err(_) => Ok(NativeRunPodDeleteDispositionV1::Uncertain),
        }
    }

    fn bound_switch_profile(&self) -> NativeResult<RunPodProfileBinding> {
        Ok(self.bound_switch_profile_with_generation()?.0)
    }

    fn bound_switch_profile_with_generation(
        &self,
    ) -> NativeResult<(RunPodProfileBinding, RunPodProfileGeneration)> {
        // Profile read -> generation mutex is the sole lock order for profile
        // snapshots. `bind_profile` takes the write side in the same order,
        // yielding one atomic profile/generation pair without serializing any
        // network request.
        let profile_guard = self
            .profile
            .read()
            .map_err(|_| switch_provider_response_error())?;
        let profile = profile_guard
            .clone()
            .ok_or_else(switch_provider_response_error)?;
        let profile_generation = *self
            .profile_generation
            .lock()
            .map_err(|_| switch_provider_response_error())?;
        validate_approved_profile_ids(&profile.template_id, &profile.network_volume_id)
            .map_err(|_| switch_provider_response_error())?;
        Ok((profile, profile_generation))
    }

    /// Construct one exact replacement-create request without accepting a
    /// provider URL, profile field, Pod name, or GPU fallback from React. The
    /// stable switch/attempt marker makes reconciliation distinguish this POST
    /// from every ordinary Start request.
    pub(crate) fn prepare_native_switch_create(
        &self,
        switch_id: &str,
        replacement_attempt_id: &str,
        replacement_attempt_revision: u64,
        target_gpu_id: &str,
    ) -> NativeResult<NativeRunPodSwitchCreatePlanV1> {
        if uuid::Uuid::parse_str(switch_id)
            .ok()
            .filter(|uuid| uuid.get_version() == Some(uuid::Version::Random))
            .is_none()
            || uuid::Uuid::parse_str(replacement_attempt_id)
                .ok()
                .filter(|uuid| uuid.get_version() == Some(uuid::Version::Random))
                .is_none()
            || replacement_attempt_revision == 0
            || replacement_attempt_revision > 9_007_199_254_740_991
            || !safe_gpu_identifier(target_gpu_id)
        {
            return Err(switch_provider_response_error());
        }
        let profile = self.bound_switch_profile()?;
        let name = format!("imageforge-switch-{replacement_attempt_id}");
        let create_marker = serde_json::json!({
            "schema_version": 1,
            "switch_id": switch_id,
            "replacement_attempt_id": replacement_attempt_id,
            "replacement_attempt_revision": replacement_attempt_revision,
            "target_gpu_id": target_gpu_id,
        });
        let create_marker_jcs = super::gpu_inventory::jcs_value(&create_marker)
            .map_err(|_| switch_provider_response_error())?;
        let create_marker_sha256 = hex::encode(Sha256::digest(create_marker_jcs.as_bytes()));
        let body = serde_json::json!({
            "name": name,
            "templateId": profile.template_id,
            "imageName": IMAGEFORGE_WORKER_IMAGE,
            "networkVolumeId": profile.network_volume_id,
            "volumeMountPath": IMAGEFORGE_VOLUME_MOUNT_PATH,
            "ports": [format!("{IMAGEFORGE_WORKER_PORT}/http")],
            "computeType": "GPU",
            "cloudType": "SECURE",
            "gpuTypeIds": [target_gpu_id],
            "gpuTypePriority": "custom",
            "gpuCount": 1,
            "interruptible": false,
            "dataCenterIds": ["EU-RO-1"],
            "env": {
                "IMAGEFORGE_EXPECTED_GPU_TYPE_ID": target_gpu_id,
                "IMAGEFORGE_GPU_SWITCH_ID": switch_id,
                "IMAGEFORGE_REPLACEMENT_ATTEMPT_ID": replacement_attempt_id,
                "IMAGEFORGE_REPLACEMENT_ATTEMPT_REVISION": replacement_attempt_revision.to_string(),
                "IMAGEFORGE_CREATE_CONTRACT_REVISION": "1",
                "IMAGEFORGE_CREATE_MARKER_SHA256": create_marker_sha256,
            },
            "allowedCudaVersions": ["13.0"],
            "minRAMPerGPU": 16,
        });
        let canonical_body =
            super::gpu_inventory::jcs_value(&body).map_err(|_| switch_provider_response_error())?;
        let create_wire_body_sha256 = hex::encode(Sha256::digest(canonical_body.as_bytes()));
        let create_intent = serde_json::json!({
            "schema_version": 1,
            "create_contract_revision": 1,
            "switch_id": switch_id,
            "replacement_attempt_id": replacement_attempt_id,
            "replacement_attempt_revision": replacement_attempt_revision,
            "request_body": body.clone(),
        });
        let create_intent_jcs = super::gpu_inventory::jcs_value(&create_intent)
            .map_err(|_| switch_provider_response_error())?;
        let create_intent_sha256 = hex::encode(Sha256::digest(create_intent_jcs.as_bytes()));
        let create_url = Url::parse("https://rest.runpod.io/v1/pods")
            .map_err(|_| switch_provider_response_error())?;
        validate_create_pod(&Method::POST, &create_url, Some(&body))
            .map_err(|_| switch_provider_response_error())?;
        validate_bound_create_profile(Some(&body), &profile)
            .map_err(|_| switch_provider_response_error())?;
        self.validate_create_gpu_policy(Some(&body))
            .map_err(|_| switch_provider_response_error())?;
        Ok(NativeRunPodSwitchCreatePlanV1 {
            body,
            request_sha256: create_wire_body_sha256.clone(),
            canonical_body,
            create_marker_sha256,
            create_intent_sha256,
            create_wire_body_sha256,
            target_gpu_id: target_gpu_id.to_owned(),
        })
    }

    /// Perform the exact POST committed by `prepare_native_switch_create`.
    /// The caller must have durably recorded the request fingerprint first;
    /// any result that cannot prove the full returned identity is an error so
    /// the switch journal parks as create-uncertain rather than creating again.
    pub(crate) async fn execute_native_switch_create(
        &self,
        plan: &NativeRunPodSwitchCreatePlanV1,
    ) -> NativeResult<NativeRunPodSwitchCreateResultV1> {
        let profile = self.bound_switch_profile()?;
        let url = Url::parse("https://rest.runpod.io/v1/pods")
            .map_err(|_| switch_provider_response_error())?;
        if super::gpu_inventory::jcs_value(&plan.body)
            .map_err(|_| switch_provider_response_error())?
            != plan.canonical_body
            || hex::encode(Sha256::digest(plan.canonical_body.as_bytes())) != plan.request_sha256
        {
            return Err(switch_provider_response_error());
        }
        validate_create_pod(&Method::POST, &url, Some(&plan.body))
            .map_err(|_| switch_provider_response_error())?;
        validate_bound_create_profile(Some(&plan.body), &profile)
            .map_err(|_| switch_provider_response_error())?;
        self.validate_create_gpu_policy(Some(&plan.body))
            .map_err(|_| switch_provider_response_error())?;
        let credential = self.vault.load(CredentialKind::RunpodApiKey)?;
        let worker_credential = self.vault.load(CredentialKind::WorkerToken).ok();
        self.before_native_mutation(NativeRunPodMutationKind::Create)?;
        let response = self
            .client
            .post(url)
            .header(ACCEPT, "application/json")
            .header(AUTHORIZATION, format!("Bearer {credential}"))
            .header(CONTENT_TYPE, "application/json")
            .body(plan.canonical_body.clone())
            .send()
            .await
            .map_err(|_| NativeError::new(
                "gpu_switch_create_uncertain",
                "RunPod may have created the replacement GPU. Reconcile the exact attempt before continuing.",
            ))?;
        if response.status().as_u16() != 201
            || !response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| {
                    value
                        .split(';')
                        .next()
                        .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
                })
        {
            return Err(NativeError::new(
                "gpu_switch_create_uncertain",
                "RunPod may have created the replacement GPU. Reconcile the exact attempt before continuing.",
            ));
        }
        let raw_body = read_bounded_body(response, MAX_RESPONSE_BYTES)
            .await
            .map_err(|_| NativeError::new(
                "gpu_switch_create_uncertain",
                "RunPod may have created the replacement GPU. Reconcile the exact attempt before continuing.",
            ))?;
        let raw: Value = serde_json::from_str(&raw_body).map_err(|_| NativeError::new(
            "gpu_switch_create_uncertain",
            "RunPod may have created the replacement GPU. Reconcile the exact attempt before continuing.",
        ))?;
        reject_secret_reflection(
            &raw,
            [&credential, worker_credential.as_deref().unwrap_or("")],
        )?;
        let pod = parse_switch_managed_pod_with_value(
            raw,
            &raw_body,
            &profile,
            &self.dynamic_catalog()?,
        )?;
        if pod.gpu_id != plan.target_gpu_id {
            return Err(switch_provider_response_error());
        }
        Ok(NativeRunPodSwitchCreateResultV1 {
            pod,
            provider_response_sha256: hex::encode(Sha256::digest(raw_body.as_bytes())),
        })
    }

    /// Issue and consume the legacy create grants wholly inside Rust.  No
    /// grant token, provider URL, or request body crosses renderer IPC.  The
    /// durable marker is written before the network write, preserving the
    /// existing ambiguous-create recovery behavior.
    pub(crate) async fn native_create_selected_pod(
        &self,
        body: Value,
        canonical_body: String,
    ) -> NativeResult<NativeCreatedPodResponse> {
        let profile = self
            .profile
            .read()
            .map_err(|_| state_error())?
            .clone()
            .ok_or_else(|| normal_start_error("gpu_start_profile_locked"))?;
        let url = Url::parse("https://rest.runpod.io/v1/pods").map_err(|_| state_error())?;
        if super::gpu_inventory::jcs_value(&body)? != canonical_body {
            return Err(normal_start_error("gpu_start_provider_response_invalid"));
        }
        validate_create_pod(&Method::POST, &url, Some(&body))?;
        validate_bound_create_profile(Some(&body), &profile)
            .map_err(|_| normal_start_error("gpu_start_profile_locked"))?;
        self.validate_create_gpu_policy(Some(&body))
            .map_err(|_| normal_start_error("gpu_start_provider_response_invalid"))?;
        if self.create_marker.metadata()?.pending {
            return Err(normal_start_error("gpu_start_operation_in_progress"));
        }
        self.create_marker
            .begin(&body)
            .map_err(|_| normal_start_error("gpu_start_store_unavailable"))?;
        let credential = self.vault.load(CredentialKind::RunpodApiKey)?;
        let worker_credential = self.vault.load(CredentialKind::WorkerToken).ok();
        self.before_native_mutation(NativeRunPodMutationKind::Create)?;
        let response = self
            .client
            .post(url)
            .header(ACCEPT, "application/json")
            .header(AUTHORIZATION, format!("Bearer {credential}"))
            .header(CONTENT_TYPE, "application/json")
            .body(canonical_body)
            .send()
            .await
            .map_err(|_| {
                NativeError::new(
                    "gpu_start_create_uncertain",
                    "The Pod create result is unknown; reconcile the exact native create marker before trying again.",
                )
            })?;
        if response.status().as_u16() != 201 {
            return Err(NativeError::new(
                "gpu_start_create_uncertain",
                "The Pod create result is unknown; reconcile the exact native create marker before trying again.",
            ));
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(';')
                    .next()
                    .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
            });
        if !content_type {
            return Err(NativeError::new(
                "gpu_start_create_uncertain",
                "The Pod create result is unknown; reconcile the exact native create marker before trying again.",
            ));
        }
        let raw_body = read_bounded_body(response, MAX_RESPONSE_BYTES)
            .await
            .map_err(|_| {
                NativeError::new(
                    "gpu_start_create_uncertain",
                    "The Pod create result is unknown; reconcile the exact native create marker before trying again.",
                )
            })?;
        let raw: Value = serde_json::from_str(&raw_body).map_err(|_| {
            NativeError::new(
                "gpu_start_create_uncertain",
                "The Pod create result is unknown; reconcile the exact native create marker before trying again.",
            )
        })?;
        reject_secret_reflection(
            &raw,
            [&credential, worker_credential.as_deref().unwrap_or("")],
        )?;
        let projected_body = self
            .project_and_register_created_pod(&raw, &body, &profile)
            .map_err(|_| {
                NativeError::new(
                    "gpu_start_create_uncertain",
                    "The Pod create result is unknown; reconcile the exact native create marker before trying again.",
                )
            })?;
        Ok(NativeCreatedPodResponse {
            raw_body,
            projected_body,
        })
    }

    pub async fn execute(&self, request: RunPodHttpRequest) -> NativeResult<RunPodHttpResponse> {
        let validated = ValidatedRequest::try_from(request)?;
        let profile = if validated.operation == RunPodOperation::Inventory {
            None
        } else {
            Some(
                self.profile
                    .read()
                    .map_err(|_| state_error())?
                    .clone()
                    .ok_or_else(|| {
                        NativeError::new(
                            "runpod_profile_unconfigured",
                            "Import and validate the ImageForge studio profile first.",
                        )
                    })?,
            )
        };
        if validated.operation == RunPodOperation::CreatePod {
            validate_bound_create_profile(validated.body.as_ref(), profile.as_ref().unwrap())?;
            self.validate_create_gpu_policy(validated.body.as_ref())?;
            self.consume_foreground_grants(
                validated.create_grant.as_deref(),
                validated.emergency_grant.as_deref(),
                validated.body.as_ref(),
            )?;
            self.create_marker
                .begin(validated.body.as_ref().ok_or_else(rejected)?)?;
        }
        if validated.operation == RunPodOperation::ListPods {
            validate_bound_list_profile(&validated.url, profile.as_ref().unwrap())?;
        }
        if validated.operation == RunPodOperation::TerminatePod {
            self.consume_delete_grant(validated.pod_id.as_deref().ok_or_else(rejected)?)?;
        }
        let credential = self.vault.load(CredentialKind::RunpodApiKey)?;
        let worker_credential = self.vault.load(CredentialKind::WorkerToken).ok();
        let mut builder = self
            .client
            .request(validated.method.clone(), validated.url.clone())
            .header(ACCEPT, "application/json")
            .header(AUTHORIZATION, format!("Bearer {credential}"));
        if let Some(body) = validated.body.as_ref() {
            builder = builder.header(CONTENT_TYPE, "application/json").json(&body);
        }
        if matches!(
            validated.operation,
            RunPodOperation::CreatePod | RunPodOperation::TerminatePod
        ) {
            self.before_native_mutation(
                native_mutation_kind_for_operation(validated.operation).ok_or_else(state_error)?,
            )?;
        }
        let response = builder.send().await.map_err(|error| {
            if error.is_timeout() {
                NativeError::retryable(
                    "runpod_timeout",
                    "RunPod did not answer before the native deadline.",
                )
            } else {
                NativeError::retryable(
                    "runpod_network_error",
                    "RunPod could not be reached over the secure network connection.",
                )
            }
        })?;
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(safe_retry_after);
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .filter(|value| {
                value
                    .split(';')
                    .next()
                    .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
            })
            .map(|_| "application/json".to_owned());

        let exact_success = status == expected_success_status(validated.operation);
        let mut body = if exact_success {
            read_bounded_body(response, MAX_RESPONSE_BYTES).await?
        } else {
            // Error bodies are intentionally not bridged into the renderer;
            // status and Retry-After are sufficient for the typed TS client.
            String::new()
        };
        if exact_success && validated.operation != RunPodOperation::TerminatePod {
            if content_type.is_none() || body.is_empty() {
                return Err(response_invalid());
            }
            let raw: Value = serde_json::from_str(&body).map_err(|_| response_invalid())?;
            reject_secret_reflection(
                &raw,
                [&credential, worker_credential.as_deref().unwrap_or("")],
            )?;
            body = match validated.operation {
                RunPodOperation::Inventory => {
                    self.record_catalog_gpus(&raw)?;
                    project_inventory_response(&validated.url, &raw)?
                }
                RunPodOperation::ListPods => {
                    self.project_and_register_pod_list(&raw, profile.as_ref().unwrap())?
                }
                RunPodOperation::CreatePod => self.project_and_register_created_pod(
                    &raw,
                    validated.body.as_ref().ok_or_else(rejected)?,
                    profile.as_ref().unwrap(),
                )?,
                RunPodOperation::GetPod => {
                    let pod_id = validated.pod_id.as_deref().ok_or_else(rejected)?;
                    self.project_and_register_pod(&raw, pod_id, profile.as_ref().unwrap())?;
                    self.record_delete_grant(pod_id)?;
                    let dynamic = self.dynamic_catalog_for_pod(pod_id)?;
                    serde_json::to_string(&project_pod_with_dynamic(&raw, &dynamic)?)
                        .map_err(|_| response_invalid())?
                }
                RunPodOperation::TerminatePod => String::new(),
            };
        }
        Ok(RunPodHttpResponse {
            status,
            body,
            retry_after,
            content_type,
        })
    }

    fn consume_foreground_grants(
        &self,
        create_token: Option<&str>,
        emergency_token: Option<&str>,
        body: Option<&Value>,
    ) -> NativeResult<()> {
        consume_grant(
            &self.create_grant,
            create_token,
            "pod_create_not_authorized",
        )?;
        let uses_emergency = body
            .and_then(Value::as_object)
            .and_then(|object| object.get("gpuTypeIds"))
            .and_then(Value::as_array)
            .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(EMERGENCY_GPU_ID)));
        if uses_emergency {
            consume_grant(
                &self.emergency_grant,
                emergency_token,
                "emergency_gpu_not_authorized",
            )?;
        } else if emergency_token.is_some() {
            return Err(NativeError::new(
                "emergency_gpu_not_authorized",
                "The emergency GPU authorization did not match this create request.",
            ));
        }
        Ok(())
    }

    fn validate_create_gpu_policy(&self, body: Option<&Value>) -> NativeResult<()> {
        let ids = body
            .and_then(Value::as_object)
            .and_then(|object| object.get("gpuTypeIds"))
            .and_then(Value::as_array)
            .ok_or_else(rejected)?;
        let dynamic = self
            .catalog_dynamic_gpus
            .read()
            .map_err(|_| state_error())?;
        if ids.iter().any(|id| {
            id.as_str()
                .is_none_or(|id| !approved_gpu_id(id) && !dynamic.contains_key(id))
        }) {
            return Err(rejected());
        }
        Ok(())
    }

    fn record_catalog_gpus(&self, raw: &Value) -> NativeResult<()> {
        let Some(gpus) = raw.get("gpus").and_then(Value::as_array) else {
            return Ok(());
        };
        let mut approved = HashMap::new();
        for item in gpus {
            let Some(gpu) = item.as_object() else {
                continue;
            };
            let Some(id) = gpu.get("id").and_then(Value::as_str) else {
                continue;
            };
            let Some(name) = gpu.get("name").and_then(Value::as_str) else {
                continue;
            };
            let manufacturer = gpu.get("manufacturer").and_then(Value::as_str);
            let memory = gpu.get("memory").and_then(Value::as_f64);
            let canonical_name = canonical_dynamic_gpu_name(name);
            let static_approved = approved_gpu_id(id);
            if !static_approved && canonical_name.is_none() {
                continue;
            }
            // Exact static IDs, including the 80/96 GB additions, are
            // validated by `approved_gpu_id` and the native inventory parser.
            // This map intentionally stores only the older dynamic Blackwell
            // IDs, whose catalog memory contract is 16..=32 GB.
            let memory_is_approved = memory.is_some_and(|memory| (16.0..=32.0).contains(&memory));
            if manufacturer.is_some_and(|value| normalize_catalog_name(value) == "NVIDIA")
                && memory_is_approved
                && safe_gpu_identifier(id)
                && id != "NVIDIA B200"
            {
                if let Some(canonical_name) = canonical_name {
                    approved.insert(id.to_owned(), canonical_name.to_owned());
                }
            }
        }
        *self
            .catalog_dynamic_gpus
            .write()
            .map_err(|_| state_error())? = approved;
        Ok(())
    }

    /// The strict native inventory decoder calls this only after the paired
    /// catalog observation has validated an approved dynamic Blackwell row.
    /// Keeping this mapping native preserves the existing managed-Pod identity
    /// check without accepting a renderer-proposed GPU name.
    pub(crate) fn native_replace_dynamic_catalog(
        &self,
        dynamic: HashMap<String, String>,
    ) -> NativeResult<()> {
        if dynamic.iter().any(|(id, name)| {
            !safe_gpu_identifier(id)
                || canonical_dynamic_gpu_name(name).is_none()
                || normalize_catalog_name(name)
                    != normalize_catalog_name(canonical_dynamic_gpu_name(name).unwrap_or(""))
        }) {
            return Err(response_invalid());
        }
        *self
            .catalog_dynamic_gpus
            .write()
            .map_err(|_| state_error())? = dynamic;
        Ok(())
    }

    fn dynamic_catalog(&self) -> NativeResult<HashMap<String, String>> {
        Ok(self
            .catalog_dynamic_gpus
            .read()
            .map_err(|_| state_error())?
            .clone())
    }

    fn dynamic_catalog_for_pod(&self, pod_id: &str) -> NativeResult<HashMap<String, String>> {
        let mut dynamic = self.dynamic_catalog()?;
        if let Some(retained) = self
            .verified_pods
            .read()
            .map_err(|_| state_error())?
            .get(pod_id)
            .filter(|pod| pod.dynamic_catalog_gpu)
        {
            dynamic.insert(retained.gpu_id.clone(), retained.gpu_display_name.clone());
        }
        Ok(dynamic)
    }

    fn register_verified_pod(&self, pod_id: &str, pod: &Value) -> NativeResult<()> {
        let gpu = pod
            .get("gpu")
            .and_then(Value::as_object)
            .ok_or_else(response_invalid)?;
        let pod_name = pod
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(response_invalid)?;
        let gpu_id = gpu
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(response_invalid)?;
        let gpu_display_name = gpu
            .get("displayName")
            .and_then(Value::as_str)
            .ok_or_else(response_invalid)?;
        let dynamic_catalog_gpu = self
            .catalog_dynamic_gpus
            .read()
            .map_err(|_| state_error())?
            .get(gpu_id)
            .is_some_and(|expected| {
                normalize_catalog_name(expected) == normalize_catalog_name(gpu_display_name)
            });
        self.verified_pods
            .write()
            .map_err(|_| state_error())?
            .insert(
                pod_id.to_owned(),
                VerifiedManagedPod {
                    pod_name: pod_name.to_owned(),
                    gpu_id: gpu_id.to_owned(),
                    gpu_display_name: gpu_display_name.to_owned(),
                    dynamic_catalog_gpu,
                },
            );
        let marker = self.create_marker.metadata()?;
        if marker.pod_id.as_deref() == Some(pod_id) {
            self.create_marker.clear(
                marker
                    .attempt_id
                    .as_deref()
                    .ok_or_else(create_marker_invalid)?,
            )?;
        }
        Ok(())
    }

    fn project_and_register_pod_list(
        &self,
        raw: &Value,
        profile: &RunPodProfileBinding,
    ) -> NativeResult<String> {
        let pods = raw.as_array().ok_or_else(response_invalid)?;
        let mut projected = Vec::with_capacity(pods.len());
        for pod in pods {
            // Same ownership rule as the observation list: a Pod this app did
            // not create is not ImageForge's to project, verify, or hand to the
            // renderer. RunPod auto-names unrelated Pods (`quiet_amber_moth`),
            // and such a Pod can carry any shape, so projecting it here failed
            // the whole list and made every Pod read fail while unrelated Pods
            // sat in the account.
            if !pod
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(imageforge_pod_name)
            {
                continue;
            }
            let dynamic = pod
                .get("id")
                .and_then(Value::as_str)
                .map(|pod_id| self.dynamic_catalog_for_pod(pod_id))
                .transpose()?
                .unwrap_or_default();
            let value = project_pod_with_dynamic(pod, &dynamic)?;
            let mut verified = false;
            if let Some(pod_id) = value.get("id").and_then(Value::as_str) {
                if validate_managed_pod_value(
                    &value,
                    pod_id,
                    profile,
                    &self.dynamic_catalog_for_pod(pod_id)?,
                )
                .is_ok()
                {
                    self.register_verified_pod(pod_id, &value)?;
                    verified = true;
                }
            }
            // Same terminal-Pod rule the observation list applies, enforced
            // here because this projection also feeds the Start preflight's
            // "does a managed Pod already exist" check. That check rejects the
            // whole list if any row is not strictly safe, so one historical
            // exited Pod left from an older pinned worker image blocked every
            // Start even once observation itself had been repaired.
            //
            // A terminal Pod is not an existing managed Pod: it is not
            // billing, it cannot be resumed into the current Pod, and it can
            // never become the duplicate this preflight exists to prevent.
            let terminal_state = value
                .get("status")
                .and_then(Value::as_str)
                .is_some_and(|status| matches!(status, "exited" | "terminated"));
            if !verified && terminal_state {
                continue;
            }
            projected.push(value);
        }
        self.retire_create_marker_against_list(pods)?;
        serde_json::to_string(&projected).map_err(|_| response_invalid())
    }

    /// Retire a create marker whose recorded Pod this complete provider list
    /// proves cannot be billing.
    ///
    /// The marker blocks a new Start so a Pod that RunPod created but this app
    /// cannot see never bills unnoticed. Clearing it required naming the exact
    /// recorded Pod *and* that Pod being verified, so a Pod stopped or
    /// terminated outside ImageForge could never be reconciled: it is absent,
    /// or present but stripped of its machine and GPU assignment and therefore
    /// unverifiable. The marker then stayed pending forever, every later Start
    /// failed as `create_uncertain`, and even the explicit recovery control
    /// could not clear it.
    ///
    /// This list is the provider's own complete Pod set for the bound profile,
    /// and an ImageForge-named Pod that is provisioning, starting, or running
    /// but unverifiable fails the observation before reaching here. So a
    /// recorded Pod that is missing from this list, or present in a terminal
    /// state, is not running and cannot bill.
    fn retire_create_marker_against_list(&self, pods: &[Value]) -> NativeResult<()> {
        let marker = self.create_marker.metadata()?;
        let (Some(attempt_id), Some(pod_id)) = (marker.attempt_id, marker.pod_id) else {
            return Ok(());
        };
        let recorded = pods.iter().find(|pod| {
            pod.get("id").and_then(Value::as_str) == Some(pod_id.as_str())
        });
        let retired = match recorded {
            None => true,
            Some(pod) => {
                let status = pod
                    .get("status")
                    .or_else(|| pod.get("desiredStatus"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                matches!(status.as_str(), "exited" | "terminated")
            }
        };
        if retired {
            self.create_marker.clear(&attempt_id)?;
        }
        Ok(())
    }

    fn project_and_register_created_pod(
        &self,
        raw: &Value,
        request_body: &Value,
        profile: &RunPodProfileBinding,
    ) -> NativeResult<String> {
        let raw_pod_id = raw
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(response_invalid)?;
        let dynamic = self.dynamic_catalog_for_pod(raw_pod_id)?;
        let projected = project_pod_with_dynamic(raw, &dynamic)?;
        let pod_id = projected
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(response_invalid)?;
        validate_managed_pod_value(
            &projected,
            pod_id,
            profile,
            &self.dynamic_catalog_for_pod(pod_id)?,
        )?;
        let requested_ids = request_body
            .get("gpuTypeIds")
            .and_then(Value::as_array)
            .ok_or_else(rejected)?;
        let actual = projected
            .get("gpu")
            .and_then(Value::as_object)
            .and_then(|gpu| gpu.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(response_invalid)?;
        if !requested_ids.iter().any(|id| id.as_str() == Some(actual))
            || projected.get("name") != request_body.get("name")
        {
            return Err(NativeError::new(
                "pod_identity_mismatch",
                "RunPod created a Pod outside the authorized ImageForge request.",
            ));
        }
        self.register_verified_pod(pod_id, &projected)?;
        self.create_marker.set_pod_id(pod_id)?;
        serde_json::to_string(&projected).map_err(|_| response_invalid())
    }

    fn project_and_register_pod(
        &self,
        raw: &Value,
        pod_id: &str,
        profile: &RunPodProfileBinding,
    ) -> NativeResult<()> {
        let dynamic = self.dynamic_catalog_for_pod(pod_id)?;
        let projected = project_pod_with_dynamic(raw, &dynamic)?;
        validate_managed_pod_value(
            &projected,
            pod_id,
            profile,
            &self.dynamic_catalog_for_pod(pod_id)?,
        )?;
        self.register_verified_pod(pod_id, &projected)
    }

    fn record_delete_grant(&self, pod_id: &str) -> NativeResult<()> {
        let mut grant = self.delete_grant.lock().map_err(|_| state_error())?;
        *grant = Some(DeleteGrant {
            pod_id: pod_id.to_owned(),
            verified_at: Instant::now(),
        });
        Ok(())
    }

    fn consume_delete_grant(&self, pod_id: &str) -> NativeResult<()> {
        let mut guard = self.delete_grant.lock().map_err(|_| state_error())?;
        let grant = guard.take().ok_or_else(|| {
            NativeError::new(
                "pod_delete_not_verified",
                "Refresh this exact ImageForge Pod before confirming termination.",
            )
        })?;
        if grant.pod_id != pod_id || grant.verified_at.elapsed() > DELETE_GRANT_TTL {
            return Err(NativeError::new(
                "pod_delete_not_verified",
                "The Pod verification expired or belongs to a different Pod; refresh and confirm again.",
            ));
        }
        Ok(())
    }
}

/// The release harness must observe exactly the paid provider mutation paths
/// and nothing else. Keeping this classification beside the socket boundary
/// makes the read-only List/Get rule independently testable.
fn native_mutation_kind_for_operation(
    operation: RunPodOperation,
) -> Option<NativeRunPodMutationKind> {
    match operation {
        RunPodOperation::CreatePod => Some(NativeRunPodMutationKind::Create),
        RunPodOperation::TerminatePod => Some(NativeRunPodMutationKind::Delete),
        RunPodOperation::Inventory | RunPodOperation::ListPods | RunPodOperation::GetPod => None,
    }
}

/// The ordinary Start path treats its profile list as an authority boundary:
/// no unknown top-level Pod fields, duplicate identities, or a partially
/// matching ImageForge Pod can be reinterpreted as an empty list.
fn parse_normal_start_list_pods(
    body: &str,
    profile: &RunPodProfileBinding,
) -> NativeResult<Vec<NormalStartListPod>> {
    let pods: Vec<NormalStartListPod> = serde_json::from_str(body)
        .map_err(|_| normal_start_error("gpu_start_provider_response_invalid"))?;
    let mut ids = std::collections::HashSet::new();
    if pods.iter().any(|pod| !ids.insert(pod.id.as_str()))
        || pods.iter().any(|pod| !pod.is_strictly_safe(profile))
    {
        return Err(normal_start_error("gpu_start_provider_response_invalid"));
    }
    Ok(pods)
}

fn expected_success_status(operation: RunPodOperation) -> u16 {
    match operation {
        RunPodOperation::Inventory | RunPodOperation::ListPods | RunPodOperation::GetPod => 200,
        RunPodOperation::CreatePod => 201,
        RunPodOperation::TerminatePod => 204,
    }
}

fn safe_retry_after(value: &str) -> Option<String> {
    let seconds = value.parse::<u32>().ok()?;
    (seconds <= 86_400).then(|| seconds.to_string())
}

impl CreateMarkerStore {
    fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            io: Mutex::new(()),
        }
    }

    fn pending_path(&self) -> PathBuf {
        self.directory.join("pending-create.json")
    }

    fn pod_id_path(&self) -> PathBuf {
        self.directory.join("exact-pod-id")
    }

    fn begin(&self, body: &Value) -> NativeResult<()> {
        let _guard = self.io.lock().map_err(|_| state_error())?;
        std::fs::create_dir_all(&self.directory).map_err(|_| create_marker_io_error())?;
        sync_directory_and_parent(&self.directory)?;
        if self.pending_path().exists() {
            return Err(NativeError::new(
                "pod_create_reconciliation_required",
                "A prior Pod create attempt must be reconciled before starting another Pod.",
            ));
        }
        let object = body.as_object().ok_or_else(rejected)?;
        let pod_name = object
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(rejected)?;
        let gpu_ids = object
            .get("gpuTypeIds")
            .and_then(Value::as_array)
            .ok_or_else(rejected)?
            .iter()
            .map(|id| id.as_str().map(str::to_owned).ok_or_else(rejected))
            .collect::<NativeResult<Vec<_>>>()?;
        if gpu_ids.is_empty() {
            return Err(rejected());
        }
        let template_id = object
            .get("templateId")
            .and_then(Value::as_str)
            .ok_or_else(rejected)?;
        let network_volume_id = object
            .get("networkVolumeId")
            .and_then(Value::as_str)
            .ok_or_else(rejected)?;
        let marker = PersistedCreateAttempt {
            schema_version: 1,
            attempt_id: uuid::Uuid::new_v4().to_string(),
            attempted_at_unix_ms: unix_time_ms(),
            pod_name: pod_name.to_owned(),
            gpu_ids,
            template_id: template_id.to_owned(),
            network_volume_id: network_volume_id.to_owned(),
        };
        let encoded = serde_json::to_vec(&marker).map_err(|_| create_marker_io_error())?;
        write_new_durable(&self.pending_path(), &encoded)?;
        sync_directory(&self.directory)?;
        Ok(())
    }

    fn set_pod_id(&self, pod_id: &str) -> NativeResult<()> {
        validate_pod_id(pod_id)?;
        let _guard = self.io.lock().map_err(|_| state_error())?;
        if !self.pending_path().is_file() {
            return Err(create_marker_invalid());
        }
        match write_new_durable(&self.pod_id_path(), pod_id.as_bytes()) {
            Ok(()) => {}
            Err(error) if error.code == "pod_create_marker_exists" => {
                let existing = std::fs::read_to_string(self.pod_id_path())
                    .map_err(|_| create_marker_io_error())?;
                if existing != pod_id {
                    return Err(create_marker_invalid());
                }
            }
            Err(error) => return Err(error),
        }
        sync_directory(&self.directory)
    }

    fn binding_matches(&self, template_id: &str, network_volume_id: &str) -> NativeResult<bool> {
        let _guard = self.io.lock().map_err(|_| state_error())?;
        let encoded = match std::fs::read(self.pending_path()) {
            Ok(encoded) => encoded,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
            Err(_) => return Err(create_marker_io_error()),
        };
        let marker: PersistedCreateAttempt =
            serde_json::from_slice(&encoded).map_err(|_| create_marker_invalid())?;
        validate_persisted_create_attempt(&marker)?;
        Ok(marker.template_id == template_id && marker.network_volume_id == network_volume_id)
    }

    fn requested_gpu_ids(&self) -> NativeResult<Vec<String>> {
        let _guard = self.io.lock().map_err(|_| state_error())?;
        let encoded = std::fs::read(self.pending_path()).map_err(|_| create_marker_invalid())?;
        let marker: PersistedCreateAttempt =
            serde_json::from_slice(&encoded).map_err(|_| create_marker_invalid())?;
        validate_persisted_create_attempt(&marker)?;
        Ok(marker.gpu_ids)
    }

    fn metadata(&self) -> NativeResult<RunPodCreateMarkerMetadata> {
        let _guard = self.io.lock().map_err(|_| state_error())?;
        let pending_path = self.pending_path();
        if !pending_path.exists() {
            return Ok(RunPodCreateMarkerMetadata {
                pending: false,
                attempt_id: None,
                attempted_at_unix_ms: None,
                pod_name: None,
                gpu_id: None,
                pod_id: None,
            });
        }
        let encoded = std::fs::read(&pending_path).map_err(|_| create_marker_io_error())?;
        let marker: PersistedCreateAttempt =
            serde_json::from_slice(&encoded).map_err(|_| create_marker_invalid())?;
        validate_persisted_create_attempt(&marker)?;
        let pod_id = match std::fs::read_to_string(self.pod_id_path()) {
            Ok(value) => {
                validate_pod_id(&value)?;
                Some(value)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err(create_marker_io_error()),
        };
        Ok(RunPodCreateMarkerMetadata {
            pending: true,
            attempt_id: Some(marker.attempt_id),
            attempted_at_unix_ms: Some(marker.attempted_at_unix_ms),
            pod_name: Some(marker.pod_name),
            gpu_id: marker.gpu_ids.first().cloned(),
            pod_id,
        })
    }

    fn clear(&self, attempt_id: &str) -> NativeResult<()> {
        let _guard = self.io.lock().map_err(|_| state_error())?;
        let encoded = std::fs::read(self.pending_path()).map_err(|_| create_marker_invalid())?;
        let marker: PersistedCreateAttempt =
            serde_json::from_slice(&encoded).map_err(|_| create_marker_invalid())?;
        validate_persisted_create_attempt(&marker)?;
        if marker.attempt_id != attempt_id {
            return Err(NativeError::new(
                "pod_create_resolution_mismatch",
                "The create-attempt resolution did not match the pending native marker.",
            ));
        }
        match std::fs::remove_file(self.pod_id_path()) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(create_marker_io_error()),
        }
        std::fs::remove_file(self.pending_path()).map_err(|_| create_marker_io_error())?;
        sync_directory(&self.directory)
    }
}

fn validate_persisted_create_attempt(marker: &PersistedCreateAttempt) -> NativeResult<()> {
    if marker.schema_version != 1
        || uuid::Uuid::parse_str(&marker.attempt_id).is_err()
        || marker.attempted_at_unix_ms == 0
        || !safe_identifier(&marker.pod_name, true)
        || !marker.pod_name.starts_with("imageforge-")
        || marker.gpu_ids.is_empty()
        || marker.gpu_ids.len() > 8
        || marker
            .gpu_ids
            .iter()
            .any(|gpu_id| !safe_gpu_identifier(gpu_id))
        || !safe_identifier(&marker.template_id, false)
        || !safe_identifier(&marker.network_volume_id, false)
    {
        return Err(create_marker_invalid());
    }
    Ok(())
}

fn default_marker_directory() -> NativeResult<PathBuf> {
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|path| path.join("Library").join("Application Support"));
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base: Option<PathBuf> = None;
    base.map(|path| path.join("com.imageforge.desktop").join("runpod-create"))
        .ok_or_else(|| {
            NativeError::new(
                "native_state_unavailable",
                "The native application-data directory is unavailable.",
            )
        })
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn write_new_durable(path: &Path, bytes: &[u8]) -> NativeResult<()> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                NativeError::new(
                    "pod_create_marker_exists",
                    "A native create marker already exists.",
                )
            } else {
                create_marker_io_error()
            }
        })?;
    file.write_all(bytes)
        .map_err(|_| create_marker_io_error())?;
    file.sync_all().map_err(|_| create_marker_io_error())
}

fn sync_directory_and_parent(directory: &Path) -> NativeResult<()> {
    if let Some(parent) = directory.parent() {
        sync_directory(parent)?;
    }
    sync_directory(directory)
}

fn sync_directory(directory: &Path) -> NativeResult<()> {
    #[cfg(windows)]
    {
        // Windows has no portable directory fsync. The marker file itself is
        // synced before this call, and its atomic replacement uses
        // MOVEFILE_WRITE_THROUGH, so a directory-handle failure must not make
        // a valid create-attempt marker look unwritable.
        let _ = directory;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::fs::File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|_| create_marker_io_error())
    }
}

fn create_marker_io_error() -> NativeError {
    NativeError::retryable(
        "pod_create_marker_io_failed",
        "ImageForge could not durably record the Pod create attempt; no request was sent.",
    )
}

fn create_marker_invalid() -> NativeError {
    NativeError::new(
        "pod_create_marker_invalid",
        "The native Pod create marker is invalid and requires explicit operator resolution.",
    )
}

fn consume_grant(
    slot: &Mutex<Option<ForegroundGrant>>,
    supplied: Option<&str>,
    code: &'static str,
) -> NativeResult<()> {
    let grant = slot.lock().map_err(|_| state_error())?.take();
    let valid = grant.is_some_and(|grant| {
        supplied == Some(grant.token.as_str()) && grant.issued_at.elapsed() <= CREATE_GRANT_TTL
    });
    if valid {
        Ok(())
    } else {
        Err(NativeError::new(
            code,
            "A fresh one-use foreground authorization is required.",
        ))
    }
}

#[derive(Debug)]
struct ValidatedRequest {
    operation: RunPodOperation,
    method: Method,
    url: Url,
    body: Option<Value>,
    pod_id: Option<String>,
    create_grant: Option<String>,
    emergency_grant: Option<String>,
}

impl TryFrom<RunPodHttpRequest> for ValidatedRequest {
    type Error = NativeError;

    fn try_from(value: RunPodHttpRequest) -> Result<Self, Self::Error> {
        let method = Method::from_bytes(value.method.as_bytes()).map_err(|_| rejected())?;
        let url = Url::parse(&value.url).map_err(|_| rejected())?;
        validate_common_url(&url)?;
        match value.operation {
            RunPodOperation::Inventory => validate_inventory(&method, &url, value.body.as_ref())?,
            RunPodOperation::ListPods => validate_list_pods(&method, &url, value.body.as_ref())?,
            RunPodOperation::CreatePod => validate_create_pod(&method, &url, value.body.as_ref())?,
            RunPodOperation::GetPod => {
                validate_pod_item(&method, &url, value.body.as_ref(), false)?
            }
            RunPodOperation::TerminatePod => {
                validate_pod_item(&method, &url, value.body.as_ref(), true)?
            }
        }
        let pod_id = match value.operation {
            RunPodOperation::GetPod | RunPodOperation::TerminatePod => {
                url.path().strip_prefix("/v1/pods/").map(str::to_owned)
            }
            _ => None,
        };
        Ok(Self {
            operation: value.operation,
            method,
            url,
            body: value.body,
            pod_id,
            create_grant: value.create_grant,
            emergency_grant: value.emergency_grant,
        })
    }
}

fn validate_bound_create_profile(
    body: Option<&Value>,
    profile: &RunPodProfileBinding,
) -> NativeResult<()> {
    validate_approved_profile_ids(&profile.template_id, &profile.network_volume_id)?;
    let object = body.and_then(Value::as_object).ok_or_else(rejected)?;
    if object.get("templateId").and_then(Value::as_str) != Some(profile.template_id.as_str())
        || object.get("networkVolumeId").and_then(Value::as_str)
            != Some(profile.network_volume_id.as_str())
    {
        return Err(NativeError::new(
            "runpod_profile_mismatch",
            "Pod creation did not match the verified ImageForge template and network volume.",
        ));
    }
    Ok(())
}

fn validate_approved_profile_ids(template_id: &str, network_volume_id: &str) -> NativeResult<()> {
    if template_id != IMAGEFORGE_TEMPLATE_ID || network_volume_id != IMAGEFORGE_NETWORK_VOLUME_ID {
        return Err(NativeError::new(
            "runpod_profile_unapproved",
            "The RunPod profile does not match the approved ImageForge deployment.",
        ));
    }
    Ok(())
}

fn validate_bound_list_profile(url: &Url, profile: &RunPodProfileBinding) -> NativeResult<()> {
    validate_approved_profile_ids(&profile.template_id, &profile.network_volume_id)?;
    let query = query_map(url)?;
    if query.get("templateId") != Some(&profile.template_id)
        || query.get("networkVolumeId") != Some(&profile.network_volume_id)
    {
        return Err(NativeError::new(
            "runpod_profile_mismatch",
            "Pod discovery did not match the verified ImageForge profile.",
        ));
    }
    Ok(())
}

/// The reserved ImageForge Pod name. It is the only ownership signal available
/// before a Pod has been strictly validated, so both the list filter and the
/// managed-Pod validator below decide ownership through this one predicate.
fn imageforge_pod_name(name: &str) -> bool {
    name == "imageforge" || name.starts_with("imageforge-")
}

fn validate_managed_pod_value(
    pod: &Value,
    expected_pod_id: &str,
    profile: &RunPodProfileBinding,
    dynamic_gpus: &HashMap<String, String>,
) -> NativeResult<()> {
    validate_approved_profile_ids(&profile.template_id, &profile.network_volume_id)?;
    let object = pod.as_object().ok_or_else(rejected)?;
    ensure_only_allowed_projection_keys(object, POD_PROJECTION_KEYS)?;
    let network_volume = object
        .get("networkVolume")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            super::error::trace_rejected_checks("managed_pod", &["networkVolume:absent"]);
            rejected()
        })?;
    ensure_only_allowed_projection_keys(network_volume, &["id", "dataCenterId"])?;
    let machine = object
        .get("machine")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            super::error::trace_rejected_checks("managed_pod", &["machine:absent"]);
            rejected()
        })?;
    ensure_only_allowed_projection_keys(machine, &["secureCloud", "dataCenterId", "gpuTypeId"])?;
    let gpu = object
        .get("gpu")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            super::error::trace_rejected_checks("managed_pod", &["gpu:absent"]);
            rejected()
        })?;
    ensure_only_allowed_projection_keys(gpu, &["id", "displayName", "count"])?;
    let ports = object
        .get("ports")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            super::error::trace_rejected_checks("managed_pod", &["ports:absent"]);
            rejected()
        })?;
    let gpu_id = gpu.get("id").and_then(Value::as_str).ok_or_else(rejected)?;
    let gpu_display = gpu
        .get("displayName")
        .and_then(Value::as_str)
        .ok_or_else(rejected)?;
    let gpu_approved = approved_gpu_id(gpu_id)
        || dynamic_gpus.get(gpu_id).is_some_and(|expected_display| {
            normalize_catalog_name(expected_display) == normalize_catalog_name(gpu_display)
        });
    let valid = object.get("id").and_then(Value::as_str) == Some(expected_pod_id)
        && object
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(imageforge_pod_name)
        && object.get("templateId").and_then(Value::as_str) == Some(profile.template_id.as_str())
        && object
            .get("imageName")
            .and_then(Value::as_str)
            .is_some_and(|image| image == IMAGEFORGE_WORKER_IMAGE)
        && object.get("volumeMountPath").and_then(Value::as_str) == Some("/workspace")
        && object.get("interruptible").and_then(Value::as_bool) == Some(false)
        && object.get("gpuCount").and_then(Value::as_u64) == Some(1)
        && network_volume.get("id").and_then(Value::as_str)
            == Some(profile.network_volume_id.as_str())
        && network_volume.get("dataCenterId").and_then(Value::as_str) == Some("EU-RO-1")
        && machine.get("secureCloud").and_then(Value::as_bool) == Some(true)
        && machine.get("dataCenterId").and_then(Value::as_str) == Some("EU-RO-1")
        && machine.get("gpuTypeId").and_then(Value::as_str) == Some(gpu_id)
        && gpu.get("count").and_then(Value::as_u64) == Some(1)
        && gpu_approved
        && ports.len() == 1
        && ports[0].as_str() == Some("8000/http");
    if !valid {
        // Names only, never values. This is the single check whose failure is
        // otherwise invisible: it collapses fifteen conditions into one code.
        super::error::trace_rejected_checks(
            "managed_pod",
            &[
                ("id", object.get("id").and_then(Value::as_str) == Some(expected_pod_id)),
                ("name", object.get("name").and_then(Value::as_str).is_some_and(imageforge_pod_name)),
                ("templateId", object.get("templateId").and_then(Value::as_str) == Some(profile.template_id.as_str())),
                ("imageName", object.get("imageName").and_then(Value::as_str).is_some_and(|image| image == IMAGEFORGE_WORKER_IMAGE)),
                ("volumeMountPath", object.get("volumeMountPath").and_then(Value::as_str) == Some("/workspace")),
                ("interruptible", object.get("interruptible").and_then(Value::as_bool) == Some(false)),
                ("gpuCount", object.get("gpuCount").and_then(Value::as_u64) == Some(1)),
                ("networkVolume.id", network_volume.get("id").and_then(Value::as_str) == Some(profile.network_volume_id.as_str())),
                ("networkVolume.dataCenterId", network_volume.get("dataCenterId").and_then(Value::as_str) == Some("EU-RO-1")),
                ("machine.secureCloud", machine.get("secureCloud").and_then(Value::as_bool) == Some(true)),
                ("machine.dataCenterId", machine.get("dataCenterId").and_then(Value::as_str) == Some("EU-RO-1")),
                ("machine.gpuTypeId", machine.get("gpuTypeId").and_then(Value::as_str) == Some(gpu_id)),
                ("gpu.count", gpu.get("count").and_then(Value::as_u64) == Some(1)),
                ("gpu_approved", gpu_approved),
                ("ports", ports.len() == 1 && ports[0].as_str() == Some("8000/http")),
            ]
            .iter()
            .filter(|(_, ok)| !ok)
            .map(|(name, _)| *name)
            .collect::<Vec<_>>(),
        );
        return Err(NativeError::new(
            "pod_identity_mismatch",
            "RunPod did not return the exact managed ImageForge Pod identity.",
        ));
    }
    Ok(())
}

/// This validator always receives the native allowlisted projection rather
/// than raw provider JSON. Keep the accepted keys explicit at each nesting
/// level so a future projection edit cannot accidentally make a mutable or
/// private provider field part of managed-Pod authority.
fn ensure_only_allowed_projection_keys(
    object: &Map<String, Value>,
    allowed: &[&str],
) -> NativeResult<()> {
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(rejected());
    }
    Ok(())
}

const POD_PROJECTION_KEYS: &[&str] = &[
    "id",
    "name",
    "desiredStatus",
    "status",
    "templateId",
    "imageName",
    "volumeMountPath",
    "interruptible",
    "networkVolume",
    "gpu",
    "gpuCount",
    "machine",
    "ports",
    "adjustedCostPerHr",
    "costPerHr",
    "createdAt",
    "lastStartedAt",
];

#[cfg(test)]
fn project_pod(raw: &Value) -> NativeResult<Value> {
    project_pod_with_dynamic(raw, &HashMap::new())
}

fn project_pod_with_dynamic(
    raw: &Value,
    dynamic_gpus: &HashMap<String, String>,
) -> NativeResult<Value> {
    let object = raw.as_object().ok_or_else(response_invalid)?;
    let mut output = Map::new();
    for key in POD_PROJECTION_KEYS {
        let Some(value) = object.get(*key) else {
            if *key == "interruptible" {
                output.insert((*key).to_owned(), Value::Bool(false));
            }
            continue;
        };
        let projected = match *key {
            "networkVolume" => project_object(value, &["id", "dataCenterId"])?,
            // Some live on-demand REST responses omit `gpu` entirely while
            // exposing the same identity as machine.gpuTypeId. The fallback
            // below handles explicit null; the post-loop fallback handles an
            // omitted field so a running Pod remains discoverable.
            "gpu" if value.is_null() => {
                let gpu_id = object
                    .get("machine")
                    .and_then(Value::as_object)
                    .and_then(|machine| machine.get("gpuTypeId"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if gpu_id.is_empty() {
                    Value::Null
                } else {
                    let display_name = dynamic_gpus
                        .get(gpu_id)
                        .cloned()
                        .unwrap_or_else(|| gpu_id.to_owned());
                    let count = object.get("gpuCount").cloned().unwrap_or(Value::from(1));
                    serde_json::json!({"id": gpu_id, "displayName": display_name, "count": count})
                }
            }
            "gpu" => project_object(value, &["id", "displayName", "count"])?,
            "machine" => project_object(value, &["secureCloud", "dataCenterId", "gpuTypeId"])?,
            _ => value.clone(),
        };
        output.insert((*key).to_owned(), projected);
    }
    if !output.contains_key("gpu") {
        let gpu_id = object
            .get("machine")
            .and_then(Value::as_object)
            .and_then(|machine| machine.get("gpuTypeId"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if !gpu_id.is_empty() {
            let display_name = dynamic_gpus
                .get(gpu_id)
                .cloned()
                .unwrap_or_else(|| gpu_id.to_owned());
            let count = object.get("gpuCount").cloned().unwrap_or(Value::from(1));
            output.insert(
                "gpu".to_owned(),
                serde_json::json!({"id": gpu_id, "displayName": display_name, "count": count}),
            );
        }
    }
    // The REST list response carries the authoritative count inside `gpu`
    // and can omit the create-request field `gpuCount` entirely.
    if !output.contains_key("gpuCount") {
        if let Some(count) = output
            .get("gpu")
            .and_then(Value::as_object)
            .and_then(|gpu| gpu.get("count"))
            .and_then(Value::as_u64)
        {
            output.insert("gpuCount".to_owned(), Value::from(count));
        }
    }
    // Current list responses may expose only the provider lifecycle field
    // `desiredStatus`. Keep the canonical lowercase status vocabulary used by
    // the existing native state machine; unknown values remain unsynthesized
    // and are rejected by the strict validator.
    if !output.contains_key("status") {
        let status = output
            .get("desiredStatus")
            .and_then(Value::as_str)
            .and_then(|value| match value {
                "CREATED" | "PROVISIONING" => Some("provisioning"),
                "STARTING" => Some("starting"),
                "RUNNING" => Some("running"),
                "EXITED" => Some("exited"),
                "ERROR" => Some("error"),
                "TERMINATED" => Some("terminated"),
                _ => None,
            });
        if let Some(status) = status {
            output.insert("status".to_owned(), Value::String(status.to_owned()));
        }
    }
    // RunPod's current REST Pod response names the container image `image`,
    // while create requests and ImageForge's canonical private projection use
    // `imageName`. Canonicalize only this documented provider alias before the
    // strict profile validator runs; the exact pinned digest comparison below
    // remains unchanged and still fails closed for any other image.
    if !output.contains_key("imageName") {
        if let Some(image) = object.get("image").and_then(Value::as_str) {
            output.insert("imageName".to_owned(), Value::String(image.to_owned()));
        }
    }
    Ok(Value::Object(output))
}

fn project_object(raw: &Value, allowed: &[&str]) -> NativeResult<Value> {
    if raw.is_null() {
        return Ok(Value::Null);
    }
    let object = raw.as_object().ok_or_else(response_invalid)?;
    Ok(Value::Object(
        allowed
            .iter()
            .filter_map(|key| {
                object
                    .get(*key)
                    .map(|value| ((*key).to_owned(), value.clone()))
            })
            .collect(),
    ))
}

fn project_inventory_response(url: &Url, raw: &Value) -> NativeResult<String> {
    let object = raw.as_object().ok_or_else(response_invalid)?;
    let projected = if url.path().ends_with("/datacenters") {
        let entries = object
            .get("dataCenters")
            .and_then(Value::as_array)
            .ok_or_else(response_invalid)?;
        serde_json::json!({
            "dataCenters": entries.iter().map(|entry| project_object(entry, &["id", "networkVolumeTypes"])).collect::<NativeResult<Vec<_>>>()?
        })
    } else {
        let entries = object
            .get("gpus")
            .and_then(Value::as_array)
            .ok_or_else(response_invalid)?;
        let mut gpus = Vec::with_capacity(entries.len());
        for entry in entries {
            let gpu = entry.as_object().ok_or_else(response_invalid)?;
            let mut output = Map::new();
            for key in [
                "id",
                "name",
                "manufacturer",
                "memory",
                "secure",
                "dataCenters",
            ] {
                if let Some(value) = gpu.get(key) {
                    let value = if key == "dataCenters" {
                        Value::Array(
                            value
                                .as_array()
                                .ok_or_else(response_invalid)?
                                .iter()
                                .map(|entry| project_object(entry, &["id", "availability"]))
                                .collect::<NativeResult<Vec<_>>>()?,
                        )
                    } else {
                        value.clone()
                    };
                    output.insert(key.to_owned(), value);
                }
            }
            for key in ["price", "maxCount"] {
                if let Some(value) = gpu.get(key) {
                    output.insert(key.to_owned(), project_object(value, &["secure"])?);
                }
            }
            gpus.push(Value::Object(output));
        }
        serde_json::json!({"gpus": gpus})
    };
    serde_json::to_string(&projected).map_err(|_| response_invalid())
}

fn reject_secret_reflection<'a>(
    value: &Value,
    secrets: impl IntoIterator<Item = &'a str>,
) -> NativeResult<()> {
    let encoded = serde_json::to_string(value).map_err(|_| response_invalid())?;
    if secrets
        .into_iter()
        .any(|secret| !secret.is_empty() && encoded.contains(secret))
    {
        return Err(NativeError::new(
            "secret_reflection_rejected",
            "A remote response attempted to reflect a saved credential.",
        ));
    }
    Ok(())
}

fn response_invalid() -> NativeError {
    NativeError::new(
        "runpod_response_invalid",
        "RunPod returned malformed or unsafe response data.",
    )
}

// Task 014's ordinary Start boundary deliberately translates every private
// transport/profile failure into the small documented action registry.  The
// generic compatibility transport keeps its existing richer internal codes;
// only the narrow native Start path uses this mapping.
fn normal_start_error(code: &'static str) -> NativeError {
    let (retryable, message) = match code {
        "gpu_start_profile_locked" => (false, "The ImageForge GPU profile changed before Start."),
        "gpu_start_existing_pod" => (
            false,
            "An ImageForge Pod already exists. Refresh before starting another.",
        ),
        "gpu_start_operation_in_progress" => (
            true,
            "Another ImageForge GPU operation is already in progress.",
        ),
        "gpu_start_create_uncertain" => (
            false,
            "RunPod may have created the GPU. Resolve this Start before trying again.",
        ),
        "gpu_start_provider_response_invalid" => {
            (false, "RunPod returned an invalid GPU response.")
        }
        "gpu_start_store_unavailable" => (
            true,
            "ImageForge could not access the GPU Start recovery journal.",
        ),
        "gpu_start_provider_auth_failed" => (
            false,
            "RunPod rejected the saved API credential. Replace it before starting a GPU.",
        ),
        "gpu_start_provider_timeout" => (
            true,
            "RunPod did not answer the final GPU check. Try Start again.",
        ),
        "gpu_start_provider_unavailable" => (
            true,
            "RunPod is unavailable for the final GPU check. Try Start again.",
        ),
        "gpu_start_provider_rate_limited" => (
            true,
            "RunPod rate-limited the final GPU check. Wait, then try Start again.",
        ),
        _ => (false, "RunPod returned an invalid GPU response."),
    };
    if retryable {
        NativeError::retryable(code, message)
    } else {
        NativeError::new(code, message)
    }
}

fn map_normal_start_preflight_error(error: NativeError) -> NativeError {
    match error.code {
        "runpod_profile_unconfigured"
        | "runpod_profile_invalid"
        | "pod_create_reconciliation_required" => normal_start_error("gpu_start_profile_locked"),
        "runpod_network_error" => normal_start_error("gpu_start_provider_unavailable"),
        "runpod_response_invalid" => normal_start_error("gpu_start_provider_response_invalid"),
        "runpod_timeout" => normal_start_error("gpu_start_provider_timeout"),
        "runpod_auth_failed" => normal_start_error("gpu_start_provider_auth_failed"),
        "runpod_rate_limited" => normal_start_error("gpu_start_provider_rate_limited"),
        "runpod_provider_unavailable" => normal_start_error("gpu_start_provider_unavailable"),
        _ => normal_start_error("gpu_start_provider_response_invalid"),
    }
}

fn switch_provider_response_error() -> NativeError {
    NativeError::new(
        "gpu_switch_provider_response_mismatch",
        "RunPod did not return the exact GPU switch provider identity.",
    )
}

fn map_switch_provider_error(error: NativeError) -> NativeError {
    match error.code {
        "runpod_timeout"
        | "runpod_network_error"
        | "runpod_rate_limited"
        | "runpod_provider_unavailable" => NativeError::retryable(
            "gpu_switch_inventory_unavailable",
            "Live RunPod GPU state is temporarily unavailable. Refresh before continuing the switch.",
        ),
        _ => switch_provider_response_error(),
    }
}

fn map_pod_observation_list_error(error: NativeError) -> NativeError {
    if error.retryable {
        NativeError::retryable(
            "gpu_pod_observation_unavailable",
            "Live ImageForge Pod state is temporarily unavailable. Refresh before continuing.",
        )
    } else {
        // Do not leak whether a malformed row was an identity mismatch,
        // duplicate, incomplete page, or provider shape drift. All of those
        // retain the prior validated observation and leave the verified-Pod
        // registry untouched.
        NativeError::new(
            "gpu_pod_observation_invalid",
            "RunPod returned an invalid ImageForge Pod observation.",
        )
    }
}

fn profile_observation_superseded() -> NativeError {
    NativeError::retryable(
        "gpu_switch_inventory_unavailable",
        "Live RunPod GPU state is temporarily unavailable. Refresh before continuing the switch.",
    )
}

fn canonical_uuid_v4(value: &str) -> bool {
    uuid::Uuid::parse_str(value).ok().is_some_and(|parsed| {
        parsed.get_version() == Some(uuid::Version::Random) && parsed.to_string() == value
    })
}

fn normal_stop_provider_error() -> NativeError {
    NativeError::new(
        "gpu_pod_observation_invalid",
        "The ImageForge Pod deletion request is invalid.",
    )
}

fn profile_pod_list_url(profile: &RunPodProfileBinding) -> String {
    let template_id =
        url::form_urlencoded::byte_serialize(profile.template_id.as_bytes()).collect::<String>();
    let network_volume_id =
        url::form_urlencoded::byte_serialize(profile.network_volume_id.as_bytes())
            .collect::<String>();
    format!(
        "https://rest.runpod.io/v1/pods?computeType=GPU&includeMachine=true&includeNetworkVolume=true&templateId={template_id}&networkVolumeId={network_volume_id}&dataCenterId=EU-RO-1"
    )
}

fn validate_complete_profile_list_shape(value: &Value) -> NativeResult<()> {
    if value.is_array() {
        Ok(())
    } else {
        Err(switch_provider_response_error())
    }
}

fn parse_switch_managed_pod_list(
    body: &str,
    profile: &RunPodProfileBinding,
    dynamic: &HashMap<String, String>,
) -> NativeResult<Vec<NativeRunPodManagedPodV1>> {
    let values: Vec<Value> =
        serde_json::from_str(body).map_err(|_| switch_provider_response_error())?;
    let mut pods = Vec::with_capacity(values.len());
    for raw in values {
        // One RunPod account may also hold Pods this app did not create. A
        // foreign Pod is not ImageForge's to verify, bill, or stop, and it can
        // legitimately carry any shape at all. Before this filter a single
        // unrelated Pod failed the strict parse below and aborted the whole
        // observation, which left the app permanently unable to observe its
        // own Pods, showed "Existing ImageForge Pods could not be observed",
        // and blocked Start.
        //
        // Ownership is decided only by the reserved ImageForge Pod name, the
        // same predicate `validate_managed_pod_value` uses. Anything carrying
        // that name still fails closed below, so an ImageForge Pod that cannot
        // be verified continues to block Start and can never be silently
        // dropped into a duplicate billed Pod.
        if !raw
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(imageforge_pod_name)
        {
            continue;
        }
        // Provider responses may contain mutable or private fields. Project
        // them through the one explicit top-level/nested allowlist before any
        // identity parsing, so unknown fields never become authority or a
        // fingerprint input. Missing/wrong-type allowlist fields are still
        // rejected by the strict projection/validation below.
        let value = project_pod_with_dynamic(&raw, dynamic)
            .map_err(|_| switch_provider_response_error())?;
        let encoded =
            serde_json::to_string(&value).map_err(|_| switch_provider_response_error())?;
        // A Pod that reached a terminal state is not billing, cannot be
        // resumed into ImageForge's current Pod, and carries no duplicate-Pod
        // hazard. Historical Pods therefore accumulate in the account under
        // whatever pinned worker image was current when they ran, and a single
        // one left from an older image used to fail this parse and abort every
        // observation for good: the app could not read Pod state, could not
        // show the Pod, and could not Start, with no in-app way out.
        //
        // Only terminal Pods are excluded here. A Pod that is still
        // provisioning, starting, or running must keep failing closed, because
        // that is the case where an unrecognized image really could mean live
        // billing or unknown code under ImageForge's own name.
        let terminal_state = value
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| matches!(status, "exited" | "terminated"));
        match parse_switch_managed_pod_with_value(value, &encoded, profile, dynamic) {
            Ok(pod) => pods.push(pod),
            Err(error) if terminal_state => {
                let _ = error;
                continue;
            }
            Err(error) => return Err(error),
        }
    }
    pods.sort_by(|left, right| left.pod_id.cmp(&right.pod_id));
    if pods.windows(2).any(|pair| pair[0].pod_id == pair[1].pod_id) {
        return Err(switch_provider_response_error());
    }
    Ok(pods)
}

fn parse_switch_managed_pod(
    body: &str,
    profile: &RunPodProfileBinding,
    dynamic: &HashMap<String, String>,
) -> NativeResult<NativeRunPodManagedPodV1> {
    let value: Value = serde_json::from_str(body).map_err(|_| switch_provider_response_error())?;
    parse_switch_managed_pod_with_value(value, body, profile, dynamic)
}

fn parse_switch_managed_pod_with_value(
    value: Value,
    encoded: &str,
    profile: &RunPodProfileBinding,
    dynamic: &HashMap<String, String>,
) -> NativeResult<NativeRunPodManagedPodV1> {
    let object = value
        .as_object()
        .ok_or_else(switch_provider_response_error)?;
    let pod_id = object
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(switch_provider_response_error)?;
    let pod_name = object
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(switch_provider_response_error)?;
    validate_managed_pod_value(&value, pod_id, profile, dynamic)
        .map_err(|_| switch_provider_response_error())?;
    let gpu = object
        .get("gpu")
        .and_then(Value::as_object)
        .ok_or_else(switch_provider_response_error)?;
    let gpu_id = gpu
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(switch_provider_response_error)?;
    let gpu_display_name = gpu
        .get("displayName")
        .and_then(Value::as_str)
        .ok_or_else(switch_provider_response_error)?;
    let status = match object
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(switch_provider_response_error)?
    {
        "provisioning" => "provisioning",
        "starting" => "starting",
        "running" => "running",
        "exited" => "exited",
        "error" => "error",
        "terminated" => "terminated",
        _ => return Err(switch_provider_response_error()),
    }
    .to_owned();
    let hourly_price_micro_usd = Some(parse_strict_observed_pod_price(object)?);
    Ok(NativeRunPodManagedPodV1 {
        pod_id: pod_id.to_owned(),
        pod_name: pod_name.to_owned(),
        gpu_id: gpu_id.to_owned(),
        gpu_display_name: gpu_display_name.to_owned(),
        hourly_price_micro_usd,
        status,
        provider_response_sha256: hex::encode(Sha256::digest(encoded.as_bytes())),
    })
}

fn parse_strict_observed_pod_price(object: &Map<String, Value>) -> NativeResult<u64> {
    let adjusted = match object.get("adjustedCostPerHr") {
        None | Some(Value::Null) => "null".to_owned(),
        Some(Value::Number(number)) => number.to_string(),
        _ => return Err(switch_provider_response_error()),
    };
    let cost = object
        .get("costPerHr")
        .filter(|value| value.is_string() || value.is_number())
        .ok_or_else(switch_provider_response_error)?
        .to_string();
    super::gpu_inventory::parse_created_price_tokens(&adjusted, &cost)
        .ok_or_else(switch_provider_response_error)
}

fn state_error() -> NativeError {
    NativeError::new(
        "runpod_state_unavailable",
        "RunPod verification state is unavailable.",
    )
}

fn validate_common_url(url: &Url) -> NativeResult<()> {
    if url.scheme() != "https"
        || url.username() != ""
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err(rejected());
    }
    Ok(())
}

fn validate_inventory(method: &Method, url: &Url, body: Option<&Value>) -> NativeResult<()> {
    if method != Method::GET || body.is_some() || url.host_str() != Some(INVENTORY_HOST) {
        return Err(rejected());
    }
    match url.path() {
        "/v2/catalog/datacenters" if url.query().is_none() => Ok(()),
        "/v2/catalog/gpus" => require_query(
            url,
            &[
                ("include", "AVAILABILITY"),
                ("product", "POD"),
                ("count", "1"),
                ("cloud", "SECURE"),
                ("minCudaVersion", "13.0"),
            ],
        ),
        _ => Err(rejected()),
    }
}

fn validate_list_pods(method: &Method, url: &Url, body: Option<&Value>) -> NativeResult<()> {
    if method != Method::GET
        || body.is_some()
        || url.host_str() != Some(REST_HOST)
        || url.path() != "/v1/pods"
    {
        return Err(rejected());
    }
    let pairs = query_map(url)?;
    for (key, expected) in [
        ("computeType", "GPU"),
        ("includeMachine", "true"),
        ("includeNetworkVolume", "true"),
        ("dataCenterId", "EU-RO-1"),
    ] {
        if pairs.get(key).map(String::as_str) != Some(expected) {
            return Err(rejected());
        }
    }
    let Some(template_id) = pairs.get("templateId") else {
        return Err(rejected());
    };
    let Some(network_volume_id) = pairs.get("networkVolumeId") else {
        return Err(rejected());
    };
    if !safe_identifier(template_id, false) || !safe_identifier(network_volume_id, false) {
        return Err(rejected());
    }
    if pairs.len() != 6 {
        return Err(rejected());
    }
    Ok(())
}

fn validate_create_pod(method: &Method, url: &Url, body: Option<&Value>) -> NativeResult<()> {
    if method != Method::POST
        || url.host_str() != Some(REST_HOST)
        || url.path() != "/v1/pods"
        || url.query().is_some()
    {
        return Err(rejected());
    }
    let object = body.and_then(Value::as_object).ok_or_else(rejected)?;
    const ALLOWED_KEYS: &[&str] = &[
        "name",
        "templateId",
        "imageName",
        "networkVolumeId",
        "volumeMountPath",
        "ports",
        "computeType",
        "cloudType",
        "gpuTypeIds",
        "gpuTypePriority",
        "gpuCount",
        "interruptible",
        "dataCenterIds",
        "env",
        "allowedCudaVersions",
        "minRAMPerGPU",
        "minDiskBandwidthMBps",
        "minDownloadMbps",
        "minUploadMbps",
    ];
    if object
        .keys()
        .any(|key| !ALLOWED_KEYS.contains(&key.as_str()))
    {
        return Err(rejected());
    }
    require_json_string(object, "computeType", "GPU")?;
    require_json_string(object, "cloudType", "SECURE")?;
    require_json_string(object, "gpuTypePriority", "custom")?;
    require_json_string(object, "volumeMountPath", "/workspace")?;
    require_json_bool(object, "interruptible", false)?;
    require_json_integer(object, "gpuCount", 1)?;
    require_json_integer_range(object, "minRAMPerGPU", 16, 32)?;
    require_json_string_array(object, "ports", &["8000/http"])?;
    require_json_string_array(object, "dataCenterIds", &["EU-RO-1"])?;
    require_json_string_array(object, "allowedCudaVersions", &["13.0"])?;
    if let Some(env) = object.get("env") {
        let env = env.as_object().ok_or_else(rejected)?;
        const SWITCH_ENV_KEYS: &[&str] = &[
            "IMAGEFORGE_EXPECTED_GPU_TYPE_ID",
            "IMAGEFORGE_GPU_SWITCH_ID",
            "IMAGEFORGE_REPLACEMENT_ATTEMPT_ID",
            "IMAGEFORGE_REPLACEMENT_ATTEMPT_REVISION",
            "IMAGEFORGE_CREATE_CONTRACT_REVISION",
            "IMAGEFORGE_CREATE_MARKER_SHA256",
        ];
        if env.len() != SWITCH_ENV_KEYS.len()
            || env
                .keys()
                .any(|key| !SWITCH_ENV_KEYS.contains(&key.as_str()))
        {
            return Err(rejected());
        }
        let switch_id = env
            .get("IMAGEFORGE_GPU_SWITCH_ID")
            .and_then(Value::as_str)
            .ok_or_else(rejected)?;
        let attempt_id = env
            .get("IMAGEFORGE_REPLACEMENT_ATTEMPT_ID")
            .and_then(Value::as_str)
            .ok_or_else(rejected)?;
        let attempt_revision = env
            .get("IMAGEFORGE_REPLACEMENT_ATTEMPT_REVISION")
            .and_then(Value::as_str)
            .ok_or_else(rejected)?;
        let target_gpu_id = env
            .get("IMAGEFORGE_EXPECTED_GPU_TYPE_ID")
            .and_then(Value::as_str)
            .ok_or_else(rejected)?;
        let marker_sha256 = env
            .get("IMAGEFORGE_CREATE_MARKER_SHA256")
            .and_then(Value::as_str)
            .ok_or_else(rejected)?;
        if !canonical_uuid_v4(switch_id)
            || !canonical_uuid_v4(attempt_id)
            || attempt_revision == "0"
            || attempt_revision.starts_with('0')
            || attempt_revision
                .parse::<u64>()
                .ok()
                .filter(|value| *value <= 9_007_199_254_740_991)
                .is_none()
            || !safe_gpu_identifier(target_gpu_id)
            || env
                .get("IMAGEFORGE_CREATE_CONTRACT_REVISION")
                .and_then(Value::as_str)
                != Some("1")
            || marker_sha256.len() != 64
            || !marker_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(rejected());
        }
    }
    for key in ["name", "templateId", "networkVolumeId"] {
        let candidate = object
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(rejected)?;
        if !safe_identifier(candidate, key == "name") {
            return Err(rejected());
        }
        if key == "name" && !candidate.starts_with("imageforge-") {
            return Err(rejected());
        }
    }
    let template_id = object
        .get("templateId")
        .and_then(Value::as_str)
        .ok_or_else(rejected)?;
    let network_volume_id = object
        .get("networkVolumeId")
        .and_then(Value::as_str)
        .ok_or_else(rejected)?;
    validate_approved_profile_ids(template_id, network_volume_id)?;

    let image_name = object
        .get("imageName")
        .and_then(Value::as_str)
        .ok_or_else(rejected)?;
    if image_name != IMAGEFORGE_WORKER_IMAGE || !safe_image_reference(image_name) {
        return Err(rejected());
    }
    for key in ["minDiskBandwidthMBps", "minDownloadMbps", "minUploadMbps"] {
        if let Some(value) = object.get(key) {
            let value = value.as_f64().ok_or_else(rejected)?;
            if !value.is_finite() || value <= 0.0 || value > 1_000_000.0 {
                return Err(rejected());
            }
        }
    }
    let gpu_ids = object
        .get("gpuTypeIds")
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty() && values.len() <= 8)
        .ok_or_else(rejected)?;
    let mut seen = std::collections::HashSet::new();
    for gpu_id in gpu_ids {
        let gpu_id = gpu_id.as_str().ok_or_else(rejected)?;
        if !safe_gpu_identifier(gpu_id) || !seen.insert(gpu_id) {
            return Err(rejected());
        }
    }
    Ok(())
}

fn safe_gpu_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 191
        && value.is_ascii()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b' ' | b'.' | b'_' | b'+' | b'-')
        })
}

fn safe_image_reference(value: &str) -> bool {
    let Some((repository, digest)) = value.split_once("@sha256:") else {
        return false;
    };
    repository.starts_with("ghcr.io/")
        && repository.len() <= 384
        && repository
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/'))
        && digest.len() == 64
        && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn normalize_catalog_name(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_uppercase()
}

fn canonical_dynamic_gpu_name(value: &str) -> Option<&'static str> {
    match normalize_catalog_name(value).as_str() {
        "RTX PRO 4500 BLACKWELL" => Some("RTX PRO 4500 Blackwell"),
        "RTX PRO 4000 BLACKWELL" => Some("RTX PRO 4000 Blackwell"),
        _ => None,
    }
}

fn validate_pod_item(
    method: &Method,
    url: &Url,
    body: Option<&Value>,
    terminate: bool,
) -> NativeResult<()> {
    let expected_method = if terminate {
        Method::DELETE
    } else {
        Method::GET
    };
    if method != expected_method || body.is_some() || url.host_str() != Some(REST_HOST) {
        return Err(rejected());
    }
    let pod_id = url.path().strip_prefix("/v1/pods/").ok_or_else(rejected)?;
    if pod_id.contains('/') {
        return Err(rejected());
    }
    validate_pod_id(pod_id)?;
    if terminate {
        if url.query().is_some() {
            return Err(rejected());
        }
    } else {
        require_query(
            url,
            &[("includeMachine", "true"), ("includeNetworkVolume", "true")],
        )?;
    }
    Ok(())
}

fn require_query(url: &Url, required: &[(&str, &str)]) -> NativeResult<()> {
    let actual = query_map(url)?;
    let expected = required
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect::<BTreeMap<_, _>>();
    if actual != expected {
        return Err(rejected());
    }
    Ok(())
}

fn query_map(url: &Url) -> NativeResult<BTreeMap<String, String>> {
    let mut actual = BTreeMap::<String, String>::new();
    for (key, value) in url.query_pairs() {
        if actual
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err(rejected());
        }
    }
    Ok(actual)
}

fn require_json_string(object: &Map<String, Value>, key: &str, expected: &str) -> NativeResult<()> {
    if object.get(key).and_then(Value::as_str) != Some(expected) {
        return Err(rejected());
    }
    Ok(())
}

fn require_json_bool(object: &Map<String, Value>, key: &str, expected: bool) -> NativeResult<()> {
    if object.get(key).and_then(Value::as_bool) != Some(expected) {
        return Err(rejected());
    }
    Ok(())
}

fn require_json_integer(object: &Map<String, Value>, key: &str, expected: u64) -> NativeResult<()> {
    if object.get(key).and_then(Value::as_u64) != Some(expected) {
        return Err(rejected());
    }
    Ok(())
}

fn require_json_integer_range(
    object: &Map<String, Value>,
    key: &str,
    minimum: u64,
    maximum: u64,
) -> NativeResult<()> {
    let value = object
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(rejected)?;
    if !(minimum..=maximum).contains(&value) {
        return Err(rejected());
    }
    Ok(())
}

fn require_json_string_array(
    object: &Map<String, Value>,
    key: &str,
    expected: &[&str],
) -> NativeResult<()> {
    let values = object
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(rejected)?;
    if values.len() != expected.len()
        || values
            .iter()
            .zip(expected)
            .any(|(value, expected)| value.as_str() != Some(expected))
    {
        return Err(rejected());
    }
    Ok(())
}

fn safe_identifier(value: &str, allow_spaces: bool) -> bool {
    !value.is_empty()
        && value.len() <= 191
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'.' | b'_' | b'-')
                || (allow_spaces && byte == b' ')
        })
}

fn approved_gpu_id(value: &str) -> bool {
    const STATIC: &[&str] = &[
        "NVIDIA GeForce RTX 4090",
        "NVIDIA GeForce RTX 5090",
        "NVIDIA L4",
        "NVIDIA RTX A4500",
        "NVIDIA RTX 4000 Ada Generation",
        "NVIDIA A100 80GB PCIe",
        "NVIDIA RTX PRO 6000 Blackwell Server Edition",
        "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
        EMERGENCY_GPU_ID,
    ];
    STATIC.contains(&value)
}

async fn read_bounded_body(response: reqwest::Response, limit: usize) -> NativeResult<String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(NativeError::new(
            "runpod_response_too_large",
            "RunPod returned an unexpectedly large response.",
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| {
            NativeError::retryable(
                "runpod_network_error",
                "The RunPod response was interrupted.",
            )
        })?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(NativeError::new(
                "runpod_response_too_large",
                "RunPod returned an unexpectedly large response.",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| {
        NativeError::new(
            "runpod_response_invalid",
            "RunPod returned an invalid text response.",
        )
    })
}

fn rejected() -> NativeError {
    NativeError::new(
        "runpod_request_rejected",
        "The requested RunPod operation is outside ImageForge's approved API surface.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::vault::MemoryVault;

    fn request(
        operation: RunPodOperation,
        method: &str,
        url: &str,
        body: Option<Value>,
    ) -> RunPodHttpRequest {
        RunPodHttpRequest {
            operation,
            method: method.to_owned(),
            url: url.to_owned(),
            body,
            create_grant: None,
            emergency_grant: None,
        }
    }

    fn create_body(gpus: &[&str]) -> Value {
        serde_json::json!({
            "name": "imageforge-request-123",
            "templateId": IMAGEFORGE_TEMPLATE_ID,
            "imageName": IMAGEFORGE_WORKER_IMAGE,
            "networkVolumeId": IMAGEFORGE_NETWORK_VOLUME_ID,
            "volumeMountPath": "/workspace",
            "ports": ["8000/http"],
            "computeType": "GPU",
            "cloudType": "SECURE",
            "gpuTypeIds": gpus,
            "gpuTypePriority": "custom",
            "gpuCount": 1,
            "interruptible": false,
            "dataCenterIds": ["EU-RO-1"],
            "allowedCudaVersions": ["13.0"],
            "minRAMPerGPU": 16
        })
    }

    #[test]
    fn allows_only_the_reviewed_runpod_surfaces() {
        let inventory = request(
            RunPodOperation::Inventory,
            "GET",
            "https://api.runpod.io/v2/catalog/gpus?include=AVAILABILITY&product=POD&count=1&cloud=SECURE&minCudaVersion=13.0",
            None,
        );
        assert!(ValidatedRequest::try_from(inventory).is_ok());
        let list = request(
            RunPodOperation::ListPods,
            "GET",
            &format!("https://rest.runpod.io/v1/pods?computeType=GPU&includeMachine=true&includeNetworkVolume=true&dataCenterId=EU-RO-1&templateId={IMAGEFORGE_TEMPLATE_ID}&networkVolumeId={IMAGEFORGE_NETWORK_VOLUME_ID}"),
            None,
        );
        assert!(ValidatedRequest::try_from(list).is_ok());
        let create = request(
            RunPodOperation::CreatePod,
            "POST",
            "https://rest.runpod.io/v1/pods",
            Some(create_body(&[
                "NVIDIA GeForce RTX 4090",
                "NVIDIA GeForce RTX 5090",
                "NVIDIA A100 80GB PCIe",
                "NVIDIA RTX PRO 6000 Blackwell Server Edition",
                "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
            ])),
        );
        assert!(ValidatedRequest::try_from(create).is_ok());
    }

    #[test]
    fn native_boundary_rejects_forged_profile_and_worker_image() {
        let temporary = tempfile::tempdir().unwrap();
        let transport = RunPodTransport::new_for_test(
            Arc::new(MemoryVault::default()),
            temporary.path().join("marker"),
        )
        .unwrap();
        for (template_id, volume_id) in [
            ("attacker-template", IMAGEFORGE_NETWORK_VOLUME_ID),
            (IMAGEFORGE_TEMPLATE_ID, "attacker-volume"),
        ] {
            assert_eq!(
                transport
                    .bind_profile(template_id, volume_id)
                    .unwrap_err()
                    .code,
                "runpod_profile_unapproved"
            );
        }
        transport
            .bind_profile(IMAGEFORGE_TEMPLATE_ID, IMAGEFORGE_NETWORK_VOLUME_ID)
            .unwrap();

        let mut forged_profile = create_body(&["NVIDIA GeForce RTX 4090"]);
        forged_profile["templateId"] = Value::String("attacker-template".to_owned());
        assert_eq!(
            ValidatedRequest::try_from(request(
                RunPodOperation::CreatePod,
                "POST",
                "https://rest.runpod.io/v1/pods",
                Some(forged_profile),
            ))
            .unwrap_err()
            .code,
            "runpod_profile_unapproved"
        );

        let mut forged_image = create_body(&["NVIDIA GeForce RTX 4090"]);
        forged_image["imageName"] = Value::String(
            "ghcr.io/attacker/imageforge-worker@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                .to_owned(),
        );
        assert_eq!(
            ValidatedRequest::try_from(request(
                RunPodOperation::CreatePod,
                "POST",
                "https://rest.runpod.io/v1/pods",
                Some(forged_image),
            ))
            .unwrap_err()
            .code,
            "runpod_request_rejected"
        );
    }

    #[test]
    fn rejects_host_confusion_queries_and_unapproved_gpu_or_placement() {
        let hostile = request(
            RunPodOperation::Inventory,
            "GET",
            "https://api.runpod.io.evil.example/v2/catalog/datacenters",
            None,
        );
        assert_eq!(
            ValidatedRequest::try_from(hostile).unwrap_err().code,
            "runpod_request_rejected"
        );

        let query_secret = request(
            RunPodOperation::GetPod,
            "GET",
            "https://rest.runpod.io/v1/pods/abc123?includeMachine=true&includeNetworkVolume=true&api_key=secret",
            None,
        );
        assert_eq!(
            ValidatedRequest::try_from(query_secret).unwrap_err().code,
            "runpod_request_rejected"
        );

        for gpus in [
            vec!["NVIDIA GeForce RTX 4090", "NVIDIA GeForce RTX 4090"],
            vec!["NVIDIA B200", "NVIDIA B200"],
        ] {
            let create = request(
                RunPodOperation::CreatePod,
                "POST",
                "https://rest.runpod.io/v1/pods",
                Some(create_body(&gpus)),
            );
            assert_eq!(
                ValidatedRequest::try_from(create).unwrap_err().code,
                "runpod_request_rejected"
            );
        }
    }

    #[test]
    fn terminate_accepts_only_one_valid_pod_id_and_no_query() {
        let valid = request(
            RunPodOperation::TerminatePod,
            "DELETE",
            "https://rest.runpod.io/v1/pods/abc123xy",
            None,
        );
        assert!(ValidatedRequest::try_from(valid).is_ok());
        for url in [
            "https://rest.runpod.io/v1/pods/abc123xy?force=true",
            "https://rest.runpod.io/v1/pods/abc123xy/other",
            "https://rest.runpod.io/v1/pods/..",
        ] {
            let invalid = request(RunPodOperation::TerminatePod, "DELETE", url, None);
            assert!(ValidatedRequest::try_from(invalid).is_err());
        }
    }

    fn managed_pod_json(volume_id: &str, gpu_id: &str) -> String {
        serde_json::json!({
            "id": "abc123xy",
            "name": "imageforge-request-123",
            "status": "running",
            "templateId": IMAGEFORGE_TEMPLATE_ID,
            "imageName": IMAGEFORGE_WORKER_IMAGE,
            "volumeMountPath": "/workspace",
            "interruptible": false,
            "networkVolume": {"id": volume_id, "dataCenterId": "EU-RO-1"},
            "machine": {
                "secureCloud": true,
                "dataCenterId": "EU-RO-1",
                "gpuTypeId": gpu_id
            },
            "gpu": {"id": gpu_id, "displayName": gpu_id, "count": 1},
            "gpuCount": 1,
            "ports": ["8000/http"],
            "adjustedCostPerHr": 0.54,
            "costPerHr": "0.54"
        })
        .to_string()
    }

    fn normal_start_profile() -> RunPodProfileBinding {
        RunPodProfileBinding {
            template_id: IMAGEFORGE_TEMPLATE_ID.to_owned(),
            network_volume_id: IMAGEFORGE_NETWORK_VOLUME_ID.to_owned(),
        }
    }

    #[test]
    fn normal_start_profile_list_rejects_unknown_rows_wrong_image_and_duplicate_ids() {
        let profile = normal_start_profile();
        let valid: Value = serde_json::from_str(&managed_pod_json(
            IMAGEFORGE_NETWORK_VOLUME_ID,
            "NVIDIA GeForce RTX 4090",
        ))
        .unwrap();

        let mut unknown = valid.clone();
        unknown["unreviewedProviderField"] = Value::Bool(true);
        assert!(serde_json::from_value::<NormalStartListPod>(unknown).is_err());

        let mut wrong_image = valid.clone();
        wrong_image["imageName"] = Value::String(
            "ghcr.io/attacker/imageforge-worker@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                .to_owned(),
        );
        let wrong_image: NormalStartListPod = serde_json::from_value(wrong_image).unwrap();
        assert!(!wrong_image.is_strictly_safe(&profile));

        let duplicate = serde_json::to_string(&vec![valid.clone(), valid]).unwrap();
        assert_eq!(
            parse_normal_start_list_pods(&duplicate, &profile)
                .unwrap_err()
                .code,
            "gpu_start_provider_response_invalid"
        );
    }

    #[test]
    fn foreign_pods_are_skipped_while_imageforge_named_pods_still_fail_closed() {
        let profile = normal_start_profile();
        let valid: Value = serde_json::from_str(&managed_pod_json(
            IMAGEFORGE_NETWORK_VOLUME_ID,
            "NVIDIA GeForce RTX 4090",
        ))
        .unwrap();

        // An unrelated Pod in the same account may carry any shape at all.
        // Before the ownership filter this aborted the whole observation and
        // left ImageForge permanently unable to see its own Pods.
        let foreign = serde_json::json!({
            "id": "foreign01",
            "name": "my-other-project",
            "desiredStatus": "RUNNING",
        });
        let parsed = parse_switch_managed_pod_list(
            &serde_json::to_string(&vec![foreign.clone(), valid.clone()]).unwrap(),
            &profile,
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].pod_id, "abc123xy");

        // A foreign Pod alone leaves an empty, successful observation rather
        // than a hard failure.
        assert!(parse_switch_managed_pod_list(
            &serde_json::to_string(&vec![foreign]).unwrap(),
            &profile,
            &HashMap::new(),
        )
        .unwrap()
        .is_empty());

        // A Pod carrying the reserved ImageForge name must still fail closed,
        // so an unverifiable managed Pod can never be dropped into a duplicate
        // billed Pod.
        let mut impostor = valid;
        impostor["imageName"] = Value::String(
            "ghcr.io/attacker/imageforge-worker@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                .to_owned(),
        );
        assert!(parse_switch_managed_pod_list(
            &serde_json::to_string(&vec![impostor]).unwrap(),
            &profile,
            &HashMap::new(),
        )
        .is_err());
    }

    #[test]
    fn terminal_pod_from_an_older_worker_image_cannot_disable_observation() {
        let profile = normal_start_profile();
        let live: Value = serde_json::from_str(&managed_pod_json(
            IMAGEFORGE_NETWORK_VOLUME_ID,
            "NVIDIA GeForce RTX 4090",
        ))
        .unwrap();
        let older_image =
            "ghcr.io/pala-lakshmansai/imageforge-worker@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        // The real failure: one exited Pod left from a previous pinned worker
        // image aborted every observation, so the app could never read Pod
        // state or Start again.
        for status in ["exited", "terminated"] {
            let mut historical = live.clone();
            historical["id"] = Value::String("oldpod01".to_owned());
            historical["name"] = Value::String("imageforge-archived".to_owned());
            historical["imageName"] = Value::String(older_image.to_owned());
            historical["status"] = Value::String(status.to_owned());

            let parsed = parse_switch_managed_pod_list(
                &serde_json::to_string(&vec![historical.clone(), live.clone()]).unwrap(),
                &profile,
                &HashMap::new(),
            )
            .unwrap();
            assert_eq!(parsed.len(), 1, "{status}: live Pod must survive");
            assert_eq!(parsed[0].pod_id, "abc123xy");

            // Alone, it leaves a clean empty observation instead of an error.
            assert!(parse_switch_managed_pod_list(
                &serde_json::to_string(&vec![historical]).unwrap(),
                &profile,
                &HashMap::new(),
            )
            .unwrap()
            .is_empty());
        }

        // An active Pod under an unrecognized image is the case that can mean
        // live billing or unknown code, so it must still fail closed.
        for status in ["provisioning", "starting", "running"] {
            let mut active = live.clone();
            active["id"] = Value::String("livepod1".to_owned());
            active["name"] = Value::String("imageforge-active".to_owned());
            active["imageName"] = Value::String(older_image.to_owned());
            active["status"] = Value::String(status.to_owned());
            assert!(
                parse_switch_managed_pod_list(
                    &serde_json::to_string(&vec![active]).unwrap(),
                    &profile,
                    &HashMap::new(),
                )
                .is_err(),
                "{status}: active mismatched Pod must fail closed"
            );
        }
    }

    #[test]
    fn list_pod_projection_drops_foreign_pods_before_they_reach_the_renderer() {
        let temporary = tempfile::tempdir().unwrap();
        let transport = RunPodTransport::new_for_test(
            Arc::new(MemoryVault::default()),
            temporary.path().join("marker"),
        )
        .unwrap();
        transport
            .bind_profile(IMAGEFORGE_TEMPLATE_ID, IMAGEFORGE_NETWORK_VOLUME_ID)
            .unwrap();
        let profile = normal_start_profile();
        let managed: Value = serde_json::from_str(&managed_pod_json(
            IMAGEFORGE_NETWORK_VOLUME_ID,
            "NVIDIA GeForce RTX 4090",
        ))
        .unwrap();
        // RunPod auto-names Pods this app never created. One of them used to
        // fail projection and take the whole Pod read down with it.
        let foreign = serde_json::json!({
            "id": "n45xsjzsedvzsx",
            "name": "controversial_sapphire_raccoon",
            "desiredStatus": "EXITED",
            "costPerHr": 0,
        });
        let raw = Value::Array(vec![foreign, managed]);
        let encoded = transport
            .project_and_register_pod_list(&raw, &profile)
            .unwrap();
        let projected: Vec<Value> = serde_json::from_str(&encoded).unwrap();
        assert_eq!(projected.len(), 1);
        assert_eq!(
            projected[0].get("id").and_then(Value::as_str),
            Some("abc123xy")
        );
        // The Start preflight rejects a list containing any unsafe row, so the
        // filtered projection is what keeps Start reachable.
        assert_eq!(
            parse_normal_start_list_pods(&encoded, &profile).unwrap().len(),
            1
        );
    }

    #[test]
    fn start_preflight_projection_drops_terminal_pods_from_an_older_worker_image() {
        let temporary = tempfile::tempdir().unwrap();
        let transport = RunPodTransport::new_for_test(
            Arc::new(MemoryVault::default()),
            temporary.path().join("marker"),
        )
        .unwrap();
        transport
            .bind_profile(IMAGEFORGE_TEMPLATE_ID, IMAGEFORGE_NETWORK_VOLUME_ID)
            .unwrap();
        let profile = normal_start_profile();
        let mut historical: Value = serde_json::from_str(&managed_pod_json(
            IMAGEFORGE_NETWORK_VOLUME_ID,
            "NVIDIA GeForce RTX 4090",
        ))
        .unwrap();
        historical["id"] = Value::String("oldpod01".to_owned());
        historical["name"] = Value::String("imageforge-archived".to_owned());
        historical["status"] = Value::String("exited".to_owned());
        historical["imageName"] = Value::String(
            "ghcr.io/pala-lakshmansai/imageforge-worker@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                .to_owned(),
        );

        let encoded = transport
            .project_and_register_pod_list(&Value::Array(vec![historical]), &profile)
            .unwrap();
        assert_eq!(serde_json::from_str::<Vec<Value>>(&encoded).unwrap().len(), 0);
        // `native_preflight_no_managed_pod` parses this body; one exited Pod
        // from an older image must not read as an existing managed Pod.
        assert!(parse_normal_start_list_pods(&encoded, &profile)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn current_runpod_image_field_is_canonicalized_for_managed_pod_identity() {
        let profile = normal_start_profile();
        let mut raw: Value = serde_json::from_str(&managed_pod_json(
            IMAGEFORGE_NETWORK_VOLUME_ID,
            "NVIDIA GeForce RTX 4090",
        ))
        .unwrap();
        raw.as_object_mut().unwrap().remove("imageName");
        raw.as_object_mut().unwrap().remove("gpuCount");
        raw.as_object_mut().unwrap().remove("status");
        raw["image"] = Value::String(IMAGEFORGE_WORKER_IMAGE.to_owned());
        raw["desiredStatus"] = Value::String("RUNNING".to_owned());

        let projected = project_pod(&raw).unwrap();
        assert_eq!(
            projected.get("imageName").and_then(Value::as_str),
            Some(IMAGEFORGE_WORKER_IMAGE)
        );
        assert!(projected.get("image").is_none());
        assert_eq!(projected.get("gpuCount").and_then(Value::as_u64), Some(1));
        assert_eq!(
            projected.get("status").and_then(Value::as_str),
            Some("running")
        );
        let parsed = parse_normal_start_list_pods(
            &serde_json::to_string(&vec![projected]).unwrap(),
            &profile,
        )
        .unwrap();
        assert_eq!(parsed.len(), 1);
        let parsed = parse_switch_managed_pod_list(
            &serde_json::to_string(&vec![raw.clone()]).unwrap(),
            &profile,
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].status, "running");

        raw["costPerHr"] = serde_json::json!(0.54);
        let parsed = parse_switch_managed_pod_list(
            &serde_json::to_string(&vec![raw.clone()]).unwrap(),
            &profile,
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(parsed[0].hourly_price_micro_usd, Some(540_000));

        // Current live Pod rows omit adjustedCostPerHr when no adjustment is
        // active. The exact base cost remains authoritative in that shape.
        raw.as_object_mut().unwrap().remove("adjustedCostPerHr");
        let parsed = parse_switch_managed_pod_list(
            &serde_json::to_string(&vec![raw.clone()]).unwrap(),
            &profile,
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(parsed[0].hourly_price_micro_usd, Some(540_000));

        raw["image"] = Value::String("ghcr.io/attacker/worker@sha256:bad".to_owned());
        let projected = project_pod(&raw).unwrap();
        let parsed: NormalStartListPod = serde_json::from_value(projected).unwrap();
        assert!(!parsed.is_strictly_safe(&profile));
    }

    #[test]
    fn strict_profile_list_projects_only_allowlisted_fields_and_rejects_partial_or_invalid_rows() {
        let profile = normal_start_profile();
        let valid: Value = serde_json::from_str(&managed_pod_json(
            IMAGEFORGE_NETWORK_VOLUME_ID,
            "NVIDIA GeForce RTX 4090",
        ))
        .unwrap();

        // Raw provider fields outside the explicit projection are ignored;
        // they cannot enter a managed-Pod identity or the verified registry.
        let mut raw_with_extra = valid.clone();
        raw_with_extra["providerPrivateField"] = Value::String("ignored".to_owned());
        let parsed = parse_switch_managed_pod_list(
            &serde_json::to_string(&vec![raw_with_extra]).unwrap(),
            &profile,
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].status, "running");
        assert_eq!(parsed[0].hourly_price_micro_usd, Some(540_000));

        // A field that somehow appears after native projection is a schema
        // drift/error, not an ignorable identity input.
        let mut crafted_projection = valid.clone();
        crafted_projection["unreviewedProjectedField"] = Value::Bool(true);
        assert!(validate_managed_pod_value(
            &crafted_projection,
            "abc123xy",
            &profile,
            &HashMap::new(),
        )
        .is_err());

        let duplicate = serde_json::to_string(&vec![valid.clone(), valid.clone()]).unwrap();
        let duplicate_error =
            parse_switch_managed_pod_list(&duplicate, &profile, &HashMap::new()).unwrap_err();
        assert_eq!(
            duplicate_error.code,
            "gpu_switch_provider_response_mismatch"
        );
        let observation_error = map_pod_observation_list_error(duplicate_error);
        assert_eq!(observation_error.code, "gpu_pod_observation_invalid");
        assert!(!observation_error.retryable);

        let mut missing_status = valid.clone();
        missing_status.as_object_mut().unwrap().remove("status");
        let missing_status_error = parse_switch_managed_pod_list(
            &serde_json::to_string(&vec![missing_status]).unwrap(),
            &profile,
            &HashMap::new(),
        )
        .unwrap_err();
        assert_eq!(
            map_pod_observation_list_error(missing_status_error).code,
            "gpu_pod_observation_invalid"
        );

        let mut unknown_status = valid.clone();
        unknown_status["status"] = Value::String("migrating".to_owned());
        assert!(parse_switch_managed_pod_list(
            &serde_json::to_string(&vec![unknown_status]).unwrap(),
            &profile,
            &HashMap::new(),
        )
        .is_err());

        let mut missing_price = valid;
        missing_price.as_object_mut().unwrap().remove("costPerHr");
        assert!(parse_switch_managed_pod_list(
            &serde_json::to_string(&vec![missing_price]).unwrap(),
            &profile,
            &HashMap::new(),
        )
        .is_err());
    }

    #[test]
    fn profile_list_rejects_cursor_envelopes_instead_of_treating_a_partial_page_as_empty() {
        let partial = serde_json::json!({
            "data": [],
            "nextCursor": "cursor-not-authorized"
        });
        let error = validate_complete_profile_list_shape(&partial).unwrap_err();
        assert_eq!(error.code, "gpu_switch_provider_response_mismatch");
        let observation_error = map_pod_observation_list_error(error);
        assert_eq!(observation_error.code, "gpu_pod_observation_invalid");
        assert!(!observation_error.retryable);

        let unavailable = map_pod_observation_list_error(NativeError::retryable(
            "gpu_switch_inventory_unavailable",
            "ignored",
        ));
        assert_eq!(unavailable.code, "gpu_pod_observation_unavailable");
        assert!(unavailable.retryable);
    }

    #[test]
    fn pod_observation_overflow_keeps_the_prior_verified_registry() {
        let temporary = tempfile::tempdir().unwrap();
        let transport = RunPodTransport::new_for_test(
            Arc::new(MemoryVault::default()),
            temporary.path().join("marker"),
        )
        .unwrap();
        transport
            .bind_profile(IMAGEFORGE_TEMPLATE_ID, IMAGEFORGE_NETWORK_VOLUME_ID)
            .unwrap();
        transport.verified_pods.write().unwrap().insert(
            "pod-prior".to_owned(),
            VerifiedManagedPod {
                pod_name: "imageforge-prior".to_owned(),
                gpu_id: "NVIDIA L4".to_owned(),
                gpu_display_name: "NVIDIA L4".to_owned(),
                dynamic_catalog_gpu: false,
            },
        );
        let overflow = (0..17)
            .map(|index| NativeRunPodManagedPodV1 {
                pod_id: format!("pod-{index:02}"),
                pod_name: format!("imageforge-{index:02}"),
                gpu_id: "NVIDIA GeForce RTX 4090".to_owned(),
                gpu_display_name: "NVIDIA GeForce RTX 4090".to_owned(),
                hourly_price_micro_usd: Some(540_000),
                status: "running".to_owned(),
                provider_response_sha256:
                    "1111111111111111111111111111111111111111111111111111111111111111".to_owned(),
            })
            .collect::<Vec<_>>();
        let profile_generation = *transport.profile_generation.lock().unwrap();
        transport.begin_pod_observation_generation(0).unwrap();
        assert!(!transport
            .replace_verified_pod_observation_for_generations(
                &overflow,
                &HashMap::new(),
                profile_generation,
                0,
            )
            .unwrap());
        let registry = transport.verified_pods.read().unwrap();
        assert_eq!(registry.len(), 1);
        assert!(registry.contains_key("pod-prior"));
    }

    #[test]
    fn old_profile_generation_cannot_repopulate_verified_pods_after_rebind() {
        let temporary = tempfile::tempdir().unwrap();
        let transport = RunPodTransport::new_for_test(
            Arc::new(MemoryVault::default()),
            temporary.path().join("marker"),
        )
        .unwrap();
        transport
            .bind_profile(IMAGEFORGE_TEMPLATE_ID, IMAGEFORGE_NETWORK_VOLUME_ID)
            .unwrap();
        let old_generation = *transport.profile_generation.lock().unwrap();
        transport.begin_pod_observation_generation(0).unwrap();
        let late_old_profile_result = vec![NativeRunPodManagedPodV1 {
            pod_id: "pod-old-profile".to_owned(),
            pod_name: "imageforge-old-profile".to_owned(),
            gpu_id: "NVIDIA GeForce RTX 4090".to_owned(),
            gpu_display_name: "NVIDIA GeForce RTX 4090".to_owned(),
            hourly_price_micro_usd: Some(540_000),
            status: "running".to_owned(),
            provider_response_sha256:
                "1111111111111111111111111111111111111111111111111111111111111111".to_owned(),
        }];

        // Rebinding the same configured profile is still a new authority
        // epoch: an old in-flight request must not repopulate its registry.
        transport
            .bind_profile(IMAGEFORGE_TEMPLATE_ID, IMAGEFORGE_NETWORK_VOLUME_ID)
            .unwrap();
        let error = transport
            .replace_verified_pod_observation_for_generations(
                &late_old_profile_result,
                &HashMap::new(),
                old_generation,
                0,
            )
            .unwrap_err();
        assert_eq!(error.code, "gpu_switch_inventory_unavailable");
        assert!(error.retryable);
        assert!(transport.verified_pods.read().unwrap().is_empty());
    }

    #[test]
    fn stop_observation_generation_blocks_a_late_heartbeat_registry_commit() {
        let temporary = tempfile::tempdir().unwrap();
        let transport = RunPodTransport::new_for_test(
            Arc::new(MemoryVault::default()),
            temporary.path().join("marker"),
        )
        .unwrap();
        transport
            .bind_profile(IMAGEFORGE_TEMPLATE_ID, IMAGEFORGE_NETWORK_VOLUME_ID)
            .unwrap();
        let profile_generation = *transport.profile_generation.lock().unwrap();
        let old_heartbeat = vec![NativeRunPodManagedPodV1 {
            pod_id: "pod-heartbeat-old".to_owned(),
            pod_name: "imageforge-heartbeat-old".to_owned(),
            gpu_id: "NVIDIA GeForce RTX 4090".to_owned(),
            gpu_display_name: "NVIDIA GeForce RTX 4090".to_owned(),
            hourly_price_micro_usd: Some(540_000),
            status: "running".to_owned(),
            provider_response_sha256:
                "1111111111111111111111111111111111111111111111111111111111111111".to_owned(),
        }];
        transport.begin_pod_observation_generation(0).unwrap();
        // Stop reserves the next action-owned observation before its R+1
        // profile read. The old in-flight heartbeat may still finish on the
        // wire but can no longer replace verified Pod authority.
        transport.begin_pod_observation_generation(1).unwrap();
        let error = transport
            .replace_verified_pod_observation_for_generations(
                &old_heartbeat,
                &HashMap::new(),
                profile_generation,
                0,
            )
            .unwrap_err();
        assert!(error.retryable);
        assert!(transport.verified_pods.read().unwrap().is_empty());
    }

    #[test]
    fn exact_managed_identity_is_required_before_delete() {
        let profile = RunPodProfileBinding {
            template_id: IMAGEFORGE_TEMPLATE_ID.into(),
            network_volume_id: IMAGEFORGE_NETWORK_VOLUME_ID.into(),
        };
        validate_managed_pod_value(
            &serde_json::from_str(&managed_pod_json(
                IMAGEFORGE_NETWORK_VOLUME_ID,
                "NVIDIA GeForce RTX 4090",
            ))
            .unwrap(),
            "abc123xy",
            &profile,
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(
            validate_managed_pod_value(
                &serde_json::from_str(
                    &managed_pod_json("other-volume", "NVIDIA GeForce RTX 4090",)
                )
                .unwrap(),
                "abc123xy",
                &profile,
                &HashMap::new(),
            )
            .unwrap_err()
            .code,
            "pod_identity_mismatch"
        );
        assert_eq!(
            validate_managed_pod_value(
                &serde_json::from_str(&managed_pod_json(
                    IMAGEFORGE_NETWORK_VOLUME_ID,
                    "NVIDIA B200",
                ))
                .unwrap(),
                "abc123xy",
                &profile,
                &HashMap::new(),
            )
            .unwrap_err()
            .code,
            "pod_identity_mismatch"
        );

        let temporary = tempfile::tempdir().unwrap();
        let transport = RunPodTransport::new_for_test(
            Arc::new(MemoryVault::default()),
            temporary.path().join("marker"),
        )
        .unwrap();
        transport
            .bind_profile(IMAGEFORGE_TEMPLATE_ID, IMAGEFORGE_NETWORK_VOLUME_ID)
            .unwrap();
        assert_eq!(
            transport.consume_delete_grant("abc123xy").unwrap_err().code,
            "pod_delete_not_verified"
        );
        transport.record_delete_grant("abc123xy").unwrap();
        assert_eq!(
            transport
                .consume_delete_grant("other-pod")
                .unwrap_err()
                .code,
            "pod_delete_not_verified"
        );
        transport.record_delete_grant("abc123xy").unwrap();
        transport.consume_delete_grant("abc123xy").unwrap();
        assert_eq!(
            transport.consume_delete_grant("abc123xy").unwrap_err().code,
            "pod_delete_not_verified"
        );
    }

    #[test]
    fn create_attempt_marker_survives_restart_and_blocks_duplicate_create() {
        let temporary = tempfile::tempdir().unwrap();
        let marker_directory = temporary.path().join("marker");
        let first = RunPodTransport::new_for_test(
            Arc::new(MemoryVault::default()),
            marker_directory.clone(),
        )
        .unwrap();
        first
            .create_marker
            .begin(&create_body(&["NVIDIA GeForce RTX 4090", "NVIDIA L4"]))
            .unwrap();
        let pending = first.create_marker_metadata().unwrap();
        assert!(pending.pending);
        assert!(pending.pod_id.is_none());

        let restarted = RunPodTransport::new_for_test(
            Arc::new(MemoryVault::default()),
            marker_directory.clone(),
        )
        .unwrap();
        assert_eq!(
            restarted.authorize_create().unwrap_err().code,
            "pod_create_reconciliation_required"
        );
        restarted.create_marker.set_pod_id("abc123xy").unwrap();

        let restarted_again =
            RunPodTransport::new_for_test(Arc::new(MemoryVault::default()), marker_directory)
                .unwrap();
        let exact = restarted_again.create_marker_metadata().unwrap();
        assert_eq!(exact.pod_id.as_deref(), Some("abc123xy"));
        assert_eq!(
            restarted_again
                .resolve_create_marker(exact.attempt_id.as_deref().unwrap(), None)
                .unwrap_err()
                .code,
            "pod_create_resolution_mismatch"
        );
        restarted_again.verified_pods.write().unwrap().insert(
            "abc123xy".to_owned(),
            VerifiedManagedPod {
                pod_name: exact.pod_name.clone().unwrap(),
                gpu_id: "NVIDIA L4".to_owned(),
                gpu_display_name: "NVIDIA L4".to_owned(),
                dynamic_catalog_gpu: false,
            },
        );
        restarted_again
            .resolve_create_marker(exact.attempt_id.as_deref().unwrap(), Some("abc123xy"))
            .unwrap();
        assert!(!restarted_again.create_marker_metadata().unwrap().pending);
        assert!(restarted_again.authorize_create().is_ok());
    }

    #[test]
    fn native_http_fixtures_strip_env_and_retain_exact_dynamic_blackwell_identity() {
        let temporary = tempfile::tempdir().unwrap();
        let transport = RunPodTransport::new_for_test(
            Arc::new(MemoryVault::default()),
            temporary.path().join("marker"),
        )
        .unwrap();
        transport
            .record_catalog_gpus(&serde_json::json!({
                "gpus": [
                    {"id": "dynamic-4500-id", "name": "RTX PRO 4500 Blackwell", "manufacturer": " nvidia ", "memory": 24},
                    {"id": "fuzzy-id", "name": "NVIDIA RTX PRO 4500 Blackwell Super", "manufacturer": "NVIDIA", "memory": 24},
                    {"id": "oversized-id", "name": "RTX PRO 4000 Blackwell", "manufacturer": "NVIDIA", "memory": 48}
                ]
            }))
            .unwrap();
        let inventory_url = Url::parse("https://api.runpod.io/v2/catalog/gpus?include=AVAILABILITY&product=POD&count=1&cloud=SECURE&minCudaVersion=13.0").unwrap();
        let projected_inventory = project_inventory_response(
            &inventory_url,
            &serde_json::json!({
                "gpus": [{
                    "id": "dynamic-4500-id", "name": "RTX PRO 4500 Blackwell", "manufacturer": "NVIDIA",
                    "memory": 24, "secure": true, "price": {"secure": 0.5, "community": 0.1},
                    "maxCount": {"secure": 1, "community": 99},
                    "dataCenters": [{"id": "EU-RO-1", "availability": "high", "internal": "hidden"}],
                    "env": {"API_KEY": "hidden"}
                }],
                "internal": "hidden"
            }),
        )
        .unwrap();
        let projected_inventory: Value = serde_json::from_str(&projected_inventory).unwrap();
        assert!(projected_inventory.get("internal").is_none());
        assert!(projected_inventory["gpus"][0].get("env").is_none());
        assert!(projected_inventory["gpus"][0]["price"]
            .get("community")
            .is_none());
        assert_eq!(
            transport.dynamic_catalog().unwrap(),
            HashMap::from([(
                "dynamic-4500-id".to_owned(),
                "RTX PRO 4500 Blackwell".to_owned()
            )])
        );
        assert!(transport
            .validate_create_gpu_policy(Some(&create_body(&["dynamic-4500-id"])))
            .is_ok());
        assert!(transport
            .validate_create_gpu_policy(Some(&create_body(&["fuzzy-id"])))
            .is_err());

        let raw = serde_json::json!({
            "id": "abc123xy", "name": "imageforge-request-123", "templateId": IMAGEFORGE_TEMPLATE_ID,
            "imageName": IMAGEFORGE_WORKER_IMAGE,
            "volumeMountPath": "/workspace", "interruptible": false,
            "networkVolume": {"id": IMAGEFORGE_NETWORK_VOLUME_ID, "dataCenterId": "EU-RO-1", "secret": "hidden"},
            "machine": {
                "secureCloud": true,
                "dataCenterId": "EU-RO-1",
                "gpuTypeId": "dynamic-4500-id",
                "internalIp": "hidden"
            },
            "gpu": {"id": "dynamic-4500-id", "displayName": "RTX PRO 4500 Blackwell", "count": 1, "serial": "hidden"},
            "gpuCount": 1,
            "ports": ["8000/http"], "env": {"WORKER_TOKEN": "must-not-cross"}
        });
        let projected = project_pod(&raw).unwrap();
        assert!(projected.get("env").is_none());
        assert!(projected["gpu"].get("serial").is_none());
        assert!(projected["machine"].get("internalIp").is_none());
        let profile = RunPodProfileBinding {
            template_id: IMAGEFORGE_TEMPLATE_ID.into(),
            network_volume_id: IMAGEFORGE_NETWORK_VOLUME_ID.into(),
        };
        validate_managed_pod_value(
            &projected,
            "abc123xy",
            &profile,
            &transport.dynamic_catalog().unwrap(),
        )
        .unwrap();
        transport
            .register_verified_pod("abc123xy", &projected)
            .unwrap();
        let registered = transport.verified_pods.read().unwrap();
        let retained = registered.get("abc123xy").unwrap();
        assert!(retained.dynamic_catalog_gpu);
        assert_eq!(retained.gpu_id, "dynamic-4500-id");
        assert_eq!(retained.gpu_display_name, "RTX PRO 4500 Blackwell");
        drop(registered);
        transport.catalog_dynamic_gpus.write().unwrap().clear();
        validate_managed_pod_value(
            &projected,
            "abc123xy",
            &profile,
            &transport.dynamic_catalog_for_pod("abc123xy").unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn expanded_static_gpu_ids_are_createable_but_b200_is_not() {
        let temporary = tempfile::tempdir().unwrap();
        let transport = RunPodTransport::new_for_test(
            Arc::new(MemoryVault::default()),
            temporary.path().join("marker"),
        )
        .unwrap();
        for gpu_id in [
            "NVIDIA A100 80GB PCIe",
            "NVIDIA RTX PRO 6000 Blackwell Server Edition",
            "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
        ] {
            assert!(
                transport
                    .validate_create_gpu_policy(Some(&create_body(&[gpu_id])))
                    .is_ok(),
                "{gpu_id}"
            );
        }
        assert!(transport
            .validate_create_gpu_policy(Some(&create_body(&["NVIDIA B200"])))
            .is_err());
    }

    #[test]
    fn create_success_fixture_projects_exact_pod_and_persists_its_id() {
        let temporary = tempfile::tempdir().unwrap();
        let transport = RunPodTransport::new_for_test(
            Arc::new(MemoryVault::default()),
            temporary.path().join("marker"),
        )
        .unwrap();
        let body = create_body(&["NVIDIA GeForce RTX 4090"]);
        transport.create_marker.begin(&body).unwrap();
        let raw: Value = serde_json::from_str(&managed_pod_json(
            IMAGEFORGE_NETWORK_VOLUME_ID,
            "NVIDIA GeForce RTX 4090",
        ))
        .unwrap();
        let profile = RunPodProfileBinding {
            template_id: IMAGEFORGE_TEMPLATE_ID.into(),
            network_volume_id: IMAGEFORGE_NETWORK_VOLUME_ID.into(),
        };
        let projected = transport
            .project_and_register_created_pod(&raw, &body, &profile)
            .unwrap();
        let projected: Value = serde_json::from_str(&projected).unwrap();
        assert!(projected.get("env").is_none());
        assert_eq!(
            transport
                .create_marker_metadata()
                .unwrap()
                .pod_id
                .as_deref(),
            Some("abc123xy")
        );
        transport
            .project_and_register_pod_list(&serde_json::json!([raw]), &profile)
            .unwrap();
        assert!(!transport.create_marker_metadata().unwrap().pending);
    }

    #[test]
    fn live_on_demand_shape_synthesizes_gpu_and_interruptible_defaults() {
        let temporary = tempfile::tempdir().unwrap();
        let transport = RunPodTransport::new_for_test(
            Arc::new(MemoryVault::default()),
            temporary.path().join("marker"),
        )
        .unwrap();
        let raw = serde_json::json!({
            "id": "live4090pod",
            "name": "imageforge-live",
            "templateId": IMAGEFORGE_TEMPLATE_ID,
            "imageName": IMAGEFORGE_WORKER_IMAGE,
            "volumeMountPath": "/workspace",
            "networkVolume": {"id": IMAGEFORGE_NETWORK_VOLUME_ID, "dataCenterId": "EU-RO-1"},
            "machine": {
                "secureCloud": true,
                "dataCenterId": "EU-RO-1",
                "gpuTypeId": "NVIDIA GeForce RTX 4090"
            },
            "gpu": null,
            "gpuCount": 1,
            "ports": ["8000/http"]
        });
        let profile = RunPodProfileBinding {
            template_id: IMAGEFORGE_TEMPLATE_ID.into(),
            network_volume_id: IMAGEFORGE_NETWORK_VOLUME_ID.into(),
        };
        let projected = project_pod(&raw).unwrap();
        assert_eq!(projected["interruptible"], false);
        assert_eq!(projected["gpu"]["id"], "NVIDIA GeForce RTX 4090");
        assert_eq!(projected["gpu"]["count"], 1);
        validate_managed_pod_value(
            &projected,
            "live4090pod",
            &profile,
            &transport.dynamic_catalog().unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn live_on_demand_shape_with_omitted_gpu_is_projected_for_reverification() {
        let temporary = tempfile::tempdir().unwrap();
        let transport = RunPodTransport::new_for_test(
            Arc::new(MemoryVault::default()),
            temporary.path().join("marker"),
        )
        .unwrap();
        let raw = serde_json::json!({
            "id": "live-omitted-gpu",
            "name": "imageforge-live",
            "templateId": IMAGEFORGE_TEMPLATE_ID,
            "imageName": IMAGEFORGE_WORKER_IMAGE,
            "volumeMountPath": "/workspace",
            "interruptible": false,
            "networkVolume": {"id": IMAGEFORGE_NETWORK_VOLUME_ID, "dataCenterId": "EU-RO-1"},
            "machine": {
                "secureCloud": true,
                "dataCenterId": "EU-RO-1",
                "gpuTypeId": "NVIDIA GeForce RTX 4090"
            },
            "gpuCount": 1,
            "ports": ["8000/http"]
        });
        let profile = RunPodProfileBinding {
            template_id: IMAGEFORGE_TEMPLATE_ID.into(),
            network_volume_id: IMAGEFORGE_NETWORK_VOLUME_ID.into(),
        };
        let projected = project_pod(&raw).unwrap();
        assert_eq!(projected["gpu"]["id"], "NVIDIA GeForce RTX 4090");
        validate_managed_pod_value(
            &projected,
            "live-omitted-gpu",
            &profile,
            &transport.dynamic_catalog().unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn foreground_and_emergency_grants_are_distinct_and_one_use() {
        let temporary = tempfile::tempdir().unwrap();
        let transport = RunPodTransport::new_for_test(
            Arc::new(MemoryVault::default()),
            temporary.path().join("marker"),
        )
        .unwrap();
        let create = transport.authorize_create().unwrap();
        transport
            .consume_foreground_grants(
                Some(&create),
                None,
                Some(&create_body(&["NVIDIA GeForce RTX 4090"])),
            )
            .unwrap();
        assert_eq!(
            transport
                .consume_foreground_grants(
                    Some(&create),
                    None,
                    Some(&create_body(&["NVIDIA GeForce RTX 4090"])),
                )
                .unwrap_err()
                .code,
            "pod_create_not_authorized"
        );

        let create = transport.authorize_create().unwrap();
        assert_eq!(
            transport
                .consume_foreground_grants(
                    Some(&create),
                    None,
                    Some(&create_body(&[EMERGENCY_GPU_ID])),
                )
                .unwrap_err()
                .code,
            "emergency_gpu_not_authorized"
        );
        let create = transport.authorize_create().unwrap();
        let emergency = transport.authorize_emergency_gpu().unwrap();
        transport
            .consume_foreground_grants(
                Some(&create),
                Some(&emergency),
                Some(&create_body(&[EMERGENCY_GPU_ID])),
            )
            .unwrap();
        assert_eq!(
            transport
                .consume_foreground_grants(
                    Some(&create),
                    Some(&emergency),
                    Some(&create_body(&[EMERGENCY_GPU_ID])),
                )
                .unwrap_err()
                .code,
            "pod_create_not_authorized"
        );
    }

    #[test]
    fn saved_secret_reflection_is_rejected_before_runpod_projection() {
        let secret = "rp_live_exact_secret";
        assert_eq!(
            reject_secret_reflection(&serde_json::json!({"env": {"API_KEY": secret}}), [secret])
                .unwrap_err()
                .code,
            "secret_reflection_rejected"
        );
    }

    #[test]
    fn mutation_boundary_classifies_only_paid_provider_writes() {
        assert_eq!(
            native_mutation_kind_for_operation(RunPodOperation::CreatePod),
            Some(NativeRunPodMutationKind::Create)
        );
        assert_eq!(
            native_mutation_kind_for_operation(RunPodOperation::TerminatePod),
            Some(NativeRunPodMutationKind::Delete)
        );
        for operation in [
            RunPodOperation::Inventory,
            RunPodOperation::ListPods,
            RunPodOperation::GetPod,
        ] {
            assert_eq!(native_mutation_kind_for_operation(operation), None);
        }
    }

    #[tokio::test]
    async fn rejecting_native_mutation_hook_stops_direct_and_generic_writes_before_send() {
        fn rejecting_hook(
            calls: Arc<Mutex<Vec<NativeRunPodMutationKind>>>,
        ) -> NativeRunPodMutationHook {
            Arc::new(move |kind| {
                calls.lock().map_err(|_| state_error())?.push(kind);
                Err(NativeError::new(
                    "queue_release_provider_write_blocked",
                    "The installed release harness rejected this provider mutation before send.",
                ))
            })
        }

        fn configured_transport() -> (tempfile::TempDir, RunPodTransport, Arc<MemoryVault>) {
            let temporary = tempfile::tempdir().unwrap();
            let marker = temporary.path().join("marker");
            let vault = Arc::new(MemoryVault::default());
            vault
                .replace(CredentialKind::RunpodApiKey, "rp_live_test_hook_key")
                .unwrap();
            let transport = RunPodTransport::new_for_test(vault.clone(), marker).unwrap();
            transport
                .bind_profile(IMAGEFORGE_TEMPLATE_ID, IMAGEFORGE_NETWORK_VOLUME_ID)
                .unwrap();
            (temporary, transport, vault)
        }

        // The direct native Start POST has no generic request object. Its hook
        // must still reject at the same pre-wire boundary.
        let (_direct_temp, direct, _vault) = configured_transport();
        let direct_calls = Arc::new(Mutex::new(Vec::new()));
        direct
            .set_native_mutation_hook(Some(rejecting_hook(direct_calls.clone())))
            .unwrap();
        let direct_body = create_body(&["NVIDIA GeForce RTX 4090"]);
        let direct_error = direct
            .native_create_selected_pod(
                direct_body.clone(),
                super::super::gpu_inventory::jcs_value(&direct_body).unwrap(),
            )
            .await
            .unwrap_err();
        assert_eq!(direct_error.code, "queue_release_provider_write_blocked");
        assert_eq!(
            *direct_calls.lock().unwrap(),
            vec![NativeRunPodMutationKind::Create]
        );

        // The legacy generic Create path remains native-only, but is also
        // guarded until it is fully removed from compatibility internals.
        let (_generic_create_temp, generic_create, _vault) = configured_transport();
        let create_calls = Arc::new(Mutex::new(Vec::new()));
        generic_create
            .set_native_mutation_hook(Some(rejecting_hook(create_calls.clone())))
            .unwrap();
        let create_grant = generic_create.authorize_create().unwrap();
        let create_error = generic_create
            .execute(RunPodHttpRequest::post(
                RunPodOperation::CreatePod,
                "https://rest.runpod.io/v1/pods".to_owned(),
                create_body(&["NVIDIA GeForce RTX 4090"]),
                create_grant,
                None,
            ))
            .await
            .unwrap_err();
        assert_eq!(create_error.code, "queue_release_provider_write_blocked");
        assert_eq!(
            *create_calls.lock().unwrap(),
            vec![NativeRunPodMutationKind::Create]
        );

        // Generic Terminate has its own one-use identity grant, which must be
        // consumed before the same rejecting socket boundary is reached.
        let (_generic_delete_temp, generic_delete, _vault) = configured_transport();
        let delete_calls = Arc::new(Mutex::new(Vec::new()));
        generic_delete
            .set_native_mutation_hook(Some(rejecting_hook(delete_calls.clone())))
            .unwrap();
        generic_delete.record_delete_grant("safe-pod-1").unwrap();
        let delete_error = generic_delete
            .execute(RunPodHttpRequest::delete(
                RunPodOperation::TerminatePod,
                "https://rest.runpod.io/v1/pods/safe-pod-1".to_owned(),
            ))
            .await
            .unwrap_err();
        assert_eq!(delete_error.code, "queue_release_provider_write_blocked");
        assert_eq!(
            *delete_calls.lock().unwrap(),
            vec![NativeRunPodMutationKind::Delete]
        );
    }


    #[test]
    fn create_marker_retires_when_its_pod_is_absent_or_terminal() {
        for scenario in ["absent", "exited", "terminated"] {
            let temporary = tempfile::tempdir().unwrap();
            let transport = RunPodTransport::new_for_test(
                Arc::new(MemoryVault::default()),
                temporary.path().join("marker"),
            )
            .unwrap();
            transport
                .bind_profile(IMAGEFORGE_TEMPLATE_ID, IMAGEFORGE_NETWORK_VOLUME_ID)
                .unwrap();
            let body = create_body(&["NVIDIA GeForce RTX 4090"]);
            transport.create_marker.begin(&body).unwrap();
            transport.create_marker.set_pod_id("abc123xy").unwrap();
            assert!(transport.create_marker.metadata().unwrap().pending);

            let pods = if scenario == "absent" {
                vec![]
            } else {
                let mut pod: Value =
                    serde_json::from_str(&managed_pod_json(
                        IMAGEFORGE_NETWORK_VOLUME_ID,
                        "NVIDIA GeForce RTX 4090",
                    ))
                    .unwrap();
                pod["status"] = Value::String(scenario.to_owned());
                vec![pod]
            };
            transport.retire_create_marker_against_list(&pods).unwrap();
            assert!(
                !transport.create_marker.metadata().unwrap().pending,
                "{scenario}: marker must retire"
            );
        }
    }

    #[test]
    fn create_marker_survives_while_its_pod_is_still_active() {
        for status in ["provisioning", "starting", "running"] {
            let temporary = tempfile::tempdir().unwrap();
            let transport = RunPodTransport::new_for_test(
                Arc::new(MemoryVault::default()),
                temporary.path().join("marker"),
            )
            .unwrap();
            transport
                .bind_profile(IMAGEFORGE_TEMPLATE_ID, IMAGEFORGE_NETWORK_VOLUME_ID)
                .unwrap();
            let body = create_body(&["NVIDIA GeForce RTX 4090"]);
            transport.create_marker.begin(&body).unwrap();
            transport.create_marker.set_pod_id("abc123xy").unwrap();

            let mut pod: Value = serde_json::from_str(&managed_pod_json(
                IMAGEFORGE_NETWORK_VOLUME_ID,
                "NVIDIA GeForce RTX 4090",
            ))
            .unwrap();
            pod["status"] = Value::String(status.to_owned());
            transport.retire_create_marker_against_list(&[pod]).unwrap();
            assert!(
                transport.create_marker.metadata().unwrap().pending,
                "{status}: an active Pod must keep the marker pending"
            );
        }
    }

    #[test]
    fn only_bounded_numeric_retry_after_metadata_crosses_the_native_boundary() {
        assert_eq!(safe_retry_after("15").as_deref(), Some("15"));
        assert_eq!(safe_retry_after("00015").as_deref(), Some("15"));
        assert!(safe_retry_after("86401").is_none());
        assert!(safe_retry_after("rp_live_reflected_secret").is_none());
        assert!(safe_retry_after("Wed, 21 Oct 2015 07:28:00 GMT").is_none());
    }
}
