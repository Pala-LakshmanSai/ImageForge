use super::{NativeError, NativeResult};
use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::{Arc, Mutex};

const SERVICE: &str = "com.imageforge.desktop";
const MIN_SECRET_LENGTH: usize = 8;
const MAX_SECRET_LENGTH: usize = 4096;
const MIN_WORKER_TOKEN_LENGTH: usize = 16;
const MAX_WORKER_TOKEN_LENGTH: usize = 512;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum CredentialKind {
    RunpodApiKey,
    WorkerToken,
}

impl CredentialKind {
    fn account(self) -> &'static str {
        match self {
            Self::RunpodApiKey => "runpod-api-key",
            Self::WorkerToken => "worker-bearer-token",
        }
    }

    pub fn as_renderer_key(self) -> &'static str {
        match self {
            Self::RunpodApiKey => "runpodApiKey",
            Self::WorkerToken => "workerToken",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialMetadata {
    pub kind: &'static str,
    pub configured: bool,
    pub suffix: Option<String>,
    pub provider: &'static str,
}

pub trait CredentialVault: Send + Sync + 'static {
    fn replace(&self, kind: CredentialKind, value: &str) -> NativeResult<CredentialMetadata>;
    fn metadata(&self, kind: CredentialKind) -> NativeResult<CredentialMetadata>;
    fn load(&self, kind: CredentialKind) -> NativeResult<String>;
}

#[derive(Debug, Default)]
pub struct KeyringVault;

impl KeyringVault {
    fn entry(kind: CredentialKind) -> NativeResult<Entry> {
        Entry::new(SERVICE, kind.account()).map_err(|_| {
            NativeError::new(
                "credential_vault_unavailable",
                "The operating-system credential vault is unavailable.",
            )
        })
    }
}

impl CredentialVault for KeyringVault {
    fn replace(&self, kind: CredentialKind, value: &str) -> NativeResult<CredentialMetadata> {
        validate_secret(value)?;
        validate_kind_specific(kind, value)?;
        Self::entry(kind)?.set_password(value).map_err(|_| {
            NativeError::new(
                "credential_write_failed",
                "The credential could not be saved to the operating-system vault.",
            )
        })?;
        Ok(metadata_for(kind, Some(value)))
    }

    fn metadata(&self, kind: CredentialKind) -> NativeResult<CredentialMetadata> {
        match Self::entry(kind)?.get_password() {
            Ok(secret) => Ok(metadata_for(kind, Some(&secret))),
            Err(KeyringError::NoEntry) => Ok(metadata_for(kind, None)),
            Err(_) => Err(NativeError::new(
                "credential_read_failed",
                "Credential status could not be read from the operating-system vault.",
            )),
        }
    }

    fn load(&self, kind: CredentialKind) -> NativeResult<String> {
        Self::entry(kind)?
            .get_password()
            .map_err(|error| match error {
                KeyringError::NoEntry => NativeError::new(
                    "credential_unavailable",
                    "The required credential is not configured.",
                ),
                _ => NativeError::new(
                    "credential_read_failed",
                    "The required credential could not be loaded from secure storage.",
                ),
            })
    }
}

fn validate_secret(value: &str) -> NativeResult<()> {
    if value.trim() != value || value.len() < MIN_SECRET_LENGTH || value.len() > MAX_SECRET_LENGTH {
        return Err(NativeError::new(
            "credential_invalid",
            "Credentials must be 8–4096 characters and cannot start or end with whitespace.",
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(NativeError::new(
            "credential_invalid",
            "Credentials cannot contain control characters.",
        ));
    }
    Ok(())
}

fn validate_kind_specific(kind: CredentialKind, value: &str) -> NativeResult<()> {
    if kind == CredentialKind::WorkerToken
        && (!(MIN_WORKER_TOKEN_LENGTH..=MAX_WORKER_TOKEN_LENGTH).contains(&value.len())
            || !value.is_ascii()
            || !value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'+' | b'/' | b'=')
            }))
    {
        return Err(NativeError::new(
            "credential_invalid",
            "Worker tokens must be 16–512 ASCII bearer-token characters.",
        ));
    }
    Ok(())
}

fn provider_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macOS Keychain"
    } else if cfg!(target_os = "windows") {
        "Windows Credential Manager"
    } else {
        "OS credential vault"
    }
}

fn metadata_for(kind: CredentialKind, secret: Option<&str>) -> CredentialMetadata {
    CredentialMetadata {
        kind: kind.as_renderer_key(),
        configured: secret.is_some(),
        suffix: secret.map(|value| {
            let mut characters = value.chars().rev().take(4).collect::<Vec<_>>();
            characters.reverse();
            characters.into_iter().collect()
        }),
        provider: provider_name(),
    }
}

#[cfg(test)]
#[derive(Clone, Default)]
pub struct MemoryVault {
    values: Arc<Mutex<HashMap<CredentialKind, String>>>,
}

#[cfg(test)]
impl CredentialVault for MemoryVault {
    fn replace(&self, kind: CredentialKind, value: &str) -> NativeResult<CredentialMetadata> {
        validate_secret(value)?;
        validate_kind_specific(kind, value)?;
        self.values
            .lock()
            .map_err(|_| {
                NativeError::new("credential_vault_unavailable", "Credential vault failed.")
            })?
            .insert(kind, value.to_owned());
        Ok(metadata_for(kind, Some(value)))
    }

    fn metadata(&self, kind: CredentialKind) -> NativeResult<CredentialMetadata> {
        let values = self.values.lock().map_err(|_| {
            NativeError::new("credential_vault_unavailable", "Credential vault failed.")
        })?;
        Ok(metadata_for(kind, values.get(&kind).map(String::as_str)))
    }

    fn load(&self, kind: CredentialKind) -> NativeResult<String> {
        self.values
            .lock()
            .map_err(|_| {
                NativeError::new("credential_vault_unavailable", "Credential vault failed.")
            })?
            .get(&kind)
            .cloned()
            .ok_or_else(|| {
                NativeError::new(
                    "credential_unavailable",
                    "The required credential is not configured.",
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_is_redacted_and_secret_never_appears_in_serialized_output() {
        let vault = MemoryVault::default();
        let secret = "rp_live_example_7K2M";
        let metadata = vault.replace(CredentialKind::RunpodApiKey, secret).unwrap();
        assert_eq!(metadata.suffix.as_deref(), Some("7K2M"));
        let serialized = serde_json::to_string(&metadata).unwrap();
        assert!(!serialized.contains(secret));
        assert!(!serialized.contains("rp_live_example"));
        assert_eq!(vault.load(CredentialKind::RunpodApiKey).unwrap(), secret);
    }

    #[test]
    fn secret_validation_rejects_ambiguous_values() {
        let vault = MemoryVault::default();
        for value in [
            "short",
            " leading-secret",
            "trailing-secret ",
            "line\nbreak",
        ] {
            let error = vault
                .replace(CredentialKind::WorkerToken, value)
                .unwrap_err();
            assert_eq!(error.code, "credential_invalid");
            assert!(!error.message.contains(value));
        }
    }

    #[test]
    fn worker_token_validation_matches_worker_runtime_limits() {
        let vault = MemoryVault::default();
        for value in ["a".repeat(15), "a".repeat(513)] {
            let error = vault
                .replace(CredentialKind::WorkerToken, &value)
                .unwrap_err();
            assert_eq!(error.code, "credential_invalid");
        }
        assert!(vault
            .replace(CredentialKind::WorkerToken, &"a".repeat(16))
            .is_ok());
        assert!(vault
            .replace(CredentialKind::RunpodApiKey, "shortkey")
            .is_ok());
    }
}
