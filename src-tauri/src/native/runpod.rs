use super::session::validate_pod_id;
use super::{CredentialKind, CredentialVault, NativeError, NativeResult};
use futures_util::StreamExt;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use url::Url;

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const REST_HOST: &str = "rest.runpod.io";
const INVENTORY_HOST: &str = "api.runpod.io";
const DELETE_GRANT_TTL: Duration = Duration::from_secs(30);

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
}

impl RunPodHttpRequest {
    pub fn get(operation: RunPodOperation, url: String) -> Self {
        Self {
            operation,
            method: "GET".to_owned(),
            url,
            body: None,
        }
    }

    pub fn post(operation: RunPodOperation, url: String, body: Value) -> Self {
        Self {
            operation,
            method: "POST".to_owned(),
            url,
            body: Some(body),
        }
    }

    pub fn delete(operation: RunPodOperation, url: String) -> Self {
        Self {
            operation,
            method: "DELETE".to_owned(),
            url,
            body: None,
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
}

impl RunPodTransport {
    pub fn new(vault: Arc<dyn CredentialVault>) -> NativeResult<Self> {
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
        })
    }

    pub fn bind_profile(&self, template_id: &str, network_volume_id: &str) -> NativeResult<()> {
        if !safe_identifier(template_id, false) || !safe_identifier(network_volume_id, false) {
            return Err(NativeError::new(
                "runpod_profile_invalid",
                "The RunPod template or network-volume identifier is invalid.",
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
        Ok(())
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
        }
        if validated.operation == RunPodOperation::TerminatePod {
            self.consume_delete_grant(validated.pod_id.as_deref().ok_or_else(rejected)?)?;
        }
        let credential = self.vault.load(CredentialKind::RunpodApiKey)?;
        let mut builder = self
            .client
            .request(validated.method, validated.url)
            .header(ACCEPT, "application/json")
            .header(AUTHORIZATION, format!("Bearer {credential}"));
        if let Some(body) = validated.body {
            builder = builder.header(CONTENT_TYPE, "application/json").json(&body);
        }
        // Drop the only in-scope secret before awaiting the network. The header
        // value remains owned solely by reqwest's native request object.
        drop(credential);

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
            .map(str::to_owned);
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.starts_with("application/json"))
            .map(|_| "application/json".to_owned());

        let body = if (200..300).contains(&status) {
            read_bounded_body(response, MAX_RESPONSE_BYTES).await?
        } else {
            // Error bodies are intentionally not bridged into the renderer;
            // status and Retry-After are sufficient for the typed TS client.
            String::new()
        };
        if validated.operation == RunPodOperation::GetPod && (200..300).contains(&status) {
            let pod_id = validated.pod_id.as_deref().ok_or_else(rejected)?;
            validate_managed_pod_response(&body, pod_id, profile.as_ref().unwrap())?;
            self.record_delete_grant(pod_id)?;
        }
        Ok(RunPodHttpResponse {
            status,
            body,
            retry_after,
            content_type,
        })
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

#[derive(Debug)]
struct ValidatedRequest {
    operation: RunPodOperation,
    method: Method,
    url: Url,
    body: Option<Value>,
    pod_id: Option<String>,
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
        })
    }
}

fn validate_bound_create_profile(
    body: Option<&Value>,
    profile: &RunPodProfileBinding,
) -> NativeResult<()> {
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

fn validate_managed_pod_response(
    body: &str,
    expected_pod_id: &str,
    profile: &RunPodProfileBinding,
) -> NativeResult<()> {
    let pod: Value = serde_json::from_str(body).map_err(|_| {
        NativeError::new(
            "runpod_response_invalid",
            "RunPod returned malformed Pod identity data.",
        )
    })?;
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
        || (gpu_display.to_ascii_uppercase().contains("BLACKWELL")
            && (gpu_display.to_ascii_uppercase().contains("RTX PRO 4500")
                || gpu_display.to_ascii_uppercase().contains("RTX PRO 4000")));
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
        && ports.iter().any(|port| port.as_str() == Some("8000/http"));
    if !valid {
        return Err(NativeError::new(
            "pod_identity_mismatch",
            "RunPod did not return the exact managed ImageForge Pod identity.",
        ));
    }
    Ok(())
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
    require_query(
        url,
        &[
            ("computeType", "GPU"),
            ("includeMachine", "true"),
            ("includeNetworkVolume", "true"),
            ("dataCenterId", "EU-RO-1"),
        ],
    )
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
        if !approved_gpu_id(gpu_id) || !seen.insert(gpu_id) {
            return Err(rejected());
        }
    }
    Ok(())
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
    let mut actual = BTreeMap::<String, String>::new();
    for (key, value) in url.query_pairs() {
        if actual
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err(rejected());
        }
    }
    let expected = required
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect::<BTreeMap<_, _>>();
    if actual != expected {
        return Err(rejected());
    }
    Ok(())
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
        "NVIDIA RTX 2000 Ada Generation",
    ];
    if STATIC.contains(&value) {
        return true;
    }
    let upper = value.to_ascii_uppercase();
    value.is_ascii()
        && value.len() <= 191
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b' ' | b'.' | b'_' | b'+' | b'-')
        })
        && upper.contains("NVIDIA")
        && upper.contains("BLACKWELL")
        && (upper.contains("RTX PRO 4500") || upper.contains("RTX PRO 4000"))
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
        }
    }

    fn create_body(gpus: &[&str]) -> Value {
        serde_json::json!({
            "name": "imageforge-request-123",
            "templateId": "imageforge-worker-v1",
            "networkVolumeId": "if-models-production",
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
            "https://rest.runpod.io/v1/pods?computeType=GPU&includeMachine=true&includeNetworkVolume=true&dataCenterId=EU-RO-1",
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
            vec!["NVIDIA B200"],
            vec!["NVIDIA RTX PRO 6000 Blackwell"],
            vec!["NVIDIA GeForce RTX 4090", "NVIDIA GeForce RTX 4090"],
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
            "templateId": "imageforge-worker-v1",
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
            template_id: "imageforge-worker-v1".into(),
            network_volume_id: "if-models-production".into(),
        };
        validate_managed_pod_response(
            &managed_pod_json("if-models-production", "NVIDIA GeForce RTX 4090"),
            "abc123xy",
            &profile,
        )
        .unwrap();
        assert_eq!(
            validate_managed_pod_response(
                &managed_pod_json("other-volume", "NVIDIA GeForce RTX 4090"),
                "abc123xy",
                &profile,
            )
            .unwrap_err()
            .code,
            "pod_identity_mismatch"
        );
        assert_eq!(
            validate_managed_pod_response(
                &managed_pod_json("if-models-production", "NVIDIA B200"),
                "abc123xy",
                &profile,
            )
            .unwrap_err()
            .code,
            "pod_identity_mismatch"
        );

        let transport = RunPodTransport::new(Arc::new(MemoryVault::default())).unwrap();
        transport
            .bind_profile("imageforge-worker-v1", "if-models-production")
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
}
