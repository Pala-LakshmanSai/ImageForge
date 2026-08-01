use super::{NativeError, NativeResult};
use serde::Serialize;
use std::sync::{Arc, RwLock};
use url::Url;

const WORKER_PORT: u16 = 8000;
const PROXY_SUFFIX: &str = ".proxy.runpod.net";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkerSessionMetadata {
    pub configured: bool,
    pub pod_id: Option<String>,
    pub origin: Option<String>,
}

#[derive(Clone, Default)]
pub struct WorkerSession {
    pod_id: Arc<RwLock<Option<String>>>,
}

impl WorkerSession {
    pub fn bind(&self, pod_id: &str) -> NativeResult<WorkerSessionMetadata> {
        validate_pod_id(pod_id)?;
        let mut guard = self.pod_id.write().map_err(|_| {
            NativeError::new(
                "worker_session_unavailable",
                "Worker session state is unavailable.",
            )
        })?;
        *guard = Some(pod_id.to_owned());
        drop(guard);
        self.metadata()
    }

    pub fn clear(&self) -> NativeResult<()> {
        let mut guard = self.pod_id.write().map_err(|_| {
            NativeError::new(
                "worker_session_unavailable",
                "Worker session state is unavailable.",
            )
        })?;
        *guard = None;
        Ok(())
    }

    pub fn metadata(&self) -> NativeResult<WorkerSessionMetadata> {
        let pod_id = self
            .pod_id
            .read()
            .map_err(|_| {
                NativeError::new(
                    "worker_session_unavailable",
                    "Worker session state is unavailable.",
                )
            })?
            .clone();
        let origin = pod_id.as_deref().map(worker_origin);
        Ok(WorkerSessionMetadata {
            configured: pod_id.is_some(),
            pod_id,
            origin,
        })
    }

    pub fn current_pod_id(&self) -> NativeResult<String> {
        self.pod_id
            .read()
            .map_err(|_| {
                NativeError::new(
                    "worker_session_unavailable",
                    "Worker session state is unavailable.",
                )
            })?
            .clone()
            .ok_or_else(|| {
                NativeError::new(
                    "worker_session_unconfigured",
                    "No verified ImageForge worker is connected.",
                )
            })
    }

    pub fn endpoint(&self, path: &str) -> NativeResult<Url> {
        validate_worker_path(path)?;
        let pod_id = self.current_pod_id()?;
        Url::parse(&format!("{}{path}", worker_origin(&pod_id))).map_err(|_| {
            NativeError::new(
                "worker_session_invalid",
                "The verified worker endpoint could not be constructed.",
            )
        })
    }

    pub fn assert_url_is_current(&self, url: &Url) -> NativeResult<()> {
        let expected = self.endpoint("/v1/health")?;
        if url.scheme() != "https"
            || url.username() != ""
            || url.password().is_some()
            || url.port().is_some()
            || url.host_str() != expected.host_str()
        {
            return Err(NativeError::new(
                "worker_host_rejected",
                "Worker requests are restricted to the current verified RunPod proxy.",
            ));
        }
        Ok(())
    }
}

fn worker_origin(pod_id: &str) -> String {
    format!("https://{pod_id}-{WORKER_PORT}{PROXY_SUFFIX}")
}

pub(super) fn validate_pod_id(pod_id: &str) -> NativeResult<()> {
    if pod_id.len() < 3
        || pod_id.len() > 64
        || !pod_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        || pod_id.starts_with('-')
        || pod_id.ends_with('-')
    {
        return Err(NativeError::new(
            "pod_id_invalid",
            "RunPod returned an invalid Pod identifier.",
        ));
    }
    Ok(())
}

fn validate_worker_path(path: &str) -> NativeResult<()> {
    if !path.starts_with("/v1/")
        || path.contains("..")
        || path.contains('?')
        || path.contains('#')
        || path.contains("//")
    {
        return Err(NativeError::new(
            "worker_path_rejected",
            "The requested worker operation is not allowed.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_derives_one_exact_https_proxy_origin() {
        let session = WorkerSession::default();
        let metadata = session.bind("abc123xy").unwrap();
        assert_eq!(
            metadata.origin.as_deref(),
            Some("https://abc123xy-8000.proxy.runpod.net")
        );
        assert_eq!(
            session.endpoint("/v1/status").unwrap().as_str(),
            "https://abc123xy-8000.proxy.runpod.net/v1/status"
        );
    }

    #[test]
    fn session_rejects_host_and_path_injection() {
        let session = WorkerSession::default();
        for pod in [
            "ab",
            "-abc",
            "abc-",
            "abc.example.com",
            "abc/def",
            "abc_123",
        ] {
            assert_eq!(session.bind(pod).unwrap_err().code, "pod_id_invalid");
        }
        session.bind("safe-pod-1").unwrap();
        for path in [
            "/health",
            "/v1/../secret",
            "/v1/status?token=x",
            "//v1/status",
        ] {
            assert_eq!(
                session.endpoint(path).unwrap_err().code,
                "worker_path_rejected"
            );
        }
        let hostile =
            Url::parse("https://safe-pod-1-8000.proxy.runpod.net.evil.example/v1/health").unwrap();
        assert_eq!(
            session.assert_url_is_current(&hostile).unwrap_err().code,
            "worker_host_rejected"
        );
    }
}
