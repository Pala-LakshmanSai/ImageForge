use crate::native::{NativeError, NativeResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use url::Url;
use uuid::Uuid;

const MAX_FIXTURE_RESPONSE_BYTES: usize = 1_048_576;
const FIXTURE_TIMEOUT_SECONDS: u64 = 30;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SmokeAvailability {
    Foreground,
    Background,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SmokeDecision {
    Approve,
    Deny,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SmokeCheckpoint {
    LifecycleLoading,
    LifecycleWarming,
    Startup,
    VetoDone,
    ReleaseInitialBatch,
    IdleAfterRelease,
    ApprovalRequestA,
    ApprovalResponseB,
    ApprovalDeleteA,
    OfflineAToB,
    ResetSecondPod,
    ReadySecondPod,
    DenialRequestB,
    DenialResponseA,
    ClearDenial,
    TimeoutRequestA,
    ExpireTimeout,
    ClearTimeout,
    GenerationRequestA,
    GenerationStartedB,
    ReleaseGeneratedBatch,
    ReverseRequestB,
    ReverseResponseA,
    ReverseDeleteB,
    OfflineBToA,
    Final,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum NativeTwoClientSmokeInput {
    RunpodList {},
    RunpodGet {
        pod_id: String,
    },
    RunpodDelete {
        pod_id: String,
    },
    WorkerHealth {},
    WorkerStatus {},
    StudioHeartbeat {
        session_id: String,
        availability: SmokeAvailability,
    },
    StudioStatus {
        session_id: String,
    },
    StudioCreateStop {
        request_id: String,
        session_id: String,
        pod_id: String,
        gpu_display_name: String,
    },
    StudioRespond {
        request_id: String,
        session_id: String,
        decision: SmokeDecision,
    },
    StudioFinalize {
        request_id: String,
        session_id: String,
        pod_id: String,
        finalization_id: String,
    },
    StudioCancel {
        request_id: String,
        session_id: String,
        pod_id: String,
        finalization_id: Option<String>,
    },
    BatchCreate {
        prompt_count: u32,
        base_seed: u64,
    },
    BatchGet {
        batch_id: String,
    },
    ArtifactDownload {
        batch_id: String,
        index: u32,
        expected_sha256: String,
        expected_size_bytes: u64,
        expected_width: u32,
        expected_height: u32,
    },
    Checkpoint {
        name: SmokeCheckpoint,
    },
    Audit {},
}

impl NativeTwoClientSmokeInput {
    fn validate(&self) -> NativeResult<()> {
        match self {
            Self::RunpodGet { pod_id } | Self::RunpodDelete { pod_id } => safe_text(
                pod_id,
                128,
                "native_smoke_pod_invalid",
                "The native smoke Pod ID is invalid.",
            ),
            Self::StudioHeartbeat { session_id, .. } | Self::StudioStatus { session_id } => {
                smoke_uuid(session_id)
            }
            Self::StudioCreateStop {
                request_id,
                session_id,
                pod_id,
                gpu_display_name,
            } => {
                smoke_uuid(request_id)?;
                smoke_uuid(session_id)?;
                safe_text(
                    pod_id,
                    128,
                    "native_smoke_pod_invalid",
                    "The native smoke Pod ID is invalid.",
                )?;
                safe_text(
                    gpu_display_name,
                    120,
                    "native_smoke_gpu_invalid",
                    "The native smoke GPU label is invalid.",
                )
            }
            Self::StudioRespond {
                request_id,
                session_id,
                ..
            } => {
                smoke_uuid(request_id)?;
                smoke_uuid(session_id)
            }
            Self::StudioFinalize {
                request_id,
                session_id,
                pod_id,
                finalization_id,
            } => {
                smoke_uuid(request_id)?;
                smoke_uuid(session_id)?;
                smoke_uuid(finalization_id)?;
                safe_text(
                    pod_id,
                    128,
                    "native_smoke_pod_invalid",
                    "The native smoke Pod ID is invalid.",
                )
            }
            Self::StudioCancel {
                request_id,
                session_id,
                pod_id,
                finalization_id,
            } => {
                smoke_uuid(request_id)?;
                smoke_uuid(session_id)?;
                if let Some(value) = finalization_id {
                    smoke_uuid(value)?;
                }
                safe_text(
                    pod_id,
                    128,
                    "native_smoke_pod_invalid",
                    "The native smoke Pod ID is invalid.",
                )
            }
            Self::BatchCreate {
                prompt_count,
                base_seed,
            } => {
                if *prompt_count == 0 || *prompt_count > 450 || *base_seed > i64::MAX as u64 {
                    return Err(NativeError::new(
                        "native_smoke_batch_invalid",
                        "The native smoke batch request is invalid.",
                    ));
                }
                Ok(())
            }
            Self::BatchGet { batch_id } => smoke_uuid(batch_id),
            Self::ArtifactDownload {
                batch_id,
                index,
                expected_sha256,
                expected_size_bytes,
                expected_width,
                expected_height,
            } => {
                smoke_uuid(batch_id)?;
                if *index == 0
                    || *index > 450
                    || expected_sha256.len() != 64
                    || !expected_sha256
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    || *expected_size_bytes == 0
                    || *expected_size_bytes > 64 * 1024 * 1024
                    || *expected_width < 64
                    || *expected_width > 4096
                    || *expected_height < 64
                    || *expected_height > 4096
                {
                    return Err(NativeError::new(
                        "native_smoke_artifact_invalid",
                        "The native smoke artifact request is invalid.",
                    ));
                }
                Ok(())
            }
            Self::RunpodList {}
            | Self::WorkerHealth {}
            | Self::WorkerStatus {}
            | Self::Checkpoint { .. }
            | Self::Audit {} => Ok(()),
        }
    }
}

fn smoke_uuid(value: &str) -> NativeResult<()> {
    let parsed = Uuid::parse_str(value).map_err(|_| {
        NativeError::new(
            "native_smoke_uuid_invalid",
            "A native smoke identifier is invalid.",
        )
    })?;
    if parsed.get_version_num() != 4 || parsed.to_string() != value.to_ascii_lowercase() {
        return Err(NativeError::new(
            "native_smoke_uuid_invalid",
            "A native smoke identifier is invalid.",
        ));
    }
    Ok(())
}

fn safe_text(
    value: &str,
    maximum: usize,
    code: &'static str,
    message: &'static str,
) -> NativeResult<()> {
    if value.is_empty()
        || value.len() > maximum
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(NativeError::new(code, message));
    }
    Ok(())
}

fn fixture_origin(raw: &str) -> NativeResult<Url> {
    let parsed = Url::parse(raw).map_err(|_| {
        NativeError::new(
            "native_smoke_fixture_invalid",
            "The native smoke fixture origin is invalid.",
        )
    })?;
    if parsed.scheme() != "http"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.port().is_none()
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(NativeError::new(
            "native_smoke_fixture_invalid",
            "The native smoke fixture must be a loopback HTTP origin.",
        ));
    }
    Ok(parsed)
}

fn fixture_configuration() -> NativeResult<(Url, String, &'static str)> {
    if std::env::var("IMAGEFORGE_NATIVE_SMOKE").ok().as_deref() != Some("two-client") {
        return Err(NativeError::new(
            "native_smoke_disabled",
            "Two-client native smoke transport is disabled.",
        ));
    }
    let origin = fixture_origin(&std::env::var("IMAGEFORGE_NATIVE_SMOKE_FIXTURE").map_err(
        |_| {
            NativeError::new(
                "native_smoke_unconfigured",
                "The native smoke fixture is not configured.",
            )
        },
    )?)?;
    let key = std::env::var("IMAGEFORGE_NATIVE_SMOKE_KEY").map_err(|_| {
        NativeError::new(
            "native_smoke_unconfigured",
            "The native smoke fixture key is not configured.",
        )
    })?;
    if key.len() < 32
        || key.len() > 128
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(NativeError::new(
            "native_smoke_unconfigured",
            "The native smoke fixture key is invalid.",
        ));
    }
    let role = match std::env::var("IMAGEFORGE_NATIVE_SMOKE_ROLE")
        .ok()
        .as_deref()
    {
        Some("A") => "A",
        Some("B") => "B",
        _ => {
            return Err(NativeError::new(
                "native_smoke_unconfigured",
                "The native smoke role is invalid.",
            ))
        }
    };
    Ok((origin, key, role))
}

pub async fn exchange(input: NativeTwoClientSmokeInput) -> NativeResult<Value> {
    input.validate()?;
    let (origin, key, role) = fixture_configuration()?;
    let endpoint = origin.join("exchange").map_err(|_| {
        NativeError::new(
            "native_smoke_fixture_invalid",
            "The native smoke fixture endpoint is invalid.",
        )
    })?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FIXTURE_TIMEOUT_SECONDS))
        .build()
        .map_err(|_| {
            NativeError::new(
                "native_smoke_transport_failed",
                "The native smoke transport could not be initialized.",
            )
        })?;
    let response = client
        .post(endpoint)
        .json(&json!({ "role": role, "key": key, "input": input }))
        .send()
        .await
        .map_err(|_| {
            NativeError::new(
                "native_smoke_transport_failed",
                "The native smoke fixture did not respond.",
            )
        })?;
    if !response.status().is_success() {
        return Err(NativeError::new(
            "native_smoke_fixture_failed",
            "The native smoke fixture rejected an operation.",
        ));
    }
    let bytes = response.bytes().await.map_err(|_| {
        NativeError::new(
            "native_smoke_transport_failed",
            "The native smoke fixture response could not be read.",
        )
    })?;
    if bytes.len() > MAX_FIXTURE_RESPONSE_BYTES {
        return Err(NativeError::new(
            "native_smoke_fixture_invalid",
            "The native smoke fixture response was too large.",
        ));
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        NativeError::new(
            "native_smoke_fixture_invalid",
            "The native smoke fixture returned invalid JSON.",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_origin_is_strictly_loopback() {
        assert!(fixture_origin("http://127.0.0.1:43123/").is_ok());
        assert!(fixture_origin("https://127.0.0.1:43123/").is_err());
        assert!(fixture_origin("http://localhost:43123/").is_err());
        assert!(fixture_origin("http://127.0.0.1:43123/path").is_err());
        assert!(fixture_origin("http://127.0.0.1/").is_err());
    }

    #[test]
    fn tagged_operations_reject_unknown_fields_and_names() {
        assert!(serde_json::from_value::<NativeTwoClientSmokeInput>(json!({
            "operation": "runpod_list"
        }))
        .is_ok());
        assert!(serde_json::from_value::<NativeTwoClientSmokeInput>(json!({
            "operation": "runpod_list",
            "url": "https://example.com"
        }))
        .is_err());
        assert!(serde_json::from_value::<NativeTwoClientSmokeInput>(json!({
            "operation": "generic_proxy"
        }))
        .is_err());
    }

    #[test]
    fn identifiers_and_batch_bounds_are_validated() {
        assert!(NativeTwoClientSmokeInput::StudioStatus {
            session_id: "44444444-4444-4444-8444-444444444444".into(),
        }
        .validate()
        .is_ok());
        assert!(NativeTwoClientSmokeInput::StudioStatus {
            session_id: "not-a-uuid".into(),
        }
        .validate()
        .is_err());
        assert!(NativeTwoClientSmokeInput::BatchCreate {
            prompt_count: 451,
            base_seed: 1,
        }
        .validate()
        .is_err());
        assert!(NativeTwoClientSmokeInput::ArtifactDownload {
            batch_id: "11111111-1111-4111-8111-111111111111".into(),
            index: 1,
            expected_sha256: "a".repeat(64),
            expected_size_bytes: 4097,
            expected_width: 1280,
            expected_height: 720,
        }
        .validate()
        .is_ok());
        assert!(NativeTwoClientSmokeInput::ArtifactDownload {
            batch_id: "11111111-1111-4111-8111-111111111111".into(),
            index: 0,
            expected_sha256: "A".repeat(64),
            expected_size_bytes: 0,
            expected_width: 1,
            expected_height: 1,
        }
        .validate()
        .is_err());
    }
}
