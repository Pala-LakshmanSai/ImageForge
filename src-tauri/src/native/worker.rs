use super::{CredentialKind, CredentialVault, NativeError, NativeResult, WorkerSession};
use futures_util::StreamExt;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

const MAX_JSON_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
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

#[derive(Clone)]
pub struct WorkerApi {
    client: Client,
    vault: Arc<dyn CredentialVault>,
    session: WorkerSession,
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
        self.request_json(Method::GET, "/v1/health", None, false)
            .await
    }

    pub async fn status(&self) -> NativeResult<WorkerHttpResponse> {
        self.request_json(Method::GET, "/v1/status", None, true)
            .await
    }

    pub async fn create_batch(&self, input: CreateBatchInput) -> NativeResult<WorkerHttpResponse> {
        validate_create_batch(&input)?;
        self.request_json(
            Method::POST,
            "/v1/batches",
            Some(json!({"prompts": input.prompts, "base_seed": input.base_seed})),
            true,
        )
        .await
    }

    pub async fn get_batch(&self, batch_id: Uuid) -> NativeResult<WorkerHttpResponse> {
        self.request_json(Method::GET, &format!("/v1/batches/{batch_id}"), None, true)
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

    pub async fn acknowledge(
        &self,
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
        self.request_json(
            Method::POST,
            &format!("/v1/batches/{batch_id}/receipts"),
            Some(json!({
                "receipts": [{"index": index, "sha256": sha256, "size_bytes": size_bytes}]
            })),
            true,
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
        )
        .await
    }

    async fn request_json(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        authenticated: bool,
    ) -> NativeResult<WorkerHttpResponse> {
        let url = self.session.endpoint(path)?;
        self.session.assert_url_is_current(&url)?;
        let mut builder = self
            .client
            .request(method, url)
            .header(ACCEPT, "application/json");
        if authenticated {
            let credential = self.worker_token()?;
            builder = builder.header(AUTHORIZATION, format!("Bearer {credential}"));
            drop(credential);
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
        validate_worker_envelope(status, &body)?;
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
            || prompt.as_bytes().len() > MAX_PROMPT_BYTES
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
}
