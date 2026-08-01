use super::session::WorkerSessionPin;
use super::{CredentialKind, CredentialVault, NativeError, NativeResult, WorkerSession};
use futures_util::StreamExt;
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
const MAX_PROMPTS: usize = 500;
const MAX_PROMPT_BYTES: usize = 4096;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateBatchInput {
    pub prompts: Vec<String>,
    pub base_seed: u64,
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

#[derive(Debug, Clone, Copy)]
enum WorkerOperation {
    Health,
    Status,
    Manifest,
    Receipt,
}

impl WorkerApi {
    pub fn new(vault: Arc<dyn CredentialVault>, session: WorkerSession) -> NativeResult<Self> {
        let client = Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(45))
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

    pub async fn create_batch(&self, input: CreateBatchInput) -> NativeResult<WorkerHttpResponse> {
        validate_create_batch(&input)?;
        self.request_json(
            Method::POST,
            "/v1/batches",
            Some(json!({"prompts": input.prompts, "base_seed": input.base_seed})),
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
    pub async fn preview(&self, batch_id: Uuid, index: u16) -> NativeResult<WorkerPreviewResponse> {
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
        index: u16,
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
        let response = builder.send().await.map_err(|_| {
            NativeError::retryable(
                "worker_network_error",
                "The ImageForge worker could not be reached.",
            )
        })?;
        let status = response.status();
        let bytes = read_bounded(response, MAX_JSON_RESPONSE_BYTES).await?;
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
        let body = if status.is_success() {
            project_worker_success(operation, &body)?
        } else {
            project_worker_error(&body)?
        };
        Ok(WorkerHttpResponse {
            status: status.as_u16(),
            body,
        })
    }
}

fn validate_create_batch(input: &CreateBatchInput) -> NativeResult<()> {
    if input.prompts.is_empty()
        || input.prompts.len() > MAX_PROMPTS
        || input.base_seed > (i64::MAX as u64).saturating_sub(MAX_PROMPTS as u64)
    {
        return Err(NativeError::new(
            "batch_invalid",
            "A batch must contain 1–500 prompts and a valid base seed.",
        ));
    }
    if input.prompts.iter().any(|prompt| {
        prompt.trim().is_empty()
            || prompt.len() > MAX_PROMPT_BYTES
            || prompt.chars().any(|character| character == '\0')
    }) {
        return Err(NativeError::new(
            "batch_invalid",
            "Each prompt must contain text and fit within 4096 UTF-8 bytes.",
        ));
    }
    Ok(())
}

pub(crate) fn validate_index(index: u16) -> NativeResult<()> {
    if !(1..=MAX_PROMPTS as u16).contains(&index) {
        return Err(NativeError::new(
            "image_index_invalid",
            "Image indices must be between 1 and 500.",
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
    let images = projected
        .get("images")
        .and_then(Value::as_array)
        .ok_or_else(worker_response_invalid)?
        .iter()
        .map(project_image)
        .collect::<NativeResult<Vec<_>>>()?;
    projected.insert("images".into(), Value::Array(images));
    Ok(Value::Object(projected))
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

async fn read_bounded(response: reqwest::Response, limit: usize) -> NativeResult<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(NativeError::new(
            "worker_response_too_large",
            "The worker returned an unexpectedly large response.",
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| {
            NativeError::retryable(
                "worker_network_error",
                "The worker response was interrupted.",
            )
        })?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(NativeError::new(
                "worker_response_too_large",
                "The worker returned an unexpectedly large response.",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_validation_is_bounded_without_logging_prompt_content() {
        assert!(validate_create_batch(&CreateBatchInput {
            prompts: vec!["A realistic editorial photograph".into()],
            base_seed: 42,
        })
        .is_ok());
        let sensitive_prompt = format!("DO-NOT-ECHO-THIS-{}", "x".repeat(MAX_PROMPT_BYTES));
        for prompts in [vec![], vec![" ".into()], vec![sensitive_prompt.clone()]] {
            let error = validate_create_batch(&CreateBatchInput {
                prompts,
                base_seed: 0,
            })
            .unwrap_err();
            assert_eq!(error.code, "batch_invalid");
            assert!(!error.message.contains("DO-NOT-ECHO-THIS"));
        }
    }

    #[test]
    fn checksum_and_index_contracts_are_exact() {
        assert!(validate_index(1).is_ok());
        assert!(validate_index(500).is_ok());
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
}
