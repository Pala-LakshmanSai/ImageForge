use super::destination::QueueDestinationBinding;
use super::file_lock::NativeFileLock;
use super::power::{NativePowerState, PowerController};
use super::{DestinationStore, NativeError, NativeResult};
use image::{guess_format, load_from_memory_with_format, ImageFormat};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::{Uuid, Version};

const SCHEMA_VERSION: u8 = 1;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_CURRENT_BYTES: u64 = 32;
const MAX_GENERATION_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ITEM_RECORD_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ALERT_BYTES: u64 = 8 * 1024;
const MAX_BATCH_REFERENCES: usize = 8;
const MAX_REFERENCE_BYTES: usize = 8 * 1024 * 1024;
const MAX_REFERENCE_TOTAL_BYTES: usize = 32 * 1024 * 1024;
const MAX_REFERENCE_PIXELS: u64 = 64_000_000;
const MAX_FILE_NAME_BYTES: usize = 255;
const MAX_NAME_BYTES: usize = 120;
const MAX_ATTENTION_CODE_BYTES: usize = 80;
const RETAIN_GENERATIONS: usize = 3;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QueueItemState {
    Staged,
    Dispatching,
    Active,
    Saving,
    Completed,
    CompletedWithFailures,
    NeedsAttention,
    Interrupted,
    Cancelled,
    Historical,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QueueRunnerState {
    Idle,
    Running,
    PauseAfterCurrent,
    Paused,
    NeedsAttention,
    Completed,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QueueAlarmState {
    Disarmed,
    Armed,
    Ringing,
    Snoozed,
    Acknowledged,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QueueAlertKind {
    Complete,
    Attention,
    Snooze,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NotificationDisposition {
    Pending,
    Delivered,
    PermissionDenied,
    Failed,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeQueueIssue {
    pub code: String,
    pub queue_item_id: Option<String>,
    pub retryable: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeQueueReferenceV1 {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeQueueItemV1 {
    pub schema_version: u8,
    pub queue_item_id: String,
    pub client_submission_id: String,
    pub record_revision: u64,
    pub run_revision: Option<String>,
    pub remote_batch_id: Option<String>,
    pub state: QueueItemState,
    pub attention_code: Option<String>,
    pub name: String,
    pub prompts: Vec<String>,
    pub base_seed: u64,
    pub destination: String,
    pub aspect_ratio: String,
    pub style_suffix: Option<String>,
    pub references: Vec<NativeQueueReferenceV1>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeQueueItemPlaceholderV1 {
    pub schema_version: u8,
    pub queue_item_id: String,
    pub record_revision: u64,
    pub state: QueueItemState,
    pub attention_code: String,
    pub name: String,
    pub prompt_count: u64,
    pub reference_count: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum NativeQueueRowV1 {
    Item(NativeQueueItemV1),
    Placeholder(NativeQueueItemPlaceholderV1),
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeQueueRunV1 {
    pub run_revision: String,
    pub cohort_item_ids: Vec<String>,
    pub runner_state: QueueRunnerState,
    pub authorization_required: bool,
    pub keep_awake: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeQueueAlarmV1 {
    pub event_id: String,
    pub run_revision: String,
    pub state: QueueAlarmState,
    pub kind: Option<QueueAlertKind>,
    pub snooze_used: bool,
    pub snooze_due_at: Option<String>,
    pub notification_disposition: Option<NotificationDisposition>,
    pub snooze_notification_disposition: Option<NotificationDisposition>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeQueueDocumentV1 {
    pub schema_version: u8,
    pub items: Vec<NativeQueueRowV1>,
    pub run: Option<NativeQueueRunV1>,
    pub alarm: Option<NativeQueueAlarmV1>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeQueueSnapshotV1 {
    pub schema_version: u8,
    pub store_revision: u64,
    pub document: NativeQueueDocumentV1,
    pub issues: Vec<NativeQueueIssue>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeReferenceBlobV1 {
    pub sha256: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeQueueCommitV1 {
    pub expected_revision: u64,
    pub document: NativeQueueDocumentV1,
    pub reference_blobs: Vec<NativeReferenceBlobV1>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QueueItemPayloadPurpose {
    Dispatch,
    Edit,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeQueueItemKey {
    pub queue_item_id: String,
    pub client_submission_id: String,
    pub purpose: QueueItemPayloadPurpose,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeQueueDispatchReferenceV1 {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeQueueDispatchPayloadV1 {
    pub queue_item_id: String,
    pub client_submission_id: String,
    pub name: String,
    pub prompts: Vec<String>,
    pub base_seed: u64,
    pub destination: String,
    pub aspect_ratio: String,
    pub references: Vec<NativeQueueDispatchReferenceV1>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRunKey {
    pub run_revision: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeRunnerLease {
    pub run_revision: String,
    pub held: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativePowerInput {
    pub run_revision: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeAlertInput {
    pub event_id: String,
    pub kind: QueueAlertKind,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeQueueResetInput {
    pub confirmation: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAlertResult {
    pub event_id: String,
    pub notification_id: i32,
    pub disposition: AlertResultDisposition,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AlertResultDisposition {
    Delivered,
    AlreadyDelivered,
    PermissionDenied,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlertDeliveryDisposition {
    Delivered,
    PermissionDenied,
    Failed,
}

#[derive(Debug, Clone, Copy)]
pub struct AlertCopy {
    pub notification_id: i32,
    pub title: &'static str,
    pub body: &'static str,
}

#[derive(Clone)]
pub struct QueueStore {
    root: Arc<PathBuf>,
    destination: DestinationStore,
    mutation_lock: Arc<Mutex<()>>,
    runner: Arc<Mutex<Option<RunnerLease>>>,
    power: PowerController,
}

struct RunnerLease {
    run_revision: Uuid,
    // The lock is held solely by ownership; dropping the lease releases it.
    _file_lock: RunnerFileLock,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiskGenerationV1 {
    schema_version: u8,
    store_revision: u64,
    items: Vec<DiskItemIndexV1>,
    run: Option<NativeQueueRunV1>,
    alarm: Option<NativeQueueAlarmV1>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiskItemIndexV1 {
    queue_item_id: String,
    record_revision: u64,
    content_hash: String,
    name: String,
    prompt_count: u64,
    reference_count: u64,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiskItemRecordV1 {
    schema_version: u8,
    item: NativeQueueItemV1,
    destination_binding: QueueDestinationBinding,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AlertOutboxV1 {
    schema_version: u8,
    event_id: String,
    primary_kind: Option<QueueAlertKind>,
    primary: Option<NotificationDisposition>,
    snooze: Option<NotificationDisposition>,
    /// This private marker keeps the repair visible across subsequent loads
    /// without trusting a renderer projection.  It is cleared only after an
    /// explicit successful native delivery attempt.
    #[serde(default)]
    recovered_after_corruption: bool,
}

#[derive(Debug)]
struct LoadedQueue {
    snapshot: NativeQueueSnapshotV1,
    generation: Option<DiskGenerationV1>,
    records: HashMap<Uuid, DiskItemRecordV1>,
    pointers: HashMap<Uuid, DiskItemIndexV1>,
    /// Rows projected to needs_attention solely because immutable reference
    /// bytes are missing/mismatched. Their on-disk record remains the prior
    /// immutable revision until an explicit repair creates a new revision.
    reference_issue_ids: HashSet<Uuid>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IntegrityIssue {
    MissingReference,
    MismatchedReference,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QueueCommitScope {
    AnyValidTransition,
    NextRunOnly,
}

impl IntegrityIssue {
    fn code(self) -> &'static str {
        match self {
            Self::MissingReference => "queue_reference_missing",
            Self::MismatchedReference => "queue_reference_mismatch",
        }
    }
}

impl QueueStore {
    pub fn new(destination: DestinationStore) -> NativeResult<Self> {
        let root = default_queue_root()?;
        Self::with_root(root, destination)
    }

    fn with_root(root: PathBuf, destination: DestinationStore) -> NativeResult<Self> {
        let store = Self {
            root: Arc::new(root),
            destination,
            mutation_lock: Arc::new(Mutex::new(())),
            runner: Arc::new(Mutex::new(None)),
            power: PowerController::new(),
        };
        store.ensure_layout()?;
        Ok(store)
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(root: PathBuf, destination: DestinationStore) -> Self {
        Self::with_root(root, destination).expect("test queue root should initialize")
    }

    #[cfg(test)]
    pub(crate) fn holds_runner_for_test(&self, run_revision: &str) -> bool {
        parse_uuid(run_revision, "queue_run_id_invalid")
            .and_then(|run_revision| self.holds_runner(run_revision))
            .expect("valid test runner identity")
    }

    #[cfg(test)]
    pub(crate) fn power_active_for_test(&self) -> bool {
        self.power.active_for_test()
    }

    pub fn load(&self) -> NativeResult<NativeQueueSnapshotV1> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| queue_store_unavailable())?;
        let _disk_mutation = self.acquire_cross_process_mutation_lock()?;
        self.pause_unleased_run_unlocked()?;
        Ok(self.load_unlocked()?.snapshot)
    }

    /// Classify a renderer commit before the command decides whether it must
    /// enter `profile-control.lock`. A coordinated GPU Switch deliberately
    /// leaves `runRevision: null` Next-run rows editable, but every current-run,
    /// alarm, cohort, or current-row mutation remains profile scoped.
    ///
    /// The exact expected revision is checked under the queue's cross-process
    /// mutation lock. The later `commit` repeats that comparison, so a sibling
    /// write between classification and commit becomes an ordinary revision
    /// conflict rather than changing the classification under our feet.
    pub(crate) fn commit_touches_profile_state(
        &self,
        input: &NativeQueueCommitV1,
    ) -> NativeResult<bool> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| queue_store_unavailable())?;
        let _disk_mutation = self.acquire_cross_process_mutation_lock()?;
        let loaded = self.load_unlocked_without_pause()?;
        if input.expected_revision != loaded.snapshot.store_revision {
            return Err(NativeError::new(
                "queue_revision_conflict",
                "The local queue changed in another ImageForge window. Reload it before saving.",
            ));
        }

        if commit_mutates_current_run(&loaded, &input.document) {
            return Ok(true);
        }

        Ok(false)
    }

    /// Validate the exact Task 013 queue generation that a coordinated GPU
    /// Switch intends to park. The caller owns `profile-control.lock`; this
    /// queue-local lock closes the remaining compare/read seam against normal
    /// queue commits and runner acquisition.
    ///
    /// This preflight is deliberately read-only. `gpu_switch_begin` writes its
    /// durable `prepared` reservation before calling `park_for_gpu_switch`, so
    /// a crash can never release a runner into an unreserved profile.
    pub(crate) fn preflight_gpu_switch_park(
        &self,
        expected_store_revision: u64,
        queue_run_revision: Option<&str>,
    ) -> NativeResult<()> {
        let _mutation = self
            .mutation_lock
            .lock()
            .map_err(|_| queue_store_unavailable())?;
        let _disk_mutation = self.acquire_cross_process_mutation_lock()?;
        let loaded = self.load_unlocked_without_pause()?;
        self.validate_gpu_switch_park_target(&loaded, expected_store_revision, queue_run_revision)?;
        Ok(())
    }

    /// Durably park the exact current queue after the Switch reservation is
    /// already `prepared`, then release this process's matching runner lease
    /// and no-idle-sleep assertion. The returned revision is the exact Task
    /// 013 revision that the Switch `active` reservation must bind.
    pub(crate) fn park_for_gpu_switch(
        &self,
        expected_store_revision: u64,
        queue_run_revision: Option<&str>,
    ) -> NativeResult<u64> {
        let _mutation = self
            .mutation_lock
            .lock()
            .map_err(|_| queue_store_unavailable())?;
        let _disk_mutation = self.acquire_cross_process_mutation_lock()?;
        let loaded = self.load_unlocked_without_pause()?;
        let run_revision = self.validate_gpu_switch_park_target(
            &loaded,
            expected_store_revision,
            queue_run_revision,
        )?;

        let Some(run_revision) = run_revision else {
            return Ok(loaded.snapshot.store_revision);
        };
        let current_run = loaded
            .snapshot
            .document
            .run
            .as_ref()
            .ok_or_else(gpu_switch_queue_reservation_conflict)?;

        let committed_revision = if matches!(
            current_run.runner_state,
            QueueRunnerState::Paused | QueueRunnerState::Completed
        ) {
            loaded.snapshot.store_revision
        } else {
            let mut generation = loaded
                .generation
                .clone()
                .ok_or_else(gpu_switch_queue_reservation_conflict)?;
            let mut candidate_document = loaded.snapshot.document.clone();
            let candidate_run = candidate_document
                .run
                .as_mut()
                .ok_or_else(gpu_switch_queue_reservation_conflict)?;
            candidate_run.runner_state = QueueRunnerState::Paused;
            candidate_run.authorization_required = true;
            validate_document(&candidate_document)?;
            validate_runner_transition(loaded.snapshot.document.run.as_ref(), &candidate_document)?;
            generation.store_revision = generation
                .store_revision
                .checked_add(1)
                .filter(|value| *value <= MAX_SAFE_INTEGER)
                .ok_or_else(gpu_switch_queue_reservation_conflict)?;
            generation.run = candidate_document.run;
            generation.alarm = candidate_document.alarm;
            self.write_generation(&generation)?;
            self.write_current(generation.store_revision)?;
            self.cleanup_old_generations(generation.store_revision);
            generation.store_revision
        };

        // The durable Paused generation precedes both local lease cleanup and
        // native Switch `planned`. A process crash here releases the OS/file
        // lease and platform power assertion while `prepared` remains a
        // blocker; an in-process continuation drops them explicitly now.
        let mut runner = self.runner.lock().map_err(|_| queue_store_unavailable())?;
        if runner
            .as_ref()
            .is_some_and(|lease| lease.run_revision != run_revision)
        {
            return Err(gpu_switch_queue_reservation_conflict());
        }
        self.power.release_for_run(run_revision);
        *runner = None;
        Ok(committed_revision)
    }

    pub fn commit(&self, input: NativeQueueCommitV1) -> NativeResult<NativeQueueSnapshotV1> {
        self.commit_with_scope(input, QueueCommitScope::AnyValidTransition)
    }

    /// Commit only a `runRevision: null` staging/edit delta. This path is used
    /// while a coordinated Switch reservation owns the profile: it repeats the
    /// exact classifier under the queue mutation lock and deliberately does not
    /// run the unrelated unleased-run repair, which would otherwise turn a
    /// harmless staged-row edit into an implicit current-run mutation.
    pub(crate) fn commit_next_run_only(
        &self,
        input: NativeQueueCommitV1,
    ) -> NativeResult<NativeQueueSnapshotV1> {
        self.commit_with_scope(input, QueueCommitScope::NextRunOnly)
    }

    fn commit_with_scope(
        &self,
        input: NativeQueueCommitV1,
        scope: QueueCommitScope,
    ) -> NativeResult<NativeQueueSnapshotV1> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| queue_store_unavailable())?;
        let _disk_mutation = self.acquire_cross_process_mutation_lock()?;
        if scope == QueueCommitScope::AnyValidTransition {
            self.pause_unleased_run_unlocked()?;
        }
        let loaded = self.load_unlocked()?;
        if input.expected_revision != loaded.snapshot.store_revision {
            return Err(NativeError::new(
                "queue_revision_conflict",
                "The local queue changed in another ImageForge window. Reload it before saving.",
            ));
        }
        if scope == QueueCommitScope::NextRunOnly
            && commit_mutates_current_run(&loaded, &input.document)
        {
            return Err(queue_commit_invalid());
        }

        validate_document(&input.document)?;
        self.validate_alarm_outbox_authority(&input.document)?;
        self.require_runner_for_commit(&loaded, &input.document)?;
        let effective_previous = effective_generation_for_transition(&loaded);
        validate_run_replacement(effective_previous.as_ref(), &input.document)?;
        validate_new_run_admission(
            effective_previous
                .as_ref()
                .and_then(|generation| generation.run.as_ref()),
            &input.document,
        )?;
        validate_runner_transition(
            effective_previous
                .as_ref()
                .and_then(|generation| generation.run.as_ref()),
            &input.document,
        )?;
        validate_alarm_transition(effective_previous.as_ref(), &input.document)?;
        self.validate_dispatch_admission(&loaded, &input.document)?;
        let plan = self.plan_commit(&loaded, &input.document)?;
        self.write_reference_blobs(&input.reference_blobs, &plan.required_references)?;
        self.verify_planned_references(&plan.records, &plan.deferred_reference_item_ids)?;
        self.write_item_records(&plan.records, &loaded.records)?;

        let next_revision = loaded
            .snapshot
            .store_revision
            .checked_add(1)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(queue_store_unavailable)?;
        let generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: next_revision,
            items: plan.indices,
            run: input.document.run.clone(),
            alarm: input.document.alarm.clone(),
        };
        self.write_generation(&generation)?;
        self.write_current(next_revision)?;
        self.cleanup_old_generations(next_revision);
        // This is intentionally post-CURRENT only. A crash before the
        // pointer switches may leave immutable records/blobs behind, but it
        // must never reclaim data that the last durable generation still
        // references. Startup recovery is read/repair-only and never runs
        // this collector.
        self.garbage_collect_unreachable(next_revision);
        Ok(self.load_unlocked()?.snapshot)
    }

    fn validate_gpu_switch_park_target(
        &self,
        loaded: &LoadedQueue,
        expected_store_revision: u64,
        queue_run_revision: Option<&str>,
    ) -> NativeResult<Option<Uuid>> {
        if expected_store_revision > MAX_SAFE_INTEGER
            || loaded.snapshot.store_revision != expected_store_revision
            || !loaded.snapshot.issues.is_empty()
        {
            return Err(gpu_switch_queue_reservation_conflict());
        }
        let requested_run = queue_run_revision
            .map(|value| parse_uuid(value, "queue_run_id_invalid"))
            .transpose()
            .map_err(|_| gpu_switch_queue_reservation_conflict())?;
        let Some(current_run) = loaded.snapshot.document.run.as_ref() else {
            if requested_run.is_some()
                || self
                    .runner
                    .lock()
                    .map_err(|_| queue_store_unavailable())?
                    .is_some()
            {
                return Err(gpu_switch_queue_reservation_conflict());
            }
            let Some(probe) = RunnerFileLock::try_acquire(&self.root.join("runner.lock"))? else {
                return Err(gpu_switch_queue_reservation_conflict());
            };
            drop(probe);
            return Ok(None);
        };
        let durable_run = parse_uuid(&current_run.run_revision, "queue_run_id_invalid")
            .map_err(|_| gpu_switch_queue_reservation_conflict())?;
        if requested_run != Some(durable_run) {
            return Err(gpu_switch_queue_reservation_conflict());
        }

        for row in &loaded.snapshot.document.items {
            let NativeQueueRowV1::Item(item) = row else {
                return Err(gpu_switch_queue_reservation_conflict());
            };
            if item.run_revision.as_deref() != Some(current_run.run_revision.as_str()) {
                continue;
            }
            if item.state == QueueItemState::Dispatching
                || (item.state == QueueItemState::NeedsAttention
                    && item.attention_code.as_deref() == Some("submission_uncertain"))
            {
                return Err(gpu_switch_queue_reservation_conflict());
            }
        }

        let held_here = self.holds_runner(durable_run)?;
        if matches!(
            current_run.runner_state,
            QueueRunnerState::Running | QueueRunnerState::PauseAfterCurrent
        ) && !held_here
        {
            return Err(gpu_switch_queue_reservation_conflict());
        }
        if !held_here {
            let Some(probe) = RunnerFileLock::try_acquire(&self.root.join("runner.lock"))? else {
                return Err(gpu_switch_queue_reservation_conflict());
            };
            drop(probe);
        }
        Ok(Some(durable_run))
    }

    pub fn prepare_dispatch(
        &self,
        input: NativeQueueItemKey,
    ) -> NativeResult<NativeQueueDispatchPayloadV1> {
        let queue_item_id = parse_uuid(&input.queue_item_id, "queue_item_id_invalid")?;
        let client_submission_id =
            parse_uuid(&input.client_submission_id, "client_submission_id_invalid")?;
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| queue_store_unavailable())?;
        let _disk_mutation = self.acquire_cross_process_mutation_lock()?;
        self.pause_unleased_run_unlocked()?;
        let loaded = self.load_unlocked()?;
        let record = loaded.records.get(&queue_item_id).ok_or_else(|| {
            NativeError::new(
                "queue_item_corrupt",
                "This queued batch needs repair before it can be dispatched.",
            )
        })?;
        let item = &record.item;
        if parse_uuid(&item.client_submission_id, "client_submission_id_invalid")?
            != client_submission_id
        {
            return Err(NativeError::new(
                "queue_item_mismatch",
                "The queued batch changed before it could be dispatched.",
            ));
        }
        if item.state != QueueItemState::Staged {
            return Err(NativeError::new(
                "queue_item_not_dispatchable",
                "Only a staged queue batch can be opened or dispatched.",
            ));
        }
        let item_run_revision = item
            .run_revision
            .as_deref()
            .map(|value| parse_uuid(value, "queue_run_id_invalid"))
            .transpose()?;
        match input.purpose {
            QueueItemPayloadPurpose::Dispatch => {
                let run_revision = item_run_revision.ok_or_else(|| {
                    NativeError::new(
                        "queue_runner_busy",
                        "Run the local queue before dispatching a staged batch.",
                    )
                })?;
                if !self.holds_runner(run_revision)? {
                    return Err(NativeError::new(
                        "queue_runner_busy",
                        "Another ImageForge process owns the local queue runner.",
                    ));
                }
                let current_run = loaded.snapshot.document.run.as_ref().ok_or_else(|| {
                    NativeError::new(
                        "queue_item_not_dispatchable",
                        "This queued batch is no longer part of the current local run.",
                    )
                })?;
                if current_run.run_revision != run_revision.to_string()
                    || current_run.runner_state != QueueRunnerState::Running
                    || current_run.authorization_required
                {
                    return Err(NativeError::new(
                        "queue_item_not_dispatchable",
                        "Resume the current local queue before dispatching this batch.",
                    ));
                }
            }
            QueueItemPayloadPurpose::Edit => {
                if let Some(run_revision) = item_run_revision {
                    if !self.holds_runner(run_revision)? {
                        return Err(NativeError::new(
                            "queue_runner_busy",
                            "Another ImageForge process owns the current local queue runner.",
                        ));
                    }
                    let current_run = loaded.snapshot.document.run.as_ref().ok_or_else(|| {
                        NativeError::new(
                            "queue_item_not_dispatchable",
                            "This queued batch is no longer part of the current local run.",
                        )
                    })?;
                    if current_run.run_revision != run_revision.to_string()
                        || current_run.runner_state == QueueRunnerState::Completed
                    {
                        return Err(NativeError::new(
                            "queue_item_not_dispatchable",
                            "This queued batch can no longer be edited in the current local run.",
                        ));
                    }
                }
            }
        }
        self.destination
            .verify_queue_destination(&record.destination_binding)
            .map_err(|_| queue_destination_unavailable())?;

        let mut references = Vec::with_capacity(item.references.len());
        for reference in &item.references {
            let bytes = self.read_and_validate_reference(reference)?;
            references.push(NativeQueueDispatchReferenceV1 {
                id: reference.id.clone(),
                name: reference.name.clone(),
                mime_type: reference.mime_type.clone(),
                size_bytes: reference.size_bytes,
                sha256: reference.sha256.clone(),
                bytes,
            });
        }
        Ok(NativeQueueDispatchPayloadV1 {
            queue_item_id: item.queue_item_id.clone(),
            client_submission_id: item.client_submission_id.clone(),
            name: item.name.clone(),
            prompts: item.prompts.clone(),
            base_seed: item.base_seed,
            destination: item.destination.clone(),
            aspect_ratio: item.aspect_ratio.clone(),
            references,
        })
    }

    pub fn acquire_runner(&self, input: NativeRunKey) -> NativeResult<NativeRunnerLease> {
        let run_revision = parse_uuid(&input.run_revision, "queue_run_id_invalid")?;
        let _mutation = self
            .mutation_lock
            .lock()
            .map_err(|_| queue_store_unavailable())?;
        let _disk_mutation = self.acquire_cross_process_mutation_lock()?;
        let loaded = self.load_unlocked()?;
        let current_run = loaded.snapshot.document.run.as_ref().ok_or_else(|| {
            NativeError::new(
                "queue_runner_busy",
                "Run the local queue before acquiring its native runner lease.",
            )
        })?;
        if parse_uuid(&current_run.run_revision, "queue_run_id_invalid")? != run_revision {
            return Err(NativeError::new(
                "queue_runner_busy",
                "The requested local queue run is no longer current.",
            ));
        }
        let mut lease = self.runner.lock().map_err(|_| queue_store_unavailable())?;
        if let Some(existing) = lease.as_ref() {
            if existing.run_revision == run_revision {
                return Ok(NativeRunnerLease {
                    run_revision: input.run_revision,
                    held: true,
                });
            }
            return Err(NativeError::new(
                "queue_runner_busy",
                "This ImageForge process is already running a different local queue.",
            ));
        }
        if !matches!(
            current_run.runner_state,
            QueueRunnerState::Paused | QueueRunnerState::NeedsAttention
        ) || !current_run.authorization_required
        {
            return Err(NativeError::new(
                "queue_runner_busy",
                "The local queue must be paused or need attention before a new runner lease is acquired.",
            ));
        }
        let Some(file_lock) = RunnerFileLock::try_acquire(&self.root.join("runner.lock"))? else {
            return Err(NativeError::new(
                "queue_runner_busy",
                "Another ImageForge process owns the local queue runner.",
            ));
        };
        *lease = Some(RunnerLease {
            run_revision,
            _file_lock: file_lock,
        });
        Ok(NativeRunnerLease {
            run_revision: input.run_revision,
            held: true,
        })
    }

    pub fn release_runner(&self, input: NativeRunKey) -> NativeResult<NativeRunnerLease> {
        let run_revision = parse_uuid(&input.run_revision, "queue_run_id_invalid")?;
        let _mutation = self
            .mutation_lock
            .lock()
            .map_err(|_| queue_store_unavailable())?;
        let _disk_mutation = self.acquire_cross_process_mutation_lock()?;
        let mut lease = self.runner.lock().map_err(|_| queue_store_unavailable())?;
        let Some(existing) = lease.as_ref() else {
            return Err(NativeError::new(
                "queue_runner_busy",
                "This ImageForge process does not hold the local queue runner.",
            ));
        };
        if existing.run_revision != run_revision {
            return Err(NativeError::new(
                "queue_runner_busy",
                "Only the process that acquired this local queue run may release it.",
            ));
        }
        self.power.release_for_run(run_revision);
        // Dropping the file lock releases the OS-level lock immediately.
        *lease = None;
        Ok(NativeRunnerLease {
            run_revision: input.run_revision,
            held: false,
        })
    }

    /// Atomically re-read the native queue journal while holding a probe lease
    /// for a released runner. The callback receives no mutable store access,
    /// so a sibling process cannot admit a new runner or replace the current
    /// run between durable fact validation and the caller's completion claim.
    ///
    /// This deliberately has no renderer-facing command. It is used only by
    /// native release verification, which must not turn a sequence of
    /// independent `load` and runner-lock checks into a race.
    pub fn inspect_released_runner_snapshot<F>(
        &self,
        run_revision: &str,
        inspect: F,
    ) -> NativeResult<()>
    where
        F: FnOnce(&NativeQueueSnapshotV1) -> NativeResult<()>,
    {
        let run_revision = parse_uuid(run_revision, "queue_run_id_invalid")?;
        let _mutation = self
            .mutation_lock
            .lock()
            .map_err(|_| queue_store_unavailable())?;
        let _disk_mutation = self.acquire_cross_process_mutation_lock()?;
        let loaded = self.load_unlocked()?;
        let current = loaded.snapshot.document.run.as_ref().ok_or_else(|| {
            NativeError::new(
                "queue_runner_busy",
                "The local queue run is no longer current.",
            )
        })?;
        if parse_uuid(&current.run_revision, "queue_run_id_invalid")? != run_revision {
            return Err(NativeError::new(
                "queue_runner_busy",
                "The local queue run is no longer current.",
            ));
        }
        if self.holds_runner(run_revision)? {
            return Err(NativeError::new(
                "queue_runner_busy",
                "The local queue runner has not been released.",
            ));
        }
        let Some(probe) = RunnerFileLock::try_acquire(&self.root.join("runner.lock"))? else {
            return Err(NativeError::new(
                "queue_runner_busy",
                "Another ImageForge process still owns the local queue runner.",
            ));
        };
        // Keep the OS-level probe alive during the full snapshot inspection.
        // A conforming sibling needs the cross-process mutation lock to change
        // this run, and it cannot acquire the runner lock while this scope is
        // held.
        let result = inspect(&loaded.snapshot);
        drop(probe);
        result
    }

    pub fn set_sleep_prevention(&self, input: NativePowerInput) -> NativeResult<NativePowerState> {
        let run_revision = parse_uuid(&input.run_revision, "queue_run_id_invalid")?;
        let _mutation = self
            .mutation_lock
            .lock()
            .map_err(|_| queue_store_unavailable())?;
        let _disk_mutation = self.acquire_cross_process_mutation_lock()?;
        if !self.holds_runner(run_revision)? {
            return Err(NativeError::new(
                "queue_runner_busy",
                "Only the active local queue runner can change keep-awake.",
            ));
        }
        if input.enabled {
            let loaded = self.load_unlocked()?;
            let current_run = loaded.snapshot.document.run.as_ref().ok_or_else(|| {
                NativeError::new(
                    "queue_runner_busy",
                    "The local queue run is no longer current.",
                )
            })?;
            if current_run.run_revision != run_revision.to_string()
                || current_run.authorization_required
                || !matches!(
                    current_run.runner_state,
                    QueueRunnerState::Running | QueueRunnerState::PauseAfterCurrent
                )
            {
                return Err(NativeError::new(
                    "queue_runner_busy",
                    "Keep-awake can be enabled only while the owned local queue is running.",
                ));
            }
        }
        self.power.set_enabled(run_revision, input.enabled)
    }

    pub fn signal_alert<F>(
        &self,
        input: NativeAlertInput,
        deliver: F,
    ) -> NativeResult<NativeAlertResult>
    where
        F: FnOnce(AlertCopy) -> AlertDeliveryDisposition,
    {
        validate_alert_event_id(&input.event_id)?;
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| queue_store_unavailable())?;
        let _disk_mutation = self.acquire_cross_process_mutation_lock()?;
        let loaded = self.load_unlocked()?;
        let alarm = loaded.snapshot.document.alarm.as_ref().ok_or_else(|| {
            NativeError::new(
                "queue_alert_event_invalid",
                "The completion alert is no longer current.",
            )
        })?;
        if alarm.event_id != input.event_id || alarm.run_revision.is_empty() {
            return Err(NativeError::new(
                "queue_alert_event_invalid",
                "The completion alert is no longer current.",
            ));
        }
        if alarm.state != QueueAlarmState::Ringing {
            return Err(NativeError::new(
                "queue_alert_event_invalid",
                "The completion alert is no longer active.",
            ));
        }
        match input.kind {
            QueueAlertKind::Complete | QueueAlertKind::Attention
                if alarm.kind != Some(input.kind) =>
            {
                return Err(NativeError::new(
                    "queue_alert_event_invalid",
                    "The completion alert does not match the local queue result.",
                ));
            }
            QueueAlertKind::Snooze
                if !alarm.snooze_used
                    || !matches!(
                        alarm.snooze_notification_disposition,
                        Some(
                            NotificationDisposition::Pending
                                | NotificationDisposition::Failed
                                | NotificationDisposition::PermissionDenied
                        )
                    ) =>
            {
                return Err(NativeError::new(
                    "queue_alert_event_invalid",
                    "The local queue reminder is not due yet.",
                ));
            }
            _ => {}
        }

        let mut outbox = self
            .read_outbox(&input.event_id)
            .map_err(|_| alert_outbox_corrupt())?
            .unwrap_or(AlertOutboxV1 {
                schema_version: SCHEMA_VERSION,
                event_id: input.event_id.clone(),
                primary_kind: None,
                primary: None,
                snooze: None,
                recovered_after_corruption: false,
            });
        if outbox.event_id != input.event_id || outbox.schema_version != SCHEMA_VERSION {
            return Err(alert_outbox_corrupt());
        }
        let slot = match input.kind {
            QueueAlertKind::Snooze => outbox.snooze,
            QueueAlertKind::Complete | QueueAlertKind::Attention => outbox.primary,
        };
        if slot == Some(NotificationDisposition::Delivered) {
            return Ok(NativeAlertResult {
                event_id: input.event_id,
                notification_id: notification_id_for(&outbox.event_id, input.kind),
                disposition: AlertResultDisposition::AlreadyDelivered,
            });
        }
        if matches!(
            input.kind,
            QueueAlertKind::Complete | QueueAlertKind::Attention
        ) && outbox.primary_kind.is_some()
            && outbox.primary_kind != Some(input.kind)
        {
            return Err(NativeError::new(
                "queue_alert_event_invalid",
                "The completion alert does not match the local queue result.",
            ));
        }
        if matches!(
            input.kind,
            QueueAlertKind::Complete | QueueAlertKind::Attention
        ) {
            outbox.primary_kind = Some(input.kind);
            outbox.primary = Some(NotificationDisposition::Pending);
        } else {
            outbox.snooze = Some(NotificationDisposition::Pending);
        }
        self.write_outbox(&outbox)?;

        let copy = fixed_alert_copy(&input.event_id, input.kind);
        let delivery = deliver(copy);
        let (stored, disposition) = match delivery {
            AlertDeliveryDisposition::Delivered => (
                NotificationDisposition::Delivered,
                AlertResultDisposition::Delivered,
            ),
            AlertDeliveryDisposition::PermissionDenied => (
                NotificationDisposition::PermissionDenied,
                AlertResultDisposition::PermissionDenied,
            ),
            AlertDeliveryDisposition::Failed => (
                NotificationDisposition::Failed,
                AlertResultDisposition::Failed,
            ),
        };
        if matches!(
            input.kind,
            QueueAlertKind::Complete | QueueAlertKind::Attention
        ) {
            outbox.primary = Some(stored);
        } else {
            outbox.snooze = Some(stored);
        }
        if stored == NotificationDisposition::Delivered {
            // A user-visible Ring now/retry completed successfully, so the
            // prior corrupt/missing record no longer needs a persistent
            // warning. Failed or denied explicit retries remain visible.
            outbox.recovered_after_corruption = false;
        }
        self.write_outbox(&outbox)?;
        Ok(NativeAlertResult {
            event_id: input.event_id,
            notification_id: copy.notification_id,
            disposition,
        })
    }

    /// The only destructive queue recovery path. It is deliberately available
    /// only after every retained generation is unreadable, and it moves the
    /// whole private journal aside for manual recovery instead of deleting a
    /// potentially useful overnight queue.
    pub fn reset(&self, input: NativeQueueResetInput) -> NativeResult<NativeQueueSnapshotV1> {
        if input.confirmation != "RESET LOCAL QUEUE" {
            return Err(NativeError::new(
                "queue_reset_confirmation_invalid",
                "Type the exact local queue reset confirmation before clearing it.",
            ));
        }
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| queue_store_unavailable())?;
        let _disk_mutation = self.acquire_cross_process_mutation_lock()?;
        if self
            .runner
            .lock()
            .map_err(|_| queue_store_unavailable())?
            .is_some()
        {
            return Err(NativeError::new(
                "queue_runner_busy",
                "Release the local queue runner before resetting its saved state.",
            ));
        }
        let Some(_runner_guard) = RunnerFileLock::try_acquire(&self.root.join("runner.lock"))?
        else {
            return Err(NativeError::new(
                "queue_runner_busy",
                "Release the local queue runner before resetting its saved state.",
            ));
        };
        match self.load_unlocked_without_pause() {
            Err(error) if error.code == "queue_store_unrecoverable" => {}
            Err(error) => return Err(error),
            Ok(_) => {
                return Err(NativeError::new(
                    "queue_reset_not_allowed",
                    "The local queue is recoverable and was not cleared.",
                ))
            }
        }
        // Reset is the one destructive local-recovery operation.  Drop a
        // stray assertion before moving the journal aside so an interrupted
        // partial cleanup cannot leave a no-idle-sleep request without any
        // durable runner to release it later.
        // The explicit drop is required on Windows: an open runner.lock
        // handle prevents the containing directory from being renamed.
        drop(_runner_guard);
        self.power.release_all();
        let parent = self.root.parent().ok_or_else(queue_store_unavailable)?;
        let quarantine = parent.join(format!("v1-recovery-{}", Uuid::new_v4()));
        fs::rename(self.root.as_ref(), &quarantine).map_err(|_| queue_store_unavailable())?;
        sync_directory(parent).map_err(|_| queue_store_unavailable())?;
        self.ensure_layout()?;
        Ok(empty_snapshot())
    }

    /// A current run is a process-owned scheduler transaction.  Another
    /// window may still safely stage or edit unassigned Next-run rows, but it
    /// cannot race the runner by changing its cohort, runner/alarm state, or
    /// any assigned row.  Completion is deliberately different: its lease is
    /// released before the user can acknowledge/snooze/archive the terminal
    /// result, and the narrower transition validators below govern that
    /// post-completion UI.
    fn require_runner_for_commit(
        &self,
        loaded: &LoadedQueue,
        next: &NativeQueueDocumentV1,
    ) -> NativeResult<()> {
        let Some(current_run) = loaded.snapshot.document.run.as_ref() else {
            return Ok(());
        };
        let mutates_current = commit_mutates_current_run(loaded, next);
        if !mutates_current || current_run.runner_state == QueueRunnerState::Completed {
            return Ok(());
        }
        let run_revision = parse_uuid(&current_run.run_revision, "queue_run_id_invalid")?;
        if self.holds_runner(run_revision)? {
            return Ok(());
        }
        Err(NativeError::new(
            "queue_runner_busy",
            "Another ImageForge process owns the current local queue runner.",
        ))
    }

    /// Opening a payload is deliberately not authorization to bill the
    /// worker. A Pause can be committed between `queue_prepare_dispatch` and
    /// the renderer's staged -> dispatching mutation, so the mutation itself
    /// repeats the exact runner/run gate. In particular, it may not combine a
    /// stale dispatch with Paused -> Running: foreground Resume persists that
    /// authorization in its own commit before a successor can be selected.
    fn validate_dispatch_admission(
        &self,
        loaded: &LoadedQueue,
        next: &NativeQueueDocumentV1,
    ) -> NativeResult<()> {
        for row in &next.items {
            let NativeQueueRowV1::Item(candidate) = row else {
                continue;
            };
            let item_id = parse_uuid(&candidate.queue_item_id, "queue_item_id_invalid")?;
            let Some(previous) = loaded.records.get(&item_id) else {
                continue;
            };
            // Requiring this for every new dispatching state also closes the
            // foreground-repair path (needs_attention -> dispatching), while
            // preserving idempotent dispatching -> dispatching projections.
            if candidate.state != QueueItemState::Dispatching
                || previous.item.state == QueueItemState::Dispatching
            {
                continue;
            }

            let run_revision = candidate
                .run_revision
                .as_deref()
                .ok_or_else(queue_commit_invalid)
                .and_then(|value| parse_uuid(value, "queue_run_id_invalid"))?;
            let run_revision_text = run_revision.to_string();
            let Some(current) = loaded.snapshot.document.run.as_ref() else {
                return Err(NativeError::new(
                    "queue_item_not_dispatchable",
                    "This queued batch is no longer part of a running local queue.",
                ));
            };
            let Some(proposed) = next.run.as_ref() else {
                return Err(NativeError::new(
                    "queue_item_not_dispatchable",
                    "This queued batch is no longer part of a running local queue.",
                ));
            };
            let exact_current = current.run_revision == run_revision_text
                && current.runner_state == QueueRunnerState::Running
                && !current.authorization_required
                && current
                    .cohort_item_ids
                    .iter()
                    .any(|id| id == &candidate.queue_item_id);
            let exact_proposed = proposed.run_revision == run_revision_text
                && proposed.runner_state == QueueRunnerState::Running
                && !proposed.authorization_required
                && proposed
                    .cohort_item_ids
                    .iter()
                    .any(|id| id == &candidate.queue_item_id);
            if !exact_current || !exact_proposed {
                return Err(NativeError::new(
                    "queue_item_not_dispatchable",
                    "Resume the current local queue before dispatching this batch.",
                ));
            }
            if previous.item.run_revision.as_deref() != Some(run_revision_text.as_str()) {
                return Err(queue_commit_invalid());
            }
            if !self.holds_runner(run_revision)? {
                return Err(NativeError::new(
                    "queue_runner_busy",
                    "Another ImageForge process owns the local queue runner.",
                ));
            }
        }
        Ok(())
    }

    fn plan_commit(
        &self,
        loaded: &LoadedQueue,
        document: &NativeQueueDocumentV1,
    ) -> NativeResult<CommitPlan> {
        let mut records = Vec::new();
        let mut indices = Vec::with_capacity(document.items.len());
        let mut seen = HashSet::new();
        let mut deferred_reference_item_ids = HashSet::new();
        let previous_positions = loaded
            .generation
            .as_ref()
            .map(|generation| {
                generation
                    .items
                    .iter()
                    .enumerate()
                    .filter_map(|(index, pointer)| {
                        parse_uuid(&pointer.queue_item_id, "queue_item_id_invalid")
                            .ok()
                            .map(|id| (id, index))
                    })
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        let mut locked_positions = Vec::new();

        for (position, row) in document.items.iter().enumerate() {
            match row {
                NativeQueueRowV1::Item(item) => {
                    validate_queue_item(item)?;
                    let id = parse_uuid(&item.queue_item_id, "queue_item_id_invalid")?;
                    if !seen.insert(id) {
                        return Err(queue_commit_invalid());
                    }
                    let existing = loaded.records.get(&id);
                    let preserve_reference_projection = loaded.reference_issue_ids.contains(&id)
                        && existing.is_some_and(|record| record.item == *item);
                    let binding = match existing {
                        Some(record) => {
                            if record.item.destination != item.destination {
                                return Err(queue_destination_unavailable());
                            }
                            if item.record_revision < record.item.record_revision
                                || (item.record_revision == record.item.record_revision
                                    && record.item != *item)
                            {
                                return Err(queue_commit_invalid());
                            }
                            validate_item_transition(
                                &record.item,
                                item,
                                document.run.as_ref(),
                                document.alarm.as_ref(),
                            )?;
                            if record.item.state == QueueItemState::NeedsAttention
                                && record.item.run_revision.is_some()
                                && item.state == QueueItemState::Cancelled
                            {
                                self.require_observed_local_damage(
                                    record,
                                    record.item.attention_code.as_deref(),
                                )?;
                                self.require_exact_runner_for_local_damage_cancellation(
                                    loaded,
                                    &record.item,
                                )?;
                            }
                            if is_locked_item_state(record.item.state) {
                                locked_positions.push((id, position));
                            }
                            record.destination_binding.clone()
                        }
                        None => {
                            // New rows enter only through local staging. A
                            // renderer cannot synthesize a remote/attention
                            // lifecycle row that lacks a native immutable
                            // predecessor to validate against.
                            if item.state != QueueItemState::Staged
                                || item.run_revision.is_some()
                                || item.remote_batch_id.is_some()
                            {
                                return Err(queue_commit_invalid());
                            }
                            self.destination
                                .capture_queue_destination(&item.destination)
                                .map_err(|_| queue_destination_unavailable())?
                        }
                    };
                    let deferred_reference_integrity = match existing {
                        Some(record)
                            if item.state == QueueItemState::NeedsAttention
                                && is_locally_removable_attention_code(
                                    item.attention_code.as_deref(),
                                ) =>
                        {
                            self.require_observed_local_damage(
                                record,
                                item.attention_code.as_deref(),
                            )?;
                            true
                        }
                        Some(record)
                            if record.item.state == QueueItemState::NeedsAttention
                                && is_locally_removable_attention_code(
                                    record.item.attention_code.as_deref(),
                                )
                                && item.state == QueueItemState::Cancelled =>
                        {
                            true
                        }
                        _ => preserve_reference_projection,
                    };
                    if deferred_reference_integrity {
                        deferred_reference_item_ids.insert(id);
                    }
                    records.push(DiskItemRecordV1 {
                        schema_version: SCHEMA_VERSION,
                        item: item.clone(),
                        destination_binding: binding,
                    });
                    if preserve_reference_projection {
                        indices.push(
                            loaded
                                .pointers
                                .get(&id)
                                .cloned()
                                .ok_or_else(queue_store_unavailable)?,
                        );
                    } else {
                        indices.push(index_for_item(item));
                    }
                }
                NativeQueueRowV1::Placeholder(placeholder) => {
                    validate_placeholder(placeholder)?;
                    let id = parse_uuid(&placeholder.queue_item_id, "queue_item_id_invalid")?;
                    if !seen.insert(id) {
                        return Err(queue_commit_invalid());
                    }
                    let pointer = loaded
                        .pointers
                        .get(&id)
                        .ok_or_else(queue_placeholder_invalid)?;
                    if pointer.record_revision != placeholder.record_revision
                        || pointer.name != placeholder.name
                        || pointer.prompt_count != placeholder.prompt_count
                        || pointer.reference_count != placeholder.reference_count
                        || pointer.created_at != placeholder.created_at
                        || pointer.updated_at != placeholder.updated_at
                    {
                        return Err(queue_placeholder_invalid());
                    }
                    indices.push(pointer.clone());
                }
            }
        }

        for (id, pointer) in &loaded.pointers {
            if seen.contains(id) {
                continue;
            }
            if let Some(record) = loaded.records.get(id) {
                if record.item.state == QueueItemState::NeedsAttention {
                    if !is_locally_removable_attention_code(record.item.attention_code.as_deref()) {
                        return Err(NativeError::new(
                            "queue_item_locked",
                            "This queued batch needs explicit foreground reconciliation before it can be removed.",
                        ));
                    }
                    self.require_observed_local_damage(
                        record,
                        record.item.attention_code.as_deref(),
                    )?;
                    if record.item.run_revision.is_some() {
                        return Err(NativeError::new(
                            "queue_item_locked",
                            "An assigned locally damaged queue item must be cancelled under its active runner lease before removal.",
                        ));
                    }
                }
                if cannot_remove_item(
                    record.item.state,
                    loaded
                        .generation
                        .as_ref()
                        .and_then(|generation| generation.run.as_ref()),
                    loaded
                        .generation
                        .as_ref()
                        .and_then(|generation| generation.alarm.as_ref()),
                ) {
                    return Err(NativeError::new(
                        "queue_item_locked",
                        "An active, terminal, or historical queued batch cannot be removed yet.",
                    ));
                }
            } else if pointer.queue_item_id == id.to_string() {
                // A corrupt placeholder cannot be edited or synthesized, but
                // omitting it is the explicit Remove corrupt item recovery
                // action. The expected-revision transaction keeps it from
                // deleting a newly repaired record in another process.
                continue;
            }
        }
        for (id, next_position) in locked_positions {
            if previous_positions.get(&id).copied() != Some(next_position) {
                return Err(NativeError::new(
                    "queue_item_locked",
                    "An active, saving, or historical queued batch cannot be reordered.",
                ));
            }
        }

        let mut required_references = BTreeMap::new();
        for reference in records
            .iter()
            .filter(|record| {
                parse_uuid(&record.item.queue_item_id, "queue_item_id_invalid")
                    .ok()
                    .is_none_or(|id| !deferred_reference_item_ids.contains(&id))
            })
            .flat_map(|record| record.item.references.iter())
        {
            let value = (reference.mime_type.clone(), reference.size_bytes);
            if let Some(previous) =
                required_references.insert(reference.sha256.clone(), value.clone())
            {
                if previous != value {
                    return Err(queue_commit_invalid());
                }
            }
        }
        Ok(CommitPlan {
            records,
            indices,
            required_references,
            deferred_reference_item_ids,
        })
    }

    /// Local bytes or an authorized destination can be proved invalid without
    /// consulting the worker. Only those pre-admission failures may become a
    /// local cancellation; an ambiguous submission/remote interruption stays
    /// durable until foreground reconciliation establishes its exact outcome.
    fn require_exact_runner_for_local_damage_cancellation(
        &self,
        loaded: &LoadedQueue,
        item: &NativeQueueItemV1,
    ) -> NativeResult<()> {
        if !is_locally_removable_attention_code(item.attention_code.as_deref()) {
            return Err(NativeError::new(
                "queue_item_locked",
                "This queued batch needs explicit foreground reconciliation before it can be cancelled.",
            ));
        }
        let run_revision = item
            .run_revision
            .as_deref()
            .ok_or_else(queue_commit_invalid)
            .and_then(|value| parse_uuid(value, "queue_run_id_invalid"))?;
        let current = loaded.snapshot.document.run.as_ref().ok_or_else(|| {
            NativeError::new(
                "queue_runner_busy",
                "The local queue runner is no longer available for this cancellation.",
            )
        })?;
        if current.run_revision != run_revision.to_string() || !self.holds_runner(run_revision)? {
            return Err(NativeError::new(
                "queue_runner_busy",
                "Only the exact active local queue runner can cancel this damaged batch.",
            ));
        }
        Ok(())
    }

    /// `attention_code` is renderer-visible but it is not renderer-trusted.
    /// Before accepting a locally-removable code, reproduce the observed
    /// damage against the private reference bytes or destination binding.
    fn require_observed_local_damage(
        &self,
        record: &DiskItemRecordV1,
        code: Option<&str>,
    ) -> NativeResult<()> {
        let observed = match code {
            Some("queue_reference_missing") | Some("queue_reference_mismatch") => self
                .check_record_integrity(record)
                .err()
                .map(IntegrityIssue::code),
            Some("queue_destination_unavailable") => self
                .destination
                .verify_queue_destination(&record.destination_binding)
                .err()
                .map(|_| "queue_destination_unavailable"),
            _ => None,
        };
        if observed != code {
            return Err(NativeError::new(
                "queue_item_locked",
                "This queue item has no verified local damage to remove.",
            ));
        }
        Ok(())
    }

    fn write_reference_blobs(
        &self,
        blobs: &[NativeReferenceBlobV1],
        required: &BTreeMap<String, (String, u64)>,
    ) -> NativeResult<()> {
        let mut supplied = BTreeMap::new();
        for blob in blobs {
            validate_reference_blob(blob)?;
            let expected = required
                .get(&blob.sha256)
                .ok_or_else(queue_commit_invalid)?;
            if expected.0 != blob.mime_type || expected.1 != blob.size_bytes {
                return Err(queue_commit_invalid());
            }
            if supplied.insert(blob.sha256.clone(), blob).is_some() {
                return Err(queue_commit_invalid());
            }
        }
        for (sha256, (mime_type, size_bytes)) in required {
            let path = self.reference_path(sha256, mime_type)?;
            let supplied_blob = supplied.get(sha256);
            if path.exists() {
                let reference = NativeQueueReferenceV1 {
                    id: Uuid::new_v4().to_string(),
                    name: "stored-reference".to_owned(),
                    mime_type: mime_type.clone(),
                    size_bytes: *size_bytes,
                    sha256: sha256.clone(),
                };
                if let Err(integrity_error) = self.read_and_validate_reference(&reference) {
                    // A foreground repair may provide the same immutable
                    // content-addressed bytes again. Replace only after the
                    // supplied blob passed its SHA/image validation above;
                    // an unrelated commit cannot silently heal or alter it.
                    let blob = supplied_blob.ok_or(integrity_error)?;
                    write_replace_atomic(&path, &blob.bytes)
                        .map_err(|_| queue_store_unavailable())?;
                    self.read_and_validate_reference(&reference)?;
                }
                continue;
            }
            let blob = supplied_blob.ok_or_else(|| {
                NativeError::new(
                    "queue_reference_missing",
                    "A copied reference image is missing from this device.",
                )
            })?;
            write_immutable_file(&path, &blob.bytes).map_err(|_| queue_store_unavailable())?;
        }
        Ok(())
    }

    fn verify_planned_references(
        &self,
        records: &[DiskItemRecordV1],
        deferred_item_ids: &HashSet<Uuid>,
    ) -> NativeResult<()> {
        for record in records {
            let item_id = parse_uuid(&record.item.queue_item_id, "queue_item_id_invalid")?;
            if deferred_item_ids.contains(&item_id) {
                continue;
            }
            for reference in &record.item.references {
                self.read_and_validate_reference(reference)?;
            }
        }
        Ok(())
    }

    fn write_item_records(
        &self,
        records: &[DiskItemRecordV1],
        existing: &HashMap<Uuid, DiskItemRecordV1>,
    ) -> NativeResult<()> {
        for record in records {
            let id = parse_uuid(&record.item.queue_item_id, "queue_item_id_invalid")?;
            if existing.get(&id).is_some_and(|previous| {
                previous.item == record.item
                    && previous.destination_binding == record.destination_binding
            }) {
                continue;
            }
            let path = self.item_path(id, record.item.record_revision)?;
            let encoded = serde_json::to_vec(record).map_err(|_| queue_store_unavailable())?;
            if path.exists() {
                let previous = read_limited(&path, MAX_ITEM_RECORD_BYTES)
                    .map_err(|_| queue_store_unavailable())?;
                if previous != encoded {
                    return Err(queue_commit_invalid());
                }
                continue;
            }
            write_immutable_file(&path, &encoded).map_err(|_| queue_store_unavailable())?;
        }
        Ok(())
    }

    fn write_generation(&self, generation: &DiskGenerationV1) -> NativeResult<()> {
        let path = self.generation_path(generation.store_revision)?;
        let encoded = serde_json::to_vec(generation).map_err(|_| queue_store_unavailable())?;
        write_immutable_file(&path, &encoded).map_err(|_| queue_store_unavailable())
    }

    fn write_current(&self, revision: u64) -> NativeResult<()> {
        let path = self.root.join("CURRENT");
        let temporary = self.root.join(format!(".CURRENT-{}.tmp", Uuid::new_v4()));
        let encoded = format!("{revision}\n");
        let result = (|| -> std::io::Result<()> {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)?;
            file.write_all(encoded.as_bytes())?;
            file.sync_all()?;
            drop(file);
            replace_file_atomic(&temporary, &path)?;
            sync_directory(&self.root)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
            return Err(queue_store_unavailable());
        }
        Ok(())
    }

    fn cleanup_old_generations(&self, current: u64) {
        let Ok(retained) = self.retained_valid_generations(current) else {
            return;
        };
        let retained = retained
            .iter()
            .map(|generation| generation.store_revision)
            .collect::<HashSet<_>>();
        let Ok(generations) = self.generation_ids() else {
            return;
        };
        let mut deleted = false;
        for revision in generations {
            // A higher journal is never current and may be a partial future
            // write. Invalid journals are likewise retained for recovery;
            // neither can consume one of the current + two prior *valid*
            // generations, nor can this housekeeping delete it.
            if revision >= current || retained.contains(&revision) {
                continue;
            }
            if self.read_generation(revision).is_ok()
                && fs::remove_file(
                    self.generation_path(revision)
                        .unwrap_or_else(|_| self.root.join("invalid")),
                )
                .is_ok()
            {
                deleted = true;
            }
        }
        if deleted {
            let _ = sync_directory(&self.root.join("generations"));
        }
    }

    /// The collector trusts only the pointer just committed and its two prior
    /// *validated* journals. It intentionally ignores a higher orphaned file
    /// instead of allowing it to evict a known-good recovery point.
    fn retained_valid_generations(&self, current: u64) -> Result<Vec<DiskGenerationV1>, ()> {
        let mut revisions = self.generation_ids()?;
        revisions.retain(|revision| *revision <= current);
        revisions.sort_unstable_by(|left, right| right.cmp(left));
        let mut retained = Vec::with_capacity(RETAIN_GENERATIONS);
        for revision in revisions {
            if let Ok(generation) = self.read_generation(revision) {
                retained.push(generation);
                if retained.len() == RETAIN_GENERATIONS {
                    break;
                }
            }
        }
        // A successful commit's CURRENT always points to the first retained
        // journal. Refuse to collect if that invariant cannot be re-read.
        if retained
            .first()
            .is_none_or(|generation| generation.store_revision != current)
        {
            return Err(());
        }
        Ok(retained)
    }

    /// Best-effort post-commit reachability collection. It never runs during
    /// startup/recovery and bails out before deleting anything if any retained
    /// generation or immutable record cannot be fully validated.
    fn garbage_collect_unreachable(&self, current: u64) {
        let Ok(retained) = self.retained_valid_generations(current) else {
            return;
        };
        let mut reachable_records = HashSet::new();
        let mut reachable_references = HashSet::new();
        for generation in retained {
            for pointer in &generation.items {
                let Ok(id) = parse_uuid(&pointer.queue_item_id, "queue_item_id_invalid") else {
                    return;
                };
                let Ok(path) = self.item_path(id, pointer.record_revision) else {
                    return;
                };
                let Ok(record) = self.read_item_record(pointer) else {
                    return;
                };
                reachable_records.insert(path);
                for reference in &record.item.references {
                    let Ok(path) = self.reference_path(&reference.sha256, &reference.mime_type)
                    else {
                        return;
                    };
                    reachable_references.insert(path);
                }
            }
        }
        let removed_items = self.garbage_collect_item_records(&reachable_records);
        let removed_references = self.garbage_collect_reference_blobs(&reachable_references);
        if removed_items {
            let _ = sync_directory(&self.root.join("items"));
        }
        if removed_references {
            let _ = sync_directory(&self.root.join("references"));
        }
    }

    fn garbage_collect_item_records(&self, reachable: &HashSet<PathBuf>) -> bool {
        let Ok(item_directories) = fs::read_dir(self.root.join("items")) else {
            return false;
        };
        let mut deleted = false;
        for item_directory in item_directories.flatten() {
            let directory = item_directory.path();
            let Ok(metadata) = fs::symlink_metadata(&directory) else {
                continue;
            };
            let Some(name) = directory.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if metadata.file_type().is_symlink()
                || !metadata.is_dir()
                || parse_uuid(name, "queue_item_id_invalid").is_err()
            {
                continue;
            }
            let Ok(records) = fs::read_dir(&directory) else {
                continue;
            };
            for record in records.flatten() {
                let path = record.path();
                let Ok(metadata) = fs::symlink_metadata(&path) else {
                    continue;
                };
                let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                if metadata.file_type().is_symlink()
                    || !metadata.is_file()
                    || !is_item_record_file_name(name)
                    || reachable.contains(&path)
                {
                    continue;
                }
                if fs::remove_file(&path).is_ok() {
                    deleted = true;
                }
            }
        }
        deleted
    }

    fn garbage_collect_reference_blobs(&self, reachable: &HashSet<PathBuf>) -> bool {
        let Ok(references) = fs::read_dir(self.root.join("references")) else {
            return false;
        };
        let mut deleted = false;
        for reference in references.flatten() {
            let path = reference.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || !is_reference_blob_file_name(name)
                || reachable.contains(&path)
            {
                continue;
            }
            if fs::remove_file(&path).is_ok() {
                deleted = true;
            }
        }
        deleted
    }

    fn pause_unleased_run_unlocked(&self) -> NativeResult<()> {
        if self
            .runner
            .lock()
            .map_err(|_| queue_store_unavailable())?
            .is_some()
        {
            return Ok(());
        }
        // A separate short-lived repair lock serializes startup/reload repair
        // across app processes. Hold the runner lock while re-reading and
        // committing the pause so another process cannot acquire a scheduler
        // lease in the stale Running window.
        let _repair_lock =
            RunnerFileLock::acquire_blocking(&self.root.join("startup-repair.lock"))?;
        if self
            .runner
            .lock()
            .map_err(|_| queue_store_unavailable())?
            .is_some()
        {
            return Ok(());
        }
        let Some(_runner_probe) = RunnerFileLock::try_acquire(&self.root.join("runner.lock"))?
        else {
            // A different local process owns the active runner; it remains
            // authoritative and must not be paused by this process.
            return Ok(());
        };
        let loaded = self.load_unlocked_without_pause()?;
        let Some(mut generation) = loaded.generation else {
            return Ok(());
        };
        let Some(run) = generation.run.as_mut() else {
            return Ok(());
        };
        if !matches!(
            run.runner_state,
            QueueRunnerState::Running | QueueRunnerState::PauseAfterCurrent
        ) {
            return Ok(());
        }
        run.runner_state = QueueRunnerState::Paused;
        run.authorization_required = true;
        generation.store_revision = generation
            .store_revision
            .checked_add(1)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(queue_store_unavailable)?;
        self.write_generation(&generation)?;
        self.write_current(generation.store_revision)?;
        Ok(())
    }

    fn holds_runner(&self, run_revision: Uuid) -> NativeResult<bool> {
        Ok(self
            .runner
            .lock()
            .map_err(|_| queue_store_unavailable())?
            .as_ref()
            .is_some_and(|lease| lease.run_revision == run_revision))
    }

    fn acquire_cross_process_mutation_lock(&self) -> NativeResult<RunnerFileLock> {
        let parent = self.root.parent().ok_or_else(queue_store_unavailable)?;
        // Keep this lock beside (not inside) v1 so destructive queue reset
        // cannot move the active lock away while another process begins a
        // commit. It serializes load/compare/write and alert outbox delivery.
        RunnerFileLock::acquire_blocking(&parent.join("v1-mutation.lock"))
    }

    fn load_unlocked(&self) -> NativeResult<LoadedQueue> {
        self.load_unlocked_without_pause()
    }

    fn load_unlocked_without_pause(&self) -> NativeResult<LoadedQueue> {
        self.ensure_layout()?;
        let current = self.read_current();
        let mut recovered = false;
        let selected = match current {
            Ok(Some(revision)) => match self.read_generation(revision) {
                Ok(generation) => Some(generation),
                Err(()) => {
                    recovered = true;
                    self.highest_valid_generation()
                }
            },
            Ok(None) => {
                let generations = self
                    .generation_ids()
                    .map_err(|_| queue_store_unavailable())?;
                if generations.is_empty() {
                    None
                } else {
                    recovered = true;
                    self.highest_valid_generation()
                }
            }
            Err(()) => {
                recovered = true;
                self.highest_valid_generation()
            }
        };
        if recovered && selected.is_none() {
            return Err(NativeError::new(
                "queue_store_unrecoverable",
                "The local queue could not be recovered. Reset it only after reviewing the saved files.",
            ));
        }
        let Some(generation) = selected else {
            return Ok(LoadedQueue {
                snapshot: empty_snapshot(),
                generation: None,
                records: HashMap::new(),
                pointers: HashMap::new(),
                reference_issue_ids: HashSet::new(),
            });
        };
        let mut issues = Vec::new();
        if recovered {
            issues.push(issue("queue_store_recovered", None, false));
        }
        let mut items = Vec::with_capacity(generation.items.len());
        let mut records = HashMap::new();
        let mut pointers = HashMap::new();
        let mut reference_issue_ids = HashSet::new();
        for pointer in &generation.items {
            let id = match parse_uuid(&pointer.queue_item_id, "queue_item_id_invalid") {
                Ok(id) => id,
                Err(_) => continue,
            };
            pointers.insert(id, pointer.clone());
            match self.read_item_record(pointer) {
                Ok(record) => match self.check_record_integrity(&record) {
                    Ok(()) => {
                        records.insert(id, record.clone());
                        items.push(NativeQueueRowV1::Item(record.item));
                    }
                    Err(integrity) => {
                        let mut item = record.item.clone();
                        item.state = QueueItemState::NeedsAttention;
                        item.attention_code = Some(integrity.code().to_owned());
                        // Keep the in-memory commit baseline coherent with
                        // the projected row. The immutable on-disk record is
                        // retained for recovery, while an unrelated commit
                        // can safely carry this needs-attention row forward
                        // and an explicit foreground repair can create its
                        // next record revision.
                        records.insert(
                            id,
                            DiskItemRecordV1 {
                                schema_version: record.schema_version,
                                item: item.clone(),
                                destination_binding: record.destination_binding,
                            },
                        );
                        reference_issue_ids.insert(id);
                        issues.push(issue(
                            integrity.code(),
                            Some(item.queue_item_id.clone()),
                            false,
                        ));
                        items.push(NativeQueueRowV1::Item(item));
                    }
                },
                Err(()) => {
                    issues.push(issue(
                        "queue_item_corrupt",
                        Some(pointer.queue_item_id.clone()),
                        false,
                    ));
                    items.push(NativeQueueRowV1::Placeholder(placeholder_for(pointer)));
                }
            }
        }
        let mut run = generation.run.clone();
        let mut alarm = generation.alarm.clone();
        if let Some(alarm_value) = alarm.as_mut() {
            match self.read_outbox(&alarm_value.event_id) {
                Ok(Some(outbox))
                    if alert_outbox_is_blank(&outbox)
                        && alarm_expects_alert_outbox(alarm_value) =>
                {
                    issues.push(issue("queue_alert_outbox_invalid", None, false));
                    let fallback = self.repair_alert_outbox(alarm_value)?;
                    apply_alert_outbox_projection(alarm_value, &fallback);
                }
                Ok(Some(outbox)) if alert_outbox_is_blank(&outbox) => {
                    if outbox.recovered_after_corruption {
                        issues.push(issue("queue_alert_outbox_invalid", None, false));
                    }
                    // A blank native record is equivalent to no delivery
                    // record yet. Keep a renderer's pending projection so an
                    // explicit first Ring now call can fill it.
                }
                Ok(Some(outbox)) if alert_outbox_matches_alarm(&outbox, alarm_value) => {
                    if outbox_missing_required_delivery_slot(&outbox, alarm_value) {
                        issues.push(issue("queue_alert_outbox_invalid", None, false));
                        let fallback = self.repair_alert_outbox(alarm_value)?;
                        apply_alert_outbox_projection(alarm_value, &fallback);
                    } else {
                        if outbox.recovered_after_corruption {
                            issues.push(issue("queue_alert_outbox_invalid", None, false));
                        }
                        alarm_value.notification_disposition = outbox.primary;
                        alarm_value.snooze_notification_disposition = outbox.snooze;
                    }
                }
                Ok(Some(_)) => {
                    issues.push(issue("queue_alert_outbox_invalid", None, false));
                    let fallback = self.repair_alert_outbox(alarm_value)?;
                    apply_alert_outbox_projection(alarm_value, &fallback);
                }
                Ok(None) if alarm_expects_alert_outbox(alarm_value) => {
                    issues.push(issue("queue_alert_outbox_invalid", None, false));
                    let fallback = self.repair_alert_outbox(alarm_value)?;
                    apply_alert_outbox_projection(alarm_value, &fallback);
                }
                Ok(None) => {}
                Err(()) => {
                    issues.push(issue("queue_alert_outbox_invalid", None, false));
                    let fallback = self.repair_alert_outbox(alarm_value)?;
                    apply_alert_outbox_projection(alarm_value, &fallback);
                }
            }
        }
        project_reconstructed_document(
            &mut items,
            &mut records,
            &pointers,
            &mut run,
            &mut alarm,
            &mut issues,
        )?;
        Ok(LoadedQueue {
            snapshot: NativeQueueSnapshotV1 {
                schema_version: SCHEMA_VERSION,
                store_revision: generation.store_revision,
                document: NativeQueueDocumentV1 {
                    schema_version: SCHEMA_VERSION,
                    items,
                    run,
                    alarm,
                },
                issues,
            },
            generation: Some(generation),
            records,
            pointers,
            reference_issue_ids,
        })
    }

    fn read_current(&self) -> Result<Option<u64>, ()> {
        let path = self.root.join("CURRENT");
        if !path.exists() {
            return Ok(None);
        }
        let bytes = read_limited(&path, MAX_CURRENT_BYTES).map_err(|_| ())?;
        let text = std::str::from_utf8(&bytes).map_err(|_| ())?;
        let Some(number) = text.strip_suffix('\n') else {
            return Err(());
        };
        if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(());
        }
        let value = number.parse::<u64>().map_err(|_| ())?;
        (value <= MAX_SAFE_INTEGER).then_some(Some(value)).ok_or(())
    }

    fn read_generation(&self, revision: u64) -> Result<DiskGenerationV1, ()> {
        let path = self.generation_path(revision).map_err(|_| ())?;
        let bytes = read_limited(&path, MAX_GENERATION_BYTES).map_err(|_| ())?;
        let generation = serde_json::from_slice::<DiskGenerationV1>(&bytes).map_err(|_| ())?;
        validate_generation(&generation, revision).map_err(|_| ())?;
        Ok(generation)
    }

    fn highest_valid_generation(&self) -> Option<DiskGenerationV1> {
        let mut ids = self.generation_ids().ok()?;
        ids.sort_unstable_by(|left, right| right.cmp(left));
        ids.into_iter()
            .find_map(|revision| self.read_generation(revision).ok())
    }

    fn read_item_record(&self, pointer: &DiskItemIndexV1) -> Result<DiskItemRecordV1, ()> {
        let id = parse_uuid(&pointer.queue_item_id, "queue_item_id_invalid").map_err(|_| ())?;
        let path = self
            .item_path(id, pointer.record_revision)
            .map_err(|_| ())?;
        let bytes = read_limited(&path, MAX_ITEM_RECORD_BYTES).map_err(|_| ())?;
        let record = serde_json::from_slice::<DiskItemRecordV1>(&bytes).map_err(|_| ())?;
        if record.schema_version != SCHEMA_VERSION
            || record.item.queue_item_id != pointer.queue_item_id
            || record.item.record_revision != pointer.record_revision
            || queue_item_content_hash(&record.item) != pointer.content_hash
            || record.item.name != pointer.name
            || record.item.prompts.len() as u64 != pointer.prompt_count
            || record.item.references.len() as u64 != pointer.reference_count
            || record.item.created_at != pointer.created_at
            || record.item.updated_at != pointer.updated_at
        {
            return Err(());
        }
        validate_queue_item(&record.item).map_err(|_| ())?;
        self.destination
            .validate_queue_binding(&record.destination_binding, &record.item.destination)
            .map_err(|_| ())?;
        Ok(record)
    }

    fn check_record_integrity(&self, record: &DiskItemRecordV1) -> Result<(), IntegrityIssue> {
        for reference in &record.item.references {
            self.read_and_validate_reference(reference)
                .map_err(|error| {
                    if error.code == "queue_reference_missing" {
                        IntegrityIssue::MissingReference
                    } else {
                        IntegrityIssue::MismatchedReference
                    }
                })?;
        }
        Ok(())
    }

    fn read_and_validate_reference(
        &self,
        reference: &NativeQueueReferenceV1,
    ) -> NativeResult<Vec<u8>> {
        validate_reference_metadata(reference)?;
        let path = self.reference_path(&reference.sha256, &reference.mime_type)?;
        let bytes = match read_limited(&path, MAX_REFERENCE_BYTES as u64) {
            Ok(bytes) => bytes,
            Err(_) => {
                return Err(NativeError::new(
                    "queue_reference_missing",
                    "A copied reference image is missing from this device.",
                ))
            }
        };
        if bytes.len() as u64 != reference.size_bytes
            || hex::encode(Sha256::digest(&bytes)) != reference.sha256
            || !validate_image_bytes(&reference.mime_type, &bytes)
        {
            return Err(NativeError::new(
                "queue_reference_mismatch",
                "A copied reference image no longer matches its staged batch.",
            ));
        }
        Ok(bytes)
    }

    fn read_outbox(&self, event_id: &str) -> Result<Option<AlertOutboxV1>, ()> {
        let path = self.outbox_path(event_id);
        if !path.exists() {
            return Ok(None);
        }
        let bytes = read_limited(&path, MAX_ALERT_BYTES).map_err(|_| ())?;
        let outbox = serde_json::from_slice::<AlertOutboxV1>(&bytes).map_err(|_| ())?;
        if outbox.schema_version != SCHEMA_VERSION || outbox.event_id != event_id {
            return Err(());
        }
        Ok(Some(outbox))
    }

    /// Preserve a corrupt native notification record for manual inspection,
    /// then atomically replace it with a private, schema-valid failed record.
    /// This repairs the durable authority boundary without ever delivering an
    /// OS alert during startup. A later explicit `signal_alert` call is the
    /// only path that may retry delivery.
    fn repair_alert_outbox(&self, alarm: &NativeQueueAlarmV1) -> NativeResult<AlertOutboxV1> {
        self.quarantine_alert_outbox(&alarm.event_id)?;
        let requires_failed_slots = alarm.kind.is_some()
            && (alarm_requires_delivery_slot(alarm)
                || alarm.notification_disposition.is_some()
                || alarm.snooze_notification_disposition.is_some());
        let fallback = AlertOutboxV1 {
            schema_version: SCHEMA_VERSION,
            event_id: alarm.event_id.clone(),
            primary_kind: requires_failed_slots.then_some(alarm.kind).flatten(),
            primary: requires_failed_slots.then_some(NotificationDisposition::Failed),
            snooze: (requires_failed_slots && alarm.snooze_used)
                .then_some(NotificationDisposition::Failed),
            recovered_after_corruption: true,
        };
        self.write_outbox(&fallback)?;
        Ok(fallback)
    }

    fn quarantine_alert_outbox(&self, event_id: &str) -> NativeResult<()> {
        let path = self.outbox_path(event_id);
        if !path.exists() {
            return Ok(());
        }
        let directory = self.root.join("alerts").join("quarantine");
        ensure_directory(&directory)?;
        let digest = hex::encode(Sha256::digest(event_id.as_bytes()));
        let destination = directory.join(format!("{digest}-{}.json", Uuid::new_v4()));
        move_file_no_replace(&path, &destination).map_err(|_| alert_outbox_corrupt())?;
        sync_directory(&directory).map_err(|_| alert_outbox_corrupt())?;
        sync_directory(&self.root.join("alerts")).map_err(|_| alert_outbox_corrupt())?;
        Ok(())
    }

    /// Notification delivery is authoritative only in the private native
    /// outbox.  The renderer may persist its observed result into the queue
    /// generation, but it cannot forge a delivery result or repair an outbox
    /// by writing the projection directly.
    fn validate_alarm_outbox_authority(
        &self,
        document: &NativeQueueDocumentV1,
    ) -> NativeResult<()> {
        let Some(alarm) = document.alarm.as_ref() else {
            return Ok(());
        };
        match self.read_outbox(&alarm.event_id) {
            Ok(Some(outbox)) => {
                if !alert_outbox_matches_alarm(&outbox, alarm)
                    || !projection_matches_outbox(alarm.notification_disposition, outbox.primary)
                    || !projection_matches_outbox(
                        alarm.snooze_notification_disposition,
                        outbox.snooze,
                    )
                {
                    return Err(queue_commit_invalid());
                }
            }
            Ok(None) if outbox_absent_projection_is_pending_or_empty(alarm) => {}
            Ok(None) => return Err(queue_commit_invalid()),
            Err(()) => return Err(alert_outbox_corrupt()),
        }
        Ok(())
    }

    fn write_outbox(&self, outbox: &AlertOutboxV1) -> NativeResult<()> {
        let path = self.outbox_path(&outbox.event_id);
        let encoded = serde_json::to_vec(outbox).map_err(|_| alert_outbox_corrupt())?;
        write_replace_atomic(&path, &encoded).map_err(|_| alert_outbox_corrupt())
    }

    fn generation_ids(&self) -> Result<Vec<u64>, ()> {
        let directory = self.root.join("generations");
        let entries = fs::read_dir(directory).map_err(|_| ())?;
        let mut ids = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|_| ())?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(stem) = name.strip_suffix(".json") else {
                continue;
            };
            if stem.is_empty() || !stem.bytes().all(|byte| byte.is_ascii_digit()) {
                continue;
            }
            let Ok(id) = stem.parse::<u64>() else {
                continue;
            };
            if id <= MAX_SAFE_INTEGER {
                ids.push(id);
            }
        }
        Ok(ids)
    }

    fn generation_path(&self, revision: u64) -> NativeResult<PathBuf> {
        ensure_safe_integer(revision)?;
        Ok(self
            .root
            .join("generations")
            .join(format!("{revision}.json")))
    }

    fn item_path(&self, item_id: Uuid, revision: u64) -> NativeResult<PathBuf> {
        ensure_safe_integer(revision)?;
        Ok(self
            .root
            .join("items")
            .join(item_id.to_string())
            .join(format!("{revision}.json")))
    }

    fn reference_path(&self, sha256: &str, mime_type: &str) -> NativeResult<PathBuf> {
        validate_sha256(sha256)?;
        let extension = extension_for_mime(mime_type).ok_or_else(queue_commit_invalid)?;
        Ok(self
            .root
            .join("references")
            .join(format!("{sha256}.{extension}")))
    }

    fn outbox_path(&self, event_id: &str) -> PathBuf {
        let digest = hex::encode(Sha256::digest(event_id.as_bytes()));
        self.root.join("alerts").join(format!("{digest}.json"))
    }

    fn ensure_layout(&self) -> NativeResult<()> {
        ensure_directory(&self.root)?;
        for name in ["generations", "items", "references", "alerts"] {
            ensure_directory(&self.root.join(name))?;
        }
        Ok(())
    }
}

/// One shared classifier owns both renderer-runner authorization and the
/// profile-control command boundary. Keeping it here prevents the command from
/// treating the mere presence of a current run as proof that an edit mutates
/// that run.
fn commit_mutates_current_run(loaded: &LoadedQueue, next: &NativeQueueDocumentV1) -> bool {
    let previous = &loaded.snapshot.document;
    let mut mutates_current = previous.run != next.run || previous.alarm != next.alarm;
    let Some(current_run) = previous.run.as_ref() else {
        return mutates_current;
    };
    let current_id = current_run.run_revision.as_str();
    let mut prior_positions = HashMap::new();
    for (position, row) in previous.items.iter().enumerate() {
        let NativeQueueRowV1::Item(item) = row else {
            continue;
        };
        if item.run_revision.as_deref() == Some(current_id) {
            prior_positions.insert(item.queue_item_id.as_str(), (position, row));
        }
    }
    for (position, row) in next.items.iter().enumerate() {
        let NativeQueueRowV1::Item(item) = row else {
            continue;
        };
        if item.run_revision.as_deref() != Some(current_id) {
            continue;
        }
        match prior_positions.remove(item.queue_item_id.as_str()) {
            Some((prior_position, prior_row)) if prior_position == position && prior_row == row => {
            }
            _ => mutates_current = true,
        }
    }
    mutates_current || !prior_positions.is_empty()
}

#[derive(Debug)]
struct CommitPlan {
    records: Vec<DiskItemRecordV1>,
    indices: Vec<DiskItemIndexV1>,
    required_references: BTreeMap<String, (String, u64)>,
    deferred_reference_item_ids: HashSet<Uuid>,
}

/// Some native load repairs intentionally project a safer alarm/run state
/// without rewriting the immutable prior generation. All subsequent renderer
/// transition checks must compare against that returned projection, not an
/// older raw Delivered disposition that the renderer was never allowed to see.
fn effective_generation_for_transition(loaded: &LoadedQueue) -> Option<DiskGenerationV1> {
    let mut generation = loaded.generation.clone()?;
    generation.run = loaded.snapshot.document.run.clone();
    generation.alarm = loaded.snapshot.document.alarm.clone();
    Some(generation)
}

fn empty_snapshot() -> NativeQueueSnapshotV1 {
    NativeQueueSnapshotV1 {
        schema_version: SCHEMA_VERSION,
        store_revision: 0,
        document: NativeQueueDocumentV1 {
            schema_version: SCHEMA_VERSION,
            items: Vec::new(),
            run: None,
            alarm: None,
        },
        issues: Vec::new(),
    }
}

fn issue(code: &str, queue_item_id: Option<String>, retryable: bool) -> NativeQueueIssue {
    NativeQueueIssue {
        code: code.to_owned(),
        queue_item_id,
        retryable,
    }
}

fn placeholder_for(pointer: &DiskItemIndexV1) -> NativeQueueItemPlaceholderV1 {
    NativeQueueItemPlaceholderV1 {
        schema_version: SCHEMA_VERSION,
        queue_item_id: pointer.queue_item_id.clone(),
        record_revision: pointer.record_revision,
        state: QueueItemState::NeedsAttention,
        attention_code: "queue_item_corrupt".to_owned(),
        name: pointer.name.clone(),
        prompt_count: pointer.prompt_count,
        reference_count: pointer.reference_count,
        created_at: pointer.created_at.clone(),
        updated_at: pointer.updated_at.clone(),
    }
}

fn index_for_item(item: &NativeQueueItemV1) -> DiskItemIndexV1 {
    DiskItemIndexV1 {
        queue_item_id: item.queue_item_id.clone(),
        record_revision: item.record_revision,
        content_hash: queue_item_content_hash(item),
        name: item.name.clone(),
        prompt_count: item.prompts.len() as u64,
        reference_count: item.references.len() as u64,
        created_at: item.created_at.clone(),
        updated_at: item.updated_at.clone(),
    }
}

fn queue_item_content_hash(item: &NativeQueueItemV1) -> String {
    // NativeQueueItemV1 contains no maps or floating-point values, so serde's
    // checked-in field order is a canonical byte representation for this v1
    // private journal. The index binds every record field, not just its human
    // summary, before the renderer is allowed to see it again after restart.
    let bytes = serde_json::to_vec(item).expect("queue item serialization is infallible");
    hex::encode(Sha256::digest(bytes))
}

fn reconstructed_document(
    items: &[NativeQueueRowV1],
    run: Option<NativeQueueRunV1>,
    alarm: Option<NativeQueueAlarmV1>,
) -> NativeQueueDocumentV1 {
    NativeQueueDocumentV1 {
        schema_version: SCHEMA_VERSION,
        items: items.to_vec(),
        run,
        alarm,
    }
}

/// The generation index cannot express all row/run relationships. Check them
/// again after loading immutable records so a syntactically valid but tampered
/// record is never returned to TypeScript as a schedulable queue row.
fn item_violates_reconstructed_run_shape(
    item: &NativeQueueItemV1,
    run: Option<&NativeQueueRunV1>,
) -> bool {
    match run {
        None => {
            !matches!(
                item.state,
                QueueItemState::Staged
                    | QueueItemState::NeedsAttention
                    | QueueItemState::Historical
            ) || (item.state != QueueItemState::Historical && item.run_revision.is_some())
        }
        Some(_) if item.state == QueueItemState::Historical => false,
        Some(run) => {
            let requires_current_run = !matches!(
                item.state,
                QueueItemState::Staged | QueueItemState::NeedsAttention
            );
            let assigned_to_current =
                item.run_revision.as_deref() == Some(run.run_revision.as_str());
            (requires_current_run && !assigned_to_current)
                || item.run_revision.as_ref().is_some_and(|_| {
                    !assigned_to_current
                        || !run
                            .cohort_item_ids
                            .iter()
                            .any(|id| id == &item.queue_item_id)
                })
        }
    }
}

fn project_corrupt_reconstructed_row(
    index: usize,
    items: &mut [NativeQueueRowV1],
    records: &mut HashMap<Uuid, DiskItemRecordV1>,
    pointers: &HashMap<Uuid, DiskItemIndexV1>,
    issues: &mut Vec<NativeQueueIssue>,
    projected: &mut HashSet<Uuid>,
) -> NativeResult<bool> {
    let NativeQueueRowV1::Item(item) = &items[index] else {
        return Ok(false);
    };
    let id = parse_uuid(&item.queue_item_id, "queue_item_id_invalid")?;
    let pointer = pointers
        .get(&id)
        .ok_or_else(queue_store_unavailable)?
        .clone();
    items[index] = NativeQueueRowV1::Placeholder(placeholder_for(&pointer));
    records.remove(&id);
    if projected.insert(id) {
        issues.push(issue(
            "queue_item_corrupt",
            Some(pointer.queue_item_id),
            false,
        ));
    }
    Ok(true)
}

fn park_reconstructed_run(
    run: &mut Option<NativeQueueRunV1>,
    alarm: &mut Option<NativeQueueAlarmV1>,
) {
    if let Some(run) = run {
        run.runner_state = QueueRunnerState::NeedsAttention;
        run.authorization_required = true;
        run.keep_awake = false;
    }
    if let Some(alarm) = alarm {
        alarm.state = QueueAlarmState::Disarmed;
        alarm.kind = None;
        alarm.snooze_used = false;
        alarm.snooze_due_at = None;
        alarm.notification_disposition = None;
        alarm.snooze_notification_disposition = None;
    }
}

fn project_reconstructed_document(
    items: &mut Vec<NativeQueueRowV1>,
    records: &mut HashMap<Uuid, DiskItemRecordV1>,
    pointers: &HashMap<Uuid, DiskItemIndexV1>,
    run: &mut Option<NativeQueueRunV1>,
    alarm: &mut Option<NativeQueueAlarmV1>,
    issues: &mut Vec<NativeQueueIssue>,
) -> NativeResult<()> {
    // A syntactically valid placeholder is still an untrusted hole in the
    // current cohort: validation deliberately permits it so the user can see
    // and repair the row, but a scheduler must never skip past it to bill a
    // later batch. Project the singleton runner to needs_attention before the
    // normal early-return path. Every native load/dispatch re-applies this
    // fail-closed projection, including after restart.
    let cohort_contains_placeholder = run.as_ref().is_some_and(|current| {
        items.iter().any(|row| {
            matches!(
                row,
                NativeQueueRowV1::Placeholder(placeholder)
                    if current
                        .cohort_item_ids
                        .iter()
                        .any(|id| id == &placeholder.queue_item_id)
            )
        })
    });
    if cohort_contains_placeholder {
        park_reconstructed_run(run, alarm);
    }
    let initial = reconstructed_document(items, run.clone(), alarm.clone());
    if validate_document_shape(&initial, true, true, true).is_ok() {
        return Ok(());
    }

    let mut projected = HashSet::new();
    for index in 0..items.len() {
        let should_project = matches!(
            items.get(index),
            Some(NativeQueueRowV1::Item(item))
                if item_violates_reconstructed_run_shape(item, run.as_ref())
        );
        if should_project {
            project_corrupt_reconstructed_row(
                index,
                items,
                records,
                pointers,
                issues,
                &mut projected,
            )?;
        }
    }

    // Any semantic inconsistency parks the local scheduler in the projection.
    // The immutable raw generation remains available for explicit repair, but
    // no queue item can dispatch from a snapshot that fails native validation.
    park_reconstructed_run(run, alarm);
    let parked = reconstructed_document(items, run.clone(), alarm.clone());
    if validate_document_shape(&parked, true, true, true).is_ok() {
        if projected.is_empty() {
            issues.push(issue("queue_store_recovered", None, false));
        }
        return Ok(());
    }

    // A cross-row tamper can evade the local predicate above. Preserve rows
    // outside the current cohort where possible, then quarantine the smallest
    // remaining set that can make the projected document safe.
    let current_cohort = run
        .as_ref()
        .map(|run| run.cohort_item_ids.iter().cloned().collect::<HashSet<_>>())
        .unwrap_or_default();
    for index in 0..items.len() {
        let should_project = matches!(
            items.get(index),
            Some(NativeQueueRowV1::Item(item))
                if current_cohort.contains(&item.queue_item_id)
        );
        if should_project {
            project_corrupt_reconstructed_row(
                index,
                items,
                records,
                pointers,
                issues,
                &mut projected,
            )?;
        }
    }
    let cohort_repaired = reconstructed_document(items, run.clone(), alarm.clone());
    if validate_document_shape(&cohort_repaired, true, true, true).is_ok() {
        return Ok(());
    }

    // Last-resort fail-closed projection for a globally inconsistent selected
    // generation. It keeps the immutable files for manual recovery but never
    // returns a renderer snapshot that violates the shared schema.
    for index in 0..items.len() {
        let _ = project_corrupt_reconstructed_row(
            index,
            items,
            records,
            pointers,
            issues,
            &mut projected,
        )?;
    }
    let final_projection = reconstructed_document(items, run.clone(), alarm.clone());
    validate_document_shape(&final_projection, true, true, true)
        .map_err(|_| queue_store_unavailable())
}

fn validate_generation(generation: &DiskGenerationV1, expected_revision: u64) -> NativeResult<()> {
    if generation.schema_version != SCHEMA_VERSION || generation.store_revision != expected_revision
    {
        return Err(queue_store_unavailable());
    }
    let document = NativeQueueDocumentV1 {
        schema_version: SCHEMA_VERSION,
        items: generation
            .items
            .iter()
            .map(placeholder_for)
            .map(NativeQueueRowV1::Placeholder)
            .collect(),
        run: generation.run.clone(),
        alarm: generation.alarm.clone(),
    };
    // A generation only contains immutable row indexes, not the full row
    // state.  Verify its schema/alarm shape here, then verify the completed
    // cohort fixed point after the corresponding item records are loaded.
    // Treating indexes as `NeedsAttention` placeholders here would otherwise
    // make every valid completed alarm look corrupt after a restart.
    validate_document_shape(&document, true, false, false)?;
    let mut seen = HashSet::new();
    for pointer in &generation.items {
        parse_uuid(&pointer.queue_item_id, "queue_item_id_invalid")?;
        ensure_safe_integer(pointer.record_revision)?;
        validate_sha256(&pointer.content_hash)?;
        validate_safe_name(&pointer.name)?;
        ensure_safe_integer(pointer.prompt_count)?;
        ensure_safe_integer(pointer.reference_count)?;
        validate_timestamp(&pointer.created_at)?;
        validate_timestamp(&pointer.updated_at)?;
        if !seen.insert(&pointer.queue_item_id) {
            return Err(queue_store_unavailable());
        }
    }
    Ok(())
}

fn validate_document(document: &NativeQueueDocumentV1) -> NativeResult<()> {
    // Native-generated corrupt placeholders may be carried forward. The
    // commit plan validates each one against the previous immutable index, so
    // a renderer cannot synthesize or alter a placeholder.
    validate_document_shape(document, true, true, true)
}

fn validate_document_shape(
    document: &NativeQueueDocumentV1,
    permits_placeholders: bool,
    require_cohort_fixed_point: bool,
    require_delivery_slots: bool,
) -> NativeResult<()> {
    if document.schema_version != SCHEMA_VERSION {
        return Err(queue_commit_invalid());
    }
    // The singleton run and singleton alarm are one durable state machine.
    // Keeping either without the other lets a renderer invent an orphaned
    // completion event or resume an unowned scheduler.
    if document.run.is_some() != document.alarm.is_some() {
        return Err(queue_commit_invalid());
    }
    let mut ids = HashSet::new();
    for row in &document.items {
        match row {
            NativeQueueRowV1::Item(item) => {
                validate_queue_item(item)?;
                if !ids.insert(item.queue_item_id.clone()) {
                    return Err(queue_commit_invalid());
                }
            }
            NativeQueueRowV1::Placeholder(placeholder) if permits_placeholders => {
                validate_placeholder(placeholder)?;
                if !ids.insert(placeholder.queue_item_id.clone()) {
                    return Err(queue_commit_invalid());
                }
            }
            NativeQueueRowV1::Placeholder(_) => return Err(queue_placeholder_invalid()),
        }
    }
    if let Some(run) = &document.run {
        validate_run(run, &ids)?;
        for cohort_item_id in &run.cohort_item_ids {
            let row = document
                .items
                .iter()
                .find(|row| match row {
                    NativeQueueRowV1::Item(item) => &item.queue_item_id == cohort_item_id,
                    NativeQueueRowV1::Placeholder(item) => &item.queue_item_id == cohort_item_id,
                })
                .ok_or_else(queue_commit_invalid)?;
            if let NativeQueueRowV1::Item(item) = row {
                if item.run_revision.as_deref() != Some(run.run_revision.as_str()) {
                    return Err(queue_commit_invalid());
                }
            }
        }
        for row in &document.items {
            let NativeQueueRowV1::Item(item) = row else {
                continue;
            };
            if let Some(item_run_revision) = &item.run_revision {
                // Completed history remains local audit data while a later
                // cohort runs.  Every *non-historical* row with a run must,
                // however, belong to the one current local run.
                if item.state != QueueItemState::Historical
                    && (item_run_revision != &run.run_revision
                        || !run
                            .cohort_item_ids
                            .iter()
                            .any(|id| id == &item.queue_item_id))
                {
                    return Err(queue_commit_invalid());
                }
            }
            if matches!(
                item.state,
                QueueItemState::Dispatching
                    | QueueItemState::Active
                    | QueueItemState::Saving
                    | QueueItemState::Completed
                    | QueueItemState::CompletedWithFailures
                    | QueueItemState::Interrupted
                    | QueueItemState::Cancelled
                    | QueueItemState::Historical
            ) && item.run_revision.is_none()
            {
                return Err(queue_commit_invalid());
            }
        }
    } else if document.alarm.is_some() {
        return Err(queue_commit_invalid());
    } else if document.items.iter().any(|row| {
        matches!(
            row,
            NativeQueueRowV1::Item(item)
                if !matches!(item.state, QueueItemState::Staged | QueueItemState::NeedsAttention | QueueItemState::Historical)
                    || (item.state != QueueItemState::Historical && item.run_revision.is_some())
        )
    }) {
        return Err(queue_commit_invalid());
    }
    if let Some(alarm) = &document.alarm {
        validate_alarm(
            alarm,
            document,
            require_cohort_fixed_point,
            require_delivery_slots,
        )?;
    }
    Ok(())
}

fn validate_queue_item(item: &NativeQueueItemV1) -> NativeResult<()> {
    if item.schema_version != SCHEMA_VERSION {
        return Err(queue_commit_invalid());
    }
    parse_uuid(&item.queue_item_id, "queue_item_id_invalid")?;
    parse_uuid(&item.client_submission_id, "client_submission_id_invalid")?;
    ensure_safe_integer(item.record_revision)?;
    if item.queue_item_id == item.client_submission_id {
        return Err(queue_commit_invalid());
    }
    if let Some(run_revision) = &item.run_revision {
        parse_uuid(run_revision, "queue_run_id_invalid")?;
    }
    if let Some(remote_batch_id) = &item.remote_batch_id {
        parse_uuid(remote_batch_id, "remote_batch_id_invalid")?;
    }
    if let Some(attention) = &item.attention_code {
        if attention.is_empty()
            || attention.len() > MAX_ATTENTION_CODE_BYTES
            || attention.chars().any(char::is_control)
        {
            return Err(queue_commit_invalid());
        }
    }
    validate_item_state_fields(item)?;
    validate_safe_name(&item.name)?;
    if item.prompts.is_empty()
        || item
            .prompts
            .iter()
            .any(|prompt| prompt.trim().is_empty() || prompt.contains('\0'))
        || item
            .base_seed
            .checked_add(item.prompts.len().saturating_sub(1) as u64)
            .map_or(true, |seed| seed > MAX_SAFE_INTEGER)
    {
        return Err(queue_commit_invalid());
    }
    ensure_safe_integer(item.base_seed)?;
    if !matches!(
        item.aspect_ratio.as_str(),
        "16:9" | "1:1" | "9:16" | "4:3" | "3:4"
    ) {
        return Err(queue_commit_invalid());
    }
    if item.destination.is_empty()
        || item.destination.contains('\0')
        || !Path::new(&item.destination).is_absolute()
    {
        return Err(queue_destination_unavailable());
    }
    if let Some(style_suffix) = &item.style_suffix {
        if style_suffix.trim() != style_suffix
            || style_suffix.is_empty()
            || style_suffix.contains('\0')
        {
            return Err(queue_commit_invalid());
        }
    }
    if item.references.len() > MAX_BATCH_REFERENCES {
        return Err(queue_commit_invalid());
    }
    let mut reference_ids = HashSet::new();
    let mut total = 0_usize;
    for reference in &item.references {
        validate_reference_metadata(reference)?;
        if !reference_ids.insert(reference.id.clone()) {
            return Err(queue_commit_invalid());
        }
        total = total.saturating_add(reference.size_bytes as usize);
    }
    if total > MAX_REFERENCE_TOTAL_BYTES {
        return Err(queue_commit_invalid());
    }
    validate_timestamp(&item.created_at)?;
    validate_timestamp(&item.updated_at)?;
    Ok(())
}

/// State-specific fields are part of the durable admission boundary.  In
/// particular, a renderer cannot create a synthetic remote association for a
/// merely staged row, or silently erase the reason that made a row require
/// foreground attention.
fn validate_item_state_fields(item: &NativeQueueItemV1) -> NativeResult<()> {
    let remote_required = matches!(
        item.state,
        QueueItemState::Active
            | QueueItemState::Saving
            | QueueItemState::Completed
            | QueueItemState::CompletedWithFailures
            | QueueItemState::Interrupted
    );
    let remote_forbidden = matches!(
        item.state,
        QueueItemState::Staged | QueueItemState::Dispatching
    );
    if (remote_required && item.remote_batch_id.is_none())
        || (remote_forbidden && item.remote_batch_id.is_some())
    {
        return Err(queue_commit_invalid());
    }

    let attention_required = matches!(
        item.state,
        QueueItemState::NeedsAttention | QueueItemState::Interrupted
    );
    if attention_required != item.attention_code.is_some() {
        return Err(queue_commit_invalid());
    }
    Ok(())
}

/// Validate an existing durable row against its candidate replacement.  The
/// JavaScript scheduler may decide *when* a foreground Resume action is
/// appropriate, but it cannot skip lifecycle phases, rewrite an immutable
/// prompt snapshot, or replace an accepted worker association.
fn validate_item_transition(
    previous: &NativeQueueItemV1,
    next: &NativeQueueItemV1,
    next_run: Option<&NativeQueueRunV1>,
    next_alarm: Option<&NativeQueueAlarmV1>,
) -> NativeResult<()> {
    if previous.queue_item_id != next.queue_item_id
        || previous.client_submission_id != next.client_submission_id
        || previous.name != next.name
        || previous.prompts != next.prompts
        || previous.base_seed != next.base_seed
        || previous.destination != next.destination
        || previous.aspect_ratio != next.aspect_ratio
        || previous.style_suffix != next.style_suffix
        || previous.references != next.references
        || previous.created_at != next.created_at
    {
        return Err(queue_commit_invalid());
    }

    if previous == next {
        return Ok(());
    }
    let expected_revision = previous
        .record_revision
        .checked_add(1)
        .filter(|revision| *revision <= MAX_SAFE_INTEGER)
        .ok_or_else(queue_commit_invalid)?;
    if next.record_revision != expected_revision {
        return Err(queue_commit_invalid());
    }

    if previous.state == QueueItemState::Historical {
        // Historical rows are immutable.  Their sole recovery action is
        // omission in the surrounding expected-revision commit, which is
        // handled by cannot_remove_item below.
        return Err(NativeError::new(
            "queue_item_locked",
            "A historical queued batch cannot be changed.",
        ));
    }

    let state_allowed = match previous.state {
        QueueItemState::Staged => matches!(
            next.state,
            QueueItemState::Staged
                | QueueItemState::Dispatching
                | QueueItemState::NeedsAttention
                | QueueItemState::Cancelled
        ),
        QueueItemState::Dispatching => matches!(
            next.state,
            QueueItemState::Dispatching
                | QueueItemState::Active
                | QueueItemState::NeedsAttention
                | QueueItemState::Interrupted
                | QueueItemState::Cancelled
                // A foreground Resume may safely return an unaccepted,
                // idempotency-checked dispatch to staged.  It is never a
                // background retry.
                | QueueItemState::Staged
        ),
        QueueItemState::Active => matches!(
            next.state,
            QueueItemState::Active
                | QueueItemState::Saving
                | QueueItemState::Interrupted
                | QueueItemState::Cancelled
                | QueueItemState::NeedsAttention
        ),
        QueueItemState::Saving => matches!(
            next.state,
            QueueItemState::Saving
                | QueueItemState::Completed
                | QueueItemState::CompletedWithFailures
                | QueueItemState::NeedsAttention
                | QueueItemState::Interrupted
                | QueueItemState::Cancelled
        ),
        QueueItemState::NeedsAttention => matches!(
            next.state,
            QueueItemState::NeedsAttention
                | QueueItemState::Staged
                | QueueItemState::Dispatching
                | QueueItemState::Active
                | QueueItemState::Cancelled
        ),
        QueueItemState::Interrupted => matches!(
            next.state,
            QueueItemState::Interrupted
                | QueueItemState::Active
                | QueueItemState::Cancelled
                | QueueItemState::NeedsAttention
        ),
        QueueItemState::Completed => matches!(
            next.state,
            QueueItemState::Completed | QueueItemState::Historical
        ),
        QueueItemState::CompletedWithFailures => {
            matches!(
                next.state,
                QueueItemState::CompletedWithFailures | QueueItemState::Historical
            )
        }
        QueueItemState::Cancelled => matches!(
            next.state,
            QueueItemState::Cancelled | QueueItemState::Historical
        ),
        QueueItemState::Historical => false,
    };
    if !state_allowed {
        return Err(queue_commit_invalid());
    }

    if previous.state == QueueItemState::NeedsAttention
        && next.state == QueueItemState::Cancelled
        && !is_locally_removable_attention_code(previous.attention_code.as_deref())
    {
        return Err(NativeError::new(
            "queue_item_locked",
            "This queued batch needs explicit foreground reconciliation before it can be cancelled.",
        ));
    }

    if let Some(previous_run) = &previous.run_revision {
        if next.run_revision.as_deref() != Some(previous_run.as_str()) {
            return Err(queue_commit_invalid());
        }
    } else if next.run_revision.is_some() && previous.state != QueueItemState::Staged {
        return Err(queue_commit_invalid());
    }

    if let Some(previous_remote) = &previous.remote_batch_id {
        // A durable association is an idempotency/audit key, not mutable UI
        // metadata.  Cancelled and historical rows intentionally retain it.
        if next.remote_batch_id.as_deref() != Some(previous_remote.as_str()) {
            return Err(queue_commit_invalid());
        }
    }

    if matches!(
        next.state,
        QueueItemState::Completed
            | QueueItemState::CompletedWithFailures
            | QueueItemState::Cancelled
            | QueueItemState::Historical
    ) {
        let run = next_run.ok_or_else(queue_commit_invalid)?;
        if next.run_revision.as_deref() != Some(run.run_revision.as_str())
            || !run
                .cohort_item_ids
                .iter()
                .any(|id| id == &next.queue_item_id)
        {
            return Err(queue_commit_invalid());
        }
        if next.state == QueueItemState::Historical
            && (run.runner_state != QueueRunnerState::Completed
                || next_alarm.map_or(true, |alarm| alarm.state != QueueAlarmState::Acknowledged))
        {
            return Err(NativeError::new(
                "queue_item_locked",
                "Completed queue rows can be archived only after acknowledgement.",
            ));
        }
    }
    Ok(())
}

fn validate_placeholder(placeholder: &NativeQueueItemPlaceholderV1) -> NativeResult<()> {
    if placeholder.schema_version != SCHEMA_VERSION
        || placeholder.state != QueueItemState::NeedsAttention
        || placeholder.attention_code != "queue_item_corrupt"
    {
        return Err(queue_placeholder_invalid());
    }
    parse_uuid(&placeholder.queue_item_id, "queue_item_id_invalid")?;
    ensure_safe_integer(placeholder.record_revision)?;
    validate_safe_name(&placeholder.name)?;
    ensure_safe_integer(placeholder.prompt_count)?;
    ensure_safe_integer(placeholder.reference_count)?;
    validate_timestamp(&placeholder.created_at)?;
    validate_timestamp(&placeholder.updated_at)
}

fn validate_reference_metadata(reference: &NativeQueueReferenceV1) -> NativeResult<()> {
    parse_uuid(&reference.id, "queue_reference_id_invalid")?;
    if reference.name.trim().is_empty()
        || reference.name.len() > MAX_FILE_NAME_BYTES
        || reference.name.contains('\0')
        || reference.name.contains('/')
        || reference.name.contains('\\')
    {
        return Err(queue_commit_invalid());
    }
    if extension_for_mime(&reference.mime_type).is_none()
        || reference.size_bytes == 0
        || reference.size_bytes > MAX_REFERENCE_BYTES as u64
    {
        return Err(queue_commit_invalid());
    }
    validate_sha256(&reference.sha256)
}

fn validate_reference_blob(blob: &NativeReferenceBlobV1) -> NativeResult<()> {
    if extension_for_mime(&blob.mime_type).is_none()
        || blob.size_bytes == 0
        || blob.size_bytes > MAX_REFERENCE_BYTES as u64
        || blob.size_bytes != blob.bytes.len() as u64
        || !validate_image_bytes(&blob.mime_type, &blob.bytes)
        || hex::encode(Sha256::digest(&blob.bytes)) != blob.sha256
    {
        return Err(queue_commit_invalid());
    }
    validate_sha256(&blob.sha256)
}

fn validate_image_bytes(mime_type: &str, bytes: &[u8]) -> bool {
    let expected = match mime_type {
        "image/jpeg" => ImageFormat::Jpeg,
        "image/png" => ImageFormat::Png,
        "image/webp" => ImageFormat::WebP,
        _ => return false,
    };
    if guess_format(bytes).ok() != Some(expected) {
        return false;
    }
    let Ok(image) = load_from_memory_with_format(bytes, expected) else {
        return false;
    };
    u64::from(image.width()) * u64::from(image.height()) <= MAX_REFERENCE_PIXELS
}

fn validate_run(run: &NativeQueueRunV1, item_ids: &HashSet<String>) -> NativeResult<()> {
    parse_uuid(&run.run_revision, "queue_run_id_invalid")?;
    if run.cohort_item_ids.is_empty() && run.runner_state != QueueRunnerState::Completed {
        return Err(queue_commit_invalid());
    }
    let mut cohort = HashSet::new();
    for id in &run.cohort_item_ids {
        parse_uuid(id, "queue_item_id_invalid")?;
        if !item_ids.contains(id) || !cohort.insert(id) {
            return Err(queue_commit_invalid());
        }
    }
    match run.runner_state {
        QueueRunnerState::Running | QueueRunnerState::PauseAfterCurrent
            if run.authorization_required =>
        {
            return Err(queue_commit_invalid())
        }
        QueueRunnerState::Idle
        | QueueRunnerState::Paused
        | QueueRunnerState::NeedsAttention
        | QueueRunnerState::Completed
            if !run.authorization_required =>
        {
            return Err(queue_commit_invalid())
        }
        _ => {}
    }
    Ok(())
}

fn validate_alarm(
    alarm: &NativeQueueAlarmV1,
    document: &NativeQueueDocumentV1,
    require_cohort_fixed_point: bool,
    require_delivery_slots: bool,
) -> NativeResult<()> {
    let run = document.run.as_ref().ok_or_else(queue_commit_invalid)?;
    let terminal_kind = matches!(
        alarm.kind,
        Some(QueueAlertKind::Complete | QueueAlertKind::Attention)
    );
    if (run.runner_state == QueueRunnerState::Completed) != terminal_kind {
        return Err(queue_commit_invalid());
    }
    parse_uuid(&alarm.run_revision, "queue_run_id_invalid")?;
    if alarm.run_revision != run.run_revision
        || alarm.event_id != format!("queue-complete:{}", alarm.run_revision)
    {
        return Err(NativeError::new(
            "queue_alert_event_invalid",
            "The completion alert identifier is invalid.",
        ));
    }
    validate_alert_event_id(&alarm.event_id)?;
    if matches!(alarm.state, QueueAlarmState::Snoozed) != alarm.snooze_due_at.is_some() {
        return Err(queue_commit_invalid());
    }
    if let Some(due_at) = &alarm.snooze_due_at {
        validate_timestamp(due_at)?;
    }
    if alarm.kind == Some(QueueAlertKind::Snooze)
        || matches!(alarm.state, QueueAlarmState::Armed) && alarm.kind.is_some()
        || matches!(
            alarm.state,
            QueueAlarmState::Armed | QueueAlarmState::Disarmed
        ) && (alarm.snooze_used || alarm.snooze_notification_disposition.is_some())
        || matches!(alarm.state, QueueAlarmState::Snoozed)
            && (!alarm.snooze_used || alarm.kind.is_none())
        || alarm.snooze_notification_disposition.is_some() && !alarm.snooze_used
        || matches!(
            alarm.state,
            QueueAlarmState::Ringing | QueueAlarmState::Snoozed | QueueAlarmState::Acknowledged
        ) && alarm.kind.is_none()
    {
        return Err(queue_commit_invalid());
    }
    if alarm.kind.is_none()
        && (alarm.notification_disposition.is_some()
            || alarm.snooze_notification_disposition.is_some())
    {
        return Err(queue_commit_invalid());
    }
    if alarm.kind.is_some()
        && (run.runner_state != QueueRunnerState::Completed
            || (require_cohort_fixed_point && !cohort_at_fixed_point(document, run)))
    {
        return Err(queue_commit_invalid());
    }
    if matches!(
        alarm.state,
        QueueAlarmState::Ringing | QueueAlarmState::Snoozed | QueueAlarmState::Acknowledged
    ) && alarm.kind.is_none()
    {
        return Err(queue_commit_invalid());
    }
    if alarm.state == QueueAlarmState::Disarmed
        && alarm.kind.is_some()
        && alarm.notification_disposition.is_some()
    {
        // Quiet completion deliberately records no native delivery attempt.
        return Err(queue_commit_invalid());
    }
    if require_delivery_slots && alarm_requires_delivery_slot(alarm) {
        let primary_ready = alarm.notification_disposition.is_some();
        let snooze_ready = !alarm.snooze_used || alarm.snooze_notification_disposition.is_some();
        if !primary_ready || !snooze_ready {
            return Err(queue_commit_invalid());
        }
    }
    Ok(())
}

fn validate_alarm_transition(
    previous: Option<&DiskGenerationV1>,
    next_document: &NativeQueueDocumentV1,
) -> NativeResult<()> {
    validate_alarm_transition_at(previous, next_document, current_queue_millis()?)
}

/// Kept separate from the system-clock wrapper so alarm timing has a
/// deterministic, cross-platform test seam. `now_millis` is always UTC Unix
/// milliseconds; durable due timestamps are canonical UTC milliseconds too.
fn validate_alarm_transition_at(
    previous: Option<&DiskGenerationV1>,
    next_document: &NativeQueueDocumentV1,
    now_millis: i128,
) -> NativeResult<()> {
    let Some(previous) = previous else {
        return Ok(());
    };
    let Some(previous_alarm) = previous.alarm.as_ref() else {
        return Ok(());
    };
    let previous_run = previous.run.as_ref().ok_or_else(queue_commit_invalid)?;
    let Some(next_alarm) = next_document.alarm.as_ref() else {
        // An event leaves the current slot only as the acknowledged run is
        // cleared.  It cannot be erased from a live/ringing run to bypass the
        // exact-once alarm or authorization gate.
        if previous_run.runner_state == QueueRunnerState::Completed
            && previous_alarm.state == QueueAlarmState::Acknowledged
            && next_document.run.is_none()
        {
            return Ok(());
        }
        return Err(queue_commit_invalid());
    };
    if next_alarm.run_revision != previous_alarm.run_revision {
        // validate_run_replacement has already checked that the older event
        // was acknowledged before a successor run can occupy this singleton
        // slot.
        return Ok(());
    }
    if next_alarm.event_id != previous_alarm.event_id {
        return Err(queue_commit_invalid());
    }
    let allowed_state = match previous_alarm.state {
        QueueAlarmState::Disarmed => {
            matches!(
                next_alarm.state,
                QueueAlarmState::Disarmed | QueueAlarmState::Acknowledged
            )
        }
        QueueAlarmState::Armed => matches!(
            next_alarm.state,
            QueueAlarmState::Armed | QueueAlarmState::Ringing
        ),
        QueueAlarmState::Ringing => matches!(
            next_alarm.state,
            QueueAlarmState::Ringing | QueueAlarmState::Snoozed | QueueAlarmState::Acknowledged
        ),
        QueueAlarmState::Snoozed => matches!(
            next_alarm.state,
            QueueAlarmState::Snoozed | QueueAlarmState::Ringing | QueueAlarmState::Acknowledged
        ),
        QueueAlarmState::Acknowledged => next_alarm.state == QueueAlarmState::Acknowledged,
    };
    if !allowed_state {
        return Err(queue_commit_invalid());
    }
    if previous_alarm.kind.is_some() && next_alarm.kind != previous_alarm.kind {
        return Err(queue_commit_invalid());
    }
    if previous_alarm.snooze_used && !next_alarm.snooze_used {
        return Err(queue_commit_invalid());
    }
    if previous_alarm.state == QueueAlarmState::Snoozed {
        let previous_due = previous_alarm
            .snooze_due_at
            .as_deref()
            .ok_or_else(queue_commit_invalid)?;
        match next_alarm.state {
            QueueAlarmState::Snoozed
                if next_alarm.snooze_due_at.as_deref() != Some(previous_due) =>
            {
                // The single 15-minute reminder has one immutable identity;
                // a renderer cannot extend it by repeatedly changing dueAt.
                return Err(queue_commit_invalid());
            }
            QueueAlarmState::Ringing => {
                if timestamp_millis(previous_due)? > now_millis
                    || next_alarm.snooze_notification_disposition
                        != Some(NotificationDisposition::Pending)
                {
                    // Dismiss may clear the due timestamp, but a reminder
                    // cannot ring or notify before the original due time.
                    return Err(queue_commit_invalid());
                }
            }
            _ => {}
        }
    }
    if !notification_disposition_can_advance(
        previous_alarm.notification_disposition,
        next_alarm.notification_disposition,
    ) || !notification_disposition_can_advance(
        previous_alarm.snooze_notification_disposition,
        next_alarm.snooze_notification_disposition,
    ) {
        return Err(queue_commit_invalid());
    }
    Ok(())
}

fn notification_disposition_can_advance(
    previous: Option<NotificationDisposition>,
    next: Option<NotificationDisposition>,
) -> bool {
    match previous {
        None => true,
        Some(NotificationDisposition::Pending) => matches!(
            next,
            Some(
                NotificationDisposition::Pending
                    | NotificationDisposition::Delivered
                    | NotificationDisposition::PermissionDenied
                    | NotificationDisposition::Failed
            )
        ),
        Some(NotificationDisposition::Delivered) => {
            next == Some(NotificationDisposition::Delivered)
        }
        Some(NotificationDisposition::PermissionDenied) => {
            matches!(
                next,
                Some(
                    NotificationDisposition::Delivered
                        | NotificationDisposition::PermissionDenied
                        | NotificationDisposition::Failed
                )
            )
        }
        Some(NotificationDisposition::Failed) => matches!(
            next,
            Some(
                NotificationDisposition::Delivered
                    | NotificationDisposition::PermissionDenied
                    | NotificationDisposition::Failed
            )
        ),
    }
}

fn outbox_absent_projection_is_pending_or_empty(alarm: &NativeQueueAlarmV1) -> bool {
    let primary_ok = matches!(
        alarm.notification_disposition,
        None | Some(NotificationDisposition::Pending)
    );
    let snooze_ok = matches!(
        alarm.snooze_notification_disposition,
        None | Some(NotificationDisposition::Pending)
    );
    primary_ok && snooze_ok
}

/// A native delivery record is the source of truth.  The only renderer-side
/// transition it may anticipate is a `Pending` slot which `signal_alert` has
/// not persisted yet (for example, when the snooze timer becomes due before
/// the notification command runs).  It may never manufacture a terminal
/// delivery disposition.
fn projection_matches_outbox(
    projection: Option<NotificationDisposition>,
    recorded: Option<NotificationDisposition>,
) -> bool {
    projection == recorded
        || (recorded.is_none() && projection == Some(NotificationDisposition::Pending))
}

fn alert_outbox_is_blank(outbox: &AlertOutboxV1) -> bool {
    outbox.primary_kind.is_none() && outbox.primary.is_none() && outbox.snooze.is_none()
}

fn alert_outbox_matches_alarm(outbox: &AlertOutboxV1, alarm: &NativeQueueAlarmV1) -> bool {
    if alert_outbox_is_blank(outbox) {
        return true;
    }
    match alarm.kind {
        Some(kind) => {
            outbox.primary_kind == Some(kind)
                && outbox.primary.is_some()
                && (alarm.snooze_used || outbox.snooze.is_none())
        }
        None => {
            outbox.primary_kind.is_none() && outbox.primary.is_none() && outbox.snooze.is_none()
        }
    }
}

fn outbox_missing_required_delivery_slot(
    outbox: &AlertOutboxV1,
    alarm: &NativeQueueAlarmV1,
) -> bool {
    // A renderer may persist a `Pending` projection immediately before the
    // native notification command writes its outbox slot. That narrow
    // same-process seam is allowed, but a restart must detect and repair an
    // existing partial outbox instead of treating `Pending` as a receipt.
    alarm.state == QueueAlarmState::Ringing
        && alarm.kind.is_some()
        && (outbox.primary.is_none() || (alarm.snooze_used && outbox.snooze.is_none()))
}

fn alarm_expects_alert_outbox(alarm: &NativeQueueAlarmV1) -> bool {
    alarm.kind.is_some()
        && (alarm_requires_delivery_slot(alarm)
            || alarm.notification_disposition.is_some()
            || alarm.snooze_notification_disposition.is_some())
}

fn alarm_requires_delivery_slot(alarm: &NativeQueueAlarmV1) -> bool {
    alarm.state == QueueAlarmState::Ringing
        && (alarm.notification_disposition.is_none()
            || (alarm.snooze_used && alarm.snooze_notification_disposition.is_none()))
}

fn apply_alert_outbox_projection(alarm: &mut NativeQueueAlarmV1, outbox: &AlertOutboxV1) {
    alarm.notification_disposition = outbox.primary;
    alarm.snooze_notification_disposition = outbox.snooze;
}

fn validate_run_replacement(
    current: Option<&DiskGenerationV1>,
    next: &NativeQueueDocumentV1,
) -> NativeResult<()> {
    let Some(current) = current else {
        return Ok(());
    };
    let Some(current_run) = current.run.as_ref() else {
        return Ok(());
    };
    let next_run = next.run.as_ref();
    let different =
        next_run.map(|run| run.run_revision.as_str()) != Some(current_run.run_revision.as_str());
    if !different {
        return Ok(());
    }
    if matches!(
        current_run.runner_state,
        QueueRunnerState::Running
            | QueueRunnerState::PauseAfterCurrent
            | QueueRunnerState::Paused
            | QueueRunnerState::NeedsAttention
    ) {
        return Err(NativeError::new(
            "queue_run_active",
            "A local queue run is still active or needs attention.",
        ));
    }
    if current_run.runner_state != QueueRunnerState::Completed
        || current
            .alarm
            .as_ref()
            .map_or(true, |alarm| alarm.state != QueueAlarmState::Acknowledged)
    {
        return Err(NativeError::new(
            "queue_run_active",
            "A completed local queue must be acknowledged before starting the next run.",
        ));
    }
    Ok(())
}

/// Starting a run is intentionally a two-phase local action: persist a
/// paused, authorization-required cohort first, then acquire the native lease
/// and commit Paused -> Running.  This prevents a forged durable generation
/// from surviving a restart as an already-authorized scheduler.
fn validate_new_run_admission(
    previous: Option<&NativeQueueRunV1>,
    next_document: &NativeQueueDocumentV1,
) -> NativeResult<()> {
    let Some(next) = next_document.run.as_ref() else {
        return Ok(());
    };
    if previous.is_some_and(|previous| previous.run_revision == next.run_revision) {
        return Ok(());
    }
    if next.runner_state != QueueRunnerState::Paused || !next.authorization_required {
        return Err(queue_commit_invalid());
    }
    let alarm = next_document
        .alarm
        .as_ref()
        .ok_or_else(queue_commit_invalid)?;
    if !matches!(
        alarm.state,
        QueueAlarmState::Armed | QueueAlarmState::Disarmed
    ) || alarm.kind.is_some()
        || alarm.snooze_used
        || alarm.snooze_due_at.is_some()
        || alarm.notification_disposition.is_some()
        || alarm.snooze_notification_disposition.is_some()
    {
        return Err(queue_commit_invalid());
    }
    for queue_item_id in &next.cohort_item_ids {
        let row = next_document
            .items
            .iter()
            .find(|row| match row {
                NativeQueueRowV1::Item(item) => item.queue_item_id == *queue_item_id,
                NativeQueueRowV1::Placeholder(item) => item.queue_item_id == *queue_item_id,
            })
            .ok_or_else(queue_commit_invalid)?;
        let NativeQueueRowV1::Item(item) = row else {
            return Err(queue_commit_invalid());
        };
        if item.state != QueueItemState::Staged
            || item.remote_batch_id.is_some()
            || item.attention_code.is_some()
            || item.run_revision.as_deref() != Some(next.run_revision.as_str())
        {
            return Err(queue_commit_invalid());
        }
    }
    Ok(())
}

/// The run is a singleton durable scheduler lease.  Its cohort and
/// keep-awake choice are frozen when a run starts; subsequent commits may
/// only make the explicit lifecycle moves that the foreground runner uses.
fn validate_runner_transition(
    previous: Option<&NativeQueueRunV1>,
    next_document: &NativeQueueDocumentV1,
) -> NativeResult<()> {
    let Some(previous) = previous else {
        return Ok(());
    };
    let Some(next) = next_document.run.as_ref() else {
        return Ok(());
    };
    if previous.run_revision != next.run_revision {
        // validate_run_replacement owns admission of a later run revision.
        return Ok(());
    }
    if previous.cohort_item_ids != next.cohort_item_ids || previous.keep_awake != next.keep_awake {
        return Err(queue_commit_invalid());
    }

    let allowed = match previous.runner_state {
        QueueRunnerState::Idle => matches!(
            next.runner_state,
            QueueRunnerState::Idle | QueueRunnerState::Running | QueueRunnerState::Paused
        ),
        QueueRunnerState::Running => matches!(
            next.runner_state,
            QueueRunnerState::Running
                | QueueRunnerState::PauseAfterCurrent
                | QueueRunnerState::Paused
                | QueueRunnerState::NeedsAttention
                | QueueRunnerState::Completed
        ),
        QueueRunnerState::PauseAfterCurrent => matches!(
            next.runner_state,
            QueueRunnerState::PauseAfterCurrent
                | QueueRunnerState::Paused
                | QueueRunnerState::NeedsAttention
                | QueueRunnerState::Completed
        ),
        QueueRunnerState::Paused => matches!(
            next.runner_state,
            QueueRunnerState::Paused
                | QueueRunnerState::Running
                | QueueRunnerState::NeedsAttention
                | QueueRunnerState::Completed
        ),
        QueueRunnerState::NeedsAttention => matches!(
            next.runner_state,
            QueueRunnerState::NeedsAttention
                | QueueRunnerState::Running
                | QueueRunnerState::Paused
                | QueueRunnerState::Completed
        ),
        QueueRunnerState::Completed => next.runner_state == QueueRunnerState::Completed,
    };
    if !allowed {
        return Err(queue_commit_invalid());
    }

    if next.runner_state == QueueRunnerState::Completed
        && !cohort_at_fixed_point(next_document, next)
    {
        return Err(queue_commit_invalid());
    }
    Ok(())
}

fn cohort_at_fixed_point(document: &NativeQueueDocumentV1, run: &NativeQueueRunV1) -> bool {
    !run.cohort_item_ids.is_empty()
        && run.cohort_item_ids.iter().all(|queue_item_id| {
            document.items.iter().any(|row| {
                matches!(
                    row,
                    NativeQueueRowV1::Item(item)
                        if item.queue_item_id == *queue_item_id
                            && matches!(
                                item.state,
                                QueueItemState::Completed
                                    | QueueItemState::CompletedWithFailures
                                    | QueueItemState::Cancelled
                                    | QueueItemState::Historical
                            )
                )
            })
        })
}

fn is_locked_item_state(state: QueueItemState) -> bool {
    matches!(
        state,
        QueueItemState::Dispatching
            | QueueItemState::Active
            | QueueItemState::Saving
            | QueueItemState::Historical
    )
}

fn cannot_remove_item(
    state: QueueItemState,
    previous_run: Option<&NativeQueueRunV1>,
    previous_alarm: Option<&NativeQueueAlarmV1>,
) -> bool {
    match state {
        // Clear completed from queue is an explicit expected-revision commit
        // that may remove historical rows only after this run reached its
        // fixed point. Historical rows remain locked for reordering.
        QueueItemState::Historical => {
            !(previous_run.is_some_and(|run| run.runner_state == QueueRunnerState::Completed)
                && previous_alarm.is_some_and(|alarm| alarm.state == QueueAlarmState::Acknowledged))
        }
        QueueItemState::Completed
        | QueueItemState::CompletedWithFailures
        | QueueItemState::Cancelled => true,
        _ => is_locked_item_state(state),
    }
}

fn is_locally_removable_attention_code(code: Option<&str>) -> bool {
    matches!(
        code,
        Some(
            "queue_reference_missing"
                | "queue_reference_mismatch"
                | "queue_destination_unavailable"
        )
    )
}

fn parse_uuid(value: &str, code: &'static str) -> NativeResult<Uuid> {
    let parsed = Uuid::parse_str(value)
        .map_err(|_| NativeError::new(code, "A local queue identifier is invalid."))?;
    if parsed.get_version() != Some(Version::Random) || parsed.to_string() != value {
        return Err(NativeError::new(
            code,
            "A local queue identifier is invalid.",
        ));
    }
    Ok(parsed)
}

fn validate_alert_event_id(value: &str) -> NativeResult<Uuid> {
    let Some(run) = value.strip_prefix("queue-complete:") else {
        return Err(NativeError::new(
            "queue_alert_event_invalid",
            "The completion alert identifier is invalid.",
        ));
    };
    parse_uuid(run, "queue_alert_event_invalid")
}

fn validate_sha256(value: &str) -> NativeResult<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(queue_commit_invalid());
    }
    Ok(())
}

fn is_item_record_file_name(value: &str) -> bool {
    let Some(revision) = value.strip_suffix(".json") else {
        return false;
    };
    !revision.is_empty()
        && revision.bytes().all(|byte| byte.is_ascii_digit())
        && revision
            .parse::<u64>()
            .is_ok_and(|revision| revision <= MAX_SAFE_INTEGER)
}

fn is_reference_blob_file_name(value: &str) -> bool {
    let Some((sha256, extension)) = value.rsplit_once('.') else {
        return false;
    };
    matches!(extension, "jpg" | "png" | "webp") && validate_sha256(sha256).is_ok()
}

fn extension_for_mime(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

fn ensure_safe_integer(value: u64) -> NativeResult<()> {
    (value <= MAX_SAFE_INTEGER)
        .then_some(())
        .ok_or_else(queue_commit_invalid)
}

fn validate_safe_name(value: &str) -> NativeResult<()> {
    if value.is_empty()
        || value.len() > MAX_NAME_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(queue_commit_invalid());
    }
    Ok(())
}

fn validate_timestamp(value: &str) -> NativeResult<()> {
    let bytes = value.as_bytes();
    let digits = |range: std::ops::Range<usize>| {
        bytes
            .get(range)
            .is_some_and(|slice| slice.iter().all(u8::is_ascii_digit))
    };
    let shape = bytes.len() == 24
        && digits(0..4)
        && bytes.get(4) == Some(&b'-')
        && digits(5..7)
        && bytes.get(7) == Some(&b'-')
        && digits(8..10)
        && bytes.get(10) == Some(&b'T')
        && digits(11..13)
        && bytes.get(13) == Some(&b':')
        && digits(14..16)
        && bytes.get(16) == Some(&b':')
        && digits(17..19)
        && bytes.get(19) == Some(&b'.')
        && digits(20..23)
        && bytes.get(23) == Some(&b'Z');
    if !shape {
        return Err(queue_commit_invalid());
    }
    let number = |range: std::ops::Range<usize>| -> Option<u32> {
        std::str::from_utf8(bytes.get(range)?).ok()?.parse().ok()
    };
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        number(0..4),
        number(5..7),
        number(8..10),
        number(11..13),
        number(14..16),
        number(17..19),
    ) else {
        return Err(queue_commit_invalid());
    };
    let maximum_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => return Err(queue_commit_invalid()),
    };
    if year == 0 || !(1..=maximum_day).contains(&day) || hour > 23 || minute > 59 || second > 59 {
        return Err(queue_commit_invalid());
    }
    Ok(())
}

fn current_queue_millis() -> NativeResult<i128> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| queue_store_unavailable())?;
    Ok(elapsed.as_millis() as i128)
}

fn timestamp_millis(value: &str) -> NativeResult<i128> {
    validate_timestamp(value)?;
    let bytes = value.as_bytes();
    let number = |start: usize, end: usize| -> i128 {
        bytes[start..end]
            .iter()
            .fold(0_i128, |value, byte| value * 10 + i128::from(byte - b'0'))
    };
    let year = number(0, 4);
    let month = number(5, 7);
    let day = number(8, 10);
    let hour = number(11, 13);
    let minute = number(14, 16);
    let second = number(17, 19);
    let millisecond = number(20, 23);

    // Howard Hinnant's civil-date conversion, with 1970-01-01 as day zero.
    let adjusted_year = year - if month <= 2 { 1 } else { 0 };
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days_since_epoch = era * 146_097 + day_of_era - 719_468;
    Ok((((days_since_epoch * 24 + hour) * 60 + minute) * 60 + second) * 1_000 + millisecond)
}

fn is_leap_year(year: u32) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

fn fixed_alert_copy(event_id: &str, kind: QueueAlertKind) -> AlertCopy {
    let (title, body) = match kind {
        QueueAlertKind::Complete => (
            "ImageForge queue complete",
            "All staged batches finished. The GPU is still running.",
        ),
        QueueAlertKind::Attention => (
            "ImageForge queue finished with attention needed",
            "All staged batches finished, but some images need review. The GPU is still running.",
        ),
        QueueAlertKind::Snooze => (
            "ImageForge queue reminder",
            "Your completed queue is still waiting. The GPU may still be running.",
        ),
    };
    AlertCopy {
        notification_id: notification_id_for(event_id, kind),
        title,
        body,
    }
}

fn notification_id_for(event_id: &str, kind: QueueAlertKind) -> i32 {
    let source = if kind == QueueAlertKind::Snooze {
        format!("{event_id}:snooze")
    } else {
        event_id.to_owned()
    };
    let hash = Sha256::digest(source.as_bytes());
    let mut value = u32::from_be_bytes([hash[0], hash[1], hash[2], hash[3]]) & 0x7fff_ffff;
    if value == 0 {
        value = 1;
    }
    value as i32
}

fn default_queue_root() -> NativeResult<PathBuf> {
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|path| path.join("Library").join("Application Support"));
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base = Some(std::env::temp_dir());
    base.map(|path| path.join("com.imageforge.desktop").join("queue").join("v1"))
        .ok_or_else(queue_store_unavailable)
}

fn ensure_directory(path: &Path) -> NativeResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(queue_store_unavailable())
        }
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(queue_store_unavailable()),
    }
    fs::create_dir_all(path).map_err(|_| queue_store_unavailable())?;
    let metadata = fs::symlink_metadata(path).map_err(|_| queue_store_unavailable())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(queue_store_unavailable());
    }
    if let Some(parent) = path.parent() {
        sync_directory(parent).map_err(|_| queue_store_unavailable())?;
    }
    Ok(())
}

fn read_limited(path: &Path, maximum: u64) -> std::io::Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > maximum {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "unsafe queue file",
        ));
    }
    let mut file = File::open(path)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(maximum + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "oversized queue file",
        ));
    }
    Ok(bytes)
}

fn write_immutable_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "missing queue parent")
    })?;
    ensure_directory_io(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("queue"),
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
        move_file_no_replace(&temporary, path)?;
        sync_directory(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_replace_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "missing queue parent")
    })?;
    ensure_directory_io(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("queue"),
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
        sync_directory(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn ensure_directory_io(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "unsafe queue directory",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn move_file_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    // `hard_link` is atomic and refuses an existing destination on the local
    // app-data volume. It also keeps the source until the link is durable.
    fs::hard_link(source, destination)?;
    fs::remove_file(source)
}

#[cfg(windows)]
fn move_file_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
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
fn move_file_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    if destination.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "queue file exists",
        ));
    }
    fs::rename(source, destination)
}

#[cfg(unix)]
fn replace_file_atomic(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
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

#[cfg(not(any(unix, windows)))]
fn replace_file_atomic(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn sync_directory(_directory: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(not(windows))]
fn sync_directory(directory: &Path) -> std::io::Result<()> {
    File::open(directory)?.sync_all()
}

/// Queue-specific wrapper around the generic hardened native file lease.
pub(crate) struct RunnerFileLock {
    _lease: NativeFileLock,
}

impl RunnerFileLock {
    pub(crate) fn try_acquire(path: &Path) -> NativeResult<Option<Self>> {
        NativeFileLock::try_acquire(path)
            .map(|lease| lease.map(|lease| Self { _lease: lease }))
            .map_err(|_| queue_store_unavailable())
    }

    /// Only used for the tiny startup-repair critical section, never for an
    /// active generation lease. A bounded wait gives a sibling app process
    /// time to finish its atomic pause/re-read before this process observes
    /// the journal, avoiding two writers racing a stale Running state.
    fn acquire_blocking(path: &Path) -> NativeResult<Self> {
        for _ in 0..5_000 {
            if let Some(lock) = Self::try_acquire(path)? {
                return Ok(lock);
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        Err(queue_store_unavailable())
    }
}

fn queue_store_unavailable() -> NativeError {
    NativeError::new(
        "queue_store_unavailable",
        "The private local queue store is unavailable.",
    )
}

fn gpu_switch_queue_reservation_conflict() -> NativeError {
    NativeError::new(
        "gpu_switch_queue_reservation_conflict",
        "The local queue changed before ImageForge could reserve it for this GPU switch.",
    )
}

fn queue_commit_invalid() -> NativeError {
    NativeError::new(
        "queue_commit_invalid",
        "The local queue change is invalid and was not saved.",
    )
}

fn queue_placeholder_invalid() -> NativeError {
    NativeError::new(
        "queue_item_corrupt",
        "A corrupted queue row can only be repaired or removed through an explicit recovery flow.",
    )
}

fn queue_destination_unavailable() -> NativeError {
    NativeError::new(
        "queue_destination_unavailable",
        "The staged downloads folder is unavailable. Choose and verify it again before dispatching.",
    )
}

fn alert_outbox_corrupt() -> NativeError {
    NativeError::new(
        "queue_alert_outbox_invalid",
        "The local completion-alert history is unavailable. The queue was not changed.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, RgbaImage};
    use std::io::Cursor;

    fn timestamp() -> String {
        "2026-08-03T12:34:56.789Z".to_owned()
    }

    fn png() -> Vec<u8> {
        let mut bytes = Vec::new();
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(2, 2, image::Rgba([1, 2, 3, 255])))
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .unwrap();
        bytes
    }

    fn destination() -> (tempfile::TempDir, DestinationStore, String) {
        let temporary = tempfile::tempdir().unwrap();
        let downloads = temporary.path().join("downloads");
        fs::create_dir(&downloads).unwrap();
        let destination = DestinationStore::new_for_test(temporary.path().join("destination.json"));
        // The renderer receives the canonical visible path returned by the
        // native chooser validation. On macOS, the raw tempfile path may use
        // `/var/...` while the bound root canonically lives under
        // `/private/var/...`; using the raw fixture path would correctly be
        // rejected as a forged/replaced destination.
        let metadata = destination.validate_and_bind(&downloads).unwrap();
        (temporary, destination, metadata.path)
    }

    fn item(destination: String, reference: Option<NativeQueueReferenceV1>) -> NativeQueueItemV1 {
        NativeQueueItemV1 {
            schema_version: 1,
            queue_item_id: Uuid::new_v4().to_string(),
            client_submission_id: Uuid::new_v4().to_string(),
            record_revision: 0,
            run_revision: None,
            remote_batch_id: None,
            state: QueueItemState::Staged,
            attention_code: None,
            name: "Night shots".to_owned(),
            prompts: vec!["soft neon city".to_owned()],
            base_seed: 42,
            destination,
            aspect_ratio: "16:9".to_owned(),
            style_suffix: None,
            references: reference.into_iter().collect(),
            created_at: timestamp(),
            updated_at: timestamp(),
        }
    }

    fn commit_for(
        item: NativeQueueItemV1,
        blobs: Vec<NativeReferenceBlobV1>,
    ) -> NativeQueueCommitV1 {
        NativeQueueCommitV1 {
            expected_revision: 0,
            document: NativeQueueDocumentV1 {
                schema_version: 1,
                items: vec![NativeQueueRowV1::Item(item)],
                run: None,
                alarm: None,
            },
            reference_blobs: blobs,
        }
    }

    /// Mirror the two durable foreground actions for a new run: stage the
    /// renderer-owned row first, then freeze that already-staged row into a
    /// paused, authorization-required cohort. A new row may never arrive
    /// pre-assigned to a run, even in a test fixture.
    fn stage_and_start_paused_run(
        store: &QueueStore,
        staged: NativeQueueItemV1,
        run: &str,
    ) -> NativeQueueSnapshotV1 {
        let snapshot = store.commit(commit_for(staged, vec![])).unwrap();
        let mut document = snapshot.document.clone();
        let NativeQueueRowV1::Item(queued) = &mut document.items[0] else {
            panic!("staged row")
        };
        queued.record_revision += 1;
        queued.run_revision = Some(run.to_owned());
        let queue_item_id = queued.queue_item_id.clone();
        document.run = Some(NativeQueueRunV1 {
            run_revision: run.to_owned(),
            cohort_item_ids: vec![queue_item_id],
            runner_state: QueueRunnerState::Paused,
            authorization_required: true,
            keep_awake: false,
        });
        document.alarm = Some(NativeQueueAlarmV1 {
            event_id: format!("queue-complete:{run}"),
            run_revision: run.to_owned(),
            state: QueueAlarmState::Disarmed,
            kind: None,
            snooze_used: false,
            snooze_due_at: None,
            notification_disposition: None,
            snooze_notification_disposition: None,
        });
        store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap()
    }

    /// Materialize the crash/restart seam directly: the durable generation
    /// says native delivery reached a terminal disposition, while its private
    /// alert outbox has been lost.  A renderer must never be able to make the
    /// same projection through `commit`, so this fixture writes the old disk
    /// shape without an outbox record.
    fn persist_terminal_alarm_without_outbox(
        store: &QueueStore,
        destination: String,
        snooze_used: bool,
    ) -> String {
        let run = Uuid::new_v4().to_string();
        let event_id = format!("queue-complete:{run}");
        let mut completed = item(destination, None);
        completed.run_revision = Some(run.clone());
        completed.remote_batch_id = Some(Uuid::new_v4().to_string());
        completed.state = QueueItemState::Completed;
        let binding = store
            .destination
            .capture_queue_destination(&completed.destination)
            .unwrap();
        store.ensure_layout().unwrap();
        store
            .write_item_records(
                &[DiskItemRecordV1 {
                    schema_version: SCHEMA_VERSION,
                    item: completed.clone(),
                    destination_binding: binding,
                }],
                &HashMap::new(),
            )
            .unwrap();
        store
            .write_generation(&DiskGenerationV1 {
                schema_version: SCHEMA_VERSION,
                store_revision: 1,
                items: vec![index_for_item(&completed)],
                run: Some(NativeQueueRunV1 {
                    run_revision: run.clone(),
                    cohort_item_ids: vec![completed.queue_item_id],
                    runner_state: QueueRunnerState::Completed,
                    authorization_required: true,
                    keep_awake: false,
                }),
                alarm: Some(NativeQueueAlarmV1 {
                    event_id: event_id.clone(),
                    run_revision: run,
                    state: QueueAlarmState::Ringing,
                    kind: Some(QueueAlertKind::Complete),
                    snooze_used,
                    snooze_due_at: None,
                    notification_disposition: Some(NotificationDisposition::Delivered),
                    snooze_notification_disposition: snooze_used
                        .then_some(NotificationDisposition::Delivered),
                }),
            })
            .unwrap();
        store.write_current(1).unwrap();
        event_id
    }

    fn persist_runner_admission_fixture(
        store: &QueueStore,
        destination: String,
        runner_state: QueueRunnerState,
    ) -> String {
        let run = Uuid::new_v4().to_string();
        let mut staged = item(destination, None);
        staged.run_revision = Some(run.clone());
        let binding = store
            .destination
            .capture_queue_destination(&staged.destination)
            .unwrap();
        store.ensure_layout().unwrap();
        store
            .write_item_records(
                &[DiskItemRecordV1 {
                    schema_version: SCHEMA_VERSION,
                    item: staged.clone(),
                    destination_binding: binding,
                }],
                &HashMap::new(),
            )
            .unwrap();
        store
            .write_generation(&DiskGenerationV1 {
                schema_version: SCHEMA_VERSION,
                store_revision: 1,
                items: vec![index_for_item(&staged)],
                run: Some(NativeQueueRunV1 {
                    run_revision: run.clone(),
                    cohort_item_ids: vec![staged.queue_item_id],
                    runner_state,
                    authorization_required: !matches!(
                        runner_state,
                        QueueRunnerState::Running | QueueRunnerState::PauseAfterCurrent
                    ),
                    keep_awake: false,
                }),
                alarm: Some(NativeQueueAlarmV1 {
                    event_id: format!("queue-complete:{run}"),
                    run_revision: run.clone(),
                    state: QueueAlarmState::Disarmed,
                    kind: None,
                    snooze_used: false,
                    snooze_due_at: None,
                    notification_disposition: None,
                    snooze_notification_disposition: None,
                }),
            })
            .unwrap();
        store.write_current(1).unwrap();
        run
    }

    fn rewrite_record_and_rebind_index(store: &QueueStore, record: DiskItemRecordV1) {
        let item_id = parse_uuid(&record.item.queue_item_id, "queue_item_id_invalid").unwrap();
        let record_path = store
            .item_path(item_id, record.item.record_revision)
            .unwrap();
        fs::write(record_path, serde_json::to_vec(&record).unwrap()).unwrap();
        let revision = store.read_current().unwrap().unwrap();
        let generation_path = store.generation_path(revision).unwrap();
        let mut generation: DiskGenerationV1 =
            serde_json::from_slice(&fs::read(&generation_path).unwrap()).unwrap();
        let pointer = generation
            .items
            .iter_mut()
            .find(|pointer| pointer.queue_item_id == record.item.queue_item_id)
            .unwrap();
        pointer.content_hash = queue_item_content_hash(&record.item);
        fs::write(generation_path, serde_json::to_vec(&generation).unwrap()).unwrap();
    }

    #[test]
    fn strict_wire_ids_timestamps_and_seeds_are_enforced() {
        let (_, _, destination_path) = destination();
        let mut candidate = item(destination_path, None);
        candidate.queue_item_id = candidate.queue_item_id.to_uppercase();
        assert_eq!(
            validate_queue_item(&candidate).unwrap_err().code,
            "queue_item_id_invalid"
        );
        let (_, _, destination_path) = destination();
        let mut candidate = item(destination_path, None);
        candidate.base_seed = MAX_SAFE_INTEGER;
        candidate.prompts.push("second".to_owned());
        assert_eq!(
            validate_queue_item(&candidate).unwrap_err().code,
            "queue_commit_invalid"
        );
        let (_, _, destination_path) = destination();
        let mut candidate = item(destination_path, None);
        candidate.created_at = "not-a-time".to_owned();
        assert_eq!(
            validate_queue_item(&candidate).unwrap_err().code,
            "queue_commit_invalid"
        );
    }

    #[test]
    fn queue_state_fields_and_prior_transitions_are_enforced() {
        let (_, _, destination) = destination();
        let run = Uuid::new_v4().to_string();
        let mut previous = item(destination, None);
        previous.run_revision = Some(run.clone());
        let item_id = previous.queue_item_id.clone();
        let current_run = NativeQueueRunV1 {
            run_revision: run.clone(),
            cohort_item_ids: vec![item_id],
            runner_state: QueueRunnerState::Running,
            authorization_required: false,
            keep_awake: false,
        };

        let mut impossible = previous.clone();
        impossible.record_revision += 1;
        impossible.state = QueueItemState::Active;
        impossible.remote_batch_id = Some(Uuid::new_v4().to_string());
        assert_eq!(
            validate_item_transition(&previous, &impossible, Some(&current_run), None)
                .unwrap_err()
                .code,
            "queue_commit_invalid"
        );

        let mut attention = previous.clone();
        attention.record_revision += 1;
        attention.state = QueueItemState::NeedsAttention;
        attention.attention_code = Some("queue_pod_offline".to_owned());
        assert!(validate_queue_item(&attention).is_ok());
        assert!(validate_item_transition(&previous, &attention, Some(&current_run), None).is_ok());

        let mut skipped_revision = attention.clone();
        skipped_revision.record_revision += 2;
        assert_eq!(
            validate_item_transition(&previous, &skipped_revision, Some(&current_run), None)
                .unwrap_err()
                .code,
            "queue_commit_invalid"
        );

        let mut repaired = attention.clone();
        repaired.record_revision += 1;
        repaired.state = QueueItemState::Staged;
        repaired.attention_code = None;
        assert!(validate_item_transition(&attention, &repaired, Some(&current_run), None).is_ok());

        let mut redispatch = attention.clone();
        redispatch.record_revision += 1;
        redispatch.state = QueueItemState::Dispatching;
        redispatch.attention_code = None;
        assert!(
            validate_item_transition(&attention, &redispatch, Some(&current_run), None).is_ok()
        );

        let mut dispatching = previous.clone();
        dispatching.record_revision += 1;
        dispatching.state = QueueItemState::Dispatching;
        let mut interrupted = dispatching.clone();
        interrupted.record_revision += 1;
        interrupted.state = QueueItemState::Interrupted;
        interrupted.remote_batch_id = Some(Uuid::new_v4().to_string());
        interrupted.attention_code = Some("queue_batch_interrupted".to_owned());
        assert!(
            validate_item_transition(&dispatching, &interrupted, Some(&current_run), None).is_ok()
        );
        let mut cancelled = dispatching.clone();
        cancelled.record_revision += 1;
        cancelled.state = QueueItemState::Cancelled;
        assert!(
            validate_item_transition(&dispatching, &cancelled, Some(&current_run), None).is_ok()
        );

        let mut missing_remote = previous.clone();
        missing_remote.state = QueueItemState::Active;
        assert_eq!(
            validate_queue_item(&missing_remote).unwrap_err().code,
            "queue_commit_invalid"
        );
        let mut missing_attention = previous.clone();
        missing_attention.state = QueueItemState::Interrupted;
        missing_attention.remote_batch_id = Some(Uuid::new_v4().to_string());
        assert_eq!(
            validate_queue_item(&missing_attention).unwrap_err().code,
            "queue_commit_invalid"
        );
    }

    #[test]
    fn commit_rejects_a_skipped_item_record_revision() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let snapshot = store
            .commit(commit_for(item(destination_path, None), vec![]))
            .unwrap();
        let mut document = snapshot.document.clone();
        let NativeQueueRowV1::Item(item) = &mut document.items[0] else {
            panic!("test row")
        };
        item.record_revision += 2;
        assert_eq!(
            store
                .commit(NativeQueueCommitV1 {
                    expected_revision: snapshot.store_revision,
                    document,
                    reference_blobs: vec![],
                })
                .unwrap_err()
                .code,
            "queue_commit_invalid"
        );
    }

    #[test]
    fn completed_rows_require_acknowledgement_before_history() {
        let (_, _, destination) = destination();
        let run = Uuid::new_v4().to_string();
        let mut completed = item(destination, None);
        completed.run_revision = Some(run.clone());
        completed.remote_batch_id = Some(Uuid::new_v4().to_string());
        completed.state = QueueItemState::Completed;
        let current_run = NativeQueueRunV1 {
            run_revision: run.clone(),
            cohort_item_ids: vec![completed.queue_item_id.clone()],
            runner_state: QueueRunnerState::Completed,
            authorization_required: true,
            keep_awake: false,
        };
        let mut historical = completed.clone();
        historical.record_revision += 1;
        historical.state = QueueItemState::Historical;
        let ringing = NativeQueueAlarmV1 {
            event_id: format!("queue-complete:{run}"),
            run_revision: run.clone(),
            state: QueueAlarmState::Ringing,
            kind: Some(QueueAlertKind::Complete),
            snooze_used: false,
            snooze_due_at: None,
            notification_disposition: Some(NotificationDisposition::Delivered),
            snooze_notification_disposition: None,
        };
        assert_eq!(
            validate_item_transition(&completed, &historical, Some(&current_run), Some(&ringing))
                .unwrap_err()
                .code,
            "queue_item_locked"
        );
        let mut acknowledged = ringing;
        acknowledged.state = QueueAlarmState::Acknowledged;
        assert!(validate_item_transition(
            &completed,
            &historical,
            Some(&current_run),
            Some(&acknowledged)
        )
        .is_ok());
    }

    #[test]
    fn runner_lifecycle_requires_fixed_point_before_completion() {
        let (_, _, destination) = destination();
        let run_id = Uuid::new_v4().to_string();
        let mut queued = item(destination, None);
        queued.run_revision = Some(run_id.clone());
        let previous = NativeQueueRunV1 {
            run_revision: run_id.clone(),
            cohort_item_ids: vec![queued.queue_item_id.clone()],
            runner_state: QueueRunnerState::Running,
            authorization_required: false,
            keep_awake: false,
        };
        let mut next_run = previous.clone();
        next_run.runner_state = QueueRunnerState::Completed;
        next_run.authorization_required = true;
        let mut document = NativeQueueDocumentV1 {
            schema_version: 1,
            items: vec![NativeQueueRowV1::Item(queued.clone())],
            run: Some(next_run.clone()),
            alarm: None,
        };
        assert_eq!(
            validate_runner_transition(Some(&previous), &document)
                .unwrap_err()
                .code,
            "queue_commit_invalid"
        );

        let NativeQueueRowV1::Item(item) = &mut document.items[0] else {
            panic!("test row")
        };
        item.state = QueueItemState::Completed;
        item.remote_batch_id = Some(Uuid::new_v4().to_string());
        assert!(validate_runner_transition(Some(&previous), &document).is_ok());

        let mut paused = previous;
        paused.runner_state = QueueRunnerState::Paused;
        paused.authorization_required = true;
        let mut invalid = paused.clone();
        invalid.runner_state = QueueRunnerState::PauseAfterCurrent;
        invalid.authorization_required = false;
        document.run = Some(invalid);
        assert_eq!(
            validate_runner_transition(Some(&paused), &document)
                .unwrap_err()
                .code,
            "queue_commit_invalid"
        );
    }

    #[test]
    fn journal_commits_references_before_generation_and_survives_reload() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let bytes = png();
        let sha256 = hex::encode(Sha256::digest(&bytes));
        let reference = NativeQueueReferenceV1 {
            id: Uuid::new_v4().to_string(),
            name: "style.png".to_owned(),
            mime_type: "image/png".to_owned(),
            size_bytes: bytes.len() as u64,
            sha256: sha256.clone(),
        };
        let snapshot = store
            .commit(commit_for(
                item(destination_path, Some(reference)),
                vec![NativeReferenceBlobV1 {
                    sha256: sha256.clone(),
                    mime_type: "image/png".to_owned(),
                    size_bytes: bytes.len() as u64,
                    bytes,
                }],
            ))
            .unwrap();
        assert_eq!(snapshot.store_revision, 1);
        assert!(store.root.join("CURRENT").is_file());
        assert!(store.root.join("generations/1.json").is_file());
        assert!(store
            .root
            .join(format!("references/{sha256}.png"))
            .is_file());
        assert_eq!(store.load().unwrap().document.items.len(), 1);
    }

    #[test]
    fn corrupt_current_recovers_last_valid_generation_without_removing_files() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        store
            .commit(commit_for(item(destination_path, None), vec![]))
            .unwrap();
        fs::write(store.root.join("CURRENT"), b"bad\n").unwrap();
        let snapshot = store.load().unwrap();
        assert_eq!(snapshot.store_revision, 1);
        assert_eq!(snapshot.issues[0].code, "queue_store_recovered");
        assert!(store.root.join("CURRENT").exists());
    }

    #[test]
    fn corrupt_item_becomes_a_placeholder_while_other_rows_load() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let first = item(destination_path.clone(), None);
        let second = item(destination_path, None);
        let snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: 0,
                document: NativeQueueDocumentV1 {
                    schema_version: 1,
                    items: vec![
                        NativeQueueRowV1::Item(first.clone()),
                        NativeQueueRowV1::Item(second.clone()),
                    ],
                    run: None,
                    alarm: None,
                },
                reference_blobs: vec![],
            })
            .unwrap();
        fs::write(
            store
                .root
                .join("items")
                .join(&first.queue_item_id)
                .join(format!("{}.json", first.record_revision)),
            b"{not-json",
        )
        .unwrap();
        let loaded = store.load().unwrap();
        assert_eq!(loaded.store_revision, snapshot.store_revision);
        assert!(matches!(
            loaded.document.items[0],
            NativeQueueRowV1::Placeholder(_)
        ));
        assert!(matches!(
            loaded.document.items[1],
            NativeQueueRowV1::Item(_)
        ));
    }

    #[test]
    fn tampered_reference_only_parks_its_item() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let bytes = png();
        let sha256 = hex::encode(Sha256::digest(&bytes));
        let reference = NativeQueueReferenceV1 {
            id: Uuid::new_v4().to_string(),
            name: "style.png".to_owned(),
            mime_type: "image/png".to_owned(),
            size_bytes: bytes.len() as u64,
            sha256: sha256.clone(),
        };
        store
            .commit(commit_for(
                item(destination_path, Some(reference)),
                vec![NativeReferenceBlobV1 {
                    sha256: sha256.clone(),
                    mime_type: "image/png".to_owned(),
                    size_bytes: bytes.len() as u64,
                    bytes,
                }],
            ))
            .unwrap();
        fs::write(store.root.join(format!("references/{sha256}.png")), b"bad").unwrap();
        let loaded = store.load().unwrap();
        let NativeQueueRowV1::Item(item) = &loaded.document.items[0] else {
            panic!("item")
        };
        assert_eq!(item.state, QueueItemState::NeedsAttention);
        assert_eq!(
            item.attention_code.as_deref(),
            Some("queue_reference_mismatch")
        );
    }

    #[test]
    fn projected_reference_issue_can_be_carried_forward_or_removed_when_unassigned() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let bytes = png();
        let sha256 = hex::encode(Sha256::digest(&bytes));
        let reference = NativeQueueReferenceV1 {
            id: Uuid::new_v4().to_string(),
            name: "style.png".to_owned(),
            mime_type: "image/png".to_owned(),
            size_bytes: bytes.len() as u64,
            sha256: sha256.clone(),
        };
        store
            .commit(commit_for(
                item(destination_path.clone(), Some(reference)),
                vec![NativeReferenceBlobV1 {
                    sha256: sha256.clone(),
                    mime_type: "image/png".to_owned(),
                    size_bytes: bytes.len() as u64,
                    bytes,
                }],
            ))
            .unwrap();
        fs::write(store.root.join(format!("references/{sha256}.png")), b"bad").unwrap();

        let loaded = store.load().unwrap();
        let mut unrelated = loaded.document.clone();
        unrelated
            .items
            .push(NativeQueueRowV1::Item(item(destination_path, None)));
        let carried = store
            .commit(NativeQueueCommitV1 {
                expected_revision: loaded.store_revision,
                document: unrelated,
                reference_blobs: vec![],
            })
            .unwrap();
        assert_eq!(carried.document.items.len(), 2);

        // The projected local-reference failure must survive an unrelated
        // generation commit/restart instead of turning into a stale index
        // hash or a broad store failure.
        let restarted =
            QueueStore::new_for_test(store.root.as_ref().clone(), store.destination.clone());
        let restarted_snapshot = restarted.load().unwrap();
        let NativeQueueRowV1::Item(projected) = &restarted_snapshot.document.items[0] else {
            panic!("projected reference item")
        };
        assert_eq!(projected.state, QueueItemState::NeedsAttention);
        assert_eq!(
            projected.attention_code.as_deref(),
            Some("queue_reference_mismatch")
        );

        let mut removed = restarted_snapshot.document.clone();
        removed.items.remove(0);
        let removed = restarted
            .commit(NativeQueueCommitV1 {
                expected_revision: restarted_snapshot.store_revision,
                document: removed,
                reference_blobs: vec![],
            })
            .unwrap();
        assert_eq!(removed.document.items.len(), 1);
    }

    #[test]
    fn foreground_reference_repair_replaces_only_the_matching_corrupt_blob() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let bytes = png();
        let sha256 = hex::encode(Sha256::digest(&bytes));
        let reference = NativeQueueReferenceV1 {
            id: Uuid::new_v4().to_string(),
            name: "style.png".to_owned(),
            mime_type: "image/png".to_owned(),
            size_bytes: bytes.len() as u64,
            sha256: sha256.clone(),
        };
        store
            .commit(commit_for(
                item(destination_path, Some(reference)),
                vec![NativeReferenceBlobV1 {
                    sha256: sha256.clone(),
                    mime_type: "image/png".to_owned(),
                    size_bytes: bytes.len() as u64,
                    bytes: bytes.clone(),
                }],
            ))
            .unwrap();
        fs::write(store.root.join(format!("references/{sha256}.png")), b"bad").unwrap();
        let damaged = store.load().unwrap();
        let mut repaired_document = damaged.document.clone();
        let NativeQueueRowV1::Item(row) = &mut repaired_document.items[0] else {
            panic!("reference row")
        };
        assert_eq!(
            row.attention_code.as_deref(),
            Some("queue_reference_mismatch")
        );
        row.record_revision += 1;
        row.state = QueueItemState::Staged;
        row.attention_code = None;
        let repaired = store
            .commit(NativeQueueCommitV1 {
                expected_revision: damaged.store_revision,
                document: repaired_document,
                reference_blobs: vec![NativeReferenceBlobV1 {
                    sha256: sha256.clone(),
                    mime_type: "image/png".to_owned(),
                    size_bytes: bytes.len() as u64,
                    bytes: bytes.clone(),
                }],
            })
            .unwrap();
        let NativeQueueRowV1::Item(row) = &repaired.document.items[0] else {
            panic!("repaired row")
        };
        assert_eq!(row.state, QueueItemState::Staged);
        assert_eq!(
            fs::read(store.root.join(format!("references/{sha256}.png"))).unwrap(),
            bytes
        );
    }

    #[test]
    fn only_provable_local_damage_can_be_cancelled_under_the_exact_runner_lease() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let run = persist_runner_admission_fixture(
            &store,
            destination_path.clone(),
            QueueRunnerState::Paused,
        );
        let mut snapshot = store.load().unwrap();
        store
            .acquire_runner(NativeRunKey {
                run_revision: run.clone(),
            })
            .unwrap();
        fs::remove_dir(&destination_path).unwrap();

        let mut document = snapshot.document.clone();
        let NativeQueueRowV1::Item(row) = &mut document.items[0] else {
            panic!("queue row")
        };
        row.record_revision += 1;
        row.state = QueueItemState::NeedsAttention;
        row.attention_code = Some("queue_destination_unavailable".to_owned());
        snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();

        let mut document = snapshot.document.clone();
        let NativeQueueRowV1::Item(row) = &mut document.items[0] else {
            panic!("queue row")
        };
        row.record_revision += 1;
        row.state = QueueItemState::Cancelled;
        row.attention_code = None;
        let cancelled = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();
        let NativeQueueRowV1::Item(cancelled_row) = &cancelled.document.items[0] else {
            panic!("cancelled row")
        };
        assert_eq!(cancelled_row.state, QueueItemState::Cancelled);
        store
            .release_runner(NativeRunKey { run_revision: run })
            .unwrap();

        let (temporary, destination_store, destination_path) = destination();
        let ambiguous =
            QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let run = persist_runner_admission_fixture(
            &ambiguous,
            destination_path,
            QueueRunnerState::Paused,
        );
        let mut snapshot = ambiguous.load().unwrap();
        ambiguous
            .acquire_runner(NativeRunKey {
                run_revision: run.clone(),
            })
            .unwrap();
        let mut document = snapshot.document.clone();
        let NativeQueueRowV1::Item(row) = &mut document.items[0] else {
            panic!("queue row")
        };
        row.record_revision += 1;
        row.state = QueueItemState::NeedsAttention;
        row.attention_code = Some("submission_uncertain".to_owned());
        snapshot = ambiguous
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();
        let mut document = snapshot.document.clone();
        let NativeQueueRowV1::Item(row) = &mut document.items[0] else {
            panic!("queue row")
        };
        row.record_revision += 1;
        row.state = QueueItemState::Cancelled;
        row.attention_code = None;
        assert_eq!(
            ambiguous
                .commit(NativeQueueCommitV1 {
                    expected_revision: snapshot.store_revision,
                    document,
                    reference_blobs: vec![],
                })
                .unwrap_err()
                .code,
            "queue_item_locked"
        );
    }

    #[test]
    fn record_index_hash_quarantines_tampered_immutable_content_only() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let first = item(destination_path.clone(), None);
        let second = item(destination_path, None);
        store
            .commit(NativeQueueCommitV1 {
                expected_revision: 0,
                document: NativeQueueDocumentV1 {
                    schema_version: SCHEMA_VERSION,
                    items: vec![
                        NativeQueueRowV1::Item(first.clone()),
                        NativeQueueRowV1::Item(second.clone()),
                    ],
                    run: None,
                    alarm: None,
                },
                reference_blobs: vec![],
            })
            .unwrap();
        let record_path = store
            .item_path(
                parse_uuid(&first.queue_item_id, "queue_item_id_invalid").unwrap(),
                first.record_revision,
            )
            .unwrap();
        let mut record: DiskItemRecordV1 =
            serde_json::from_slice(&fs::read(record_path).unwrap()).unwrap();
        record.item.prompts = vec!["tampered but still valid prompt".to_owned()];
        // Deliberately leave the generation hash untouched: a valid-schema
        // record cannot rewrite prompt content after staging.
        fs::write(
            store
                .item_path(
                    parse_uuid(&first.queue_item_id, "queue_item_id_invalid").unwrap(),
                    first.record_revision,
                )
                .unwrap(),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();

        let loaded = store.load().unwrap();
        assert!(matches!(
            loaded.document.items[0],
            NativeQueueRowV1::Placeholder(_)
        ));
        assert!(matches!(
            loaded.document.items[1],
            NativeQueueRowV1::Item(_)
        ));
    }

    #[test]
    fn destination_binding_mismatch_is_quarantined_without_losing_other_rows() {
        let (temporary, destination_store, destination_path) = destination();
        let replacement_destination = temporary.path().join("replacement-downloads");
        fs::create_dir(&replacement_destination).unwrap();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let first = item(destination_path.clone(), None);
        let second = item(destination_path, None);
        store
            .commit(NativeQueueCommitV1 {
                expected_revision: 0,
                document: NativeQueueDocumentV1 {
                    schema_version: SCHEMA_VERSION,
                    items: vec![
                        NativeQueueRowV1::Item(first.clone()),
                        NativeQueueRowV1::Item(second.clone()),
                    ],
                    run: None,
                    alarm: None,
                },
                reference_blobs: vec![],
            })
            .unwrap();
        let path = store
            .item_path(
                parse_uuid(&first.queue_item_id, "queue_item_id_invalid").unwrap(),
                first.record_revision,
            )
            .unwrap();
        let mut record: DiskItemRecordV1 =
            serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        record.item.destination = replacement_destination.to_string_lossy().into_owned();
        rewrite_record_and_rebind_index(&store, record);

        let loaded = store.load().unwrap();
        assert!(matches!(
            loaded.document.items[0],
            NativeQueueRowV1::Placeholder(_)
        ));
        assert!(matches!(
            loaded.document.items[1],
            NativeQueueRowV1::Item(_)
        ));
    }

    #[test]
    fn semantically_impossible_record_is_projected_before_the_renderer_sees_it() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let first = item(destination_path.clone(), None);
        let second = item(destination_path, None);
        store
            .commit(NativeQueueCommitV1 {
                expected_revision: 0,
                document: NativeQueueDocumentV1 {
                    schema_version: SCHEMA_VERSION,
                    items: vec![
                        NativeQueueRowV1::Item(first.clone()),
                        NativeQueueRowV1::Item(second.clone()),
                    ],
                    run: None,
                    alarm: None,
                },
                reference_blobs: vec![],
            })
            .unwrap();
        let path = store
            .item_path(
                parse_uuid(&first.queue_item_id, "queue_item_id_invalid").unwrap(),
                first.record_revision,
            )
            .unwrap();
        let mut record: DiskItemRecordV1 =
            serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        record.item.state = QueueItemState::Completed;
        record.item.remote_batch_id = Some(Uuid::new_v4().to_string());
        // Keep runRevision null. The item remains individually schema-valid,
        // but the reconstructed document is not.
        rewrite_record_and_rebind_index(&store, record);

        let loaded = store.load().unwrap();
        assert!(matches!(
            loaded.document.items[0],
            NativeQueueRowV1::Placeholder(_)
        ));
        assert!(matches!(
            loaded.document.items[1],
            NativeQueueRowV1::Item(_)
        ));
        assert!(validate_document(&loaded.document).is_ok());
    }

    #[test]
    fn runner_file_lease_prevents_second_store_and_release_cleans_power() {
        let (temporary, destination_store, destination_path) = destination();
        let store =
            QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store.clone());
        let run = Uuid::new_v4().to_string();
        assert_eq!(
            store
                .acquire_runner(NativeRunKey {
                    run_revision: run.clone()
                })
                .unwrap_err()
                .code,
            "queue_runner_busy"
        );
        stage_and_start_paused_run(&store, item(destination_path, None), &run);
        assert!(
            store
                .acquire_runner(NativeRunKey {
                    run_revision: run.clone()
                })
                .unwrap()
                .held
        );
        let second = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        assert_eq!(
            second
                .acquire_runner(NativeRunKey {
                    run_revision: run.clone()
                })
                .unwrap_err()
                .code,
            "queue_runner_busy"
        );
        assert!(
            !store
                .release_runner(NativeRunKey { run_revision: run })
                .unwrap()
                .held
        );
    }

    #[test]
    fn profile_classifier_allows_only_unassigned_next_run_edits_during_a_current_run() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let bytes = png();
        let sha256 = hex::encode(Sha256::digest(&bytes));
        let reference = NativeQueueReferenceV1 {
            id: Uuid::new_v4().to_string(),
            name: "shared-style.png".to_owned(),
            mime_type: "image/png".to_owned(),
            size_bytes: bytes.len() as u64,
            sha256: sha256.clone(),
        };
        let blob = NativeReferenceBlobV1 {
            sha256,
            mime_type: "image/png".to_owned(),
            size_bytes: bytes.len() as u64,
            bytes,
        };
        let snapshot = store
            .commit(commit_for(
                item(destination_path.clone(), Some(reference.clone())),
                vec![blob.clone()],
            ))
            .unwrap();
        let run = Uuid::new_v4().to_string();
        let mut document = snapshot.document.clone();
        let NativeQueueRowV1::Item(current) = &mut document.items[0] else {
            panic!("current queue row")
        };
        current.record_revision += 1;
        current.run_revision = Some(run.clone());
        let current_id = current.queue_item_id.clone();
        document.run = Some(NativeQueueRunV1 {
            run_revision: run.clone(),
            cohort_item_ids: vec![current_id],
            runner_state: QueueRunnerState::Paused,
            authorization_required: true,
            keep_awake: false,
        });
        document.alarm = Some(NativeQueueAlarmV1 {
            event_id: format!("queue-complete:{run}"),
            run_revision: run,
            state: QueueAlarmState::Disarmed,
            kind: None,
            snooze_used: false,
            snooze_due_at: None,
            notification_disposition: None,
            snooze_notification_disposition: None,
        });
        let mut snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();
        store
            .acquire_runner(NativeRunKey {
                run_revision: snapshot.document.run.as_ref().unwrap().run_revision.clone(),
            })
            .unwrap();
        let mut running = snapshot.document.clone();
        running.run.as_mut().unwrap().runner_state = QueueRunnerState::Running;
        running.run.as_mut().unwrap().authorization_required = false;
        snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document: running,
                reference_blobs: vec![],
            })
            .unwrap();
        store
            .release_runner(NativeRunKey {
                run_revision: snapshot.document.run.as_ref().unwrap().run_revision.clone(),
            })
            .unwrap();

        let mut next_document = snapshot.document.clone();
        next_document.items.push(NativeQueueRowV1::Item(item(
            destination_path,
            Some(reference),
        )));
        let next_run_commit = NativeQueueCommitV1 {
            expected_revision: snapshot.store_revision,
            document: next_document,
            // Reusing a content-addressed blob already referenced by the current
            // cohort must not turn this Next-run edit into a profile mutation.
            reference_blobs: vec![blob],
        };
        assert!(!store
            .commit_touches_profile_state(&next_run_commit)
            .unwrap());
        let staged = store.commit_next_run_only(next_run_commit).unwrap();
        assert_eq!(
            staged.document.run.as_ref().unwrap().runner_state,
            QueueRunnerState::Running,
            "Next-run staging must not implicitly pause an unleased current run"
        );

        let mut edit_next = staged.document.clone();
        let NativeQueueRowV1::Item(next) = &mut edit_next.items[1] else {
            panic!("Next-run queue row")
        };
        next.record_revision += 1;
        next.name = "Edited while the GPU switch is pending".to_owned();
        assert!(!store
            .commit_touches_profile_state(&NativeQueueCommitV1 {
                expected_revision: staged.store_revision,
                document: edit_next,
                reference_blobs: vec![],
            })
            .unwrap());

        let mut mutate_current = staged.document.clone();
        let NativeQueueRowV1::Item(current) = &mut mutate_current.items[0] else {
            panic!("current queue row")
        };
        current.record_revision += 1;
        current.name = "Forbidden current-cohort edit".to_owned();
        assert!(store
            .commit_touches_profile_state(&NativeQueueCommitV1 {
                expected_revision: staged.store_revision,
                document: mutate_current,
                reference_blobs: vec![],
            })
            .unwrap());

        let mut mutate_alarm = staged.document.clone();
        mutate_alarm.alarm.as_mut().unwrap().state = QueueAlarmState::Armed;
        assert!(store
            .commit_touches_profile_state(&NativeQueueCommitV1 {
                expected_revision: staged.store_revision,
                document: mutate_alarm,
                reference_blobs: vec![],
            })
            .unwrap());
    }

    #[test]
    fn gpu_switch_park_commits_paused_before_releasing_runner_and_preserves_active_item() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let run = Uuid::new_v4().to_string();
        let run_id = parse_uuid(&run, "queue_run_id_invalid").unwrap();
        let mut snapshot = stage_and_start_paused_run(&store, item(destination_path, None), &run);
        store
            .acquire_runner(NativeRunKey {
                run_revision: run.clone(),
            })
            .unwrap();
        let mut document = snapshot.document.clone();
        document.run.as_mut().unwrap().runner_state = QueueRunnerState::Running;
        document.run.as_mut().unwrap().authorization_required = false;
        snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();
        let mut document = snapshot.document.clone();
        let NativeQueueRowV1::Item(row) = &mut document.items[0] else {
            panic!("queue row")
        };
        row.record_revision += 1;
        row.state = QueueItemState::Dispatching;
        snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();
        let mut document = snapshot.document.clone();
        let NativeQueueRowV1::Item(row) = &mut document.items[0] else {
            panic!("queue row")
        };
        row.record_revision += 1;
        row.state = QueueItemState::Active;
        row.remote_batch_id = Some(Uuid::new_v4().to_string());
        snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();

        #[cfg(any(target_os = "macos", target_os = "windows"))]
        store
            .set_sleep_prevention(NativePowerInput {
                run_revision: run.clone(),
                enabled: true,
            })
            .unwrap();
        store
            .preflight_gpu_switch_park(snapshot.store_revision, Some(&run))
            .unwrap();
        let parked_revision = store
            .park_for_gpu_switch(snapshot.store_revision, Some(&run))
            .unwrap();
        assert_eq!(parked_revision, snapshot.store_revision + 1);
        let parked = store.load().unwrap();
        let parked_run = parked.document.run.as_ref().unwrap();
        assert_eq!(parked_run.runner_state, QueueRunnerState::Paused);
        assert!(parked_run.authorization_required);
        let NativeQueueRowV1::Item(row) = &parked.document.items[0] else {
            panic!("queue row")
        };
        assert_eq!(row.state, QueueItemState::Active);
        assert!(row.remote_batch_id.is_some());
        assert!(!store.holds_runner(run_id).unwrap());
        assert!(!store.power.active_for_test());
    }

    #[test]
    fn gpu_switch_park_rejects_dispatch_uncertainty_without_releasing_runner() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let run = Uuid::new_v4().to_string();
        let run_id = parse_uuid(&run, "queue_run_id_invalid").unwrap();
        let mut snapshot = stage_and_start_paused_run(&store, item(destination_path, None), &run);
        store
            .acquire_runner(NativeRunKey {
                run_revision: run.clone(),
            })
            .unwrap();
        let mut document = snapshot.document.clone();
        document.run.as_mut().unwrap().runner_state = QueueRunnerState::Running;
        document.run.as_mut().unwrap().authorization_required = false;
        snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();
        let mut document = snapshot.document.clone();
        let NativeQueueRowV1::Item(row) = &mut document.items[0] else {
            panic!("queue row")
        };
        row.record_revision += 1;
        row.state = QueueItemState::Dispatching;
        snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();

        assert_eq!(
            store
                .preflight_gpu_switch_park(snapshot.store_revision, Some(&run))
                .unwrap_err()
                .code,
            "gpu_switch_queue_reservation_conflict"
        );
        assert_eq!(
            store.load().unwrap().store_revision,
            snapshot.store_revision
        );
        assert!(store.holds_runner(run_id).unwrap());
    }

    #[test]
    fn separate_queue_store_instances_serialize_same_revision_commits() {
        let (temporary, destination_store, destination_path) = destination();
        let root = temporary.path().join("queue/v1");
        let first = QueueStore::new_for_test(root.clone(), destination_store.clone());
        let second = QueueStore::new_for_test(root, destination_store);
        let snapshot = first
            .commit(commit_for(item(destination_path, None), vec![]))
            .unwrap();
        let input = NativeQueueCommitV1 {
            expected_revision: snapshot.store_revision,
            document: snapshot.document,
            reference_blobs: vec![],
        };
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let left_barrier = barrier.clone();
        let left_input = input.clone();
        let left = std::thread::spawn(move || {
            left_barrier.wait();
            first
                .commit(left_input)
                .map(|_| ())
                .map_err(|error| error.code)
        });
        let right_barrier = barrier.clone();
        let right = std::thread::spawn(move || {
            right_barrier.wait();
            second.commit(input).map(|_| ()).map_err(|error| error.code)
        });
        let outcomes = [left.join().unwrap(), right.join().unwrap()];
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        let error = outcomes
            .iter()
            .find_map(|outcome| outcome.as_ref().err())
            .expect("one conflicting commit");
        assert_eq!(*error, "queue_revision_conflict");
    }

    #[test]
    fn simultaneous_restart_loads_pause_one_unleased_runner_exactly_once() {
        let (temporary, destination_store, destination_path) = destination();
        let root = temporary.path().join("queue/v1");
        let first = QueueStore::new_for_test(root.clone(), destination_store.clone());
        let run =
            persist_runner_admission_fixture(&first, destination_path, QueueRunnerState::Running);
        let second = QueueStore::new_for_test(root, destination_store);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let left_barrier = barrier.clone();
        let left = std::thread::spawn(move || {
            left_barrier.wait();
            first.load()
        });
        let right_barrier = barrier.clone();
        let right = std::thread::spawn(move || {
            right_barrier.wait();
            second.load()
        });
        let left = left.join().unwrap().unwrap();
        let right = right.join().unwrap().unwrap();
        for snapshot in [&left, &right] {
            let run_state = snapshot.document.run.as_ref().unwrap();
            assert_eq!(run_state.run_revision, run);
            assert_eq!(run_state.runner_state, QueueRunnerState::Paused);
            assert!(run_state.authorization_required);
        }
        assert_eq!(left.store_revision, 2);
        assert_eq!(right.store_revision, 2);
    }

    #[test]
    fn separate_process_alert_signals_deliver_only_once() {
        let (temporary, destination_store, destination_path) = destination();
        let root = temporary.path().join("queue/v1");
        let first = QueueStore::new_for_test(root.clone(), destination_store.clone());
        let event_id = persist_terminal_alarm_without_outbox(&first, destination_path, false);
        let second = QueueStore::new_for_test(root, destination_store);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let deliveries = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let left_barrier = barrier.clone();
        let left_deliveries = deliveries.clone();
        let left_event = event_id.clone();
        let left = std::thread::spawn(move || {
            left_barrier.wait();
            first.signal_alert(
                NativeAlertInput {
                    event_id: left_event,
                    kind: QueueAlertKind::Complete,
                },
                |_| {
                    left_deliveries.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    AlertDeliveryDisposition::Delivered
                },
            )
        });
        let right_barrier = barrier.clone();
        let right_deliveries = deliveries.clone();
        let right = std::thread::spawn(move || {
            right_barrier.wait();
            second.signal_alert(
                NativeAlertInput {
                    event_id,
                    kind: QueueAlertKind::Complete,
                },
                |_| {
                    right_deliveries.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    AlertDeliveryDisposition::Delivered
                },
            )
        });
        let outcomes = [
            left.join().unwrap().unwrap(),
            right.join().unwrap().unwrap(),
        ];
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| outcome.disposition == AlertResultDisposition::Delivered)
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| outcome.disposition == AlertResultDisposition::AlreadyDelivered)
                .count(),
            1
        );
        assert_eq!(deliveries.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn first_run_is_persisted_paused_before_a_lease_can_start_it() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let run = Uuid::new_v4().to_string();
        let mut queued = item(destination_path, None);
        queued.run_revision = Some(run.clone());
        let item_id = queued.queue_item_id.clone();
        let make_document =
            |runner_state, authorization_required, alarm_state, kind| NativeQueueDocumentV1 {
                schema_version: 1,
                items: vec![NativeQueueRowV1::Item(queued.clone())],
                run: Some(NativeQueueRunV1 {
                    run_revision: run.clone(),
                    cohort_item_ids: vec![item_id.clone()],
                    runner_state,
                    authorization_required,
                    keep_awake: false,
                }),
                alarm: Some(NativeQueueAlarmV1 {
                    event_id: format!("queue-complete:{run}"),
                    run_revision: run.clone(),
                    state: alarm_state,
                    kind,
                    snooze_used: false,
                    snooze_due_at: None,
                    notification_disposition: None,
                    snooze_notification_disposition: None,
                }),
            };
        assert_eq!(
            store
                .commit(NativeQueueCommitV1 {
                    expected_revision: 0,
                    document: make_document(
                        QueueRunnerState::Running,
                        false,
                        QueueAlarmState::Armed,
                        None
                    ),
                    reference_blobs: vec![],
                })
                .unwrap_err()
                .code,
            "queue_commit_invalid"
        );
        assert_eq!(
            store
                .commit(NativeQueueCommitV1 {
                    expected_revision: 0,
                    document: make_document(
                        QueueRunnerState::Completed,
                        true,
                        QueueAlarmState::Ringing,
                        Some(QueueAlertKind::Complete),
                    ),
                    reference_blobs: vec![],
                })
                .unwrap_err()
                .code,
            "queue_commit_invalid"
        );
    }

    #[test]
    fn a_new_runner_lease_rejects_an_idle_or_completed_run() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let idle_run =
            persist_runner_admission_fixture(&store, destination_path, QueueRunnerState::Idle);
        assert_eq!(
            store
                .acquire_runner(NativeRunKey {
                    run_revision: idle_run,
                })
                .unwrap_err()
                .code,
            "queue_runner_busy"
        );

        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let completed_run = persist_terminal_alarm_without_outbox(&store, destination_path, false)
            .strip_prefix("queue-complete:")
            .unwrap()
            .to_owned();
        assert_eq!(
            store
                .acquire_runner(NativeRunKey {
                    run_revision: completed_run,
                })
                .unwrap_err()
                .code,
            "queue_runner_busy"
        );
    }

    #[test]
    fn peer_cannot_mutate_current_run_but_can_stage_next_run_rows() {
        let (temporary, destination_store, destination_path) = destination();
        let store =
            QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store.clone());
        let run = Uuid::new_v4().to_string();
        let initial =
            stage_and_start_paused_run(&store, item(destination_path.clone(), None), &run);
        store
            .acquire_runner(NativeRunKey {
                run_revision: run.clone(),
            })
            .unwrap();
        let mut running_document = initial.document.clone();
        running_document.run.as_mut().unwrap().runner_state = QueueRunnerState::Running;
        running_document
            .run
            .as_mut()
            .unwrap()
            .authorization_required = false;
        let running = store
            .commit(NativeQueueCommitV1 {
                expected_revision: initial.store_revision,
                document: running_document,
                reference_blobs: vec![],
            })
            .unwrap();

        let peer = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let mut forbidden = running.document.clone();
        let NativeQueueRowV1::Item(row) = &mut forbidden.items[0] else {
            panic!("test row")
        };
        row.record_revision += 1;
        row.state = QueueItemState::Dispatching;
        assert_eq!(
            peer.commit(NativeQueueCommitV1 {
                expected_revision: running.store_revision,
                document: forbidden,
                reference_blobs: vec![],
            })
            .unwrap_err()
            .code,
            "queue_runner_busy"
        );

        let mut next_run = running.document.clone();
        next_run
            .items
            .push(NativeQueueRowV1::Item(item(destination_path, None)));
        let staged = peer
            .commit(NativeQueueCommitV1 {
                expected_revision: running.store_revision,
                document: next_run,
                reference_blobs: vec![],
            })
            .unwrap();
        assert_eq!(staged.document.items.len(), 2);
    }

    #[test]
    fn dispatch_payload_is_never_exposed_for_a_non_staged_row() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let run = Uuid::new_v4().to_string();
        let queued = item(destination_path, None);
        let queue_item_id = queued.queue_item_id.clone();
        let client_submission_id = queued.client_submission_id.clone();
        let initial = stage_and_start_paused_run(&store, queued, &run);
        store
            .acquire_runner(NativeRunKey {
                run_revision: run.clone(),
            })
            .unwrap();
        let mut document = initial.document.clone();
        document.run.as_mut().unwrap().runner_state = QueueRunnerState::Running;
        document.run.as_mut().unwrap().authorization_required = false;
        let running = store
            .commit(NativeQueueCommitV1 {
                expected_revision: initial.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();
        let mut document = running.document.clone();
        let NativeQueueRowV1::Item(queued) = &mut document.items[0] else {
            panic!("test row")
        };
        queued.record_revision += 1;
        queued.state = QueueItemState::Dispatching;
        store
            .commit(NativeQueueCommitV1 {
                expected_revision: running.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();
        assert_eq!(
            store
                .prepare_dispatch(NativeQueueItemKey {
                    queue_item_id,
                    client_submission_id,
                    purpose: QueueItemPayloadPurpose::Dispatch,
                })
                .unwrap_err()
                .code,
            "queue_item_not_dispatchable"
        );
    }

    #[test]
    fn edit_payload_allows_unassigned_staging_but_dispatch_does_not() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let staged = item(destination_path, None);
        let key = NativeQueueItemKey {
            queue_item_id: staged.queue_item_id.clone(),
            client_submission_id: staged.client_submission_id.clone(),
            purpose: QueueItemPayloadPurpose::Edit,
        };
        store.commit(commit_for(staged, vec![])).unwrap();
        assert_eq!(
            store.prepare_dispatch(key.clone()).unwrap().queue_item_id,
            key.queue_item_id
        );
        assert_eq!(
            store
                .prepare_dispatch(NativeQueueItemKey {
                    purpose: QueueItemPayloadPurpose::Dispatch,
                    ..key
                })
                .unwrap_err()
                .code,
            "queue_runner_busy"
        );
    }

    #[test]
    fn assigned_edit_requires_its_held_runner_but_may_be_paused() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let run = Uuid::new_v4().to_string();
        let queued = item(destination_path, None);
        let key = NativeQueueItemKey {
            queue_item_id: queued.queue_item_id.clone(),
            client_submission_id: queued.client_submission_id.clone(),
            purpose: QueueItemPayloadPurpose::Edit,
        };
        stage_and_start_paused_run(&store, queued, &run);
        assert_eq!(
            store.prepare_dispatch(key.clone()).unwrap_err().code,
            "queue_runner_busy"
        );
        store
            .acquire_runner(NativeRunKey { run_revision: run })
            .unwrap();
        assert_eq!(
            store.prepare_dispatch(key.clone()).unwrap().queue_item_id,
            key.queue_item_id
        );
    }

    #[test]
    fn alert_outbox_is_fixed_copy_and_exactly_once_per_slot() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let run = Uuid::new_v4().to_string();
        let queued = item(destination_path, None);
        let cohort_item_id = queued.queue_item_id.clone();
        let mut snapshot = store.commit(commit_for(queued, vec![])).unwrap();
        let mut document = snapshot.document.clone();
        let NativeQueueRowV1::Item(queued) = &mut document.items[0] else {
            panic!("test row")
        };
        queued.run_revision = Some(run.clone());
        queued.record_revision += 1;
        document.run = Some(NativeQueueRunV1 {
            run_revision: run.clone(),
            cohort_item_ids: vec![cohort_item_id],
            runner_state: QueueRunnerState::Paused,
            authorization_required: true,
            keep_awake: false,
        });
        document.alarm = Some(NativeQueueAlarmV1 {
            event_id: format!("queue-complete:{run}"),
            run_revision: run.clone(),
            state: QueueAlarmState::Armed,
            kind: None,
            snooze_used: false,
            snooze_due_at: None,
            notification_disposition: None,
            snooze_notification_disposition: None,
        });
        snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();

        store
            .acquire_runner(NativeRunKey {
                run_revision: run.clone(),
            })
            .unwrap();

        let mut document = snapshot.document.clone();
        document.run.as_mut().unwrap().runner_state = QueueRunnerState::Running;
        document.run.as_mut().unwrap().authorization_required = false;
        snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();

        let mut document = snapshot.document.clone();
        let NativeQueueRowV1::Item(queued) = &mut document.items[0] else {
            panic!("test row")
        };
        queued.record_revision += 1;
        queued.state = QueueItemState::Dispatching;
        snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();

        let mut document = snapshot.document.clone();
        let NativeQueueRowV1::Item(queued) = &mut document.items[0] else {
            panic!("test row")
        };
        queued.record_revision += 1;
        queued.state = QueueItemState::Active;
        queued.remote_batch_id = Some(Uuid::new_v4().to_string());
        snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();

        let mut document = snapshot.document.clone();
        let NativeQueueRowV1::Item(queued) = &mut document.items[0] else {
            panic!("test row")
        };
        queued.record_revision += 1;
        queued.state = QueueItemState::Saving;
        snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();

        let mut document = snapshot.document.clone();
        let NativeQueueRowV1::Item(queued) = &mut document.items[0] else {
            panic!("test row")
        };
        queued.record_revision += 1;
        queued.state = QueueItemState::Completed;
        snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();

        let mut forged_acknowledgement = snapshot.document.clone();
        forged_acknowledgement.run.as_mut().unwrap().runner_state = QueueRunnerState::Completed;
        forged_acknowledgement
            .run
            .as_mut()
            .unwrap()
            .authorization_required = true;
        let forged_alarm = forged_acknowledgement.alarm.as_mut().unwrap();
        forged_alarm.state = QueueAlarmState::Acknowledged;
        forged_alarm.kind = Some(QueueAlertKind::Complete);
        assert_eq!(
            store
                .commit(NativeQueueCommitV1 {
                    expected_revision: snapshot.store_revision,
                    document: forged_acknowledgement,
                    reference_blobs: vec![],
                })
                .unwrap_err()
                .code,
            "queue_commit_invalid"
        );

        let mut document = snapshot.document.clone();
        document.run.as_mut().unwrap().runner_state = QueueRunnerState::Completed;
        document.run.as_mut().unwrap().authorization_required = true;
        let alarm = document.alarm.as_mut().unwrap();
        alarm.state = QueueAlarmState::Ringing;
        alarm.kind = Some(QueueAlertKind::Complete);
        alarm.notification_disposition = Some(NotificationDisposition::Pending);
        snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();
        let mut forged_delivery = snapshot.document.clone();
        forged_delivery
            .alarm
            .as_mut()
            .unwrap()
            .notification_disposition = Some(NotificationDisposition::Delivered);
        assert_eq!(
            store
                .commit(NativeQueueCommitV1 {
                    expected_revision: snapshot.store_revision,
                    document: forged_delivery,
                    reference_blobs: vec![],
                })
                .unwrap_err()
                .code,
            "queue_commit_invalid"
        );
        assert_eq!(
            store
                .set_sleep_prevention(NativePowerInput {
                    run_revision: run.clone(),
                    enabled: true,
                })
                .unwrap_err()
                .code,
            "queue_runner_busy"
        );
        store
            .release_runner(NativeRunKey {
                run_revision: run.clone(),
            })
            .unwrap();
        assert_eq!(
            store
                .acquire_runner(NativeRunKey {
                    run_revision: run.clone(),
                })
                .unwrap_err()
                .code,
            "queue_runner_busy"
        );
        let event_id = format!("queue-complete:{run}");
        let failed = store
            .signal_alert(
                NativeAlertInput {
                    event_id: event_id.clone(),
                    kind: QueueAlertKind::Complete,
                },
                |copy| {
                    assert_eq!(copy.title, "ImageForge queue complete");
                    assert_eq!(
                        copy.body,
                        "All staged batches finished. The GPU is still running."
                    );
                    AlertDeliveryDisposition::Failed
                },
            )
            .unwrap();
        assert_eq!(failed.disposition, AlertResultDisposition::Failed);
        let delivered = store
            .signal_alert(
                NativeAlertInput {
                    event_id: event_id.clone(),
                    kind: QueueAlertKind::Complete,
                },
                |_| AlertDeliveryDisposition::Delivered,
            )
            .unwrap();
        assert_eq!(delivered.disposition, AlertResultDisposition::Delivered);
        let no_replay = store
            .signal_alert(
                NativeAlertInput {
                    event_id: event_id.clone(),
                    kind: QueueAlertKind::Complete,
                },
                |_| panic!("already delivered must not send again"),
            )
            .unwrap();
        assert_eq!(failed.notification_id, delivered.notification_id);
        assert_eq!(delivered.notification_id, no_replay.notification_id);
        assert_eq!(
            no_replay.disposition,
            AlertResultDisposition::AlreadyDelivered
        );

        let loaded = store.load().unwrap();
        let mut acknowledged = loaded.document.clone();
        acknowledged.alarm.as_mut().unwrap().state = QueueAlarmState::Acknowledged;
        store
            .commit(NativeQueueCommitV1 {
                expected_revision: loaded.store_revision,
                document: acknowledged,
                reference_blobs: vec![],
            })
            .unwrap();
        assert_eq!(
            store
                .signal_alert(
                    NativeAlertInput {
                        event_id: event_id.clone(),
                        kind: QueueAlertKind::Complete,
                    },
                    |_| panic!("a dismissed completion event must not notify"),
                )
                .unwrap_err()
                .code,
            "queue_alert_event_invalid"
        );

        fs::write(store.outbox_path(&event_id), b"{invalid-outbox").unwrap();
        let recovered = store.load().unwrap();
        assert!(recovered
            .issues
            .iter()
            .any(|entry| entry.code == "queue_alert_outbox_invalid" && !entry.retryable));
        assert_eq!(
            recovered
                .document
                .alarm
                .as_ref()
                .and_then(|alarm| alarm.notification_disposition),
            Some(NotificationDisposition::Failed)
        );
    }

    #[test]
    fn renderer_cannot_forge_missing_ringing_delivery_slots_or_early_snooze_redelivery() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        persist_terminal_alarm_without_outbox(&store, destination_path, false);
        let recovered = store.load().unwrap();

        let mut forged = recovered.document.clone();
        forged.alarm.as_mut().unwrap().notification_disposition = None;
        assert_eq!(
            store
                .commit(NativeQueueCommitV1 {
                    expected_revision: recovered.store_revision,
                    document: forged,
                    reference_blobs: vec![],
                })
                .unwrap_err()
                .code,
            "queue_commit_invalid"
        );

        // A crash/old malformed disk generation can still contain the shape
        // a renderer was forbidden to commit. Startup must repair it into a
        // visible failed native slot rather than returning an unschedulable
        // Ringing/null projection.
        let (temporary, destination_store, destination_path) = destination();
        let malformed_store =
            QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        persist_terminal_alarm_without_outbox(&malformed_store, destination_path, false);
        let generation_path = malformed_store.generation_path(1).unwrap();
        let mut malformed: DiskGenerationV1 =
            serde_json::from_slice(&fs::read(&generation_path).unwrap()).unwrap();
        malformed.alarm.as_mut().unwrap().notification_disposition = None;
        fs::write(&generation_path, serde_json::to_vec(&malformed).unwrap()).unwrap();
        let repaired = malformed_store.load().unwrap();
        assert_eq!(
            repaired
                .document
                .alarm
                .as_ref()
                .and_then(|alarm| alarm.notification_disposition),
            Some(NotificationDisposition::Failed)
        );
        assert!(repaired
            .issues
            .iter()
            .any(|entry| entry.code == "queue_alert_outbox_invalid" && !entry.retryable));

        // A nonblank primary record cannot mask a missing *post-due* snooze
        // record. This is the partial-outbox crash seam: startup repairs both
        // slots without emitting a notification itself.
        let (temporary, destination_store, destination_path) = destination();
        let partial_store =
            QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let partial_event =
            persist_terminal_alarm_without_outbox(&partial_store, destination_path, true);
        let generation_path = partial_store.generation_path(1).unwrap();
        let mut partial: DiskGenerationV1 =
            serde_json::from_slice(&fs::read(&generation_path).unwrap()).unwrap();
        partial
            .alarm
            .as_mut()
            .unwrap()
            .snooze_notification_disposition = None;
        fs::write(&generation_path, serde_json::to_vec(&partial).unwrap()).unwrap();
        partial_store
            .write_outbox(&AlertOutboxV1 {
                schema_version: SCHEMA_VERSION,
                event_id: partial_event,
                primary_kind: Some(QueueAlertKind::Complete),
                primary: Some(NotificationDisposition::Delivered),
                snooze: None,
                recovered_after_corruption: false,
            })
            .unwrap();
        let repaired_partial = partial_store.load().unwrap();
        let repaired_alarm = repaired_partial.document.alarm.as_ref().unwrap();
        assert_eq!(
            repaired_alarm.notification_disposition,
            Some(NotificationDisposition::Failed)
        );
        assert_eq!(
            repaired_alarm.snooze_notification_disposition,
            Some(NotificationDisposition::Failed)
        );

        let mut previous = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: recovered.store_revision,
            items: recovered
                .document
                .items
                .iter()
                .map(|row| match row {
                    NativeQueueRowV1::Item(item) => index_for_item(item),
                    NativeQueueRowV1::Placeholder(_) => panic!("terminal row"),
                })
                .collect(),
            run: recovered.document.run.clone(),
            alarm: recovered.document.alarm.clone(),
        };
        let due = "2026-08-03T10:20:00.000Z";
        let alarm = previous.alarm.as_mut().unwrap();
        alarm.state = QueueAlarmState::Snoozed;
        alarm.snooze_used = true;
        alarm.snooze_due_at = Some(due.to_owned());
        alarm.snooze_notification_disposition = None;

        let mut ringing = recovered.document.clone();
        let alarm = ringing.alarm.as_mut().unwrap();
        alarm.state = QueueAlarmState::Ringing;
        alarm.snooze_used = true;
        alarm.snooze_due_at = None;
        alarm.snooze_notification_disposition = None;
        assert_eq!(
            validate_alarm_transition_at(
                Some(&previous),
                &ringing,
                timestamp_millis("2026-08-03T10:19:59.999Z").unwrap(),
            )
            .unwrap_err()
            .code,
            "queue_commit_invalid"
        );
        assert_eq!(
            validate_alarm_transition_at(
                Some(&previous),
                &ringing,
                timestamp_millis(due).unwrap(),
            )
            .unwrap_err()
            .code,
            "queue_commit_invalid"
        );
        ringing
            .alarm
            .as_mut()
            .unwrap()
            .snooze_notification_disposition = Some(NotificationDisposition::Pending);
        assert!(validate_alarm_transition_at(
            Some(&previous),
            &ringing,
            timestamp_millis(due).unwrap(),
        )
        .is_ok());
        assert!(validate_document(&ringing).is_ok());
        let pending_snooze_outbox = AlertOutboxV1 {
            schema_version: SCHEMA_VERSION,
            event_id: ringing.alarm.as_ref().unwrap().event_id.clone(),
            primary_kind: Some(QueueAlertKind::Complete),
            primary: ringing.alarm.as_ref().unwrap().notification_disposition,
            snooze: None,
            recovered_after_corruption: false,
        };
        // The renderer may persist the due-time Pending transition before the
        // native notification command writes its second slot. A same-process
        // commit accepts that narrow anticipation; a restart repairs it.
        assert!(alert_outbox_matches_alarm(
            &pending_snooze_outbox,
            ringing.alarm.as_ref().unwrap()
        ));
        assert!(projection_matches_outbox(
            ringing.alarm.as_ref().unwrap().notification_disposition,
            pending_snooze_outbox.primary,
        ));
        assert!(projection_matches_outbox(
            ringing
                .alarm
                .as_ref()
                .unwrap()
                .snooze_notification_disposition,
            pending_snooze_outbox.snooze,
        ));
        assert!(outbox_missing_required_delivery_slot(
            &pending_snooze_outbox,
            ringing.alarm.as_ref().unwrap()
        ));

        let mut changed_due = reconstructed_document(
            &recovered.document.items,
            recovered.document.run.clone(),
            previous.alarm.clone(),
        );
        changed_due.alarm.as_mut().unwrap().snooze_due_at =
            Some("2026-08-03T10:35:00.000Z".to_owned());
        assert_eq!(
            validate_alarm_transition_at(
                Some(&previous),
                &changed_due,
                timestamp_millis("2026-08-03T10:21:00.000Z").unwrap(),
            )
            .unwrap_err()
            .code,
            "queue_commit_invalid"
        );
    }

    #[test]
    fn restart_missing_terminal_alert_outbox_repairs_authority_and_allows_acknowledgement() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let event_id = persist_terminal_alarm_without_outbox(&store, destination_path, false);

        let recovered = store.load().unwrap();
        assert!(recovered
            .issues
            .iter()
            .any(|entry| entry.code == "queue_alert_outbox_invalid" && !entry.retryable));
        let alarm = recovered.document.alarm.as_ref().unwrap();
        assert_eq!(
            alarm.notification_disposition,
            Some(NotificationDisposition::Failed)
        );
        assert_eq!(alarm.snooze_notification_disposition, None);
        assert!(store
            .read_outbox(&event_id)
            .unwrap()
            .is_some_and(|outbox| outbox.recovered_after_corruption));
        let mut acknowledged = recovered.document.clone();
        acknowledged.alarm.as_mut().unwrap().state = QueueAlarmState::Acknowledged;
        let acknowledged = store
            .commit(NativeQueueCommitV1 {
                expected_revision: recovered.store_revision,
                document: acknowledged,
                reference_blobs: vec![],
            })
            .unwrap();
        assert_eq!(
            store
                .signal_alert(
                    NativeAlertInput {
                        event_id,
                        kind: QueueAlertKind::Complete,
                    },
                    |_| panic!("an acknowledged event must not replay an OS alert"),
                )
                .unwrap_err()
                .code,
            "queue_alert_event_invalid"
        );
        assert_eq!(
            acknowledged.document.alarm.as_ref().unwrap().state,
            QueueAlarmState::Acknowledged
        );
    }

    #[test]
    fn restart_missing_snooze_alert_outbox_requires_an_explicit_retry() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let event_id = persist_terminal_alarm_without_outbox(&store, destination_path, true);

        let recovered = store.load().unwrap();
        assert!(recovered
            .issues
            .iter()
            .any(|entry| entry.code == "queue_alert_outbox_invalid" && !entry.retryable));
        let alarm = recovered.document.alarm.as_ref().unwrap();
        assert_eq!(
            alarm.notification_disposition,
            Some(NotificationDisposition::Failed)
        );
        assert_eq!(
            alarm.snooze_notification_disposition,
            Some(NotificationDisposition::Failed)
        );
        let delivered = store
            .signal_alert(
                NativeAlertInput {
                    event_id: event_id.clone(),
                    kind: QueueAlertKind::Snooze,
                },
                |_| AlertDeliveryDisposition::Delivered,
            )
            .unwrap();
        assert_eq!(delivered.disposition, AlertResultDisposition::Delivered);
        assert!(!store
            .read_outbox(&event_id)
            .unwrap()
            .is_some_and(|outbox| outbox.recovered_after_corruption));
    }

    #[test]
    fn event_id_is_canonical_and_snooze_has_a_distinct_stable_id() {
        let run = Uuid::new_v4().to_string();
        let event = format!("queue-complete:{run}");
        assert!(validate_alert_event_id(&event).is_ok());
        assert!(validate_alert_event_id(&event.to_uppercase()).is_err());
        assert_ne!(
            notification_id_for(&event, QueueAlertKind::Complete),
            notification_id_for(&event, QueueAlertKind::Snooze)
        );
        assert!(notification_disposition_can_advance(
            Some(NotificationDisposition::Failed),
            Some(NotificationDisposition::Delivered)
        ));
        assert!(notification_disposition_can_advance(
            Some(NotificationDisposition::PermissionDenied),
            Some(NotificationDisposition::Delivered)
        ));
        assert!(!notification_disposition_can_advance(
            Some(NotificationDisposition::Delivered),
            Some(NotificationDisposition::Failed)
        ));
    }

    #[test]
    fn notification_id_hash_matches_the_cross_platform_contract_vectors() {
        // Keep this literal stable: the TypeScript fake adapter uses the same
        // vectors to ensure macOS and Windows notifications replace/retry the
        // same OS notification rather than producing duplicate alerts.
        let event_id = "queue-complete:33333333-3333-4333-8333-333333333333";
        assert_eq!(
            notification_id_for(event_id, QueueAlertKind::Complete),
            2_093_761_350
        );
        assert_eq!(
            notification_id_for(event_id, QueueAlertKind::Attention),
            2_093_761_350
        );
        assert_eq!(
            notification_id_for(event_id, QueueAlertKind::Snooze),
            894_846_938
        );
    }

    #[test]
    fn reset_requires_an_unrecoverable_store_and_exact_confirmation() {
        let (temporary, destination_store, _) = destination();
        let root = temporary.path().join("queue/v1");
        let store = QueueStore::new_for_test(root.clone(), destination_store);
        assert_eq!(
            store
                .reset(NativeQueueResetInput {
                    confirmation: "RESET LOCAL QUEUE".to_owned(),
                })
                .unwrap_err()
                .code,
            "queue_reset_not_allowed"
        );
        fs::write(root.join("CURRENT"), b"bad\n").unwrap();
        fs::write(root.join("generations/1.json"), b"not-json").unwrap();
        assert_eq!(store.load().unwrap_err().code, "queue_store_unrecoverable");
        assert_eq!(
            store
                .reset(NativeQueueResetInput {
                    confirmation: "reset local queue".to_owned(),
                })
                .unwrap_err()
                .code,
            "queue_reset_confirmation_invalid"
        );
        let snapshot = store
            .reset(NativeQueueResetInput {
                confirmation: "RESET LOCAL QUEUE".to_owned(),
            })
            .unwrap();
        assert_eq!(snapshot, empty_snapshot());
        assert!(root.is_dir());
        assert!(temporary
            .path()
            .join("queue")
            .read_dir()
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("v1-recovery-")));
    }

    #[test]
    fn post_current_gc_keeps_retained_edits_then_reclaims_removed_records_and_blobs() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let first = item(destination_path.clone(), None);
        let first_id = parse_uuid(&first.queue_item_id, "queue_item_id_invalid").unwrap();
        let first_initial_path = store.item_path(first_id, 0).unwrap();
        let mut snapshot = store.commit(commit_for(first, vec![])).unwrap();

        let bytes = png();
        let sha256 = hex::encode(Sha256::digest(&bytes));
        let reference = NativeQueueReferenceV1 {
            id: Uuid::new_v4().to_string(),
            name: "remove-me.png".to_owned(),
            mime_type: "image/png".to_owned(),
            size_bytes: bytes.len() as u64,
            sha256: sha256.clone(),
        };
        let removed = item(destination_path, Some(reference));
        let removed_id = parse_uuid(&removed.queue_item_id, "queue_item_id_invalid").unwrap();
        let removed_record_path = store.item_path(removed_id, 0).unwrap();
        let removed_reference_path = store.reference_path(&sha256, "image/png").unwrap();
        let mut add_removed = snapshot.document.clone();
        add_removed.items.push(NativeQueueRowV1::Item(removed));
        snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document: add_removed,
                reference_blobs: vec![NativeReferenceBlobV1 {
                    sha256,
                    mime_type: "image/png".to_owned(),
                    size_bytes: bytes.len() as u64,
                    bytes,
                }],
            })
            .unwrap();

        // Revision 3 removes one referenced row and creates an immutable
        // replacement for the surviving row. The removed paths remain
        // reachable through revision 2 until three later valid journals make
        // them collectible.
        let mut remove_and_edit = snapshot.document.clone();
        remove_and_edit.items.pop();
        let NativeQueueRowV1::Item(first) = &mut remove_and_edit.items[0] else {
            panic!("first queue row")
        };
        first.record_revision += 1;
        snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document: remove_and_edit,
                reference_blobs: vec![],
            })
            .unwrap();

        let mut second_edit = snapshot.document.clone();
        let NativeQueueRowV1::Item(first) = &mut second_edit.items[0] else {
            panic!("first queue row")
        };
        first.record_revision += 1;
        snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document: second_edit,
                reference_blobs: vec![],
            })
            .unwrap();
        assert!(first_initial_path.exists());
        assert!(removed_record_path.exists());
        assert!(removed_reference_path.exists());

        let mut third_edit = snapshot.document.clone();
        let NativeQueueRowV1::Item(first) = &mut third_edit.items[0] else {
            panic!("first queue row")
        };
        first.record_revision += 1;
        let final_snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document: third_edit,
                reference_blobs: vec![],
            })
            .unwrap();
        assert_eq!(final_snapshot.store_revision, 5);
        assert!(!first_initial_path.exists());
        assert!(!removed_record_path.exists());
        assert!(!removed_reference_path.exists());
        for revision in [1, 2, 3] {
            assert!(store.item_path(first_id, revision).unwrap().is_file());
        }
    }

    #[test]
    fn startup_recovery_never_runs_reachability_gc_but_the_next_commit_does() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let snapshot = store
            .commit(commit_for(item(destination_path, None), vec![]))
            .unwrap();
        let orphan_id = Uuid::new_v4();
        let orphan_record = store.item_path(orphan_id, 0).unwrap();
        fs::create_dir_all(orphan_record.parent().unwrap()).unwrap();
        fs::write(&orphan_record, b"orphan record from an interrupted commit").unwrap();
        let orphan_sha256 = "a".repeat(64);
        let orphan_reference = store.reference_path(&orphan_sha256, "image/png").unwrap();
        fs::write(
            &orphan_reference,
            b"orphan reference from an interrupted commit",
        )
        .unwrap();

        let recovered = store.load().unwrap();
        assert_eq!(recovered.store_revision, snapshot.store_revision);
        assert!(orphan_record.exists());
        assert!(orphan_reference.exists());

        store
            .commit(NativeQueueCommitV1 {
                expected_revision: recovered.store_revision,
                document: recovered.document,
                reference_blobs: vec![],
            })
            .unwrap();
        assert!(!orphan_record.exists());
        assert!(!orphan_reference.exists());
    }

    #[test]
    fn current_cohort_placeholder_parks_the_runner_and_blocks_later_dispatch_after_restart() {
        let (temporary, destination_store, destination_path) = destination();
        let root = temporary.path().join("queue/v1");
        let store = QueueStore::new_for_test(root.clone(), destination_store.clone());
        let run = Uuid::new_v4().to_string();
        let mut corrupt = item(destination_path.clone(), None);
        corrupt.run_revision = Some(run.clone());
        let valid = {
            let mut item = item(destination_path, None);
            item.run_revision = Some(run.clone());
            item
        };
        let corrupt_id = parse_uuid(&corrupt.queue_item_id, "queue_item_id_invalid").unwrap();
        let valid_key = NativeQueueItemKey {
            queue_item_id: valid.queue_item_id.clone(),
            client_submission_id: valid.client_submission_id.clone(),
            purpose: QueueItemPayloadPurpose::Dispatch,
        };
        let corrupt_binding = store
            .destination
            .capture_queue_destination(&corrupt.destination)
            .unwrap();
        let valid_binding = store
            .destination
            .capture_queue_destination(&valid.destination)
            .unwrap();
        store
            .write_item_records(
                &[
                    DiskItemRecordV1 {
                        schema_version: SCHEMA_VERSION,
                        item: corrupt.clone(),
                        destination_binding: corrupt_binding,
                    },
                    DiskItemRecordV1 {
                        schema_version: SCHEMA_VERSION,
                        item: valid.clone(),
                        destination_binding: valid_binding,
                    },
                ],
                &HashMap::new(),
            )
            .unwrap();
        store
            .write_generation(&DiskGenerationV1 {
                schema_version: SCHEMA_VERSION,
                store_revision: 1,
                items: vec![index_for_item(&corrupt), index_for_item(&valid)],
                run: Some(NativeQueueRunV1 {
                    run_revision: run.clone(),
                    cohort_item_ids: vec![
                        corrupt.queue_item_id.clone(),
                        valid.queue_item_id.clone(),
                    ],
                    runner_state: QueueRunnerState::Running,
                    authorization_required: false,
                    keep_awake: false,
                }),
                alarm: Some(NativeQueueAlarmV1 {
                    event_id: format!("queue-complete:{run}"),
                    run_revision: run.clone(),
                    state: QueueAlarmState::Disarmed,
                    kind: None,
                    snooze_used: false,
                    snooze_due_at: None,
                    notification_disposition: None,
                    snooze_notification_disposition: None,
                }),
            })
            .unwrap();
        store.write_current(1).unwrap();
        fs::write(store.item_path(corrupt_id, 0).unwrap(), b"{broken-record").unwrap();

        let loaded = store.load().unwrap();
        let run_projection = loaded.document.run.as_ref().unwrap();
        assert_eq!(
            run_projection.runner_state,
            QueueRunnerState::NeedsAttention
        );
        assert!(run_projection.authorization_required);
        assert!(matches!(
            loaded.document.items[0],
            NativeQueueRowV1::Placeholder(_)
        ));
        store
            .acquire_runner(NativeRunKey {
                run_revision: run.clone(),
            })
            .unwrap();
        assert_eq!(
            store.prepare_dispatch(valid_key.clone()).unwrap_err().code,
            "queue_item_not_dispatchable"
        );
        store
            .release_runner(NativeRunKey {
                run_revision: run.clone(),
            })
            .unwrap();

        let restarted = QueueStore::new_for_test(root, destination_store);
        let reloaded = restarted.load().unwrap();
        let run_projection = reloaded.document.run.as_ref().unwrap();
        assert_eq!(
            run_projection.runner_state,
            QueueRunnerState::NeedsAttention
        );
        assert!(run_projection.authorization_required);
        assert!(matches!(
            reloaded.document.items[0],
            NativeQueueRowV1::Placeholder(_)
        ));
    }

    #[test]
    fn stale_dispatch_after_pause_cannot_reauthorize_or_bill_the_next_batch() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let run =
            persist_runner_admission_fixture(&store, destination_path, QueueRunnerState::Paused);
        let paused_admission = store.load().unwrap();
        let NativeQueueRowV1::Item(staged) = &paused_admission.document.items[0] else {
            panic!("staged queue row")
        };
        let key = NativeQueueItemKey {
            queue_item_id: staged.queue_item_id.clone(),
            client_submission_id: staged.client_submission_id.clone(),
            purpose: QueueItemPayloadPurpose::Dispatch,
        };
        store
            .acquire_runner(NativeRunKey {
                run_revision: run.clone(),
            })
            .unwrap();
        let mut running_document = paused_admission.document.clone();
        running_document.run.as_mut().unwrap().runner_state = QueueRunnerState::Running;
        running_document
            .run
            .as_mut()
            .unwrap()
            .authorization_required = false;
        let running = store
            .commit(NativeQueueCommitV1 {
                expected_revision: paused_admission.store_revision,
                document: running_document,
                reference_blobs: vec![],
            })
            .unwrap();
        // The scheduler may have copied this private payload before the user
        // pressed Pause. It must not make that copy billable afterward.
        store.prepare_dispatch(key).unwrap();

        let mut paused_document = running.document.clone();
        paused_document.run.as_mut().unwrap().runner_state = QueueRunnerState::Paused;
        paused_document.run.as_mut().unwrap().authorization_required = true;
        let paused = store
            .commit(NativeQueueCommitV1 {
                expected_revision: running.store_revision,
                document: paused_document,
                reference_blobs: vec![],
            })
            .unwrap();

        // Simulate a stale scheduler trying to fold an old Running view and
        // staged -> dispatching into the newest expected-revision commit.
        // A foreground Resume must be a separate authorized transition.
        let mut stale_dispatch = paused.document.clone();
        stale_dispatch.run.as_mut().unwrap().runner_state = QueueRunnerState::Running;
        stale_dispatch.run.as_mut().unwrap().authorization_required = false;
        let NativeQueueRowV1::Item(row) = &mut stale_dispatch.items[0] else {
            panic!("staged queue row")
        };
        row.record_revision += 1;
        row.state = QueueItemState::Dispatching;
        assert_eq!(
            store
                .commit(NativeQueueCommitV1 {
                    expected_revision: paused.store_revision,
                    document: stale_dispatch,
                    reference_blobs: vec![],
                })
                .unwrap_err()
                .code,
            "queue_item_not_dispatchable"
        );
        let after = store.load().unwrap();
        assert_eq!(
            after.document.run.as_ref().unwrap().runner_state,
            QueueRunnerState::Paused
        );
        assert!(matches!(
            after.document.items[0],
            NativeQueueRowV1::Item(NativeQueueItemV1 {
                state: QueueItemState::Staged,
                ..
            })
        ));
    }

    #[test]
    fn runner_lock_rejects_non_regular_paths() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("startup-repair.lock");
        fs::create_dir(&path).unwrap();
        let Err(error) = RunnerFileLock::try_acquire(&path) else {
            panic!("directory must not become a lock file")
        };
        assert_eq!(error.code, "queue_store_unavailable");
    }

    #[test]
    fn released_runner_snapshot_holds_the_probe_while_native_facts_are_checked() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let run =
            persist_runner_admission_fixture(&store, destination_path, QueueRunnerState::Paused);
        store
            .acquire_runner(NativeRunKey {
                run_revision: run.clone(),
            })
            .unwrap();
        assert_eq!(
            store
                .inspect_released_runner_snapshot(&run, |_| Ok(()))
                .unwrap_err()
                .code,
            "queue_runner_busy"
        );
        store
            .release_runner(NativeRunKey {
                run_revision: run.clone(),
            })
            .unwrap();
        store
            .inspect_released_runner_snapshot(&run, |snapshot| {
                assert_eq!(
                    snapshot
                        .document
                        .run
                        .as_ref()
                        .map(|current| &current.run_revision),
                    Some(&run)
                );
                Ok(())
            })
            .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn runner_and_mutation_locks_reject_symlink_paths_without_touching_targets() {
        let temporary = tempfile::tempdir().unwrap();
        let target = temporary.path().join("target");
        fs::write(&target, b"do not open as a queue lock").unwrap();
        let runner = temporary.path().join("runner.lock");
        std::os::unix::fs::symlink(&target, &runner).unwrap();
        let Err(error) = RunnerFileLock::try_acquire(&runner) else {
            panic!("symlink must not become a lock file")
        };
        assert_eq!(error.code, "queue_store_unavailable");
        assert_eq!(fs::read(&target).unwrap(), b"do not open as a queue lock");

        let destination_path = temporary.path().join("downloads");
        fs::create_dir(&destination_path).unwrap();
        let destination = DestinationStore::new_for_test(temporary.path().join("destination.json"));
        destination.validate_and_bind(&destination_path).unwrap();
        let root = temporary.path().join("queue/v1");
        let store = QueueStore::new_for_test(root.clone(), destination);
        let mutation = root.parent().unwrap().join("v1-mutation.lock");
        std::os::unix::fs::symlink(&target, &mutation).unwrap();
        assert_eq!(store.load().unwrap_err().code, "queue_store_unavailable");
        assert_eq!(fs::read(&target).unwrap(), b"do not open as a queue lock");
    }

    #[test]
    fn generation_retention_keeps_three_valid_journals_when_a_newer_file_is_corrupt() {
        let (temporary, destination_store, _) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        for revision in 1..=4 {
            store
                .write_generation(&DiskGenerationV1 {
                    schema_version: SCHEMA_VERSION,
                    store_revision: revision,
                    items: vec![],
                    run: None,
                    alarm: None,
                })
                .unwrap();
        }
        let corrupt = store.generation_path(99).unwrap();
        fs::write(&corrupt, b"{torn-generation").unwrap();

        store.cleanup_old_generations(4);

        for revision in [4, 3, 2] {
            assert!(store.generation_path(revision).unwrap().is_file());
        }
        assert!(!store.generation_path(1).unwrap().exists());
        // Invalid/higher journals are forensic recovery material. They never
        // count toward the three validated generations and are not deleted by
        // post-commit retention or reachability cleanup.
        assert!(corrupt.exists());
    }

    #[test]
    fn historical_rows_are_removable_only_after_the_run_completes() {
        let (temporary, destination_store, destination_path) = destination();
        let store = QueueStore::new_for_test(temporary.path().join("queue/v1"), destination_store);
        let run = Uuid::new_v4().to_string();
        let staged = item(destination_path, None);
        let item_id = staged.queue_item_id.clone();
        let mut snapshot = store.commit(commit_for(staged, vec![])).unwrap();
        let mut document = snapshot.document.clone();
        let NativeQueueRowV1::Item(queued) = &mut document.items[0] else {
            panic!("test row")
        };
        queued.run_revision = Some(run.clone());
        queued.record_revision += 1;
        document.run = Some(NativeQueueRunV1 {
            run_revision: run.clone(),
            cohort_item_ids: vec![item_id],
            runner_state: QueueRunnerState::Paused,
            authorization_required: true,
            keep_awake: false,
        });
        document.alarm = Some(NativeQueueAlarmV1 {
            event_id: format!("queue-complete:{run}"),
            run_revision: run.clone(),
            state: QueueAlarmState::Disarmed,
            kind: None,
            snooze_used: false,
            snooze_due_at: None,
            notification_disposition: None,
            snooze_notification_disposition: None,
        });
        snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();
        store
            .acquire_runner(NativeRunKey {
                run_revision: run.clone(),
            })
            .unwrap();

        let mut document = snapshot.document.clone();
        document.run.as_mut().unwrap().runner_state = QueueRunnerState::Running;
        document.run.as_mut().unwrap().authorization_required = false;
        let NativeQueueRowV1::Item(queued) = &mut document.items[0] else {
            panic!("test row")
        };
        queued.record_revision += 1;
        queued.state = QueueItemState::Cancelled;
        snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();

        let mut document = snapshot.document.clone();
        document.run.as_mut().unwrap().runner_state = QueueRunnerState::Completed;
        document.run.as_mut().unwrap().authorization_required = true;
        let alarm = document.alarm.as_mut().unwrap();
        alarm.kind = Some(QueueAlertKind::Attention);
        snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();
        store
            .release_runner(NativeRunKey {
                run_revision: run.clone(),
            })
            .unwrap();

        let mut document = snapshot.document.clone();
        document.alarm.as_mut().unwrap().state = QueueAlarmState::Acknowledged;
        snapshot = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();
        assert_eq!(
            store
                .commit(NativeQueueCommitV1 {
                    expected_revision: snapshot.store_revision,
                    document: NativeQueueDocumentV1 {
                        schema_version: SCHEMA_VERSION,
                        items: vec![],
                        run: None,
                        alarm: None,
                    },
                    reference_blobs: vec![],
                })
                .unwrap_err()
                .code,
            "queue_item_locked"
        );
        let mut document = snapshot.document.clone();
        let NativeQueueRowV1::Item(queued) = &mut document.items[0] else {
            panic!("test row")
        };
        queued.record_revision += 1;
        queued.state = QueueItemState::Historical;
        let first = store
            .commit(NativeQueueCommitV1 {
                expected_revision: snapshot.store_revision,
                document,
                reference_blobs: vec![],
            })
            .unwrap();
        let cleared = store
            .commit(NativeQueueCommitV1 {
                expected_revision: first.store_revision,
                document: NativeQueueDocumentV1 {
                    schema_version: 1,
                    items: vec![],
                    run: None,
                    alarm: None,
                },
                reference_blobs: vec![],
            })
            .unwrap();
        assert!(cleared.document.items.is_empty());
    }
}
