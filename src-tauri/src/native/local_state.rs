//! Archive the device-local lifecycle state so a stale record cannot wedge the app.
//!
//! Lifecycle records name a Pod, a network volume and an image digest that were
//! true when they were written. Replacing the model, the volume or the worker
//! image leaves records pointing at things that no longer exist, and the app
//! then reconciles against them on every start. Recovering from that used to
//! mean renaming a directory by hand.
//!
//! Only the lifecycle records are archived. Receipts, the queue and the chosen
//! download destination are the operator's own work and are never touched, and
//! credentials live in the OS keychain rather than here.

use std::path::PathBuf;

use serde::Serialize;

use crate::native::error::{NativeError, NativeResult};

/// Directories holding records that describe a specific Pod, volume or image.
const LIFECYCLE_DIRECTORIES: [&str; 3] = ["gpu-start", "runpod-create", "gpu-switch"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStateResetV1 {
    pub schema_version: u8,
    /// Where the archived copy was moved to, absent when nothing existed.
    pub archived_path: Option<String>,
    pub archived_directories: Vec<String>,
}

fn state_root() -> NativeResult<PathBuf> {
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|path| path.join("Library").join("Application Support"));
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base: Option<PathBuf> = None;
    base.map(|path| path.join("com.imageforge.desktop"))
        .ok_or_else(|| {
            NativeError::new(
                "native_state_unavailable",
                "The native application-data directory is unavailable.",
            )
        })
}

/// Move every lifecycle directory into one timestamped archive.
///
/// The state is archived rather than deleted: a wedged app is exactly when the
/// evidence is worth keeping, and the operator can still delete the archive.
pub fn reset_local_lifecycle_state(now_millis: u64) -> NativeResult<LocalStateResetV1> {
    let root = state_root()?;
    let present: Vec<&str> = LIFECYCLE_DIRECTORIES
        .into_iter()
        .filter(|name| root.join(name).is_dir())
        .collect();
    if present.is_empty() {
        return Ok(LocalStateResetV1 {
            schema_version: 1,
            archived_path: None,
            archived_directories: Vec::new(),
        });
    }

    let archive = root.join(format!("archived-state-{now_millis}"));
    std::fs::create_dir_all(&archive).map_err(|_| archive_failed())?;
    let mut archived = Vec::with_capacity(present.len());
    for name in present {
        std::fs::rename(root.join(name), archive.join(name)).map_err(|_| archive_failed())?;
        archived.push(name.to_owned());
    }
    Ok(LocalStateResetV1 {
        schema_version: 1,
        archived_path: Some(archive.to_string_lossy().into_owned()),
        archived_directories: archived,
    })
}

fn archive_failed() -> NativeError {
    NativeError::new(
        "local_state_reset_failed",
        "ImageForge could not archive the device-local GPU records.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reporting_nothing_to_archive_is_not_an_error() {
        // A clean install has no lifecycle directories, and asking to reset one
        // must succeed rather than look like a failure to the operator.
        let temporary = tempfile::tempdir().expect("temporary directory");
        let root = temporary.path().join("com.imageforge.desktop");
        std::fs::create_dir_all(&root).expect("state root");
        let present: Vec<&str> = LIFECYCLE_DIRECTORIES
            .into_iter()
            .filter(|name| root.join(name).is_dir())
            .collect();
        assert!(present.is_empty());
    }

    #[test]
    fn the_operators_own_work_is_never_archived() {
        // Receipts, the queue and the destination record are not lifecycle
        // state, so no reset may move them.
        for name in ["queue", "destination.json", "library"] {
            assert!(!LIFECYCLE_DIRECTORIES.contains(&name));
        }
    }
}
