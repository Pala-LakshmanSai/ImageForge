use super::{NativeError, NativeResult};
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use uuid::Uuid;

const CHOOSER_GRANT_TTL: Duration = Duration::from_secs(120);
const MAX_BATCH_FOLDER_BYTES: usize = 120;
const MAX_BATCH_FOLDER_UTF16_UNITS: usize = 120;
const MAX_BATCH_FOLDER_COLLISIONS: u32 = 10_000;
const MAX_BATCH_FOLDER_MAPPING_BYTES: u64 = 4 * 1024;
const MAX_LEGACY_RECEIPT_BYTES: u64 = 16 * 1024;
const BATCH_FOLDER_OWNER_FILE: &str = ".imageforge-batch-owner";

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

/// A queue record keeps this private binding beside the renderer-visible
/// destination string.  The chooser grant itself is deliberately short lived
/// and never serialized; this identity is what lets a later dispatch reject a
/// replaced, linked, or otherwise different destination root.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct QueueDestinationBinding {
    path: String,
    identity: RootIdentity,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedDestination {
    schema_version: u8,
    path: String,
    identity: RootIdentity,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BatchFolderMapping {
    schema_version: u8,
    batch_id: Uuid,
    folder_name: String,
    legacy_migration: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyReceiptProbe {
    schema_version: u8,
    batch_id: Uuid,
    index: u64,
    filename: String,
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
    batch_folder_lock: Arc<Mutex<()>>,
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
            batch_folder_lock: Arc::new(Mutex::new(())),
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

    /// Capture the currently authorized destination for a new local queue
    /// item. The renderer may name the path it already displays, but it cannot
    /// supply a grant, root identity, or an alternate filesystem location.
    pub(crate) fn capture_queue_destination(
        &self,
        visible_path: &str,
    ) -> NativeResult<QueueDestinationBinding> {
        let current = self.current()?;
        let rendered = current.to_string_lossy();
        if visible_path != rendered {
            return Err(destination_root_replaced());
        }
        Ok(QueueDestinationBinding {
            path: rendered.into_owned(),
            identity: root_identity(&current)?,
        })
    }

    /// Validate only the serialized private binding shape while reading the
    /// queue journal. This deliberately does not touch the filesystem (a
    /// disconnected destination is handled at dispatch), but it prevents a
    /// tampered row from pairing a visible destination path with another
    /// root's private identity.
    pub(crate) fn validate_queue_binding(
        &self,
        binding: &QueueDestinationBinding,
        visible_path: &str,
    ) -> NativeResult<()> {
        if binding.path != visible_path
            || binding.path.is_empty()
            || binding.path.contains('\0')
            || !Path::new(&binding.path).is_absolute()
        {
            return Err(destination_root_replaced());
        }
        #[cfg(unix)]
        if binding.identity.inode == 0 {
            return Err(destination_root_replaced());
        }
        #[cfg(windows)]
        if binding.identity.volume.is_none() || binding.identity.index.unwrap_or_default() == 0 {
            return Err(destination_root_replaced());
        }
        Ok(())
    }

    /// Re-check a private queue binding immediately before reference bytes are
    /// exposed for dispatch. This intentionally performs no implicit rebind:
    /// an editor must explicitly choose and validate a replacement folder.
    pub(crate) fn verify_queue_destination(
        &self,
        binding: &QueueDestinationBinding,
    ) -> NativeResult<()> {
        let current = self.current()?;
        if current.to_string_lossy() != binding.path || root_identity(&current)? != binding.identity
        {
            return Err(destination_root_replaced());
        }
        probe_writable(&current)
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

    pub(crate) fn resolve_batch_folder(
        &self,
        batch_id: Uuid,
        batch_name: &str,
    ) -> NativeResult<String> {
        let _guard = self
            .batch_folder_lock
            .lock()
            .map_err(|_| batch_folder_mapping_error())?;
        if let Some(mapping) = self.read_batch_folder_mapping_unlocked(batch_id)? {
            return self.materialize_batch_folder_unlocked(&mapping);
        }

        self.ensure_safe_directory(Path::new("batches"))?;
        self.ensure_safe_directory(Path::new(".imageforge/batch-folders"))?;
        let legacy_migration = self.has_valid_legacy_receipt_unlocked(batch_id)?
            && self
                .existing_safe_entry(&PathBuf::from("batches").join(batch_id.to_string()))?
                .is_some_and(|(_, metadata)| metadata.is_dir());
        let folder_name = self.choose_available_batch_folder_unlocked(batch_name)?;
        let mapping = BatchFolderMapping {
            schema_version: 1,
            batch_id,
            folder_name: folder_name.clone(),
            legacy_migration,
        };

        // The mapping is the transaction record for both new folders and
        // legacy migration. Persist it first so a crash can never strand an
        // unowned named directory and force a false `(2)` collision.
        self.persist_batch_folder_mapping_unlocked(&mapping)?;
        self.materialize_batch_folder_unlocked(&mapping)
    }

    pub(crate) fn resolve_existing_batch_folder(
        &self,
        batch_id: Uuid,
    ) -> NativeResult<Option<String>> {
        let _guard = self
            .batch_folder_lock
            .lock()
            .map_err(|_| batch_folder_mapping_error())?;
        self.read_batch_folder_mapping_unlocked(batch_id)?
            .map(|mapping| self.materialize_batch_folder_unlocked(&mapping))
            .transpose()
    }

    fn resolve_manifest_batch_folder(&self, batch_id: Uuid) -> NativeResult<String> {
        let _guard = self
            .batch_folder_lock
            .lock()
            .map_err(|_| batch_folder_mapping_error())?;
        if let Some(mapping) = self.read_batch_folder_mapping_unlocked(batch_id)? {
            return self.materialize_batch_folder_unlocked(&mapping);
        }
        let legacy_name = batch_id.to_string();
        let relative = PathBuf::from("batches").join(&legacy_name);
        match self.existing_safe_entry(&relative)? {
            Some((_, metadata)) if metadata.is_dir() => Ok(legacy_name),
            Some(_) => Err(batch_folder_collision_error()),
            None => {
                self.create_batch_directory_unlocked(&legacy_name)?;
                Ok(legacy_name)
            }
        }
    }

    fn read_batch_folder_mapping_unlocked(
        &self,
        batch_id: Uuid,
    ) -> NativeResult<Option<BatchFolderMapping>> {
        let relative = PathBuf::from(".imageforge")
            .join("batch-folders")
            .join(format!("{batch_id}.json"));
        let Some((path, metadata)) = self.existing_safe_entry(&relative)? else {
            return Ok(None);
        };
        if !metadata.is_file() {
            return Err(batch_folder_mapping_error());
        }
        let mut file = OpenOptions::new()
            .read(true)
            .open(path)
            .map_err(|_| batch_folder_mapping_error())?;
        if file
            .metadata()
            .map_err(|_| batch_folder_mapping_error())?
            .len()
            > MAX_BATCH_FOLDER_MAPPING_BYTES
        {
            return Err(batch_folder_mapping_error());
        }
        let mut encoded = Vec::new();
        std::io::Read::by_ref(&mut file)
            .take(MAX_BATCH_FOLDER_MAPPING_BYTES + 1)
            .read_to_end(&mut encoded)
            .map_err(|_| batch_folder_mapping_error())?;
        if encoded.len() as u64 > MAX_BATCH_FOLDER_MAPPING_BYTES {
            return Err(batch_folder_mapping_error());
        }
        let mapping: BatchFolderMapping =
            serde_json::from_slice(&encoded).map_err(|_| batch_folder_mapping_error())?;
        if mapping.schema_version != 1
            || mapping.batch_id != batch_id
            || !is_safe_batch_folder_component(&mapping.folder_name)
            || (mapping.legacy_migration && mapping.folder_name == batch_id.to_string())
        {
            return Err(batch_folder_mapping_error());
        }
        Ok(Some(mapping))
    }

    fn persist_batch_folder_mapping_unlocked(
        &self,
        mapping: &BatchFolderMapping,
    ) -> NativeResult<()> {
        let directory = self.ensure_safe_directory(Path::new(".imageforge/batch-folders"))?;
        let destination = directory.join(format!("{}.json", mapping.batch_id));
        if destination.exists() {
            let existing = self
                .read_batch_folder_mapping_unlocked(mapping.batch_id)?
                .ok_or_else(batch_folder_mapping_error)?;
            return (existing == *mapping)
                .then_some(())
                .ok_or_else(batch_folder_mapping_error);
        }

        let encoded = serde_json::to_vec(mapping).map_err(|_| batch_folder_mapping_error())?;
        let temporary = directory.join(format!(".{}.{}.tmp", mapping.batch_id, Uuid::new_v4()));
        let result = (|| -> std::io::Result<()> {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)?;
            file.write_all(&encoded)?;
            file.sync_all()?;
            drop(file);
            move_path_no_replace(&temporary, &destination)?;
            sync_directory(&directory)?;
            Ok(())
        })();
        if let Err(error) = result {
            let _ = std::fs::remove_file(&temporary);
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                let existing = self
                    .read_batch_folder_mapping_unlocked(mapping.batch_id)?
                    .ok_or_else(batch_folder_mapping_error)?;
                if existing == *mapping {
                    return Ok(());
                }
            }
            return Err(batch_folder_mapping_error());
        }
        Ok(())
    }

    fn materialize_batch_folder_unlocked(
        &self,
        mapping: &BatchFolderMapping,
    ) -> NativeResult<String> {
        let batches = self.ensure_safe_directory(Path::new("batches"))?;
        let target_relative = PathBuf::from("batches").join(&mapping.folder_name);
        let target = self.existing_safe_entry(&target_relative)?;
        if !mapping.legacy_migration {
            match target {
                Some((_, metadata)) if metadata.is_dir() => {
                    self.verify_owned_batch_directory_unlocked(mapping)?;
                }
                Some(_) => return Err(batch_folder_collision_error()),
                None => {
                    self.create_owned_batch_directory_unlocked(mapping)?;
                }
            }
            return Ok(mapping.folder_name.clone());
        }

        let legacy_relative = PathBuf::from("batches").join(mapping.batch_id.to_string());
        let legacy = self.existing_safe_entry(&legacy_relative)?;
        match (legacy, target) {
            (Some((source, source_metadata)), None) if source_metadata.is_dir() => {
                let destination = batches.join(&mapping.folder_name);
                move_path_no_replace(&source, &destination).map_err(|error| {
                    if error.kind() == std::io::ErrorKind::AlreadyExists {
                        batch_folder_collision_error()
                    } else {
                        batch_folder_migration_error()
                    }
                })?;
                sync_directory(&batches).map_err(|_| batch_folder_migration_error())?;
            }
            (None, Some((_, target_metadata))) if target_metadata.is_dir() => {}
            (Some(_), Some(_)) => return Err(batch_folder_collision_error()),
            (None, None) => return Err(batch_folder_migration_error()),
            _ => return Err(batch_folder_migration_error()),
        }
        Ok(mapping.folder_name.clone())
    }

    fn choose_available_batch_folder_unlocked(&self, batch_name: &str) -> NativeResult<String> {
        let base = sanitize_batch_folder_name(batch_name);
        for collision in 0..MAX_BATCH_FOLDER_COLLISIONS {
            let candidate = batch_folder_with_suffix(&base, collision);
            if self.batch_folder_name_is_available_unlocked(&candidate)? {
                return Ok(candidate);
            }
        }
        Err(batch_folder_collision_error())
    }

    fn batch_folder_name_is_available_unlocked(&self, candidate: &str) -> NativeResult<bool> {
        let batches = self.ensure_safe_directory(Path::new("batches"))?;
        let folded_candidate = candidate.to_lowercase();
        let mappings = self.ensure_safe_directory(Path::new(".imageforge/batch-folders"))?;
        for entry in std::fs::read_dir(mappings).map_err(|_| batch_folder_mapping_error())? {
            let entry = entry.map_err(|_| batch_folder_mapping_error())?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let Some(stem) = name.strip_suffix(".json") else {
                continue;
            };
            let Ok(batch_id) = Uuid::parse_str(stem) else {
                continue;
            };
            let mapping = self
                .read_batch_folder_mapping_unlocked(batch_id)?
                .ok_or_else(batch_folder_mapping_error)?;
            if mapping.folder_name.to_lowercase() == folded_candidate {
                return Ok(false);
            }
        }
        let entries = std::fs::read_dir(batches).map_err(|_| destination_write_error())?;
        for entry in entries {
            let entry = entry.map_err(|_| destination_write_error())?;
            if entry.file_name().to_string_lossy().to_lowercase() == folded_candidate {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn create_owned_batch_directory_unlocked(
        &self,
        mapping: &BatchFolderMapping,
    ) -> NativeResult<PathBuf> {
        if !is_safe_batch_folder_component(&mapping.folder_name) || mapping.legacy_migration {
            return Err(batch_folder_mapping_error());
        }
        let batches = self.ensure_safe_directory(Path::new("batches"))?;
        let destination = batches.join(&mapping.folder_name);
        let staging = batches.join(format!(
            ".imageforge-batch-{}-{}.part",
            mapping.batch_id,
            Uuid::new_v4()
        ));
        let result = (|| -> std::io::Result<()> {
            std::fs::create_dir(&staging)?;
            let marker = staging.join(BATCH_FOLDER_OWNER_FILE);
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&marker)?;
            file.write_all(mapping.batch_id.to_string().as_bytes())?;
            file.sync_all()?;
            drop(file);
            hide_internal_file(&marker)?;
            sync_directory(&staging)?;
            move_path_no_replace(&staging, &destination)?;
            sync_directory(&batches)?;
            Ok(())
        })();
        if let Err(error) = result {
            let _ = std::fs::remove_file(staging.join(BATCH_FOLDER_OWNER_FILE));
            let _ = std::fs::remove_dir(&staging);
            return if error.kind() == std::io::ErrorKind::AlreadyExists {
                Err(batch_folder_collision_error())
            } else {
                Err(destination_write_error())
            };
        }
        self.verify_owned_batch_directory_unlocked(mapping)?;
        Ok(destination)
    }

    fn verify_owned_batch_directory_unlocked(
        &self,
        mapping: &BatchFolderMapping,
    ) -> NativeResult<()> {
        let relative = PathBuf::from("batches")
            .join(&mapping.folder_name)
            .join(BATCH_FOLDER_OWNER_FILE);
        let Some((path, metadata)) = self.existing_safe_entry(&relative)? else {
            return Err(batch_folder_collision_error());
        };
        if !metadata.is_file() || metadata.len() != 36 {
            return Err(batch_folder_collision_error());
        }
        let mut file = OpenOptions::new()
            .read(true)
            .open(path)
            .map_err(|_| batch_folder_collision_error())?;
        let mut encoded = Vec::with_capacity(36);
        std::io::Read::by_ref(&mut file)
            .take(37)
            .read_to_end(&mut encoded)
            .map_err(|_| batch_folder_collision_error())?;
        if encoded != mapping.batch_id.to_string().as_bytes() {
            return Err(batch_folder_collision_error());
        }
        let Some((_, metadata)) = self.existing_safe_entry(&relative)? else {
            return Err(batch_folder_collision_error());
        };
        if !metadata.is_file() || metadata.len() != 36 {
            return Err(batch_folder_collision_error());
        }
        Ok(())
    }

    fn create_batch_directory_unlocked(&self, folder_name: &str) -> NativeResult<PathBuf> {
        if !is_safe_batch_folder_component(folder_name) {
            return Err(batch_folder_mapping_error());
        }
        let batches = self.ensure_safe_directory(Path::new("batches"))?;
        let directory = batches.join(folder_name);
        match std::fs::create_dir(&directory) {
            Ok(()) => {
                sync_directory(&directory).map_err(|_| destination_write_error())?;
                sync_directory(&batches).map_err(|_| destination_write_error())?;
                Ok(directory)
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                Err(batch_folder_collision_error())
            }
            Err(_) => Err(destination_write_error()),
        }
    }

    fn has_valid_legacy_receipt_unlocked(&self, batch_id: Uuid) -> NativeResult<bool> {
        let relative = PathBuf::from(".imageforge")
            .join("receipts")
            .join(batch_id.to_string());
        let Some((directory, metadata)) = self.existing_safe_entry(&relative)? else {
            return Ok(false);
        };
        if !metadata.is_dir() {
            return Err(batch_folder_migration_error());
        }
        let entries = std::fs::read_dir(directory).map_err(|_| batch_folder_migration_error())?;
        for entry in entries {
            let entry = entry.map_err(|_| batch_folder_migration_error())?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !is_receipt_filename(name) {
                continue;
            }
            let Some((path, metadata)) = self.existing_safe_entry(&relative.join(name))? else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            let Ok(mut file) = OpenOptions::new().read(true).open(path) else {
                continue;
            };
            let Ok(length) = file.metadata().map(|metadata| metadata.len()) else {
                continue;
            };
            if length == 0 || length > MAX_LEGACY_RECEIPT_BYTES {
                continue;
            }
            let mut encoded = Vec::with_capacity(length as usize);
            if std::io::Read::by_ref(&mut file)
                .take(MAX_LEGACY_RECEIPT_BYTES + 1)
                .read_to_end(&mut encoded)
                .is_err()
                || encoded.len() as u64 > MAX_LEGACY_RECEIPT_BYTES
            {
                continue;
            }
            let Ok(receipt) = serde_json::from_slice::<LegacyReceiptProbe>(&encoded) else {
                continue;
            };
            if receipt.schema_version == 1
                && receipt.batch_id == batch_id
                && receipt.index > 0
                && receipt.filename == format!("batches/{batch_id}/{:06}.jpg", receipt.index)
                && name == format!("{:06}.json", receipt.index)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn existing_safe_entry(
        &self,
        relative: &Path,
    ) -> NativeResult<Option<(PathBuf, std::fs::Metadata)>> {
        if relative.is_absolute() {
            return Err(destination_path_error());
        }
        let mut current = self.current()?;
        let components = relative.components().collect::<Vec<_>>();
        for (position, component) in components.iter().enumerate() {
            let std::path::Component::Normal(component) = component else {
                return Err(destination_path_error());
            };
            current.push(component);
            let Some(metadata) = safe_metadata(&current)? else {
                return Ok(None);
            };
            if position + 1 < components.len() && !metadata.is_dir() {
                return Err(destination_path_error());
            }
            if position + 1 == components.len() {
                return Ok(Some((current, metadata)));
            }
        }
        Err(destination_path_error())
    }

    fn ensure_safe_directory(&self, relative: &Path) -> NativeResult<PathBuf> {
        if relative.is_absolute() {
            return Err(destination_path_error());
        }
        let root = self.current()?;
        let mut current = root.clone();
        for component in relative.components() {
            let std::path::Component::Normal(component) = component else {
                return Err(destination_path_error());
            };
            current.push(component);
            match safe_metadata(&current)? {
                Some(metadata) if metadata.is_dir() => {}
                Some(_) => return Err(destination_path_error()),
                None => match std::fs::create_dir(&current) {
                    Ok(()) => {
                        sync_directory(&current).map_err(|_| destination_write_error())?;
                        if let Some(parent) = current.parent() {
                            sync_directory(parent).map_err(|_| destination_write_error())?;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        if !safe_metadata(&current)?.is_some_and(|metadata| metadata.is_dir()) {
                            return Err(destination_path_error());
                        }
                    }
                    Err(_) => return Err(destination_write_error()),
                },
            }
        }
        if !current.starts_with(root) {
            return Err(destination_path_error());
        }
        Ok(current)
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
            // Finder-launched apps do not inherit a user shell PATH. Use the
            // system tool's stable absolute path so reveal remains functional
            // and cannot resolve an unrelated executable from PATH.
            let mut command = std::process::Command::new("/usr/bin/open");
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
            // Finder-launched/packaged apps must not resolve a shell helper
            // through the current directory or an attacker-controlled PATH.
            let mut command = std::process::Command::new(windows_explorer_path()?);
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
        let folder_name = self.resolve_manifest_batch_folder(batch_id)?;
        let batches = self.ensure_safe_directory(Path::new("batches"))?;
        let batch_directory = self
            .existing_safe_entry(&PathBuf::from("batches").join(&folder_name))?
            .and_then(|(path, metadata)| metadata.is_dir().then_some(path))
            .ok_or_else(batch_folder_mapping_error)?;
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

pub(crate) fn sanitize_batch_folder_name(value: &str) -> String {
    let mut sanitized = String::new();
    let mut utf16_units = 0_usize;
    for character in value.chars() {
        let character = if is_invalid_batch_folder_character(character) {
            '-'
        } else {
            character
        };
        let next_bytes = sanitized.len().saturating_add(character.len_utf8());
        let next_utf16 = utf16_units.saturating_add(character.len_utf16());
        if next_bytes > MAX_BATCH_FOLDER_BYTES || next_utf16 > MAX_BATCH_FOLDER_UTF16_UNITS {
            break;
        }
        sanitized.push(character);
        utf16_units = next_utf16;
    }

    let mut sanitized = trim_batch_folder_component(&sanitized);
    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        sanitized = "Untitled batch".to_owned();
    }
    if is_windows_reserved_component(&sanitized) {
        sanitized = truncate_batch_folder_component(
            &format!("Batch {sanitized}"),
            MAX_BATCH_FOLDER_BYTES,
            MAX_BATCH_FOLDER_UTF16_UNITS,
        );
    }
    if sanitized.is_empty() {
        "Untitled batch".to_owned()
    } else {
        sanitized
    }
}

fn batch_folder_with_suffix(base: &str, collision: u32) -> String {
    if collision == 0 {
        return base.to_owned();
    }
    let suffix = format!(" ({})", collision + 1);
    let stem = truncate_batch_folder_component(
        base,
        MAX_BATCH_FOLDER_BYTES.saturating_sub(suffix.len()),
        MAX_BATCH_FOLDER_UTF16_UNITS.saturating_sub(suffix.encode_utf16().count()),
    );
    let stem = if stem.is_empty() { "Batch" } else { &stem };
    format!("{stem}{suffix}")
}

fn truncate_batch_folder_component(value: &str, max_bytes: usize, max_utf16: usize) -> String {
    let mut result = String::new();
    let mut utf16_units = 0_usize;
    for character in value.chars() {
        let next_bytes = result.len().saturating_add(character.len_utf8());
        let next_utf16 = utf16_units.saturating_add(character.len_utf16());
        if next_bytes > max_bytes || next_utf16 > max_utf16 {
            break;
        }
        result.push(character);
        utf16_units = next_utf16;
    }
    trim_batch_folder_component(&result)
}

fn trim_batch_folder_component(value: &str) -> String {
    value
        .trim()
        .trim_end_matches(|character: char| character == '.' || character.is_whitespace())
        .to_owned()
}

fn is_invalid_batch_folder_character(character: char) -> bool {
    character.is_control()
        || matches!(
            character,
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
        )
}

fn is_windows_reserved_component(value: &str) -> bool {
    let stem = value.split('.').next().unwrap_or_default();
    let uppercase = stem.to_ascii_uppercase();
    matches!(uppercase.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
        || ["COM", "LPT"].iter().any(|prefix| {
            uppercase.strip_prefix(prefix).is_some_and(|suffix| {
                let mut characters = suffix.chars();
                matches!(characters.next(), Some('1'..='9' | '¹' | '²' | '³'))
                    && characters.next().is_none()
            })
        })
}

fn is_safe_batch_folder_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= MAX_BATCH_FOLDER_BYTES
        && value.encode_utf16().count() <= MAX_BATCH_FOLDER_UTF16_UNITS
        && trim_batch_folder_component(value) == value
        && !value.chars().any(is_invalid_batch_folder_character)
        && !is_windows_reserved_component(value)
        && Path::new(value).components().count() == 1
        && matches!(
            Path::new(value).components().next(),
            Some(std::path::Component::Normal(_))
        )
}

fn is_receipt_filename(name: &str) -> bool {
    name.len() == 11
        && name.ends_with(".json")
        && name[..6].bytes().all(|byte| byte.is_ascii_digit())
}

fn safe_metadata(path: &Path) -> NativeResult<Option<std::fs::Metadata>> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(destination_path_error()),
    };
    if metadata.file_type().is_symlink() {
        return Err(destination_path_error());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(destination_path_error());
        }
    }
    Ok(Some(metadata))
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
pub(crate) fn replace_file_atomic(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(windows)]
pub(crate) fn replace_file_atomic(source: &Path, destination: &Path) -> std::io::Result<()> {
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

#[cfg(windows)]
fn hide_internal_file(path: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN};

    let path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    if unsafe { SetFileAttributesW(path.as_ptr(), FILE_ATTRIBUTE_HIDDEN) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn hide_internal_file(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn move_path_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
pub(crate) fn move_path_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

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
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn move_path_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
pub(crate) fn move_path_no_replace(_source: &Path, _destination: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "atomic no-replace move is unsupported on this development platform",
    ))
}

fn sync_directory(directory: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        // Windows has no portable directory fsync. Directory handles also
        // fail on some supported filesystems (including the hosted runner),
        // so do not turn a successful durable file write into a false error.
        // Every file is fsynced and the final MoveFileEx uses WRITE_THROUGH.
        let _ = directory;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::fs::File::open(directory)?.sync_all()
    }
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

#[cfg(target_os = "windows")]
fn windows_explorer_path() -> NativeResult<PathBuf> {
    let root = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("WINDIR"))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(destination_reveal_error)?;
    let executable = root.join("explorer.exe");
    if executable.is_file() {
        Ok(executable)
    } else {
        Err(destination_reveal_error())
    }
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
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    // `std::os::windows::fs::MetadataExt::{volume_serial_number,file_index}`
    // is still unstable on the Rust toolchain used for this release. Open the
    // directory with the stable Win32 metadata API instead. Backup semantics
    // is required for directory handles; sharing all access avoids blocking
    // another editor or Explorer while we verify the destination.
    let wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(destination_root_replaced());
    }

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    let result = unsafe { GetFileInformationByHandle(handle, &mut information) };
    // Close the handle on both success and failure. The identity is copied
    // before closing, so no Win32 resource escapes this function.
    let _ = unsafe { CloseHandle(handle) };
    if result == 0 {
        return Err(destination_root_replaced());
    }

    Ok(RootIdentity {
        volume: Some(information.dwVolumeSerialNumber),
        index: Some(((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64),
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

fn destination_path_error() -> NativeError {
    NativeError::new(
        "destination_path_rejected",
        "ImageForge will not use a linked or unsafe local batch path.",
    )
}

fn batch_folder_mapping_error() -> NativeError {
    NativeError::new(
        "batch_folder_mapping_invalid",
        "The durable local batch-folder mapping is missing, invalid, or inconsistent.",
    )
}

fn batch_folder_collision_error() -> NativeError {
    NativeError::new(
        "batch_folder_collision",
        "A different local folder occupies the selected batch name; no file was overwritten.",
    )
}

fn batch_folder_migration_error() -> NativeError {
    NativeError::retryable(
        "batch_folder_migration_incomplete",
        "The legacy local batch folder could not be moved safely; retrying will resume migration.",
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

    #[cfg(windows)]
    #[test]
    fn windows_root_identity_is_stable_for_a_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let first = root_identity(temporary.path()).unwrap();
        let second = root_identity(temporary.path()).unwrap();
        assert_eq!(first, second);
        assert!(first.volume.is_some());
        assert!(first.index.is_some());
    }

    #[cfg(windows)]
    #[test]
    fn windows_reveal_uses_the_system_explorer_binary() {
        let executable = windows_explorer_path().unwrap();
        assert!(executable.is_absolute());
        assert_eq!(
            executable.file_name().and_then(|name| name.to_str()),
            Some("explorer.exe")
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

    #[test]
    fn batch_folder_names_preserve_case_and_spaces_but_are_portable() {
        assert_eq!(
            sanitize_batch_folder_name("  Atlas of Quiet Work  "),
            "Atlas of Quiet Work"
        );
        assert_eq!(
            sanitize_batch_folder_name("Launch/Check: 01*"),
            "Launch-Check- 01-"
        );
        assert_eq!(sanitize_batch_folder_name("Atlas.   "), "Atlas");
        assert_eq!(sanitize_batch_folder_name("CON"), "Batch CON");
        assert_eq!(sanitize_batch_folder_name("lpt9.txt"), "Batch lpt9.txt");
        assert_eq!(sanitize_batch_folder_name("COM¹"), "Batch COM¹");
        assert_eq!(sanitize_batch_folder_name("lpt².txt"), "Batch lpt².txt");
        assert_eq!(sanitize_batch_folder_name("COM³"), "Batch COM³");
        assert_eq!(sanitize_batch_folder_name("..."), "Untitled batch");
        assert_eq!(sanitize_batch_folder_name("\u{0000}\u{0007}"), "--");

        let long_name = "Quiet Work ".repeat(100);
        let sanitized = sanitize_batch_folder_name(&long_name);
        assert!(sanitized.len() <= MAX_BATCH_FOLDER_BYTES);
        assert!(sanitized.encode_utf16().count() <= MAX_BATCH_FOLDER_UTF16_UNITS);
        assert!(is_safe_batch_folder_component(&sanitized));
    }

    #[test]
    fn durable_batch_mapping_is_stable_and_suffixes_only_real_collisions() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("downloads");
        let record = temporary.path().join("state").join("destination.json");
        std::fs::create_dir(&destination).unwrap();
        let store = DestinationStore::new_for_test(record.clone());
        store.validate_and_bind(&destination).unwrap();

        let first_batch = Uuid::new_v4();
        assert_eq!(
            store
                .resolve_batch_folder(first_batch, "Atlas of Quiet Work")
                .unwrap(),
            "Atlas of Quiet Work"
        );
        assert_eq!(
            store
                .resolve_batch_folder(first_batch, "A later renderer value")
                .unwrap(),
            "Atlas of Quiet Work"
        );

        let restarted = DestinationStore::new_for_test(record);
        restarted.restore().unwrap().unwrap();
        assert_eq!(
            restarted
                .resolve_existing_batch_folder(first_batch)
                .unwrap(),
            Some("Atlas of Quiet Work".into())
        );
        assert_eq!(
            restarted
                .resolve_batch_folder(Uuid::new_v4(), "Atlas of Quiet Work")
                .unwrap(),
            "Atlas of Quiet Work (2)"
        );
        assert_eq!(
            restarted
                .resolve_batch_folder(Uuid::new_v4(), "ATLAS OF QUIET WORK")
                .unwrap(),
            "ATLAS OF QUIET WORK (3)"
        );
    }

    #[test]
    fn first_named_resolution_migrates_a_legacy_uuid_folder_atomically() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("downloads");
        std::fs::create_dir(&destination).unwrap();
        let store = DestinationStore::new_for_test(temporary.path().join("destination.json"));
        store.validate_and_bind(&destination).unwrap();
        let batch_id = Uuid::new_v4();
        let legacy = destination.join("batches").join(batch_id.to_string());
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("000001.jpg"), b"legacy-image").unwrap();
        let receipt_directory = destination
            .join(".imageforge")
            .join("receipts")
            .join(batch_id.to_string());
        std::fs::create_dir_all(&receipt_directory).unwrap();
        std::fs::write(
            receipt_directory.join("000001.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "batchId": batch_id,
                "index": 1,
                "filename": format!("batches/{batch_id}/000001.jpg")
            }))
            .unwrap(),
        )
        .unwrap();

        assert_eq!(
            store
                .resolve_batch_folder(batch_id, "Atlas of Quiet Work")
                .unwrap(),
            "Atlas of Quiet Work"
        );
        assert!(!legacy.exists());
        assert_eq!(
            std::fs::read(
                destination
                    .join("batches")
                    .join("Atlas of Quiet Work")
                    .join("000001.jpg")
            )
            .unwrap(),
            b"legacy-image"
        );
        let mapping: BatchFolderMapping = serde_json::from_slice(
            &std::fs::read(
                destination
                    .join(".imageforge")
                    .join("batch-folders")
                    .join(format!("{batch_id}.json")),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(mapping.legacy_migration);
        assert_eq!(mapping.folder_name, "Atlas of Quiet Work");
    }

    #[test]
    fn interrupted_legacy_migration_resumes_from_the_durable_mapping() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("downloads");
        let record = temporary.path().join("state").join("destination.json");
        std::fs::create_dir(&destination).unwrap();
        let store = DestinationStore::new_for_test(record.clone());
        store.validate_and_bind(&destination).unwrap();
        let batch_id = Uuid::new_v4();
        let legacy = destination.join("batches").join(batch_id.to_string());
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("000021.jpg"), b"last-legacy-image").unwrap();
        let mapping = BatchFolderMapping {
            schema_version: 1,
            batch_id,
            folder_name: "Recovered Batch".into(),
            legacy_migration: true,
        };
        store
            .persist_batch_folder_mapping_unlocked(&mapping)
            .unwrap();
        assert!(legacy.exists());
        assert!(!destination.join("batches").join("Recovered Batch").exists());

        let restarted = DestinationStore::new_for_test(record);
        restarted.restore().unwrap().unwrap();
        assert_eq!(
            restarted.resolve_existing_batch_folder(batch_id).unwrap(),
            Some("Recovered Batch".into())
        );
        assert!(!legacy.exists());
        assert_eq!(
            std::fs::read(
                destination
                    .join("batches")
                    .join("Recovered Batch")
                    .join("000021.jpg")
            )
            .unwrap(),
            b"last-legacy-image"
        );
    }

    #[test]
    fn interrupted_new_folder_creation_resumes_without_a_false_suffix() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("downloads");
        let record = temporary.path().join("state").join("destination.json");
        std::fs::create_dir(&destination).unwrap();
        let store = DestinationStore::new_for_test(record.clone());
        store.validate_and_bind(&destination).unwrap();
        let batch_id = Uuid::new_v4();
        let mapping = BatchFolderMapping {
            schema_version: 1,
            batch_id,
            folder_name: "Atlas of Quiet Work".into(),
            legacy_migration: false,
        };
        store
            .persist_batch_folder_mapping_unlocked(&mapping)
            .unwrap();
        assert!(!destination
            .join("batches")
            .join("Atlas of Quiet Work")
            .exists());

        let restarted = DestinationStore::new_for_test(record);
        restarted.restore().unwrap().unwrap();
        assert_eq!(
            restarted.resolve_existing_batch_folder(batch_id).unwrap(),
            Some("Atlas of Quiet Work".into())
        );
        assert!(destination
            .join("batches")
            .join("Atlas of Quiet Work")
            .is_dir());
        assert!(!destination
            .join("batches")
            .join("Atlas of Quiet Work (2)")
            .exists());
    }

    #[test]
    fn pending_mapping_reserves_its_name_and_rejects_an_unowned_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("downloads");
        std::fs::create_dir(&destination).unwrap();
        let store = DestinationStore::new_for_test(temporary.path().join("destination.json"));
        store.validate_and_bind(&destination).unwrap();
        let first_batch = Uuid::new_v4();
        let pending = BatchFolderMapping {
            schema_version: 1,
            batch_id: first_batch,
            folder_name: "Atlas of Quiet Work".into(),
            legacy_migration: false,
        };
        store
            .persist_batch_folder_mapping_unlocked(&pending)
            .unwrap();

        assert_eq!(
            store
                .resolve_batch_folder(Uuid::new_v4(), "Atlas of Quiet Work")
                .unwrap(),
            "Atlas of Quiet Work (2)"
        );
        let unrelated = destination.join("batches").join("Atlas of Quiet Work");
        std::fs::create_dir(&unrelated).unwrap();
        std::fs::write(unrelated.join("keep.txt"), b"unrelated").unwrap();

        assert_eq!(
            store
                .resolve_existing_batch_folder(first_batch)
                .unwrap_err()
                .code,
            "batch_folder_collision"
        );
        assert_eq!(
            std::fs::read(unrelated.join("keep.txt")).unwrap(),
            b"unrelated"
        );
    }

    #[test]
    fn oversized_legacy_receipt_probe_is_bounded_and_ignored() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("downloads");
        std::fs::create_dir(&destination).unwrap();
        let store = DestinationStore::new_for_test(temporary.path().join("destination.json"));
        store.validate_and_bind(&destination).unwrap();
        let batch_id = Uuid::new_v4();
        let receipt_directory = destination
            .join(".imageforge")
            .join("receipts")
            .join(batch_id.to_string());
        std::fs::create_dir_all(&receipt_directory).unwrap();
        std::fs::write(
            receipt_directory.join("000001.json"),
            vec![b' '; MAX_LEGACY_RECEIPT_BYTES as usize + 1],
        )
        .unwrap();

        assert!(!store.has_valid_legacy_receipt_unlocked(batch_id).unwrap());
    }

    #[test]
    fn oversized_batch_mapping_is_rejected_before_json_parsing() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("downloads");
        std::fs::create_dir(&destination).unwrap();
        let store = DestinationStore::new_for_test(temporary.path().join("destination.json"));
        store.validate_and_bind(&destination).unwrap();
        let batch_id = Uuid::new_v4();
        let mapping_directory = destination.join(".imageforge").join("batch-folders");
        std::fs::create_dir_all(&mapping_directory).unwrap();
        std::fs::write(
            mapping_directory.join(format!("{batch_id}.json")),
            vec![b' '; MAX_BATCH_FOLDER_MAPPING_BYTES as usize + 1],
        )
        .unwrap();

        assert_eq!(
            store
                .resolve_existing_batch_folder(batch_id)
                .unwrap_err()
                .code,
            "batch_folder_mapping_invalid"
        );
    }

    #[test]
    fn manifest_uses_the_same_named_batch_mapping() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("downloads");
        std::fs::create_dir(&destination).unwrap();
        let store = DestinationStore::new_for_test(temporary.path().join("destination.json"));
        store.validate_and_bind(&destination).unwrap();
        let batch_id = Uuid::new_v4();
        store
            .resolve_batch_folder(batch_id, "Atlas of Quiet Work")
            .unwrap();

        let manifest = store
            .write_manifest(&batch_id.to_string(), "manifest\n")
            .unwrap();
        assert_eq!(
            PathBuf::from(manifest).parent().unwrap(),
            destination
                .canonicalize()
                .unwrap()
                .join("batches")
                .join("Atlas of Quiet Work")
        );
    }

    #[cfg(unix)]
    #[test]
    fn named_batch_resolution_never_follows_an_existing_link() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("downloads");
        let outside = temporary.path().join("outside");
        std::fs::create_dir(&destination).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::create_dir(destination.join("batches")).unwrap();
        symlink(&outside, destination.join("batches").join("Atlas")).unwrap();
        let store = DestinationStore::new_for_test(temporary.path().join("destination.json"));
        store.validate_and_bind(&destination).unwrap();

        assert_eq!(
            store.resolve_batch_folder(Uuid::new_v4(), "Atlas").unwrap(),
            "Atlas (2)"
        );
        assert_eq!(std::fs::read_dir(outside).unwrap().count(), 0);
    }
}
