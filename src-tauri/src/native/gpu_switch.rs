//! Native-owned Task 014 GPU switch transaction journal.
//!
//! This module deliberately keeps switch authority, foreground grants and
//! durable recovery state below the renderer boundary.  The public types in
//! this file mirror `src/native/gpuSwitchBridge.ts`; provider and worker
//! transport are injected by the command layer rather than accepted from IPC.

use super::gpu_inventory::NativeGpuSwitchPodV1;
use super::{NativeError, NativeResult};
use serde::de::{self, Deserializer, Visitor};
use serde::{Deserialize, Serialize, Serializer};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::{Uuid, Version};

const SCHEMA_VERSION: u8 = 1;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_GENERATION_BYTES: u64 = 128 * 1024;
const FOREGROUND_GRANT_TTL: Duration = Duration::from_secs(5);
const PREPARED_QUOTE_TTL: Duration = Duration::from_secs(60);
const RETAINED_GENERATIONS: usize = 3;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeGpuSwitchPhaseV1 {
    Planned,
    ConsentPending,
    Pausing,
    ReadyToDelete,
    DeleteIntent,
    DeleteUncertain,
    OldAbsent,
    CreateIntent,
    CreateUncertain,
    ReplacementIdentified,
    Provisioning,
    ReplacementFailed,
    ReplacementDeleteIntent,
    ReplacementDeleteUncertain,
    ReadyPaused,
    Completed,
    NeedsAttention,
    CancelledPreDelete,
}

/// Safe, durable indication of whether the requester has revalidated the
/// selected target after consent was created.  Keeping this separate from the
/// worker consent phase makes a relaunch deterministic: a consent-pending
/// record can tell the renderer whether its next permitted action is the
/// native target confirmation or worker finalization.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeGpuSwitchTargetConfirmationV1 {
    Required,
    Confirmed,
}

impl NativeGpuSwitchPhaseV1 {
    fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::CancelledPreDelete)
    }

    fn is_blocked_phase(self) -> bool {
        !matches!(
            self,
            Self::NeedsAttention | Self::Completed | Self::CancelledPreDelete
        )
    }

    fn allows_transition_to(self, next: Self) -> bool {
        use NativeGpuSwitchPhaseV1::*;
        matches!(
            (self, next),
            (Planned, ConsentPending)
                | (ConsentPending, Pausing)
                | (Pausing, ReadyToDelete)
                | (ReadyToDelete, DeleteIntent)
                | (DeleteIntent, DeleteUncertain)
                | (DeleteIntent, OldAbsent)
                | (DeleteUncertain, DeleteIntent)
                | (DeleteUncertain, OldAbsent)
                | (OldAbsent, CreateIntent)
                | (CreateIntent, CreateUncertain)
                | (CreateIntent, ReplacementIdentified)
                | (CreateUncertain, ReplacementIdentified)
                | (CreateUncertain, OldAbsent)
                | (ReplacementIdentified, Provisioning)
                | (ReplacementIdentified, ReplacementDeleteIntent)
                | (Provisioning, ReplacementFailed)
                | (Provisioning, ReadyPaused)
                | (ReplacementFailed, Provisioning)
                | (ReplacementFailed, ReplacementDeleteIntent)
                | (ReplacementDeleteIntent, ReplacementDeleteUncertain)
                | (ReplacementDeleteIntent, OldAbsent)
                | (ReplacementDeleteUncertain, ReplacementDeleteIntent)
                | (ReplacementDeleteUncertain, OldAbsent)
                | (ReadyPaused, Completed)
                | (Planned, CancelledPreDelete)
                | (ConsentPending, CancelledPreDelete)
        )
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchIssueV1 {
    pub code: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchTargetV1 {
    pub replacement_attempt_id: String,
    pub attempt_revision: u64,
    pub gpu_id: String,
    pub gpu_display_name: String,
    pub hourly_price_micro_usd: u64,
    pub observation_id: String,
    pub receipt_id: String,
    pub inventory_observed_at: String,
    pub price_confirmed_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchPreparedTargetV1 {
    pub quote_id: String,
    pub prepared_from_record_revision: u64,
    pub gpu_id: String,
    pub gpu_display_name: String,
    pub hourly_price_micro_usd: u64,
    pub observation_id: String,
    pub receipt_id: String,
    pub prepared_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeGpuSwitchPriorAttemptOutcomeV1 {
    NotCreated,
    FailedReplacementDeleted,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchPriorAttemptV1 {
    #[serde(flatten)]
    pub target: NativeGpuSwitchTargetV1,
    pub replacement_pod_id: Option<String>,
    pub outcome: NativeGpuSwitchPriorAttemptOutcomeV1,
    pub settled_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchQueueReservationV1 {
    pub active: bool,
    pub queue_run_revision: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchRecordV1 {
    pub schema_version: u8,
    pub switch_id: String,
    pub record_revision: u64,
    pub phase: NativeGpuSwitchPhaseV1,
    pub blocked_at: Option<NativeGpuSwitchPhaseV1>,
    pub attention_code: Option<String>,
    pub authorization_required: bool,
    pub target_confirmation: NativeGpuSwitchTargetConfirmationV1,
    pub old_pod: NativeGpuSwitchPodV1,
    pub initial_target: NativeGpuSwitchTargetV1,
    pub current_target: NativeGpuSwitchTargetV1,
    pub prepared_target: Option<NativeGpuSwitchPreparedTargetV1>,
    pub prior_attempts: Vec<NativeGpuSwitchPriorAttemptV1>,
    pub queue_reservation: NativeGpuSwitchQueueReservationV1,
    pub expected_batch_id: Option<String>,
    pub old_delete_wire_attempts: u8,
    pub replacement_pod_id: Option<String>,
    pub peer_pod_ids: Vec<String>,
    pub peer_pod_overflow: bool,
    pub actual_hourly_price_micro_usd: Option<u64>,
    pub confirmed_actual_price: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchSnapshotV1 {
    pub schema_version: u8,
    pub store_revision: u64,
    pub record: Option<NativeGpuSwitchRecordV1>,
    pub issues: Vec<NativeGpuSwitchIssueV1>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuObservationChoiceV1 {
    pub observation_id: String,
    pub receipt_id: String,
    pub target_gpu_id: String,
    pub confirmed_hourly_price_micro_usd: u64,
}

/// Strict JSON-null marker. `Option<()>` would accept a missing field, which
/// would weaken the discriminated IPC shape contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequiredJsonNull;

impl<'de> Deserialize<'de> for RequiredJsonNull {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct NullVisitor;
        impl<'de> Visitor<'de> for NullVisitor {
            type Value = RequiredJsonNull;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("JSON null")
            }
            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(RequiredJsonNull)
            }
        }
        deserializer.deserialize_unit(NullVisitor)
    }
}

impl Serialize for RequiredJsonNull {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_unit()
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchBeginGrantRequestV1 {
    pub action: NativeGpuSwitchBeginGrantActionV1,
    pub switch_id: RequiredJsonNull,
    pub observation_id: String,
    pub target_gpu_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeGpuSwitchBeginGrantActionV1 {
    Begin,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchResumeGrantRequestV1 {
    pub action: NativeGpuSwitchResumeGrantActionV1,
    pub switch_id: String,
    pub observation_id: RequiredJsonNull,
    pub target_gpu_id: RequiredJsonNull,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeGpuSwitchResumeGrantActionV1 {
    Resume,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum NativeGpuSwitchForegroundGrantRequestV1 {
    Begin(NativeGpuSwitchBeginGrantRequestV1),
    Resume(NativeGpuSwitchResumeGrantRequestV1),
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchForegroundGrantV1 {
    pub schema_version: u8,
    pub grant_id: String,
    pub process_epoch_id: String,
    pub action: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchBeginV1 {
    pub observation_id: String,
    pub receipt_id: String,
    pub target_gpu_id: String,
    pub confirmed_hourly_price_micro_usd: u64,
    pub expected_store_revision: u64,
    pub session_id: String,
    pub queue_expected_store_revision: u64,
    pub queue_run_revision: Option<String>,
    pub foreground_grant_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchKeyV1 {
    pub switch_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchAcquireV1 {
    pub switch_id: String,
    pub foreground_grant_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchRevisionKeyV1 {
    pub switch_id: String,
    pub expected_record_revision: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchWorkerSyncV1 {
    pub switch_id: String,
    pub expected_record_revision: u64,
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchFreshWorkerV1 {
    pub switch_id: String,
    pub expected_record_revision: u64,
    pub session_id: String,
    pub observation_id: String,
    pub receipt_id: String,
    pub target_gpu_id: String,
    pub confirmed_hourly_price_micro_usd: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchPrepareTargetV1 {
    pub switch_id: String,
    pub expected_record_revision: u64,
    pub observation_id: String,
    pub receipt_id: String,
    pub target_gpu_id: String,
    pub confirmed_hourly_price_micro_usd: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchConfirmAttemptV1 {
    pub switch_id: String,
    pub expected_record_revision: u64,
    pub observation_id: String,
    pub receipt_id: String,
    pub target_gpu_id: String,
    pub confirmed_hourly_price_micro_usd: u64,
    pub quote_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeGpuSwitchProviderReconcileReasonV1 {
    Resume,
    AfterDelete,
    AfterCreate,
    Provisioning,
    ZeroMatchProof,
    AfterReplacementDelete,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchProviderReconcileV1 {
    pub switch_id: String,
    pub expected_record_revision: u64,
    pub reason: NativeGpuSwitchProviderReconcileReasonV1,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeGpuSwitchReplacementDeleteReasonV1 {
    ReplacementFailed,
    ActualPriceRejected,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchReplacementDeleteV1 {
    pub switch_id: String,
    pub expected_record_revision: u64,
    pub replacement_pod_id: String,
    pub reason: NativeGpuSwitchReplacementDeleteReasonV1,
    pub confirmation: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchActualPriceV1 {
    pub switch_id: String,
    pub expected_record_revision: u64,
    pub confirmed_actual_hourly_price_micro_usd: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchLeaseV1 {
    pub switch_id: String,
    pub held: bool,
}

/// Private command-orchestration proof. It is intentionally never registered
/// with Tauri and lets the worker adapter bind a terminal tombstone without
/// exposing principal or tombstone material to React.
#[derive(Debug, Clone)]
pub(crate) struct NativeGpuSwitchTerminalProofV1 {
    pub terminal_reason: NativeGpuSwitchTerminalReasonV1,
    pub principal_binding_id: Option<String>,
    pub worker_tombstone_sha256: Option<String>,
}

/// Native-only evidence assembled from a pinned worker create plan before the
/// first network byte is written. The canonical body is safe JSON but remains
/// private because it binds session/Pod/attempt authority and must never be
/// renderer-authored or silently regenerated on Resume.
#[derive(Clone)]
pub(crate) struct NativeGpuSwitchWorkerCreateIntentV1 {
    pub profile_binding_sha256: String,
    pub credential_binding_sha256: String,
    pub worker_session_binding_sha256: String,
    pub canonical_body: String,
    pub canonical_body_sha256: String,
}

/// Exact native provider-create fingerprints committed together before the
/// replacement POST.  The marker and intent hashes bind the worker adoption
/// contract while the wire hash binds the only provider request body.
#[derive(Debug, Clone)]
pub(crate) struct NativeGpuSwitchProviderCreateIntentV1 {
    pub create_marker_sha256: String,
    pub create_intent_sha256: String,
    pub create_wire_body_sha256: String,
    pub observation_id: String,
    pub receipt_id: String,
    pub inventory_observed_at: String,
}

/// Private binding returned only by the pinned worker create/owner lookup.
/// The worker, not a renderer input or bearer-token parser, supplies the
/// authenticated requester identity and the opaque principal binding.
#[derive(Clone)]
pub(crate) struct NativeGpuSwitchWorkerBindingV1 {
    pub requester_user_id: String,
    pub principal_binding_id: String,
}

/// Private worker-route material derived exclusively from a bound switch
/// generation. It is intentionally not serializable: callers use it only to
/// construct fixed native worker routes after the renderer has supplied an
/// already-validated revision key.
#[derive(Debug, Clone)]
pub(crate) struct NativeGpuSwitchWorkerAccessV1 {
    pub switch_id: String,
    pub record_revision: u64,
    pub session_id: String,
    pub old_pod_id: String,
    pub old_gpu_id: String,
    pub replacement_pod_id: Option<String>,
    pub finalization_id: Option<String>,
    pub requester_user_id: String,
    pub principal_binding_id: String,
    pub current_target: NativeGpuSwitchTargetV1,
    pub provider_request_sha256: Option<String>,
    pub provider_response_sha256: Option<String>,
    pub create_marker_sha256: Option<String>,
    pub create_intent_sha256: Option<String>,
    pub create_wire_body_sha256: Option<String>,
    pub runtime_identity_sha256: Option<String>,
}

/// Private replay material for the one safe way to resolve a create whose
/// response was lost. It is reconstructed only from the canonical persisted
/// worker body and never serializes across Tauri IPC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NativeGpuSwitchUncertainCreateAccessV1 {
    pub switch_id: String,
    pub record_revision: u64,
    pub session_id: String,
    pub old_pod_id: String,
    pub old_gpu_id: String,
    pub old_gpu_display_name: String,
    pub initial_target_gpu_id: String,
    pub initial_target_gpu_display_name: String,
    pub initial_replacement_attempt_id: String,
    pub expected_batch_id: Option<String>,
    pub inventory_observed_at: String,
}

#[derive(Debug, Clone)]
pub struct NativeGpuSwitchSelectionEvidenceV1 {
    pub old_pod: NativeGpuSwitchPodV1,
    pub target_gpu_display_name: String,
    pub inventory_observed_at: String,
    pub inventory_catalog_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiskGenerationV1 {
    schema_version: u8,
    store_revision: u64,
    record: Option<NativeGpuSwitchRecordV1>,
    private: PrivateGpuSwitchGenerationV1,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum PrivateWorkerCreateStateV1 {
    Draft,
    SendPending,
    SentUncertain,
    Bound,
    Terminal,
}

/// Private, append-only evidence for a replacement creation attempt that has
/// been conclusively cleaned up.  The active attempt stays in the two
/// `provider_*` fields below so a response-loss can be reconciled without
/// exposing provider request material to the renderer.  Once that attempt is
/// deleted, its fingerprints move here before a new attempt may bind fresh
/// request/response fingerprints.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrivateGpuSwitchProviderAttemptV1 {
    schema_version: u8,
    replacement_attempt_id: String,
    attempt_revision: u64,
    request_sha256: String,
    response_sha256: Option<String>,
    create_marker_sha256: String,
    create_intent_sha256: String,
    create_wire_body_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrivateGpuSwitchGenerationV1 {
    schema_version: u8,
    worker_create_state: PrivateWorkerCreateStateV1,
    process_epoch_id: Option<String>,
    inventory_observation_id: Option<String>,
    inventory_receipt_id: Option<String>,
    inventory_catalog_sha256: Option<String>,
    consumed_foreground_grant_sha256: Option<String>,
    worker_create_body: Option<String>,
    worker_create_body_sha256: Option<String>,
    worker_create_session_binding_sha256: Option<String>,
    worker_create_session_id: Option<String>,
    requester_user_id: Option<String>,
    principal_binding_id: Option<String>,
    worker_finalization_id: Option<String>,
    profile_binding_sha256: Option<String>,
    credential_binding_sha256: Option<String>,
    /// Fingerprints for the one currently active replacement attempt only.
    /// They are deliberately reset only by the durable failed-replacement
    /// cleanup transition, which appends their immutable values to
    /// `provider_attempt_history` in the same atomic generation.
    provider_request_sha256: Option<String>,
    provider_response_sha256: Option<String>,
    create_marker_sha256: Option<String>,
    create_intent_sha256: Option<String>,
    create_wire_body_sha256: Option<String>,
    #[serde(default)]
    provider_attempt_history: Vec<PrivateGpuSwitchProviderAttemptV1>,
    zero_match_proof_sha256: Option<String>,
    runtime_identity_sha256: Option<String>,
    queue_reservation_sha256: Option<String>,
    queue_reservation_revision: Option<u64>,
}

impl PrivateGpuSwitchGenerationV1 {
    fn empty() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            worker_create_state: PrivateWorkerCreateStateV1::Draft,
            process_epoch_id: None,
            inventory_observation_id: None,
            inventory_receipt_id: None,
            inventory_catalog_sha256: None,
            consumed_foreground_grant_sha256: None,
            worker_create_body: None,
            worker_create_body_sha256: None,
            worker_create_session_binding_sha256: None,
            worker_create_session_id: None,
            requester_user_id: None,
            principal_binding_id: None,
            worker_finalization_id: None,
            profile_binding_sha256: None,
            credential_binding_sha256: None,
            provider_request_sha256: None,
            provider_response_sha256: None,
            create_marker_sha256: None,
            create_intent_sha256: None,
            create_wire_body_sha256: None,
            provider_attempt_history: Vec::new(),
            zero_match_proof_sha256: None,
            runtime_identity_sha256: None,
            queue_reservation_sha256: None,
            queue_reservation_revision: None,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PrivateWorkerCreateBodyV1 {
    schema_version: u8,
    switch_id: String,
    session_id: String,
    old_pod_id: String,
    old_gpu_id: String,
    old_gpu_display_name: String,
    initial_target_gpu_id: String,
    initial_target_gpu_display_name: String,
    initial_replacement_attempt_id: String,
    expected_batch_id: Option<String>,
    inventory_observed_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum PrivateGpuSwitchQueueReservationPhaseV1 {
    Prepared,
    Active,
    Releasing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrivateGpuSwitchQueueReservationV1 {
    schema_version: u8,
    reservation_revision: u64,
    switch_id: String,
    phase: PrivateGpuSwitchQueueReservationPhaseV1,
    queue_store_revision: u64,
    queue_run_revision: Option<String>,
    native_store_revision: Option<u64>,
    native_record_revision: Option<u64>,
    terminal_state: Option<String>,
    worker_tombstone_sha256: Option<String>,
    native_history_sha256: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativeGpuSwitchTerminalReasonV1 {
    ReplacementCompleted,
    RequesterCancelled,
    PeerDenied,
    ResponseTimeout,
    RequesterExpired,
    GenerationStarted,
    BatchChanged,
    StopStarted,
    TargetChangedPreDelete,
    LocalDraftCancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeGpuSwitchHistoryV1 {
    schema_version: u8,
    switch_id: String,
    terminal_state: String,
    terminal_reason: NativeGpuSwitchTerminalReasonV1,
    terminal_at: String,
    old_pod_id: String,
    replacement_pod_id: Option<String>,
    final_attempt_id: String,
    principal_binding_sha256: Option<String>,
    worker_tombstone_sha256: Option<String>,
}

#[derive(Debug, Clone)]
enum ForegroundGrantBinding {
    Begin {
        observation_id: String,
        target_gpu_id: String,
    },
    Resume {
        switch_id: String,
    },
}

#[derive(Debug, Clone)]
struct ForegroundGrantPrivate {
    binding: ForegroundGrantBinding,
    issued_at: Instant,
}

#[derive(Debug, Clone)]
struct PreparedQuotePrivate {
    switch_id: String,
    record_revision: u64,
    target_gpu_id: String,
    receipt_id: String,
    inventory_observed_at: String,
    issued_at: Instant,
}

#[derive(Debug)]
struct SwitchInner {
    generation: DiskGenerationV1,
    issues: Vec<NativeGpuSwitchIssueV1>,
    unrecoverable: bool,
    held_lease: Option<String>,
    grants: HashMap<String, ForegroundGrantPrivate>,
    quotes: HashMap<String, PreparedQuotePrivate>,
}

#[derive(Debug)]
struct SwitchJournal {
    root: PathBuf,
    io: Mutex<()>,
}

/// A small native transaction coordinator. It owns only local proof and
/// state-machine transitions. Callers must perform the specified private
/// worker/RunPod operation before asking it to advance a remote phase.
#[derive(Clone)]
pub struct GpuSwitchService {
    process_epoch_id: String,
    inner: Arc<Mutex<SwitchInner>>,
    journal: Arc<SwitchJournal>,
}

impl GpuSwitchService {
    pub fn new(process_epoch_id: String) -> NativeResult<Self> {
        Self::with_root(process_epoch_id, default_switch_root()?)
    }

    fn with_root(process_epoch_id: String, root: PathBuf) -> NativeResult<Self> {
        validate_uuid_v4(&process_epoch_id, "gpu_switch_store_unrecoverable")?;
        let journal = Arc::new(SwitchJournal::new(root)?);
        let loaded = journal.load()?;
        let mut issues = Vec::new();
        if let Some(code) = loaded
            .generation
            .as_ref()
            .and_then(|generation| generation.record.as_ref())
            .and_then(|record| record.attention_code.as_deref())
        {
            issues.push(issue(code));
        }
        if loaded.recovered {
            issues.push(issue("gpu_switch_store_recovered"));
        }
        if loaded.unrecoverable {
            issues.push(issue("gpu_switch_store_unrecoverable"));
        }
        Ok(Self {
            process_epoch_id,
            inner: Arc::new(Mutex::new(SwitchInner {
                generation: loaded.generation.unwrap_or(DiskGenerationV1 {
                    schema_version: SCHEMA_VERSION,
                    store_revision: 0,
                    record: None,
                    private: PrivateGpuSwitchGenerationV1::empty(),
                }),
                issues,
                unrecoverable: loaded.unrecoverable,
                held_lease: None,
                grants: HashMap::new(),
                quotes: HashMap::new(),
            })),
            journal,
        })
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(root: PathBuf) -> NativeResult<Self> {
        Self::with_root("00000000-0000-4000-8000-000000000001".to_owned(), root)
    }

    pub fn load(&self) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        let inner = self.inner.lock().map_err(|_| state_error())?;
        Ok(snapshot_from_inner(&inner))
    }

    /// Read the local Switch journal before an ordinary Stop starts any
    /// provider/worker work. The command holds its process-local profile
    /// control gate through the whole action; worker finalization remains the
    /// authoritative cross-process final race gate.
    pub(crate) fn veto_normal_stop(&self) -> NativeResult<()> {
        let inner = self.inner.lock().map_err(|_| state_error())?;
        let Some(record) = inner.generation.record.as_ref() else {
            return Ok(());
        };
        normal_stop_veto_for_phase(record.phase, record.blocked_at)
    }

    /// Re-read the durable Switch generation and both queue-reservation copies
    /// while the caller owns `profile-control.lock`. A separately running
    /// ImageForge process may have committed a newer `CURRENT` after this
    /// service was constructed, so the process-local snapshot above is never
    /// sufficient at a normal Stop admission or final-I/O boundary.
    ///
    /// `SwitchJournal::load` validates CURRENT, retained generations and
    /// `QUEUE_RESERVATION`/`.prev` as one cross-record proof. Any unreadable or
    /// mismatched seam is a fail-closed store error; a recovered generation is
    /// likewise not provider-mutation authority until the Switch recovery path
    /// explicitly reacquires it.
    pub(crate) fn veto_normal_stop_from_disk(&self) -> NativeResult<()> {
        let loaded = self.journal.load()?;
        if loaded.unrecoverable {
            return Err(state_error());
        }
        if loaded.recovered {
            return Err(switch_error("gpu_switch_store_recovered"));
        }
        // `load` has already validated both reservation copies against the
        // selected generation. Read the authoritative current/previous choice
        // once more so a terminal history in the deliberate `releasing` seam
        // remains a profile-action blocker until reservation cleanup commits.
        let reservation = self.journal.read_reservation()?;
        let Some(record) = loaded.generation.and_then(|generation| generation.record) else {
            if reservation.is_some() {
                return Err(switch_error("gpu_switch_pending"));
            }
            return Ok(());
        };
        normal_stop_veto_for_phase(record.phase, record.blocked_at)?;
        if reservation.is_some_and(|reservation| {
            matches!(
                reservation.phase,
                PrivateGpuSwitchQueueReservationPhaseV1::Prepared
                    | PrivateGpuSwitchQueueReservationPhaseV1::Active
                    | PrivateGpuSwitchQueueReservationPhaseV1::Releasing
            )
        }) {
            return Err(switch_error("gpu_switch_pending"));
        }
        Ok(())
    }

    /// Block queue admission while any durable Switch reservation phase owns
    /// the profile. Queue commands call this while holding the same
    /// `profile-control.lock`; the renderer cannot clear or reinterpret a
    /// prepared/active/releasing envelope.
    pub(crate) fn veto_queue_action_from_disk(&self) -> NativeResult<()> {
        let loaded = self.journal.load()?;
        let reservations = self.journal.reservation_candidates().map_err(|_| {
            NativeError::new(
                "gpu_switch_queue_reservation_corrupt",
                "The GPU switch queue reservation is unavailable until its local evidence is repaired.",
            )
        })?;
        // Exact crash seam: `prepared` is intentionally the first durable
        // write, so process loss may occur before any native generation is
        // legal. It cannot reconstruct or authorize the Switch, but the
        // canonical reservation remains a queue blocker rather than corrupt
        // bytes. Any generation/CURRENT or non-prepared candidate makes this
        // an ordinary fail-closed mismatch instead.
        let prepared_only_crash = loaded.unrecoverable
            && loaded.generation.is_none()
            && !self.journal.current_path().exists()
            && self.journal.generation_ids()?.is_empty()
            && reservations.len() == 1
            && reservations[0].phase == PrivateGpuSwitchQueueReservationPhaseV1::Prepared;
        if loaded.unrecoverable && !prepared_only_crash {
            return Err(NativeError::new(
                "gpu_switch_queue_reservation_corrupt",
                "The GPU switch queue reservation is unavailable until its local evidence is repaired.",
            ));
        }
        if reservations.iter().any(|reservation| {
            matches!(
                reservation.phase,
                PrivateGpuSwitchQueueReservationPhaseV1::Prepared
                    | PrivateGpuSwitchQueueReservationPhaseV1::Active
                    | PrivateGpuSwitchQueueReservationPhaseV1::Releasing
            )
        }) {
            return Err(NativeError::new(
                "queue_gpu_switch_pending",
                "A coordinated GPU switch is reserving this profile. Resume or resolve it before continuing the queue.",
            ));
        }
        if loaded
            .generation
            .as_ref()
            .and_then(|generation| generation.record.as_ref())
            .is_some_and(|record| !record.phase.is_terminal())
        {
            return Err(NativeError::new(
                "gpu_switch_queue_reservation_corrupt",
                "The GPU switch queue reservation is unavailable until its local evidence is repaired.",
            ));
        }
        Ok(())
    }

    pub fn process_epoch_id(&self) -> &str {
        &self.process_epoch_id
    }

    /// Mint a process-local grant only after the IPC command has independently
    /// checked the main focused native window and trusted native activation.
    pub fn authorize_foreground(
        &self,
        request: NativeGpuSwitchForegroundGrantRequestV1,
    ) -> NativeResult<NativeGpuSwitchForegroundGrantV1> {
        let binding = match request {
            NativeGpuSwitchForegroundGrantRequestV1::Begin(request) => {
                validate_uuid_v4(
                    &request.observation_id,
                    "gpu_switch_foreground_grant_invalid",
                )?;
                validate_gpu_identity(&request.target_gpu_id)?;
                ForegroundGrantBinding::Begin {
                    observation_id: request.observation_id,
                    target_gpu_id: request.target_gpu_id,
                }
            }
            NativeGpuSwitchForegroundGrantRequestV1::Resume(request) => {
                validate_uuid_v4(&request.switch_id, "gpu_switch_foreground_grant_invalid")?;
                ForegroundGrantBinding::Resume {
                    switch_id: request.switch_id,
                }
            }
        };
        let grant_id = Uuid::new_v4().to_string();
        let expires_at = utc_after(FOREGROUND_GRANT_TTL)?;
        let action = match &binding {
            ForegroundGrantBinding::Begin { .. } => "begin",
            ForegroundGrantBinding::Resume { .. } => "resume",
        }
        .to_owned();
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        if inner.unrecoverable {
            return Err(switch_error("gpu_switch_store_unrecoverable"));
        }
        inner.grants.insert(
            grant_id.clone(),
            ForegroundGrantPrivate {
                binding,
                issued_at: Instant::now(),
            },
        );
        Ok(NativeGpuSwitchForegroundGrantV1 {
            schema_version: SCHEMA_VERSION,
            grant_id,
            process_epoch_id: self.process_epoch_id.clone(),
            action,
            expires_at,
        })
    }

    /// Create only a local planned transaction. The private worker request is
    /// intentionally performed by the command orchestration before it advances
    /// this record to `consent_pending`.
    #[cfg(test)]
    pub fn begin(
        &self,
        input: NativeGpuSwitchBeginV1,
        evidence: NativeGpuSwitchSelectionEvidenceV1,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        self.begin_with_queue_park(input, evidence, |expected_revision, _| {
            Ok(expected_revision)
        })
    }

    pub fn begin_with_queue_park<F>(
        &self,
        input: NativeGpuSwitchBeginV1,
        evidence: NativeGpuSwitchSelectionEvidenceV1,
        park_queue: F,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1>
    where
        F: FnOnce(u64, Option<&str>) -> NativeResult<u64>,
    {
        validate_begin_input(&input)?;
        validate_pod(&evidence.old_pod)?;
        validate_gpu_identity(&evidence.target_gpu_display_name)?;
        validate_timestamp(&evidence.inventory_observed_at)?;
        if !valid_sha256(&evidence.inventory_catalog_sha256) {
            return Err(switch_error("gpu_switch_inventory_receipt_invalid"));
        }
        if input.target_gpu_id == evidence.old_pod.gpu_id {
            return Err(switch_error("gpu_switch_target_unapproved"));
        }
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        if inner.generation.store_revision != input.expected_store_revision {
            return Err(switch_error("gpu_switch_revision_conflict"));
        }
        if inner
            .generation
            .record
            .as_ref()
            .is_some_and(|record| !record.phase.is_terminal())
        {
            return Err(switch_error("gpu_switch_active"));
        }
        consume_begin_grant(
            &mut inner,
            &input.foreground_grant_id,
            &input.observation_id,
            &input.target_gpu_id,
        )?;
        let private_draft = PrivateGpuSwitchGenerationV1 {
            process_epoch_id: Some(self.process_epoch_id.clone()),
            inventory_observation_id: Some(input.observation_id.clone()),
            inventory_receipt_id: Some(input.receipt_id.clone()),
            inventory_catalog_sha256: Some(evidence.inventory_catalog_sha256.clone()),
            consumed_foreground_grant_sha256: Some(sha256_text(&input.foreground_grant_id)),
            ..PrivateGpuSwitchGenerationV1::empty()
        };
        let now = utc_now()?;
        let target = NativeGpuSwitchTargetV1 {
            replacement_attempt_id: Uuid::new_v4().to_string(),
            attempt_revision: 1,
            gpu_id: input.target_gpu_id,
            gpu_display_name: evidence.target_gpu_display_name,
            hourly_price_micro_usd: input.confirmed_hourly_price_micro_usd,
            observation_id: input.observation_id,
            receipt_id: input.receipt_id,
            inventory_observed_at: evidence.inventory_observed_at,
            price_confirmed_at: now.clone(),
        };
        let record = NativeGpuSwitchRecordV1 {
            schema_version: SCHEMA_VERSION,
            switch_id: Uuid::new_v4().to_string(),
            record_revision: 1,
            phase: NativeGpuSwitchPhaseV1::Planned,
            blocked_at: None,
            attention_code: None,
            authorization_required: true,
            target_confirmation: NativeGpuSwitchTargetConfirmationV1::Required,
            old_pod: evidence.old_pod,
            initial_target: target.clone(),
            current_target: target,
            prepared_target: None,
            prior_attempts: Vec::new(),
            queue_reservation: NativeGpuSwitchQueueReservationV1 {
                active: true,
                queue_run_revision: input.queue_run_revision,
            },
            expected_batch_id: None,
            old_delete_wire_attempts: 0,
            replacement_pod_id: None,
            peer_pod_ids: Vec::new(),
            peer_pod_overflow: false,
            actual_hourly_price_micro_usd: None,
            confirmed_actual_price: false,
            created_at: now.clone(),
            updated_at: now,
        };
        validate_record(&record, &inner.issues)?;
        let switch_id = record.switch_id.clone();
        let prepared_reservation = PrivateGpuSwitchQueueReservationV1 {
            schema_version: SCHEMA_VERSION,
            reservation_revision: 1,
            switch_id: switch_id.clone(),
            phase: PrivateGpuSwitchQueueReservationPhaseV1::Prepared,
            queue_store_revision: input.queue_expected_store_revision,
            queue_run_revision: record.queue_reservation.queue_run_revision.clone(),
            native_store_revision: None,
            native_record_revision: None,
            terminal_state: None,
            worker_tombstone_sha256: None,
            native_history_sha256: None,
            created_at: record.created_at.clone(),
            updated_at: record.updated_at.clone(),
        };
        // The prepared reservation is the first crash-safe blocker. It lands
        // before the durable planned transaction so queue acquisition can
        // never race an unreserved Switch draft.
        self.journal.write_reservation(&prepared_reservation)?;
        let parked_queue_store_revision = park_queue(
            input.queue_expected_store_revision,
            record.queue_reservation.queue_run_revision.as_deref(),
        )?;
        let maximum_parked_revision = input
            .queue_expected_store_revision
            .checked_add(1)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .unwrap_or(input.queue_expected_store_revision);
        if parked_queue_store_revision < input.queue_expected_store_revision
            || parked_queue_store_revision > maximum_parked_revision
            || (record.queue_reservation.queue_run_revision.is_none()
                && parked_queue_store_revision != input.queue_expected_store_revision)
        {
            return Err(switch_error("gpu_switch_queue_reservation_conflict"));
        }
        let planned_store_revision = next_revision(inner.generation.store_revision)?;
        let generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: planned_store_revision,
            record: Some(record.clone()),
            private: PrivateGpuSwitchGenerationV1 {
                queue_reservation_sha256: Some(reservation_sha256(&prepared_reservation)),
                queue_reservation_revision: Some(prepared_reservation.reservation_revision),
                ..private_draft
            },
        };
        self.commit_prebound_locked(&mut inner, generation)?;
        let active_store_revision = next_revision(inner.generation.store_revision)?;
        let active_reservation = PrivateGpuSwitchQueueReservationV1 {
            reservation_revision: 2,
            phase: PrivateGpuSwitchQueueReservationPhaseV1::Active,
            queue_store_revision: parked_queue_store_revision,
            native_store_revision: Some(active_store_revision),
            native_record_revision: Some(record.record_revision),
            updated_at: utc_now()?,
            ..prepared_reservation
        };
        self.journal.write_reservation(&active_reservation)?;
        let active_generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: active_store_revision,
            record: Some(record),
            private: PrivateGpuSwitchGenerationV1 {
                queue_reservation_sha256: Some(reservation_sha256(&active_reservation)),
                queue_reservation_revision: Some(active_reservation.reservation_revision),
                ..inner.generation.private.clone()
            },
        };
        self.commit_prebound_locked(&mut inner, active_generation)?;
        inner.held_lease = Some(switch_id);
        Ok(snapshot_from_inner(&inner))
    }

    /// Persist the exact worker-create bytes and all native-only bindings
    /// before any socket write. This is the sole transition from a local
    /// planned draft into `send_pending`; a crash here proves no worker POST
    /// may have started and permits only the narrowly defined local-draft
    /// cancellation path.
    pub(crate) fn prepare_worker_create_send_pending(
        &self,
        switch_id: &str,
        expected_record_revision: u64,
        intent: NativeGpuSwitchWorkerCreateIntentV1,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        validate_uuid_v4(switch_id, "gpu_switch_not_found")?;
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        self.ensure_disk_matches_inner(&inner)?;
        ensure_held(&inner, switch_id)?;
        let record = exact_record(&inner, switch_id)?.clone();
        if record.record_revision != expected_record_revision {
            return Err(switch_error("gpu_switch_revision_conflict"));
        }
        if record.phase != NativeGpuSwitchPhaseV1::Planned
            || inner.generation.private.worker_create_state != PrivateWorkerCreateStateV1::Draft
        {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        validate_worker_create_intent(&intent, &record)?;
        let mut private = inner.generation.private.clone();
        private.worker_create_state = PrivateWorkerCreateStateV1::SendPending;
        private.profile_binding_sha256 = Some(intent.profile_binding_sha256);
        private.credential_binding_sha256 = Some(intent.credential_binding_sha256);
        private.worker_create_session_binding_sha256 = Some(intent.worker_session_binding_sha256);
        private.worker_create_body = Some(intent.canonical_body);
        private.worker_create_body_sha256 = Some(intent.canonical_body_sha256);
        private.worker_create_session_id = Some(worker_create_body_session_id(
            private
                .worker_create_body
                .as_deref()
                .ok_or_else(state_error)?,
        )?);
        let generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: next_revision(inner.generation.store_revision)?,
            record: Some(record),
            private,
        };
        self.commit_locked(&mut inner, generation)?;
        Ok(snapshot_from_inner(&inner))
    }

    /// Consume the local proof that the first worker-create socket write is
    /// about to occur. Any response loss from this point is permanently
    /// `sent_uncertain` and must use owner lookup/settling; it can never issue
    /// another switch ID or silently return to a retryable draft.
    pub(crate) fn mark_worker_create_sent_uncertain(
        &self,
        switch_id: &str,
        expected_record_revision: u64,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        validate_uuid_v4(switch_id, "gpu_switch_not_found")?;
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        self.ensure_disk_matches_inner(&inner)?;
        ensure_held(&inner, switch_id)?;
        let record = exact_record(&inner, switch_id)?.clone();
        if record.record_revision != expected_record_revision {
            return Err(switch_error("gpu_switch_revision_conflict"));
        }
        if record.phase != NativeGpuSwitchPhaseV1::Planned
            || inner.generation.private.worker_create_state
                != PrivateWorkerCreateStateV1::SendPending
        {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        let mut private = inner.generation.private.clone();
        private.worker_create_state = PrivateWorkerCreateStateV1::SentUncertain;
        let generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: next_revision(inner.generation.store_revision)?,
            record: Some(record),
            private,
        };
        self.commit_locked(&mut inner, generation)?;
        Ok(snapshot_from_inner(&inner))
    }

    /// Bind the only admissible worker-create response. This transitions the
    /// renderer-visible record to consent-pending only after the opaque worker
    /// principal and authenticated requester identity are durable.
    pub(crate) fn bind_worker_create_response(
        &self,
        switch_id: &str,
        expected_record_revision: u64,
        binding: NativeGpuSwitchWorkerBindingV1,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        validate_uuid_v4(switch_id, "gpu_switch_not_found")?;
        validate_worker_binding(&binding)?;
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        self.ensure_disk_matches_inner(&inner)?;
        ensure_held(&inner, switch_id)?;
        let prior = exact_record(&inner, switch_id)?.clone();
        if prior.record_revision != expected_record_revision {
            return Err(switch_error("gpu_switch_revision_conflict"));
        }
        let effective_planned = prior.phase == NativeGpuSwitchPhaseV1::Planned
            || (prior.phase == NativeGpuSwitchPhaseV1::NeedsAttention
                && prior.blocked_at == Some(NativeGpuSwitchPhaseV1::Planned));
        if !effective_planned
            || inner.generation.private.worker_create_state
                != PrivateWorkerCreateStateV1::SentUncertain
        {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        let mut candidate = prior;
        candidate.phase = NativeGpuSwitchPhaseV1::ConsentPending;
        candidate.blocked_at = None;
        candidate.attention_code = None;
        candidate.record_revision = next_revision(candidate.record_revision)?;
        candidate.updated_at = utc_now()?;
        let candidate_issues = inner
            .issues
            .iter()
            .filter(|issue| issue.code == "gpu_switch_store_recovered")
            .cloned()
            .collect::<Vec<_>>();
        validate_transition(
            inner.generation.record.as_ref().ok_or_else(state_error)?,
            &candidate,
            &candidate_issues,
        )?;
        let mut private = inner.generation.private.clone();
        private.worker_create_state = PrivateWorkerCreateStateV1::Bound;
        private.requester_user_id = Some(binding.requester_user_id);
        private.principal_binding_id = Some(binding.principal_binding_id);
        let generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: next_revision(inner.generation.store_revision)?,
            record: Some(candidate),
            private,
        };
        self.commit_locked(&mut inner, generation)?;
        inner.issues = candidate_issues;
        Ok(snapshot_from_inner(&inner))
    }

    /// Owner lookup after a lost create response must be exact. A matching
    /// bound record is a no-op; a sent-uncertain record is bound through the
    /// same one-way transition. Mismatched principal/user values never become
    /// evidence for a different request.
    pub(crate) fn bind_or_validate_worker_owner(
        &self,
        switch_id: &str,
        expected_record_revision: u64,
        binding: NativeGpuSwitchWorkerBindingV1,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        validate_uuid_v4(switch_id, "gpu_switch_not_found")?;
        validate_worker_binding(&binding)?;
        let state = {
            let inner = self.inner.lock().map_err(|_| state_error())?;
            ensure_writable(&inner)?;
            ensure_held(&inner, switch_id)?;
            let record = exact_record(&inner, switch_id)?;
            if record.record_revision != expected_record_revision {
                return Err(switch_error("gpu_switch_revision_conflict"));
            }
            inner.generation.private.worker_create_state
        };
        match state {
            PrivateWorkerCreateStateV1::SentUncertain => {
                self.bind_worker_create_response(switch_id, expected_record_revision, binding)
            }
            PrivateWorkerCreateStateV1::Bound => {
                let inner = self.inner.lock().map_err(|_| state_error())?;
                let private = &inner.generation.private;
                if private.requester_user_id.as_deref() != Some(binding.requester_user_id.as_str())
                    || private.principal_binding_id.as_deref()
                        != Some(binding.principal_binding_id.as_str())
                {
                    return Err(switch_error("gpu_switch_transition_invalid"));
                }
                Ok(snapshot_from_inner(&inner))
            }
            _ => Err(switch_error("gpu_switch_transition_invalid")),
        }
    }

    /// Return the exact private worker binding for a durable, bound switch.
    /// It is the sole source of a follow-up route's session and Pod identity;
    /// callers cannot replace either from renderer state after consent.
    pub(crate) fn worker_access(
        &self,
        switch_id: &str,
        expected_record_revision: u64,
    ) -> NativeResult<NativeGpuSwitchWorkerAccessV1> {
        validate_revision_key(switch_id, expected_record_revision)?;
        let inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        ensure_held(&inner, switch_id)?;
        let record = exact_record(&inner, switch_id)?;
        if record.record_revision != expected_record_revision
            || record.phase.is_terminal()
            || inner.generation.private.worker_create_state != PrivateWorkerCreateStateV1::Bound
        {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        worker_access_from_generation(record, &inner.generation.private)
    }

    /// Return only the persisted canonical create request for a
    /// `sent_uncertain` switch. This is intentionally distinct from the
    /// bound owner accessor: a response loss has no trusted principal or
    /// finalization ID, so Cancel must call the worker's idempotent
    /// `settle-create` route rather than the ordinary cancel route.
    pub(crate) fn uncertain_create_access(
        &self,
        switch_id: &str,
        expected_record_revision: u64,
    ) -> NativeResult<NativeGpuSwitchUncertainCreateAccessV1> {
        validate_revision_key(switch_id, expected_record_revision)?;
        let inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        ensure_held(&inner, switch_id)?;
        let record = exact_record(&inner, switch_id)?;
        let effective_planned = record.phase == NativeGpuSwitchPhaseV1::Planned
            || (record.phase == NativeGpuSwitchPhaseV1::NeedsAttention
                && record.blocked_at == Some(NativeGpuSwitchPhaseV1::Planned));
        if record.record_revision != expected_record_revision
            || !effective_planned
            || inner.generation.private.worker_create_state
                != PrivateWorkerCreateStateV1::SentUncertain
        {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        uncertain_create_access_from_generation(record, &inner.generation.private)
    }

    /// Return replay material only for the exact currently held
    /// `planned/sent_uncertain` state. Other Resume phases are not worker-create
    /// recovery and continue through their normal state-specific actions.
    pub(crate) fn sent_uncertain_create_access(
        &self,
        switch_id: &str,
    ) -> NativeResult<Option<NativeGpuSwitchUncertainCreateAccessV1>> {
        validate_uuid_v4(switch_id, "gpu_switch_not_found")?;
        let inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        self.ensure_disk_matches_inner(&inner)?;
        ensure_held(&inner, switch_id)?;
        let record = exact_record(&inner, switch_id)?;
        if record.phase != NativeGpuSwitchPhaseV1::Planned
            || inner.generation.private.worker_create_state
                != PrivateWorkerCreateStateV1::SentUncertain
        {
            return Ok(None);
        }
        uncertain_create_access_from_generation(record, &inner.generation.private).map(Some)
    }

    /// Decide before consuming a Resume grant whether this exact durable
    /// sent-uncertain state may run lookup-first reconciliation. A complete
    /// typed worker rejection is parked as `worker_response_invalid`; Resume
    /// may reopen that record for explicit settlement, but must never replay
    /// its already-rejected create request.
    pub(crate) fn sent_uncertain_resume_replay_allowed(
        &self,
        switch_id: &str,
    ) -> NativeResult<bool> {
        validate_uuid_v4(switch_id, "gpu_switch_not_found")?;
        let inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        self.ensure_disk_matches_inner(&inner)?;
        let record = exact_record(&inner, switch_id)?;
        if inner.generation.private.worker_create_state != PrivateWorkerCreateStateV1::SentUncertain
        {
            return Ok(false);
        }
        match record.phase {
            NativeGpuSwitchPhaseV1::Planned => Ok(true),
            NativeGpuSwitchPhaseV1::NeedsAttention
                if record.blocked_at == Some(NativeGpuSwitchPhaseV1::Planned) =>
            {
                Ok(record.attention_code.as_deref() == Some("gpu_switch_worker_create_uncertain"))
            }
            _ => Ok(false),
        }
    }

    /// Prove an explicit Resume replay is byte-for-byte identical to the
    /// persisted `sent_uncertain` worker request. The caller performs owner
    /// lookup first, prepares the pinned request without network I/O, then
    /// calls this method under `profile-control.lock` immediately before the
    /// one replay socket write.
    pub(crate) fn validate_uncertain_create_replay(
        &self,
        access: &NativeGpuSwitchUncertainCreateAccessV1,
        intent: &NativeGpuSwitchWorkerCreateIntentV1,
    ) -> NativeResult<()> {
        let inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        self.ensure_disk_matches_inner(&inner)?;
        ensure_held(&inner, &access.switch_id)?;
        let record = exact_record(&inner, &access.switch_id)?;
        if record.record_revision != access.record_revision
            || record.phase != NativeGpuSwitchPhaseV1::Planned
            || inner.generation.private.worker_create_state
                != PrivateWorkerCreateStateV1::SentUncertain
        {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        let persisted = uncertain_create_access_from_generation(record, &inner.generation.private)?;
        if &persisted != access {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        validate_worker_create_intent(intent, record)?;
        let private = &inner.generation.private;
        if private.profile_binding_sha256.as_deref() != Some(intent.profile_binding_sha256.as_str())
            || private.credential_binding_sha256.as_deref()
                != Some(intent.credential_binding_sha256.as_str())
            || private.worker_create_session_binding_sha256.as_deref()
                != Some(intent.worker_session_binding_sha256.as_str())
            || private.worker_create_body.as_deref() != Some(intent.canonical_body.as_str())
            || private.worker_create_body_sha256.as_deref()
                != Some(intent.canonical_body_sha256.as_str())
        {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        Ok(())
    }

    /// Return current process-local lease truth after a Resume reconciliation
    /// may have parked the record and released authorization.
    pub(crate) fn lease_status(&self, switch_id: &str) -> NativeResult<NativeGpuSwitchLeaseV1> {
        validate_uuid_v4(switch_id, "gpu_switch_not_found")?;
        let inner = self.inner.lock().map_err(|_| state_error())?;
        let _ = exact_record(&inner, switch_id)?;
        Ok(NativeGpuSwitchLeaseV1 {
            switch_id: switch_id.to_owned(),
            held: inner.held_lease.as_deref() == Some(switch_id),
        })
    }

    /// Persist a native-generated finalization identity and the `pausing`
    /// intent before its one worker POST. A lost response cannot result in a
    /// second ID or a second finalization route: the next explicit Resume must
    /// inspect the owner-only lookup against this stored value.
    pub(crate) fn prepare_worker_finalization(
        &self,
        switch_id: &str,
        expected_record_revision: u64,
    ) -> NativeResult<NativeGpuSwitchWorkerAccessV1> {
        validate_revision_key(switch_id, expected_record_revision)?;
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        ensure_held(&inner, switch_id)?;
        let prior = exact_record(&inner, switch_id)?.clone();
        if prior.record_revision != expected_record_revision
            || prior.phase != NativeGpuSwitchPhaseV1::ConsentPending
            || prior.target_confirmation != NativeGpuSwitchTargetConfirmationV1::Confirmed
            || inner.generation.private.worker_create_state != PrivateWorkerCreateStateV1::Bound
            || inner.generation.private.worker_finalization_id.is_some()
        {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        let mut candidate = prior;
        candidate.phase = NativeGpuSwitchPhaseV1::Pausing;
        candidate.record_revision = next_revision(candidate.record_revision)?;
        candidate.updated_at = utc_now()?;
        validate_transition(
            inner.generation.record.as_ref().ok_or_else(state_error)?,
            &candidate,
            &inner.issues,
        )?;
        let mut private = inner.generation.private.clone();
        private.worker_finalization_id = Some(Uuid::new_v4().to_string());
        let generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: next_revision(inner.generation.store_revision)?,
            record: Some(candidate.clone()),
            private: private.clone(),
        };
        self.commit_locked(&mut inner, generation)?;
        worker_access_from_generation(&candidate, &private)
    }

    pub fn acquire(&self, input: NativeGpuSwitchAcquireV1) -> NativeResult<NativeGpuSwitchLeaseV1> {
        validate_uuid_v4(&input.switch_id, "gpu_switch_not_found")?;
        validate_uuid_v4(
            &input.foreground_grant_id,
            "gpu_switch_foreground_grant_invalid",
        )?;
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        self.ensure_disk_matches_inner(&inner)?;
        let record = exact_record(&inner, &input.switch_id)?.clone();
        if record.phase.is_terminal() {
            return Ok(NativeGpuSwitchLeaseV1 {
                switch_id: input.switch_id,
                held: false,
            });
        }
        if let Some(held) = &inner.held_lease {
            let held_by_requested_switch = held == &input.switch_id;
            return Ok(NativeGpuSwitchLeaseV1 {
                switch_id: input.switch_id,
                held: held_by_requested_switch,
            });
        }
        consume_resume_grant(&mut inner, &input.foreground_grant_id, &input.switch_id)?;
        let keep_non_replayable_attention = record.phase == NativeGpuSwitchPhaseV1::NeedsAttention
            && record.blocked_at == Some(NativeGpuSwitchPhaseV1::Planned)
            && record.attention_code.as_deref() == Some("gpu_switch_worker_response_invalid")
            && inner.generation.private.worker_create_state
                == PrivateWorkerCreateStateV1::SentUncertain;
        if record.phase == NativeGpuSwitchPhaseV1::NeedsAttention && !keep_non_replayable_attention
        {
            let mut candidate = record;
            candidate.phase = candidate
                .blocked_at
                .ok_or_else(|| switch_error("gpu_switch_transition_invalid"))?;
            candidate.blocked_at = None;
            candidate.attention_code = None;
            candidate.record_revision = next_revision(candidate.record_revision)?;
            candidate.updated_at = utc_now()?;
            let mut candidate_issues = inner
                .issues
                .iter()
                .find(|entry| entry.code == "gpu_switch_store_recovered")
                .cloned()
                .into_iter()
                .collect::<Vec<_>>();
            validate_transition(
                inner.generation.record.as_ref().ok_or_else(state_error)?,
                &candidate,
                &candidate_issues,
            )?;
            let generation = DiskGenerationV1 {
                schema_version: SCHEMA_VERSION,
                store_revision: next_revision(inner.generation.store_revision)?,
                record: Some(candidate),
                private: inner.generation.private.clone(),
            };
            self.commit_locked(&mut inner, generation)?;
            inner.issues.clear();
            inner.issues.append(&mut candidate_issues);
        }
        inner.held_lease = Some(input.switch_id.clone());
        Ok(NativeGpuSwitchLeaseV1 {
            switch_id: input.switch_id,
            held: true,
        })
    }

    pub fn release(&self, input: NativeGpuSwitchKeyV1) -> NativeResult<NativeGpuSwitchLeaseV1> {
        validate_uuid_v4(&input.switch_id, "gpu_switch_not_found")?;
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        let _ = exact_record(&inner, &input.switch_id)?;
        let held = inner.held_lease.as_deref() == Some(input.switch_id.as_str());
        if held {
            inner.held_lease = None;
            inner.quotes.clear();
        }
        Ok(NativeGpuSwitchLeaseV1 {
            switch_id: input.switch_id,
            held: false,
        })
    }

    /// Advance only after a private transport validator has proved the exact
    /// worker/provider state. This separates the renderer input surface from
    /// authority-bearing remote state and is also used by focused Rust tests.
    pub fn advance_with_proof(
        &self,
        switch_id: &str,
        expected_record_revision: u64,
        next_phase: NativeGpuSwitchPhaseV1,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        validate_uuid_v4(switch_id, "gpu_switch_not_found")?;
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        self.ensure_disk_matches_inner(&inner)?;
        ensure_held(&inner, switch_id)?;
        let prior = exact_record(&inner, switch_id)?.clone();
        if prior.record_revision != expected_record_revision {
            return Err(switch_error("gpu_switch_revision_conflict"));
        }
        if !prior.phase.allows_transition_to(next_phase) {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        // `consent_pending` is reachable only after the pinned worker create
        // (or exact owner-only recovery) has durably bound its authenticated
        // requester and worker-generated principal ID. Generic local phase
        // advancement is never authority for that transition.
        if prior.phase == NativeGpuSwitchPhaseV1::Planned
            && next_phase == NativeGpuSwitchPhaseV1::ConsentPending
        {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        let mut candidate = prior;
        candidate.phase = next_phase;
        candidate.blocked_at = None;
        candidate.attention_code = None;
        candidate.prepared_target = None;
        candidate.record_revision = next_revision(candidate.record_revision)?;
        candidate.updated_at = utc_now()?;
        validate_transition(
            inner.generation.record.as_ref().ok_or_else(state_error)?,
            &candidate,
            &inner.issues,
        )?;
        let generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: next_revision(inner.generation.store_revision)?,
            record: Some(candidate),
            private: inner.generation.private.clone(),
        };
        self.commit_locked(&mut inner, generation)?;
        Ok(snapshot_from_inner(&inner))
    }

    /// Commit the bounded old-Pod DELETE wire budget before the private
    /// transport writes a socket. The command orchestration may call this once
    /// for the initial send and, only after exact reconciliation, once more for
    /// the documented Resume retry. It cannot create a third wire attempt.
    pub fn prepare_old_delete_wire_attempt(
        &self,
        switch_id: &str,
        expected_record_revision: u64,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        validate_revision_key(switch_id, expected_record_revision)?;
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        ensure_held(&inner, switch_id)?;
        let prior = exact_record(&inner, switch_id)?.clone();
        if prior.record_revision != expected_record_revision {
            return Err(switch_error("gpu_switch_revision_conflict"));
        }
        if prior.phase != NativeGpuSwitchPhaseV1::DeleteIntent
            || prior.old_delete_wire_attempts >= 2
        {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        let mut candidate = prior;
        candidate.old_delete_wire_attempts += 1;
        candidate.record_revision = next_revision(candidate.record_revision)?;
        candidate.updated_at = utc_now()?;
        validate_transition(
            inner.generation.record.as_ref().ok_or_else(state_error)?,
            &candidate,
            &inner.issues,
        )?;
        let generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: next_revision(inner.generation.store_revision)?,
            record: Some(candidate),
            private: inner.generation.private.clone(),
        };
        self.commit_locked(&mut inner, generation)?;
        Ok(snapshot_from_inner(&inner))
    }

    pub fn park_with_attention(
        &self,
        switch_id: &str,
        expected_record_revision: u64,
        attention_code: &str,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        validate_uuid_v4(switch_id, "gpu_switch_not_found")?;
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        self.ensure_disk_matches_inner(&inner)?;
        ensure_held(&inner, switch_id)?;
        let prior = exact_record(&inner, switch_id)?.clone();
        if prior.record_revision != expected_record_revision {
            return Err(switch_error("gpu_switch_revision_conflict"));
        }
        if !prior.phase.is_blocked_phase() {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        validate_attention_for_phase(attention_code, prior.phase)?;
        let mut candidate = prior;
        let blocked_at = candidate.phase;
        candidate.phase = NativeGpuSwitchPhaseV1::NeedsAttention;
        candidate.blocked_at = Some(blocked_at);
        candidate.attention_code = Some(attention_code.to_owned());
        candidate.record_revision = next_revision(candidate.record_revision)?;
        candidate.updated_at = utc_now()?;
        let recovery_issue = inner
            .issues
            .iter()
            .find(|issue| issue.code == "gpu_switch_store_recovered")
            .cloned();
        let mut candidate_issues = vec![issue(attention_code)];
        if let Some(recovery_issue) = recovery_issue {
            candidate_issues.push(recovery_issue);
        }
        validate_transition(
            inner.generation.record.as_ref().ok_or_else(state_error)?,
            &candidate,
            &candidate_issues,
        )?;
        let generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: next_revision(inner.generation.store_revision)?,
            record: Some(candidate),
            private: inner.generation.private.clone(),
        };
        self.commit_locked(&mut inner, generation)?;
        inner.issues = candidate_issues;
        inner.held_lease = None;
        inner.quotes.clear();
        Ok(snapshot_from_inner(&inner))
    }

    /// Persist the exact bounded set of unexpected profile Pods observed at a
    /// provider decision boundary. More than sixteen identities is represented
    /// only by the overflow bit, so renderer IPC never truncates authority.
    pub(crate) fn park_with_peer_pods(
        &self,
        switch_id: &str,
        expected_record_revision: u64,
        mut pod_ids: Vec<String>,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        validate_revision_key(switch_id, expected_record_revision)?;
        pod_ids.sort();
        pod_ids.dedup();
        if pod_ids.iter().any(|pod_id| !valid_pod_id(pod_id)) {
            return Err(switch_error("gpu_switch_provider_response_mismatch"));
        }
        let overflow = pod_ids.len() > 16;
        if overflow {
            pod_ids.clear();
        }
        let code = if overflow {
            "gpu_switch_peer_pod_overflow"
        } else if pod_ids.is_empty() {
            return Err(switch_error("gpu_switch_transition_invalid"));
        } else {
            "gpu_switch_peer_pod_present"
        };
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        self.ensure_disk_matches_inner(&inner)?;
        ensure_held(&inner, switch_id)?;
        let prior = exact_record(&inner, switch_id)?.clone();
        if prior.record_revision != expected_record_revision {
            return Err(switch_error("gpu_switch_revision_conflict"));
        }
        validate_attention_for_phase(code, prior.phase)?;
        let mut candidate = prior;
        candidate.blocked_at = Some(candidate.phase);
        candidate.phase = NativeGpuSwitchPhaseV1::NeedsAttention;
        candidate.attention_code = Some(code.to_owned());
        candidate.peer_pod_ids = pod_ids;
        candidate.peer_pod_overflow = overflow;
        candidate.record_revision = next_revision(candidate.record_revision)?;
        candidate.updated_at = utc_now()?;
        let recovery_issue = inner
            .issues
            .iter()
            .find(|issue| issue.code == "gpu_switch_store_recovered")
            .cloned();
        let mut candidate_issues = vec![issue(code)];
        if let Some(recovery_issue) = recovery_issue {
            candidate_issues.push(recovery_issue);
        }
        validate_transition(
            inner.generation.record.as_ref().ok_or_else(state_error)?,
            &candidate,
            &candidate_issues,
        )?;
        let generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: next_revision(inner.generation.store_revision)?,
            record: Some(candidate),
            private: inner.generation.private.clone(),
        };
        self.commit_locked(&mut inner, generation)?;
        inner.issues = candidate_issues;
        inner.held_lease = None;
        inner.quotes.clear();
        Ok(snapshot_from_inner(&inner))
    }

    /// Persist a fresh, native-inventory-backed confirmation for the exact
    /// already-approved target. It deliberately cannot retarget a live
    /// switch: GPU identity, attempt ID and canonical micro-price are all
    /// immutable here. A different target must be cancelled before delete and
    /// started again with new consent.
    pub(crate) fn confirm_current_target(
        &self,
        input: NativeGpuSwitchPrepareTargetV1,
        target_display_name: String,
        inventory_observed_at: String,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        validate_prepare_input(&input)?;
        validate_gpu_identity(&target_display_name)?;
        validate_timestamp(&inventory_observed_at)?;
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        ensure_held(&inner, &input.switch_id)?;
        let prior = exact_record(&inner, &input.switch_id)?.clone();
        if prior.record_revision != input.expected_record_revision
            || prior.phase != NativeGpuSwitchPhaseV1::ConsentPending
            || prior.target_confirmation != NativeGpuSwitchTargetConfirmationV1::Required
            || prior.current_target.gpu_id != input.target_gpu_id
            || prior.current_target.gpu_display_name != target_display_name
            || prior.current_target.hourly_price_micro_usd != input.confirmed_hourly_price_micro_usd
        {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        let mut candidate = prior;
        candidate.target_confirmation = NativeGpuSwitchTargetConfirmationV1::Confirmed;
        candidate.current_target.observation_id = input.observation_id;
        candidate.current_target.receipt_id = input.receipt_id;
        candidate.current_target.inventory_observed_at = inventory_observed_at;
        candidate.current_target.price_confirmed_at = utc_now()?;
        candidate.record_revision = next_revision(candidate.record_revision)?;
        candidate.updated_at = utc_now()?;
        validate_transition(
            inner.generation.record.as_ref().ok_or_else(state_error)?,
            &candidate,
            &inner.issues,
        )?;
        let generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: next_revision(inner.generation.store_revision)?,
            record: Some(candidate),
            private: inner.generation.private.clone(),
        };
        self.commit_locked(&mut inner, generation)?;
        Ok(snapshot_from_inner(&inner))
    }

    pub fn prepare_attempt(
        &self,
        input: NativeGpuSwitchPrepareTargetV1,
        target_display_name: String,
        inventory_observed_at: String,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        validate_prepare_input(&input)?;
        validate_gpu_identity(&target_display_name)?;
        validate_timestamp(&inventory_observed_at)?;
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        ensure_held(&inner, &input.switch_id)?;
        let record = exact_record(&inner, &input.switch_id)?.clone();
        if record.record_revision != input.expected_record_revision {
            return Err(switch_error("gpu_switch_revision_conflict"));
        }
        if record.phase != NativeGpuSwitchPhaseV1::OldAbsent || record.prepared_target.is_some() {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        let prepared_at = utc_now()?;
        let quote_id = Uuid::new_v4().to_string();
        let prepared_record_revision = next_revision(record.record_revision)?;
        let prepared = NativeGpuSwitchPreparedTargetV1 {
            quote_id: quote_id.clone(),
            prepared_from_record_revision: prepared_record_revision,
            gpu_id: input.target_gpu_id.clone(),
            gpu_display_name: target_display_name,
            hourly_price_micro_usd: input.confirmed_hourly_price_micro_usd,
            observation_id: input.observation_id,
            receipt_id: input.receipt_id,
            prepared_at: prepared_at.clone(),
            expires_at: utc_after(PREPARED_QUOTE_TTL)?,
        };
        let mut candidate = record;
        candidate.prepared_target = Some(prepared);
        candidate.record_revision = prepared_record_revision;
        candidate.updated_at = prepared_at;
        validate_transition(
            inner.generation.record.as_ref().ok_or_else(state_error)?,
            &candidate,
            &inner.issues,
        )?;
        inner.quotes.insert(
            quote_id,
            PreparedQuotePrivate {
                switch_id: input.switch_id,
                record_revision: candidate.record_revision,
                target_gpu_id: candidate
                    .prepared_target
                    .as_ref()
                    .map(|prepared| prepared.gpu_id.clone())
                    .ok_or_else(state_error)?,
                receipt_id: candidate
                    .prepared_target
                    .as_ref()
                    .map(|prepared| prepared.receipt_id.clone())
                    .ok_or_else(state_error)?,
                inventory_observed_at,
                issued_at: Instant::now(),
            },
        );
        let generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: next_revision(inner.generation.store_revision)?,
            record: Some(candidate),
            private: inner.generation.private.clone(),
        };
        self.commit_locked(&mut inner, generation)?;
        Ok(snapshot_from_inner(&inner))
    }

    pub fn confirm_attempt(
        &self,
        input: NativeGpuSwitchConfirmAttemptV1,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        validate_confirm_attempt_input(&input)?;
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        ensure_held(&inner, &input.switch_id)?;
        let record = exact_record(&inner, &input.switch_id)?.clone();
        if record.record_revision != input.expected_record_revision {
            return Err(switch_error("gpu_switch_revision_conflict"));
        }
        let prepared = record
            .prepared_target
            .clone()
            .filter(|quote| quote.quote_id == input.quote_id)
            .ok_or_else(|| switch_error("gpu_switch_quote_invalid"))?;
        if prepared.prepared_from_record_revision != input.expected_record_revision
            || prepared.gpu_id != input.target_gpu_id
            || prepared.receipt_id != input.receipt_id
            || prepared.observation_id != input.observation_id
            || prepared.hourly_price_micro_usd != input.confirmed_hourly_price_micro_usd
        {
            return Err(switch_error("gpu_switch_quote_invalid"));
        }
        let private = inner
            .quotes
            .get(&input.quote_id)
            .cloned()
            .ok_or_else(|| switch_error("gpu_switch_quote_invalid"))?;
        if private.issued_at.elapsed() >= PREPARED_QUOTE_TTL {
            return Err(switch_error("gpu_switch_quote_expired"));
        }
        if private.switch_id != input.switch_id
            || private.record_revision != input.expected_record_revision
            || private.target_gpu_id != input.target_gpu_id
            || private.receipt_id != input.receipt_id
        {
            return Err(switch_error("gpu_switch_quote_invalid"));
        }
        let mut candidate = record;
        let prior = NativeGpuSwitchPriorAttemptV1 {
            target: candidate.current_target.clone(),
            replacement_pod_id: None,
            outcome: NativeGpuSwitchPriorAttemptOutcomeV1::NotCreated,
            settled_at: utc_now()?,
        };
        candidate.prior_attempts.push(prior);
        candidate.current_target = NativeGpuSwitchTargetV1 {
            replacement_attempt_id: Uuid::new_v4().to_string(),
            attempt_revision: candidate.prior_attempts.len() as u64 + 1,
            gpu_id: prepared.gpu_id.clone(),
            gpu_display_name: prepared.gpu_display_name.clone(),
            hourly_price_micro_usd: prepared.hourly_price_micro_usd,
            observation_id: prepared.observation_id.clone(),
            receipt_id: prepared.receipt_id.clone(),
            inventory_observed_at: private.inventory_observed_at,
            price_confirmed_at: utc_now()?,
        };
        candidate.prepared_target = None;
        candidate.record_revision = next_revision(candidate.record_revision)?;
        candidate.updated_at = utc_now()?;
        validate_transition(
            inner.generation.record.as_ref().ok_or_else(state_error)?,
            &candidate,
            &inner.issues,
        )?;
        let generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: next_revision(inner.generation.store_revision)?,
            record: Some(candidate),
            private: inner.generation.private.clone(),
        };
        self.commit_locked(&mut inner, generation)?;
        // A rejected candidate or failed durable commit must leave the quote
        // usable. Once the attempt generation is committed, the quote can no
        // longer be replayed and its process-local entry is safely removed.
        inner.quotes.remove(&input.quote_id);
        Ok(snapshot_from_inner(&inner))
    }

    /// Commit the immutable replacement-create request fingerprint before the
    /// native RunPod POST. The body itself never crosses IPC, but its digest
    /// is part of the crash-recovery proof and cannot be replaced after a
    /// response loss.
    pub(crate) fn prepare_replacement_create(
        &self,
        switch_id: &str,
        expected_record_revision: u64,
        intent: NativeGpuSwitchProviderCreateIntentV1,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        validate_revision_key(switch_id, expected_record_revision)?;
        if !valid_sha256(&intent.create_marker_sha256)
            || !valid_sha256(&intent.create_intent_sha256)
            || !valid_sha256(&intent.create_wire_body_sha256)
            || validate_uuid_v4(
                &intent.observation_id,
                "gpu_switch_inventory_receipt_invalid",
            )
            .is_err()
            || validate_uuid_v4(&intent.receipt_id, "gpu_switch_inventory_receipt_invalid").is_err()
            || validate_timestamp(&intent.inventory_observed_at).is_err()
        {
            return Err(switch_error("gpu_switch_provider_response_mismatch"));
        }
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        ensure_held(&inner, switch_id)?;
        let prior = exact_record(&inner, switch_id)?.clone();
        if prior.record_revision != expected_record_revision
            || prior.phase != NativeGpuSwitchPhaseV1::OldAbsent
            || inner.generation.private.provider_request_sha256.is_some()
            || inner.generation.private.provider_response_sha256.is_some()
            || inner.generation.private.create_marker_sha256.is_some()
            || inner.generation.private.create_intent_sha256.is_some()
            || inner.generation.private.create_wire_body_sha256.is_some()
        {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        let mut candidate = prior;
        candidate.phase = NativeGpuSwitchPhaseV1::CreateIntent;
        candidate.current_target.observation_id = intent.observation_id;
        candidate.current_target.receipt_id = intent.receipt_id;
        candidate.current_target.inventory_observed_at = intent.inventory_observed_at;
        candidate.current_target.price_confirmed_at = utc_now()?;
        candidate.record_revision = next_revision(candidate.record_revision)?;
        candidate.updated_at = utc_now()?;
        validate_transition(
            inner.generation.record.as_ref().ok_or_else(state_error)?,
            &candidate,
            &inner.issues,
        )?;
        let mut private = inner.generation.private.clone();
        private.provider_request_sha256 = Some(intent.create_wire_body_sha256.clone());
        private.create_marker_sha256 = Some(intent.create_marker_sha256);
        private.create_intent_sha256 = Some(intent.create_intent_sha256);
        private.create_wire_body_sha256 = Some(intent.create_wire_body_sha256);
        let generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: next_revision(inner.generation.store_revision)?,
            record: Some(candidate),
            private,
        };
        self.commit_locked(&mut inner, generation)?;
        Ok(snapshot_from_inner(&inner))
    }

    /// A response that cannot prove exact non-creation must be durable before
    /// returning to React. It intentionally has no automatic retry path.
    pub(crate) fn mark_replacement_create_uncertain(
        &self,
        switch_id: &str,
        expected_record_revision: u64,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        self.advance_with_proof(
            switch_id,
            expected_record_revision,
            NativeGpuSwitchPhaseV1::CreateUncertain,
        )
    }

    /// Bind one fully validated provider response to the current immutable
    /// attempt. A matching price still waits for the explicit confirmation
    /// command; changed or missing prices are parked at the exact response
    /// boundary rather than guessed or silently accepted.
    pub(crate) fn record_replacement_identified(
        &self,
        switch_id: &str,
        expected_record_revision: u64,
        replacement_pod_id: String,
        target_gpu_id: String,
        actual_hourly_price_micro_usd: Option<u64>,
        provider_response_sha256: String,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        validate_revision_key(switch_id, expected_record_revision)?;
        if !valid_pod_id(&replacement_pod_id)
            || validate_gpu_identity(&target_gpu_id).is_err()
            || !valid_sha256(&provider_response_sha256)
            || actual_hourly_price_micro_usd.is_some_and(|price| price > MAX_SAFE_INTEGER)
        {
            return Err(switch_error("gpu_switch_provider_response_mismatch"));
        }
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        ensure_held(&inner, switch_id)?;
        let prior = exact_record(&inner, switch_id)?.clone();
        if prior.record_revision != expected_record_revision
            || !matches!(
                prior.phase,
                NativeGpuSwitchPhaseV1::CreateIntent | NativeGpuSwitchPhaseV1::CreateUncertain
            )
            || prior.current_target.gpu_id != target_gpu_id
            || inner.generation.private.provider_request_sha256.is_none()
            || inner.generation.private.provider_response_sha256.is_some()
        {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        let mut candidate = prior;
        candidate.phase = NativeGpuSwitchPhaseV1::ReplacementIdentified;
        candidate.replacement_pod_id = Some(replacement_pod_id);
        candidate.actual_hourly_price_micro_usd = actual_hourly_price_micro_usd;
        candidate.confirmed_actual_price = false;
        let attention = match actual_hourly_price_micro_usd {
            None => Some("gpu_actual_price_unavailable"),
            Some(price) if price != candidate.current_target.hourly_price_micro_usd => {
                Some("gpu_actual_price_changed")
            }
            Some(_) => None,
        };
        if let Some(code) = attention {
            candidate.blocked_at = Some(NativeGpuSwitchPhaseV1::ReplacementIdentified);
            candidate.attention_code = Some(code.to_owned());
            candidate.phase = NativeGpuSwitchPhaseV1::NeedsAttention;
            let recovery_issue = inner
                .issues
                .iter()
                .find(|issue| issue.code == "gpu_switch_store_recovered")
                .cloned();
            inner.issues = vec![issue(code)];
            if let Some(recovery_issue) = recovery_issue {
                inner.issues.push(recovery_issue);
            }
        } else {
            candidate.blocked_at = None;
            candidate.attention_code = None;
        }
        candidate.record_revision = next_revision(candidate.record_revision)?;
        candidate.updated_at = utc_now()?;
        validate_transition(
            inner.generation.record.as_ref().ok_or_else(state_error)?,
            &candidate,
            &inner.issues,
        )?;
        let mut private = inner.generation.private.clone();
        private.provider_response_sha256 = Some(provider_response_sha256);
        let generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: next_revision(inner.generation.store_revision)?,
            record: Some(candidate),
            private,
        };
        self.commit_locked(&mut inner, generation)?;
        Ok(snapshot_from_inner(&inner))
    }

    /// Confirm the exact actual provider price and enter provisioning. This
    /// never sends a provider/worker request and rejects changed text rather
    /// than using the renderer value as authority.
    pub(crate) fn confirm_actual_price(
        &self,
        input: NativeGpuSwitchActualPriceV1,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        validate_revision_key(&input.switch_id, input.expected_record_revision)?;
        if input.confirmed_actual_hourly_price_micro_usd > MAX_SAFE_INTEGER {
            return Err(switch_error("gpu_actual_price_changed"));
        }
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        ensure_held(&inner, &input.switch_id)?;
        let prior = exact_record(&inner, &input.switch_id)?.clone();
        let changed_price_attention = prior.phase == NativeGpuSwitchPhaseV1::NeedsAttention
            && prior.blocked_at == Some(NativeGpuSwitchPhaseV1::ReplacementIdentified)
            && prior.attention_code.as_deref() == Some("gpu_actual_price_changed");
        if prior.record_revision != input.expected_record_revision
            || !(prior.phase == NativeGpuSwitchPhaseV1::ReplacementIdentified
                || changed_price_attention)
            || prior.actual_hourly_price_micro_usd
                != Some(input.confirmed_actual_hourly_price_micro_usd)
        {
            return Err(switch_error("gpu_actual_price_changed"));
        }
        let mut candidate = prior;
        candidate.confirmed_actual_price = true;
        candidate.phase = NativeGpuSwitchPhaseV1::Provisioning;
        candidate.blocked_at = None;
        candidate.attention_code = None;
        candidate.record_revision = next_revision(candidate.record_revision)?;
        candidate.updated_at = utc_now()?;
        inner
            .issues
            .retain(|entry| entry.code == "gpu_switch_store_recovered");
        validate_transition(
            inner.generation.record.as_ref().ok_or_else(state_error)?,
            &candidate,
            &inner.issues,
        )?;
        let generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: next_revision(inner.generation.store_revision)?,
            record: Some(candidate),
            private: inner.generation.private.clone(),
        };
        self.commit_locked(&mut inner, generation)?;
        Ok(snapshot_from_inner(&inner))
    }

    /// Bind one strict, provider-correlated replacement runtime proof and move
    /// to the fixed-point `ready_paused` state.  The caller obtains the proof
    /// only from the pinned owner-only worker route; this method persists its
    /// canonical digest so completion and restart validation cannot substitute
    /// another worker/device identity.
    pub(crate) fn bind_verified_runtime_identity(
        &self,
        switch_id: &str,
        expected_record_revision: u64,
        runtime_identity_sha256: String,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        validate_revision_key(switch_id, expected_record_revision)?;
        if !valid_sha256(&runtime_identity_sha256) {
            return Err(switch_error("gpu_switch_runtime_identity_unavailable"));
        }
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        self.ensure_disk_matches_inner(&inner)?;
        ensure_held(&inner, switch_id)?;
        let prior = exact_record(&inner, switch_id)?.clone();
        let runtime_attention = prior.phase == NativeGpuSwitchPhaseV1::NeedsAttention
            && prior.blocked_at == Some(NativeGpuSwitchPhaseV1::Provisioning)
            && prior.attention_code.as_deref() == Some("gpu_switch_runtime_identity_unavailable");
        if prior.record_revision != expected_record_revision
            || !(prior.phase == NativeGpuSwitchPhaseV1::Provisioning || runtime_attention)
            || prior.replacement_pod_id.is_none()
            || !prior.confirmed_actual_price
            || inner.generation.private.provider_request_sha256.is_none()
            || inner.generation.private.provider_response_sha256.is_none()
            || inner.generation.private.create_marker_sha256.is_none()
            || inner.generation.private.create_intent_sha256.is_none()
            || inner.generation.private.create_wire_body_sha256.is_none()
            || inner.generation.private.runtime_identity_sha256.is_some()
        {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        let mut candidate = prior;
        candidate.phase = NativeGpuSwitchPhaseV1::ReadyPaused;
        candidate.blocked_at = None;
        candidate.attention_code = None;
        candidate.record_revision = next_revision(candidate.record_revision)?;
        candidate.updated_at = utc_now()?;
        inner
            .issues
            .retain(|entry| entry.code == "gpu_switch_store_recovered");
        validate_transition(
            inner.generation.record.as_ref().ok_or_else(state_error)?,
            &candidate,
            &inner.issues,
        )?;
        let mut private = inner.generation.private.clone();
        private.runtime_identity_sha256 = Some(runtime_identity_sha256);
        let generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: next_revision(inner.generation.store_revision)?,
            record: Some(candidate),
            private,
        };
        self.commit_locked(&mut inner, generation)?;
        Ok(snapshot_from_inner(&inner))
    }

    /// Persist a failed-replacement deletion intent before its sole native
    /// DELETE. The literal user confirmation is checked in the command layer;
    /// only the safe reason enum reaches this journal method.
    pub(crate) fn prepare_replacement_delete(
        &self,
        switch_id: &str,
        expected_record_revision: u64,
        replacement_pod_id: &str,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        validate_revision_key(switch_id, expected_record_revision)?;
        if !valid_pod_id(replacement_pod_id) {
            return Err(switch_error("gpu_switch_replacement_mismatch"));
        }
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        ensure_held(&inner, switch_id)?;
        let prior = exact_record(&inner, switch_id)?.clone();
        let blocked_replacement = prior.phase == NativeGpuSwitchPhaseV1::NeedsAttention
            && prior.blocked_at == Some(NativeGpuSwitchPhaseV1::ReplacementIdentified);
        if prior.record_revision != expected_record_revision
            || !(matches!(
                prior.phase,
                NativeGpuSwitchPhaseV1::ReplacementIdentified
                    | NativeGpuSwitchPhaseV1::Provisioning
                    | NativeGpuSwitchPhaseV1::ReplacementFailed
            ) || blocked_replacement)
            || prior.replacement_pod_id.as_deref() != Some(replacement_pod_id)
        {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        let mut candidate = prior;
        candidate.phase = NativeGpuSwitchPhaseV1::ReplacementDeleteIntent;
        candidate.blocked_at = None;
        candidate.attention_code = None;
        candidate.record_revision = next_revision(candidate.record_revision)?;
        candidate.updated_at = utc_now()?;
        inner
            .issues
            .retain(|entry| entry.code == "gpu_switch_store_recovered");
        validate_transition(
            inner.generation.record.as_ref().ok_or_else(state_error)?,
            &candidate,
            &inner.issues,
        )?;
        let generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: next_revision(inner.generation.store_revision)?,
            record: Some(candidate),
            private: inner.generation.private.clone(),
        };
        self.commit_locked(&mut inner, generation)?;
        Ok(snapshot_from_inner(&inner))
    }

    pub(crate) fn mark_replacement_delete_uncertain(
        &self,
        switch_id: &str,
        expected_record_revision: u64,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        self.advance_with_proof(
            switch_id,
            expected_record_revision,
            NativeGpuSwitchPhaseV1::ReplacementDeleteUncertain,
        )
    }

    /// Reconciliation proved that the exact failed replacement is gone. Its
    /// attempt becomes immutable history and native creates the next dormant
    /// attempt identity; a later explicit quote/confirmation is still needed
    /// before any further POST.
    pub(crate) fn settle_deleted_replacement(
        &self,
        switch_id: &str,
        expected_record_revision: u64,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        validate_revision_key(switch_id, expected_record_revision)?;
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        ensure_held(&inner, switch_id)?;
        let prior = exact_record(&inner, switch_id)?.clone();
        if prior.record_revision != expected_record_revision
            || !matches!(
                prior.phase,
                NativeGpuSwitchPhaseV1::ReplacementDeleteIntent
                    | NativeGpuSwitchPhaseV1::ReplacementDeleteUncertain
            )
        {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        let deleted_pod_id = prior
            .replacement_pod_id
            .clone()
            .ok_or_else(|| switch_error("gpu_switch_transition_invalid"))?;
        let archived_attempt_id = prior.current_target.replacement_attempt_id.clone();
        let archived_attempt_revision = prior.current_target.attempt_revision;
        let mut candidate = prior;
        candidate
            .prior_attempts
            .push(NativeGpuSwitchPriorAttemptV1 {
                target: candidate.current_target.clone(),
                replacement_pod_id: Some(deleted_pod_id),
                outcome: NativeGpuSwitchPriorAttemptOutcomeV1::FailedReplacementDeleted,
                settled_at: utc_now()?,
            });
        let next_attempt_revision = candidate.prior_attempts.len() as u64 + 1;
        if next_attempt_revision > MAX_SAFE_INTEGER {
            return Err(switch_error("gpu_switch_revision_exhausted"));
        }
        candidate.current_target = NativeGpuSwitchTargetV1 {
            replacement_attempt_id: Uuid::new_v4().to_string(),
            attempt_revision: next_attempt_revision,
            ..candidate.current_target.clone()
        };
        candidate.phase = NativeGpuSwitchPhaseV1::OldAbsent;
        candidate.replacement_pod_id = None;
        candidate.actual_hourly_price_micro_usd = None;
        candidate.confirmed_actual_price = false;
        candidate.record_revision = next_revision(candidate.record_revision)?;
        candidate.updated_at = utc_now()?;
        validate_transition(
            inner.generation.record.as_ref().ok_or_else(state_error)?,
            &candidate,
            &inner.issues,
        )?;
        // A replacement may be retried only after this atomic cleanup: move
        // the old attempt's immutable fingerprints into private history and
        // clear the active binding for the freshly minted attempt identity.
        // This makes a crash at every seam recoverable without permitting a
        // request/response fingerprint to be rewritten in place.
        let mut private = inner.generation.private.clone();
        let request_sha256 = private
            .provider_request_sha256
            .take()
            .ok_or_else(state_error)?;
        let response_sha256 = private
            .provider_response_sha256
            .take()
            .ok_or_else(state_error)?;
        let create_marker_sha256 = private
            .create_marker_sha256
            .take()
            .ok_or_else(state_error)?;
        let create_intent_sha256 = private
            .create_intent_sha256
            .take()
            .ok_or_else(state_error)?;
        let create_wire_body_sha256 = private
            .create_wire_body_sha256
            .take()
            .ok_or_else(state_error)?;
        private
            .provider_attempt_history
            .push(PrivateGpuSwitchProviderAttemptV1 {
                schema_version: SCHEMA_VERSION,
                replacement_attempt_id: archived_attempt_id,
                attempt_revision: archived_attempt_revision,
                request_sha256,
                response_sha256: Some(response_sha256),
                create_marker_sha256,
                create_intent_sha256,
                create_wire_body_sha256,
            });
        let generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: next_revision(inner.generation.store_revision)?,
            record: Some(candidate),
            private,
        };
        self.commit_locked(&mut inner, generation)?;
        Ok(snapshot_from_inner(&inner))
    }

    /// Persist the worker terminal tombstone, native terminal history, and
    /// releasing queue reservation in that order. The reservation deliberately
    /// remains a durable blocker after this return; a later profile-locked
    /// cleanup/acknowledgement may archive it, but no queue can race the
    /// terminal evidence while the app is between those commits.
    pub(crate) fn terminalize_with_proof(
        &self,
        switch_id: &str,
        expected_record_revision: u64,
        terminal_phase: NativeGpuSwitchPhaseV1,
        proof: NativeGpuSwitchTerminalProofV1,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        validate_revision_key(switch_id, expected_record_revision)?;
        if !matches!(
            terminal_phase,
            NativeGpuSwitchPhaseV1::Completed | NativeGpuSwitchPhaseV1::CancelledPreDelete
        ) {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        ensure_held(&inner, switch_id)?;
        let prior = exact_record(&inner, switch_id)?.clone();
        if prior.record_revision != expected_record_revision {
            return Err(switch_error("gpu_switch_revision_conflict"));
        }
        let legal = match terminal_phase {
            NativeGpuSwitchPhaseV1::Completed => prior.phase == NativeGpuSwitchPhaseV1::ReadyPaused,
            NativeGpuSwitchPhaseV1::CancelledPreDelete => matches!(
                prior.phase,
                NativeGpuSwitchPhaseV1::Planned | NativeGpuSwitchPhaseV1::ConsentPending
            ),
            _ => false,
        };
        if !legal {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        let local_draft =
            proof.terminal_reason == NativeGpuSwitchTerminalReasonV1::LocalDraftCancelled;
        let private = &inner.generation.private;
        let invalid_local_draft = local_draft
            && (terminal_phase != NativeGpuSwitchPhaseV1::CancelledPreDelete
                || prior.phase != NativeGpuSwitchPhaseV1::Planned
                // `send_pending` is the sole durable proof that the exact
                // body exists while no socket-write boundary was entered.
                // Bare Draft cannot prove what was cancelled; sent_uncertain
                // must be settled through the worker, never locally erased.
                || private.worker_create_state != PrivateWorkerCreateStateV1::SendPending
                || proof.principal_binding_id.is_some()
                || proof.worker_tombstone_sha256.is_some());
        let invalid_worker_terminal = !local_draft
            && (private.worker_create_state != PrivateWorkerCreateStateV1::Bound
                || proof.principal_binding_id.is_none()
                || proof.worker_tombstone_sha256.is_none()
                || private.principal_binding_id.as_deref()
                    != proof.principal_binding_id.as_deref());
        if invalid_local_draft
            || invalid_worker_terminal
            || (!local_draft
                && terminal_phase == NativeGpuSwitchPhaseV1::CancelledPreDelete
                && prior.phase != NativeGpuSwitchPhaseV1::ConsentPending)
            || proof
                .principal_binding_id
                .as_deref()
                .is_some_and(|id| validate_uuid_v4(id, "gpu_switch_store_unrecoverable").is_err())
            || proof
                .worker_tombstone_sha256
                .as_deref()
                .is_some_and(|hash| !valid_sha256(hash))
        {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        let principal_binding_sha256 = proof.principal_binding_id.as_deref().map(|binding| {
            sha256_text(&format!(
                "imageforge-principal-binding-history-v1\n{binding}"
            ))
        });
        let history = NativeGpuSwitchHistoryV1 {
            schema_version: SCHEMA_VERSION,
            switch_id: prior.switch_id.clone(),
            terminal_state: match terminal_phase {
                NativeGpuSwitchPhaseV1::Completed => "completed",
                NativeGpuSwitchPhaseV1::CancelledPreDelete => "cancelled_pre_delete",
                _ => unreachable!(),
            }
            .to_owned(),
            terminal_reason: proof.terminal_reason,
            terminal_at: utc_now()?,
            old_pod_id: prior.old_pod.pod_id.clone(),
            replacement_pod_id: prior.replacement_pod_id.clone(),
            final_attempt_id: prior.current_target.replacement_attempt_id.clone(),
            principal_binding_sha256,
            worker_tombstone_sha256: proof.worker_tombstone_sha256,
        };
        let history_sha256 = self.journal.write_history(&history)?;
        let current_reservation = self.journal.read_reservation()?.ok_or_else(state_error)?;
        if current_reservation.phase != PrivateGpuSwitchQueueReservationPhaseV1::Active
            || current_reservation.switch_id != prior.switch_id
        {
            return Err(state_error());
        }
        let next_record_revision = next_revision(prior.record_revision)?;
        let next_store_revision = next_revision(inner.generation.store_revision)?;
        let releasing = PrivateGpuSwitchQueueReservationV1 {
            reservation_revision: next_revision(current_reservation.reservation_revision)?,
            phase: PrivateGpuSwitchQueueReservationPhaseV1::Releasing,
            native_store_revision: Some(next_store_revision),
            native_record_revision: Some(next_record_revision),
            terminal_state: Some(history.terminal_state.clone()),
            worker_tombstone_sha256: history.worker_tombstone_sha256.clone(),
            native_history_sha256: Some(history_sha256),
            updated_at: utc_now()?,
            ..current_reservation
        };
        self.journal.write_reservation(&releasing)?;
        let mut candidate = prior;
        candidate.phase = terminal_phase;
        candidate.blocked_at = None;
        candidate.attention_code = None;
        candidate.prepared_target = None;
        candidate.queue_reservation = NativeGpuSwitchQueueReservationV1 {
            active: false,
            queue_run_revision: None,
        };
        candidate.record_revision = next_record_revision;
        candidate.updated_at = utc_now()?;
        let generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: next_store_revision,
            record: Some(candidate),
            private: PrivateGpuSwitchGenerationV1 {
                worker_create_state: PrivateWorkerCreateStateV1::Terminal,
                queue_reservation_sha256: Some(reservation_sha256(&releasing)),
                queue_reservation_revision: Some(releasing.reservation_revision),
                ..inner.generation.private.clone()
            },
        };
        self.commit_prebound_locked(&mut inner, generation)?;
        inner.held_lease = None;
        inner.quotes.clear();
        Ok(snapshot_from_inner(&inner))
    }

    /// Final release is intentionally a separate private operation. It can be
    /// called only after a terminal snapshot has been observed/acknowledged by
    /// the owning workflow; it never resumes the queue or starts/stops a Pod.
    pub(crate) fn clear_terminal_after_history(
        &self,
        switch_id: &str,
        expected_record_revision: u64,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        validate_revision_key(switch_id, expected_record_revision)?;
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        ensure_writable(&inner)?;
        let record = exact_record(&inner, switch_id)?.clone();
        if !record.phase.is_terminal() || record.record_revision != expected_record_revision {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        let reservation = self.journal.read_reservation()?.ok_or_else(state_error)?;
        if reservation.phase != PrivateGpuSwitchQueueReservationPhaseV1::Releasing
            || reservation.switch_id != switch_id
        {
            return Err(state_error());
        }
        self.journal.archive_reservation(&reservation)?;
        let generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: next_revision(inner.generation.store_revision)?,
            record: None,
            private: PrivateGpuSwitchGenerationV1::empty(),
        };
        self.commit_prebound_locked(&mut inner, generation)?;
        self.journal.remove_reservation_if_exact(&reservation)?;
        inner
            .issues
            .retain(|issue| issue.code == "gpu_switch_store_recovered");
        Ok(snapshot_from_inner(&inner))
    }

    fn commit_locked(
        &self,
        inner: &mut SwitchInner,
        mut generation: DiskGenerationV1,
    ) -> NativeResult<()> {
        if let Some(record) = generation
            .record
            .as_ref()
            .filter(|record| !record.phase.is_terminal())
        {
            let current = self.journal.read_reservation()?.ok_or_else(state_error)?;
            if current.phase != PrivateGpuSwitchQueueReservationPhaseV1::Active
                || current.switch_id != record.switch_id
            {
                return Err(state_error());
            }
            let reservation = PrivateGpuSwitchQueueReservationV1 {
                reservation_revision: next_revision(current.reservation_revision)?,
                native_store_revision: Some(generation.store_revision),
                native_record_revision: Some(record.record_revision),
                updated_at: utc_now()?,
                ..current
            };
            self.journal.write_reservation(&reservation)?;
            generation.private.queue_reservation_sha256 = Some(reservation_sha256(&reservation));
            generation.private.queue_reservation_revision = Some(reservation.reservation_revision);
        }
        self.commit_prebound_locked(inner, generation)
    }

    /// The in-process projection is only an optimization. Every command-side
    /// mutation boundary protected by `profile-control.lock` must prove that
    /// CURRENT and its queue reservation still describe these exact bytes
    /// before it advances a private send/provider marker.
    fn ensure_disk_matches_inner(&self, inner: &SwitchInner) -> NativeResult<()> {
        let loaded = self.journal.load()?;
        if loaded.unrecoverable {
            return Err(state_error());
        }
        if loaded.recovered {
            return Err(switch_error("gpu_switch_store_recovered"));
        }
        if loaded.generation.as_ref() != Some(&inner.generation) {
            return Err(switch_error("gpu_switch_revision_conflict"));
        }
        Ok(())
    }

    fn commit_prebound_locked(
        &self,
        inner: &mut SwitchInner,
        generation: DiskGenerationV1,
    ) -> NativeResult<()> {
        validate_generation(&generation, &inner.issues)?;
        if generation.record.is_some() {
            validate_private_transition(
                &inner.generation.private,
                &generation.private,
                inner.generation.record.as_ref(),
                generation.record.as_ref(),
            )?;
        } else if inner
            .generation
            .record
            .as_ref()
            .is_some_and(|record| !record.phase.is_terminal())
        {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
        self.journal.commit(&generation)?;
        inner.generation = generation;
        Ok(())
    }
}

#[derive(Debug)]
struct JournalLoad {
    generation: Option<DiskGenerationV1>,
    recovered: bool,
    unrecoverable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GenerationReadFault {
    Missing,
    Torn,
    Invalid,
}

impl SwitchJournal {
    fn new(root: PathBuf) -> NativeResult<Self> {
        ensure_directory(&root)?;
        ensure_directory(&root.join("generations"))?;
        ensure_directory(&root.join("history"))?;
        ensure_directory(&root.join("reservation-history"))?;
        Ok(Self {
            root,
            io: Mutex::new(()),
        })
    }

    fn current_path(&self) -> PathBuf {
        self.root.join("CURRENT")
    }

    fn generation_path(&self, revision: u64) -> PathBuf {
        self.root
            .join("generations")
            .join(format!("{revision}.json"))
    }

    fn reservation_path(&self) -> PathBuf {
        self.root.join("QUEUE_RESERVATION")
    }

    fn reservation_previous_path(&self) -> PathBuf {
        self.root.join("QUEUE_RESERVATION.prev")
    }

    fn history_path(&self, switch_id: &str) -> PathBuf {
        self.root
            .join("history")
            .join(format!("{}.json", sha256_text(switch_id)))
    }

    fn reservation_history_path(&self, switch_id: &str) -> PathBuf {
        self.root
            .join("reservation-history")
            .join(format!("{}.json", sha256_text(switch_id)))
    }

    fn load(&self) -> NativeResult<JournalLoad> {
        let _guard = self.io.lock().map_err(|_| state_error())?;
        let current = read_current(&self.current_path());
        let ids = self.generation_ids()?;
        if ids.is_empty() && matches!(current, Ok(None)) {
            return match self.reservation_candidates() {
                Ok(candidates) if candidates.is_empty() => Ok(JournalLoad {
                    generation: None,
                    recovered: false,
                    unrecoverable: false,
                }),
                Ok(_) | Err(_) => Ok(JournalLoad {
                    generation: None,
                    recovered: false,
                    unrecoverable: true,
                }),
            };
        }
        if let Ok(Some(revision)) = current {
            match self.read_generation_for_load(revision) {
                Ok(generation) if self.generation_reservation_is_valid(&generation) => {
                    return Ok(JournalLoad {
                        generation: Some(generation),
                        recovered: false,
                        unrecoverable: false,
                    });
                }
                Ok(generation) if self.is_known_terminal_clear_seam(&generation) => {
                    // `clear_terminal_after_history` commits the empty
                    // generation before it removes the releasing reservation.
                    // A crash in that intentionally ordered gap leaves a
                    // well-formed empty CURRENT plus a fully linked terminal
                    // predecessor. It is not an attacker-controlled semantic
                    // repair: require the exact retained terminal generation,
                    // reservation, and history below, then recover that
                    // predecessor through the normal retained scan.
                }
                Ok(_) | Err(GenerationReadFault::Invalid) => {
                    // A syntactically readable current generation that fails
                    // its cross-record proof is not a torn CURRENT pointer.
                    // Falling back to an older pre-delete generation could
                    // erase evidence of an already-issued provider action, so
                    // it is a fail-closed repair condition instead.
                    return Ok(JournalLoad {
                        generation: None,
                        recovered: false,
                        unrecoverable: true,
                    });
                }
                Err(GenerationReadFault::Missing | GenerationReadFault::Torn) => {
                    // A missing or torn generation is a crash seam. It may
                    // use a retained fully linked generation below; a
                    // well-formed-but-semantic-invalid target never receives
                    // this recovery privilege.
                }
            }
        }
        let mut valid = Vec::new();
        for revision in ids {
            if let Ok(generation) = self.read_generation(revision) {
                if !self.generation_reservation_is_valid(&generation) {
                    continue;
                }
                valid.push(generation);
            }
        }
        valid.sort_by(|left, right| right.store_revision.cmp(&left.store_revision));
        if let Some(generation) = valid.into_iter().next() {
            return Ok(JournalLoad {
                generation: Some(generation),
                recovered: true,
                unrecoverable: false,
            });
        }
        Ok(JournalLoad {
            generation: None,
            recovered: false,
            unrecoverable: true,
        })
    }

    fn generation_reservation_is_valid(&self, generation: &DiskGenerationV1) -> bool {
        let Some(record) = &generation.record else {
            return generation.private.queue_reservation_sha256.is_none()
                && generation.private.queue_reservation_revision.is_none()
                && self
                    .reservation_candidates()
                    .is_ok_and(|candidates| candidates.is_empty());
        };
        if record.phase.is_terminal() {
            return self.terminal_reservation_is_valid(generation, record);
        }
        self.reservation_candidates().is_ok_and(|candidates| {
            candidates.into_iter().any(|reservation| {
                let reservation_hash = reservation_sha256(&reservation);
                let private_matches = generation.private.queue_reservation_revision
                    == Some(reservation.reservation_revision)
                    && generation.private.queue_reservation_sha256.as_deref()
                        == Some(reservation_hash.as_str());
                match reservation.phase {
                    PrivateGpuSwitchQueueReservationPhaseV1::Prepared => {
                        record.phase == NativeGpuSwitchPhaseV1::Planned
                            && reservation.switch_id == record.switch_id
                            && reservation.native_store_revision.is_none()
                            && reservation.native_record_revision.is_none()
                            && private_matches
                    }
                    PrivateGpuSwitchQueueReservationPhaseV1::Active => {
                        reservation.switch_id == record.switch_id
                            && reservation.native_store_revision == Some(generation.store_revision)
                            && reservation.native_record_revision == Some(record.record_revision)
                            && private_matches
                    }
                    PrivateGpuSwitchQueueReservationPhaseV1::Releasing => false,
                }
            })
        })
    }

    /// Recognize only the crash seam between a durable terminal-clear
    /// generation and removal of its already-linked releasing reservation.
    /// Any other readable CURRENT/cross-record mismatch is unrecoverable so an
    /// older generation cannot erase evidence of a provider mutation.
    fn is_known_terminal_clear_seam(&self, generation: &DiskGenerationV1) -> bool {
        if generation.record.is_some()
            || generation.private != PrivateGpuSwitchGenerationV1::empty()
        {
            return false;
        }
        let Ok(candidates) = self.reservation_candidates() else {
            return false;
        };
        candidates.into_iter().any(|reservation| {
            if reservation.phase != PrivateGpuSwitchQueueReservationPhaseV1::Releasing {
                return false;
            }
            let Some(terminal_store_revision) = reservation.native_store_revision else {
                return false;
            };
            if terminal_store_revision.checked_add(1) != Some(generation.store_revision) {
                return false;
            }
            let Ok(terminal_generation) = self.read_generation_for_load(terminal_store_revision)
            else {
                return false;
            };
            let Some(terminal_record) = terminal_generation.record.as_ref() else {
                return false;
            };
            terminal_record.phase.is_terminal()
                && reservation.native_record_revision == Some(terminal_record.record_revision)
                && self.terminal_reservation_is_valid(&terminal_generation, terminal_record)
        })
    }

    fn terminal_reservation_is_valid(
        &self,
        generation: &DiskGenerationV1,
        record: &NativeGpuSwitchRecordV1,
    ) -> bool {
        if record.queue_reservation.active
            || record.queue_reservation.queue_run_revision.is_some()
            || generation.private.worker_create_state != PrivateWorkerCreateStateV1::Terminal
        {
            return false;
        }
        let terminal_state = match record.phase {
            NativeGpuSwitchPhaseV1::Completed => "completed",
            NativeGpuSwitchPhaseV1::CancelledPreDelete => "cancelled_pre_delete",
            _ => return false,
        };
        let Ok(Some(history)) = self.read_history(&record.switch_id) else {
            return false;
        };
        let history_hash = history_sha256(&history);
        self.reservation_candidates().is_ok_and(|candidates| {
            candidates.into_iter().any(|reservation| {
                let reservation_hash = reservation_sha256(&reservation);
                reservation.phase == PrivateGpuSwitchQueueReservationPhaseV1::Releasing
                    && reservation.switch_id == record.switch_id
                    && reservation.native_store_revision == Some(generation.store_revision)
                    && reservation.native_record_revision == Some(record.record_revision)
                    && reservation.terminal_state.as_deref() == Some(terminal_state)
                    && reservation.native_history_sha256.as_deref() == Some(history_hash.as_str())
                    && generation.private.queue_reservation_revision
                        == Some(reservation.reservation_revision)
                    && generation.private.queue_reservation_sha256.as_deref()
                        == Some(reservation_hash.as_str())
                    && history.terminal_state == terminal_state
                    && history.old_pod_id == record.old_pod.pod_id
                    && history.final_attempt_id == record.current_target.replacement_attempt_id
                    && history.replacement_pod_id == record.replacement_pod_id
            })
        })
    }

    fn reservation_candidates(&self) -> NativeResult<Vec<PrivateGpuSwitchQueueReservationV1>> {
        let mut candidates = Vec::new();
        for path in [self.reservation_path(), self.reservation_previous_path()] {
            match self.read_reservation_one(&path) {
                Ok(Some(reservation)) => {
                    if !candidates.contains(&reservation) {
                        candidates.push(reservation);
                    }
                }
                Ok(None) => {}
                Err(_) => return Err(state_error()),
            }
        }
        Ok(candidates)
    }

    fn read_reservation(&self) -> NativeResult<Option<PrivateGpuSwitchQueueReservationV1>> {
        match self.read_reservation_one(&self.reservation_path()) {
            Ok(Some(reservation)) => Ok(Some(reservation)),
            Ok(None) => self.read_reservation_one(&self.reservation_previous_path()),
            Err(_) => match self.read_reservation_one(&self.reservation_previous_path()) {
                Ok(Some(reservation)) => Ok(Some(reservation)),
                _ => Err(state_error()),
            },
        }
    }

    fn read_reservation_one(
        &self,
        path: &Path,
    ) -> NativeResult<Option<PrivateGpuSwitchQueueReservationV1>> {
        let bytes = match read_limited(path, 4 * 1024) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(state_error()),
        };
        let reservation: PrivateGpuSwitchQueueReservationV1 =
            serde_json::from_slice(&bytes).map_err(|_| state_error())?;
        if serde_json::to_vec(&reservation).ok().as_deref() != Some(bytes.as_slice()) {
            return Err(state_error());
        }
        validate_reservation(&reservation)?;
        Ok(Some(reservation))
    }

    fn write_reservation(
        &self,
        reservation: &PrivateGpuSwitchQueueReservationV1,
    ) -> NativeResult<()> {
        validate_reservation(reservation)?;
        let encoded = serde_json::to_vec(reservation).map_err(|_| state_error())?;
        if encoded.len() > 4 * 1024 {
            return Err(state_error());
        }
        let _guard = self.io.lock().map_err(|_| state_error())?;
        match self.read_reservation_one(&self.reservation_path()) {
            Ok(Some(prior)) => {
                let prior = serde_json::to_vec(&prior).map_err(|_| state_error())?;
                write_replace_atomic(&self.reservation_previous_path(), &prior)
                    .map_err(|_| state_error())?;
            }
            Ok(None) => {}
            Err(_) => return Err(state_error()),
        }
        write_replace_atomic(&self.reservation_path(), &encoded).map_err(|_| state_error())
    }

    fn write_history(&self, history: &NativeGpuSwitchHistoryV1) -> NativeResult<String> {
        validate_history(history)?;
        let encoded = serde_json::to_vec(history).map_err(|_| state_error())?;
        let path = self.history_path(&history.switch_id);
        if path.exists() {
            let existing = read_limited(&path, MAX_GENERATION_BYTES).map_err(|_| state_error())?;
            if existing != encoded {
                return Err(switch_error("gpu_switch_revision_conflict"));
            }
        } else {
            write_immutable(&path, &encoded).map_err(|_| state_error())?;
        }
        Ok(hex::encode(Sha256::digest(encoded)))
    }

    fn archive_reservation(
        &self,
        reservation: &PrivateGpuSwitchQueueReservationV1,
    ) -> NativeResult<()> {
        validate_reservation(reservation)?;
        if reservation.phase != PrivateGpuSwitchQueueReservationPhaseV1::Releasing {
            return Err(state_error());
        }
        let encoded = serde_json::to_vec(reservation).map_err(|_| state_error())?;
        let path = self.reservation_history_path(&reservation.switch_id);
        if path.exists() {
            let existing = read_limited(&path, 4 * 1024).map_err(|_| state_error())?;
            if existing != encoded {
                return Err(switch_error("gpu_switch_revision_conflict"));
            }
        } else {
            write_immutable(&path, &encoded).map_err(|_| state_error())?;
        }
        Ok(())
    }

    fn remove_reservation_if_exact(
        &self,
        expected: &PrivateGpuSwitchQueueReservationV1,
    ) -> NativeResult<()> {
        let _guard = self.io.lock().map_err(|_| state_error())?;
        let current = self
            .read_reservation_one(&self.reservation_path())?
            .ok_or_else(state_error)?;
        if &current != expected {
            return Err(switch_error("gpu_switch_revision_conflict"));
        }
        fs::remove_file(self.reservation_path()).map_err(|_| state_error())?;
        match fs::symlink_metadata(self.reservation_previous_path()) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                fs::remove_file(self.reservation_previous_path()).map_err(|_| state_error())?;
            }
            Ok(_) => return Err(state_error()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(state_error()),
        }
        sync_directory(&self.root).map_err(|_| state_error())
    }

    fn read_history(&self, switch_id: &str) -> NativeResult<Option<NativeGpuSwitchHistoryV1>> {
        let path = self.history_path(switch_id);
        let bytes = match read_limited(&path, MAX_GENERATION_BYTES) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(state_error()),
        };
        let history: NativeGpuSwitchHistoryV1 =
            serde_json::from_slice(&bytes).map_err(|_| state_error())?;
        if serde_json::to_vec(&history).ok().as_deref() != Some(bytes.as_slice()) {
            return Err(state_error());
        }
        validate_history(&history)?;
        Ok(Some(history))
    }

    fn commit(&self, generation: &DiskGenerationV1) -> NativeResult<()> {
        let _guard = self.io.lock().map_err(|_| state_error())?;
        let path = self.generation_path(generation.store_revision);
        let encoded = serde_json::to_vec(generation).map_err(|_| state_error())?;
        if encoded.len() as u64 > MAX_GENERATION_BYTES {
            return Err(switch_error("gpu_switch_revision_exhausted"));
        }
        if path.exists() {
            let previous = self.read_generation(generation.store_revision)?;
            if previous != *generation {
                return Err(switch_error("gpu_switch_revision_conflict"));
            }
        } else {
            write_immutable(&path, &encoded).map_err(|_| state_error())?;
        }
        write_current(&self.current_path(), generation.store_revision)
            .map_err(|_| state_error())?;
        self.cleanup(generation.store_revision);
        Ok(())
    }

    fn read_generation(&self, revision: u64) -> NativeResult<DiskGenerationV1> {
        self.read_generation_for_load(revision)
            .map_err(|_| state_error())
    }

    fn read_generation_for_load(
        &self,
        revision: u64,
    ) -> Result<DiskGenerationV1, GenerationReadFault> {
        let bytes = match read_limited(&self.generation_path(revision), MAX_GENERATION_BYTES) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(GenerationReadFault::Missing)
            }
            Err(_) => return Err(GenerationReadFault::Torn),
        };
        let generation: DiskGenerationV1 =
            serde_json::from_slice(&bytes).map_err(|_| GenerationReadFault::Torn)?;
        if serde_json::to_vec(&generation).ok().as_deref() != Some(bytes.as_slice()) {
            return Err(GenerationReadFault::Torn);
        }
        validate_generation(&generation, &[]).map_err(|_| GenerationReadFault::Invalid)?;
        if generation.store_revision != revision {
            return Err(GenerationReadFault::Invalid);
        }
        Ok(generation)
    }

    fn generation_ids(&self) -> NativeResult<Vec<u64>> {
        let mut ids = Vec::new();
        let directory = self.root.join("generations");
        for entry in fs::read_dir(directory).map_err(|_| state_error())? {
            let entry = entry.map_err(|_| state_error())?;
            let metadata = entry.metadata().map_err(|_| state_error())?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Some(raw) = name.strip_suffix(".json") else {
                continue;
            };
            if raw.is_empty() || (raw.len() > 1 && raw.starts_with('0')) {
                continue;
            }
            if let Ok(id) = raw.parse::<u64>() {
                if id > 0 && id <= MAX_SAFE_INTEGER {
                    ids.push(id);
                }
            }
        }
        Ok(ids)
    }

    fn cleanup(&self, current: u64) {
        let Ok(mut ids) = self.generation_ids() else {
            return;
        };
        ids.sort_unstable_by(|left, right| right.cmp(left));
        for revision in ids.into_iter().skip(RETAINED_GENERATIONS) {
            if revision >= current {
                continue;
            }
            // Invalid/orphaned journals are evidence, not temporary files.
            if self.read_generation(revision).is_ok() {
                let _ = fs::remove_file(self.generation_path(revision));
            }
        }
        let _ = sync_directory(&self.root.join("generations"));
    }
}

fn snapshot_from_inner(inner: &SwitchInner) -> NativeGpuSwitchSnapshotV1 {
    let mut record = inner.generation.record.clone();
    if let Some(record) = &mut record {
        record.authorization_required =
            inner.held_lease.as_deref() != Some(record.switch_id.as_str());
    }
    NativeGpuSwitchSnapshotV1 {
        schema_version: SCHEMA_VERSION,
        store_revision: inner.generation.store_revision,
        record,
        issues: inner.issues.clone(),
    }
}

fn issue(code: &str) -> NativeGpuSwitchIssueV1 {
    NativeGpuSwitchIssueV1 {
        code: code.to_owned(),
        retryable: is_retryable_code(code),
    }
}

fn switch_error(code: &'static str) -> NativeError {
    let message = match code {
        "gpu_switch_store_unrecoverable" => {
            "GPU switch state is unavailable until its local recovery evidence is repaired."
        }
        "gpu_switch_active" => "Another GPU switch is already active.",
        "gpu_switch_not_found" => "The requested GPU switch is no longer available.",
        "gpu_switch_revision_conflict" => "GPU switch state changed. Reload before continuing.",
        "gpu_switch_revision_exhausted" => "GPU switch revision capacity is exhausted.",
        "gpu_switch_lease_busy" => "Another ImageForge process holds this GPU switch.",
        "gpu_switch_lease_required" => "Resume this GPU switch from the focused ImageForge window.",
        "gpu_switch_transition_invalid" => {
            "That GPU switch action is not valid in its current state."
        }
        "gpu_switch_foreground_grant_required" => {
            "Use the focused ImageForge GPU switch control to continue."
        }
        "gpu_switch_foreground_grant_invalid" => "The GPU switch authorization is invalid.",
        "gpu_switch_foreground_grant_expired" => "The GPU switch authorization expired.",
        "gpu_switch_foreground_grant_consumed" => "The GPU switch authorization was already used.",
        "gpu_switch_quote_invalid" => "The replacement GPU quote is invalid.",
        "gpu_switch_quote_expired" => "The replacement GPU quote expired.",
        "gpu_switch_quote_consumed" => "The replacement GPU quote was already used.",
        "gpu_switch_target_unapproved" => "Choose a different approved GPU target.",
        "gpu_identity_invalid" => "The GPU identity is invalid.",
        "gpu_switch_provider_response_mismatch" => {
            "The provider response does not match this GPU switch."
        }
        "gpu_switch_worker_guard_missing" => "The worker is not ready for that GPU switch action.",
        "gpu_switch_request_in_progress" => "A GPU switch request is already in progress.",
        "gpu_switch_pending" => "A coordinated GPU switch is already in progress.",
        _ => "The GPU switch could not continue safely.",
    };
    if is_retryable_code(code) {
        NativeError::retryable(code, message)
    } else {
        NativeError::new(code, message)
    }
}

fn normal_stop_veto_for_phase(
    phase: NativeGpuSwitchPhaseV1,
    blocked_at: Option<NativeGpuSwitchPhaseV1>,
) -> NativeResult<()> {
    let effective_phase = if phase == NativeGpuSwitchPhaseV1::NeedsAttention {
        blocked_at.ok_or_else(state_error)?
    } else {
        phase
    };
    if effective_phase.is_terminal() {
        return Ok(());
    }
    if matches!(
        effective_phase,
        NativeGpuSwitchPhaseV1::Planned | NativeGpuSwitchPhaseV1::ConsentPending
    ) {
        Err(switch_error("gpu_switch_request_in_progress"))
    } else {
        Err(switch_error("gpu_switch_pending"))
    }
}

fn state_error() -> NativeError {
    NativeError::new(
        "gpu_switch_store_unrecoverable",
        "GPU switch state is unavailable until its local recovery evidence is repaired.",
    )
}

fn is_retryable_code(code: &str) -> bool {
    matches!(
        code,
        "gpu_switch_revision_conflict"
            | "gpu_switch_lease_busy"
            | "gpu_switch_inventory_unavailable"
    )
}

fn is_known_native_code(code: &str) -> bool {
    matches!(
        code,
        "gpu_switch_store_recovered"
            | "gpu_switch_store_unrecoverable"
            | "gpu_switch_active"
            | "gpu_switch_not_found"
            | "gpu_switch_revision_conflict"
            | "gpu_switch_revision_exhausted"
            | "gpu_switch_lease_busy"
            | "gpu_switch_lease_required"
            | "gpu_switch_transition_invalid"
            | "gpu_switch_foreground_grant_required"
            | "gpu_switch_foreground_grant_invalid"
            | "gpu_switch_foreground_grant_expired"
            | "gpu_switch_foreground_grant_consumed"
            | "queue_gpu_switch_pending"
            | "gpu_switch_queue_reservation_conflict"
            | "gpu_switch_queue_reservation_corrupt"
            | "gpu_switch_queue_dispatch_uncertain"
            | "gpu_switch_local_receipts_pending"
            | "gpu_switch_inventory_unavailable"
            | "gpu_switch_inventory_stale"
            | "gpu_switch_inventory_receipt_invalid"
            | "gpu_switch_price_changed"
            | "gpu_actual_price_changed"
            | "gpu_actual_price_unavailable"
            | "gpu_identity_invalid"
            | "gpu_switch_target_unapproved"
            | "gpu_switch_target_unavailable"
            | "gpu_switch_current_pod_unverified"
            | "gpu_switch_requester_not_foreground"
            | "gpu_switch_old_pod_changed"
            | "gpu_switch_old_pod_disappeared_early"
            | "gpu_switch_profile_locked"
            | "gpu_switch_worker_create_uncertain"
            | "gpu_switch_worker_response_invalid"
            | "gpu_switch_worker_guard_missing"
            | "gpu_switch_delete_uncertain"
            | "gpu_switch_create_uncertain"
            | "gpu_switch_replacement_ambiguous"
            | "gpu_switch_replacement_mismatch"
            | "gpu_switch_provider_response_mismatch"
            | "gpu_switch_zero_match_unproven"
            | "gpu_switch_replacement_cleanup_required"
            | "gpu_switch_replacement_delete_uncertain"
            | "gpu_switch_peer_pod_present"
            | "gpu_switch_peer_pod_overflow"
            | "gpu_switch_quote_invalid"
            | "gpu_switch_quote_expired"
            | "gpu_switch_quote_consumed"
            | "gpu_switch_pause_failed"
            | "gpu_switch_completion_failed"
            | "gpu_switch_cancel_not_allowed"
            | "stop_request_in_progress"
            | "gpu_stop_pending"
            | "gpu_switch_request_in_progress"
            | "gpu_switch_pending"
            | "gpu_control_guard_conflict"
            | "gpu_switch_store_corrupt"
            | "gpu_switch_runtime_identity_unavailable"
    )
}

fn is_attention_code(code: &str) -> bool {
    matches!(
        code,
        "gpu_switch_revision_exhausted"
            | "gpu_actual_price_changed"
            | "gpu_actual_price_unavailable"
            | "gpu_switch_target_unavailable"
            | "gpu_switch_old_pod_changed"
            | "gpu_switch_old_pod_disappeared_early"
            | "gpu_switch_profile_locked"
            | "gpu_switch_worker_create_uncertain"
            | "gpu_switch_worker_response_invalid"
            | "gpu_switch_worker_guard_missing"
            | "gpu_switch_replacement_ambiguous"
            | "gpu_switch_replacement_mismatch"
            | "gpu_switch_provider_response_mismatch"
            | "gpu_switch_zero_match_unproven"
            | "gpu_switch_peer_pod_present"
            | "gpu_switch_peer_pod_overflow"
            | "gpu_switch_pause_failed"
            | "gpu_switch_completion_failed"
            | "gpu_switch_runtime_identity_unavailable"
    )
}

fn attention_allowed_at(code: &str, phase: NativeGpuSwitchPhaseV1) -> bool {
    use NativeGpuSwitchPhaseV1::*;
    match code {
        "gpu_switch_revision_exhausted" => phase.is_blocked_phase(),
        "gpu_switch_worker_create_uncertain" | "gpu_switch_worker_response_invalid" => {
            phase == Planned
        }
        "gpu_switch_pause_failed" => phase == Pausing,
        "gpu_actual_price_changed" | "gpu_actual_price_unavailable" => {
            matches!(phase, ReplacementIdentified | Provisioning)
        }
        "gpu_switch_peer_pod_present"
        | "gpu_switch_peer_pod_overflow"
        | "gpu_switch_provider_response_mismatch"
        | "gpu_switch_replacement_ambiguous"
        | "gpu_switch_replacement_mismatch"
        | "gpu_switch_zero_match_unproven" => matches!(
            phase,
            OldAbsent
                | CreateIntent
                | CreateUncertain
                | ReplacementIdentified
                | Provisioning
                | ReplacementFailed
                | ReplacementDeleteIntent
                | ReplacementDeleteUncertain
        ),
        "gpu_switch_completion_failed" | "gpu_switch_runtime_identity_unavailable" => {
            matches!(phase, Provisioning | ReadyPaused)
        }
        "gpu_switch_target_unavailable"
        | "gpu_switch_old_pod_changed"
        | "gpu_switch_old_pod_disappeared_early"
        | "gpu_switch_profile_locked"
        | "gpu_switch_worker_guard_missing" => phase.is_blocked_phase(),
        _ => false,
    }
}

fn validate_attention_for_phase(code: &str, phase: NativeGpuSwitchPhaseV1) -> NativeResult<()> {
    if !is_attention_code(code) || !attention_allowed_at(code, phase) {
        return Err(switch_error("gpu_switch_transition_invalid"));
    }
    Ok(())
}

fn validate_generation(
    generation: &DiskGenerationV1,
    issues: &[NativeGpuSwitchIssueV1],
) -> NativeResult<()> {
    if generation.schema_version != SCHEMA_VERSION || generation.store_revision > MAX_SAFE_INTEGER {
        return Err(state_error());
    }
    if generation.store_revision == 0 && generation.record.is_some() {
        return Err(state_error());
    }
    validate_private_generation(&generation.private, generation.record.as_ref())?;
    if let Some(record) = &generation.record {
        let derived_issue = record.attention_code.as_deref().map(issue);
        let effective_issues = if issues.is_empty() {
            derived_issue.as_ref().map_or(&[][..], std::slice::from_ref)
        } else {
            issues
        };
        validate_record(record, effective_issues)?;
    }
    Ok(())
}

fn validate_worker_create_intent(
    intent: &NativeGpuSwitchWorkerCreateIntentV1,
    record: &NativeGpuSwitchRecordV1,
) -> NativeResult<()> {
    if !valid_sha256(&intent.profile_binding_sha256)
        || !valid_sha256(&intent.credential_binding_sha256)
        || !valid_sha256(&intent.worker_session_binding_sha256)
        || !valid_sha256(&intent.canonical_body_sha256)
        || intent.canonical_body.len() > 4 * 1024
        || sha256_text(&intent.canonical_body) != intent.canonical_body_sha256
    {
        return Err(switch_error("gpu_switch_transition_invalid"));
    }
    let body = parse_private_worker_create_body(&intent.canonical_body)
        .ok_or_else(|| switch_error("gpu_switch_transition_invalid"))?;
    if !private_worker_create_body_matches_record(&body, record) {
        return Err(switch_error("gpu_switch_transition_invalid"));
    }
    Ok(())
}

fn worker_create_body_session_id(body: &str) -> NativeResult<String> {
    parse_private_worker_create_body(body)
        .map(|body| body.session_id)
        .ok_or_else(|| switch_error("gpu_switch_transition_invalid"))
}

fn validate_worker_binding(binding: &NativeGpuSwitchWorkerBindingV1) -> NativeResult<()> {
    if !valid_worker_user_id(&binding.requester_user_id)
        || validate_uuid_v4(
            &binding.principal_binding_id,
            "gpu_switch_transition_invalid",
        )
        .is_err()
    {
        return Err(switch_error("gpu_switch_transition_invalid"));
    }
    Ok(())
}

fn parse_private_worker_create_body(body: &str) -> Option<PrivateWorkerCreateBodyV1> {
    if body.is_empty() || body.len() > 4 * 1024 || body.as_bytes().starts_with(&[0xef, 0xbb, 0xbf])
    {
        return None;
    }
    let mut deserializer = serde_json::Deserializer::from_str(body);
    let parsed = PrivateWorkerCreateBodyV1::deserialize(&mut deserializer).ok()?;
    deserializer.end().ok()?;
    let value = serde_json::to_value(&parsed).ok()?;
    let canonical = super::gpu_inventory::jcs_value(&value).ok()?;
    (canonical == body).then_some(parsed)
}

fn uncertain_create_access_from_generation(
    record: &NativeGpuSwitchRecordV1,
    private: &PrivateGpuSwitchGenerationV1,
) -> NativeResult<NativeGpuSwitchUncertainCreateAccessV1> {
    let body = private
        .worker_create_body
        .as_deref()
        .and_then(parse_private_worker_create_body)
        .ok_or_else(state_error)?;
    if !private_worker_create_body_matches_record(&body, record) {
        return Err(state_error());
    }
    Ok(NativeGpuSwitchUncertainCreateAccessV1 {
        switch_id: body.switch_id,
        record_revision: record.record_revision,
        session_id: body.session_id,
        old_pod_id: body.old_pod_id,
        old_gpu_id: body.old_gpu_id,
        old_gpu_display_name: body.old_gpu_display_name,
        initial_target_gpu_id: body.initial_target_gpu_id,
        initial_target_gpu_display_name: body.initial_target_gpu_display_name,
        initial_replacement_attempt_id: body.initial_replacement_attempt_id,
        expected_batch_id: body.expected_batch_id,
        inventory_observed_at: body.inventory_observed_at,
    })
}

fn private_worker_create_body_matches_record(
    body: &PrivateWorkerCreateBodyV1,
    record: &NativeGpuSwitchRecordV1,
) -> bool {
    body.schema_version == SCHEMA_VERSION
        && validate_uuid_v4(&body.switch_id, "gpu_switch_store_unrecoverable").is_ok()
        && validate_uuid_v4(&body.session_id, "gpu_switch_store_unrecoverable").is_ok()
        && validate_uuid_v4(
            &body.initial_replacement_attempt_id,
            "gpu_switch_store_unrecoverable",
        )
        .is_ok()
        && body
            .expected_batch_id
            .as_deref()
            .map(|value| validate_uuid_v4(value, "gpu_switch_store_unrecoverable").is_ok())
            .unwrap_or(true)
        && valid_pod_id(&body.old_pod_id)
        && [
            &body.old_gpu_id,
            &body.old_gpu_display_name,
            &body.initial_target_gpu_id,
            &body.initial_target_gpu_display_name,
        ]
        .into_iter()
        .all(|value| valid_gpu_identity_raw(value))
        && validate_timestamp(&body.inventory_observed_at).is_ok()
        && body.switch_id == record.switch_id
        && body.old_pod_id == record.old_pod.pod_id
        && body.old_gpu_id == record.old_pod.gpu_id
        && body.old_gpu_display_name == record.old_pod.gpu_display_name
        && body.initial_target_gpu_id == record.initial_target.gpu_id
        && body.initial_target_gpu_display_name == record.initial_target.gpu_display_name
        && body.initial_replacement_attempt_id == record.initial_target.replacement_attempt_id
        && body.expected_batch_id == record.expected_batch_id
        && body.inventory_observed_at == record.initial_target.inventory_observed_at
}

fn valid_worker_user_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn worker_access_from_generation(
    record: &NativeGpuSwitchRecordV1,
    private: &PrivateGpuSwitchGenerationV1,
) -> NativeResult<NativeGpuSwitchWorkerAccessV1> {
    let session_id = private
        .worker_create_session_id
        .clone()
        .ok_or_else(state_error)?;
    let requester_user_id = private.requester_user_id.clone().ok_or_else(state_error)?;
    let principal_binding_id = private
        .principal_binding_id
        .clone()
        .ok_or_else(state_error)?;
    validate_uuid_v4(&session_id, "gpu_switch_store_unrecoverable")?;
    validate_worker_binding(&NativeGpuSwitchWorkerBindingV1 {
        requester_user_id: requester_user_id.clone(),
        principal_binding_id: principal_binding_id.clone(),
    })?;
    if private.worker_create_state != PrivateWorkerCreateStateV1::Bound {
        return Err(state_error());
    }
    if let Some(finalization_id) = private.worker_finalization_id.as_deref() {
        validate_uuid_v4(finalization_id, "gpu_switch_store_unrecoverable")?;
    }
    Ok(NativeGpuSwitchWorkerAccessV1 {
        switch_id: record.switch_id.clone(),
        record_revision: record.record_revision,
        session_id,
        old_pod_id: record.old_pod.pod_id.clone(),
        old_gpu_id: record.old_pod.gpu_id.clone(),
        replacement_pod_id: record.replacement_pod_id.clone(),
        finalization_id: private.worker_finalization_id.clone(),
        requester_user_id,
        principal_binding_id,
        current_target: record.current_target.clone(),
        provider_request_sha256: private.provider_request_sha256.clone(),
        provider_response_sha256: private.provider_response_sha256.clone(),
        create_marker_sha256: private.create_marker_sha256.clone(),
        create_intent_sha256: private.create_intent_sha256.clone(),
        create_wire_body_sha256: private.create_wire_body_sha256.clone(),
        runtime_identity_sha256: private.runtime_identity_sha256.clone(),
    })
}

fn validate_private_generation(
    private: &PrivateGpuSwitchGenerationV1,
    record: Option<&NativeGpuSwitchRecordV1>,
) -> NativeResult<()> {
    if private.schema_version != SCHEMA_VERSION {
        return Err(state_error());
    }
    for hash in [
        private.inventory_catalog_sha256.as_deref(),
        private.consumed_foreground_grant_sha256.as_deref(),
        private.worker_create_body_sha256.as_deref(),
        private.worker_create_session_binding_sha256.as_deref(),
        private.profile_binding_sha256.as_deref(),
        private.credential_binding_sha256.as_deref(),
        private.provider_request_sha256.as_deref(),
        private.provider_response_sha256.as_deref(),
        private.create_marker_sha256.as_deref(),
        private.create_intent_sha256.as_deref(),
        private.create_wire_body_sha256.as_deref(),
        private.zero_match_proof_sha256.as_deref(),
        private.runtime_identity_sha256.as_deref(),
        private.queue_reservation_sha256.as_deref(),
    ] {
        if hash.is_some_and(|value| !valid_sha256(value)) {
            return Err(state_error());
        }
    }
    for id in [
        private.process_epoch_id.as_deref(),
        private.inventory_observation_id.as_deref(),
        private.inventory_receipt_id.as_deref(),
        private.worker_create_session_id.as_deref(),
        private.principal_binding_id.as_deref(),
        private.worker_finalization_id.as_deref(),
    ] {
        if id
            .is_some_and(|value| validate_uuid_v4(value, "gpu_switch_store_unrecoverable").is_err())
        {
            return Err(state_error());
        }
    }
    if private
        .queue_reservation_revision
        .is_some_and(|revision| revision == 0 || revision > MAX_SAFE_INTEGER)
    {
        return Err(state_error());
    }
    let reservation_bound =
        private.queue_reservation_sha256.is_some() && private.queue_reservation_revision.is_some();
    if private.queue_reservation_sha256.is_some() != private.queue_reservation_revision.is_some() {
        return Err(state_error());
    }
    if private
        .requester_user_id
        .as_deref()
        .is_some_and(|value| !valid_worker_user_id(value))
    {
        return Err(state_error());
    }
    let worker_create_bound = private.worker_create_body.is_some()
        && private.worker_create_body_sha256.is_some()
        && private.worker_create_session_binding_sha256.is_some()
        && private.worker_create_session_id.is_some();
    if worker_create_bound
        != (private.worker_create_body.is_some()
            || private.worker_create_body_sha256.is_some()
            || private.worker_create_session_binding_sha256.is_some()
            || private.worker_create_session_id.is_some())
    {
        return Err(state_error());
    }
    if worker_create_bound {
        let (Some(body), Some(body_sha256), Some(session_id), Some(record)) = (
            private.worker_create_body.as_deref(),
            private.worker_create_body_sha256.as_deref(),
            private.worker_create_session_id.as_deref(),
            record,
        ) else {
            return Err(state_error());
        };
        let Some(parsed) = parse_private_worker_create_body(body) else {
            return Err(state_error());
        };
        if sha256_text(body) != body_sha256
            || parsed.session_id != session_id
            || !private_worker_create_body_matches_record(&parsed, record)
        {
            return Err(state_error());
        }
    }
    validate_private_provider_attempts(private, record)?;
    match record {
        Some(record) if !record.phase.is_terminal() && !reservation_bound => Err(state_error()),
        None if reservation_bound => Err(state_error()),
        Some(record) => {
            let inventory_bound = private.process_epoch_id.is_some()
                && private.inventory_observation_id.is_some()
                && private.inventory_receipt_id.is_some()
                && private.inventory_catalog_sha256.is_some()
                && private.consumed_foreground_grant_sha256.is_some();
            if !inventory_bound {
                return Err(state_error());
            }
            let effective_phase = if record.phase == NativeGpuSwitchPhaseV1::NeedsAttention {
                record.blocked_at.ok_or_else(state_error)?
            } else {
                record.phase
            };
            let runtime_identity_required = matches!(
                effective_phase,
                NativeGpuSwitchPhaseV1::ReadyPaused | NativeGpuSwitchPhaseV1::Completed
            );
            if private.runtime_identity_sha256.is_some() != runtime_identity_required {
                return Err(state_error());
            }
            match private.worker_create_state {
                PrivateWorkerCreateStateV1::Draft => {
                    if worker_create_bound
                        || private.profile_binding_sha256.is_some()
                        || private.credential_binding_sha256.is_some()
                        || private.requester_user_id.is_some()
                        || private.principal_binding_id.is_some()
                        || private.worker_finalization_id.is_some()
                        || private.provider_request_sha256.is_some()
                        || private.provider_response_sha256.is_some()
                        || private.create_marker_sha256.is_some()
                        || private.create_intent_sha256.is_some()
                        || private.create_wire_body_sha256.is_some()
                        || private.runtime_identity_sha256.is_some()
                        || !private.provider_attempt_history.is_empty()
                    {
                        return Err(state_error());
                    }
                }
                PrivateWorkerCreateStateV1::SendPending
                | PrivateWorkerCreateStateV1::SentUncertain => {
                    if !worker_create_bound
                        || effective_phase != NativeGpuSwitchPhaseV1::Planned
                        || private.profile_binding_sha256.is_none()
                        || private.credential_binding_sha256.is_none()
                        || private.requester_user_id.is_some()
                        || private.principal_binding_id.is_some()
                    {
                        return Err(state_error());
                    }
                }
                PrivateWorkerCreateStateV1::Bound => {
                    if !worker_create_bound
                        || private.profile_binding_sha256.is_none()
                        || private.credential_binding_sha256.is_none()
                        || private.requester_user_id.is_none()
                        || private.principal_binding_id.is_none()
                        || record.phase == NativeGpuSwitchPhaseV1::Planned
                    {
                        return Err(state_error());
                    }
                }
                PrivateWorkerCreateStateV1::Terminal => {
                    // Terminal evidence retains the original canonical create
                    // body. A local cancellation has no principal binding;
                    // every worker-backed terminal outcome has both values.
                    // This prevents a crafted terminal generation from
                    // erasing the distinction between unsent and uncertain.
                    let local_cancel = record.phase == NativeGpuSwitchPhaseV1::CancelledPreDelete
                        && private.requester_user_id.is_none()
                        && private.principal_binding_id.is_none();
                    if !worker_create_bound
                        || private.profile_binding_sha256.is_none()
                        || private.credential_binding_sha256.is_none()
                        || (!local_cancel
                            && (private.requester_user_id.is_none()
                                || private.principal_binding_id.is_none()))
                    {
                        return Err(state_error());
                    }
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Validate the private provider-attempt ledger against the public durable
/// attempt history.  The ledger deliberately contains only attempts that
/// reached a provider response and were then deleted; a `not_created` entry
/// has no provider fingerprint to retain.  Keeping this relation bijective
/// makes a tampered/stale private generation fail closed on restart instead
/// of poisoning a later explicit retry.
fn validate_private_provider_attempts(
    private: &PrivateGpuSwitchGenerationV1,
    record: Option<&NativeGpuSwitchRecordV1>,
) -> NativeResult<()> {
    let create_contract_bound = private.create_marker_sha256.is_some()
        && private.create_intent_sha256.is_some()
        && private.create_wire_body_sha256.is_some();
    if create_contract_bound
        != (private.create_marker_sha256.is_some()
            || private.create_intent_sha256.is_some()
            || private.create_wire_body_sha256.is_some())
        || create_contract_bound != private.provider_request_sha256.is_some()
        || (create_contract_bound
            && private.provider_request_sha256 != private.create_wire_body_sha256)
    {
        return Err(state_error());
    }
    if private.provider_response_sha256.is_some() && private.provider_request_sha256.is_none() {
        return Err(state_error());
    }
    let Some(record) = record else {
        return if private.provider_request_sha256.is_none()
            && private.provider_response_sha256.is_none()
            && private.create_marker_sha256.is_none()
            && private.create_intent_sha256.is_none()
            && private.create_wire_body_sha256.is_none()
            && private.provider_attempt_history.is_empty()
        {
            Ok(())
        } else {
            Err(state_error())
        };
    };

    let failed_attempts = record
        .prior_attempts
        .iter()
        .filter(|attempt| {
            attempt.outcome == NativeGpuSwitchPriorAttemptOutcomeV1::FailedReplacementDeleted
        })
        .collect::<Vec<_>>();
    if failed_attempts.len() != private.provider_attempt_history.len() {
        return Err(state_error());
    }
    let mut last_revision = 0_u64;
    for (history, public_attempt) in private
        .provider_attempt_history
        .iter()
        .zip(failed_attempts.into_iter())
    {
        if history.schema_version != SCHEMA_VERSION
            || history.attempt_revision == 0
            || history.attempt_revision > MAX_SAFE_INTEGER
            || history.attempt_revision <= last_revision
            || !valid_sha256(&history.request_sha256)
            || !valid_sha256(&history.create_marker_sha256)
            || !valid_sha256(&history.create_intent_sha256)
            || !valid_sha256(&history.create_wire_body_sha256)
            || history.request_sha256 != history.create_wire_body_sha256
            || history
                .response_sha256
                .as_deref()
                .is_some_and(|value| !valid_sha256(value))
            || validate_uuid_v4(
                &history.replacement_attempt_id,
                "gpu_switch_store_unrecoverable",
            )
            .is_err()
            || history.replacement_attempt_id != public_attempt.target.replacement_attempt_id
            || history.attempt_revision != public_attempt.target.attempt_revision
            || history.response_sha256.is_none()
        {
            return Err(state_error());
        }
        last_revision = history.attempt_revision;
    }
    if private.provider_attempt_history.iter().any(|history| {
        history.replacement_attempt_id == record.current_target.replacement_attempt_id
            || history.attempt_revision == record.current_target.attempt_revision
    }) {
        return Err(state_error());
    }
    // An old-deleted/next-attempt record must never carry forward an active
    // provider binding.  Other phases intentionally remain permissive here:
    // `needs_attention` can preserve the exact pre-write evidence while the
    // user decides whether to reconcile or delete.
    if record.phase == NativeGpuSwitchPhaseV1::OldAbsent
        && (private.provider_request_sha256.is_some()
            || private.provider_response_sha256.is_some()
            || private.create_marker_sha256.is_some()
            || private.create_intent_sha256.is_some()
            || private.create_wire_body_sha256.is_some())
    {
        return Err(state_error());
    }
    Ok(())
}

fn validate_provider_attempt_transition(
    prior: &PrivateGpuSwitchGenerationV1,
    candidate: &PrivateGpuSwitchGenerationV1,
    prior_record: Option<&NativeGpuSwitchRecordV1>,
    candidate_record: Option<&NativeGpuSwitchRecordV1>,
) -> NativeResult<()> {
    let history_prefix_is_immutable = candidate.provider_attempt_history.len()
        >= prior.provider_attempt_history.len()
        && candidate.provider_attempt_history.len()
            <= prior.provider_attempt_history.len().saturating_add(1)
        && candidate
            .provider_attempt_history
            .iter()
            .take(prior.provider_attempt_history.len())
            .eq(prior.provider_attempt_history.iter());
    if !history_prefix_is_immutable {
        return Err(switch_error("gpu_switch_transition_invalid"));
    }
    let prior_pair = (
        prior.provider_request_sha256.as_deref(),
        prior.provider_response_sha256.as_deref(),
    );
    let candidate_pair = (
        candidate.provider_request_sha256.as_deref(),
        candidate.provider_response_sha256.as_deref(),
    );
    let prior_create = (
        prior.create_marker_sha256.as_deref(),
        prior.create_intent_sha256.as_deref(),
        prior.create_wire_body_sha256.as_deref(),
    );
    let candidate_create = (
        candidate.create_marker_sha256.as_deref(),
        candidate.create_intent_sha256.as_deref(),
        candidate.create_wire_body_sha256.as_deref(),
    );
    let history_grew = candidate.provider_attempt_history.len()
        == prior.provider_attempt_history.len().saturating_add(1);
    if prior_pair == candidate_pair && prior_create == candidate_create {
        return if history_grew {
            Err(switch_error("gpu_switch_transition_invalid"))
        } else {
            Ok(())
        };
    }

    // First durable binding for the current attempt.  The current target is
    // already a new UUID/revision after cleanup, so a stale hash can never be
    // rebound to it.
    if prior_pair == (None, None)
        && candidate_pair.0.is_some()
        && candidate_pair.1.is_none()
        && prior_create == (None, None, None)
        && candidate_create.0.is_some()
        && candidate_create.1.is_some()
        && candidate_create.2 == candidate_pair.0
        && !history_grew
        && prior_record.is_some_and(|record| record.phase == NativeGpuSwitchPhaseV1::OldAbsent)
        && candidate_record
            .is_some_and(|record| record.phase == NativeGpuSwitchPhaseV1::CreateIntent)
    {
        return Ok(());
    }
    // The one allowed in-place extension is binding the response to the
    // already immutable request digest.  It cannot replace the request.
    if let (Some(prior_request), None) = prior_pair {
        if candidate_pair == (Some(prior_request), candidate_pair.1)
            && candidate_pair.1.is_some()
            && candidate_create == prior_create
            && !history_grew
        {
            return Ok(());
        }
    }
    // Failed-replacement cleanup atomically archives the exact current
    // fingerprints and clears the active pair while switching to a freshly
    // allocated replacement attempt.  This is the only allowed clear.
    if let (Some(prior_request), Some(prior_response)) = prior_pair {
        if candidate_pair == (None, None)
            && candidate_create == (None, None, None)
            && history_grew
            && matches!(
                prior_record.map(|record| record.phase),
                Some(
                    NativeGpuSwitchPhaseV1::ReplacementDeleteIntent
                        | NativeGpuSwitchPhaseV1::ReplacementDeleteUncertain
                )
            )
            && candidate_record
                .is_some_and(|record| record.phase == NativeGpuSwitchPhaseV1::OldAbsent)
        {
            let Some(prior_record) = prior_record else {
                return Err(switch_error("gpu_switch_transition_invalid"));
            };
            let Some(entry) = candidate.provider_attempt_history.last() else {
                return Err(switch_error("gpu_switch_transition_invalid"));
            };
            if entry.replacement_attempt_id == prior_record.current_target.replacement_attempt_id
                && entry.attempt_revision == prior_record.current_target.attempt_revision
                && entry.request_sha256 == prior_request
                && entry.response_sha256.as_deref() == Some(prior_response)
                && Some(entry.create_marker_sha256.as_str()) == prior_create.0
                && Some(entry.create_intent_sha256.as_str()) == prior_create.1
                && Some(entry.create_wire_body_sha256.as_str()) == prior_create.2
            {
                return Ok(());
            }
        }
    }
    Err(switch_error("gpu_switch_transition_invalid"))
}

fn validate_private_transition(
    prior: &PrivateGpuSwitchGenerationV1,
    candidate: &PrivateGpuSwitchGenerationV1,
    prior_record: Option<&NativeGpuSwitchRecordV1>,
    candidate_record: Option<&NativeGpuSwitchRecordV1>,
) -> NativeResult<()> {
    let immutable = [
        (&prior.process_epoch_id, &candidate.process_epoch_id),
        (
            &prior.inventory_observation_id,
            &candidate.inventory_observation_id,
        ),
        (&prior.inventory_receipt_id, &candidate.inventory_receipt_id),
        (
            &prior.inventory_catalog_sha256,
            &candidate.inventory_catalog_sha256,
        ),
        (
            &prior.consumed_foreground_grant_sha256,
            &candidate.consumed_foreground_grant_sha256,
        ),
        (&prior.worker_create_body, &candidate.worker_create_body),
        (
            &prior.worker_create_body_sha256,
            &candidate.worker_create_body_sha256,
        ),
        (
            &prior.worker_create_session_binding_sha256,
            &candidate.worker_create_session_binding_sha256,
        ),
        (
            &prior.worker_create_session_id,
            &candidate.worker_create_session_id,
        ),
        (
            &prior.profile_binding_sha256,
            &candidate.profile_binding_sha256,
        ),
        (
            &prior.credential_binding_sha256,
            &candidate.credential_binding_sha256,
        ),
        (&prior.requester_user_id, &candidate.requester_user_id),
        (&prior.principal_binding_id, &candidate.principal_binding_id),
        (
            &prior.worker_finalization_id,
            &candidate.worker_finalization_id,
        ),
        (
            &prior.zero_match_proof_sha256,
            &candidate.zero_match_proof_sha256,
        ),
        (
            &prior.runtime_identity_sha256,
            &candidate.runtime_identity_sha256,
        ),
    ];
    for (old, new) in immutable {
        if old.is_some() && old != new {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
    }
    validate_provider_attempt_transition(prior, candidate, prior_record, candidate_record)?;
    if !matches!(
        (prior.worker_create_state, candidate.worker_create_state),
        (
            PrivateWorkerCreateStateV1::Draft,
            PrivateWorkerCreateStateV1::Draft
        ) | (
            PrivateWorkerCreateStateV1::Draft,
            PrivateWorkerCreateStateV1::SendPending
        ) | (
            PrivateWorkerCreateStateV1::SendPending,
            PrivateWorkerCreateStateV1::SendPending
        ) | (
            PrivateWorkerCreateStateV1::SendPending,
            PrivateWorkerCreateStateV1::SentUncertain
        ) | (
            PrivateWorkerCreateStateV1::SendPending,
            PrivateWorkerCreateStateV1::Terminal
        ) | (
            PrivateWorkerCreateStateV1::SentUncertain,
            PrivateWorkerCreateStateV1::SentUncertain
        ) | (
            PrivateWorkerCreateStateV1::SentUncertain,
            PrivateWorkerCreateStateV1::Bound
        ) | (
            PrivateWorkerCreateStateV1::Bound,
            PrivateWorkerCreateStateV1::Bound
        ) | (
            PrivateWorkerCreateStateV1::Bound,
            PrivateWorkerCreateStateV1::Terminal
        ) | (
            PrivateWorkerCreateStateV1::Terminal,
            PrivateWorkerCreateStateV1::Terminal
        )
    ) {
        return Err(switch_error("gpu_switch_transition_invalid"));
    }
    Ok(())
}

fn validate_reservation(reservation: &PrivateGpuSwitchQueueReservationV1) -> NativeResult<()> {
    if reservation.schema_version != SCHEMA_VERSION
        || reservation.reservation_revision == 0
        || reservation.reservation_revision > MAX_SAFE_INTEGER
        || reservation.queue_store_revision > MAX_SAFE_INTEGER
    {
        return Err(state_error());
    }
    validate_uuid_v4(&reservation.switch_id, "gpu_switch_store_unrecoverable")?;
    if reservation
        .queue_run_revision
        .as_deref()
        .is_some_and(|value| validate_uuid_v4(value, "gpu_switch_store_unrecoverable").is_err())
    {
        return Err(state_error());
    }
    for revision in [
        reservation.native_store_revision,
        reservation.native_record_revision,
    ] {
        if revision.is_some_and(|value| value == 0 || value > MAX_SAFE_INTEGER) {
            return Err(state_error());
        }
    }
    for hash in [
        reservation.worker_tombstone_sha256.as_deref(),
        reservation.native_history_sha256.as_deref(),
    ] {
        if hash.is_some_and(|value| !valid_sha256(value)) {
            return Err(state_error());
        }
    }
    validate_timestamp(&reservation.created_at)?;
    validate_timestamp(&reservation.updated_at)?;
    if reservation.updated_at < reservation.created_at {
        return Err(state_error());
    }
    match reservation.phase {
        PrivateGpuSwitchQueueReservationPhaseV1::Prepared => {
            if reservation.reservation_revision != 1
                || reservation.native_store_revision.is_some()
                || reservation.native_record_revision.is_some()
                || reservation.terminal_state.is_some()
                || reservation.worker_tombstone_sha256.is_some()
                || reservation.native_history_sha256.is_some()
            {
                return Err(state_error());
            }
        }
        PrivateGpuSwitchQueueReservationPhaseV1::Active => {
            if reservation.reservation_revision < 2
                || reservation.native_store_revision.is_none()
                || reservation.native_record_revision.is_none()
                || reservation.terminal_state.is_some()
                || reservation.worker_tombstone_sha256.is_some()
                || reservation.native_history_sha256.is_some()
            {
                return Err(state_error());
            }
        }
        PrivateGpuSwitchQueueReservationPhaseV1::Releasing => {
            if reservation.reservation_revision < 3
                || reservation.native_store_revision.is_none()
                || reservation.native_record_revision.is_none()
                || !matches!(
                    reservation.terminal_state.as_deref(),
                    Some("completed" | "cancelled_pre_delete" | "denied" | "expired")
                )
                || reservation
                    .native_history_sha256
                    .as_deref()
                    .is_none_or(|hash| !valid_sha256(hash))
            {
                return Err(state_error());
            }
        }
    }
    Ok(())
}

fn reservation_sha256(reservation: &PrivateGpuSwitchQueueReservationV1) -> String {
    // All durable reservation bytes originate here and serde field ordering is
    // fixed by the struct. The hash is private linkage, not a renderer-facing
    // canonicalization format.
    let bytes = serde_json::to_vec(reservation).unwrap_or_default();
    hex::encode(Sha256::digest(bytes))
}

fn sha256_text(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn history_sha256(history: &NativeGpuSwitchHistoryV1) -> String {
    let bytes = serde_json::to_vec(history).unwrap_or_default();
    hex::encode(Sha256::digest(bytes))
}

fn validate_history(history: &NativeGpuSwitchHistoryV1) -> NativeResult<()> {
    if history.schema_version != SCHEMA_VERSION
        || !matches!(
            history.terminal_state.as_str(),
            "completed" | "cancelled_pre_delete" | "denied" | "expired"
        )
        || !valid_pod_id(&history.old_pod_id)
    {
        return Err(state_error());
    }
    validate_uuid_v4(&history.switch_id, "gpu_switch_store_unrecoverable")?;
    validate_uuid_v4(&history.final_attempt_id, "gpu_switch_store_unrecoverable")?;
    if history
        .replacement_pod_id
        .as_deref()
        .is_some_and(|value| !valid_pod_id(value))
    {
        return Err(state_error());
    }
    for hash in [
        history.principal_binding_sha256.as_deref(),
        history.worker_tombstone_sha256.as_deref(),
    ] {
        if hash.is_some_and(|value| !valid_sha256(value)) {
            return Err(state_error());
        }
    }
    let local_draft =
        history.terminal_reason == NativeGpuSwitchTerminalReasonV1::LocalDraftCancelled;
    if !local_draft
        && (history.principal_binding_sha256.is_none() || history.worker_tombstone_sha256.is_none())
    {
        return Err(state_error());
    }
    validate_timestamp(&history.terminal_at)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_record(
    record: &NativeGpuSwitchRecordV1,
    issues: &[NativeGpuSwitchIssueV1],
) -> NativeResult<()> {
    if record.schema_version != SCHEMA_VERSION
        || record.record_revision == 0
        || record.record_revision > MAX_SAFE_INTEGER
        || record.old_delete_wire_attempts > 2
        || !record.authorization_required
        || record
            .actual_hourly_price_micro_usd
            .is_some_and(|price| price > MAX_SAFE_INTEGER)
    {
        return Err(state_error());
    }
    validate_uuid_v4(&record.switch_id, "gpu_switch_store_unrecoverable")?;
    validate_pod(&record.old_pod)?;
    validate_target(&record.initial_target)?;
    validate_target(&record.current_target)?;
    validate_timestamp(&record.created_at)?;
    validate_timestamp(&record.updated_at)?;
    if record.updated_at < record.created_at
        || record.initial_target.attempt_revision != 1
        || record.current_target.attempt_revision != record.prior_attempts.len() as u64 + 1
        || record.peer_pod_ids.len() > 16
        || record
            .expected_batch_id
            .as_deref()
            .is_some_and(|value| validate_uuid_v4(value, "gpu_switch_store_unrecoverable").is_err())
        || record
            .replacement_pod_id
            .as_deref()
            .is_some_and(|value| !valid_pod_id(value))
        || record.confirmed_actual_price && record.actual_hourly_price_micro_usd.is_none()
    {
        return Err(state_error());
    }
    if !record.queue_reservation.active && record.queue_reservation.queue_run_revision.is_some() {
        return Err(state_error());
    }
    let mut previous_id = None;
    for (index, attempt) in record.prior_attempts.iter().enumerate() {
        validate_target(&attempt.target)?;
        validate_timestamp(&attempt.settled_at)?;
        if attempt.target.attempt_revision != index as u64 + 1 {
            return Err(state_error());
        }
        match attempt.outcome {
            NativeGpuSwitchPriorAttemptOutcomeV1::NotCreated
                if attempt.replacement_pod_id.is_some() =>
            {
                return Err(state_error())
            }
            NativeGpuSwitchPriorAttemptOutcomeV1::FailedReplacementDeleted
                if attempt
                    .replacement_pod_id
                    .as_deref()
                    .is_none_or(|pod| !valid_pod_id(pod)) =>
            {
                return Err(state_error())
            }
            _ => {}
        }
    }
    for pod_id in &record.peer_pod_ids {
        if !valid_pod_id(pod_id)
            || previous_id
                .as_ref()
                .is_some_and(|prior: &String| prior >= pod_id)
        {
            return Err(state_error());
        }
        previous_id = Some(pod_id.clone());
    }
    if record.peer_pod_overflow && !record.peer_pod_ids.is_empty() {
        return Err(state_error());
    }
    if record.peer_pod_overflow
        && record.attention_code.as_deref() != Some("gpu_switch_peer_pod_overflow")
    {
        return Err(state_error());
    }
    if !record.peer_pod_ids.is_empty()
        && record.attention_code.as_deref() != Some("gpu_switch_peer_pod_present")
    {
        return Err(state_error());
    }
    if record.phase == NativeGpuSwitchPhaseV1::NeedsAttention {
        let Some(blocked_at) = record.blocked_at else {
            return Err(state_error());
        };
        let Some(code) = record.attention_code.as_deref() else {
            return Err(state_error());
        };
        if !blocked_at.is_blocked_phase()
            || !is_attention_code(code)
            || !attention_allowed_at(code, blocked_at)
            || !issues
                .iter()
                .any(|issue| issue.code == code && issue.retryable == is_retryable_code(code))
        {
            return Err(state_error());
        }
    } else if record.blocked_at.is_some() || record.attention_code.is_some() {
        return Err(state_error());
    }
    match &record.prepared_target {
        Some(prepared)
            if record.phase == NativeGpuSwitchPhaseV1::OldAbsent
                && prepared.prepared_from_record_revision == record.record_revision =>
        {
            validate_prepared_target(prepared)?;
        }
        Some(_) => return Err(state_error()),
        None => {}
    }
    let effective_phase = if record.phase == NativeGpuSwitchPhaseV1::NeedsAttention {
        record.blocked_at.ok_or_else(state_error)?
    } else {
        record.phase
    };
    let target_confirmation_valid = match effective_phase {
        // A never-sent local draft has no consent to refresh, so it is always
        // explicitly required. A cancelled pre-delete record can have been
        // cancelled from either the draft or consent-pending boundary.
        NativeGpuSwitchPhaseV1::Planned => {
            record.target_confirmation == NativeGpuSwitchTargetConfirmationV1::Required
        }
        NativeGpuSwitchPhaseV1::ConsentPending | NativeGpuSwitchPhaseV1::CancelledPreDelete => true,
        // Every later mutable phase was reached through native finalization;
        // that operation is legal only after the safe confirmation projection
        // becomes confirmed.
        _ => record.target_confirmation == NativeGpuSwitchTargetConfirmationV1::Confirmed,
    };
    if !target_confirmation_valid {
        return Err(state_error());
    }
    let after_delete = matches!(
        effective_phase,
        NativeGpuSwitchPhaseV1::DeleteIntent
            | NativeGpuSwitchPhaseV1::DeleteUncertain
            | NativeGpuSwitchPhaseV1::OldAbsent
            | NativeGpuSwitchPhaseV1::CreateIntent
            | NativeGpuSwitchPhaseV1::CreateUncertain
            | NativeGpuSwitchPhaseV1::ReplacementIdentified
            | NativeGpuSwitchPhaseV1::Provisioning
            | NativeGpuSwitchPhaseV1::ReplacementFailed
            | NativeGpuSwitchPhaseV1::ReplacementDeleteIntent
            | NativeGpuSwitchPhaseV1::ReplacementDeleteUncertain
            | NativeGpuSwitchPhaseV1::ReadyPaused
            | NativeGpuSwitchPhaseV1::Completed
    );
    if !after_delete && record.old_delete_wire_attempts != 0 {
        return Err(state_error());
    }
    if effective_phase == NativeGpuSwitchPhaseV1::DeleteUncertain
        && record.old_delete_wire_attempts == 0
    {
        return Err(state_error());
    }
    if matches!(
        effective_phase,
        NativeGpuSwitchPhaseV1::OldAbsent
            | NativeGpuSwitchPhaseV1::CreateIntent
            | NativeGpuSwitchPhaseV1::CreateUncertain
            | NativeGpuSwitchPhaseV1::ReplacementIdentified
            | NativeGpuSwitchPhaseV1::Provisioning
            | NativeGpuSwitchPhaseV1::ReplacementFailed
            | NativeGpuSwitchPhaseV1::ReplacementDeleteIntent
            | NativeGpuSwitchPhaseV1::ReplacementDeleteUncertain
            | NativeGpuSwitchPhaseV1::ReadyPaused
            | NativeGpuSwitchPhaseV1::Completed
    ) && record.old_delete_wire_attempts == 0
    {
        return Err(state_error());
    }
    let replacement_required = matches!(
        effective_phase,
        NativeGpuSwitchPhaseV1::ReplacementIdentified
            | NativeGpuSwitchPhaseV1::Provisioning
            | NativeGpuSwitchPhaseV1::ReplacementFailed
            | NativeGpuSwitchPhaseV1::ReplacementDeleteIntent
            | NativeGpuSwitchPhaseV1::ReplacementDeleteUncertain
            | NativeGpuSwitchPhaseV1::ReadyPaused
            | NativeGpuSwitchPhaseV1::Completed
    );
    if replacement_required != record.replacement_pod_id.is_some() {
        return Err(state_error());
    }
    if !replacement_required && record.actual_hourly_price_micro_usd.is_some() {
        return Err(state_error());
    }
    if record
        .queue_reservation
        .queue_run_revision
        .as_deref()
        .is_some_and(|value| validate_uuid_v4(value, "gpu_switch_store_unrecoverable").is_err())
    {
        return Err(state_error());
    }
    Ok(())
}

fn validate_transition(
    prior: &NativeGpuSwitchRecordV1,
    candidate: &NativeGpuSwitchRecordV1,
    issues: &[NativeGpuSwitchIssueV1],
) -> NativeResult<()> {
    validate_record(candidate, issues)?;
    if candidate.switch_id != prior.switch_id
        || candidate.old_pod != prior.old_pod
        || candidate.initial_target != prior.initial_target
        || candidate.created_at != prior.created_at
        || candidate.expected_batch_id != prior.expected_batch_id
        || candidate.queue_reservation != prior.queue_reservation
        || candidate.record_revision != next_revision(prior.record_revision)?
        || candidate.updated_at < prior.updated_at
    {
        return Err(switch_error("gpu_switch_transition_invalid"));
    }
    if candidate.prior_attempts.len() < prior.prior_attempts.len()
        || candidate.prior_attempts.len() > prior.prior_attempts.len() + 1
        || !candidate
            .prior_attempts
            .iter()
            .take(prior.prior_attempts.len())
            .eq(prior.prior_attempts.iter())
    {
        return Err(switch_error("gpu_switch_transition_invalid"));
    }
    let current_changed = candidate.current_target != prior.current_target;
    if candidate.target_confirmation != prior.target_confirmation
        && !(prior.phase == NativeGpuSwitchPhaseV1::ConsentPending
            && candidate.phase == NativeGpuSwitchPhaseV1::ConsentPending
            && prior.target_confirmation == NativeGpuSwitchTargetConfirmationV1::Required
            && candidate.target_confirmation == NativeGpuSwitchTargetConfirmationV1::Confirmed)
    {
        return Err(switch_error("gpu_switch_transition_invalid"));
    }
    if current_changed {
        let allowed_attempt_change = prior.phase == NativeGpuSwitchPhaseV1::OldAbsent
            && candidate.phase == NativeGpuSwitchPhaseV1::OldAbsent
            && prior.prepared_target.is_some()
            && candidate.prepared_target.is_none()
            && candidate.prior_attempts.len() == prior.prior_attempts.len() + 1
            && candidate
                .prior_attempts
                .last()
                .is_some_and(|attempt| attempt.target == prior.current_target);
        // Before delete intent the same approved GPU may be freshly observed
        // again. That confirmation must retain the attempt identity and price
        // while replacing only receipt/timestamp evidence; a different GPU or
        // price still requires terminal cancellation and a new switch.
        let allowed_confirmation_refresh = prior.phase == NativeGpuSwitchPhaseV1::ConsentPending
            && candidate.phase == NativeGpuSwitchPhaseV1::ConsentPending
            && prior.target_confirmation == NativeGpuSwitchTargetConfirmationV1::Required
            && candidate.target_confirmation == NativeGpuSwitchTargetConfirmationV1::Confirmed
            && candidate.prior_attempts == prior.prior_attempts
            && candidate.current_target.replacement_attempt_id
                == prior.current_target.replacement_attempt_id
            && candidate.current_target.attempt_revision == prior.current_target.attempt_revision
            && candidate.current_target.gpu_id == prior.current_target.gpu_id
            && candidate.current_target.gpu_display_name == prior.current_target.gpu_display_name
            && candidate.current_target.hourly_price_micro_usd
                == prior.current_target.hourly_price_micro_usd;
        let allowed_failed_replacement_cleanup = matches!(
            prior.phase,
            NativeGpuSwitchPhaseV1::ReplacementDeleteIntent
                | NativeGpuSwitchPhaseV1::ReplacementDeleteUncertain
        ) && candidate.phase
            == NativeGpuSwitchPhaseV1::OldAbsent
            && candidate.prepared_target.is_none()
            && candidate.prior_attempts.len() == prior.prior_attempts.len() + 1
            && candidate.prior_attempts.last().is_some_and(|attempt| {
                attempt.target == prior.current_target
                    && attempt.replacement_pod_id == prior.replacement_pod_id
                    && attempt.outcome
                        == NativeGpuSwitchPriorAttemptOutcomeV1::FailedReplacementDeleted
            })
            && candidate.current_target.attempt_revision
                == candidate.prior_attempts.len() as u64 + 1
            && candidate.current_target.replacement_attempt_id
                != prior.current_target.replacement_attempt_id
            && candidate.current_target.gpu_id == prior.current_target.gpu_id
            && candidate.current_target.gpu_display_name == prior.current_target.gpu_display_name
            && candidate.current_target.hourly_price_micro_usd
                == prior.current_target.hourly_price_micro_usd
            && candidate.current_target.observation_id == prior.current_target.observation_id
            && candidate.current_target.receipt_id == prior.current_target.receipt_id;
        // Replacement creation owns one final native inventory observation.
        // It may refresh only the receipt/timestamp evidence for the already
        // confirmed attempt while atomically committing CreateIntent.  The
        // attempt identity, GPU, and accepted price remain immutable.
        let allowed_create_evidence_refresh = prior.phase == NativeGpuSwitchPhaseV1::OldAbsent
            && candidate.phase == NativeGpuSwitchPhaseV1::CreateIntent
            && candidate.prior_attempts == prior.prior_attempts
            && candidate.prepared_target == prior.prepared_target
            && candidate.current_target.replacement_attempt_id
                == prior.current_target.replacement_attempt_id
            && candidate.current_target.attempt_revision == prior.current_target.attempt_revision
            && candidate.current_target.gpu_id == prior.current_target.gpu_id
            && candidate.current_target.gpu_display_name == prior.current_target.gpu_display_name
            && candidate.current_target.hourly_price_micro_usd
                == prior.current_target.hourly_price_micro_usd;
        if !allowed_attempt_change
            && !allowed_confirmation_refresh
            && !allowed_failed_replacement_cleanup
            && !allowed_create_evidence_refresh
        {
            return Err(switch_error("gpu_switch_transition_invalid"));
        }
    } else if candidate.prior_attempts.len() != prior.prior_attempts.len() {
        return Err(switch_error("gpu_switch_transition_invalid"));
    }
    Ok(())
}

fn validate_pod(pod: &NativeGpuSwitchPodV1) -> NativeResult<()> {
    if !valid_pod_id(&pod.pod_id)
        || !valid_gpu_identity_raw(&pod.gpu_id)
        || !valid_gpu_identity_raw(&pod.gpu_display_name)
        || pod
            .hourly_price_micro_usd
            .is_some_and(|price| price > MAX_SAFE_INTEGER)
    {
        return Err(switch_error("gpu_identity_invalid"));
    }
    Ok(())
}

fn validate_target(target: &NativeGpuSwitchTargetV1) -> NativeResult<()> {
    if target.attempt_revision == 0
        || target.attempt_revision > MAX_SAFE_INTEGER
        || target.hourly_price_micro_usd > MAX_SAFE_INTEGER
    {
        return Err(state_error());
    }
    validate_uuid_v4(
        &target.replacement_attempt_id,
        "gpu_switch_store_unrecoverable",
    )?;
    validate_uuid_v4(&target.observation_id, "gpu_switch_store_unrecoverable")?;
    validate_uuid_v4(&target.receipt_id, "gpu_switch_store_unrecoverable")?;
    if !valid_gpu_identity_raw(&target.gpu_id)
        || !valid_gpu_identity_raw(&target.gpu_display_name)
        || validate_timestamp(&target.inventory_observed_at).is_err()
        || validate_timestamp(&target.price_confirmed_at).is_err()
    {
        return Err(state_error());
    }
    Ok(())
}

fn validate_prepared_target(target: &NativeGpuSwitchPreparedTargetV1) -> NativeResult<()> {
    if target.prepared_from_record_revision == 0
        || target.prepared_from_record_revision > MAX_SAFE_INTEGER
        || target.hourly_price_micro_usd > MAX_SAFE_INTEGER
        || !valid_gpu_identity_raw(&target.gpu_id)
        || !valid_gpu_identity_raw(&target.gpu_display_name)
    {
        return Err(state_error());
    }
    for id in [&target.quote_id, &target.observation_id, &target.receipt_id] {
        validate_uuid_v4(id, "gpu_switch_store_unrecoverable")?;
    }
    validate_timestamp(&target.prepared_at)?;
    validate_timestamp(&target.expires_at)?;
    if target.expires_at <= target.prepared_at {
        return Err(state_error());
    }
    Ok(())
}

fn validate_begin_input(input: &NativeGpuSwitchBeginV1) -> NativeResult<()> {
    for value in [
        &input.observation_id,
        &input.receipt_id,
        &input.session_id,
        &input.foreground_grant_id,
    ] {
        validate_uuid_v4(value, "gpu_switch_foreground_grant_invalid")?;
    }
    if input.expected_store_revision > MAX_SAFE_INTEGER
        || input.queue_expected_store_revision > MAX_SAFE_INTEGER
        || input.confirmed_hourly_price_micro_usd > MAX_SAFE_INTEGER
    {
        return Err(switch_error("gpu_switch_revision_exhausted"));
    }
    validate_gpu_identity(&input.target_gpu_id)?;
    if input.queue_run_revision.as_deref().is_some_and(|value| {
        validate_uuid_v4(value, "gpu_switch_queue_reservation_conflict").is_err()
    }) {
        return Err(switch_error("gpu_switch_queue_reservation_conflict"));
    }
    Ok(())
}

fn validate_prepare_input(input: &NativeGpuSwitchPrepareTargetV1) -> NativeResult<()> {
    validate_revision_key(&input.switch_id, input.expected_record_revision)?;
    for value in [&input.observation_id, &input.receipt_id] {
        validate_uuid_v4(value, "gpu_switch_inventory_receipt_invalid")?;
    }
    if input.confirmed_hourly_price_micro_usd > MAX_SAFE_INTEGER {
        return Err(switch_error("gpu_switch_price_changed"));
    }
    validate_gpu_identity(&input.target_gpu_id)
}

fn validate_confirm_attempt_input(input: &NativeGpuSwitchConfirmAttemptV1) -> NativeResult<()> {
    validate_prepare_input(&NativeGpuSwitchPrepareTargetV1 {
        switch_id: input.switch_id.clone(),
        expected_record_revision: input.expected_record_revision,
        observation_id: input.observation_id.clone(),
        receipt_id: input.receipt_id.clone(),
        target_gpu_id: input.target_gpu_id.clone(),
        confirmed_hourly_price_micro_usd: input.confirmed_hourly_price_micro_usd,
    })?;
    validate_uuid_v4(&input.quote_id, "gpu_switch_quote_invalid")
}

fn validate_revision_key(switch_id: &str, revision: u64) -> NativeResult<()> {
    validate_uuid_v4(switch_id, "gpu_switch_not_found")?;
    if revision == 0 || revision > MAX_SAFE_INTEGER {
        return Err(switch_error("gpu_switch_revision_conflict"));
    }
    Ok(())
}

fn validate_gpu_identity(value: &str) -> NativeResult<()> {
    if valid_gpu_identity_raw(value) {
        Ok(())
    } else {
        Err(switch_error("gpu_identity_invalid"))
    }
}

fn valid_gpu_identity_raw(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=128).contains(&bytes.len())
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.iter().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(*byte, b' ' | b'.' | b'_' | b'(' | b')' | b'+' | b':' | b'-')
        })
}

fn valid_pod_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 1
        && bytes.len() <= 58
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
}

fn validate_uuid_v4(value: &str, code: &'static str) -> NativeResult<()> {
    let parsed = Uuid::parse_str(value).map_err(|_| switch_error(code))?;
    if parsed.get_version() != Some(Version::Random) || parsed.hyphenated().to_string() != value {
        return Err(switch_error(code));
    }
    Ok(())
}

fn validate_timestamp(value: &str) -> NativeResult<()> {
    let bytes = value.as_bytes();
    if bytes.len() != 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
        || ![0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22]
            .into_iter()
            .all(|index| bytes[index].is_ascii_digit())
    {
        return Err(state_error());
    }
    Ok(())
}

fn next_revision(value: u64) -> NativeResult<u64> {
    value
        .checked_add(1)
        .filter(|next| *next <= MAX_SAFE_INTEGER)
        .ok_or_else(|| switch_error("gpu_switch_revision_exhausted"))
}

fn ensure_writable(inner: &SwitchInner) -> NativeResult<()> {
    if inner.unrecoverable {
        Err(switch_error("gpu_switch_store_unrecoverable"))
    } else {
        Ok(())
    }
}

fn exact_record<'a>(
    inner: &'a SwitchInner,
    switch_id: &str,
) -> NativeResult<&'a NativeGpuSwitchRecordV1> {
    inner
        .generation
        .record
        .as_ref()
        .filter(|record| record.switch_id == switch_id)
        .ok_or_else(|| switch_error("gpu_switch_not_found"))
}

fn ensure_held(inner: &SwitchInner, switch_id: &str) -> NativeResult<()> {
    match inner.held_lease.as_deref() {
        Some(held) if held == switch_id => Ok(()),
        Some(_) => Err(switch_error("gpu_switch_lease_busy")),
        None => Err(switch_error("gpu_switch_lease_required")),
    }
}

fn consume_begin_grant(
    inner: &mut SwitchInner,
    grant_id: &str,
    observation_id: &str,
    target_gpu_id: &str,
) -> NativeResult<()> {
    let Some(grant) = inner.grants.remove(grant_id) else {
        return Err(switch_error("gpu_switch_foreground_grant_required"));
    };
    if grant.issued_at.elapsed() >= FOREGROUND_GRANT_TTL {
        return Err(switch_error("gpu_switch_foreground_grant_expired"));
    }
    match grant.binding {
        ForegroundGrantBinding::Begin {
            observation_id: expected_observation,
            target_gpu_id: expected_target,
        } if expected_observation == observation_id && expected_target == target_gpu_id => Ok(()),
        ForegroundGrantBinding::Begin { .. } | ForegroundGrantBinding::Resume { .. } => {
            Err(switch_error("gpu_switch_foreground_grant_invalid"))
        }
    }
}

fn consume_resume_grant(
    inner: &mut SwitchInner,
    grant_id: &str,
    switch_id: &str,
) -> NativeResult<()> {
    let Some(grant) = inner.grants.remove(grant_id) else {
        return Err(switch_error("gpu_switch_foreground_grant_required"));
    };
    if grant.issued_at.elapsed() >= FOREGROUND_GRANT_TTL {
        return Err(switch_error("gpu_switch_foreground_grant_expired"));
    }
    match grant.binding {
        ForegroundGrantBinding::Resume {
            switch_id: expected,
        } if expected == switch_id => Ok(()),
        ForegroundGrantBinding::Begin { .. } | ForegroundGrantBinding::Resume { .. } => {
            Err(switch_error("gpu_switch_foreground_grant_invalid"))
        }
    }
}

fn read_current(path: &Path) -> std::io::Result<Option<u64>> {
    let bytes = match read_limited(path, 64) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let raw = std::str::from_utf8(&bytes)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "CURRENT utf8"))?;
    let digits = raw
        .strip_suffix('\n')
        .filter(|candidate| !candidate.is_empty() && !candidate.starts_with('0'))
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "CURRENT shape"))?;
    let revision = digits
        .parse::<u64>()
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "CURRENT number"))?;
    if revision == 0 || revision > MAX_SAFE_INTEGER || format!("{revision}\n") != raw {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "CURRENT canonical",
        ));
    }
    Ok(Some(revision))
}

fn write_current(path: &Path, revision: u64) -> std::io::Result<()> {
    write_replace_atomic(path, format!("{revision}\n").as_bytes())
}

fn read_limited(path: &Path, maximum: u64) -> std::io::Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() == 0
        || metadata.len() > maximum
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "unsafe switch journal",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)?
        .take(maximum + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 != metadata.len() || bytes.len() as u64 > maximum {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "short switch journal read",
        ));
    }
    Ok(bytes)
}

fn ensure_directory(path: &Path) -> NativeResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(state_error())
        }
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(state_error()),
    }
    fs::create_dir_all(path).map_err(|_| state_error())?;
    let metadata = fs::symlink_metadata(path).map_err(|_| state_error())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(state_error());
    }
    if let Some(parent) = path.parent() {
        sync_directory(parent).map_err(|_| state_error())?;
    }
    Ok(())
}

fn write_immutable(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "missing parent"))?;
    ensure_directory(parent)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "unsafe parent"))?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("generation"),
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
        #[cfg(unix)]
        {
            fs::hard_link(&temporary, path)?;
            fs::remove_file(&temporary)?;
        }
        #[cfg(not(unix))]
        {
            if path.exists() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "generation exists",
                ));
            }
            fs::rename(&temporary, path)?;
        }
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn write_replace_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "missing parent"))?;
    ensure_directory(parent)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "unsafe parent"))?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("CURRENT"),
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
        let _ = fs::remove_file(temporary);
    }
    result
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

pub(crate) fn default_switch_root() -> NativeResult<PathBuf> {
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|path| path.join("Library").join("Application Support"));
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base = Some(std::env::temp_dir());
    base.map(|path| {
        path.join("com.imageforge.desktop")
            .join("gpu-switch")
            .join("v1")
    })
    .ok_or_else(state_error)
}

fn utc_now() -> NativeResult<String> {
    utc_from(SystemTime::now())
}

fn utc_after(duration: Duration) -> NativeResult<String> {
    let now = SystemTime::now()
        .checked_add(duration)
        .ok_or_else(state_error)?;
    utc_from(now)
}

fn utc_from(time: SystemTime) -> NativeResult<String> {
    let millis = time
        .duration_since(UNIX_EPOCH)
        .map_err(|_| state_error())?
        .as_millis();
    let seconds = (millis / 1_000) as i64;
    let milliseconds = millis % 1_000;
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    if !(1..=9999).contains(&year) {
        return Err(state_error());
    }
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{milliseconds:03}Z",
        seconds_of_day / 3_600,
        (seconds_of_day % 3_600) / 60,
        seconds_of_day % 60,
    ))
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    (year + if month <= 2 { 1 } else { 0 }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::queue::{
        NativePowerInput, NativeQueueAlarmV1, NativeQueueCommitV1, NativeQueueDocumentV1,
        NativeQueueItemV1, NativeQueueRowV1, NativeQueueRunV1, NativeRunKey,
        NotificationDisposition, QueueAlarmState, QueueItemState, QueueRunnerState, QueueStore,
    };
    use crate::native::DestinationStore;

    const PROCESS: &str = "00000000-0000-4000-8000-000000000001";
    const OBSERVATION: &str = "00000000-0000-4000-8000-000000000002";
    const RECEIPT: &str = "00000000-0000-4000-8000-000000000003";
    const SESSION: &str = "00000000-0000-4000-8000-000000000004";
    const QUEUE_RUN: &str = "00000000-0000-4000-8000-000000000005";

    fn service() -> (tempfile::TempDir, GpuSwitchService) {
        let directory = tempfile::tempdir().expect("temporary switch root");
        let service =
            GpuSwitchService::with_root(PROCESS.to_owned(), directory.path().join("gpu-switch"))
                .expect("switch service");
        (directory, service)
    }

    fn evidence() -> NativeGpuSwitchSelectionEvidenceV1 {
        NativeGpuSwitchSelectionEvidenceV1 {
            old_pod: NativeGpuSwitchPodV1 {
                pod_id: "old-pod-1".to_owned(),
                gpu_id: "NVIDIA GeForce RTX 4090".to_owned(),
                gpu_display_name: "RTX 4090".to_owned(),
                hourly_price_micro_usd: Some(500_000),
            },
            target_gpu_display_name: "RTX 5090".to_owned(),
            inventory_observed_at: "2026-08-04T00:00:00.000Z".to_owned(),
            inventory_catalog_sha256:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_owned(),
        }
    }

    fn provider_create_intent(label: &str) -> NativeGpuSwitchProviderCreateIntentV1 {
        NativeGpuSwitchProviderCreateIntentV1 {
            create_marker_sha256: sha256_text(&format!("{label} marker")),
            create_intent_sha256: sha256_text(&format!("{label} intent")),
            create_wire_body_sha256: sha256_text(&format!("{label} wire")),
            observation_id: "00000000-0000-4000-8000-000000000010".to_owned(),
            receipt_id: "00000000-0000-4000-8000-000000000011".to_owned(),
            inventory_observed_at: "2026-08-04T00:01:00.000Z".to_owned(),
        }
    }

    fn begin_grant(service: &GpuSwitchService) -> NativeGpuSwitchForegroundGrantV1 {
        service
            .authorize_foreground(NativeGpuSwitchForegroundGrantRequestV1::Begin(
                NativeGpuSwitchBeginGrantRequestV1 {
                    action: NativeGpuSwitchBeginGrantActionV1::Begin,
                    switch_id: RequiredJsonNull,
                    observation_id: OBSERVATION.to_owned(),
                    target_gpu_id: "NVIDIA GeForce RTX 5090".to_owned(),
                },
            ))
            .expect("begin foreground grant")
    }

    fn begin(service: &GpuSwitchService) -> NativeGpuSwitchSnapshotV1 {
        let grant = begin_grant(service);
        service
            .begin(
                NativeGpuSwitchBeginV1 {
                    observation_id: OBSERVATION.to_owned(),
                    receipt_id: RECEIPT.to_owned(),
                    target_gpu_id: "NVIDIA GeForce RTX 5090".to_owned(),
                    confirmed_hourly_price_micro_usd: 700_000,
                    expected_store_revision: 0,
                    session_id: SESSION.to_owned(),
                    queue_expected_store_revision: 0,
                    queue_run_revision: Some(QUEUE_RUN.to_owned()),
                    foreground_grant_id: grant.grant_id,
                },
                evidence(),
            )
            .expect("begin switch")
    }

    fn queue_item(destination: String) -> NativeQueueItemV1 {
        NativeQueueItemV1 {
            schema_version: 1,
            queue_item_id: Uuid::new_v4().to_string(),
            client_submission_id: Uuid::new_v4().to_string(),
            record_revision: 0,
            run_revision: None,
            remote_batch_id: None,
            state: QueueItemState::Staged,
            attention_code: None,
            name: "Switch crash seam".to_owned(),
            prompts: vec!["durable queue park".to_owned()],
            base_seed: 42,
            destination,
            aspect_ratio: "16:9".to_owned(),
            style_suffix: None,
            references: vec![],
            created_at: "2026-08-04T00:00:00.000Z".to_owned(),
            updated_at: "2026-08-04T00:00:00.000Z".to_owned(),
        }
    }

    #[test]
    fn begin_binds_the_post_park_queue_revision_before_active_reservation() {
        let (_directory, service) = service();
        let grant = begin_grant(&service);
        let snapshot = service
            .begin_with_queue_park(
                NativeGpuSwitchBeginV1 {
                    observation_id: OBSERVATION.to_owned(),
                    receipt_id: RECEIPT.to_owned(),
                    target_gpu_id: "NVIDIA GeForce RTX 5090".to_owned(),
                    confirmed_hourly_price_micro_usd: 700_000,
                    expected_store_revision: 0,
                    session_id: SESSION.to_owned(),
                    queue_expected_store_revision: 7,
                    queue_run_revision: Some(QUEUE_RUN.to_owned()),
                    foreground_grant_id: grant.grant_id,
                },
                evidence(),
                |expected_revision, run_revision| {
                    assert_eq!(expected_revision, 7);
                    assert_eq!(run_revision, Some(QUEUE_RUN));
                    Ok(8)
                },
            )
            .expect("begin after queue park");
        assert_eq!(record(&snapshot).phase, NativeGpuSwitchPhaseV1::Planned);
        let reservation = service
            .journal
            .read_reservation()
            .expect("reservation read")
            .expect("active reservation");
        assert_eq!(
            reservation.phase,
            PrivateGpuSwitchQueueReservationPhaseV1::Active
        );
        assert_eq!(reservation.queue_store_revision, 8);
        assert_eq!(reservation.queue_run_revision.as_deref(), Some(QUEUE_RUN));
        assert_eq!(
            snapshot
                .record
                .as_ref()
                .and_then(|record| record.queue_reservation.queue_run_revision.as_deref()),
            Some(QUEUE_RUN)
        );
    }

    #[test]
    fn next_run_commit_after_park_does_not_rebind_the_active_reservation_revision() {
        let directory = tempfile::tempdir().expect("temporary coordinated roots");
        let downloads = directory.path().join("downloads");
        fs::create_dir(&downloads).expect("test destination");
        let destination = DestinationStore::new_for_test(directory.path().join("destination.json"));
        let destination_path = destination
            .validate_and_bind(&downloads)
            .expect("bind test destination")
            .path;
        let queue = QueueStore::new_for_test(directory.path().join("queue/v1"), destination);
        let staged = queue
            .commit(NativeQueueCommitV1 {
                expected_revision: 0,
                document: NativeQueueDocumentV1 {
                    schema_version: 1,
                    items: vec![NativeQueueRowV1::Item(queue_item(destination_path.clone()))],
                    run: None,
                    alarm: None,
                },
                reference_blobs: vec![],
            })
            .expect("stage first Next-run item");
        let service = GpuSwitchService::new_for_test(directory.path().join("gpu-switch"))
            .expect("switch service");
        let grant = begin_grant(&service);
        let snapshot = service
            .begin_with_queue_park(
                NativeGpuSwitchBeginV1 {
                    observation_id: OBSERVATION.to_owned(),
                    receipt_id: RECEIPT.to_owned(),
                    target_gpu_id: "NVIDIA GeForce RTX 5090".to_owned(),
                    confirmed_hourly_price_micro_usd: 700_000,
                    expected_store_revision: 0,
                    session_id: SESSION.to_owned(),
                    queue_expected_store_revision: staged.store_revision,
                    queue_run_revision: None,
                    foreground_grant_id: grant.grant_id,
                },
                evidence(),
                |expected_revision, requested_run| {
                    assert!(requested_run.is_none());
                    let parked = queue.park_for_gpu_switch(expected_revision, requested_run)?;
                    assert_eq!(parked, expected_revision);
                    let mut next_document = staged.document.clone();
                    next_document
                        .items
                        .push(NativeQueueRowV1::Item(queue_item(destination_path)));
                    let after_staging = queue.commit_next_run_only(NativeQueueCommitV1 {
                        expected_revision: parked,
                        document: next_document,
                        reference_blobs: vec![],
                    })?;
                    assert_eq!(after_staging.store_revision, parked + 1);
                    // The reservation binds the exact park generation, not an
                    // unrelated later Next-run-only queue generation.
                    Ok(parked)
                },
            )
            .expect("begin with an interleaved Next-run edit");
        assert_eq!(record(&snapshot).phase, NativeGpuSwitchPhaseV1::Planned);
        let reservation = service
            .journal
            .read_reservation()
            .expect("read reservation")
            .expect("active reservation");
        assert_eq!(
            reservation.phase,
            PrivateGpuSwitchQueueReservationPhaseV1::Active
        );
        assert_eq!(reservation.queue_store_revision, staged.store_revision);
        assert_eq!(
            queue.load().unwrap().store_revision,
            staged.store_revision + 1
        );
    }

    #[test]
    fn crash_after_prepared_before_queue_park_restarts_as_a_durable_queue_blocker() {
        let (directory, service) = service();
        let root = service.journal.root.clone();
        let grant = begin_grant(&service);
        let result = service.begin_with_queue_park(
            NativeGpuSwitchBeginV1 {
                observation_id: OBSERVATION.to_owned(),
                receipt_id: RECEIPT.to_owned(),
                target_gpu_id: "NVIDIA GeForce RTX 5090".to_owned(),
                confirmed_hourly_price_micro_usd: 700_000,
                expected_store_revision: 0,
                session_id: SESSION.to_owned(),
                queue_expected_store_revision: 7,
                queue_run_revision: Some(QUEUE_RUN.to_owned()),
                foreground_grant_id: grant.grant_id,
            },
            evidence(),
            |expected_revision, run_revision| {
                assert_eq!(expected_revision, 7);
                assert_eq!(run_revision, Some(QUEUE_RUN));
                let reservation = service
                    .journal
                    .read_reservation()?
                    .ok_or_else(state_error)?;
                assert_eq!(
                    reservation.phase,
                    PrivateGpuSwitchQueueReservationPhaseV1::Prepared
                );
                assert_eq!(reservation.queue_store_revision, 7);
                Err(switch_error("gpu_switch_queue_reservation_conflict"))
            },
        );
        assert_eq!(
            result.unwrap_err().code,
            "gpu_switch_queue_reservation_conflict"
        );
        assert!(service.journal.generation_ids().unwrap().is_empty());
        assert!(!service.journal.current_path().exists());
        assert_eq!(
            service.journal.read_reservation().unwrap().unwrap().phase,
            PrivateGpuSwitchQueueReservationPhaseV1::Prepared
        );

        drop(service);
        let restarted = GpuSwitchService::with_root(PROCESS.to_owned(), root)
            .expect("restart preserves the prepared blocker");
        let snapshot = restarted.load().expect("fail-closed projection");
        assert!(snapshot.record.is_none());
        assert!(snapshot
            .issues
            .iter()
            .any(|issue| issue.code == "gpu_switch_store_unrecoverable"));
        assert_eq!(
            restarted.veto_queue_action_from_disk().unwrap_err().code,
            "queue_gpu_switch_pending"
        );
        assert_eq!(
            restarted
                .authorize_foreground(NativeGpuSwitchForegroundGrantRequestV1::Resume(
                    NativeGpuSwitchResumeGrantRequestV1 {
                        action: NativeGpuSwitchResumeGrantActionV1::Resume,
                        switch_id: "00000000-0000-4000-8000-000000000099".to_owned(),
                        observation_id: RequiredJsonNull,
                        target_gpu_id: RequiredJsonNull,
                    },
                ))
                .unwrap_err()
                .code,
            "gpu_switch_store_unrecoverable"
        );
        drop(directory);
    }

    #[test]
    fn crash_after_queue_park_before_planned_keeps_paused_queue_and_prepared_blocker() {
        let directory = tempfile::tempdir().expect("temporary coordinated roots");
        let downloads = directory.path().join("downloads");
        fs::create_dir(&downloads).expect("test destination");
        let destination = DestinationStore::new_for_test(directory.path().join("destination.json"));
        let destination_path = destination
            .validate_and_bind(&downloads)
            .expect("bind test destination")
            .path;
        let queue = QueueStore::new_for_test(directory.path().join("queue/v1"), destination);
        let staged = queue
            .commit(NativeQueueCommitV1 {
                expected_revision: 0,
                document: NativeQueueDocumentV1 {
                    schema_version: 1,
                    items: vec![NativeQueueRowV1::Item(queue_item(destination_path))],
                    run: None,
                    alarm: None,
                },
                reference_blobs: vec![],
            })
            .expect("stage queue item");
        let run_revision = Uuid::new_v4().to_string();
        let mut document = staged.document.clone();
        let NativeQueueRowV1::Item(item) = &mut document.items[0] else {
            panic!("queue item")
        };
        item.record_revision += 1;
        item.run_revision = Some(run_revision.clone());
        let queue_item_id = item.queue_item_id.clone();
        document.run = Some(NativeQueueRunV1 {
            run_revision: run_revision.clone(),
            cohort_item_ids: vec![queue_item_id],
            runner_state: QueueRunnerState::Paused,
            authorization_required: true,
            keep_awake: true,
        });
        document.alarm = Some(NativeQueueAlarmV1 {
            event_id: format!("queue-complete:{run_revision}"),
            run_revision: run_revision.clone(),
            state: QueueAlarmState::Armed,
            kind: None,
            snooze_used: false,
            snooze_due_at: None,
            notification_disposition: None::<NotificationDisposition>,
            snooze_notification_disposition: None::<NotificationDisposition>,
        });
        let mut running = queue
            .commit(NativeQueueCommitV1 {
                expected_revision: staged.store_revision,
                document,
                reference_blobs: vec![],
            })
            .expect("create paused queue run");
        queue
            .acquire_runner(NativeRunKey {
                run_revision: run_revision.clone(),
            })
            .expect("acquire queue runner");
        running.document.run.as_mut().unwrap().runner_state = QueueRunnerState::Running;
        running
            .document
            .run
            .as_mut()
            .unwrap()
            .authorization_required = false;
        running = queue
            .commit(NativeQueueCommitV1 {
                expected_revision: running.store_revision,
                document: running.document,
                reference_blobs: vec![],
            })
            .expect("commit running queue");
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        queue
            .set_sleep_prevention(NativePowerInput {
                run_revision: run_revision.clone(),
                enabled: true,
            })
            .expect("enable test keep-awake");

        let switch_root = directory.path().join("gpu-switch");
        let service = GpuSwitchService::new_for_test(switch_root.clone()).expect("switch service");
        let grant = begin_grant(&service);
        let error = service
            .begin_with_queue_park(
                NativeGpuSwitchBeginV1 {
                    observation_id: OBSERVATION.to_owned(),
                    receipt_id: RECEIPT.to_owned(),
                    target_gpu_id: "NVIDIA GeForce RTX 5090".to_owned(),
                    confirmed_hourly_price_micro_usd: 700_000,
                    expected_store_revision: 0,
                    session_id: SESSION.to_owned(),
                    queue_expected_store_revision: running.store_revision,
                    queue_run_revision: Some(run_revision.clone()),
                    foreground_grant_id: grant.grant_id,
                },
                evidence(),
                |expected_revision, requested_run| {
                    let parked = queue.park_for_gpu_switch(expected_revision, requested_run)?;
                    assert_eq!(parked, expected_revision + 1);
                    Err(switch_error("gpu_switch_queue_reservation_conflict"))
                },
            )
            .expect_err("simulate process loss after the queue park");
        assert_eq!(error.code, "gpu_switch_queue_reservation_conflict");

        let parked = queue.load().expect("load durably parked queue");
        let run = parked.document.run.as_ref().expect("parked run remains");
        assert_eq!(run.runner_state, QueueRunnerState::Paused);
        assert!(run.authorization_required);
        assert!(!queue.holds_runner_for_test(&run_revision));
        assert!(!queue.power_active_for_test());

        drop(service);
        let restarted = GpuSwitchService::new_for_test(switch_root).expect("restart switch store");
        assert_eq!(
            restarted
                .veto_queue_action_from_disk()
                .expect_err("prepared reservation remains a queue blocker")
                .code,
            "queue_gpu_switch_pending"
        );
    }

    fn record(snapshot: &NativeGpuSwitchSnapshotV1) -> &NativeGpuSwitchRecordV1 {
        snapshot.record.as_ref().expect("active record")
    }

    fn test_worker_binding() -> NativeGpuSwitchWorkerBindingV1 {
        NativeGpuSwitchWorkerBindingV1 {
            requester_user_id: "lakshman".to_owned(),
            principal_binding_id: "00000000-0000-4000-8000-000000000008".to_owned(),
        }
    }

    fn test_worker_intent(record: &NativeGpuSwitchRecordV1) -> NativeGpuSwitchWorkerCreateIntentV1 {
        let canonical_body = crate::native::gpu_inventory::jcs_value(&serde_json::json!({
            "schema_version": 1,
            "switch_id": record.switch_id.clone(),
            "session_id": SESSION,
            "old_pod_id": record.old_pod.pod_id.clone(),
            "old_gpu_id": record.old_pod.gpu_id.clone(),
            "old_gpu_display_name": record.old_pod.gpu_display_name.clone(),
            "initial_target_gpu_id": record.initial_target.gpu_id.clone(),
            "initial_target_gpu_display_name": record.initial_target.gpu_display_name.clone(),
            "initial_replacement_attempt_id": record.initial_target.replacement_attempt_id.clone(),
            "expected_batch_id": record.expected_batch_id.clone(),
            "inventory_observed_at": record.initial_target.inventory_observed_at.clone(),
        }))
        .expect("canonical worker body");
        NativeGpuSwitchWorkerCreateIntentV1 {
            profile_binding_sha256: sha256_text("test profile binding"),
            credential_binding_sha256: sha256_text("test credential binding"),
            worker_session_binding_sha256: sha256_text("test session binding"),
            canonical_body_sha256: sha256_text(&canonical_body),
            canonical_body,
        }
    }

    fn persist_test_worker_send_pending(
        service: &GpuSwitchService,
        snapshot: &NativeGpuSwitchSnapshotV1,
    ) -> NativeGpuSwitchSnapshotV1 {
        let active = record(snapshot);
        service
            .prepare_worker_create_send_pending(
                &active.switch_id,
                active.record_revision,
                test_worker_intent(active),
            )
            .expect("persist worker create send-pending")
    }

    fn persist_test_worker_sent_uncertain(
        service: &GpuSwitchService,
        snapshot: &NativeGpuSwitchSnapshotV1,
    ) -> NativeGpuSwitchSnapshotV1 {
        let pending = persist_test_worker_send_pending(service, snapshot);
        let active = record(&pending);
        service
            .mark_worker_create_sent_uncertain(&active.switch_id, active.record_revision)
            .expect("persist worker create sent-uncertain")
    }

    fn bind_test_worker(
        service: &GpuSwitchService,
        snapshot: &NativeGpuSwitchSnapshotV1,
    ) -> NativeGpuSwitchSnapshotV1 {
        let sent = persist_test_worker_sent_uncertain(service, snapshot);
        let active = record(&sent);
        service
            .bind_worker_create_response(
                &active.switch_id,
                active.record_revision,
                test_worker_binding(),
            )
            .expect("bind test worker response")
    }

    fn bind_and_confirm_test_worker(
        service: &GpuSwitchService,
        snapshot: &NativeGpuSwitchSnapshotV1,
    ) -> NativeGpuSwitchSnapshotV1 {
        let bound = bind_test_worker(service, snapshot);
        let active = record(&bound).clone();
        service
            .confirm_current_target(
                NativeGpuSwitchPrepareTargetV1 {
                    switch_id: active.switch_id,
                    expected_record_revision: active.record_revision,
                    observation_id: "00000000-0000-4000-8000-000000000015".to_owned(),
                    receipt_id: "00000000-0000-4000-8000-000000000016".to_owned(),
                    target_gpu_id: active.current_target.gpu_id.clone(),
                    confirmed_hourly_price_micro_usd: active.current_target.hourly_price_micro_usd,
                },
                active.current_target.gpu_display_name,
                "2026-08-04T00:03:00.000Z".to_owned(),
            )
            .expect("confirm test target")
    }

    fn advance_bound_switch_to_old_absent(
        service: &GpuSwitchService,
        snapshot: &NativeGpuSwitchSnapshotV1,
    ) -> NativeGpuSwitchSnapshotV1 {
        let bound = bind_and_confirm_test_worker(service, snapshot);
        let switch_id = record(&bound).switch_id.clone();
        let pausing = service
            .advance_with_proof(
                &switch_id,
                record(&bound).record_revision,
                NativeGpuSwitchPhaseV1::Pausing,
            )
            .expect("pause old worker");
        let ready = service
            .advance_with_proof(
                &switch_id,
                record(&pausing).record_revision,
                NativeGpuSwitchPhaseV1::ReadyToDelete,
            )
            .expect("old worker ready to delete");
        let intent = service
            .advance_with_proof(
                &switch_id,
                record(&ready).record_revision,
                NativeGpuSwitchPhaseV1::DeleteIntent,
            )
            .expect("persist old delete intent");
        let wire = service
            .prepare_old_delete_wire_attempt(&switch_id, record(&intent).record_revision)
            .expect("persist old delete wire attempt");
        service
            .advance_with_proof(
                &switch_id,
                record(&wire).record_revision,
                NativeGpuSwitchPhaseV1::OldAbsent,
            )
            .expect("old pod absent")
    }

    fn advance_bound_switch_to_provisioning(
        service: &GpuSwitchService,
        snapshot: &NativeGpuSwitchSnapshotV1,
    ) -> NativeGpuSwitchSnapshotV1 {
        let old_absent = advance_bound_switch_to_old_absent(service, snapshot);
        let switch_id = record(&old_absent).switch_id.clone();
        let intent = service
            .prepare_replacement_create(
                &switch_id,
                record(&old_absent).record_revision,
                provider_create_intent("verified runtime replacement"),
            )
            .expect("persist replacement create intent");
        let identified = service
            .record_replacement_identified(
                &switch_id,
                record(&intent).record_revision,
                "replacement-pod-runtime".to_owned(),
                record(&intent).current_target.gpu_id.clone(),
                Some(record(&intent).current_target.hourly_price_micro_usd),
                sha256_text("verified runtime provider response"),
            )
            .expect("bind replacement Pod");
        service
            .confirm_actual_price(NativeGpuSwitchActualPriceV1 {
                switch_id,
                expected_record_revision: record(&identified).record_revision,
                confirmed_actual_hourly_price_micro_usd: record(&identified)
                    .actual_hourly_price_micro_usd
                    .expect("actual replacement price"),
            })
            .expect("confirm replacement price")
    }

    #[derive(Clone)]
    enum FakeWorkerPost {
        Created(NativeGpuSwitchWorkerBindingV1),
        ResponseLost,
    }

    struct FakeWorkerCreateTransport {
        post: FakeWorkerPost,
        owner_lookup: Option<NativeGpuSwitchWorkerBindingV1>,
        post_calls: usize,
        owner_lookup_calls: usize,
        sent_bodies: Vec<String>,
    }

    impl FakeWorkerCreateTransport {
        fn post_once(
            &mut self,
            canonical_body: &str,
        ) -> Result<NativeGpuSwitchWorkerBindingV1, ()> {
            self.post_calls += 1;
            self.sent_bodies.push(canonical_body.to_owned());
            match self.post.clone() {
                FakeWorkerPost::Created(binding) => Ok(binding),
                FakeWorkerPost::ResponseLost => Err(()),
            }
        }

        fn owner_lookup(&mut self) -> Option<NativeGpuSwitchWorkerBindingV1> {
            self.owner_lookup_calls += 1;
            self.owner_lookup.clone()
        }
    }

    /// A small test-only mirror of the production command's transport order:
    /// persist canonical body, persist sent-uncertain, issue one POST, then
    /// use a single owner lookup on loss. It intentionally has no retry path.
    fn run_fake_worker_create_saga(
        service: &GpuSwitchService,
        snapshot: &NativeGpuSwitchSnapshotV1,
        transport: &mut FakeWorkerCreateTransport,
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        let sent = persist_test_worker_sent_uncertain(service, snapshot);
        let active = record(&sent);
        let canonical_body = service
            .inner
            .lock()
            .map_err(|_| state_error())?
            .generation
            .private
            .worker_create_body
            .clone()
            .ok_or_else(state_error)?;
        match transport.post_once(&canonical_body) {
            Ok(binding) => service.bind_worker_create_response(
                &active.switch_id,
                active.record_revision,
                binding,
            ),
            Err(()) => match transport.owner_lookup() {
                Some(binding) => service.bind_or_validate_worker_owner(
                    &active.switch_id,
                    active.record_revision,
                    binding,
                ),
                None => service.park_with_attention(
                    &active.switch_id,
                    active.record_revision,
                    "gpu_switch_worker_create_uncertain",
                ),
            },
        }
    }

    fn resume_fake_sent_uncertain_create(
        service: &GpuSwitchService,
        snapshot: &NativeGpuSwitchSnapshotV1,
        transport: &mut FakeWorkerCreateTransport,
        mutate_replay_intent: impl FnOnce(&mut NativeGpuSwitchWorkerCreateIntentV1),
    ) -> NativeResult<NativeGpuSwitchSnapshotV1> {
        let sent = persist_test_worker_sent_uncertain(service, snapshot);
        let sent_record = record(&sent).clone();
        let parked = service.park_with_attention(
            &sent_record.switch_id,
            sent_record.record_revision,
            "gpu_switch_worker_create_uncertain",
        )?;
        assert!(record(&parked).authorization_required);
        assert!(service.sent_uncertain_resume_replay_allowed(&sent_record.switch_id)?);
        let grant = service.authorize_foreground(
            NativeGpuSwitchForegroundGrantRequestV1::Resume(NativeGpuSwitchResumeGrantRequestV1 {
                action: NativeGpuSwitchResumeGrantActionV1::Resume,
                switch_id: sent_record.switch_id.clone(),
                observation_id: RequiredJsonNull,
                target_gpu_id: RequiredJsonNull,
            }),
        )?;
        let lease = service.acquire(NativeGpuSwitchAcquireV1 {
            switch_id: sent_record.switch_id.clone(),
            foreground_grant_id: grant.grant_id,
        })?;
        assert!(lease.held);
        let access = service
            .sent_uncertain_create_access(&sent_record.switch_id)?
            .ok_or_else(state_error)?;

        if let Some(binding) = transport.owner_lookup() {
            return service.bind_or_validate_worker_owner(
                &access.switch_id,
                access.record_revision,
                binding,
            );
        }

        let current = service.load()?;
        let mut replay_intent = test_worker_intent(record(&current));
        mutate_replay_intent(&mut replay_intent);
        service.validate_uncertain_create_replay(&access, &replay_intent)?;
        match transport.post_once(&replay_intent.canonical_body) {
            Ok(binding) => service.bind_or_validate_worker_owner(
                &access.switch_id,
                access.record_revision,
                binding,
            ),
            Err(()) => {
                if let Some(binding) = transport.owner_lookup() {
                    service.bind_or_validate_worker_owner(
                        &access.switch_id,
                        access.record_revision,
                        binding,
                    )
                } else {
                    service.park_with_attention(
                        &access.switch_id,
                        access.record_revision,
                        "gpu_switch_worker_response_invalid",
                    )
                }
            }
        }
    }

    #[test]
    fn strict_discriminated_grant_and_command_inputs_reject_unknown_or_missing_nulls() {
        let unknown = serde_json::from_str::<NativeGpuSwitchBeginV1>(&format!(
            r#"{{"observationId":"{OBSERVATION}","receiptId":"{RECEIPT}","targetGpuId":"NVIDIA GeForce RTX 5090","confirmedHourlyPriceMicroUsd":1,"expectedStoreRevision":0,"sessionId":"{SESSION}","queueExpectedStoreRevision":0,"queueRunRevision":null,"foregroundGrantId":"{PROCESS}","extra":true}}"#
        ));
        assert!(unknown.is_err());
        let malformed_resume = serde_json::from_str::<NativeGpuSwitchForegroundGrantRequestV1>(
            &format!(r#"{{"action":"resume","switchId":"{PROCESS}","observationId":null}}"#),
        );
        assert!(malformed_resume.is_err());
        let malformed_begin = serde_json::from_str::<NativeGpuSwitchForegroundGrantRequestV1>(
            &format!(
                r#"{{"action":"begin","switchId":null,"observationId":"{OBSERVATION}","targetGpuId":"NVIDIA GeForce RTX 5090","unexpected":true}}"#
            ),
        );
        assert!(malformed_begin.is_err());
    }

    #[test]
    fn explicit_resume_reopens_only_the_exact_persisted_attention_phase() {
        let (directory, service) = service();
        let planned = begin(&service);
        let consent = bind_and_confirm_test_worker(&service, &planned);
        let switch_id = record(&consent).switch_id.clone();
        let pausing = service
            .advance_with_proof(
                &switch_id,
                record(&consent).record_revision,
                NativeGpuSwitchPhaseV1::Pausing,
            )
            .expect("enter pausing");
        let parked = service
            .park_with_attention(
                &switch_id,
                record(&pausing).record_revision,
                "gpu_switch_pause_failed",
            )
            .expect("park exact phase");
        assert_eq!(
            record(&parked).phase,
            NativeGpuSwitchPhaseV1::NeedsAttention
        );
        assert_eq!(
            record(&parked).blocked_at,
            Some(NativeGpuSwitchPhaseV1::Pausing)
        );
        assert!(record(&parked).authorization_required);
        let parked_revision = record(&parked).record_revision;
        service
            .release(NativeGpuSwitchKeyV1 {
                switch_id: switch_id.clone(),
            })
            .expect("release process lease");
        let grant = service
            .authorize_foreground(NativeGpuSwitchForegroundGrantRequestV1::Resume(
                NativeGpuSwitchResumeGrantRequestV1 {
                    action: NativeGpuSwitchResumeGrantActionV1::Resume,
                    switch_id: switch_id.clone(),
                    observation_id: RequiredJsonNull,
                    target_gpu_id: RequiredJsonNull,
                },
            ))
            .expect("mint exact resume grant");
        let lease = service
            .acquire(NativeGpuSwitchAcquireV1 {
                switch_id: switch_id.clone(),
                foreground_grant_id: grant.grant_id,
            })
            .expect("resume exact attention phase");
        assert!(lease.held);
        let resumed = service.load().expect("load resumed switch");
        assert_eq!(record(&resumed).phase, NativeGpuSwitchPhaseV1::Pausing);
        assert_eq!(record(&resumed).blocked_at, None);
        assert_eq!(record(&resumed).attention_code, None);
        assert_eq!(record(&resumed).record_revision, parked_revision + 1);
        assert!(!record(&resumed).authorization_required);
        assert!(resumed
            .issues
            .iter()
            .all(|entry| entry.code != "gpu_switch_pause_failed"));

        drop(service);
        let restored =
            GpuSwitchService::with_root(PROCESS.to_owned(), directory.path().join("gpu-switch"))
                .expect("reload resumed switch")
                .load()
                .expect("project resumed switch");
        assert_eq!(record(&restored).phase, NativeGpuSwitchPhaseV1::Pausing);
        assert!(record(&restored).authorization_required);
    }

    #[test]
    fn begin_consumes_exact_grant_persists_local_plan_and_requires_authorization_after_restart() {
        let (directory, service) = service();
        let snapshot = begin(&service);
        let active = record(&snapshot);
        assert_eq!(snapshot.store_revision, 2);
        assert_eq!(active.record_revision, 1);
        assert_eq!(active.phase, NativeGpuSwitchPhaseV1::Planned);
        assert!(!active.authorization_required);
        assert!(active.queue_reservation.active);
        let switch_id = active.switch_id.clone();
        let second = service.begin(
            NativeGpuSwitchBeginV1 {
                observation_id: OBSERVATION.to_owned(),
                receipt_id: RECEIPT.to_owned(),
                target_gpu_id: "NVIDIA GeForce RTX 5090".to_owned(),
                confirmed_hourly_price_micro_usd: 700_000,
                expected_store_revision: 2,
                session_id: SESSION.to_owned(),
                queue_expected_store_revision: 0,
                queue_run_revision: Some(QUEUE_RUN.to_owned()),
                foreground_grant_id: begin_grant(&service).grant_id,
            },
            evidence(),
        );
        assert_eq!(second.unwrap_err().code, "gpu_switch_active");
        drop(service);
        let recovered =
            GpuSwitchService::with_root(PROCESS.to_owned(), directory.path().join("gpu-switch"))
                .expect("reload switch store")
                .load()
                .expect("load recovered switch store");
        assert_eq!(record(&recovered).switch_id, switch_id);
        assert!(record(&recovered).authorization_required);
    }

    #[test]
    fn fake_worker_transport_binds_consent_only_after_one_durable_send_boundary() {
        let (_directory, service) = service();
        let planned = begin(&service);
        let mut transport = FakeWorkerCreateTransport {
            post: FakeWorkerPost::Created(test_worker_binding()),
            owner_lookup: None,
            post_calls: 0,
            owner_lookup_calls: 0,
            sent_bodies: Vec::new(),
        };
        let bound = run_fake_worker_create_saga(&service, &planned, &mut transport).unwrap();
        assert_eq!(record(&bound).phase, NativeGpuSwitchPhaseV1::ConsentPending);
        assert_eq!(transport.post_calls, 1);
        assert_eq!(transport.owner_lookup_calls, 0);
        assert_eq!(transport.sent_bodies.len(), 1);
        let private = service.inner.lock().unwrap().generation.private.clone();
        assert_eq!(
            private.worker_create_state,
            PrivateWorkerCreateStateV1::Bound
        );
        assert_eq!(
            private.requester_user_id.as_deref(),
            Some(test_worker_binding().requester_user_id.as_str())
        );
        assert_eq!(
            private.principal_binding_id.as_deref(),
            Some(test_worker_binding().principal_binding_id.as_str())
        );
    }

    #[test]
    fn fake_worker_response_loss_uses_one_owner_lookup_without_duplicate_post() {
        let (_directory, service) = service();
        let planned = begin(&service);
        let mut transport = FakeWorkerCreateTransport {
            post: FakeWorkerPost::ResponseLost,
            owner_lookup: Some(test_worker_binding()),
            post_calls: 0,
            owner_lookup_calls: 0,
            sent_bodies: Vec::new(),
        };
        let bound = run_fake_worker_create_saga(&service, &planned, &mut transport).unwrap();
        assert_eq!(record(&bound).phase, NativeGpuSwitchPhaseV1::ConsentPending);
        assert_eq!(transport.post_calls, 1);
        assert_eq!(transport.owner_lookup_calls, 1);
        assert_eq!(transport.sent_bodies.len(), 1);
    }

    #[test]
    fn sent_uncertain_resume_owner_hit_binds_without_replay_post() {
        let (_directory, service) = service();
        let planned = begin(&service);
        let mut transport = FakeWorkerCreateTransport {
            post: FakeWorkerPost::ResponseLost,
            owner_lookup: Some(test_worker_binding()),
            post_calls: 0,
            owner_lookup_calls: 0,
            sent_bodies: Vec::new(),
        };
        let bound = resume_fake_sent_uncertain_create(&service, &planned, &mut transport, |_| {})
            .expect("owner lookup binds sent-uncertain Resume");
        assert_eq!(record(&bound).phase, NativeGpuSwitchPhaseV1::ConsentPending);
        assert_eq!(transport.owner_lookup_calls, 1);
        assert_eq!(transport.post_calls, 0);
        assert!(transport.sent_bodies.is_empty());
    }

    #[test]
    fn sent_uncertain_resume_owner_404_replays_one_identical_body_and_uuid() {
        let (_directory, service) = service();
        let planned = begin(&service);
        let switch_id = record(&planned).switch_id.clone();
        let mut transport = FakeWorkerCreateTransport {
            post: FakeWorkerPost::Created(test_worker_binding()),
            owner_lookup: None,
            post_calls: 0,
            owner_lookup_calls: 0,
            sent_bodies: Vec::new(),
        };
        let bound = resume_fake_sent_uncertain_create(&service, &planned, &mut transport, |_| {})
            .expect("generic owner 404 permits one exact replay");
        assert_eq!(record(&bound).phase, NativeGpuSwitchPhaseV1::ConsentPending);
        assert_eq!(record(&bound).switch_id, switch_id);
        assert_eq!(transport.owner_lookup_calls, 1);
        assert_eq!(transport.post_calls, 1);
        let persisted_body = service
            .inner
            .lock()
            .unwrap()
            .generation
            .private
            .worker_create_body
            .clone()
            .expect("persisted worker create body");
        assert_eq!(transport.sent_bodies, vec![persisted_body]);
    }

    #[test]
    fn sent_uncertain_resume_replay_response_loss_parks_without_second_post() {
        let (_directory, service) = service();
        let planned = begin(&service);
        let switch_id = record(&planned).switch_id.clone();
        let mut transport = FakeWorkerCreateTransport {
            post: FakeWorkerPost::ResponseLost,
            owner_lookup: None,
            post_calls: 0,
            owner_lookup_calls: 0,
            sent_bodies: Vec::new(),
        };
        let parked = resume_fake_sent_uncertain_create(&service, &planned, &mut transport, |_| {})
            .expect("lost replay response remains recoverable attention");
        assert_eq!(record(&parked).switch_id, switch_id);
        assert_eq!(
            record(&parked).phase,
            NativeGpuSwitchPhaseV1::NeedsAttention
        );
        assert_eq!(
            record(&parked).attention_code.as_deref(),
            Some("gpu_switch_worker_response_invalid")
        );
        assert!(record(&parked).authorization_required);
        assert_eq!(transport.owner_lookup_calls, 2);
        assert_eq!(transport.post_calls, 1);
        assert!(!service.lease_status(&switch_id).unwrap().held);
        assert!(!service
            .sent_uncertain_resume_replay_allowed(&switch_id)
            .expect("one lost replay permanently consumes replay authority"));
    }

    #[test]
    fn sent_uncertain_resume_rejects_changed_replay_binding_before_post() {
        let (_directory, service) = service();
        let planned = begin(&service);
        let mut transport = FakeWorkerCreateTransport {
            post: FakeWorkerPost::Created(test_worker_binding()),
            owner_lookup: None,
            post_calls: 0,
            owner_lookup_calls: 0,
            sent_bodies: Vec::new(),
        };
        let error =
            resume_fake_sent_uncertain_create(&service, &planned, &mut transport, |intent| {
                intent.credential_binding_sha256 = sha256_text("changed credential")
            })
            .expect_err("changed replay binding fails closed");
        assert_eq!(error.code, "gpu_switch_transition_invalid");
        assert_eq!(transport.owner_lookup_calls, 1);
        assert_eq!(transport.post_calls, 0);
        assert!(transport.sent_bodies.is_empty());
    }

    #[test]
    fn definitive_worker_create_rejection_cannot_be_replayed_by_resume() {
        let (_directory, service) = service();
        let planned = begin(&service);
        let sent = persist_test_worker_sent_uncertain(&service, &planned);
        let sent_record = record(&sent).clone();
        let parked = service
            .park_with_attention(
                &sent_record.switch_id,
                sent_record.record_revision,
                "gpu_switch_worker_response_invalid",
            )
            .expect("persist definitive rejection attention");
        assert!(record(&parked).authorization_required);
        assert!(!service
            .sent_uncertain_resume_replay_allowed(&sent_record.switch_id)
            .expect("classify definitive rejection"));

        let mut transport = FakeWorkerCreateTransport {
            post: FakeWorkerPost::Created(test_worker_binding()),
            owner_lookup: Some(test_worker_binding()),
            post_calls: 0,
            owner_lookup_calls: 0,
            sent_bodies: Vec::new(),
        };
        let replay_allowed = service
            .sent_uncertain_resume_replay_allowed(&sent_record.switch_id)
            .expect("recheck before Resume grant consumption");
        let grant = service
            .authorize_foreground(NativeGpuSwitchForegroundGrantRequestV1::Resume(
                NativeGpuSwitchResumeGrantRequestV1 {
                    action: NativeGpuSwitchResumeGrantActionV1::Resume,
                    switch_id: sent_record.switch_id.clone(),
                    observation_id: RequiredJsonNull,
                    target_gpu_id: RequiredJsonNull,
                },
            ))
            .expect("mint Resume grant");
        assert!(
            service
                .acquire(NativeGpuSwitchAcquireV1 {
                    switch_id: sent_record.switch_id.clone(),
                    foreground_grant_id: grant.grant_id,
                })
                .expect("reopen only for explicit settlement")
                .held
        );
        if replay_allowed {
            let body = service
                .inner
                .lock()
                .unwrap()
                .generation
                .private
                .worker_create_body
                .clone()
                .expect("persisted body");
            let _ = transport.post_once(&body);
        }
        let first_resume = service.load().unwrap();
        assert_eq!(
            record(&first_resume).phase,
            NativeGpuSwitchPhaseV1::NeedsAttention
        );
        assert_eq!(
            record(&first_resume).attention_code.as_deref(),
            Some("gpu_switch_worker_response_invalid")
        );
        service
            .release(NativeGpuSwitchKeyV1 {
                switch_id: sent_record.switch_id.clone(),
            })
            .expect("release first non-replayable Resume lease");
        assert!(!service
            .sent_uncertain_resume_replay_allowed(&sent_record.switch_id)
            .expect("second Resume remains non-replayable"));
        let second_grant = service
            .authorize_foreground(NativeGpuSwitchForegroundGrantRequestV1::Resume(
                NativeGpuSwitchResumeGrantRequestV1 {
                    action: NativeGpuSwitchResumeGrantActionV1::Resume,
                    switch_id: sent_record.switch_id.clone(),
                    observation_id: RequiredJsonNull,
                    target_gpu_id: RequiredJsonNull,
                },
            ))
            .expect("mint second Resume grant");
        assert!(
            service
                .acquire(NativeGpuSwitchAcquireV1 {
                    switch_id: sent_record.switch_id.clone(),
                    foreground_grant_id: second_grant.grant_id,
                })
                .expect("second Resume stays settlement-only")
                .held
        );
        let second_resume = service.load().unwrap();
        assert_eq!(
            record(&second_resume).phase,
            NativeGpuSwitchPhaseV1::NeedsAttention
        );
        assert_eq!(
            record(&second_resume).attention_code.as_deref(),
            Some("gpu_switch_worker_response_invalid")
        );
        let settlement = service
            .uncertain_create_access(
                &sent_record.switch_id,
                record(&second_resume).record_revision,
            )
            .expect("non-replayable state retains exact settle-create request");
        let settled = service
            .bind_worker_create_response(
                &settlement.switch_id,
                settlement.record_revision,
                test_worker_binding(),
            )
            .expect("settle-create owner evidence remains bindable");
        assert_eq!(
            record(&settled).phase,
            NativeGpuSwitchPhaseV1::ConsentPending
        );
        assert_eq!(transport.owner_lookup_calls, 0);
        assert_eq!(transport.post_calls, 0);
        assert!(transport.sent_bodies.is_empty());
    }

    #[test]
    fn fresh_target_confirmation_is_durable_and_cannot_retarget_before_delete() {
        let (directory, service) = service();
        let planned = begin(&service);
        let bound = bind_test_worker(&service, &planned);
        let active = record(&bound).clone();
        let confirmed = service
            .confirm_current_target(
                NativeGpuSwitchPrepareTargetV1 {
                    switch_id: active.switch_id.clone(),
                    expected_record_revision: active.record_revision,
                    observation_id: "00000000-0000-4000-8000-000000000011".to_owned(),
                    receipt_id: "00000000-0000-4000-8000-000000000012".to_owned(),
                    target_gpu_id: active.current_target.gpu_id.clone(),
                    confirmed_hourly_price_micro_usd: active.current_target.hourly_price_micro_usd,
                },
                active.current_target.gpu_display_name.clone(),
                "2026-08-04T00:01:00.000Z".to_owned(),
            )
            .expect("persist fresh target confirmation");
        let confirmed_record = record(&confirmed);
        assert_eq!(
            confirmed_record.phase,
            NativeGpuSwitchPhaseV1::ConsentPending
        );
        assert_eq!(
            confirmed_record.target_confirmation,
            NativeGpuSwitchTargetConfirmationV1::Confirmed
        );
        assert_eq!(
            confirmed_record.current_target.observation_id,
            "00000000-0000-4000-8000-000000000011"
        );
        assert_eq!(
            confirmed_record.current_target.receipt_id,
            "00000000-0000-4000-8000-000000000012"
        );
        assert_eq!(
            confirmed_record.current_target.replacement_attempt_id,
            active.current_target.replacement_attempt_id
        );
        assert_eq!(
            confirmed_record.current_target.hourly_price_micro_usd,
            active.current_target.hourly_price_micro_usd
        );
        let retarget = service.confirm_current_target(
            NativeGpuSwitchPrepareTargetV1 {
                switch_id: confirmed_record.switch_id.clone(),
                expected_record_revision: confirmed_record.record_revision,
                observation_id: "00000000-0000-4000-8000-000000000013".to_owned(),
                receipt_id: "00000000-0000-4000-8000-000000000014".to_owned(),
                target_gpu_id: "NVIDIA L4".to_owned(),
                confirmed_hourly_price_micro_usd: 420_000,
            },
            "NVIDIA L4".to_owned(),
            "2026-08-04T00:02:00.000Z".to_owned(),
        );
        assert_eq!(retarget.unwrap_err().code, "gpu_switch_transition_invalid");
        drop(service);
        let reloaded =
            GpuSwitchService::with_root(PROCESS.to_owned(), directory.path().join("gpu-switch"))
                .expect("reload target confirmation")
                .load()
                .expect("load target confirmation");
        assert_eq!(
            record(&reloaded).current_target.observation_id,
            "00000000-0000-4000-8000-000000000011"
        );
        assert_eq!(
            record(&reloaded).current_target.receipt_id,
            "00000000-0000-4000-8000-000000000012"
        );
        assert_eq!(
            record(&reloaded).target_confirmation,
            NativeGpuSwitchTargetConfirmationV1::Confirmed
        );
    }

    #[test]
    fn worker_finalization_requires_durable_target_confirmation() {
        let (_directory, service) = service();
        let planned = begin(&service);
        let bound = bind_test_worker(&service, &planned);
        let active = record(&bound);
        assert_eq!(
            active.target_confirmation,
            NativeGpuSwitchTargetConfirmationV1::Required
        );
        let error = service
            .prepare_worker_finalization(&active.switch_id, active.record_revision)
            .unwrap_err();
        assert_eq!(error.code, "gpu_switch_transition_invalid");
    }

    #[test]
    fn fake_worker_owner_binding_mismatch_fails_closed_without_rebinding() {
        let (_directory, service) = service();
        let planned = begin(&service);
        let bound = bind_test_worker(&service, &planned);
        let active = record(&bound);
        let mismatch = NativeGpuSwitchWorkerBindingV1 {
            requester_user_id: "sujal".to_owned(),
            principal_binding_id: "00000000-0000-4000-8000-000000000009".to_owned(),
        };
        let error = service
            .bind_or_validate_worker_owner(&active.switch_id, active.record_revision, mismatch)
            .unwrap_err();
        assert_eq!(error.code, "gpu_switch_transition_invalid");
        let unchanged = service.load().unwrap();
        assert_eq!(
            record(&unchanged).phase,
            NativeGpuSwitchPhaseV1::ConsentPending
        );
        let private = service.inner.lock().unwrap().generation.private.clone();
        assert_eq!(private.requester_user_id.as_deref(), Some("lakshman"));
        assert_eq!(
            private.principal_binding_id.as_deref(),
            Some("00000000-0000-4000-8000-000000000008")
        );
    }

    #[test]
    fn sent_uncertain_draft_cannot_retry_or_use_local_draft_cancellation() {
        let (_directory, service) = service();
        let planned = begin(&service);
        let sent = persist_test_worker_sent_uncertain(&service, &planned);
        let active = record(&sent);
        let retry = service.prepare_worker_create_send_pending(
            &active.switch_id,
            active.record_revision,
            test_worker_intent(active),
        );
        assert_eq!(retry.unwrap_err().code, "gpu_switch_transition_invalid");
        let cancellation = service.terminalize_with_proof(
            &active.switch_id,
            active.record_revision,
            NativeGpuSwitchPhaseV1::CancelledPreDelete,
            NativeGpuSwitchTerminalProofV1 {
                terminal_reason: NativeGpuSwitchTerminalReasonV1::LocalDraftCancelled,
                principal_binding_id: None,
                worker_tombstone_sha256: None,
            },
        );
        assert_eq!(
            cancellation.unwrap_err().code,
            "gpu_switch_transition_invalid"
        );
        assert_eq!(
            service
                .inner
                .lock()
                .unwrap()
                .generation
                .private
                .worker_create_state,
            PrivateWorkerCreateStateV1::SentUncertain
        );
    }

    #[test]
    fn phase_machine_rejects_skips_and_durably_counts_only_two_delete_writes() {
        let (_directory, service) = service();
        let initial = begin(&service);
        let switch_id = record(&initial).switch_id.clone();
        let skipped = service.advance_with_proof(
            &switch_id,
            record(&initial).record_revision,
            NativeGpuSwitchPhaseV1::ReadyToDelete,
        );
        assert_eq!(skipped.unwrap_err().code, "gpu_switch_transition_invalid");
        let forged_consent = service.advance_with_proof(
            &switch_id,
            record(&initial).record_revision,
            NativeGpuSwitchPhaseV1::ConsentPending,
        );
        assert_eq!(
            forged_consent.unwrap_err().code,
            "gpu_switch_transition_invalid"
        );
        let consent = bind_and_confirm_test_worker(&service, &initial);
        let pausing = service
            .advance_with_proof(
                &switch_id,
                record(&consent).record_revision,
                NativeGpuSwitchPhaseV1::Pausing,
            )
            .unwrap();
        let ready = service
            .advance_with_proof(
                &switch_id,
                record(&pausing).record_revision,
                NativeGpuSwitchPhaseV1::ReadyToDelete,
            )
            .unwrap();
        let intent = service
            .advance_with_proof(
                &switch_id,
                record(&ready).record_revision,
                NativeGpuSwitchPhaseV1::DeleteIntent,
            )
            .unwrap();
        let first = service
            .prepare_old_delete_wire_attempt(&switch_id, record(&intent).record_revision)
            .unwrap();
        assert_eq!(record(&first).old_delete_wire_attempts, 1);
        let absent = service
            .advance_with_proof(
                &switch_id,
                record(&first).record_revision,
                NativeGpuSwitchPhaseV1::OldAbsent,
            )
            .unwrap();
        assert_eq!(record(&absent).old_delete_wire_attempts, 1);
        let wrong_phase =
            service.prepare_old_delete_wire_attempt(&switch_id, record(&absent).record_revision);
        assert_eq!(
            wrong_phase.unwrap_err().code,
            "gpu_switch_transition_invalid"
        );
    }

    #[test]
    fn failed_replacement_cleanup_archives_fingerprints_and_allows_one_fresh_second_attempt() {
        let (directory, service) = service();
        let planned = begin(&service);
        let old_absent = advance_bound_switch_to_old_absent(&service, &planned);
        let switch_id = record(&old_absent).switch_id.clone();
        let first_create = provider_create_intent("provider create request one");
        let first_request = first_create.create_wire_body_sha256.clone();
        let first_intent = service
            .prepare_replacement_create(
                &switch_id,
                record(&old_absent).record_revision,
                first_create,
            )
            .expect("first provider create intent");
        let identified = service
            .record_replacement_identified(
                &switch_id,
                record(&first_intent).record_revision,
                "replacement-pod-1".to_owned(),
                record(&first_intent).current_target.gpu_id.clone(),
                Some(record(&first_intent).current_target.hourly_price_micro_usd),
                sha256_text("provider create response one"),
            )
            .expect("bind first replacement response");
        let provisioned = service
            .confirm_actual_price(NativeGpuSwitchActualPriceV1 {
                switch_id: switch_id.clone(),
                expected_record_revision: record(&identified).record_revision,
                confirmed_actual_hourly_price_micro_usd: record(&identified)
                    .actual_hourly_price_micro_usd
                    .expect("first actual price"),
            })
            .expect("confirm first actual price");
        let failed = service
            .advance_with_proof(
                &switch_id,
                record(&provisioned).record_revision,
                NativeGpuSwitchPhaseV1::ReplacementFailed,
            )
            .expect("mark replacement failed");
        let delete_intent = service
            .prepare_replacement_delete(
                &switch_id,
                record(&failed).record_revision,
                "replacement-pod-1",
            )
            .expect("persist failed replacement delete intent");
        let second_dormant = service
            .settle_deleted_replacement(&switch_id, record(&delete_intent).record_revision)
            .expect("archive first attempt and allocate second");
        let second_record = record(&second_dormant);
        assert_eq!(second_record.phase, NativeGpuSwitchPhaseV1::OldAbsent);
        assert_eq!(second_record.current_target.attempt_revision, 2);
        assert_eq!(second_record.prior_attempts.len(), 1);
        let private = service.inner.lock().unwrap().generation.private.clone();
        assert!(private.provider_request_sha256.is_none());
        assert!(private.provider_response_sha256.is_none());
        assert_eq!(private.provider_attempt_history.len(), 1);
        assert_eq!(
            private.provider_attempt_history[0].replacement_attempt_id,
            second_record.prior_attempts[0]
                .target
                .replacement_attempt_id
        );
        assert_eq!(
            private.provider_attempt_history[0].request_sha256,
            first_request
        );

        let second_intent = service
            .prepare_replacement_create(
                &switch_id,
                second_record.record_revision,
                provider_create_intent("provider create request two"),
            )
            .expect("fresh second provider create intent");
        assert_eq!(
            record(&second_intent).phase,
            NativeGpuSwitchPhaseV1::CreateIntent
        );
        assert_eq!(record(&second_intent).current_target.attempt_revision, 2);
        drop(service);

        let restored =
            GpuSwitchService::with_root(PROCESS.to_owned(), directory.path().join("gpu-switch"))
                .expect("reload retry journal")
                .load()
                .expect("load retry journal");
        assert_eq!(
            record(&restored).phase,
            NativeGpuSwitchPhaseV1::CreateIntent
        );
        assert_eq!(record(&restored).current_target.attempt_revision, 2);
    }

    #[test]
    fn verified_runtime_identity_is_required_durable_and_fail_closed_on_restart() {
        let (directory, service) = service();
        let planned = begin(&service);
        let provisioned = advance_bound_switch_to_provisioning(&service, &planned);
        let switch_id = record(&provisioned).switch_id.clone();
        let runtime_sha256 = sha256_text("strict worker runtime identity projection");
        let ready = service
            .bind_verified_runtime_identity(
                &switch_id,
                record(&provisioned).record_revision,
                runtime_sha256.clone(),
            )
            .expect("bind verified runtime identity");
        assert_eq!(record(&ready).phase, NativeGpuSwitchPhaseV1::ReadyPaused);
        assert_eq!(
            service
                .inner
                .lock()
                .unwrap()
                .generation
                .private
                .runtime_identity_sha256
                .as_deref(),
            Some(runtime_sha256.as_str())
        );
        let store_revision = ready.store_revision;
        let root = directory.path().join("gpu-switch");
        drop(service);

        let restored_service = GpuSwitchService::with_root(PROCESS.to_owned(), root.clone())
            .expect("reload runtime-bound switch");
        let restored = restored_service
            .load()
            .expect("project runtime-bound switch");
        assert_eq!(record(&restored).phase, NativeGpuSwitchPhaseV1::ReadyPaused);
        drop(restored_service);

        let generation_path = root
            .join("generations")
            .join(format!("{store_revision}.json"));
        let mut crafted: DiskGenerationV1 = serde_json::from_slice(
            &fs::read(&generation_path).expect("read runtime-bound generation"),
        )
        .expect("parse runtime-bound generation");
        crafted.private.runtime_identity_sha256 = None;
        fs::write(&generation_path, serde_json::to_vec(&crafted).unwrap()).unwrap();

        let failed = GpuSwitchService::with_root(PROCESS.to_owned(), root)
            .expect("open crafted runtime journal")
            .load()
            .expect("fail-closed runtime projection");
        assert!(failed.record.is_none());
        assert!(failed
            .issues
            .iter()
            .any(|entry| entry.code == "gpu_switch_store_unrecoverable"));
    }

    #[test]
    fn crafted_provider_attempt_history_mismatch_fails_closed_on_restart() {
        let (directory, service) = service();
        let planned = begin(&service);
        let old_absent = advance_bound_switch_to_old_absent(&service, &planned);
        let switch_id = record(&old_absent).switch_id.clone();
        let first_intent = service
            .prepare_replacement_create(
                &switch_id,
                record(&old_absent).record_revision,
                provider_create_intent("provider create request one"),
            )
            .unwrap();
        let identified = service
            .record_replacement_identified(
                &switch_id,
                record(&first_intent).record_revision,
                "replacement-pod-1".to_owned(),
                record(&first_intent).current_target.gpu_id.clone(),
                Some(record(&first_intent).current_target.hourly_price_micro_usd),
                sha256_text("provider create response one"),
            )
            .unwrap();
        let provisioned = service
            .confirm_actual_price(NativeGpuSwitchActualPriceV1 {
                switch_id: switch_id.clone(),
                expected_record_revision: record(&identified).record_revision,
                confirmed_actual_hourly_price_micro_usd: record(&identified)
                    .actual_hourly_price_micro_usd
                    .unwrap(),
            })
            .unwrap();
        let failed = service
            .advance_with_proof(
                &switch_id,
                record(&provisioned).record_revision,
                NativeGpuSwitchPhaseV1::ReplacementFailed,
            )
            .unwrap();
        let delete_intent = service
            .prepare_replacement_delete(
                &switch_id,
                record(&failed).record_revision,
                "replacement-pod-1",
            )
            .unwrap();
        let settled = service
            .settle_deleted_replacement(&switch_id, record(&delete_intent).record_revision)
            .unwrap();
        let root = directory.path().join("gpu-switch");
        let path = root
            .join("generations")
            .join(format!("{}.json", settled.store_revision));
        let mut crafted: DiskGenerationV1 =
            serde_json::from_slice(&fs::read(&path).expect("read settled generation"))
                .expect("parse settled generation");
        crafted.private.provider_attempt_history[0].attempt_revision = 99;
        fs::write(&path, serde_json::to_vec(&crafted).unwrap()).unwrap();
        drop(service);

        let restored = GpuSwitchService::with_root(PROCESS.to_owned(), root)
            .expect("reload crafted journal")
            .load()
            .expect("load crafted journal");
        assert!(restored.record.is_none());
        assert!(restored
            .issues
            .iter()
            .any(|entry| entry.code == "gpu_switch_store_unrecoverable"));
    }

    #[test]
    fn attempt_quote_is_process_local_and_current_target_can_change_only_through_confirmation() {
        let (_directory, service) = service();
        let initial = begin(&service);
        let switch_id = record(&initial).switch_id.clone();
        let consent = bind_and_confirm_test_worker(&service, &initial);
        let pausing = service
            .advance_with_proof(
                &switch_id,
                record(&consent).record_revision,
                NativeGpuSwitchPhaseV1::Pausing,
            )
            .unwrap();
        let ready = service
            .advance_with_proof(
                &switch_id,
                record(&pausing).record_revision,
                NativeGpuSwitchPhaseV1::ReadyToDelete,
            )
            .unwrap();
        let intent = service
            .advance_with_proof(
                &switch_id,
                record(&ready).record_revision,
                NativeGpuSwitchPhaseV1::DeleteIntent,
            )
            .unwrap();
        let wire = service
            .prepare_old_delete_wire_attempt(&switch_id, record(&intent).record_revision)
            .unwrap();
        let absent = service
            .advance_with_proof(
                &switch_id,
                record(&wire).record_revision,
                NativeGpuSwitchPhaseV1::OldAbsent,
            )
            .unwrap();
        let prepared = service
            .prepare_attempt(
                NativeGpuSwitchPrepareTargetV1 {
                    switch_id: switch_id.clone(),
                    expected_record_revision: record(&absent).record_revision,
                    observation_id: "00000000-0000-4000-8000-000000000006".to_owned(),
                    receipt_id: "00000000-0000-4000-8000-000000000007".to_owned(),
                    target_gpu_id: "NVIDIA L4".to_owned(),
                    confirmed_hourly_price_micro_usd: 300_000,
                },
                "NVIDIA L4".to_owned(),
                "2026-08-04T00:00:30.000Z".to_owned(),
            )
            .unwrap();
        let quote = record(&prepared)
            .prepared_target
            .as_ref()
            .expect("prepared quote")
            .clone();
        assert_eq!(
            quote.prepared_from_record_revision,
            record(&prepared).record_revision
        );
        let confirmed = service
            .confirm_attempt(NativeGpuSwitchConfirmAttemptV1 {
                switch_id: switch_id.clone(),
                expected_record_revision: record(&prepared).record_revision,
                observation_id: quote.observation_id.clone(),
                receipt_id: quote.receipt_id.clone(),
                target_gpu_id: quote.gpu_id.clone(),
                confirmed_hourly_price_micro_usd: quote.hourly_price_micro_usd,
                quote_id: quote.quote_id.clone(),
            })
            .unwrap();
        assert_eq!(record(&confirmed).current_target.attempt_revision, 2);
        assert_eq!(record(&confirmed).prior_attempts.len(), 1);
        let replay = service.confirm_attempt(NativeGpuSwitchConfirmAttemptV1 {
            switch_id,
            expected_record_revision: record(&confirmed).record_revision,
            observation_id: quote.observation_id,
            receipt_id: quote.receipt_id,
            target_gpu_id: quote.gpu_id,
            confirmed_hourly_price_micro_usd: quote.hourly_price_micro_usd,
            quote_id: quote.quote_id,
        });
        assert_eq!(replay.unwrap_err().code, "gpu_switch_quote_invalid");
    }

    #[test]
    fn corrupt_current_recovers_highest_valid_generation_and_invalid_relations_fail_closed() {
        let (directory, service) = service();
        let snapshot = begin(&service);
        let root = directory.path().join("gpu-switch");
        fs::write(root.join("CURRENT"), b"99\n").unwrap();
        drop(service);
        let recovered = GpuSwitchService::with_root(PROCESS.to_owned(), root.clone()).unwrap();
        let recovered_snapshot = recovered.load().unwrap();
        assert!(recovered_snapshot
            .issues
            .iter()
            .any(|issue| issue.code == "gpu_switch_store_recovered"));
        assert!(record(&recovered_snapshot).authorization_required);

        let mut invalid = record(&snapshot).clone();
        invalid.authorization_required = false;
        let invalid_generation = DiskGenerationV1 {
            schema_version: SCHEMA_VERSION,
            store_revision: 1,
            record: Some(invalid),
            private: PrivateGpuSwitchGenerationV1::empty(),
        };
        let invalid_root = directory.path().join("invalid-switch");
        fs::create_dir_all(invalid_root.join("generations")).unwrap();
        fs::write(invalid_root.join("CURRENT"), b"1\n").unwrap();
        fs::write(
            invalid_root.join("generations").join("1.json"),
            serde_json::to_vec(&invalid_generation).unwrap(),
        )
        .unwrap();
        let blocked = GpuSwitchService::with_root(PROCESS.to_owned(), invalid_root)
            .unwrap()
            .load()
            .unwrap();
        assert_eq!(blocked.record, None);
        assert_eq!(
            blocked.issues,
            vec![issue("gpu_switch_store_unrecoverable")]
        );
    }

    #[test]
    fn torn_current_generation_recovers_the_highest_retained_linked_generation() {
        let (directory, service) = service();
        let snapshot = begin(&service);
        let root = directory.path().join("gpu-switch");
        fs::write(
            root.join("generations")
                .join(format!("{}.json", snapshot.store_revision)),
            br#"{"schemaVersion":1"#,
        )
        .unwrap();
        drop(service);

        let restored = GpuSwitchService::with_root(PROCESS.to_owned(), root)
            .unwrap()
            .load()
            .unwrap();
        assert!(restored
            .issues
            .iter()
            .any(|issue| issue.code == "gpu_switch_store_recovered"));
        assert_eq!(record(&restored).phase, NativeGpuSwitchPhaseV1::Planned);
        assert!(record(&restored).authorization_required);
    }

    #[test]
    fn crafted_persisted_generation_relation_violations_fail_closed_on_restart() {
        let (directory, service) = service();
        let snapshot = begin(&service);
        let source = directory.path().join("gpu-switch");
        let generation_path = source
            .join("generations")
            .join(format!("{}.json", snapshot.store_revision));
        let valid: DiskGenerationV1 =
            serde_json::from_slice(&fs::read(generation_path).unwrap()).unwrap();
        let cases: Vec<(&str, Box<dyn Fn(&mut NativeGpuSwitchRecordV1)>)> = vec![
            (
                "durable_authorization",
                Box::new(|record| record.authorization_required = false),
            ),
            (
                "post_delete_wire_budget",
                Box::new(|record| record.phase = NativeGpuSwitchPhaseV1::OldAbsent),
            ),
            (
                "replacement_identity",
                Box::new(|record| {
                    record.phase = NativeGpuSwitchPhaseV1::ReplacementIdentified;
                    record.old_delete_wire_attempts = 1;
                }),
            ),
            (
                "queue_run_without_reservation",
                Box::new(|record| record.queue_reservation.active = false),
            ),
        ];
        for (name, mutate) in cases {
            let isolated = tempfile::tempdir().unwrap();
            copy_switch_root(&source, isolated.path()).unwrap();
            let root = isolated.path().join("gpu-switch");
            let mut malformed = valid.clone();
            mutate(malformed.record.as_mut().unwrap());
            fs::write(
                root.join("generations")
                    .join(format!("{}.json", malformed.store_revision)),
                serde_json::to_vec(&malformed).unwrap(),
            )
            .unwrap();
            let loaded = GpuSwitchService::with_root(PROCESS.to_owned(), root)
                .unwrap()
                .load()
                .unwrap();
            assert_eq!(loaded.record, None, "{name}");
            assert!(
                loaded
                    .issues
                    .iter()
                    .any(|issue| issue.code == "gpu_switch_store_unrecoverable"),
                "{name}"
            );
        }
    }

    #[test]
    fn private_receipt_and_grant_binding_are_durable_and_cannot_be_rebound() {
        let (_directory, service) = service();
        let snapshot = begin(&service);
        let initial_private = service.inner.lock().unwrap().generation.private.clone();
        assert_eq!(initial_private.process_epoch_id.as_deref(), Some(PROCESS));
        assert_eq!(
            initial_private.inventory_observation_id.as_deref(),
            Some(OBSERVATION)
        );
        assert_eq!(
            initial_private.inventory_receipt_id.as_deref(),
            Some(RECEIPT)
        );
        assert!(initial_private.inventory_catalog_sha256.is_some());
        assert!(initial_private.consumed_foreground_grant_sha256.is_some());
        let mut inner = service.inner.lock().unwrap();
        let mut rebound = inner.generation.clone();
        rebound.store_revision = next_revision(rebound.store_revision).unwrap();
        rebound.private.inventory_receipt_id =
            Some("00000000-0000-4000-8000-000000000099".to_owned());
        let error = service
            .commit_prebound_locked(&mut inner, rebound)
            .unwrap_err();
        assert_eq!(error.code, "gpu_switch_transition_invalid");
        assert_eq!(inner.generation.store_revision, snapshot.store_revision);
    }

    #[test]
    fn local_draft_terminalization_writes_history_and_releasing_reservation_before_restart() {
        let (directory, service) = service();
        let planned = begin(&service);
        let pending = persist_test_worker_send_pending(&service, &planned);
        let switch_id = record(&pending).switch_id.clone();
        let terminal = service
            .terminalize_with_proof(
                &switch_id,
                record(&pending).record_revision,
                NativeGpuSwitchPhaseV1::CancelledPreDelete,
                NativeGpuSwitchTerminalProofV1 {
                    terminal_reason: NativeGpuSwitchTerminalReasonV1::LocalDraftCancelled,
                    principal_binding_id: None,
                    worker_tombstone_sha256: None,
                },
            )
            .unwrap();
        assert_eq!(
            record(&terminal).phase,
            NativeGpuSwitchPhaseV1::CancelledPreDelete
        );
        assert!(!record(&terminal).queue_reservation.active);
        assert!(record(&terminal).authorization_required);
        let root = directory.path().join("gpu-switch");
        let history = root
            .join("history")
            .join(format!("{}.json", sha256_text(&switch_id)));
        assert!(history.exists());
        let reservation: PrivateGpuSwitchQueueReservationV1 =
            serde_json::from_slice(&fs::read(root.join("QUEUE_RESERVATION")).unwrap()).unwrap();
        assert_eq!(
            reservation.phase,
            PrivateGpuSwitchQueueReservationPhaseV1::Releasing
        );
        assert_eq!(
            reservation.terminal_state.as_deref(),
            Some("cancelled_pre_delete")
        );
        drop(service);
        let restored = GpuSwitchService::with_root(PROCESS.to_owned(), root)
            .unwrap()
            .load()
            .unwrap();
        assert_eq!(
            record(&restored).phase,
            NativeGpuSwitchPhaseV1::CancelledPreDelete
        );
        assert!(record(&restored).authorization_required);
        let cleared =
            GpuSwitchService::with_root(PROCESS.to_owned(), directory.path().join("gpu-switch"))
                .unwrap()
                .clear_terminal_after_history(&switch_id, record(&restored).record_revision)
                .unwrap();
        assert!(cleared.record.is_none());
        assert!(!directory
            .path()
            .join("gpu-switch")
            .join("QUEUE_RESERVATION")
            .exists());
        assert!(directory
            .path()
            .join("gpu-switch")
            .join("reservation-history")
            .join(format!("{}.json", sha256_text(&switch_id)))
            .exists());
    }

    #[test]
    fn crash_between_terminal_clear_generation_and_reservation_removal_recovers_terminal_blocker() {
        let (directory, service) = service();
        let planned = begin(&service);
        let pending = persist_test_worker_send_pending(&service, &planned);
        let switch_id = record(&pending).switch_id.clone();
        let terminal = service
            .terminalize_with_proof(
                &switch_id,
                record(&pending).record_revision,
                NativeGpuSwitchPhaseV1::CancelledPreDelete,
                NativeGpuSwitchTerminalProofV1 {
                    terminal_reason: NativeGpuSwitchTerminalReasonV1::LocalDraftCancelled,
                    principal_binding_id: None,
                    worker_tombstone_sha256: None,
                },
            )
            .unwrap();
        let terminal_record = record(&terminal).clone();
        {
            let mut inner = service.inner.lock().unwrap();
            let interrupted_clear = DiskGenerationV1 {
                schema_version: SCHEMA_VERSION,
                store_revision: next_revision(inner.generation.store_revision).unwrap(),
                record: None,
                private: PrivateGpuSwitchGenerationV1::empty(),
            };
            service
                .commit_prebound_locked(&mut inner, interrupted_clear)
                .unwrap();
        }
        drop(service);
        let restored =
            GpuSwitchService::with_root(PROCESS.to_owned(), directory.path().join("gpu-switch"))
                .unwrap()
                .load()
                .unwrap();
        assert_eq!(record(&restored).switch_id, terminal_record.switch_id);
        assert_eq!(
            record(&restored).phase,
            NativeGpuSwitchPhaseV1::CancelledPreDelete
        );
        assert!(restored
            .issues
            .iter()
            .any(|issue| issue.code == "gpu_switch_store_recovered"));
    }

    #[test]
    fn registry_retryability_is_exhaustive_for_native_switch_issues() {
        for code in [
            "gpu_switch_revision_conflict",
            "gpu_switch_lease_busy",
            "gpu_switch_inventory_unavailable",
        ] {
            assert!(issue(code).retryable, "{code}");
        }
        for code in [
            "gpu_switch_store_recovered",
            "gpu_switch_store_unrecoverable",
            "gpu_switch_target_unavailable",
            "gpu_switch_worker_guard_missing",
            "gpu_switch_pause_failed",
            "gpu_switch_runtime_identity_unavailable",
        ] {
            assert!(is_known_native_code(code));
            assert!(!issue(code).retryable, "{code}");
        }
    }

    #[test]
    fn normal_stop_veto_maps_local_switch_phases_without_mutating_the_journal() {
        let (_directory, service) = service();
        let planned = begin(&service);
        let before = service.load().unwrap();
        let error = service.veto_normal_stop().unwrap_err();
        assert_eq!(error.code, "gpu_switch_request_in_progress");
        assert!(!error.retryable);
        assert_eq!(service.load().unwrap(), before);
        assert_eq!(record(&planned).phase, NativeGpuSwitchPhaseV1::Planned);

        for phase in [
            NativeGpuSwitchPhaseV1::Pausing,
            NativeGpuSwitchPhaseV1::ReadyToDelete,
            NativeGpuSwitchPhaseV1::DeleteIntent,
            NativeGpuSwitchPhaseV1::ReplacementIdentified,
            NativeGpuSwitchPhaseV1::ReadyPaused,
        ] {
            assert_eq!(
                normal_stop_veto_for_phase(phase, None).unwrap_err().code,
                "gpu_switch_pending",
                "{phase:?}"
            );
        }
        assert_eq!(
            normal_stop_veto_for_phase(
                NativeGpuSwitchPhaseV1::NeedsAttention,
                Some(NativeGpuSwitchPhaseV1::ConsentPending),
            )
            .unwrap_err()
            .code,
            "gpu_switch_request_in_progress"
        );
        assert_eq!(
            normal_stop_veto_for_phase(
                NativeGpuSwitchPhaseV1::NeedsAttention,
                Some(NativeGpuSwitchPhaseV1::DeleteUncertain),
            )
            .unwrap_err()
            .code,
            "gpu_switch_pending"
        );
        for terminal in [
            NativeGpuSwitchPhaseV1::Completed,
            NativeGpuSwitchPhaseV1::CancelledPreDelete,
        ] {
            assert!(normal_stop_veto_for_phase(terminal, None).is_ok());
        }
    }

    #[test]
    fn normal_stop_disk_veto_detects_a_newer_sibling_switch_and_reservation() {
        let (directory, stale_service) = service();
        assert!(stale_service.veto_normal_stop().is_ok());

        // This simulates a second desktop process that started from the same
        // app-data root after `stale_service` constructed its in-memory view.
        // `begin` persists both CURRENT and QUEUE_RESERVATION, while the first
        // service deliberately remains unaware of that generation.
        let sibling =
            GpuSwitchService::with_root(PROCESS.to_owned(), directory.path().join("gpu-switch"))
                .expect("sibling switch service");
        let persisted = begin(&sibling);
        assert_eq!(record(&persisted).phase, NativeGpuSwitchPhaseV1::Planned);

        assert!(
            stale_service.veto_normal_stop().is_ok(),
            "the process-start snapshot is intentionally stale in this test"
        );
        let error = stale_service.veto_normal_stop_from_disk().unwrap_err();
        assert_eq!(error.code, "gpu_switch_request_in_progress");
        assert!(!error.retryable);
    }

    #[test]
    fn normal_stop_disk_veto_keeps_a_terminal_releasing_reservation_blocked() {
        let (_directory, service) = service();
        let planned = begin(&service);
        let pending = persist_test_worker_send_pending(&service, &planned);
        let switch_id = record(&pending).switch_id.clone();
        let terminal = service
            .terminalize_with_proof(
                &switch_id,
                record(&pending).record_revision,
                NativeGpuSwitchPhaseV1::CancelledPreDelete,
                NativeGpuSwitchTerminalProofV1 {
                    terminal_reason: NativeGpuSwitchTerminalReasonV1::LocalDraftCancelled,
                    principal_binding_id: None,
                    worker_tombstone_sha256: None,
                },
            )
            .expect("terminalize local draft");
        assert_eq!(
            record(&terminal).phase,
            NativeGpuSwitchPhaseV1::CancelledPreDelete
        );
        assert!(
            service.veto_normal_stop().is_ok(),
            "a terminal record alone is not a Stop veto"
        );
        let error = service.veto_normal_stop_from_disk().unwrap_err();
        assert_eq!(error.code, "gpu_switch_pending");
        assert!(!error.retryable);
    }

    #[test]
    fn gpu_identity_uses_the_shared_v1_ascii_grammar() {
        let maximum = "A".repeat(128);
        for value in [
            "NVIDIA RTX 4090",
            "RTX PRO (Blackwell)+4:1",
            "A_B.C-1",
            "x",
            maximum.as_str(),
        ] {
            assert!(valid_gpu_identity_raw(value), "expected valid: {value:?}");
        }
        let too_long = "A".repeat(129);
        for value in [
            "",
            " NVIDIA RTX 4090",
            "NVIDIA RTX 4090 ",
            "NVIDIA/RTX",
            r"NVIDIA\RTX",
            "NVIDIA RTX-",
            too_long.as_str(),
        ] {
            assert!(
                !valid_gpu_identity_raw(value),
                "expected invalid: {value:?}"
            );
        }
    }

    fn copy_switch_root(source: &Path, destination_parent: &Path) -> std::io::Result<()> {
        let destination = destination_parent.join("gpu-switch");
        fs::create_dir_all(destination.join("generations"))?;
        fs::create_dir_all(destination.join("history"))?;
        fs::create_dir_all(destination.join("reservation-history"))?;
        for name in ["CURRENT", "QUEUE_RESERVATION", "QUEUE_RESERVATION.prev"] {
            let source_path = source.join(name);
            if source_path.exists() {
                fs::copy(source_path, destination.join(name))?;
            }
        }
        for entry in fs::read_dir(source.join("generations"))? {
            let entry = entry?;
            fs::copy(
                entry.path(),
                destination.join("generations").join(entry.file_name()),
            )?;
        }
        Ok(())
    }
}
