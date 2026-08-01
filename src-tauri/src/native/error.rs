use serde::Serialize;
use std::fmt::{Display, Formatter};

pub type NativeResult<T> = Result<T, NativeError>;

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
        Self {
            code,
            message: message.into(),
            retryable: false,
        }
    }

    pub fn retryable(code: &'static str, message: impl Into<String>) -> Self {
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
