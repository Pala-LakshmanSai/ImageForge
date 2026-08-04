//! Cross-process native profile-control lease for GPU mutations.
//!
//! This is deliberately an OS file lock rather than a renderer or Tokio-only
//! mutex.  A second ImageForge desktop process sharing the same app-data root
//! must observe the same lease before it can start, stop, switch, or dispatch
//! against the profile.  The lease uses the queue store's hardened
//! cross-platform lock primitive (O_NOFOLLOW/inode verification on Unix and
//! LockFileEx on Windows), but lives at the Task 014 fixed `gpu-switch/v1`
//! app-data location.

use super::file_lock::NativeFileLock;
use super::gpu_switch::default_switch_root;
use super::{NativeError, NativeResult};
use std::path::{Path, PathBuf};

/// RAII holder for `gpu-switch/v1/profile-control.lock`.
///
/// It is Send because it owns only an OS file handle. Commands acquire it via
/// [`ProfileControlLease::try_acquire`] which performs the filesystem open and
/// non-blocking lock attempt on the blocking runtime, never on a Tokio worker.
pub(crate) struct ProfileControlLease {
    _file: NativeFileLock,
}

impl ProfileControlLease {
    /// Attempt one non-blocking lease acquisition. `Ok(None)` is an expected
    /// sibling-process conflict; no timer retry or busy wait is performed.
    pub(crate) async fn try_acquire() -> NativeResult<Option<Self>> {
        let path = default_profile_control_lock_path()?;
        tauri::async_runtime::spawn_blocking(move || Self::try_acquire_at(&path))
            .await
            .map_err(|_| profile_control_unavailable())?
    }

    /// Kept synchronous for deterministic filesystem tests. Production IPC
    /// must call the async wrapper above.
    pub(crate) fn try_acquire_at(path: &Path) -> NativeResult<Option<Self>> {
        NativeFileLock::try_acquire(path)
            .map(|lease| lease.map(|file| Self { _file: file }))
            .map_err(|_| profile_control_unavailable())
    }
}

/// A held profile-control file lease is a retryable local-process contention,
/// not proof of an unsafe remote state. The caller must explicitly retry after
/// the sibling command completes; it must not schedule a background mutation.
pub(crate) fn profile_control_lease_busy() -> NativeError {
    NativeError::retryable(
        "gpu_switch_lease_busy",
        "Another ImageForge process is performing a GPU action. Retry after it completes.",
    )
}

fn profile_control_unavailable() -> NativeError {
    NativeError::new(
        "gpu_switch_store_unrecoverable",
        "The private GPU control store is unavailable. Repair it before changing the GPU.",
    )
}

/// Fixed `gpu-switch/v1` app-data location shared by all native GPU mutations.
/// The Task 014 layout places this file in the Switch store root so a durable
/// `CURRENT`/reservation reread and the cross-process lease share one exact
/// trust root.
pub(crate) fn default_profile_control_lock_path() -> NativeResult<PathBuf> {
    default_switch_root().map(|root| profile_control_lock_path_under(&root))
}

fn profile_control_lock_path_under(switch_root: &Path) -> PathBuf {
    switch_root.join("profile-control.lock")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    const CHILD_LOCK_PATH: &str = "IMAGEFORGE_PROFILE_CONTROL_CHILD_LOCK_PATH";

    #[test]
    fn profile_control_path_is_the_fixed_gpu_switch_store_member() {
        assert_eq!(
            profile_control_lock_path_under(Path::new(
                "/safe-app-data/com.imageforge.desktop/gpu-switch/v1"
            )),
            PathBuf::from(
                "/safe-app-data/com.imageforge.desktop/gpu-switch/v1/profile-control.lock"
            )
        );
    }

    #[test]
    fn independent_file_handles_exclude_a_second_profile_control_lease() {
        let root = std::env::temp_dir().join(format!(
            "imageforge-profile-control-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("temporary profile-control root");
        let path = root.join("profile-control.lock");

        let first = ProfileControlLease::try_acquire_at(&path)
            .expect("first lease result")
            .expect("first lease acquired");
        assert!(
            ProfileControlLease::try_acquire_at(&path)
                .expect("second lease result")
                .is_none(),
            "a separately opened file handle must observe the active OS lease"
        );
        drop(first);
        assert!(
            ProfileControlLease::try_acquire_at(&path)
                .expect("lease after release")
                .is_some(),
            "releasing the first handle must make the lease available"
        );

        fs::remove_dir_all(&root).expect("remove temporary profile-control root");
    }

    #[test]
    fn independent_process_observes_the_active_profile_control_lease() {
        let root = std::env::temp_dir().join(format!(
            "imageforge-profile-control-process-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("temporary profile-control root");
        let path = root.join("profile-control.lock");
        let _lease = ProfileControlLease::try_acquire_at(&path)
            .expect("parent lease result")
            .expect("parent lease acquired");

        let status = Command::new(std::env::current_exe().expect("current test executable"))
            .args([
                "--exact",
                "native::profile_control::tests::child_process_reports_busy",
                "--nocapture",
            ])
            .env(CHILD_LOCK_PATH, &path)
            .status()
            .expect("spawn child test process");
        assert!(
            status.success(),
            "child process must observe the held lease"
        );

        drop(_lease);
        fs::remove_dir_all(&root).expect("remove temporary profile-control root");
    }

    #[test]
    fn child_process_reports_busy() {
        let Some(path) = std::env::var_os(CHILD_LOCK_PATH).map(PathBuf::from) else {
            return;
        };
        assert!(
            ProfileControlLease::try_acquire_at(&path)
                .expect("child lease result")
                .is_none(),
            "a child process must not acquire its parent's active lease"
        );
    }
}
