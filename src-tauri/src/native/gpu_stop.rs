//! Crash-safe private journal for the one ordinary Task 012 GPU Stop DELETE.
//!
//! This is deliberately separate from the renderer-visible Pod projection.
//! It stores only opaque IDs, a fingerprint of the strict IPC input, and the
//! already-safe Pod projection needed for replay/uncertainty. No provider URL,
//! credential, raw worker body, or native delete grant is persisted here.

use super::gpu_pod::{
    validate_normal_stop_input, validate_normal_stop_result, validate_pod_observation,
    NativeGpuNormalStopResultV1, NativeGpuNormalStopV1, NativeGpuObservedPodV1,
    NativeGpuPodObservationV1,
};
use super::{NativeError, NativeResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

const SCHEMA_VERSION: u8 = 1;
const MAX_RECORD_BYTES: u64 = 16 * 1024;
const PREFLIGHT_ABORT_SCHEMA_VERSION: u8 = 1;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NormalStopPhaseV1 {
    Preflight,
    DeleteIntent,
    DeleteUncertain,
    Completed,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NormalStopRecordV1 {
    pub schema_version: u8,
    pub input: NativeGpuNormalStopV1,
    pub input_sha256: String,
    pub operation_id: String,
    pub finalization_id: String,
    pub phase: NormalStopPhaseV1,
    pub delete_wire_attempts: u8,
    pub preflight_pod: NativeGpuObservedPodV1,
    pub preflight_observation: NativeGpuPodObservationV1,
    pub result: Option<NativeGpuNormalStopResultV1>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NormalStopLookupV1 {
    Missing,
    Exact(NormalStopRecordV1),
    DifferentRequestActive,
}

/// Creation is idempotent at the journal boundary as well as in the command
/// handler. A historical exact request is a replay, never permission to make
/// a fresh DELETE.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NormalStopCreatePreflightV1 {
    Created(NormalStopRecordV1),
    CompletedReplay(NormalStopRecordV1),
}

/// Evidence that a `preflight` record reached a definitive worker/guard veto
/// before any provider DELETE socket write. This deliberately lives outside
/// the four normal Stop phases: ambiguous finalization remains `delete_uncertain`.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NormalStopPreflightAbortV1 {
    schema_version: u8,
    input: NativeGpuNormalStopV1,
    input_sha256: String,
    operation_id: String,
    finalization_id: String,
}

enum RecordReadV1 {
    Missing,
    Torn,
    Valid(NormalStopRecordV1),
}

#[derive(Debug)]
pub(crate) struct NormalStopJournal {
    root: PathBuf,
    io: Mutex<()>,
}

impl NormalStopJournal {
    pub(crate) fn open(root: PathBuf) -> NativeResult<Self> {
        ensure_directory(&root)?;
        ensure_directory(&root.join("history"))?;
        ensure_directory(&root.join("aborted"))?;
        Ok(Self {
            root,
            io: Mutex::new(()),
        })
    }

    /// Open an existing recovery store without creating a directory, journal
    /// generation, or cleanup artifact. The relaunch IPC bridge is intentionally
    /// a pure read: a first launch with no Stop history must leave no native
    /// GPU-control footprint behind.
    pub(crate) fn open_read_only(root: PathBuf) -> NativeResult<Option<Self>> {
        let metadata = match fs::symlink_metadata(&root) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(stop_store_error()),
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(stop_store_error());
        }
        Ok(Some(Self {
            root,
            io: Mutex::new(()),
        }))
    }

    pub(crate) fn lookup(&self, input: &NativeGpuNormalStopV1) -> NativeResult<NormalStopLookupV1> {
        validate_normal_stop_input(input).map_err(|_| stop_store_error())?;
        let _guard = self.io.lock().map_err(|_| stop_store_error())?;
        self.recover_terminal_active_unlocked()?;
        self.recover_aborted_preflight_unlocked()?;
        let input_sha256 = input_sha256(input)?;
        if let Some(record) = self.read_immutable_history(&input.stop_request_id)? {
            return compare_record(input, &input_sha256, record);
        }
        let Some(active) = self.read_record_with_previous(&self.active_path())? else {
            return Ok(NormalStopLookupV1::Missing);
        };
        if active.input.stop_request_id != input.stop_request_id {
            return Ok(NormalStopLookupV1::DifferentRequestActive);
        }
        compare_record(input, &input_sha256, active)
    }

    /// Read-only relaunch bridge for a pending normal Stop. It deliberately
    /// exposes only the strict renderer input already supplied by the caller,
    /// never operation/finalization IDs, provider authority, journal phase, or
    /// worker state. It performs no recovery cleanup or record mutation: a
    /// completed replay stays history-only; `preflight` is not externally
    /// resumable because no worker socket outcome is known yet.
    pub(crate) fn load_recovery_input(&self) -> NativeResult<Option<NativeGpuNormalStopV1>> {
        let _guard = self.io.lock().map_err(|_| stop_store_error())?;
        let Some(active) = self.read_record_with_previous(&self.active_path())? else {
            return Ok(None);
        };
        if let Some(history) = self.read_immutable_history(&active.input.stop_request_id)? {
            if !records_same_operation(&history, &active) {
                return Err(stop_store_error());
            }
            // A completed history written before active cleanup is already
            // terminal evidence. Recovery input would incorrectly let a
            // renderer treat it as a live mutation boundary.
            return Ok(None);
        }
        if let Some(abort) = self.read_preflight_abort(&active.input.stop_request_id)? {
            if active.phase != NormalStopPhaseV1::Preflight
                || active.delete_wire_attempts != 0
                || !abort_matches_record(&abort, &active)
            {
                return Err(stop_store_error());
            }
            return Ok(None);
        }
        match active.phase {
            NormalStopPhaseV1::DeleteIntent | NormalStopPhaseV1::DeleteUncertain => {
                Ok(Some(active.input))
            }
            NormalStopPhaseV1::Preflight | NormalStopPhaseV1::Completed => Ok(None),
        }
    }

    pub(crate) fn load_recovery_input_from_root(
        root: PathBuf,
    ) -> NativeResult<Option<NativeGpuNormalStopV1>> {
        let Some(journal) = Self::open_read_only(root)? else {
            return Ok(None);
        };
        journal.load_recovery_input()
    }

    pub(crate) fn create_preflight(
        &self,
        input: NativeGpuNormalStopV1,
        operation_id: String,
        finalization_id: String,
        preflight_pod: NativeGpuObservedPodV1,
        preflight_observation: NativeGpuPodObservationV1,
    ) -> NativeResult<NormalStopCreatePreflightV1> {
        let record = NormalStopRecordV1 {
            schema_version: SCHEMA_VERSION,
            input_sha256: input_sha256(&input)?,
            input,
            operation_id,
            finalization_id,
            phase: NormalStopPhaseV1::Preflight,
            delete_wire_attempts: 0,
            preflight_pod,
            preflight_observation,
            result: None,
        };
        validate_record(&record)?;
        let _guard = self.io.lock().map_err(|_| stop_store_error())?;
        self.recover_terminal_active_unlocked()?;
        self.recover_aborted_preflight_unlocked()?;
        if let Some(history) = self.read_immutable_history(&record.input.stop_request_id)? {
            return match compare_record(&record.input, &record.input_sha256, history)? {
                NormalStopLookupV1::Exact(record) => {
                    Ok(NormalStopCreatePreflightV1::CompletedReplay(record))
                }
                NormalStopLookupV1::Missing | NormalStopLookupV1::DifferentRequestActive => {
                    Err(stop_store_error())
                }
            };
        }
        if self
            .read_record_with_previous(&self.active_path())?
            .is_some()
        {
            return Err(stop_request_in_progress());
        }
        if let Some(abort) = self.read_preflight_abort(&record.input.stop_request_id)? {
            if abort.input != record.input || abort.input_sha256 != record.input_sha256 {
                return Err(stop_request_conflict());
            }
        }
        self.clear_abort_unlocked(&record.input.stop_request_id)?;
        self.write_active_unlocked(&record)?;
        Ok(NormalStopCreatePreflightV1::Created(record))
    }

    pub(crate) fn mark_delete_intent(
        &self,
        record: &NormalStopRecordV1,
    ) -> NativeResult<NormalStopRecordV1> {
        let _guard = self.io.lock().map_err(|_| stop_store_error())?;
        self.recover_terminal_active_unlocked()?;
        self.recover_aborted_preflight_unlocked()?;
        let mut candidate = self.require_active_exact_unlocked(record)?;
        if candidate.phase != NormalStopPhaseV1::Preflight || candidate.delete_wire_attempts != 0 {
            return Err(stop_store_error());
        }
        candidate.phase = NormalStopPhaseV1::DeleteIntent;
        candidate.delete_wire_attempts = 1;
        validate_record(&candidate)?;
        self.write_active_unlocked(&candidate)?;
        Ok(candidate)
    }

    pub(crate) fn mark_uncertain(
        &self,
        record: &NormalStopRecordV1,
    ) -> NativeResult<NormalStopRecordV1> {
        let _guard = self.io.lock().map_err(|_| stop_store_error())?;
        self.recover_terminal_active_unlocked()?;
        self.recover_aborted_preflight_unlocked()?;
        let mut candidate = self.require_active_exact_unlocked(record)?;
        if !matches!(
            candidate.phase,
            NormalStopPhaseV1::Preflight
                | NormalStopPhaseV1::DeleteIntent
                | NormalStopPhaseV1::DeleteUncertain
        ) {
            return Err(stop_store_error());
        }
        candidate.phase = NormalStopPhaseV1::DeleteUncertain;
        // A worker-finalize loss before the DELETE is still a fail-closed
        // recovery state. It does not claim a wire attempt, and it can never
        // be retried automatically.
        if candidate.delete_wire_attempts > 1 {
            return Err(stop_store_error());
        }
        validate_record(&candidate)?;
        self.write_active_unlocked(&candidate)?;
        Ok(candidate)
    }

    /// Settle a definitive pre-provider worker/guard veto. The abort evidence
    /// is committed before active cleanup so a crash cannot turn an already
    /// known zero-DELETE rejection into a permanently blocking `preflight`.
    /// It is intentionally unavailable after any ambiguous worker finalization
    /// or DELETE intent; those paths must remain `delete_uncertain`.
    pub(crate) fn cancel_preflight(&self, record: &NormalStopRecordV1) -> NativeResult<()> {
        let _guard = self.io.lock().map_err(|_| stop_store_error())?;
        self.recover_terminal_active_unlocked()?;
        self.recover_aborted_preflight_unlocked()?;
        let active = self.require_active_exact_unlocked(record)?;
        if active.phase != NormalStopPhaseV1::Preflight || active.delete_wire_attempts != 0 {
            return Err(stop_store_error());
        }
        let abort = NormalStopPreflightAbortV1 {
            schema_version: PREFLIGHT_ABORT_SCHEMA_VERSION,
            input: active.input.clone(),
            input_sha256: active.input_sha256.clone(),
            operation_id: active.operation_id.clone(),
            finalization_id: active.finalization_id.clone(),
        };
        validate_preflight_abort(&abort)?;
        write_replace_atomic(
            &self.abort_path(&active.input.stop_request_id),
            &abort_bytes(&abort)?,
        )?;
        self.clear_active_unlocked()
    }

    pub(crate) fn complete(
        &self,
        record: &NormalStopRecordV1,
        result: NativeGpuNormalStopResultV1,
    ) -> NativeResult<NormalStopRecordV1> {
        let _guard = self.io.lock().map_err(|_| stop_store_error())?;
        self.recover_terminal_active_unlocked()?;
        self.recover_aborted_preflight_unlocked()?;
        let mut candidate = self.require_active_exact_unlocked(record)?;
        if candidate.phase != NormalStopPhaseV1::DeleteIntent || candidate.delete_wire_attempts != 1
        {
            return Err(stop_store_error());
        }
        candidate.phase = NormalStopPhaseV1::Completed;
        candidate.result = Some(result);
        validate_record(&candidate)?;
        // Write immutable replay evidence before changing/removing the active
        // record. Any crash in the remaining cleanup is therefore safe: exact
        // replay sees the history and never sends a second DELETE.
        self.write_completed_history_unlocked(&candidate)?;
        self.clear_active_unlocked()?;
        Ok(candidate)
    }

    fn require_active_exact_unlocked(
        &self,
        record: &NormalStopRecordV1,
    ) -> NativeResult<NormalStopRecordV1> {
        let active = self
            .read_record_with_previous(&self.active_path())?
            .ok_or_else(stop_store_error)?;
        if active.input_sha256 != record.input_sha256
            || active.operation_id != record.operation_id
            || active.finalization_id != record.finalization_id
        {
            return Err(stop_store_error());
        }
        Ok(active)
    }

    fn active_path(&self) -> PathBuf {
        self.root.join("CURRENT.json")
    }

    fn history_path(&self, stop_request_id: &str) -> PathBuf {
        self.root
            .join("history")
            .join(format!("{}.json", sha256_text(stop_request_id)))
    }

    fn abort_path(&self, stop_request_id: &str) -> PathBuf {
        self.root
            .join("aborted")
            .join(format!("{}.json", sha256_text(stop_request_id)))
    }

    fn previous_path(path: &Path) -> PathBuf {
        let mut value = path.as_os_str().to_os_string();
        value.push(".prev");
        PathBuf::from(value)
    }

    fn read_record_with_previous(&self, path: &Path) -> NativeResult<Option<NormalStopRecordV1>> {
        match read_record(path)? {
            RecordReadV1::Valid(record) => Ok(Some(record)),
            RecordReadV1::Missing => match read_record(&Self::previous_path(path))? {
                RecordReadV1::Valid(record) => Ok(Some(record)),
                RecordReadV1::Missing => Ok(None),
                RecordReadV1::Torn => Err(stop_store_error()),
            },
            // An interrupted replacement can leave only a torn CURRENT. Its
            // last complete `.prev` is an atomic recovery generation; a
            // syntactically valid but semantically impossible CURRENT instead
            // fails closed in `read_record` and never reaches this branch.
            RecordReadV1::Torn => match read_record(&Self::previous_path(path))? {
                RecordReadV1::Valid(record) => Ok(Some(record)),
                RecordReadV1::Missing | RecordReadV1::Torn => Err(stop_store_error()),
            },
        }
    }

    fn write_active_unlocked(&self, record: &NormalStopRecordV1) -> NativeResult<()> {
        let path = self.active_path();
        if path.exists() {
            let previous = Self::previous_path(&path);
            match read_record(&path)? {
                RecordReadV1::Valid(_) => {
                    let bytes = fs::read(&path).map_err(|_| stop_store_error())?;
                    write_replace_atomic(&previous, &bytes)?;
                }
                // CURRENT was interrupted but `.prev` is the verified active
                // generation already used by `require_active_exact_unlocked`.
                // Do not overwrite that recovery copy with torn bytes.
                RecordReadV1::Torn => {}
                RecordReadV1::Missing => {}
            }
        }
        write_replace_atomic(&path, &record_bytes(record)?)
    }

    fn read_immutable_history(
        &self,
        stop_request_id: &str,
    ) -> NativeResult<Option<NormalStopRecordV1>> {
        match read_record(&self.history_path(stop_request_id))? {
            RecordReadV1::Missing => Ok(None),
            RecordReadV1::Valid(record)
                if record.phase == NormalStopPhaseV1::Completed
                    && record.input.stop_request_id == stop_request_id =>
            {
                Ok(Some(record))
            }
            // History is immutable. A torn or non-completed record cannot be
            // made safe by falling back to an older byte sequence.
            RecordReadV1::Torn | RecordReadV1::Valid(_) => Err(stop_store_error()),
        }
    }

    fn write_completed_history_unlocked(&self, candidate: &NormalStopRecordV1) -> NativeResult<()> {
        let path = self.history_path(&candidate.input.stop_request_id);
        match read_record(&path)? {
            RecordReadV1::Missing => write_create_atomic(&path, &record_bytes(candidate)?),
            RecordReadV1::Valid(existing) if records_identical_for_replay(&existing, candidate) => {
                Ok(())
            }
            RecordReadV1::Valid(_) | RecordReadV1::Torn => Err(stop_store_error()),
        }
    }

    fn clear_active_unlocked(&self) -> NativeResult<()> {
        remove_if_exists(&self.active_path())?;
        remove_if_exists(&Self::previous_path(&self.active_path()))?;
        sync_directory(&self.root).map_err(|_| stop_store_error())
    }

    fn clear_abort_unlocked(&self, stop_request_id: &str) -> NativeResult<()> {
        remove_if_exists(&self.abort_path(stop_request_id))?;
        sync_directory(&self.root).map_err(|_| stop_store_error())
    }

    /// Finish cleanup after a power loss between immutable history creation
    /// and mutable CURRENT/.prev removal. Each artifact is removed only when
    /// it is cryptographically/structurally bound to the completed history;
    /// a live new request is never discarded merely because an older prev
    /// exists beside it.
    fn recover_terminal_active_unlocked(&self) -> NativeResult<()> {
        let current_path = self.active_path();
        let previous_path = Self::previous_path(&current_path);
        let current = read_record(&current_path)?;
        let previous = read_record(&previous_path)?;
        let current_valid = match &current {
            RecordReadV1::Valid(record) => Some(record),
            RecordReadV1::Missing | RecordReadV1::Torn => None,
        };
        let previous_valid = match &previous {
            RecordReadV1::Valid(record) => Some(record),
            RecordReadV1::Missing | RecordReadV1::Torn => None,
        };

        let mut remove_current = false;
        let mut remove_previous = false;
        for (record, is_current) in [(current_valid, true), (previous_valid, false)] {
            let Some(record) = record else { continue };
            let Some(history) = self.read_immutable_history(&record.input.stop_request_id)? else {
                continue;
            };
            if !records_same_operation(&history, record) {
                return Err(stop_store_error());
            }
            if is_current {
                remove_current = true;
            } else {
                remove_previous = true;
            }
        }
        // A torn mutable replacement paired with a verified completed prior is
        // precisely the crash seam `.prev` exists to repair.
        if matches!(&current, RecordReadV1::Torn) && remove_previous {
            remove_current = true;
        }
        if matches!(&previous, RecordReadV1::Torn) && remove_current {
            remove_previous = true;
        }
        if remove_current {
            remove_if_exists(&current_path)?;
        }
        if remove_previous {
            remove_if_exists(&previous_path)?;
        }
        if remove_current || remove_previous {
            sync_directory(&self.root).map_err(|_| stop_store_error())?;
        }
        Ok(())
    }

    fn recover_aborted_preflight_unlocked(&self) -> NativeResult<()> {
        let current_path = self.active_path();
        let previous_path = Self::previous_path(&current_path);
        let current = read_record(&current_path)?;
        let previous = read_record(&previous_path)?;
        let current_valid = match &current {
            RecordReadV1::Valid(record) => Some(record),
            RecordReadV1::Missing | RecordReadV1::Torn => None,
        };
        let previous_valid = match &previous {
            RecordReadV1::Valid(record) => Some(record),
            RecordReadV1::Missing | RecordReadV1::Torn => None,
        };
        let mut remove_current = false;
        let mut remove_previous = false;
        for (record, is_current) in [(current_valid, true), (previous_valid, false)] {
            let Some(record) = record else { continue };
            let Some(abort) = self.read_preflight_abort(&record.input.stop_request_id)? else {
                continue;
            };
            if record.phase != NormalStopPhaseV1::Preflight
                || record.delete_wire_attempts != 0
                || !abort_matches_record(&abort, record)
            {
                return Err(stop_store_error());
            }
            if is_current {
                remove_current = true;
            } else {
                remove_previous = true;
            }
        }
        if matches!(&current, RecordReadV1::Torn) && remove_previous {
            remove_current = true;
        }
        if matches!(&previous, RecordReadV1::Torn) && remove_current {
            remove_previous = true;
        }
        if remove_current {
            remove_if_exists(&current_path)?;
        }
        if remove_previous {
            remove_if_exists(&previous_path)?;
        }
        if remove_current || remove_previous {
            sync_directory(&self.root).map_err(|_| stop_store_error())?;
        }
        Ok(())
    }

    fn read_preflight_abort(
        &self,
        stop_request_id: &str,
    ) -> NativeResult<Option<NormalStopPreflightAbortV1>> {
        let path = self.abort_path(stop_request_id);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(stop_store_error()),
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > MAX_RECORD_BYTES
        {
            return Err(stop_store_error());
        }
        let bytes = fs::read(path).map_err(|_| stop_store_error())?;
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| stop_store_error())?;
        let abort = serde_json::from_value(value).map_err(|_| stop_store_error())?;
        validate_preflight_abort(&abort)?;
        Ok(Some(abort))
    }
}

pub(crate) fn default_normal_stop_root() -> PathBuf {
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|path| path.join("Library").join("Application Support"));
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base = Some(std::env::temp_dir());
    base.unwrap_or_else(std::env::temp_dir)
        .join("com.imageforge.desktop")
        .join("gpu-control")
        .join("normal-stop-v1")
}

pub(crate) fn input_sha256(input: &NativeGpuNormalStopV1) -> NativeResult<String> {
    let value = serde_json::to_value(input).map_err(|_| stop_store_error())?;
    let canonical = super::gpu_inventory::jcs_value(&value).map_err(|_| stop_store_error())?;
    Ok(sha256_text(&canonical))
}

fn compare_record(
    input: &NativeGpuNormalStopV1,
    input_sha256: &str,
    record: NormalStopRecordV1,
) -> NativeResult<NormalStopLookupV1> {
    validate_record(&record)?;
    if record.input != *input || record.input_sha256 != input_sha256 {
        return Err(stop_request_conflict());
    }
    Ok(NormalStopLookupV1::Exact(record))
}

fn validate_record(record: &NormalStopRecordV1) -> NativeResult<()> {
    if record.schema_version != SCHEMA_VERSION
        || !canonical_uuid_v4(&record.operation_id)
        || !canonical_uuid_v4(&record.finalization_id)
        || validate_normal_stop_input(&record.input).is_err()
        || record.input.expected_lifecycle_revision > MAX_SAFE_INTEGER - 2
        || !canonical_sha256(&record.input_sha256)
        || input_sha256(&record.input)
            .map(|computed| computed != record.input_sha256)
            .unwrap_or(true)
        || record.delete_wire_attempts > 1
        || (record.phase == NormalStopPhaseV1::Completed) != record.result.is_some()
        || (record.phase != NormalStopPhaseV1::Completed && record.result.is_some())
        || (record.phase == NormalStopPhaseV1::Preflight && record.delete_wire_attempts != 0)
        || (matches!(
            record.phase,
            NormalStopPhaseV1::DeleteIntent | NormalStopPhaseV1::Completed
        ) && record.delete_wire_attempts != 1)
    {
        return Err(stop_store_error());
    }

    let expected_preflight_revision = record
        .input
        .expected_lifecycle_revision
        .checked_add(1)
        .ok_or_else(stop_store_error)?;
    if validate_pod_observation(&record.preflight_observation).is_err()
        || record.preflight_observation.lifecycle_revision != expected_preflight_revision
        || record.preflight_observation.state != "single"
        || record.preflight_observation.stale
        || record.preflight_observation.overflow
        || record.preflight_observation.issue.is_some()
        || record.preflight_observation.pods.as_slice() != &[record.preflight_pod.clone()]
        || record.preflight_pod.pod_id != record.input.pod_id
    {
        return Err(stop_store_error());
    }

    if let Some(result) = &record.result {
        let expected_result_revision = expected_preflight_revision
            .checked_add(1)
            .ok_or_else(stop_store_error)?;
        if validate_normal_stop_result(result, Some(&record.input)).is_err()
            || result.operation_id != record.operation_id
            || result.observation.lifecycle_revision != expected_result_revision
            || result.observation.process_epoch_id != record.preflight_observation.process_epoch_id
            || !matches!(result.disposition.as_str(), "stopped" | "already_stopped")
        {
            return Err(stop_store_error());
        }
    }
    Ok(())
}

fn validate_preflight_abort(abort: &NormalStopPreflightAbortV1) -> NativeResult<()> {
    if abort.schema_version != PREFLIGHT_ABORT_SCHEMA_VERSION
        || validate_normal_stop_input(&abort.input).is_err()
        || abort.input.expected_lifecycle_revision > MAX_SAFE_INTEGER - 2
        || !canonical_sha256(&abort.input_sha256)
        || input_sha256(&abort.input)
            .map(|computed| computed != abort.input_sha256)
            .unwrap_or(true)
        || !canonical_uuid_v4(&abort.operation_id)
        || !canonical_uuid_v4(&abort.finalization_id)
    {
        return Err(stop_store_error());
    }
    Ok(())
}

fn records_same_operation(history: &NormalStopRecordV1, active: &NormalStopRecordV1) -> bool {
    history.phase == NormalStopPhaseV1::Completed
        && history.input == active.input
        && history.input_sha256 == active.input_sha256
        && history.operation_id == active.operation_id
        && history.finalization_id == active.finalization_id
        && history.preflight_pod == active.preflight_pod
        && history.preflight_observation == active.preflight_observation
}

fn records_identical_for_replay(left: &NormalStopRecordV1, right: &NormalStopRecordV1) -> bool {
    left == right && left.phase == NormalStopPhaseV1::Completed
}

fn abort_matches_record(abort: &NormalStopPreflightAbortV1, record: &NormalStopRecordV1) -> bool {
    abort.input == record.input
        && abort.input_sha256 == record.input_sha256
        && abort.operation_id == record.operation_id
        && abort.finalization_id == record.finalization_id
}

fn canonical_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn record_bytes(record: &NormalStopRecordV1) -> NativeResult<Vec<u8>> {
    serde_json::to_vec(record).map_err(|_| stop_store_error())
}

fn abort_bytes(abort: &NormalStopPreflightAbortV1) -> NativeResult<Vec<u8>> {
    serde_json::to_vec(abort).map_err(|_| stop_store_error())
}

fn read_record(path: &Path) -> NativeResult<RecordReadV1> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RecordReadV1::Missing)
        }
        Err(_) => return Err(stop_store_error()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_RECORD_BYTES
    {
        return Err(stop_store_error());
    }
    let bytes = fs::read(path).map_err(|_| stop_store_error())?;
    // Only an incomplete/non-JSON byte sequence is a recoverable torn current
    // generation. A valid JSON value that cannot deserialize or fails semantic
    // validation is authority corruption and must not be hidden by `.prev`.
    let value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => return Ok(RecordReadV1::Torn),
    };
    let record = serde_json::from_value(value).map_err(|_| stop_store_error())?;
    validate_record(&record)?;
    Ok(RecordReadV1::Valid(record))
}

fn ensure_directory(path: &Path) -> NativeResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(stop_store_error())
        }
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(stop_store_error()),
    }
    fs::create_dir_all(path).map_err(|_| stop_store_error())?;
    let metadata = fs::symlink_metadata(path).map_err(|_| stop_store_error())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(stop_store_error());
    }
    if let Some(parent) = path.parent() {
        sync_directory(parent).map_err(|_| stop_store_error())?;
    }
    Ok(())
}

fn write_replace_atomic(path: &Path, bytes: &[u8]) -> NativeResult<()> {
    let parent = path.parent().ok_or_else(stop_store_error)?;
    ensure_directory(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("normal-stop"),
        Uuid::new_v4()
    ));
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        replace_file_atomic(&temporary, path)?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|_| stop_store_error())
}

/// Atomically publish an immutable history entry without replacing a record
/// another process may already have committed. The temporary file is fully
/// fsynced first; linking/moving it into the final name either succeeds once
/// or fails without changing the existing history evidence.
fn write_create_atomic(path: &Path, bytes: &[u8]) -> NativeResult<()> {
    let parent = path.parent().ok_or_else(stop_store_error)?;
    ensure_directory(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("normal-stop-history"),
        Uuid::new_v4()
    ));
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        create_file_atomic(&temporary, path)?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|_| stop_store_error())
}

fn remove_if_exists(path: &Path) -> NativeResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(stop_store_error()),
    }
}

#[cfg(unix)]
fn replace_file_atomic(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(unix)]
fn create_file_atomic(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::hard_link(source, destination)?;
    fs::remove_file(source)
}

#[cfg(windows)]
fn replace_file_atomic(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(source: *const u16, destination: *const u16, flags: u32) -> i32;
    }
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
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
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn create_file_atomic(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(source: *const u16, destination: *const u16, flags: u32) -> i32;
    }
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
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
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(any(unix, windows)))]
fn replace_file_atomic(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(not(any(unix, windows)))]
fn create_file_atomic(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::hard_link(source, destination)?;
    fs::remove_file(source)
}

#[cfg(windows)]
fn sync_directory(_directory: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(not(windows))]
fn sync_directory(directory: &Path) -> std::io::Result<()> {
    File::open(directory)?.sync_all()
}

fn canonical_uuid_v4(value: &str) -> bool {
    Uuid::parse_str(value).ok().is_some_and(|uuid| {
        uuid.get_version() == Some(uuid::Version::Random) && uuid.to_string() == value
    })
}

fn sha256_text(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn stop_request_conflict() -> NativeError {
    NativeError::new(
        "gpu_stop_request_conflict",
        "This GPU Stop request belongs to different immutable inputs. Refresh shared status before continuing.",
    )
}

pub(crate) fn stop_request_in_progress() -> NativeError {
    NativeError::new(
        "stop_request_in_progress",
        "A coordinated GPU Stop request is already in progress.",
    )
}

fn stop_store_error() -> NativeError {
    NativeError::new(
        "gpu_pod_observation_invalid",
        "Native ImageForge GPU Stop recovery state is unavailable.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn input() -> NativeGpuNormalStopV1 {
        NativeGpuNormalStopV1 {
            pod_id: "pod-exact-1".to_owned(),
            stop_request_id: "40000000-0000-4000-8000-000000000000".to_owned(),
            session_id: "30000000-0000-4000-8000-000000000000".to_owned(),
            expected_server_instance_id: "20000000-0000-4000-8000-000000000000".to_owned(),
            expected_coordination_revision: 7,
            expected_lifecycle_revision: 10,
        }
    }

    fn observation() -> NativeGpuPodObservationV1 {
        NativeGpuPodObservationV1 {
            schema_version: 1,
            process_epoch_id: "50000000-0000-4000-8000-000000000000".to_owned(),
            lifecycle_revision: 11,
            state: "single".to_owned(),
            observed_at: Some("2026-08-04T00:00:00.000Z".to_owned()),
            stale: false,
            pods: vec![pod()],
            overflow: false,
            issue: None,
        }
    }

    fn pod() -> NativeGpuObservedPodV1 {
        NativeGpuObservedPodV1 {
            pod_id: "pod-exact-1".to_owned(),
            gpu_id: "NVIDIA GeForce RTX 4090".to_owned(),
            gpu_display_name: "NVIDIA GeForce RTX 4090".to_owned(),
            hourly_price_micro_usd: Some(540_000),
            status: "running".to_owned(),
        }
    }

    fn result(disposition: &str) -> NativeGpuNormalStopResultV1 {
        NativeGpuNormalStopResultV1 {
            schema_version: 1,
            operation_id: "60000000-0000-4000-8000-000000000000".to_owned(),
            pod_id: "pod-exact-1".to_owned(),
            disposition: disposition.to_owned(),
            observation: NativeGpuPodObservationV1 {
                schema_version: 1,
                process_epoch_id: "50000000-0000-4000-8000-000000000000".to_owned(),
                lifecycle_revision: 12,
                state: "offline".to_owned(),
                observed_at: Some("2026-08-04T00:00:01.000Z".to_owned()),
                stale: false,
                pods: Vec::new(),
                overflow: false,
                issue: None,
            },
            issue: None,
        }
    }

    fn create(journal: &NormalStopJournal, input: NativeGpuNormalStopV1) -> NormalStopRecordV1 {
        match journal
            .create_preflight(
                input,
                "60000000-0000-4000-8000-000000000000".to_owned(),
                "70000000-0000-4000-8000-000000000000".to_owned(),
                pod(),
                observation(),
            )
            .unwrap()
        {
            NormalStopCreatePreflightV1::Created(record) => record,
            NormalStopCreatePreflightV1::CompletedReplay(_) => panic!("expected a new preflight"),
        }
    }

    fn different_input() -> NativeGpuNormalStopV1 {
        let mut value = input();
        value.stop_request_id = "41000000-0000-4000-8000-000000000000".to_owned();
        value
    }

    #[test]
    fn input_hash_is_stable_and_same_request_with_other_immutable_input_conflicts() {
        let directory = tempfile::tempdir().unwrap();
        let journal = NormalStopJournal::open(directory.path().join("normal-stop")).unwrap();
        let first = create(&journal, input());
        assert!(matches!(
            journal.lookup(&input()).unwrap(),
            NormalStopLookupV1::Exact(_)
        ));
        let mut changed = input();
        changed.expected_coordination_revision += 1;
        assert_eq!(
            journal.lookup(&changed).unwrap_err().code,
            "gpu_stop_request_conflict"
        );
        assert_eq!(first.delete_wire_attempts, 0);
    }

    #[test]
    fn semantically_invalid_current_never_falls_back_to_a_valid_previous_generation() {
        let directory = tempfile::tempdir().unwrap();
        let journal = NormalStopJournal::open(directory.path().join("normal-stop")).unwrap();
        let record = create(&journal, input());
        let current = journal.active_path();
        let previous = NormalStopJournal::previous_path(&current);
        let good = fs::read(&current).unwrap();
        fs::write(&previous, &good).unwrap();

        let mut crafted = serde_json::to_value(&record).unwrap();
        crafted["inputSha256"] = serde_json::Value::String("a".repeat(64));
        fs::write(&current, serde_json::to_vec(&crafted).unwrap()).unwrap();

        assert_eq!(
            journal.lookup(&input()).unwrap_err().code,
            "gpu_pod_observation_invalid"
        );
    }

    #[test]
    fn a_torn_current_recovers_only_from_the_last_complete_previous_generation() {
        let directory = tempfile::tempdir().unwrap();
        let journal = NormalStopJournal::open(directory.path().join("normal-stop")).unwrap();
        let record = create(&journal, input());
        let current = journal.active_path();
        let previous = NormalStopJournal::previous_path(&current);
        fs::write(&previous, fs::read(&current).unwrap()).unwrap();
        fs::write(&current, b"{\"").unwrap();

        match journal.lookup(&input()).unwrap() {
            NormalStopLookupV1::Exact(restored) => assert_eq!(restored, record),
            _ => panic!("expected previous generation recovery"),
        }
    }

    #[test]
    fn completed_history_replays_byte_identically_and_never_recreates_the_delete_authority() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("normal-stop");
        let journal = NormalStopJournal::open(root.clone()).unwrap();
        let intent = journal
            .mark_delete_intent(&create(&journal, input()))
            .unwrap();
        let completed = journal.complete(&intent, result("stopped")).unwrap();
        let original_bytes = serde_json::to_vec(&completed.result).unwrap();

        drop(journal);
        let reopened = NormalStopJournal::open(root).unwrap();
        match reopened.lookup(&input()).unwrap() {
            NormalStopLookupV1::Exact(replay) => {
                assert_eq!(replay, completed);
                assert_eq!(serde_json::to_vec(&replay.result).unwrap(), original_bytes);
            }
            _ => panic!("expected completed replay"),
        }
        match reopened
            .create_preflight(
                input(),
                "60000000-0000-4000-8000-000000000000".to_owned(),
                "70000000-0000-4000-8000-000000000000".to_owned(),
                pod(),
                observation(),
            )
            .unwrap()
        {
            NormalStopCreatePreflightV1::CompletedReplay(replay) => assert_eq!(replay, completed),
            NormalStopCreatePreflightV1::Created(_) => {
                panic!("completed history must never recreate")
            }
        }
        let mut reused = input();
        reused.expected_coordination_revision += 1;
        assert_eq!(
            reopened
                .create_preflight(
                    reused,
                    "60000000-0000-4000-8000-000000000000".to_owned(),
                    "70000000-0000-4000-8000-000000000000".to_owned(),
                    pod(),
                    observation(),
                )
                .unwrap_err()
                .code,
            "gpu_stop_request_conflict"
        );
    }

    #[test]
    fn crafted_history_cannot_substitute_other_immutable_inputs_under_the_same_request_uuid() {
        let directory = tempfile::tempdir().unwrap();
        let journal = NormalStopJournal::open(directory.path().join("normal-stop")).unwrap();
        let intent = journal
            .mark_delete_intent(&create(&journal, input()))
            .unwrap();
        journal.complete(&intent, result("stopped")).unwrap();

        let history_path = journal.history_path(&input().stop_request_id);
        let mut crafted: NormalStopRecordV1 =
            serde_json::from_slice(&fs::read(&history_path).unwrap()).unwrap();
        crafted.input.expected_coordination_revision += 1;
        crafted.input_sha256 = input_sha256(&crafted.input).unwrap();
        // This remains internally self-consistent; only a full immutable
        // input comparison with the caller exposes the forged substitution.
        validate_record(&crafted).unwrap();
        fs::write(&history_path, record_bytes(&crafted).unwrap()).unwrap();

        assert_eq!(
            journal.lookup(&input()).unwrap_err().code,
            "gpu_stop_request_conflict"
        );
    }

    #[test]
    fn completed_history_cannot_cross_the_preflight_process_epoch() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("normal-stop");
        let journal = NormalStopJournal::open(root.clone()).unwrap();
        let intent = journal
            .mark_delete_intent(&create(&journal, input()))
            .unwrap();
        journal.complete(&intent, result("stopped")).unwrap();

        let history_path = journal.history_path(&input().stop_request_id);
        let mut crafted: NormalStopRecordV1 =
            serde_json::from_slice(&fs::read(&history_path).unwrap()).unwrap();
        crafted
            .result
            .as_mut()
            .unwrap()
            .observation
            .process_epoch_id = "80000000-0000-4000-8000-000000000000".to_owned();
        assert_eq!(
            validate_record(&crafted).unwrap_err().code,
            "gpu_pod_observation_invalid"
        );
        fs::write(&history_path, record_bytes(&crafted).unwrap()).unwrap();
        drop(journal);

        let reopened = NormalStopJournal::open(root).unwrap();
        assert_eq!(
            reopened.lookup(&input()).unwrap_err().code,
            "gpu_pod_observation_invalid"
        );
    }

    #[test]
    fn history_written_before_active_cleanup_is_recovered_and_a_new_request_is_admissible() {
        let directory = tempfile::tempdir().unwrap();
        let journal = NormalStopJournal::open(directory.path().join("normal-stop")).unwrap();
        let intent = journal
            .mark_delete_intent(&create(&journal, input()))
            .unwrap();
        let mut completed = intent.clone();
        completed.phase = NormalStopPhaseV1::Completed;
        completed.result = Some(result("stopped"));
        validate_record(&completed).unwrap();
        write_create_atomic(
            &journal.history_path(&input().stop_request_id),
            &record_bytes(&completed).unwrap(),
        )
        .unwrap();

        assert!(matches!(
            journal.lookup(&input()).unwrap(),
            NormalStopLookupV1::Exact(_)
        ));
        assert!(matches!(
            journal.lookup(&different_input()).unwrap(),
            NormalStopLookupV1::Missing
        ));
        let next = create(&journal, different_input());
        assert_eq!(
            next.input.stop_request_id,
            different_input().stop_request_id
        );
    }

    #[test]
    fn definitive_preflight_cancellation_clears_the_active_request_but_ambiguity_does_not() {
        let directory = tempfile::tempdir().unwrap();
        let journal = NormalStopJournal::open(directory.path().join("normal-stop")).unwrap();
        let record = create(&journal, input());
        journal.cancel_preflight(&record).unwrap();
        assert!(matches!(
            journal.lookup(&different_input()).unwrap(),
            NormalStopLookupV1::Missing
        ));
        let second = create(&journal, different_input());
        assert_eq!(
            second.input.stop_request_id,
            different_input().stop_request_id
        );
        journal.cancel_preflight(&second).unwrap();

        let uncertain = journal.mark_uncertain(&create(&journal, input())).unwrap();
        assert_eq!(uncertain.phase, NormalStopPhaseV1::DeleteUncertain);
        assert_eq!(
            journal.cancel_preflight(&uncertain).unwrap_err().code,
            "gpu_pod_observation_invalid"
        );
    }

    #[test]
    fn abort_evidence_written_before_cleanup_recovers_without_blocking_a_later_fresh_request() {
        let directory = tempfile::tempdir().unwrap();
        let journal = NormalStopJournal::open(directory.path().join("normal-stop")).unwrap();
        let record = create(&journal, input());
        let abort = NormalStopPreflightAbortV1 {
            schema_version: PREFLIGHT_ABORT_SCHEMA_VERSION,
            input: record.input.clone(),
            input_sha256: record.input_sha256.clone(),
            operation_id: record.operation_id.clone(),
            finalization_id: record.finalization_id.clone(),
        };
        write_replace_atomic(
            &journal.abort_path(&record.input.stop_request_id),
            &abort_bytes(&abort).unwrap(),
        )
        .unwrap();

        assert!(matches!(
            journal.lookup(&different_input()).unwrap(),
            NormalStopLookupV1::Missing
        ));
        assert_eq!(
            create(&journal, different_input()).input.stop_request_id,
            different_input().stop_request_id
        );
    }

    #[test]
    fn recovery_load_exposes_only_an_active_delete_intent_or_uncertain_input() {
        let directory = tempfile::tempdir().unwrap();
        let journal = NormalStopJournal::open(directory.path().join("normal-stop")).unwrap();
        let preflight = create(&journal, input());
        assert_eq!(journal.load_recovery_input().unwrap(), None);
        let intent = journal.mark_delete_intent(&preflight).unwrap();
        let intent_bytes = fs::read(journal.active_path()).unwrap();
        assert_eq!(journal.load_recovery_input().unwrap(), Some(input()));
        assert_eq!(fs::read(journal.active_path()).unwrap(), intent_bytes);
        let uncertain = journal.mark_uncertain(&intent).unwrap();
        assert_eq!(uncertain.phase, NormalStopPhaseV1::DeleteUncertain);
        let uncertain_bytes = fs::read(journal.active_path()).unwrap();
        assert_eq!(journal.load_recovery_input().unwrap(), Some(input()));
        assert_eq!(fs::read(journal.active_path()).unwrap(), uncertain_bytes);
    }

    #[test]
    fn recovery_load_at_a_missing_root_is_pure_and_creates_no_store() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("absent-normal-stop");
        assert_eq!(
            NormalStopJournal::load_recovery_input_from_root(root.clone()).unwrap(),
            None
        );
        assert!(!root.exists());
    }

    #[test]
    fn recovery_load_does_not_cleanup_a_completed_history_crash_seam() {
        let directory = tempfile::tempdir().unwrap();
        let journal = NormalStopJournal::open(directory.path().join("normal-stop")).unwrap();
        let intent = journal
            .mark_delete_intent(&create(&journal, input()))
            .unwrap();
        let mut completed = intent.clone();
        completed.phase = NormalStopPhaseV1::Completed;
        completed.result = Some(result("stopped"));
        validate_record(&completed).unwrap();
        write_create_atomic(
            &journal.history_path(&input().stop_request_id),
            &record_bytes(&completed).unwrap(),
        )
        .unwrap();
        let active_path = journal.active_path();
        let active_bytes = fs::read(&active_path).unwrap();

        assert_eq!(journal.load_recovery_input().unwrap(), None);
        assert_eq!(fs::read(active_path).unwrap(), active_bytes);
    }

    #[test]
    fn reopened_delete_intent_promotes_to_durable_uncertainty_without_a_second_wire_attempt() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("normal-stop");
        let journal = NormalStopJournal::open(root.clone()).unwrap();
        let intent = journal
            .mark_delete_intent(&create(&journal, input()))
            .unwrap();
        assert_eq!(intent.delete_wire_attempts, 1);
        let operation_id = intent.operation_id.clone();
        drop(journal);

        // The relaunch branch has no Finalize or DELETE authority. Its first
        // durable operation is only the no-retry phase promotion; a later
        // caller can make at most the read-only reconciliation observation.
        let reopened = NormalStopJournal::open(root.clone()).unwrap();
        let recovered = match reopened.lookup(&input()).unwrap() {
            NormalStopLookupV1::Exact(record) => record,
            _ => panic!("expected the durable delete intent"),
        };
        assert_eq!(recovered.phase, NormalStopPhaseV1::DeleteIntent);
        let uncertain = reopened.mark_uncertain(&recovered).unwrap();
        assert_eq!(uncertain.phase, NormalStopPhaseV1::DeleteUncertain);
        assert_eq!(uncertain.delete_wire_attempts, 1);
        assert_eq!(uncertain.operation_id, operation_id);
        drop(reopened);

        let restarted = NormalStopJournal::open(root).unwrap();
        match restarted.lookup(&input()).unwrap() {
            NormalStopLookupV1::Exact(record) => {
                assert_eq!(record.phase, NormalStopPhaseV1::DeleteUncertain);
                assert_eq!(record.delete_wire_attempts, 1);
                assert_eq!(record.operation_id, operation_id);
            }
            _ => panic!("expected durable uncertainty after relaunch"),
        }
        assert_eq!(restarted.load_recovery_input().unwrap(), Some(input()));
    }

    #[test]
    fn crafted_preflight_and_completed_result_relations_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let journal = NormalStopJournal::open(directory.path().join("normal-stop")).unwrap();
        let record = create(&journal, input());
        let mut crafted = record.clone();
        crafted.preflight_observation.lifecycle_revision += 1;
        assert_eq!(
            validate_record(&crafted).unwrap_err().code,
            "gpu_pod_observation_invalid"
        );
        journal.cancel_preflight(&record).unwrap();

        let intent = journal
            .mark_delete_intent(&create(&journal, different_input()))
            .unwrap();
        let mut impossible = result("stopped");
        impossible.observation.lifecycle_revision = 13;
        assert_eq!(
            journal.complete(&intent, impossible).unwrap_err().code,
            "gpu_pod_observation_invalid"
        );
    }

    #[test]
    fn max_minus_one_stop_input_is_rejected_before_any_journal_file_is_written() {
        let directory = tempfile::tempdir().unwrap();
        let journal = NormalStopJournal::open(directory.path().join("normal-stop")).unwrap();
        let mut exhausted = input();
        exhausted.expected_lifecycle_revision = MAX_SAFE_INTEGER - 1;
        assert_eq!(
            journal
                .create_preflight(
                    exhausted,
                    "60000000-0000-4000-8000-000000000000".to_owned(),
                    "70000000-0000-4000-8000-000000000000".to_owned(),
                    pod(),
                    observation(),
                )
                .unwrap_err()
                .code,
            "gpu_pod_observation_invalid"
        );
        assert!(!journal.active_path().exists());
    }
}
