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
        Entry::new(SERVICE, kind.account()).map_err(|_| vault_unavailable())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VaultOperation {
    Write,
    ReadStatus,
    Load,
}

impl VaultOperation {
    fn code(self) -> &'static str {
        match self {
            Self::Write => "credential_write_failed",
            Self::ReadStatus | Self::Load => "credential_read_failed",
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::Write => "The credential could not be saved to the operating-system vault.",
            Self::ReadStatus => {
                "Credential status could not be read from the operating-system vault."
            }
            Self::Load => "The required credential could not be loaded from secure storage.",
        }
    }
}

/// The vault reports "could not open the store at all" and "could not complete
/// this one item" through the same call. They need different repairs, so they
/// need different codes: an unreachable vault is usually a login session
/// without the user's keychain (a launcher that overrides `HOME`, a locked or
/// missing default keychain), which no amount of retyping the credential fixes.
/// The platform error itself is never forwarded — see `NativeError`.
fn vault_error(operation: VaultOperation, error: KeyringError) -> NativeError {
    match error {
        KeyringError::PlatformFailure(_) | KeyringError::NoStorageAccess(_) => vault_unavailable(),
        _ => NativeError::new(operation.code(), operation.message()),
    }
}

fn vault_unavailable() -> NativeError {
    NativeError::new(
        "credential_vault_unavailable",
        "ImageForge could not open the operating-system credential vault for this login session. \
         Reopen ImageForge the normal way from Applications, then try again.",
    )
}

impl CredentialVault for KeyringVault {
    fn replace(&self, kind: CredentialKind, value: &str) -> NativeResult<CredentialMetadata> {
        validate_secret(value)?;
        validate_kind_specific(kind, value)?;
        Self::entry(kind)?
            .set_password(value)
            .map_err(|error| vault_error(VaultOperation::Write, error))?;
        Ok(metadata_for(kind, Some(value)))
    }

    fn metadata(&self, kind: CredentialKind) -> NativeResult<CredentialMetadata> {
        match Self::entry(kind)?.get_password() {
            Ok(secret) => Ok(metadata_for(kind, Some(&secret))),
            Err(KeyringError::NoEntry) => Ok(metadata_for(kind, None)),
            Err(error) => Err(vault_error(VaultOperation::ReadStatus, error)),
        }
    }

    fn load(&self, kind: CredentialKind) -> NativeResult<String> {
        let secret = Self::entry(kind)?
            .get_password()
            .map_err(|error| match error {
                KeyringError::NoEntry => NativeError::new(
                    "credential_unavailable",
                    "The required credential is not configured.",
                ),
                other => vault_error(VaultOperation::Load, other),
            })?;
        validate_secret(&secret)?;
        validate_kind_specific(kind, &secret)?;
        Ok(secret)
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
    fn an_unreachable_vault_is_reported_apart_from_a_rejected_credential() {
        // errSecNoDefaultKeychain and a locked store arrive as these two
        // variants. They mean the vault could not be opened at all, which is a
        // different repair from a credential the vault refused.
        for unreachable in [
            KeyringError::PlatformFailure(Box::new(std::io::Error::other("-25307"))),
            KeyringError::NoStorageAccess(Box::new(std::io::Error::other("locked"))),
        ] {
            let error = vault_error(VaultOperation::Write, unreachable);
            assert_eq!(error.code, "credential_vault_unavailable");
            assert!(!error.message.contains("25307"));
            assert!(!error.message.contains("locked"));
        }

        assert_eq!(
            vault_error(VaultOperation::Write, KeyringError::TooLong("service".into(), 8)).code,
            "credential_write_failed",
        );
        assert_eq!(
            vault_error(VaultOperation::ReadStatus, KeyringError::TooLong("service".into(), 8)).code,
            "credential_read_failed",
        );
        assert_eq!(
            vault_error(VaultOperation::Load, KeyringError::TooLong("service".into(), 8)).code,
            "credential_read_failed",
        );
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
