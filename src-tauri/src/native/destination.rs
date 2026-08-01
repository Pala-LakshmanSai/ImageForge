use super::{NativeError, NativeResult};
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use uuid::Uuid;

const CHOOSER_GRANT_TTL: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DestinationMetadata {
    pub path: String,
    pub writable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DestinationSelection {
    pub path: String,
    pub chooser_grant: String,
}

#[derive(Debug, Clone)]
struct BoundDestination {
    path: PathBuf,
    identity: RootIdentity,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RootIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    volume: Option<u32>,
    #[cfg(windows)]
    index: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedDestination {
    schema_version: u8,
    path: String,
    identity: RootIdentity,
}

#[derive(Debug, Clone)]
struct ChooserGrant {
    token: String,
    path: PathBuf,
    issued_at: Instant,
}

#[derive(Clone)]
pub struct DestinationStore {
    root: Arc<RwLock<Option<BoundDestination>>>,
    chooser_grant: Arc<Mutex<Option<ChooserGrant>>>,
    record_path: Arc<PathBuf>,
}

impl DestinationStore {
    pub fn new() -> NativeResult<Self> {
        Ok(Self::with_record_path(default_record_path()?))
    }

    fn with_record_path(record_path: PathBuf) -> Self {
        Self {
            root: Arc::new(RwLock::new(None)),
            chooser_grant: Arc::new(Mutex::new(None)),
            record_path: Arc::new(record_path),
        }
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(record_path: PathBuf) -> Self {
        Self::with_record_path(record_path)
    }

    pub fn authorize_selected(&self, candidate: &Path) -> NativeResult<DestinationSelection> {
        let canonical = validate_candidate(candidate)?;
        let token = Uuid::new_v4().to_string();
        let grant = ChooserGrant {
            token: token.clone(),
            path: canonical.clone(),
            issued_at: Instant::now(),
        };
        *self
            .chooser_grant
            .lock()
            .map_err(|_| destination_unavailable())? = Some(grant);
        Ok(DestinationSelection {
            path: canonical.to_string_lossy().into_owned(),
            chooser_grant: token,
        })
    }

    pub fn validate_selected(
        &self,
        candidate: &Path,
        chooser_grant: &str,
    ) -> NativeResult<DestinationMetadata> {
        let grant = self
            .chooser_grant
            .lock()
            .map_err(|_| destination_unavailable())?
            .take()
            .ok_or_else(destination_grant_invalid)?;
        let canonical = validate_candidate(candidate)?;
        if grant.token != chooser_grant
            || grant.path != canonical
            || grant.issued_at.elapsed() > CHOOSER_GRANT_TTL
        {
            return Err(destination_grant_invalid());
        }
        self.validate_and_bind(&canonical)
    }

    pub(crate) fn validate_and_bind(&self, candidate: &Path) -> NativeResult<DestinationMetadata> {
        let canonical = validate_candidate(candidate)?;
        reject_reparse_or_symlink(&canonical)?;
        let identity = root_identity(&canonical)?;
        probe_writable(&canonical)?;
        persist_destination_record(&self.record_path, &canonical, &identity)?;

        self.bind_in_memory(canonical, identity)
    }

    pub fn restore(&self) -> NativeResult<Option<DestinationMetadata>> {
        let encoded = match std::fs::read(self.record_path.as_ref()) {
            Ok(encoded) => encoded,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(destination_record_error()),
        };
        let record: PersistedDestination =
            serde_json::from_slice(&encoded).map_err(|_| destination_record_error())?;
        if record.schema_version != 1 {
            return Err(destination_record_error());
        }
        let canonical = validate_candidate(Path::new(&record.path))?;
        reject_reparse_or_symlink(&canonical)?;
        let identity = root_identity(&canonical)?;
        if canonical.to_string_lossy() != record.path || identity != record.identity {
            return Err(destination_root_replaced());
        }
        probe_writable(&canonical)?;
        self.bind_in_memory(canonical, identity).map(Some)
    }

    fn bind_in_memory(
        &self,
        canonical: PathBuf,
        identity: RootIdentity,
    ) -> NativeResult<DestinationMetadata> {
        let display = canonical.to_string_lossy().into_owned();
        let mut guard = self.root.write().map_err(|_| destination_unavailable())?;
        *guard = Some(BoundDestination {
            path: canonical,
            identity,
        });
        Ok(DestinationMetadata {
            path: display,
            writable: true,
        })
    }

    pub fn current(&self) -> NativeResult<PathBuf> {
        let bound = self
            .root
            .read()
            .map_err(|_| destination_unavailable())?
            .clone()
            .ok_or_else(|| {
                NativeError::new(
                    "destination_unconfigured",
                    "Choose and verify a downloads folder first.",
                )
            })?;
        reject_reparse_or_symlink(&bound.path)?;
        let canonical = bound
            .path
            .canonicalize()
            .map_err(|_| destination_root_replaced())?;
        if canonical != bound.path || root_identity(&canonical)? != bound.identity {
            return Err(destination_root_replaced());
        }
        Ok(bound.path)
    }

    pub fn confine(&self, relative: &Path) -> NativeResult<PathBuf> {
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            return Err(NativeError::new(
                "destination_path_rejected",
                "The requested output path is not allowed.",
            ));
        }
        let root = self.current()?;
        Ok(root.join(relative))
    }

    pub fn reveal(&self, relative: Option<&str>) -> NativeResult<()> {
        let root = self.current()?;
        let target = match relative {
            Some(relative) if !relative.is_empty() => self.confine(Path::new(relative))?,
            _ => root.clone(),
        };
        reject_reparse_or_symlink(&target)?;
        if !target.exists() {
            return Err(NativeError::new(
                "destination_missing",
                "The requested ImageForge file is not present on this device.",
            ));
        }
        let canonical_target = target.canonicalize().map_err(|_| {
            NativeError::new(
                "destination_missing",
                "The requested ImageForge file is not present on this device.",
            )
        })?;
        if !canonical_target.starts_with(&root) {
            return Err(NativeError::new(
                "destination_path_rejected",
                "The requested reveal path is outside the ImageForge destination.",
            ));
        }

        #[cfg(target_os = "macos")]
        {
            let mut command = std::process::Command::new("open");
            if canonical_target.is_file() {
                command.arg("-R");
            }
            command.arg(&canonical_target);
            command
                .status()
                .map_err(|_| destination_reveal_error())?
                .success()
                .then_some(())
                .ok_or_else(destination_reveal_error)
        }
        #[cfg(target_os = "windows")]
        {
            let mut command = std::process::Command::new("explorer.exe");
            if canonical_target.is_file() {
                command.arg(format!("/select,{}", canonical_target.display()));
            } else {
                command.arg(&canonical_target);
            }
            command
                .status()
                .map_err(|_| destination_reveal_error())?
                .success()
                .then_some(())
                .ok_or_else(destination_reveal_error)
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = canonical_target;
            Err(NativeError::new(
                "platform_unsupported",
                "Reveal is available in the macOS and Windows apps.",
            ))
        }
    }

    pub fn write_manifest(&self, batch_id: &str, content: &str) -> NativeResult<String> {
        if content.is_empty() || content.len() > 2 * 1024 * 1024 {
            return Err(NativeError::new(
                "manifest_rejected",
                "The manifest is empty or larger than the safe export limit.",
            ));
        }
        let batch_id = Uuid::parse_str(batch_id).map_err(|_| {
            NativeError::new(
                "batch_id_invalid",
                "The ImageForge batch identifier is invalid.",
            )
        })?;
        let batches = self.confine(Path::new("batches"))?;
        if batches.exists() {
            reject_reparse_or_symlink(&batches)?;
        } else {
            std::fs::create_dir(&batches).map_err(|_| destination_write_error())?;
        }
        let batch_directory = batches.join(batch_id.to_string());
        if batch_directory.exists() {
            reject_reparse_or_symlink(&batch_directory)?;
        } else {
            std::fs::create_dir(&batch_directory).map_err(|_| destination_write_error())?;
        }
        let destination = batch_directory.join("manifest.csv");
        if destination.exists() {
            reject_reparse_or_symlink(&destination)?;
        }
        let root = self.current()?;
        let temporary = batch_directory.join(format!(".manifest.{}.part", Uuid::new_v4()));
        let result = (|| -> std::io::Result<()> {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)?;
            file.write_all(content.as_bytes())?;
            file.sync_all()?;
            drop(file);
            replace_file_atomic(&temporary, &destination)?;
            sync_directory(&batch_directory)?;
            sync_directory(&batches)?;
            sync_directory(&root)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
            return Err(destination_write_error());
        }
        Ok(destination.to_string_lossy().into_owned())
    }
}

fn persist_destination_record(
    record_path: &Path,
    canonical: &Path,
    identity: &RootIdentity,
) -> NativeResult<()> {
    let parent = record_path.parent().ok_or_else(destination_record_error)?;
    std::fs::create_dir_all(parent).map_err(|_| destination_record_error())?;
    if let Some(grandparent) = parent.parent() {
        sync_directory(grandparent).map_err(|_| destination_record_error())?;
    }
    let record = PersistedDestination {
        schema_version: 1,
        path: canonical.to_string_lossy().into_owned(),
        identity: identity.clone(),
    };
    let encoded = serde_json::to_vec(&record).map_err(|_| destination_record_error())?;
    let temporary = parent.join(format!(".destination-{}.tmp", Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&encoded)?;
        file.sync_all()?;
        drop(file);
        replace_file_atomic(&temporary, record_path)?;
        sync_directory(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
        return Err(destination_record_error());
    }
    Ok(())
}

#[cfg(unix)]
fn replace_file_atomic(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file_atomic(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn sync_directory(directory: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(directory)?
    };
    #[cfg(not(windows))]
    let file = std::fs::File::open(directory)?;
    sync_directory_handle(file)
}

#[cfg(windows)]
fn sync_directory_handle(file: std::fs::File) -> std::io::Result<()> {
    use windows_sys::Win32::Foundation::{ERROR_INVALID_FUNCTION, ERROR_INVALID_HANDLE};
    match file.sync_all() {
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(code)
                    if code == ERROR_INVALID_FUNCTION as i32 || code == ERROR_INVALID_HANDLE as i32
            ) =>
        {
            // Windows does not expose a portable directory flush on every
            // supported filesystem. Files are individually fsynced and the
            // final MoveFileEx uses WRITE_THROUGH.
            Ok(())
        }
        result => result,
    }
}

#[cfg(not(windows))]
fn sync_directory_handle(file: std::fs::File) -> std::io::Result<()> {
    file.sync_all()
}

fn default_record_path() -> NativeResult<PathBuf> {
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|path| path.join("Library").join("Application Support"));
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base: Option<PathBuf> = None;
    base.map(|path| path.join("com.imageforge.desktop").join("destination.json"))
        .ok_or_else(destination_record_error)
}

fn validate_candidate(candidate: &Path) -> NativeResult<PathBuf> {
    if !candidate.is_absolute() {
        return Err(NativeError::new(
            "destination_invalid",
            "Choose an absolute downloads folder.",
        ));
    }
    if !candidate.is_dir() {
        return Err(NativeError::new(
            "destination_invalid",
            "Choose an existing downloads folder.",
        ));
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|_| destination_write_error())?;
    if !canonical.is_dir() {
        return Err(NativeError::new(
            "destination_invalid",
            "The selected destination is not a folder.",
        ));
    }

    Ok(canonical)
}

fn probe_writable(canonical: &Path) -> NativeResult<()> {
    let probe = canonical.join(format!(".imageforge-write-probe-{}", Uuid::new_v4()));
    let probe_result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&probe)?;
        file.write_all(b"imageforge\n")?;
        file.sync_all()?;
        drop(file);
        std::fs::remove_file(&probe)?;
        Ok(())
    })();
    if probe_result.is_err() {
        let _ = std::fs::remove_file(&probe);
        return Err(destination_write_error());
    }
    Ok(())
}

#[cfg(unix)]
fn root_identity(path: &Path) -> NativeResult<RootIdentity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::metadata(path).map_err(|_| destination_root_replaced())?;
    Ok(RootIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(windows)]
fn root_identity(path: &Path) -> NativeResult<RootIdentity> {
    use std::os::windows::fs::MetadataExt;
    let metadata = std::fs::metadata(path).map_err(|_| destination_root_replaced())?;
    Ok(RootIdentity {
        volume: metadata.volume_serial_number(),
        index: metadata.file_index(),
    })
}

#[cfg(not(any(unix, windows)))]
fn root_identity(_path: &Path) -> NativeResult<RootIdentity> {
    Ok(RootIdentity {})
}

fn reject_reparse_or_symlink(path: &Path) -> NativeResult<()> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| destination_root_replaced())?;
    if metadata.file_type().is_symlink() {
        return Err(destination_root_replaced());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(destination_root_replaced());
        }
    }
    Ok(())
}

fn destination_unavailable() -> NativeError {
    NativeError::new(
        "destination_unavailable",
        "Destination state is unavailable.",
    )
}

fn destination_grant_invalid() -> NativeError {
    NativeError::new(
        "destination_chooser_grant_invalid",
        "Choose the downloads folder again before validating it.",
    )
}

fn destination_reveal_error() -> NativeError {
    NativeError::new(
        "destination_reveal_failed",
        "The operating system could not reveal the ImageForge destination.",
    )
}

fn destination_root_replaced() -> NativeError {
    NativeError::new(
        "destination_root_replaced",
        "The selected downloads folder changed and must be chosen again.",
    )
}

fn destination_record_error() -> NativeError {
    NativeError::new(
        "destination_record_invalid",
        "The saved downloads-folder permission is unavailable; choose the folder again.",
    )
}

fn destination_write_error() -> NativeError {
    NativeError::new(
        "destination_not_writable",
        "ImageForge could not write to the selected downloads folder.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destination_is_canonical_writable_and_confined() {
        let temporary = tempfile::tempdir().unwrap();
        let nested = temporary.path().join("downloads");
        std::fs::create_dir(&nested).unwrap();
        let store = DestinationStore::new_for_test(temporary.path().join("record.json"));
        let metadata = store.validate_and_bind(&nested).unwrap();
        let canonical_nested = nested.canonicalize().unwrap();
        assert!(metadata.writable);
        assert!(Path::new(&metadata.path).is_absolute());
        assert_eq!(
            store.confine(Path::new("000001.jpg")).unwrap(),
            canonical_nested.join("000001.jpg")
        );
        for escaped in [Path::new("../outside"), Path::new("/tmp/outside")] {
            assert_eq!(
                store.confine(escaped).unwrap_err().code,
                "destination_path_rejected"
            );
        }
    }

    #[test]
    fn renderer_validation_requires_the_exact_one_use_chooser_grant() {
        let temporary = tempfile::tempdir().unwrap();
        let first = temporary.path().join("first");
        let second = temporary.path().join("second");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        let store = DestinationStore::new_for_test(temporary.path().join("record.json"));
        let selection = store.authorize_selected(&first).unwrap();
        assert_eq!(
            store
                .validate_selected(&second, &selection.chooser_grant)
                .unwrap_err()
                .code,
            "destination_chooser_grant_invalid"
        );
        assert_eq!(
            store
                .validate_selected(&first, &selection.chooser_grant)
                .unwrap_err()
                .code,
            "destination_chooser_grant_invalid"
        );
        let selection = store.authorize_selected(&first).unwrap();
        store
            .validate_selected(&first, &selection.chooser_grant)
            .unwrap();
        assert_eq!(
            store
                .validate_selected(&first, &selection.chooser_grant)
                .unwrap_err()
                .code,
            "destination_chooser_grant_invalid"
        );
    }

    #[test]
    fn durable_destination_restores_after_restart_and_rejects_root_replacement() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("downloads");
        let record = temporary.path().join("state").join("destination.json");
        std::fs::create_dir(&destination).unwrap();
        let first = DestinationStore::new_for_test(record.clone());
        let selection = first.authorize_selected(&destination).unwrap();
        first
            .validate_selected(&destination, &selection.chooser_grant)
            .unwrap();
        let canonical_destination = destination.canonicalize().unwrap();

        let restarted = DestinationStore::new_for_test(record.clone());
        assert_eq!(
            restarted.restore().unwrap().unwrap().path,
            canonical_destination.to_string_lossy()
        );

        std::fs::remove_dir(&destination).unwrap();
        std::fs::create_dir(&destination).unwrap();
        let replaced = DestinationStore::new_for_test(record);
        assert_eq!(
            replaced.restore().unwrap_err().code,
            "destination_root_replaced"
        );
    }

    #[test]
    fn manifest_export_is_atomic_and_confined_to_the_bound_destination() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("downloads");
        std::fs::create_dir(&destination).unwrap();
        let store = DestinationStore::new_for_test(temporary.path().join("state.json"));
        store.validate_and_bind(&destination).unwrap();
        let canonical_destination = destination.canonicalize().unwrap();

        let batch_id = "11111111-1111-4111-8111-111111111111";
        let path = store
            .write_manifest(batch_id, "index,prompt,status\n1,hello,complete\n")
            .unwrap();
        let path = PathBuf::from(path);
        assert_eq!(
            path.parent().unwrap(),
            canonical_destination.join("batches").join(batch_id)
        );
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "index,prompt,status\n1,hello,complete\n"
        );
        assert_eq!(
            store.write_manifest(batch_id, "").unwrap_err().code,
            "manifest_rejected"
        );
        let second_id = "22222222-2222-4222-8222-222222222222";
        store.write_manifest(second_id, "second\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(
                destination
                    .join("batches")
                    .join(batch_id)
                    .join("manifest.csv")
            )
            .unwrap(),
            "index,prompt,status\n1,hello,complete\n"
        );
        assert_eq!(
            store.reveal(Some("../outside")).unwrap_err().code,
            "destination_path_rejected"
        );
    }
}
