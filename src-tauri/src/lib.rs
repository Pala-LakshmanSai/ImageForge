use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppEnvironment {
    platform: &'static str,
    release_channel: &'static str,
    native_core: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RedactedCredentialStatus {
    kind: &'static str,
    configured: bool,
    suffix: Option<&'static str>,
    provider: &'static str,
}

/// Returns non-sensitive desktop metadata. This deliberately exposes no generic
/// shell, filesystem, HTTP, or environment-variable access to the webview.
#[tauri::command]
fn app_environment() -> AppEnvironment {
    AppEnvironment {
        platform: std::env::consts::OS,
        release_channel: "desktop-shell-simulation",
        native_core: true,
    }
}

/// Placeholder credential health for the Task 001 shell. Real vault writes are
/// intentionally deferred; React receives configured/redacted metadata only.
#[tauri::command]
fn redacted_credential_status() -> Vec<RedactedCredentialStatus> {
    let provider = if cfg!(target_os = "macos") {
        "macOS Keychain"
    } else if cfg!(target_os = "windows") {
        "Windows Credential Manager"
    } else {
        "Unsupported development host"
    };

    vec![
        RedactedCredentialStatus {
            kind: "runpodApiKey",
            configured: false,
            suffix: None,
            provider,
        },
        RedactedCredentialStatus {
            kind: "workerToken",
            configured: false,
            suffix: None,
            provider,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            app_environment,
            redacted_credential_status
        ])
        .run(tauri::generate_context!())
        .expect("ImageForge native host failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_metadata_never_contains_a_secret() {
        for status in redacted_credential_status() {
            assert!(!status.configured);
            assert!(status.suffix.is_none());
        }
    }
}
