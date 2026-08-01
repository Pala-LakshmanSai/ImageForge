use super::{NativeError, NativeResult};
use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DestinationMetadata {
    pub path: String,
    pub writable: bool,
}

#[derive(Clone, Default)]
pub struct DestinationStore {
    root: Arc<RwLock<Option<PathBuf>>>,
}

impl DestinationStore {
    pub fn validate_and_bind(&self, candidate: &Path) -> NativeResult<DestinationMetadata> {
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

        let display = canonical.to_string_lossy().into_owned();
        let mut guard = self.root.write().map_err(|_| {
            NativeError::new(
                "destination_unavailable",
                "Destination state is unavailable.",
            )
        })?;
        *guard = Some(canonical);
        Ok(DestinationMetadata {
            path: display,
            writable: true,
        })
    }

    pub fn current(&self) -> NativeResult<PathBuf> {
        self.root
            .read()
            .map_err(|_| {
                NativeError::new(
                    "destination_unavailable",
                    "Destination state is unavailable.",
                )
            })?
            .clone()
            .ok_or_else(|| {
                NativeError::new(
                    "destination_unconfigured",
                    "Choose and verify a downloads folder first.",
                )
            })
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
        let store = DestinationStore::default();
        let metadata = store.validate_and_bind(&nested).unwrap();
        assert!(metadata.writable);
        assert!(Path::new(&metadata.path).is_absolute());
        assert_eq!(
            store.confine(Path::new("000001.jpg")).unwrap(),
            nested.join("000001.jpg")
        );
        for escaped in [Path::new("../outside"), Path::new("/tmp/outside")] {
            assert_eq!(
                store.confine(escaped).unwrap_err().code,
                "destination_path_rejected"
            );
        }
    }
}
