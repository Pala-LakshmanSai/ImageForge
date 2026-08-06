use serde::Serialize;
use std::fmt::{Display, Formatter};
use std::sync::OnceLock;

pub type NativeResult<T> = Result<T, NativeError>;

/// Opt-in developer diagnostics, enabled with `IMAGEFORGE_DIAGNOSTICS=1`.
///
/// The renderer-facing error surface is deliberately coarse: several distinct
/// native failures are collapsed into one code so a provider response can never
/// be reconstructed from what crosses IPC. That is correct for the product and
/// hostile to debugging, because a failure reports only where it was caught and
/// not where it was raised. Diagnosing one such failure previously meant
/// rebuilding the app repeatedly just to learn which check rejected a row.
///
/// This records the code and the ImageForge frames that raised it, and nothing
/// else. Messages are fixed native strings; provider bodies, URLs, Pod fields,
/// and credentials are never touched here.
fn diagnostics_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var_os("IMAGEFORGE_DIAGNOSTICS")
            .is_some_and(|value| value == "1" || value == "true")
    })
}

/// Record a named check that rejected a value, for the same opt-in channel.
/// Callers pass only fixed check names, never provider values.
pub fn trace_rejected_checks(subject: &str, failed: &[impl AsRef<str>]) {
    if !diagnostics_enabled() {
        return;
    }
    let names = failed
        .iter()
        .map(AsRef::as_ref)
        .collect::<Vec<_>>()
        .join(",");
    eprintln!("imageforge.reject subject={subject} failed=[{names}]");
}

fn trace_construction(code: &'static str, retryable: bool) {
    if !diagnostics_enabled() {
        return;
    }
    let raised_at = std::backtrace::Backtrace::force_capture()
        .to_string()
        .lines()
        .filter(|line| line.contains("imageforge_lib") && !line.contains("native::error"))
        .take(3)
        .map(str::trim)
        .collect::<Vec<_>>()
        .join(" <- ");
    eprintln!("imageforge.error code={code} retryable={retryable} raised_at={raised_at}");
}

/// A deliberately small, serializable error surface. Underlying I/O, HTTP,
/// keychain, and parsing errors are never serialized because they may contain
/// credentials, response bodies, local paths, or authorization headers.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl NativeError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        trace_construction(code, false);
        Self {
            code,
            message: message.into(),
            retryable: false,
        }
    }

    pub fn retryable(code: &'static str, message: impl Into<String>) -> Self {
        trace_construction(code, true);
        Self {
            code,
            message: message.into(),
            retryable: true,
        }
    }
}

impl Display for NativeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for NativeError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_are_opt_in_and_never_alter_the_error_surface() {
        // The default build must not enable tracing, and the trace must never
        // be able to change what a caller or the renderer observes.
        assert!(!diagnostics_enabled());

        let error = NativeError::new("gpu_start_inventory_stale", "Live GPU inventory expired.");
        assert_eq!(error.code, "gpu_start_inventory_stale");
        assert_eq!(error.message, "Live GPU inventory expired.");
        assert!(!error.retryable);

        let retryable = NativeError::retryable("gpu_pod_observation_unavailable", "Unavailable.");
        assert!(retryable.retryable);
        assert_eq!(retryable.code, "gpu_pod_observation_unavailable");

        // Serialization stays the exact three-field renderer contract, so a
        // diagnostic can never widen what crosses IPC.
        let json = serde_json::to_value(&error).unwrap();
        let object = json.as_object().unwrap();
        assert_eq!(object.len(), 3);
        assert!(object.contains_key("code"));
        assert!(object.contains_key("message"));
        assert!(object.contains_key("retryable"));
    }
}
