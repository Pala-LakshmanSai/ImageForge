use super::session::validate_pod_id;
use super::{CredentialKind, CredentialVault, NativeError, NativeResult};
use futures_util::StreamExt;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
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
    "ghcr.io/pala-lakshmansai/imageforge-worker@sha256:f862e1ea8ece9f35101e7c47be55a5042c17e0eb3cf8414dd709ed73a59e33ed";

#[derive(Debug, Clone, PartialEq, Eq)]
struct RunPodProfileBinding {
    template_id: String,
    network_volume_id: String,
}

#[derive(Debug, Clone)]
struct DeleteGrant {
    pod_id: String,
    verified_at: Instant,
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

#[derive(Clone)]
pub struct RunPodTransport {
    client: Client,
    vault: Arc<dyn CredentialVault>,
    profile: Arc<RwLock<Option<RunPodProfileBinding>>>,
    delete_grant: Arc<Mutex<Option<DeleteGrant>>>,
    create_grant: Arc<Mutex<Option<ForegroundGrant>>>,
    emergency_grant: Arc<Mutex<Option<ForegroundGrant>>>,
    catalog_dynamic_gpus: Arc<RwLock<HashMap<String, String>>>,
    verified_pods: Arc<RwLock<HashMap<String, VerifiedManagedPod>>>,
    create_marker: Arc<CreateMarkerStore>,
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
            delete_grant: Arc::new(Mutex::new(None)),
            create_grant: Arc::new(Mutex::new(None)),
            emergency_grant: Arc::new(Mutex::new(None)),
            catalog_dynamic_gpus: Arc::new(RwLock::new(HashMap::new())),
            verified_pods: Arc::new(RwLock::new(HashMap::new())),
            create_marker: Arc::new(CreateMarkerStore::new(marker_directory)),
        })
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
        *profile = Some(RunPodProfileBinding {
            template_id: template_id.to_owned(),
            network_volume_id: network_volume_id.to_owned(),
        });
        if let Ok(mut grant) = self.delete_grant.lock() {
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
        let response = builder.send().await.map_err(|_| {
            NativeError::retryable(
                "runpod_network_error",
                "RunPod could not be reached over the secure network connection.",
            )
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
            let Some(canonical_name) = canonical_dynamic_gpu_name(name) else {
                continue;
            };
            if manufacturer.is_some_and(|value| normalize_catalog_name(value) == "NVIDIA")
                && memory.is_some_and(|memory| (16.0..=32.0).contains(&memory))
                && safe_gpu_identifier(id)
                && !id.to_ascii_uppercase().contains("RTX PRO 6000")
                && id != "NVIDIA B200"
            {
                approved.insert(id.to_owned(), canonical_name.to_owned());
            }
        }
        *self
            .catalog_dynamic_gpus
            .write()
            .map_err(|_| state_error())? = approved;
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
            let dynamic = pod
                .get("id")
                .and_then(Value::as_str)
                .map(|pod_id| self.dynamic_catalog_for_pod(pod_id))
                .transpose()?
                .unwrap_or_default();
            let value = project_pod_with_dynamic(pod, &dynamic)?;
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
                }
            }
            projected.push(value);
        }
        serde_json::to_string(&projected).map_err(|_| response_invalid())
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

fn validate_managed_pod_value(
    pod: &Value,
    expected_pod_id: &str,
    profile: &RunPodProfileBinding,
    dynamic_gpus: &HashMap<String, String>,
) -> NativeResult<()> {
    validate_approved_profile_ids(&profile.template_id, &profile.network_volume_id)?;
    let object = pod.as_object().ok_or_else(rejected)?;
    let network_volume = object
        .get("networkVolume")
        .and_then(Value::as_object)
        .ok_or_else(rejected)?;
    let machine = object
        .get("machine")
        .and_then(Value::as_object)
        .ok_or_else(rejected)?;
    let gpu = object
        .get("gpu")
        .and_then(Value::as_object)
        .ok_or_else(rejected)?;
    let ports = object
        .get("ports")
        .and_then(Value::as_array)
        .ok_or_else(rejected)?;
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
            .is_some_and(|name| name == "imageforge" || name.starts_with("imageforge-"))
        && object.get("templateId").and_then(Value::as_str) == Some(profile.template_id.as_str())
        && object.get("volumeMountPath").and_then(Value::as_str) == Some("/workspace")
        && object.get("interruptible").and_then(Value::as_bool) == Some(false)
        && network_volume.get("id").and_then(Value::as_str)
            == Some(profile.network_volume_id.as_str())
        && network_volume.get("dataCenterId").and_then(Value::as_str) == Some("EU-RO-1")
        && machine.get("secureCloud").and_then(Value::as_bool) == Some(true)
        && machine.get("dataCenterId").and_then(Value::as_str) == Some("EU-RO-1")
        && gpu.get("count").and_then(Value::as_u64) == Some(1)
        && gpu_approved
        && ports.len() == 1
        && ports[0].as_str() == Some("8000/http");
    if !valid {
        return Err(NativeError::new(
            "pod_identity_mismatch",
            "RunPod did not return the exact managed ImageForge Pod identity.",
        ));
    }
    Ok(())
}

const POD_PROJECTION_KEYS: &[&str] = &[
    "id",
    "name",
    "desiredStatus",
    "status",
    "templateId",
    "volumeMountPath",
    "interruptible",
    "networkVolume",
    "gpu",
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
    if pairs.get("templateId").map(String::as_str) != Some(IMAGEFORGE_TEMPLATE_ID)
        || pairs.get("networkVolumeId").map(String::as_str) != Some(IMAGEFORGE_NETWORK_VOLUME_ID)
    {
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
            "templateId": IMAGEFORGE_TEMPLATE_ID,
            "volumeMountPath": "/workspace",
            "interruptible": false,
            "networkVolume": {"id": volume_id, "dataCenterId": "EU-RO-1"},
            "machine": {"secureCloud": true, "dataCenterId": "EU-RO-1"},
            "gpu": {"id": gpu_id, "displayName": gpu_id, "count": 1},
            "ports": ["8000/http"]
        })
        .to_string()
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
            "volumeMountPath": "/workspace", "interruptible": false,
            "networkVolume": {"id": IMAGEFORGE_NETWORK_VOLUME_ID, "dataCenterId": "EU-RO-1", "secret": "hidden"},
            "machine": {"secureCloud": true, "dataCenterId": "EU-RO-1", "internalIp": "hidden"},
            "gpu": {"id": "dynamic-4500-id", "displayName": "RTX PRO 4500 Blackwell", "count": 1, "serial": "hidden"},
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
    fn only_bounded_numeric_retry_after_metadata_crosses_the_native_boundary() {
        assert_eq!(safe_retry_after("15").as_deref(), Some("15"));
        assert_eq!(safe_retry_after("00015").as_deref(), Some("15"));
        assert!(safe_retry_after("86401").is_none());
        assert!(safe_retry_after("rp_live_reflected_secret").is_none());
        assert!(safe_retry_after("Wed, 21 Oct 2015 07:28:00 GMT").is_none());
    }
}
