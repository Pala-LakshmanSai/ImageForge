//! Hardened cross-platform advisory file leases for private native stores.
//!
//! Callers map I/O faults to their own typed error registry. Keeping this
//! primitive free of queue/Switch policy prevents a corrupted profile-control
//! lock from surfacing as an unrelated queue-store error.

use std::fs::{self, File, OpenOptions};
use std::path::Path;

/// An exclusive, non-blocking OS file lease released on drop.
pub(crate) struct NativeFileLock {
    file: File,
}

impl NativeFileLock {
    /// Open a regular, non-symlink lock file and acquire its exclusive lease
    /// without waiting. `Ok(None)` means another process owns the lease.
    pub(crate) fn try_acquire(path: &Path) -> std::io::Result<Option<Self>> {
        let file = open_safe_lock_file(path)?;
        match lock_file_nonblocking(&file)? {
            true => Ok(Some(Self { file })),
            false => Ok(None),
        }
    }
}

impl Drop for NativeFileLock {
    fn drop(&mut self) {
        let _ = unlock_file(&self.file);
    }
}

/// Opening a symlink here would turn a local coordination action into an
/// arbitrary file-open primitive. Unix additionally requests O_NOFOLLOW and
/// compares the opened inode with the pathname after open to close the
/// replacement race.
fn open_safe_lock_file(path: &Path) -> std::io::Result<File> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "lock file has no parent")
    })?;
    ensure_lock_parent(parent)?;
    validate_lock_file_path(path)?;
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    let opened = file.metadata()?;
    if !opened.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "lock target is not a regular file",
        ));
    }
    validate_lock_file_path(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let path_metadata = fs::symlink_metadata(path)?;
        if opened.dev() != path_metadata.dev() || opened.ino() != path_metadata.ino() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "lock target changed during open",
            ));
        }
    }
    Ok(file)
}

fn ensure_lock_parent(path: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "lock parent is unsafe",
            ));
        }
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    fs::create_dir_all(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "created lock parent is unsafe",
        ));
    }
    Ok(())
}

fn validate_lock_file_path(path: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => Err(
            std::io::Error::new(std::io::ErrorKind::InvalidData, "lock target is unsafe"),
        ),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn lock_file_nonblocking(file: &File) -> std::io::Result<bool> {
    use std::os::fd::AsRawFd;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    let code = error.raw_os_error();
    if code == Some(libc::EWOULDBLOCK) || code == Some(libc::EAGAIN) {
        Ok(false)
    } else {
        Err(error)
    }
}

#[cfg(unix)]
fn unlock_file(file: &File) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn lock_file_nonblocking(file: &File) -> std::io::Result<bool> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        h_event: isize,
    }
    #[link(name = "Kernel32")]
    extern "system" {
        fn LockFileEx(
            file: isize,
            flags: u32,
            reserved: u32,
            low: u32,
            high: u32,
            overlapped: *mut Overlapped,
        ) -> i32;
    }
    const LOCKFILE_FAIL_IMMEDIATELY: u32 = 0x0000_0001;
    const LOCKFILE_EXCLUSIVE_LOCK: u32 = 0x0000_0002;
    let mut overlapped = Overlapped {
        internal: 0,
        internal_high: 0,
        offset: 0,
        offset_high: 0,
        h_event: 0,
    };
    if unsafe {
        LockFileEx(
            file.as_raw_handle() as isize,
            LOCKFILE_FAIL_IMMEDIATELY | LOCKFILE_EXCLUSIVE_LOCK,
            0,
            1,
            0,
            &mut overlapped,
        )
    } != 0
    {
        Ok(true)
    } else {
        let error = std::io::Error::last_os_error();
        // ERROR_LOCK_VIOLATION / ERROR_IO_PENDING both mean an active lease
        // for this non-blocking request.
        if matches!(error.raw_os_error(), Some(33 | 997)) {
            Ok(false)
        } else {
            Err(error)
        }
    }
}

#[cfg(windows)]
fn unlock_file(file: &File) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        h_event: isize,
    }
    #[link(name = "Kernel32")]
    extern "system" {
        fn UnlockFileEx(
            file: isize,
            reserved: u32,
            low: u32,
            high: u32,
            overlapped: *mut Overlapped,
        ) -> i32;
    }
    let mut overlapped = Overlapped {
        internal: 0,
        internal_high: 0,
        offset: 0,
        offset_high: 0,
        h_event: 0,
    };
    if unsafe { UnlockFileEx(file.as_raw_handle() as isize, 0, 1, 0, &mut overlapped) } != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(unix, windows)))]
fn lock_file_nonblocking(_file: &File) -> std::io::Result<bool> {
    Ok(true)
}

#[cfg(not(any(unix, windows)))]
fn unlock_file(_file: &File) -> std::io::Result<()> {
    Ok(())
}
