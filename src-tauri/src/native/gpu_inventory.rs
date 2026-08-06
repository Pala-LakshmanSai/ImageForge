//! Native-owned Task 014 GPU inventory and normal Start authority.
//!
//! The renderer receives only strict, safe selector projections. Provider URLs,
//! raw JSON, auth headers, catalog receipts, create markers, and Pod bodies stay
//! in this module or `runpod.rs`.

use super::{NativeError, NativeResult, RunPodTransport};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use uuid::{Uuid, Version};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const RECEIPT_VALID_FOR_MS: u64 = 60_000;
const GPU_INVENTORY_EVENT: &str = "gpu-inventory-v1";
const START_JOURNAL_SCHEMA_VERSION: u8 = 1;
const MAX_START_JOURNAL_BYTES: u64 = 64 * 1024;
const IMAGEFORGE_TEMPLATE_ID: &str = "q8sfgixfy2";
const IMAGEFORGE_NETWORK_VOLUME_ID: &str = "ukh207b26r";
const IMAGEFORGE_WORKER_IMAGE: &str =
    "ghcr.io/pala-lakshmansai/imageforge-worker@sha256:f862e1ea8ece9f35101e7c47be55a5042c17e0eb3cf8414dd709ed73a59e33ed";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeGpuInventoryReceiptV1 {
    pub schema_version: u8,
    pub receipt_id: String,
    pub process_epoch_id: String,
    pub received_at: String,
    pub valid_for_ms: u64,
    pub catalog_sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeGpuInventoryIssueV1 {
    pub code: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuSwitchPodV1 {
    pub pod_id: String,
    pub gpu_id: String,
    pub gpu_display_name: String,
    pub hourly_price_micro_usd: Option<u64>,
}

/// Native-only result of the final target revalidation used by a coordinated
/// GPU switch. The renderer's receipt identifies the intent being checked;
/// the returned receipt/observation are freshly minted from the authoritative
/// catalog read and are the only values committed into the switch journal.
#[derive(Debug, Clone)]
pub(crate) struct NativeGpuSwitchFreshSelectionV1 {
    pub observation_id: String,
    pub receipt_id: String,
    pub evidence: super::gpu_switch::NativeGpuSwitchSelectionEvidenceV1,
}

/// Native-only target quote produced after the original Pod has already been
/// deleted. Unlike `NativeGpuSwitchFreshSelectionV1`, this proof deliberately
/// does not require a current Pod; it still binds the exact freshly promoted
/// catalog receipt, target identity, display name, and integer price.
#[derive(Debug, Clone)]
pub(crate) struct NativeGpuSwitchFreshTargetV1 {
    pub observation_id: String,
    pub receipt_id: String,
    pub target_gpu_display_name: String,
    pub inventory_observed_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuSelectorOfferV1 {
    pub schema_version: u8,
    pub observation_id: String,
    pub receipt_id: Option<String>,
    pub gpu_id: String,
    pub policy_key: String,
    pub display_name: String,
    pub memory_gb: u16,
    pub emergency: bool,
    pub availability: String,
    pub hourly_price_micro_usd: Option<u64>,
    pub data_center_id: String,
    pub source: String,
    pub observed_at: Option<String>,
    pub stale: bool,
    pub selectable: bool,
    pub disabled_reason: Option<String>,
    pub benchmark_state: String,
    pub benchmark_age_ms: Option<u64>,
    pub speed_score: Option<u64>,
    pub benchmark_median_duration_us: Option<u64>,
    pub benchmark_p95_duration_us: Option<u64>,
    pub benchmark_measured_at: Option<String>,
    pub benchmark_evidence_sha256: Option<String>,
    pub estimated_switch_remaining_cost_micro_usd: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeGpuInventorySnapshotV1 {
    pub schema_version: u8,
    pub observation_id: String,
    pub process_epoch_id: String,
    pub include_emergency_tier: bool,
    pub state: String,
    pub observed_at: Option<String>,
    pub receipt: Option<NativeGpuInventoryReceiptV1>,
    pub offers: Vec<GpuSelectorOfferV1>,
    pub current_pod: Option<NativeGpuSwitchPodV1>,
    pub current_pod_observed_at: Option<String>,
    pub current_pod_stale: bool,
    pub issue: Option<NativeGpuInventoryIssueV1>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeGpuInventoryEventV1 {
    schema_version: u8,
    event: &'static str,
    process_epoch_id: String,
    observation_id: String,
    event_sequence: u64,
    superseded: bool,
    snapshot: NativeGpuInventorySnapshotV1,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeManualGpuStartV1 {
    pub observation_id: String,
    pub receipt_id: String,
    pub target_gpu_id: String,
    pub confirmed_hourly_price_micro_usd: u64,
    pub session_id: String,
    pub expected_lifecycle_revision: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeAutoGpuStartV1 {
    pub observation_id: String,
    pub receipt_id: String,
    pub session_id: String,
    pub expected_lifecycle_revision: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeManualGpuActualPriceV1 {
    pub operation_id: String,
    pub expected_lifecycle_revision: u64,
    pub confirmed_actual_hourly_price_micro_usd: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuStartIssueV1 {
    pub code: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeManualGpuStartResultV1 {
    pub schema_version: u8,
    pub operation_id: String,
    pub lifecycle_revision: u64,
    pub state: String,
    pub pod: Option<NativeGpuSwitchPodV1>,
    pub confirmed_hourly_price_micro_usd: u64,
    pub actual_hourly_price_micro_usd: Option<u64>,
    pub issue: Option<NativeGpuStartIssueV1>,
}

#[derive(Debug, Clone)]
struct Policy {
    key: &'static str,
    display_name: &'static str,
    exact_ids: &'static [&'static str],
    priority: u8,
    emergency: bool,
    minimum_memory_gb: u16,
    maximum_memory_gb: u16,
    expected_memory_gb: u16,
}

const POLICIES: &[Policy] = &[
    Policy {
        key: "rtx_4090",
        display_name: "RTX 4090",
        exact_ids: &["NVIDIA GeForce RTX 4090"],
        priority: 0,
        emergency: false,
        minimum_memory_gb: 16,
        maximum_memory_gb: 32,
        expected_memory_gb: 24,
    },
    Policy {
        key: "rtx_pro_4500_blackwell",
        display_name: "RTX PRO 4500 Blackwell",
        exact_ids: &[],
        priority: 1,
        emergency: false,
        minimum_memory_gb: 16,
        maximum_memory_gb: 32,
        expected_memory_gb: 32,
    },
    Policy {
        key: "rtx_5090",
        display_name: "RTX 5090",
        exact_ids: &["NVIDIA GeForce RTX 5090"],
        priority: 2,
        emergency: false,
        minimum_memory_gb: 16,
        maximum_memory_gb: 32,
        expected_memory_gb: 32,
    },
    Policy {
        key: "rtx_pro_4000_blackwell",
        display_name: "RTX PRO 4000 Blackwell",
        exact_ids: &[],
        priority: 3,
        emergency: false,
        minimum_memory_gb: 16,
        maximum_memory_gb: 32,
        expected_memory_gb: 24,
    },
    Policy {
        key: "l4",
        display_name: "L4",
        exact_ids: &["NVIDIA L4"],
        priority: 4,
        emergency: false,
        minimum_memory_gb: 16,
        maximum_memory_gb: 32,
        expected_memory_gb: 24,
    },
    Policy {
        key: "rtx_a4500",
        display_name: "RTX A4500",
        exact_ids: &["NVIDIA RTX A4500"],
        priority: 5,
        emergency: false,
        minimum_memory_gb: 16,
        maximum_memory_gb: 32,
        expected_memory_gb: 20,
    },
    Policy {
        key: "rtx_4000_ada",
        display_name: "RTX 4000 Ada",
        exact_ids: &["NVIDIA RTX 4000 Ada Generation"],
        priority: 6,
        emergency: false,
        minimum_memory_gb: 16,
        maximum_memory_gb: 32,
        expected_memory_gb: 20,
    },
    Policy {
        key: "a100_pcie",
        display_name: "A100 PCIe",
        exact_ids: &["NVIDIA A100 80GB PCIe"],
        priority: 7,
        emergency: false,
        minimum_memory_gb: 64,
        maximum_memory_gb: 128,
        expected_memory_gb: 80,
    },
    Policy {
        key: "rtx_pro_6000_blackwell_server",
        display_name: "RTX PRO 6000 Blackwell Server Edition",
        exact_ids: &["NVIDIA RTX PRO 6000 Blackwell Server Edition"],
        priority: 8,
        emergency: false,
        minimum_memory_gb: 64,
        maximum_memory_gb: 128,
        expected_memory_gb: 96,
    },
    Policy {
        key: "rtx_pro_6000_blackwell_workstation",
        display_name: "RTX PRO 6000 Blackwell Workstation Edition",
        exact_ids: &["NVIDIA RTX PRO 6000 Blackwell Workstation Edition"],
        priority: 9,
        emergency: false,
        minimum_memory_gb: 64,
        maximum_memory_gb: 128,
        expected_memory_gb: 96,
    },
    Policy {
        key: "rtx_2000_ada",
        display_name: "RTX 2000 Ada",
        exact_ids: &["NVIDIA RTX 2000 Ada Generation"],
        priority: 100,
        emergency: true,
        minimum_memory_gb: 16,
        maximum_memory_gb: 32,
        expected_memory_gb: 16,
    },
];

#[derive(Debug, Clone)]
struct ParsedOffer {
    gpu_id: String,
    policy_key: String,
    display_name: String,
    memory_gb: u16,
    emergency: bool,
    availability: String,
    hourly_price_micro_usd: Option<u64>,
    max_count: u64,
    secure: bool,
}

#[derive(Debug, Clone)]
struct ReceiptPrivate {
    received_instant: Instant,
    catalog_sha256: String,
    include_emergency_tier: bool,
    offers: Vec<ParsedOffer>,
    eu_ro_1_volume_supported: bool,
}

#[derive(Debug, Clone)]
struct CurrentPodProjection {
    pod: Option<NativeGpuSwitchPodV1>,
    observed_at: Option<String>,
    stale: bool,
}

#[derive(Debug, Clone)]
struct ActiveObservation {
    include_emergency_tier: bool,
    superseded: bool,
    /// A foreground final-preflight owns the current inventory authority.  A
    /// background refresh that was already on the wire must not be allowed to
    /// publish a stale terminal event after that preflight promotes its exact
    /// receipt.  This is distinct from ordinary refresh supersession: normal
    /// refreshes still emit one `superseded` event for renderer de-duplication.
    discard_after_action_preflight: bool,
}

#[derive(Debug, Clone)]
struct PendingManualOperation {
    lifecycle_revision: u64,
    result: NativeManualGpuStartResultV1,
}

#[derive(Debug, Clone)]
struct StartRequestIdentity {
    observation_id: String,
    receipt_id: String,
    invocation_observation_id: String,
    invocation_receipt_id: String,
    session_id: String,
    expected_lifecycle_revision: u64,
    requested_target_gpu_id: Option<String>,
    requested_price_micro_usd: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum NormalStartAuthorityKind {
    NormalManualStart,
    NormalAutoStart,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrivateNormalStartAuthorityV1 {
    schema_version: u8,
    kind: NormalStartAuthorityKind,
    operation_id: String,
    observation_id: String,
    receipt_id: String,
    invocation_observation_id: String,
    invocation_receipt_id: String,
    session_id: String,
    expected_lifecycle_revision: u64,
    requested_target_gpu_id: Option<String>,
    requested_price_micro_usd: Option<u64>,
    ordered_gpu_ids_sha256: String,
    request_body_sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum NormalStartPostStateV1 {
    PostSendPending,
    PostSent,
    Settled,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedNormalStartV1 {
    schema_version: u8,
    result: NativeManualGpuStartResultV1,
    authority: PrivateNormalStartAuthorityV1,
    post_state: NormalStartPostStateV1,
}

/// A deliberately tiny, private recovery journal for ordinary Start.  It is
/// separate from the process-bound inventory receipts: a relaunch can display
/// an interrupted Start safely, but it can never revive an old quote or mint a
/// fresh POST from persisted renderer bytes.
#[derive(Debug)]
struct NormalStartJournal {
    root: PathBuf,
    io: Mutex<()>,
}

impl NormalStartJournal {
    fn new(root: PathBuf) -> NativeResult<Self> {
        fs::create_dir_all(&root).map_err(|_| start_store_unavailable())?;
        let metadata = fs::symlink_metadata(&root).map_err(|_| start_store_unavailable())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(start_store_unavailable());
        }
        Ok(Self {
            root,
            io: Mutex::new(()),
        })
    }

    fn current_path(&self) -> PathBuf {
        self.root.join("CURRENT.json")
    }

    fn previous_path(&self) -> PathBuf {
        self.root.join("CURRENT.prev.json")
    }

    fn load(&self) -> NativeResult<Option<PersistedNormalStartV1>> {
        let _guard = self.io.lock().map_err(|_| start_store_unavailable())?;
        let current = self.read_one(&self.current_path());
        match current {
            Ok(Some(record)) => Ok(Some(record)),
            Ok(None) => self.read_one(&self.previous_path()),
            Err(_) => match self.read_one(&self.previous_path()) {
                Ok(Some(record)) => Ok(Some(record)),
                // Do not discard or overwrite damaged evidence. A corrupt
                // journal blocks mutation until an operator can preserve and
                // repair the private app-data directory.
                _ => Err(start_store_unavailable()),
            },
        }
    }

    fn read_one(&self, path: &Path) -> NativeResult<Option<PersistedNormalStartV1>> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(start_store_unavailable()),
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() == 0
            || metadata.len() > MAX_START_JOURNAL_BYTES
        {
            return Err(start_store_unavailable());
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        File::open(path)
            .and_then(|mut file| file.read_to_end(&mut bytes))
            .map_err(|_| start_store_unavailable())?;
        if bytes.len() as u64 != metadata.len() {
            return Err(start_store_unavailable());
        }
        let record: PersistedNormalStartV1 =
            strict_json_decode(&bytes).map_err(|_| start_store_unavailable())?;
        validate_persisted_start(&record)?;
        Ok(Some(record))
    }

    fn persist(&self, record: &PersistedNormalStartV1) -> NativeResult<()> {
        validate_persisted_start(record)?;
        let encoded = serde_json::to_vec(record).map_err(|_| start_store_unavailable())?;
        if encoded.len() as u64 > MAX_START_JOURNAL_BYTES {
            return Err(start_store_unavailable());
        }
        let _guard = self.io.lock().map_err(|_| start_store_unavailable())?;
        let current = self.current_path();
        if current.exists() {
            let prior = self.read_one(&current)?;
            if let Some(prior) = prior {
                let prior_bytes =
                    serde_json::to_vec(&prior).map_err(|_| start_store_unavailable())?;
                write_replace_atomic(&self.previous_path(), &prior_bytes)
                    .map_err(|_| start_store_unavailable())?;
            }
        }
        write_replace_atomic(&current, &encoded).map_err(|_| start_store_unavailable())
    }
}

#[derive(Debug)]
struct InventoryInner {
    current: NativeGpuInventorySnapshotV1,
    active: HashMap<String, ActiveObservation>,
    receipts: HashMap<String, ReceiptPrivate>,
    event_sequence: u64,
    lifecycle_revision: u64,
    pending_manual: HashMap<String, PendingManualOperation>,
    latest_start: Option<PersistedNormalStartV1>,
    current_pod: CurrentPodProjection,
    /// While a foreground Start/Switch final preflight is reading its two
    /// catalog endpoints, ordinary refresh callers coalesce without starting
    /// a competing observation.  The command layer serializes foreground GPU
    /// controls, but background selector polling intentionally does not take
    /// that controller lock, so this lives beside `active`.
    final_preflight_active: bool,
}

/// Releases the small in-memory final-preflight ownership marker even when a
/// provider read or strict parse returns an error.  It intentionally carries
/// no durable authority: a process restart drops it together with receipts.
struct FinalPreflightObservationGuard {
    inner: Arc<Mutex<InventoryInner>>,
}

impl Drop for FinalPreflightObservationGuard {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.final_preflight_active = false;
        }
    }
}

/// Process-scoped inventory journal. It intentionally owns no durable state:
/// receipt authority is invalid after relaunch even if a renderer saved an old
/// snapshot in browser storage.
#[derive(Clone)]
pub struct GpuInventoryService {
    process_epoch_id: String,
    inner: Arc<Mutex<InventoryInner>>,
    start_journal: Arc<NormalStartJournal>,
}

impl GpuInventoryService {
    pub fn new() -> NativeResult<Self> {
        Self::with_journal_root(default_start_journal_root()?)
    }

    fn with_journal_root(root: PathBuf) -> NativeResult<Self> {
        let start_journal = Arc::new(NormalStartJournal::new(root)?);
        let mut latest_start = start_journal.load()?;
        if latest_start.as_ref().is_some_and(|record| {
            matches!(record.post_state, NormalStartPostStateV1::PostSent)
                && record.result.state == "create_intent"
        }) {
            let prior = latest_start.as_ref().ok_or_else(start_store_unavailable)?;
            let recovered = start_result_transition(
                prior,
                "create_uncertain",
                None,
                None,
                Some(start_issue("gpu_start_create_uncertain")),
            )?;
            start_journal.persist(&recovered)?;
            latest_start = Some(recovered);
        }
        let lifecycle_revision = latest_start
            .as_ref()
            .map(|record| record.result.lifecycle_revision)
            .unwrap_or(0);
        let process_epoch_id = Uuid::new_v4().to_string();
        let observation_id = Uuid::new_v4().to_string();
        let current = loading_snapshot(&process_epoch_id, &observation_id, false);
        let mut pending_manual = HashMap::new();
        if let Some(record) = latest_start
            .as_ref()
            .filter(|record| record.result.state == "price_attention")
        {
            pending_manual.insert(
                record.result.operation_id.clone(),
                PendingManualOperation {
                    lifecycle_revision: record.result.lifecycle_revision,
                    result: record.result.clone(),
                },
            );
        }
        Ok(Self {
            process_epoch_id,
            inner: Arc::new(Mutex::new(InventoryInner {
                current,
                active: HashMap::new(),
                receipts: HashMap::new(),
                event_sequence: 0,
                lifecycle_revision,
                pending_manual,
                latest_start,
                current_pod: CurrentPodProjection {
                    pod: None,
                    observed_at: None,
                    stale: false,
                },
                final_preflight_active: false,
            })),
            start_journal,
        })
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(root: PathBuf) -> NativeResult<Self> {
        Self::with_journal_root(root)
    }

    pub fn load(&self) -> NativeResult<NativeGpuInventorySnapshotV1> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| state_error())?
            .current
            .clone())
    }

    pub fn process_epoch_id(&self) -> String {
        self.process_epoch_id.clone()
    }

    /// A bound profile rebind invalidates all selector receipts/current-Pod
    /// evidence without issuing network I/O. Background observations from the
    /// prior binding are removed so they cannot publish a catalog or Pod join
    /// after the new profile takes effect.
    pub(crate) fn reset_for_profile_binding(&self) -> NativeResult<()> {
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        inner.active.clear();
        inner.receipts.clear();
        inner.current_pod = CurrentPodProjection {
            pod: None,
            observed_at: None,
            stale: false,
        };
        inner.current =
            loading_snapshot(&self.process_epoch_id, &Uuid::new_v4().to_string(), false);
        Ok(())
    }

    /// Return only the receipt-bound safe selection evidence needed to draft a
    /// GPU switch. This is deliberately a read-only, process-local bridge:
    /// the switch command still performs its own final worker/profile/provider
    /// proof before any remote mutation.
    pub fn switch_begin_evidence(
        &self,
        observation_id: &str,
        receipt_id: &str,
        target_gpu_id: &str,
        confirmed_hourly_price_micro_usd: u64,
    ) -> NativeResult<super::gpu_switch::NativeGpuSwitchSelectionEvidenceV1> {
        let _receipt = self.receipt_for(observation_id, receipt_id).map_err(|_| {
            NativeError::new(
                "gpu_switch_inventory_receipt_invalid",
                "The selected GPU observation is no longer valid.",
            )
        })?;
        let inner = self.inner.lock().map_err(|_| state_error())?;
        let snapshot = &inner.current;
        let receipt_matches = snapshot
            .receipt
            .as_ref()
            .is_some_and(|receipt| receipt.receipt_id == receipt_id)
            && snapshot.observation_id == observation_id
            && snapshot.state == "ready";
        if !receipt_matches {
            return Err(NativeError::new(
                "gpu_switch_inventory_receipt_invalid",
                "The selected GPU observation is no longer valid.",
            ));
        }
        let old_pod = snapshot
            .current_pod
            .clone()
            .filter(|_| !snapshot.current_pod_stale)
            .ok_or_else(|| {
                NativeError::new(
                    "gpu_switch_current_pod_unverified",
                    "The current GPU Pod must be verified before switching.",
                )
            })?;
        let offer = snapshot
            .offers
            .iter()
            .find(|offer| offer.gpu_id == target_gpu_id)
            .filter(|offer| offer.selectable)
            .ok_or_else(|| {
                NativeError::new(
                    "gpu_switch_target_unavailable",
                    "The selected GPU is no longer available.",
                )
            })?;
        if offer.hourly_price_micro_usd != Some(confirmed_hourly_price_micro_usd) {
            return Err(NativeError::new(
                "gpu_switch_price_changed",
                "The selected GPU price changed. Confirm the current price.",
            ));
        }
        let inventory_observed_at = snapshot.observed_at.clone().ok_or_else(|| {
            NativeError::new(
                "gpu_switch_inventory_receipt_invalid",
                "The selected GPU observation is no longer valid.",
            )
        })?;
        let inventory_catalog_sha256 = snapshot
            .receipt
            .as_ref()
            .map(|receipt| receipt.catalog_sha256.clone())
            .ok_or_else(|| {
                NativeError::new(
                    "gpu_switch_inventory_receipt_invalid",
                    "The selected GPU observation is no longer valid.",
                )
            })?;
        Ok(super::gpu_switch::NativeGpuSwitchSelectionEvidenceV1 {
            old_pod,
            target_gpu_display_name: offer.display_name.clone(),
            inventory_observed_at,
            inventory_catalog_sha256,
        })
    }

    /// Re-read the native catalog immediately before `confirm_target` mutates
    /// the switch journal. This closes the renderer-refresh-to-command race:
    /// stale or changed target evidence produces an action error before any
    /// worker/provider mutation or durable switch confirmation.
    pub(crate) async fn fresh_switch_target_evidence(
        &self,
        app: AppHandle,
        runpod: &RunPodTransport,
        observation_id: &str,
        receipt_id: &str,
        target_gpu_id: &str,
        confirmed_hourly_price_micro_usd: u64,
    ) -> NativeResult<NativeGpuSwitchFreshSelectionV1> {
        let initial = self.receipt_for(observation_id, receipt_id).map_err(|_| {
            NativeError::new(
                "gpu_switch_inventory_receipt_invalid",
                "The selected GPU observation is no longer valid.",
            )
        })?;
        // This action is serialized with every Switch command by the shared
        // profile-control gate.  Selector polling does not take that gate, so
        // claim the inventory authority before the two provider GETs.  Any
        // already-started background read is discarded on completion rather
        // than overwriting or emitting after this action's exact receipt.
        let _preflight = self.begin_final_preflight_observation()?;
        let fresh = self
            .final_observation(runpod, initial.include_emergency_tier)
            .await?;
        // Promotion is intentionally before the derived evidence check: even
        // a changed target must replace stale UI inventory with the exact
        // native observation that caused the rejection.
        self.promote_final_snapshot(app, &fresh)?;
        let fresh_receipt_id = fresh
            .receipt
            .as_ref()
            .map(|receipt| receipt.receipt_id.clone())
            .ok_or_else(|| {
                NativeError::new(
                    "gpu_switch_inventory_receipt_invalid",
                    "The selected GPU observation is no longer valid.",
                )
            })?;
        let evidence = self
            .switch_begin_evidence(
                &fresh.observation_id,
                &fresh_receipt_id,
                target_gpu_id,
                confirmed_hourly_price_micro_usd,
            )
            .map_err(|error| match error.code {
                "gpu_switch_target_unavailable" | "gpu_switch_price_changed" => error,
                _ => NativeError::new(
                    "gpu_switch_inventory_receipt_invalid",
                    "The selected GPU observation is no longer valid.",
                ),
            })?;
        Ok(NativeGpuSwitchFreshSelectionV1 {
            observation_id: fresh.observation_id,
            receipt_id: fresh_receipt_id,
            evidence,
        })
    }

    /// Revalidate a replacement target after the old Pod is proven absent.
    /// This shares the foreground-final-observation authority with Start and
    /// target confirmation, but intentionally omits the current-Pod join.
    pub(crate) async fn fresh_switch_replacement_target(
        &self,
        app: AppHandle,
        runpod: &RunPodTransport,
        observation_id: &str,
        receipt_id: &str,
        target_gpu_id: &str,
        confirmed_hourly_price_micro_usd: u64,
    ) -> NativeResult<NativeGpuSwitchFreshTargetV1> {
        let initial = self.receipt_for(observation_id, receipt_id).map_err(|_| {
            NativeError::new(
                "gpu_switch_inventory_receipt_invalid",
                "The selected GPU observation is no longer valid.",
            )
        })?;
        let initial_offer = initial
            .offers
            .iter()
            .find(|offer| {
                offer.gpu_id == target_gpu_id && offer.availability != "none" && offer.max_count > 0
            })
            .ok_or_else(|| {
                NativeError::new(
                    "gpu_switch_target_unavailable",
                    "The selected GPU is no longer available.",
                )
            })?;
        if initial_offer.hourly_price_micro_usd != Some(confirmed_hourly_price_micro_usd) {
            return Err(NativeError::new(
                "gpu_switch_price_changed",
                "The selected GPU price changed. Confirm the current price.",
            ));
        }
        let _preflight = self.begin_final_preflight_observation()?;
        let fresh = self
            .final_observation(runpod, initial.include_emergency_tier)
            .await?;
        self.promote_final_snapshot(app, &fresh)?;
        let fresh_receipt_id = fresh
            .receipt
            .as_ref()
            .map(|receipt| receipt.receipt_id.clone())
            .ok_or_else(|| {
                NativeError::new(
                    "gpu_switch_inventory_receipt_invalid",
                    "The selected GPU observation is no longer valid.",
                )
            })?;
        let fresh_private = self.receipt_for(&fresh.observation_id, &fresh_receipt_id)?;
        let offer = fresh_private
            .offers
            .iter()
            .find(|offer| {
                offer.gpu_id == target_gpu_id && offer.availability != "none" && offer.max_count > 0
            })
            .ok_or_else(|| {
                NativeError::new(
                    "gpu_switch_target_unavailable",
                    "The selected GPU is no longer available.",
                )
            })?;
        if offer.hourly_price_micro_usd != Some(confirmed_hourly_price_micro_usd) {
            return Err(NativeError::new(
                "gpu_switch_price_changed",
                "The selected GPU price changed. Confirm the current price.",
            ));
        }
        let inventory_observed_at = fresh.observed_at.clone().ok_or_else(|| {
            NativeError::new(
                "gpu_switch_inventory_receipt_invalid",
                "The selected GPU observation is no longer valid.",
            )
        })?;
        Ok(NativeGpuSwitchFreshTargetV1 {
            observation_id: fresh.observation_id,
            receipt_id: fresh_receipt_id,
            target_gpu_display_name: offer.display_name.clone(),
            inventory_observed_at,
        })
    }

    /// This deliberately has no provider I/O.  It is the only renderer read
    /// path for an interrupted ordinary Start after the app relaunches.
    pub fn start_load(&self) -> NativeResult<Option<NativeManualGpuStartResultV1>> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| state_error())?
            .latest_start
            .as_ref()
            .map(|record| record.result.clone()))
    }

    /// Lifecycle polling may already be in flight for the studio.  It joins
    /// that authoritative safe projection here instead of giving selector
    /// polling another provider path.  A malformed/ambiguous list deliberately
    /// retains the last identity as stale rather than guessing that no Pod
    /// exists.
    pub fn observe_current_pod_list(&self, body: &str) -> NativeResult<()> {
        let projection = parse_current_pod_projection(body);
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        match projection {
            Ok(pod) => {
                inner.current_pod = CurrentPodProjection {
                    pod,
                    observed_at: Some(utc_now_rfc3339_millis()?),
                    stale: false,
                };
            }
            Err(()) => {
                inner.current_pod.stale = true;
            }
        }
        let current_pod = inner.current_pod.clone();
        apply_current_pod_projection(&mut inner.current, &current_pod);
        Ok(())
    }

    pub fn mark_current_pod_stale(&self) -> NativeResult<()> {
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        inner.current_pod.stale = true;
        let current_pod = inner.current_pod.clone();
        apply_current_pod_projection(&mut inner.current, &current_pod);
        Ok(())
    }

    /// Join the separately-authoritative profile-scoped Pod observation into
    /// the selector snapshot. This accepts only the already validated native
    /// projection from `gpu_pod`; it neither reads a catalog nor creates a
    /// selector receipt.
    pub(crate) fn replace_current_pod_projection(
        &self,
        pod: Option<NativeGpuSwitchPodV1>,
        observed_at: Option<String>,
        stale: bool,
    ) -> NativeResult<()> {
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        inner.current_pod = CurrentPodProjection {
            pod,
            observed_at,
            stale,
        };
        let current_pod = inner.current_pod.clone();
        apply_current_pod_projection(&mut inner.current, &current_pod);
        Ok(())
    }

    fn observe_created_pod(&self, pod: NativeGpuSwitchPodV1) -> NativeResult<()> {
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        inner.current_pod = CurrentPodProjection {
            pod: Some(pod),
            observed_at: Some(utc_now_rfc3339_millis()?),
            stale: false,
        };
        let current_pod = inner.current_pod.clone();
        apply_current_pod_projection(&mut inner.current, &current_pod);
        Ok(())
    }

    pub fn begin_refresh(
        &self,
        app: AppHandle,
        runpod: RunPodTransport,
        include_emergency_tier: bool,
    ) -> NativeResult<NativeGpuInventorySnapshotV1> {
        runpod.assert_catalog_credential()?;
        let (snapshot, observation_id) = self.reserve_observation(include_emergency_tier)?;
        let Some(observation_id) = observation_id else {
            return Ok(snapshot);
        };
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            let (datacenters, gpus) = tokio::join!(
                runpod.native_catalog_datacenters(),
                runpod.native_catalog_gpus(),
            );
            service.finish_observation(app, runpod, observation_id, datacenters, gpus);
        });
        Ok(snapshot)
    }

    /// Reserve a coalesced observation before any I/O. Keeping this small
    /// state transition separate makes the one-observation/two-GET invariant
    /// auditable and testable without a provider.
    fn reserve_observation(
        &self,
        include_emergency_tier: bool,
    ) -> NativeResult<(NativeGpuInventorySnapshotV1, Option<String>)> {
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        if inner.final_preflight_active {
            // A foreground final preflight is the newer observation authority
            // for both selector policies.  Do not launch another catalog read
            // that could race its promoted receipt.
            return Ok((inner.current.clone(), None));
        }
        if inner.active.iter().any(|(_, active)| {
            !active.superseded && active.include_emergency_tier == include_emergency_tier
        }) {
            return Ok((inner.current.clone(), None));
        }
        for active in inner.active.values_mut() {
            active.superseded = true;
        }
        let observation_id = Uuid::new_v4().to_string();
        let snapshot = loading_snapshot(
            &self.process_epoch_id,
            &observation_id,
            include_emergency_tier,
        );
        inner.active.insert(
            observation_id.clone(),
            ActiveObservation {
                include_emergency_tier,
                superseded: false,
                discard_after_action_preflight: false,
            },
        );
        inner.current = snapshot.clone();
        Ok((snapshot, Some(observation_id)))
    }

    fn finish_observation(
        &self,
        app: AppHandle,
        runpod: RunPodTransport,
        observation_id: String,
        datacenters: NativeResult<super::runpod::NativeCatalogBody>,
        gpus: NativeResult<super::runpod::NativeCatalogBody>,
    ) {
        let Some((include_emergency_tier, superseded)) =
            self.take_background_observation_for_completion(&observation_id)
        else {
            return;
        };
        let terminal = self.terminal_snapshot(
            &runpod,
            &observation_id,
            include_emergency_tier,
            datacenters,
            gpus,
        );
        let Ok(snapshot) = terminal else {
            // `terminal_snapshot` deliberately converts all expected provider
            // failures into a strict terminal projection. This branch is only
            // for impossible local-state failures and must not manufacture an
            // event with an unsafe body.
            return;
        };
        let event = match self.inner.lock() {
            Ok(mut inner) => {
                if inner.event_sequence >= MAX_SAFE_INTEGER {
                    return;
                }
                inner.event_sequence += 1;
                if !superseded {
                    inner.current = snapshot.clone();
                }
                NativeGpuInventoryEventV1 {
                    schema_version: 1,
                    event: GPU_INVENTORY_EVENT,
                    process_epoch_id: self.process_epoch_id.clone(),
                    observation_id: observation_id.clone(),
                    event_sequence: inner.event_sequence,
                    superseded,
                    snapshot,
                }
            }
            Err(_) => return,
        };
        // App-scoped events are intentionally not persisted or replayed.
        let _ = app.emit(GPU_INVENTORY_EVENT, event);
    }

    /// Enter foreground final-preflight ordering before any catalog I/O.  This
    /// is deliberately independent of the renderer's background-refresh
    /// coalescing: callers such as `confirm_target` must be able to replace a
    /// stale quote atomically, while an earlier asynchronous refresh must not
    /// subsequently publish an older terminal snapshot.
    fn begin_final_preflight_observation(&self) -> NativeResult<FinalPreflightObservationGuard> {
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        if inner.final_preflight_active {
            return Err(NativeError::retryable(
                "gpu_inventory_refresh_in_progress",
                "A final GPU inventory check is already in progress. Wait for it to finish.",
            ));
        }
        inner.final_preflight_active = true;
        for active in inner.active.values_mut() {
            active.superseded = true;
            active.discard_after_action_preflight = true;
        }
        Ok(FinalPreflightObservationGuard {
            inner: Arc::clone(&self.inner),
        })
    }

    /// Atomically consume one background observation completion.  A final
    /// foreground preflight may have already promoted a newer receipt, in
    /// which case the older worker is intentionally discarded before parsing,
    /// registry replacement, current-snapshot replacement, or event emission.
    /// Keeping this decision before `terminal_snapshot` also prevents a stale
    /// catalog from replacing the live dynamic-GPU registry.
    fn take_background_observation_for_completion(
        &self,
        observation_id: &str,
    ) -> Option<(bool, bool)> {
        let mut inner = self.inner.lock().ok()?;
        let active = inner.active.remove(observation_id)?;
        if active.discard_after_action_preflight {
            return None;
        }
        Some((active.include_emergency_tier, active.superseded))
    }

    fn terminal_snapshot(
        &self,
        runpod: &RunPodTransport,
        observation_id: &str,
        include_emergency_tier: bool,
        datacenters: NativeResult<super::runpod::NativeCatalogBody>,
        gpus: NativeResult<super::runpod::NativeCatalogBody>,
    ) -> NativeResult<NativeGpuInventorySnapshotV1> {
        let datacenters = match datacenters {
            Ok(body) => body,
            Err(_) => {
                return Ok(fallback_snapshot(
                    &self.process_epoch_id,
                    observation_id,
                    include_emergency_tier,
                    "gpu_inventory_datacenters_unavailable",
                ))
            }
        };
        let gpus = match gpus {
            Ok(body) => body,
            Err(_) => {
                return Ok(fallback_snapshot(
                    &self.process_epoch_id,
                    observation_id,
                    include_emergency_tier,
                    "gpu_inventory_gpus_unavailable",
                ))
            }
        };
        let volume_supported = match parse_datacenter_support(&datacenters.body) {
            Ok(value) => value,
            Err(ParseFailure::Invalid) => {
                return Ok(error_snapshot(
                    &self.process_epoch_id,
                    observation_id,
                    include_emergency_tier,
                    "gpu_inventory_response_invalid",
                ))
            }
            Err(ParseFailure::RegionUnsupported) => {
                return Ok(error_snapshot(
                    &self.process_epoch_id,
                    observation_id,
                    include_emergency_tier,
                    "gpu_inventory_region_unsupported",
                ))
            }
        };
        let parsed = match parse_gpu_catalog(&gpus.body, include_emergency_tier) {
            Ok(value) => value,
            Err(_) => {
                return Ok(error_snapshot(
                    &self.process_epoch_id,
                    observation_id,
                    include_emergency_tier,
                    "gpu_inventory_response_invalid",
                ))
            }
        };
        runpod.native_replace_dynamic_catalog(parsed.dynamic_catalog)?;
        let catalog_sha256 =
            catalog_sha256(include_emergency_tier, volume_supported, &parsed.offers)?;
        let observed_at = utc_now_rfc3339_millis()?;
        let receipt_id = Uuid::new_v4().to_string();
        let receipt = NativeGpuInventoryReceiptV1 {
            schema_version: 1,
            receipt_id: receipt_id.clone(),
            process_epoch_id: self.process_epoch_id.clone(),
            received_at: observed_at.clone(),
            valid_for_ms: RECEIPT_VALID_FOR_MS,
            catalog_sha256: catalog_sha256.clone(),
        };
        let mut snapshot = if parsed.offers.is_empty() {
            NativeGpuInventorySnapshotV1 {
                schema_version: 1,
                observation_id: observation_id.to_owned(),
                process_epoch_id: self.process_epoch_id.clone(),
                include_emergency_tier,
                state: "empty".to_owned(),
                observed_at: Some(observed_at),
                receipt: Some(receipt),
                offers: Vec::new(),
                current_pod: None,
                current_pod_observed_at: None,
                current_pod_stale: false,
                issue: None,
            }
        } else {
            let offers = parsed
                .offers
                .iter()
                .map(|offer| live_offer(observation_id, &receipt_id, &observed_at, offer))
                .collect();
            NativeGpuInventorySnapshotV1 {
                schema_version: 1,
                observation_id: observation_id.to_owned(),
                process_epoch_id: self.process_epoch_id.clone(),
                include_emergency_tier,
                state: "ready".to_owned(),
                observed_at: Some(observed_at),
                receipt: Some(receipt),
                offers,
                current_pod: None,
                current_pod_observed_at: None,
                current_pod_stale: false,
                issue: None,
            }
        };
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        inner.receipts.insert(
            receipt_id,
            ReceiptPrivate {
                received_instant: Instant::now(),
                catalog_sha256,
                include_emergency_tier,
                offers: parsed.offers,
                eu_ro_1_volume_supported: volume_supported,
            },
        );
        // Receipt mappings are process-local. Keep the bounded recent window
        // only; expired values never regain authority.
        inner.receipts.retain(|_, receipt| {
            receipt.received_instant.elapsed().as_millis() < RECEIPT_VALID_FOR_MS as u128
        });
        let current_pod = inner.current_pod.clone();
        apply_current_pod_projection(&mut snapshot, &current_pod);
        Ok(snapshot)
    }

    async fn final_observation(
        &self,
        runpod: &RunPodTransport,
        include_emergency_tier: bool,
    ) -> NativeResult<NativeGpuInventorySnapshotV1> {
        let observation_id = Uuid::new_v4().to_string();
        let (datacenters, gpus) = tokio::join!(
            runpod.native_catalog_datacenters(),
            runpod.native_catalog_gpus(),
        );
        let snapshot = self.terminal_snapshot(
            runpod,
            &observation_id,
            include_emergency_tier,
            datacenters,
            gpus,
        )?;
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        inner.current = snapshot.clone();
        Ok(snapshot)
    }

    /// Final Start preflight is deliberately separate from background refresh.
    /// It maps the complete pinned transport matrix to the public action-code
    /// registry and never emits an inventory event or mutates lifecycle state.
    async fn final_observation_for_start(
        &self,
        app: AppHandle,
        runpod: &RunPodTransport,
        include_emergency_tier: bool,
    ) -> NativeResult<NativeGpuInventorySnapshotV1> {
        // Ordinary Start has the same freshness boundary as Switch: selector
        // polling cannot be allowed to publish a stale catalog after this
        // explicit foreground preflight promotes the authoritative receipt.
        let _preflight = self.begin_final_preflight_observation()?;
        let observation_id = Uuid::new_v4().to_string();
        let (datacenters, gpus) = tokio::join!(
            runpod.native_catalog_datacenters(),
            runpod.native_catalog_gpus(),
        );
        let datacenters = datacenters.map_err(|error| map_catalog_preflight_error(&error, true))?;
        let gpus = gpus.map_err(|error| map_catalog_preflight_error(&error, false))?;
        let snapshot = self.terminal_snapshot(
            runpod,
            &observation_id,
            include_emergency_tier,
            Ok(datacenters),
            Ok(gpus),
        )?;
        self.promote_final_snapshot(app, &snapshot)?;
        match snapshot.state.as_str() {
            "ready" => {
                if !snapshot.offers.iter().any(|offer| offer.selectable) {
                    return Err(no_eligible_gpu());
                }
                Ok(snapshot)
            }
            "empty" => Err(no_eligible_gpu()),
            "fallback" => Err(
                match snapshot.issue.as_ref().map(|issue| issue.code.as_str()) {
                    Some("gpu_inventory_datacenters_unavailable") => datacenters_unavailable(),
                    Some("gpu_inventory_gpus_unavailable") => gpus_unavailable(),
                    _ => provider_unavailable(),
                },
            ),
            "error" => Err(
                match snapshot.issue.as_ref().map(|issue| issue.code.as_str()) {
                    Some("gpu_inventory_region_unsupported") => region_unsupported(),
                    _ => inventory_response_invalid(),
                },
            ),
            _ => Err(inventory_response_invalid()),
        }
    }

    fn promote_final_snapshot(
        &self,
        app: AppHandle,
        snapshot: &NativeGpuInventorySnapshotV1,
    ) -> NativeResult<()> {
        let event = {
            let mut inner = self.inner.lock().map_err(|_| state_error())?;
            if inner.event_sequence >= MAX_SAFE_INTEGER {
                return Err(state_error());
            }
            inner.current = snapshot.clone();
            inner.event_sequence += 1;
            NativeGpuInventoryEventV1 {
                schema_version: 1,
                event: GPU_INVENTORY_EVENT,
                process_epoch_id: self.process_epoch_id.clone(),
                observation_id: snapshot.observation_id.clone(),
                event_sequence: inner.event_sequence,
                superseded: false,
                snapshot: snapshot.clone(),
            }
        };
        let _ = app.emit(GPU_INVENTORY_EVENT, event);
        Ok(())
    }

    pub async fn start_selected<F>(
        &self,
        app: AppHandle,
        runpod: RunPodTransport,
        input: NativeManualGpuStartV1,
        consume_foreground_authority: F,
    ) -> NativeResult<NativeManualGpuStartResultV1>
    where
        F: FnOnce() -> NativeResult<()>,
    {
        validate_manual_input(&input)?;
        if let Some(replay) = self.replay_or_block_manual(&input)? {
            return Ok(replay);
        }
        let initial = self.validate_manual_selection(&input)?;
        let fresh = self
            .final_observation_for_start(app, &runpod, initial.include_emergency_tier)
            .await?;
        let Some(offer) = fresh
            .offers
            .iter()
            .find(|offer| offer.gpu_id == input.target_gpu_id)
        else {
            return Err(target_changed());
        };
        if !offer.selectable {
            return Err(target_changed());
        }
        if offer.hourly_price_micro_usd != Some(input.confirmed_hourly_price_micro_usd) {
            return Err(price_changed());
        }
        let fresh_receipt_id = fresh
            .receipt
            .as_ref()
            .map(|receipt| receipt.receipt_id.clone())
            .ok_or_else(inventory_receipt_invalid)?;
        runpod.native_preflight_no_managed_pod().await?;
        // The native modal grant is intentionally consumed only after every
        // read-only final check has succeeded and immediately before the
        // durable create-intent / provider-POST boundary.  A slow provider
        // preflight therefore cannot turn an old click into a later create.
        consume_foreground_authority()?;
        self.create_with_order(
            runpod,
            NormalStartAuthorityKind::NormalManualStart,
            vec![input.target_gpu_id.clone()],
            input.confirmed_hourly_price_micro_usd,
            StartRequestIdentity {
                observation_id: fresh.observation_id,
                receipt_id: fresh_receipt_id,
                invocation_observation_id: input.observation_id,
                invocation_receipt_id: input.receipt_id,
                session_id: input.session_id,
                expected_lifecycle_revision: input.expected_lifecycle_revision,
                requested_target_gpu_id: Some(input.target_gpu_id),
                requested_price_micro_usd: Some(input.confirmed_hourly_price_micro_usd),
            },
        )
        .await
    }

    pub async fn start_auto<F>(
        &self,
        app: AppHandle,
        runpod: RunPodTransport,
        input: NativeAutoGpuStartV1,
        consume_foreground_authority: F,
    ) -> NativeResult<NativeManualGpuStartResultV1>
    where
        F: FnOnce() -> NativeResult<()>,
    {
        validate_auto_input(&input)?;
        if let Some(replay) = self.replay_or_block_auto(&input)? {
            return Ok(replay);
        }
        let initial = self.validate_auto_selection(&input)?;
        let initial_order = auto_order(&initial.offers);
        if initial_order.is_empty() {
            return Err(no_eligible_gpu());
        }
        let fresh = self
            .final_observation_for_start(app, &runpod, initial.include_emergency_tier)
            .await?;
        let fresh_receipt_id = fresh
            .receipt
            .as_ref()
            .map(|receipt| receipt.receipt_id.clone())
            .ok_or_else(inventory_receipt_invalid)?;
        let fresh_private = self.receipt_for(&fresh.observation_id, &fresh_receipt_id)?;
        let fresh_order = auto_order(&fresh_private.offers);
        if fresh_order != initial_order || fresh_order.is_empty() {
            return Err(target_changed());
        }
        let confirmed = fresh_private
            .offers
            .iter()
            .find(|offer| offer.gpu_id == fresh_order[0])
            .and_then(|offer| offer.hourly_price_micro_usd)
            .ok_or_else(inventory_receipt_invalid)?;
        runpod.native_preflight_no_managed_pod().await?;
        consume_foreground_authority()?;
        self.create_with_order(
            runpod,
            NormalStartAuthorityKind::NormalAutoStart,
            fresh_order,
            confirmed,
            StartRequestIdentity {
                observation_id: fresh.observation_id,
                receipt_id: fresh_receipt_id,
                invocation_observation_id: input.observation_id,
                invocation_receipt_id: input.receipt_id,
                session_id: input.session_id,
                expected_lifecycle_revision: input.expected_lifecycle_revision,
                requested_target_gpu_id: None,
                requested_price_micro_usd: None,
            },
        )
        .await
    }

    async fn create_with_order(
        &self,
        runpod: RunPodTransport,
        kind: NormalStartAuthorityKind,
        ordered_gpu_ids: Vec<String>,
        confirmed_hourly_price_micro_usd: u64,
        identity: StartRequestIdentity,
    ) -> NativeResult<NativeManualGpuStartResultV1> {
        let operation_id = Uuid::new_v4().to_string();
        let body = create_body(&operation_id, &ordered_gpu_ids);
        let body_jcs = jcs_value(&body)?;
        let request_body_sha256 = sha256_hex(&body_jcs);
        let ordered_gpu_ids_sha256 = sha256_hex(&jcs_string_array(&ordered_gpu_ids)?);
        let intent = PersistedNormalStartV1 {
            schema_version: START_JOURNAL_SCHEMA_VERSION,
            result: NativeManualGpuStartResultV1 {
                schema_version: 1,
                operation_id: operation_id.clone(),
                lifecycle_revision: identity
                    .expected_lifecycle_revision
                    .checked_add(1)
                    .filter(|value| *value <= MAX_SAFE_INTEGER)
                    .ok_or_else(revision_exhausted)?,
                state: "create_intent".to_owned(),
                pod: None,
                confirmed_hourly_price_micro_usd,
                actual_hourly_price_micro_usd: None,
                issue: None,
            },
            authority: PrivateNormalStartAuthorityV1 {
                schema_version: START_JOURNAL_SCHEMA_VERSION,
                kind,
                operation_id: operation_id.clone(),
                observation_id: identity.observation_id,
                receipt_id: identity.receipt_id,
                invocation_observation_id: identity.invocation_observation_id,
                invocation_receipt_id: identity.invocation_receipt_id,
                session_id: identity.session_id,
                expected_lifecycle_revision: identity.expected_lifecycle_revision,
                requested_target_gpu_id: identity.requested_target_gpu_id,
                requested_price_micro_usd: identity.requested_price_micro_usd,
                ordered_gpu_ids_sha256,
                request_body_sha256,
            },
            post_state: NormalStartPostStateV1::PostSendPending,
        };
        self.persist_intent(&intent)?;
        // Commit `post_sent` before passing control to the transport.  If the
        // process dies at any point after this durable transition, Resume can
        // show the exact operation without issuing a second POST.
        let mut sent = intent.clone();
        sent.post_state = NormalStartPostStateV1::PostSent;
        self.persist_replace(&sent, intent.result.lifecycle_revision)?;
        let created = match runpod.native_create_selected_pod(body, body_jcs).await {
            Ok(created) => created,
            Err(error) if error.code == "gpu_start_create_uncertain" => {
                let uncertain = start_result_transition(
                    &sent,
                    "create_uncertain",
                    None,
                    None,
                    Some(start_issue("gpu_start_create_uncertain")),
                )?;
                self.persist_replace(&uncertain, sent.result.lifecycle_revision)?;
                return Ok(uncertain.result);
            }
            Err(error) => return Err(error),
        };
        let mut pod = parse_safe_pod(&created.projected_body)?;
        let actual = parse_created_pod_price(&created.raw_body);
        pod.hourly_price_micro_usd = actual;
        let status = parse_created_pod_status(&created.raw_body).unwrap_or_default();
        let state = if actual == Some(confirmed_hourly_price_micro_usd) {
            if status.eq_ignore_ascii_case("running") {
                "ready"
            } else {
                "provisioning"
            }
        } else {
            "price_attention"
        };
        let issue = if actual == Some(confirmed_hourly_price_micro_usd) {
            None
        } else if actual.is_some() {
            Some(NativeGpuStartIssueV1 {
                code: "gpu_actual_price_changed".to_owned(),
                retryable: false,
            })
        } else {
            Some(NativeGpuStartIssueV1 {
                code: "gpu_actual_price_unavailable".to_owned(),
                retryable: false,
            })
        };
        let settled = start_result_transition(&sent, state, Some(pod), actual, issue)?;
        self.persist_replace(&settled, sent.result.lifecycle_revision)?;
        if let Some(pod) = settled.result.pod.clone() {
            self.observe_created_pod(pod)?;
        }
        Ok(settled.result)
    }

    pub fn confirm_actual_price(
        &self,
        input: NativeManualGpuActualPriceV1,
    ) -> NativeResult<NativeManualGpuStartResultV1> {
        validate_actual_price_input(&input)?;
        let pending = {
            let inner = self.inner.lock().map_err(|_| state_error())?;
            inner
                .pending_manual
                .get(&input.operation_id)
                .cloned()
                .ok_or_else(|| {
                    NativeError::new(
                        "gpu_actual_price_operation_invalid",
                        "The created Pod price confirmation is no longer available.",
                    )
                })?
        };
        if pending.lifecycle_revision != input.expected_lifecycle_revision
            || pending.result.actual_hourly_price_micro_usd
                != Some(input.confirmed_actual_hourly_price_micro_usd)
        {
            return Err(NativeError::new(
                "gpu_actual_price_confirmation_invalid",
                "Confirm the exact current price shown for this created Pod.",
            ));
        }
        let latest = self
            .inner
            .lock()
            .map_err(|_| state_error())?
            .latest_start
            .clone()
            .ok_or_else(start_store_unavailable)?;
        let settled = start_result_transition(
            &latest,
            "provisioning",
            pending.result.pod.clone(),
            pending.result.actual_hourly_price_micro_usd,
            None,
        )?;
        self.persist_replace(&settled, pending.lifecycle_revision)?;
        Ok(settled.result)
    }

    fn replay_or_block_manual(
        &self,
        input: &NativeManualGpuStartV1,
    ) -> NativeResult<Option<NativeManualGpuStartResultV1>> {
        self.replay_or_block(
            NormalStartAuthorityKind::NormalManualStart,
            &input.observation_id,
            &input.receipt_id,
            &input.session_id,
            input.expected_lifecycle_revision,
            Some(&input.target_gpu_id),
            Some(input.confirmed_hourly_price_micro_usd),
        )
    }

    fn replay_or_block_auto(
        &self,
        input: &NativeAutoGpuStartV1,
    ) -> NativeResult<Option<NativeManualGpuStartResultV1>> {
        self.replay_or_block(
            NormalStartAuthorityKind::NormalAutoStart,
            &input.observation_id,
            &input.receipt_id,
            &input.session_id,
            input.expected_lifecycle_revision,
            None,
            None,
        )
    }

    fn replay_or_block(
        &self,
        kind: NormalStartAuthorityKind,
        observation_id: &str,
        receipt_id: &str,
        session_id: &str,
        expected_lifecycle_revision: u64,
        requested_target_gpu_id: Option<&str>,
        requested_price_micro_usd: Option<u64>,
    ) -> NativeResult<Option<NativeManualGpuStartResultV1>> {
        let inner = self.inner.lock().map_err(|_| state_error())?;
        let Some(record) = inner.latest_start.as_ref() else {
            return Ok(None);
        };
        let exact = record.authority.kind == kind
            && record.authority.invocation_observation_id == observation_id
            && record.authority.invocation_receipt_id == receipt_id
            && record.authority.session_id == session_id
            && record.authority.expected_lifecycle_revision == expected_lifecycle_revision
            && record.authority.requested_target_gpu_id.as_deref() == requested_target_gpu_id
            && record.authority.requested_price_micro_usd == requested_price_micro_usd;
        if exact {
            return Ok(Some(record.result.clone()));
        }
        if matches!(
            record.result.state.as_str(),
            "create_intent" | "create_uncertain" | "provisioning" | "price_attention"
        ) {
            return Err(operation_in_progress());
        }
        Ok(None)
    }

    fn persist_intent(&self, record: &PersistedNormalStartV1) -> NativeResult<()> {
        {
            let inner = self.inner.lock().map_err(|_| state_error())?;
            if inner.lifecycle_revision != record.authority.expected_lifecycle_revision {
                return Err(revision_conflict());
            }
            if inner.latest_start.as_ref().is_some_and(|existing| {
                matches!(
                    existing.result.state.as_str(),
                    "create_intent" | "create_uncertain" | "provisioning" | "price_attention"
                )
            }) {
                return Err(operation_in_progress());
            }
        }
        self.start_journal.persist(record)?;
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        if inner.lifecycle_revision != record.authority.expected_lifecycle_revision {
            return Err(revision_conflict());
        }
        inner.lifecycle_revision = record.result.lifecycle_revision;
        inner.latest_start = Some(record.clone());
        Ok(())
    }

    fn persist_replace(
        &self,
        record: &PersistedNormalStartV1,
        expected_revision: u64,
    ) -> NativeResult<()> {
        {
            let inner = self.inner.lock().map_err(|_| state_error())?;
            if inner.lifecycle_revision != expected_revision {
                return Err(revision_conflict());
            }
        }
        self.start_journal.persist(record)?;
        let mut inner = self.inner.lock().map_err(|_| state_error())?;
        if inner.lifecycle_revision != expected_revision {
            return Err(revision_conflict());
        }
        inner.lifecycle_revision = record.result.lifecycle_revision;
        inner.latest_start = Some(record.clone());
        if record.result.state == "price_attention" {
            inner.pending_manual.insert(
                record.result.operation_id.clone(),
                PendingManualOperation {
                    lifecycle_revision: record.result.lifecycle_revision,
                    result: record.result.clone(),
                },
            );
        } else {
            inner.pending_manual.remove(&record.result.operation_id);
        }
        Ok(())
    }

    fn validate_manual_selection(
        &self,
        input: &NativeManualGpuStartV1,
    ) -> NativeResult<ReceiptPrivate> {
        let inner = self.inner.lock().map_err(|_| state_error())?;
        if inner.lifecycle_revision != input.expected_lifecycle_revision {
            return Err(revision_conflict());
        }
        let receipt = receipt_for_inner(
            &inner,
            &self.process_epoch_id,
            &input.observation_id,
            &input.receipt_id,
        )?;
        let Some(offer) = receipt
            .offers
            .iter()
            .find(|offer| offer.gpu_id == input.target_gpu_id)
        else {
            return Err(target_changed());
        };
        if offer.hourly_price_micro_usd != Some(input.confirmed_hourly_price_micro_usd) {
            return Err(price_changed());
        }
        if offer.availability == "none" || offer.max_count == 0 {
            return Err(target_changed());
        }
        Ok(receipt)
    }

    fn validate_auto_selection(
        &self,
        input: &NativeAutoGpuStartV1,
    ) -> NativeResult<ReceiptPrivate> {
        let inner = self.inner.lock().map_err(|_| state_error())?;
        if inner.lifecycle_revision != input.expected_lifecycle_revision {
            return Err(revision_conflict());
        }
        receipt_for_inner(
            &inner,
            &self.process_epoch_id,
            &input.observation_id,
            &input.receipt_id,
        )
    }

    fn receipt_for(&self, observation_id: &str, receipt_id: &str) -> NativeResult<ReceiptPrivate> {
        let inner = self.inner.lock().map_err(|_| state_error())?;
        receipt_for_inner(&inner, &self.process_epoch_id, observation_id, receipt_id)
    }
}

fn receipt_for_inner(
    inner: &InventoryInner,
    process_epoch_id: &str,
    observation_id: &str,
    receipt_id: &str,
) -> NativeResult<ReceiptPrivate> {
    validate_uuid(observation_id, "gpu_start_inventory_receipt_invalid")?;
    validate_uuid(receipt_id, "gpu_start_inventory_receipt_invalid")?;
    if inner.current.process_epoch_id != process_epoch_id
        || inner.current.observation_id != observation_id
        || inner
            .current
            .receipt
            .as_ref()
            .map(|receipt| receipt.receipt_id.as_str())
            != Some(receipt_id)
    {
        return Err(inventory_receipt_invalid());
    }
    let receipt = inner
        .receipts
        .get(receipt_id)
        .cloned()
        .ok_or_else(inventory_receipt_invalid)?;
    if receipt.received_instant.elapsed().as_millis() >= RECEIPT_VALID_FOR_MS as u128 {
        return Err(inventory_stale());
    }
    if !receipt.eu_ro_1_volume_supported || receipt.catalog_sha256.is_empty() {
        return Err(inventory_receipt_invalid());
    }
    Ok(receipt)
}

fn loading_snapshot(
    process_epoch_id: &str,
    observation_id: &str,
    include_emergency_tier: bool,
) -> NativeGpuInventorySnapshotV1 {
    NativeGpuInventorySnapshotV1 {
        schema_version: 1,
        observation_id: observation_id.to_owned(),
        process_epoch_id: process_epoch_id.to_owned(),
        include_emergency_tier,
        state: "loading".to_owned(),
        observed_at: None,
        receipt: None,
        offers: Vec::new(),
        current_pod: None,
        current_pod_observed_at: None,
        current_pod_stale: false,
        issue: None,
    }
}

fn error_snapshot(
    process_epoch_id: &str,
    observation_id: &str,
    include_emergency_tier: bool,
    code: &str,
) -> NativeGpuInventorySnapshotV1 {
    NativeGpuInventorySnapshotV1 {
        schema_version: 1,
        observation_id: observation_id.to_owned(),
        process_epoch_id: process_epoch_id.to_owned(),
        include_emergency_tier,
        state: "error".to_owned(),
        observed_at: None,
        receipt: None,
        offers: Vec::new(),
        current_pod: None,
        current_pod_observed_at: None,
        current_pod_stale: false,
        issue: Some(NativeGpuInventoryIssueV1 {
            code: code.to_owned(),
            retryable: false,
        }),
    }
}

fn fallback_snapshot(
    process_epoch_id: &str,
    observation_id: &str,
    include_emergency_tier: bool,
    code: &str,
) -> NativeGpuInventorySnapshotV1 {
    let offers = POLICIES
        .iter()
        .filter(|policy| !policy.emergency && !policy.exact_ids.is_empty())
        .map(|policy| GpuSelectorOfferV1 {
            schema_version: 1,
            observation_id: observation_id.to_owned(),
            receipt_id: None,
            gpu_id: policy.exact_ids[0].to_owned(),
            policy_key: policy.key.to_owned(),
            display_name: policy.display_name.to_owned(),
            memory_gb: policy.expected_memory_gb,
            emergency: false,
            availability: "unknown".to_owned(),
            hourly_price_micro_usd: None,
            data_center_id: "EU-RO-1".to_owned(),
            source: "fallback".to_owned(),
            observed_at: None,
            stale: false,
            selectable: false,
            disabled_reason: Some("fallback_only".to_owned()),
            benchmark_state: "unmeasured".to_owned(),
            benchmark_age_ms: None,
            speed_score: None,
            benchmark_median_duration_us: None,
            benchmark_p95_duration_us: None,
            benchmark_measured_at: None,
            benchmark_evidence_sha256: None,
            estimated_switch_remaining_cost_micro_usd: None,
        })
        .collect();
    NativeGpuInventorySnapshotV1 {
        schema_version: 1,
        observation_id: observation_id.to_owned(),
        process_epoch_id: process_epoch_id.to_owned(),
        include_emergency_tier,
        state: "fallback".to_owned(),
        observed_at: None,
        receipt: None,
        offers,
        current_pod: None,
        current_pod_observed_at: None,
        current_pod_stale: false,
        issue: Some(NativeGpuInventoryIssueV1 {
            code: code.to_owned(),
            retryable: true,
        }),
    }
}

fn live_offer(
    observation_id: &str,
    receipt_id: &str,
    observed_at: &str,
    offer: &ParsedOffer,
) -> GpuSelectorOfferV1 {
    let disabled_reason = if offer.availability == "none" || offer.max_count == 0 {
        Some("unavailable".to_owned())
    } else if offer.hourly_price_micro_usd.is_none() {
        Some("price_unavailable".to_owned())
    } else {
        None
    };
    GpuSelectorOfferV1 {
        schema_version: 1,
        observation_id: observation_id.to_owned(),
        receipt_id: Some(receipt_id.to_owned()),
        gpu_id: offer.gpu_id.clone(),
        policy_key: offer.policy_key.clone(),
        display_name: offer.display_name.clone(),
        memory_gb: offer.memory_gb,
        emergency: offer.emergency,
        availability: offer.availability.clone(),
        hourly_price_micro_usd: offer.hourly_price_micro_usd,
        data_center_id: "EU-RO-1".to_owned(),
        source: "live".to_owned(),
        observed_at: Some(observed_at.to_owned()),
        stale: false,
        selectable: disabled_reason.is_none(),
        disabled_reason,
        benchmark_state: "unmeasured".to_owned(),
        benchmark_age_ms: None,
        speed_score: None,
        benchmark_median_duration_us: None,
        benchmark_p95_duration_us: None,
        benchmark_measured_at: None,
        benchmark_evidence_sha256: None,
        estimated_switch_remaining_cost_micro_usd: None,
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ParseFailure {
    Invalid,
    RegionUnsupported,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DataCenterRoot {
    data_centers: Vec<Box<RawValue>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DataCenterEntry {
    id: String,
    network_volume_types: Vec<String>,
}

#[derive(Deserialize)]
struct GpuRoot {
    gpus: Vec<Box<RawValue>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GpuEntry {
    id: String,
    name: String,
    manufacturer: String,
    memory: u16,
    secure: bool,
    price: SecurePrice,
    max_count: SecureMaxCount,
    data_centers: Vec<GpuDataCenter>,
}

#[derive(Deserialize)]
struct SecurePrice {
    secure: Box<RawValue>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecureMaxCount {
    secure: Box<RawValue>,
}

#[derive(Deserialize)]
struct GpuDataCenter {
    id: String,
    availability: String,
}

struct ParsedCatalog {
    offers: Vec<ParsedOffer>,
    dynamic_catalog: HashMap<String, String>,
}

fn parse_datacenter_support(body: &str) -> Result<bool, ParseFailure> {
    let root: DataCenterRoot = serde_json::from_str(body).map_err(|_| ParseFailure::Invalid)?;
    let mut found = false;
    for raw in root.data_centers {
        let Ok(entry) = serde_json::from_str::<DataCenterEntry>(raw.get()) else {
            continue;
        };
        if entry.id == "EU-RO-1" {
            if found {
                return Err(ParseFailure::Invalid);
            }
            found = true;
            if !entry.network_volume_types.is_empty()
                && entry
                    .network_volume_types
                    .iter()
                    .all(|value| !value.trim().is_empty())
            {
                return Ok(true);
            }
        }
    }
    if found {
        Err(ParseFailure::RegionUnsupported)
    } else {
        Err(ParseFailure::RegionUnsupported)
    }
}

fn parse_gpu_catalog(
    body: &str,
    include_emergency_tier: bool,
) -> Result<ParsedCatalog, ParseFailure> {
    let root: GpuRoot = serde_json::from_str(body).map_err(|_| ParseFailure::Invalid)?;
    let mut offers = Vec::new();
    let mut dynamic_catalog = HashMap::new();
    let mut seen = HashSet::new();
    for raw in root.gpus {
        let Ok(entry) = serde_json::from_str::<GpuEntry>(raw.get()) else {
            // A malformed sibling row is deliberately unselectable rather
            // than poisoning a valid catalog observation.
            continue;
        };
        let Some(policy) = policy_for(&entry.id, &entry.name, entry.memory, include_emergency_tier)
        else {
            continue;
        };
        if !entry.secure
            || entry.manufacturer != "NVIDIA"
            || !valid_gpu_identity(&entry.id)
            || !valid_gpu_identity(&entry.name)
        {
            continue;
        }
        if !seen.insert(entry.id.clone()) {
            return Err(ParseFailure::Invalid);
        }
        let availability = entry
            .data_centers
            .iter()
            .filter(|data_center| data_center.id == "EU-RO-1")
            .map(|data_center| parse_availability(&data_center.availability))
            .collect::<Option<Vec<_>>>()
            .and_then(|values| (values.len() == 1).then(|| values[0].clone()))
            .unwrap_or_else(|| "none".to_owned());
        // `secure` is mandatory for both fields. A row with a missing, null,
        // string, exponent, fractional count, or unsafe number is malformed
        // and skipped; a valid sibling remains selectable.
        let Some(hourly_price_micro_usd) = parse_nullable_price(entry.price.secure.get()) else {
            continue;
        };
        let Some(max_count) = parse_max_count(entry.max_count.secure.get()) else {
            continue;
        };
        if policy.exact_ids.is_empty() {
            dynamic_catalog.insert(entry.id.clone(), policy.display_name.to_owned());
        }
        offers.push(ParsedOffer {
            gpu_id: entry.id,
            policy_key: policy.key.to_owned(),
            display_name: entry.name,
            memory_gb: entry.memory,
            emergency: policy.emergency,
            availability,
            hourly_price_micro_usd,
            max_count,
            secure: true,
        });
    }
    offers.sort_by(|left, right| {
        policy_priority(&left.policy_key)
            .cmp(&policy_priority(&right.policy_key))
            .then_with(|| left.gpu_id.cmp(&right.gpu_id))
    });
    Ok(ParsedCatalog {
        offers,
        dynamic_catalog,
    })
}

fn policy_for(
    id: &str,
    name: &str,
    memory_gb: u16,
    include_emergency_tier: bool,
) -> Option<&'static Policy> {
    POLICIES.iter().find(|policy| {
        (!policy.emergency || include_emergency_tier)
            && (policy.minimum_memory_gb..=policy.maximum_memory_gb).contains(&memory_gb)
            && if policy.exact_ids.is_empty() {
                name == policy.display_name
            } else {
                policy.exact_ids.contains(&id)
            }
    })
}

fn policy_priority(key: &str) -> u8 {
    POLICIES
        .iter()
        .find(|policy| policy.key == key)
        .map(|policy| policy.priority)
        .unwrap_or(u8::MAX)
}

fn parse_availability(value: &str) -> Option<String> {
    match value {
        "NONE" => Some("none".to_owned()),
        "LOW" => Some("low".to_owned()),
        "MEDIUM" => Some("medium".to_owned()),
        "HIGH" => Some("high".to_owned()),
        _ => None,
    }
}

/// Decodes the precise documented decimal token without a binary float.
fn parse_number_price(token: &str) -> Option<u64> {
    if token.is_empty()
        || token
            .as_bytes()
            .iter()
            .any(|byte| byte.is_ascii_whitespace())
    {
        return None;
    }
    let (whole, fraction) = match token.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (token, None),
    };
    if whole.is_empty()
        || whole.len() > 16
        || !whole.as_bytes().iter().all(u8::is_ascii_digit)
        || (whole.len() > 1 && whole.starts_with('0'))
        || fraction.is_some_and(|value| {
            value.is_empty() || value.len() > 6 || !value.as_bytes().iter().all(u8::is_ascii_digit)
        })
    {
        return None;
    }
    let whole = whole.parse::<u64>().ok()?;
    let fraction = fraction.unwrap_or("0");
    let mut fraction_micro = fraction.parse::<u64>().ok()?;
    for _ in fraction.len()..6 {
        fraction_micro = fraction_micro.checked_mul(10)?;
    }
    whole
        .checked_mul(1_000_000)?
        .checked_add(fraction_micro)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
}

fn parse_nullable_price(token: &str) -> Option<Option<u64>> {
    if token == "null" {
        Some(None)
    } else {
        parse_number_price(token).map(Some)
    }
}

fn parse_max_count(token: &str) -> Option<u64> {
    if token == "null" {
        return Some(0);
    }
    if token.is_empty()
        || token.len() > 16
        || !token.as_bytes().iter().all(u8::is_ascii_digit)
        || (token.len() > 1 && token.starts_with('0'))
    {
        return None;
    }
    token
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
}

fn catalog_sha256(
    include_emergency_tier: bool,
    eu_ro_1_volume_supported: bool,
    offers: &[ParsedOffer],
) -> NativeResult<String> {
    let mut sorted = offers.to_vec();
    sorted.sort_by(|left, right| left.gpu_id.cmp(&right.gpu_id));
    let offers = sorted
        .iter()
        .map(|offer| {
            Ok(format!(
                "{{\"availability\":{},\"display_name\":{},\"emergency\":{},\"gpu_id\":{},\"hourly_price_micro_usd\":{},\"max_count\":{},\"memory_gb\":{},\"policy_key\":{},\"secure\":{}}}",
                json_string(&offer.availability)?,
                json_string(&offer.display_name)?,
                offer.emergency,
                json_string(&offer.gpu_id)?,
                offer.hourly_price_micro_usd.map_or_else(|| "null".to_owned(), |value| value.to_string()),
                offer.max_count,
                offer.memory_gb,
                json_string(&offer.policy_key)?,
                offer.secure,
            ))
        })
        .collect::<NativeResult<Vec<_>>>()?
        .join(",");
    // All values are constrained ASCII strings, booleans, integers or null;
    // this is a direct RFC8785/JCS serialization with lexicographic keys.
    let canonical = format!(
        "{{\"eu_ro_1_volume_supported\":{},\"include_emergency_tier\":{},\"offers\":[{}],\"schema_version\":1}}",
        eu_ro_1_volume_supported, include_emergency_tier, offers
    );
    Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
}

fn json_string(value: &str) -> NativeResult<String> {
    serde_json::to_string(value).map_err(|_| state_error())
}

fn auto_order(offers: &[ParsedOffer]) -> Vec<String> {
    let mut candidates = offers
        .iter()
        .filter(|offer| {
            !offer.emergency
                && offer.availability != "none"
                && offer.max_count > 0
                && offer.hourly_price_micro_usd.is_some()
        })
        .collect::<Vec<_>>();
    // Native benchmark evidence is deliberately not accepted from the
    // renderer. Until a compatible native measured profile is available, the
    // contract's receipt-bearing fixed-policy branch is the only admissible
    // Auto order.
    candidates.sort_by(|left, right| {
        policy_priority(&left.policy_key)
            .cmp(&policy_priority(&right.policy_key))
            .then_with(|| left.gpu_id.cmp(&right.gpu_id))
    });
    candidates
        .into_iter()
        .map(|offer| offer.gpu_id.clone())
        .collect()
}

fn create_body(operation_id: &str, gpu_type_ids: &[String]) -> Value {
    json!({
        "name": format!("imageforge-{operation_id}"),
        "templateId": IMAGEFORGE_TEMPLATE_ID,
        "imageName": IMAGEFORGE_WORKER_IMAGE,
        "networkVolumeId": IMAGEFORGE_NETWORK_VOLUME_ID,
        "volumeMountPath": "/workspace",
        "ports": ["8000/http"],
        "computeType": "GPU",
        "cloudType": "SECURE",
        "gpuTypeIds": gpu_type_ids,
        "gpuTypePriority": "custom",
        "gpuCount": 1,
        "interruptible": false,
        "dataCenterIds": ["EU-RO-1"],
        "allowedCudaVersions": ["13.0"],
        "minRAMPerGPU": 16,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectedPod {
    id: String,
    status: Option<String>,
    gpu: ProjectedPodGpu,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectedPodGpu {
    id: String,
    display_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurrentPodListEntry {
    id: String,
    gpu: ProjectedPodGpu,
    adjusted_cost_per_hr: Option<Box<RawValue>>,
    cost_per_hr: Option<Box<RawValue>>,
}

fn parse_current_pod_projection(body: &str) -> Result<Option<NativeGpuSwitchPodV1>, ()> {
    let pods: Vec<CurrentPodListEntry> = serde_json::from_str(body).map_err(|_| ())?;
    match pods.len() {
        0 => Ok(None),
        1 => {
            let pod = pods.into_iter().next().ok_or(())?;
            if !valid_pod_id(&pod.id)
                || !valid_gpu_identity(&pod.gpu.id)
                || !valid_gpu_identity(&pod.gpu.display_name)
            {
                return Err(());
            }
            let price = match (&pod.adjusted_cost_per_hr, &pod.cost_per_hr) {
                (Some(adjusted), Some(cost)) => {
                    parse_created_price_tokens(adjusted.get(), cost.get())
                }
                _ => None,
            };
            Ok(Some(NativeGpuSwitchPodV1 {
                pod_id: pod.id,
                gpu_id: pod.gpu.id,
                gpu_display_name: pod.gpu.display_name,
                hourly_price_micro_usd: price,
            }))
        }
        _ => Err(()),
    }
}

fn apply_current_pod_projection(
    snapshot: &mut NativeGpuInventorySnapshotV1,
    current: &CurrentPodProjection,
) {
    snapshot.current_pod = current.pod.clone();
    snapshot.current_pod_observed_at = current.observed_at.clone();
    snapshot.current_pod_stale = current.stale;
}

fn parse_safe_pod(body: &str) -> NativeResult<NativeGpuSwitchPodV1> {
    let pod: ProjectedPod = serde_json::from_str(body).map_err(|_| {
        NativeError::new(
            "gpu_start_provider_response_invalid",
            "RunPod returned an invalid created Pod identity.",
        )
    })?;
    let _ = pod.status;
    if !valid_pod_id(&pod.id)
        || !valid_gpu_identity(&pod.gpu.id)
        || !valid_gpu_identity(&pod.gpu.display_name)
    {
        return Err(NativeError::new(
            "gpu_start_provider_response_invalid",
            "RunPod returned an invalid created Pod identity.",
        ));
    }
    Ok(NativeGpuSwitchPodV1 {
        pod_id: pod.id,
        gpu_id: pod.gpu.id,
        gpu_display_name: pod.gpu.display_name,
        hourly_price_micro_usd: None,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCreatedPodPrice {
    adjusted_cost_per_hr: Option<Box<RawValue>>,
    cost_per_hr: Box<RawValue>,
}

fn parse_created_pod_price(body: &str) -> Option<u64> {
    let raw: RawCreatedPodPrice = serde_json::from_str(body).ok()?;
    parse_created_price_tokens(
        raw.adjusted_cost_per_hr
            .as_deref()
            .map(RawValue::get)
            .unwrap_or("null"),
        raw.cost_per_hr.get(),
    )
}

pub(crate) fn parse_created_price_tokens(adjusted: &str, cost: &str) -> Option<u64> {
    // RunPod currently emits `costPerHr` as a JSON number in Pod responses,
    // while older responses used a JSON decimal string. Keep either original
    // decimal token lossless; never route price authority through f64.
    let cost_value: Value = serde_json::from_str(cost).ok()?;
    let cost = match cost_value {
        Value::String(value) => parse_number_price(&value)?,
        Value::Number(_) => parse_number_price(cost)?,
        _ => return None,
    };
    if adjusted == "null" {
        Some(cost)
    } else {
        parse_number_price(adjusted)
    }
}

fn parse_created_pod_status(body: &str) -> Option<String> {
    serde_json::from_str::<Value>(body)
        .ok()?
        .get("status")?
        .as_str()
        .map(str::to_owned)
}

fn validate_manual_input(input: &NativeManualGpuStartV1) -> NativeResult<()> {
    validate_uuid(&input.observation_id, "gpu_start_input_invalid")?;
    validate_uuid(&input.receipt_id, "gpu_start_input_invalid")?;
    validate_uuid(&input.session_id, "gpu_start_input_invalid")?;
    if !valid_gpu_identity(&input.target_gpu_id)
        || input.confirmed_hourly_price_micro_usd > MAX_SAFE_INTEGER
        || input.expected_lifecycle_revision > MAX_SAFE_INTEGER
    {
        return Err(NativeError::new(
            "gpu_start_input_invalid",
            "The selected GPU start input is invalid.",
        ));
    }
    if input.expected_lifecycle_revision == MAX_SAFE_INTEGER {
        return Err(revision_exhausted());
    }
    Ok(())
}

fn validate_auto_input(input: &NativeAutoGpuStartV1) -> NativeResult<()> {
    validate_uuid(&input.observation_id, "gpu_start_input_invalid")?;
    validate_uuid(&input.receipt_id, "gpu_start_input_invalid")?;
    validate_uuid(&input.session_id, "gpu_start_input_invalid")?;
    if input.expected_lifecycle_revision > MAX_SAFE_INTEGER {
        return Err(NativeError::new(
            "gpu_start_input_invalid",
            "The Auto GPU start input is invalid.",
        ));
    }
    if input.expected_lifecycle_revision == MAX_SAFE_INTEGER {
        return Err(revision_exhausted());
    }
    Ok(())
}

fn validate_actual_price_input(input: &NativeManualGpuActualPriceV1) -> NativeResult<()> {
    validate_uuid(&input.operation_id, "gpu_actual_price_input_invalid")?;
    if input.expected_lifecycle_revision > MAX_SAFE_INTEGER
        || input.confirmed_actual_hourly_price_micro_usd > MAX_SAFE_INTEGER
    {
        return Err(NativeError::new(
            "gpu_actual_price_input_invalid",
            "The created Pod price confirmation is invalid.",
        ));
    }
    Ok(())
}

fn validate_uuid(value: &str, code: &'static str) -> NativeResult<()> {
    let parsed = Uuid::parse_str(value)
        .map_err(|_| NativeError::new(code, "A native GPU identifier is invalid."))?;
    if parsed.get_version() != Some(Version::Random) || parsed.to_string() != value {
        return Err(NativeError::new(
            code,
            "A native GPU identifier is invalid.",
        ));
    }
    Ok(())
}

fn valid_gpu_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b' ' | b'.' | b'_' | b'(' | b')' | b'+' | b':' | b'-')
        })
}

fn valid_pod_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 58
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn inventory_receipt_invalid() -> NativeError {
    start_error("gpu_start_inventory_receipt_invalid")
}

fn price_changed() -> NativeError {
    start_error("gpu_start_price_changed")
}

fn target_changed() -> NativeError {
    start_error("gpu_start_target_changed")
}

fn revision_conflict() -> NativeError {
    start_error("gpu_start_revision_conflict")
}

fn revision_exhausted() -> NativeError {
    start_error("gpu_start_revision_exhausted")
}

fn inventory_stale() -> NativeError {
    start_error("gpu_start_inventory_stale")
}

fn operation_in_progress() -> NativeError {
    start_error("gpu_start_operation_in_progress")
}

fn no_eligible_gpu() -> NativeError {
    start_error("gpu_start_no_eligible_gpu")
}

fn datacenters_unavailable() -> NativeError {
    start_error("gpu_start_datacenters_unavailable")
}

fn gpus_unavailable() -> NativeError {
    start_error("gpu_start_gpus_unavailable")
}

fn inventory_response_invalid() -> NativeError {
    start_error("gpu_start_inventory_response_invalid")
}

fn region_unsupported() -> NativeError {
    start_error("gpu_start_region_unsupported")
}

fn provider_unavailable() -> NativeError {
    start_error("gpu_start_provider_unavailable")
}

fn start_store_unavailable() -> NativeError {
    start_error("gpu_start_store_unavailable")
}

fn start_issue(code: &'static str) -> NativeGpuStartIssueV1 {
    NativeGpuStartIssueV1 {
        code: code.to_owned(),
        retryable: false,
    }
}

fn start_error(code: &'static str) -> NativeError {
    let (retryable, message) = match code {
        "gpu_start_revision_conflict" => {
            (true, "GPU start state changed. Reload and choose again.")
        }
        "gpu_start_revision_exhausted" => (
            false,
            "GPU start history reached its safe revision limit. Export recovery evidence before continuing.",
        ),
        "gpu_start_foreground_required" => (
            false,
            "Use the focused ImageForge Start control to authorize this GPU action.",
        ),
        "gpu_start_inventory_stale" => (
            true,
            "Live GPU inventory expired. Refresh GPUs and choose again.",
        ),
        "gpu_start_inventory_receipt_invalid" => (
            false,
            "The GPU inventory receipt is invalid for this app process.",
        ),
        "gpu_start_profile_locked" => (false, "The ImageForge GPU profile changed before Start."),
        "gpu_start_target_changed" => (
            true,
            "The selected GPU changed. Review the refreshed choice.",
        ),
        "gpu_start_price_changed" => (
            true,
            "The selected GPU price changed. Review and confirm the new price.",
        ),
        "gpu_start_existing_pod" => (
            false,
            "An ImageForge Pod already exists. Refresh before starting another.",
        ),
        "gpu_start_operation_in_progress" => (
            true,
            "Another ImageForge GPU operation is already in progress.",
        ),
        "gpu_start_create_uncertain" => (
            false,
            "RunPod may have created the GPU. Resolve this Start before trying again.",
        ),
        "gpu_start_provider_response_invalid" => {
            (false, "RunPod returned an invalid GPU response.")
        }
        "gpu_start_store_unavailable" => (
            true,
            "ImageForge could not access the GPU Start recovery journal.",
        ),
        "gpu_start_datacenters_unavailable" => (
            true,
            "RunPod datacenters are unavailable. Refresh GPUs and try again.",
        ),
        "gpu_start_gpus_unavailable" => (
            true,
            "RunPod GPU inventory is unavailable. Refresh GPUs and try again.",
        ),
        "gpu_start_inventory_response_invalid" => {
            (false, "RunPod returned invalid live GPU inventory.")
        }
        "gpu_start_region_unsupported" => {
            (false, "Secure GPU inventory is unavailable in EU-RO-1.")
        }
        "gpu_start_no_eligible_gpu" => (
            true,
            "No eligible live ImageForge GPU is currently available.",
        ),
        "gpu_start_provider_auth_failed" => (
            false,
            "RunPod rejected the saved API credential. Replace it before starting a GPU.",
        ),
        "gpu_start_provider_timeout" => (
            true,
            "RunPod did not answer the final GPU check. Try Start again.",
        ),
        "gpu_start_provider_unavailable" => (
            true,
            "RunPod is unavailable for the final GPU check. Try Start again.",
        ),
        "gpu_start_provider_rate_limited" => (
            true,
            "RunPod rate-limited the final GPU check. Wait, then try Start again.",
        ),
        _ => {
            return NativeError::new(
                "gpu_start_provider_response_invalid",
                "RunPod returned an invalid GPU response.",
            )
        }
    };
    if retryable {
        NativeError::retryable(code, message)
    } else {
        NativeError::new(code, message)
    }
}

fn map_catalog_preflight_error(error: &NativeError, datacenters: bool) -> NativeError {
    match error.code {
        "runpod_auth_failed" => start_error("gpu_start_provider_auth_failed"),
        "runpod_timeout" => start_error("gpu_start_provider_timeout"),
        "runpod_rate_limited" => start_error("gpu_start_provider_rate_limited"),
        "runpod_response_invalid" => inventory_response_invalid(),
        "runpod_provider_unavailable" | "runpod_network_error" | "runpod_inventory_unavailable" => {
            if datacenters {
                datacenters_unavailable()
            } else {
                gpus_unavailable()
            }
        }
        _ => {
            if datacenters {
                datacenters_unavailable()
            } else {
                gpus_unavailable()
            }
        }
    }
}

fn start_result_transition(
    prior: &PersistedNormalStartV1,
    state: &str,
    pod: Option<NativeGpuSwitchPodV1>,
    actual_hourly_price_micro_usd: Option<u64>,
    issue: Option<NativeGpuStartIssueV1>,
) -> NativeResult<PersistedNormalStartV1> {
    let lifecycle_revision = prior
        .result
        .lifecycle_revision
        .checked_add(1)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(revision_exhausted)?;
    let result = NativeManualGpuStartResultV1 {
        schema_version: 1,
        operation_id: prior.result.operation_id.clone(),
        lifecycle_revision,
        state: state.to_owned(),
        pod,
        confirmed_hourly_price_micro_usd: prior.result.confirmed_hourly_price_micro_usd,
        actual_hourly_price_micro_usd,
        issue,
    };
    validate_start_result_shape(&result)?;
    Ok(PersistedNormalStartV1 {
        schema_version: START_JOURNAL_SCHEMA_VERSION,
        result,
        authority: prior.authority.clone(),
        post_state: NormalStartPostStateV1::Settled,
    })
}

fn validate_persisted_start(record: &PersistedNormalStartV1) -> NativeResult<()> {
    if record.schema_version != START_JOURNAL_SCHEMA_VERSION
        || record.authority.schema_version != START_JOURNAL_SCHEMA_VERSION
        || record.authority.operation_id != record.result.operation_id
        || !valid_sha256(&record.authority.ordered_gpu_ids_sha256)
        || !valid_sha256(&record.authority.request_body_sha256)
        || record.authority.expected_lifecycle_revision > MAX_SAFE_INTEGER
        || record
            .authority
            .requested_price_micro_usd
            .is_some_and(|value| value > MAX_SAFE_INTEGER)
    {
        return Err(start_store_unavailable());
    }
    for value in [
        record.authority.operation_id.as_str(),
        record.authority.observation_id.as_str(),
        record.authority.receipt_id.as_str(),
        record.authority.invocation_observation_id.as_str(),
        record.authority.invocation_receipt_id.as_str(),
        record.authority.session_id.as_str(),
    ] {
        validate_uuid(value, "gpu_start_store_unavailable")?;
    }
    match record.authority.kind {
        NormalStartAuthorityKind::NormalManualStart => {
            if record
                .authority
                .requested_target_gpu_id
                .as_deref()
                .is_none_or(|id| !valid_gpu_identity(id))
                || record.authority.requested_price_micro_usd.is_none()
            {
                return Err(start_store_unavailable());
            }
        }
        NormalStartAuthorityKind::NormalAutoStart => {
            if record.authority.requested_target_gpu_id.is_some()
                || record.authority.requested_price_micro_usd.is_some()
            {
                return Err(start_store_unavailable());
            }
        }
    }
    validate_start_result_shape(&record.result).map_err(|_| start_store_unavailable())?;
    let post_state_valid = matches!(
        (&record.post_state, record.result.state.as_str()),
        (NormalStartPostStateV1::PostSendPending, "create_intent")
            | (
                NormalStartPostStateV1::PostSent,
                "create_intent" | "create_uncertain"
            )
            | (
                NormalStartPostStateV1::Settled,
                "create_uncertain" | "provisioning" | "ready" | "price_attention"
            )
    );
    post_state_valid
        .then_some(())
        .ok_or_else(start_store_unavailable)
}

fn validate_start_result_shape(result: &NativeManualGpuStartResultV1) -> NativeResult<()> {
    if result.schema_version != 1
        || result.lifecycle_revision == 0
        || result.lifecycle_revision > MAX_SAFE_INTEGER
        || result.confirmed_hourly_price_micro_usd > MAX_SAFE_INTEGER
        || result
            .actual_hourly_price_micro_usd
            .is_some_and(|value| value > MAX_SAFE_INTEGER)
    {
        return Err(start_error("gpu_start_provider_response_invalid"));
    }
    validate_uuid(&result.operation_id, "gpu_start_provider_response_invalid")?;
    let valid_pod = |pod: &NativeGpuSwitchPodV1| {
        valid_pod_id(&pod.pod_id)
            && valid_gpu_identity(&pod.gpu_id)
            && valid_gpu_identity(&pod.gpu_display_name)
            && pod
                .hourly_price_micro_usd
                .is_none_or(|value| value <= MAX_SAFE_INTEGER)
    };
    let issue_is = |code: &str| {
        result
            .issue
            .as_ref()
            .is_some_and(|issue| issue.code == code && !issue.retryable)
    };
    let valid = match result.state.as_str() {
        "create_intent" => {
            result.pod.is_none()
                && result.actual_hourly_price_micro_usd.is_none()
                && result.issue.is_none()
        }
        "create_uncertain" => {
            result.pod.is_none()
                && result.actual_hourly_price_micro_usd.is_none()
                && issue_is("gpu_start_create_uncertain")
        }
        "provisioning" => {
            result.pod.as_ref().is_some_and(|pod| {
                valid_pod(pod)
                    && pod.hourly_price_micro_usd == result.actual_hourly_price_micro_usd
                    && result.actual_hourly_price_micro_usd
                        == Some(result.confirmed_hourly_price_micro_usd)
            }) && result.issue.is_none()
        }
        "ready" => {
            result.pod.as_ref().is_some_and(|pod| {
                valid_pod(pod)
                    && pod.hourly_price_micro_usd == result.actual_hourly_price_micro_usd
                    && result.actual_hourly_price_micro_usd
                        == Some(result.confirmed_hourly_price_micro_usd)
            }) && result.issue.is_none()
        }
        "price_attention" => match result.actual_hourly_price_micro_usd {
            Some(actual) => {
                result.pod.as_ref().is_some_and(|pod| {
                    valid_pod(pod)
                        && pod.hourly_price_micro_usd == Some(actual)
                        && actual != result.confirmed_hourly_price_micro_usd
                }) && issue_is("gpu_actual_price_changed")
            }
            None => {
                result
                    .pod
                    .as_ref()
                    .is_some_and(|pod| valid_pod(pod) && pod.hourly_price_micro_usd.is_none())
                    && issue_is("gpu_actual_price_unavailable")
            }
        },
        _ => false,
    };
    valid
        .then_some(())
        .ok_or_else(|| start_error("gpu_start_provider_response_invalid"))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

pub(crate) fn start_input_sha256<T: Serialize>(input: &T) -> NativeResult<String> {
    let value = serde_json::to_value(input)
        .map_err(|_| start_error("gpu_start_provider_response_invalid"))?;
    Ok(sha256_hex(&jcs_value(&value)?))
}

/// RFC8785/JCS for the JSON values that occur in normal Start authority. The
/// renderer never supplies these values, but the helper is intentionally
/// general enough for the checked-in cross-language golden vector.
pub(crate) fn jcs_value(value: &Value) -> NativeResult<String> {
    match value {
        Value::Null => Ok("null".to_owned()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(value) => {
            let text = value.to_string();
            if text.contains('e') || text.contains('E') || text.contains('.') {
                return Err(start_error("gpu_start_provider_response_invalid"));
            }
            Ok(text)
        }
        Value::String(value) => json_string(value),
        Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(jcs_value)
                .collect::<NativeResult<Vec<_>>>()?
                .join(",")
        )),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            let mut rendered = Vec::with_capacity(keys.len());
            for key in keys {
                rendered.push(format!(
                    "{}:{}",
                    json_string(key)?,
                    jcs_value(&values[key])?
                ));
            }
            Ok(format!("{{{}}}", rendered.join(",")))
        }
    }
}

fn jcs_string_array(values: &[String]) -> NativeResult<String> {
    jcs_value(&Value::Array(
        values.iter().cloned().map(Value::String).collect(),
    ))
}

/// The cross-language authority fixtures use raw JSON bytes, not just a
/// `serde_json::Value`: a BOM or a trailing line break changes signed/hashed
/// bytes and must not silently become the same start authority. Struct
/// deserialization also preserves serde's duplicate-field rejection.
fn strict_json_decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ()> {
    if bytes.is_empty()
        || bytes.starts_with(&[0xef, 0xbb, 0xbf])
        || bytes.last().is_some_and(u8::is_ascii_whitespace)
        || has_noncanonical_integer_token(bytes)
    {
        return Err(());
    }
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let decoded = T::deserialize(&mut deserializer).map_err(|_| ())?;
    deserializer.end().map_err(|_| ())?;
    Ok(decoded)
}

/// The Start IPC/journal schemas contain only non-negative JS-safe integer
/// number fields. Scan outside JSON strings before serde can normalize `-0`,
/// `1e0`, or a decimal lexeme into an otherwise indistinguishable integer.
fn has_noncanonical_integer_token(bytes: &[u8]) -> bool {
    let mut index = 0;
    let mut in_string = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            match byte {
                b'\\' => index = index.saturating_add(2),
                b'"' => {
                    in_string = false;
                    index += 1;
                }
                _ => index += 1,
            }
            continue;
        }
        match byte {
            b'"' => {
                in_string = true;
                index += 1;
            }
            b'-' => return true,
            b'0' => {
                let next = bytes.get(index + 1).copied();
                if next.is_some_and(|value| {
                    value.is_ascii_digit() || matches!(value, b'.' | b'e' | b'E')
                }) {
                    return true;
                }
                index += 1;
            }
            b'1'..=b'9' => {
                index += 1;
                while bytes.get(index).is_some_and(u8::is_ascii_digit) {
                    index += 1;
                }
                if bytes
                    .get(index)
                    .is_some_and(|value| matches!(value, b'.' | b'e' | b'E'))
                {
                    return true;
                }
            }
            _ => index += 1,
        }
    }
    false
}

fn default_start_journal_root() -> NativeResult<PathBuf> {
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|path| path.join("Library").join("Application Support"));
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base: Option<PathBuf> = None;
    base.map(|path| {
        path.join("com.imageforge.desktop")
            .join("gpu-start")
            .join("v1")
    })
    .ok_or_else(start_store_unavailable)
}

fn write_replace_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "missing GPU Start journal parent",
        )
    })?;
    fs::create_dir_all(parent)?;
    let metadata = fs::symlink_metadata(parent)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "unsafe journal directory",
        ));
    }
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
        let _ = fs::remove_file(&temporary);
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

fn state_error() -> NativeError {
    NativeError::new(
        "gpu_inventory_state_unavailable",
        "Native GPU inventory state is unavailable.",
    )
}

pub(crate) fn utc_now_rfc3339_millis() -> NativeResult<String> {
    let millis = SystemTime::now()
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

// Howard Hinnant's civil-date conversion with 1970-01-01 as day zero.
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

    fn datacenters() -> &'static str {
        r#"{"dataCenters":[{"id":"EU-RO-1","networkVolumeTypes":["NETWORK_VOLUME"]}]}"#
    }

    fn gpus() -> &'static str {
        r#"{"gpus":[
          {"id":"NVIDIA GeForce RTX 4090","name":"RTX 4090","manufacturer":"NVIDIA","memory":24,"secure":true,"price":{"secure":0.500001},"maxCount":{"secure":1},"dataCenters":[{"id":"EU-RO-1","availability":"HIGH"}]},
          {"id":"bad","name":"Bad","manufacturer":"NVIDIA","memory":24,"secure":true,"price":{"secure":"0.7"},"maxCount":{"secure":1},"dataCenters":[{"id":"EU-RO-1","availability":"HIGH"}]}
        ]}"#
    }

    #[test]
    fn price_grammar_is_lossless_and_js_safe() {
        assert_eq!(parse_number_price("0"), Some(0));
        assert_eq!(parse_number_price("0.000001"), Some(1));
        assert_eq!(parse_number_price("12.000001"), Some(12_000_001));
        assert_eq!(
            parse_number_price("9007199254.740991"),
            Some(MAX_SAFE_INTEGER)
        );
        for invalid in [
            "00",
            "01",
            "1.",
            ".1",
            "-1",
            "1e3",
            "1.0000001",
            "9007199254.740992",
            " 1",
            "1 ",
        ] {
            assert_eq!(parse_number_price(invalid), None, "{invalid}");
        }
    }

    #[test]
    fn created_pod_price_accepts_number_and_decimal_string_forms() {
        assert_eq!(
            parse_created_price_tokens("null", "\"0.74\""),
            Some(740_000)
        );
        assert_eq!(parse_created_price_tokens("null", "0.74"), Some(740_000));
        assert_eq!(parse_created_price_tokens("0.73", "0.74"), Some(730_000));
        assert_eq!(parse_created_price_tokens("null", "7.4e-1"), None);
        assert_eq!(parse_created_price_tokens("null", "true"), None);
    }

    #[test]
    fn valid_sibling_survives_malformed_catalog_price() {
        assert_eq!(parse_datacenter_support(datacenters()), Ok(true));
        let parsed = parse_gpu_catalog(gpus(), false).unwrap();
        assert_eq!(parsed.offers.len(), 1);
        assert_eq!(parsed.offers[0].hourly_price_micro_usd, Some(500_001));
        assert_eq!(parsed.offers[0].gpu_id, "NVIDIA GeForce RTX 4090");
    }

    #[test]
    fn expanded_policy_accepts_exact_80_and_96_gb_ids_but_rejects_b200() {
        let body = r#"{"gpus":[
          {"id":"NVIDIA A100 80GB PCIe","name":"A100 PCIe","manufacturer":"NVIDIA","memory":80,"secure":true,"price":{"secure":1.39},"maxCount":{"secure":1},"dataCenters":[{"id":"EU-RO-1","availability":"HIGH"}]},
          {"id":"NVIDIA RTX PRO 6000 Blackwell Server Edition","name":"RTX PRO 6000 Blackwell Server Edition","manufacturer":"NVIDIA","memory":96,"secure":true,"price":{"secure":2.09},"maxCount":{"secure":1},"dataCenters":[{"id":"EU-RO-1","availability":"HIGH"}]},
          {"id":"NVIDIA RTX PRO 6000 Blackwell Workstation Edition","name":"RTX PRO 6000 Blackwell Workstation Edition","manufacturer":"NVIDIA","memory":96,"secure":true,"price":{"secure":1.89},"maxCount":{"secure":1},"dataCenters":[{"id":"EU-RO-1","availability":"HIGH"}]},
          {"id":"NVIDIA B200","name":"B200","manufacturer":"NVIDIA","memory":180,"secure":true,"price":{"secure":6.79},"maxCount":{"secure":1},"dataCenters":[{"id":"EU-RO-1","availability":"HIGH"}]}
        ]}"#;
        let parsed = parse_gpu_catalog(body, false).unwrap();
        assert_eq!(
            parsed
                .offers
                .iter()
                .map(|offer| offer.gpu_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "NVIDIA A100 80GB PCIe",
                "NVIDIA RTX PRO 6000 Blackwell Server Edition",
                "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
            ]
        );
        assert!(parsed.offers.iter().all(|offer| !offer.emergency));
    }

    #[test]
    fn observations_coalesce_only_same_policy_and_supersede_old() {
        let directory = tempfile::tempdir().unwrap();
        let service =
            GpuInventoryService::new_for_test(directory.path().join("gpu-start")).unwrap();
        let (first, first_start) = service.reserve_observation(false).unwrap();
        assert!(first_start.is_some());
        let (same, same_start) = service.reserve_observation(false).unwrap();
        assert_eq!(same.observation_id, first.observation_id);
        assert!(same_start.is_none());
        let (next, next_start) = service.reserve_observation(true).unwrap();
        assert_ne!(next.observation_id, first.observation_id);
        assert!(next_start.is_some());
        let inner = service.inner.lock().unwrap();
        assert!(inner.active.get(&first.observation_id).unwrap().superseded);
        assert!(!inner.active.get(&next.observation_id).unwrap().superseded);
    }

    #[test]
    fn final_preflight_discards_an_older_background_completion_before_it_can_publish() {
        let directory = tempfile::tempdir().unwrap();
        let service =
            GpuInventoryService::new_for_test(directory.path().join("gpu-start")).unwrap();
        let (background, background_started) = service.reserve_observation(false).unwrap();
        assert!(background_started.is_some());

        let preflight = service.begin_final_preflight_observation().unwrap();
        {
            let inner = service.inner.lock().unwrap();
            let active = inner.active.get(&background.observation_id).unwrap();
            assert!(active.superseded);
            assert!(active.discard_after_action_preflight);
            assert!(inner.final_preflight_active);
        }

        // A selector timer arriving during the final action must not start a
        // competing read.  It observes the current native projection and the
        // action owns the subsequent terminal receipt/event.
        let (coalesced, coalesced_started) = service.reserve_observation(true).unwrap();
        assert_eq!(coalesced.observation_id, background.observation_id);
        assert!(coalesced_started.is_none());

        // This is the exact completion gate used by the spawned background
        // task. `None` means it returns before parsing, registry/current
        // replacement, or event emission, so it cannot overwrite the action
        // preflight's promoted snapshot afterward.
        assert!(service
            .take_background_observation_for_completion(&background.observation_id)
            .is_none());
        drop(preflight);
        assert!(!service.inner.lock().unwrap().final_preflight_active);
    }

    #[test]
    fn fallback_is_receipt_free_and_nonselectable() {
        let snapshot = fallback_snapshot(
            &Uuid::new_v4().to_string(),
            &Uuid::new_v4().to_string(),
            false,
            "gpu_inventory_gpus_unavailable",
        );
        assert_eq!(snapshot.state, "fallback");
        assert!(snapshot.receipt.is_none());
        assert!(snapshot.observed_at.is_none());
        assert!(snapshot
            .offers
            .iter()
            .all(|offer| !offer.selectable && offer.source == "fallback"));
    }

    #[test]
    fn strict_manual_inputs_reject_unknown_fields_and_noncanonical_uuid() {
        let value = json!({
            "observationId": Uuid::new_v4().to_string(),
            "receiptId": Uuid::new_v4().to_string(),
            "targetGpuId": "NVIDIA GeForce RTX 4090",
            "confirmedHourlyPriceMicroUsd": 500000,
            "sessionId": Uuid::new_v4().to_string(),
            "expectedLifecycleRevision": 0,
            "unexpected": true,
        });
        assert!(serde_json::from_value::<NativeManualGpuStartV1>(value).is_err());
    }

    #[test]
    fn catalog_hash_is_order_independent_and_excludes_timestamp() {
        let offers = parse_gpu_catalog(gpus(), false).unwrap().offers;
        let first = catalog_sha256(false, true, &offers).unwrap();
        let mut reversed = offers.clone();
        reversed.reverse();
        assert_eq!(first, catalog_sha256(false, true, &reversed).unwrap());
    }

    fn start_vectors() -> Value {
        serde_json::from_str(include_str!(
            "../../../contracts/gpu-start-auto-v1.vectors.json"
        ))
        .expect("checked-in GPU Start vectors are valid JSON")
    }

    #[test]
    fn start_contract_vectors_bind_strict_shapes_relations_and_authority_bytes() {
        let vectors = start_vectors();
        for entry in vectors["acceptedInputs"].as_array().unwrap() {
            let input: NativeAutoGpuStartV1 =
                serde_json::from_value(entry["value"].clone()).expect("accepted input shape");
            // The maximum-safe case is structurally valid but cannot begin a
            // new revision; that semantic exhaustion is tested separately.
            if entry["id"] == "initial_auto_start" {
                validate_auto_input(&input).expect("initial input is actionable");
            }
        }
        for entry in vectors["acceptedResults"].as_array().unwrap() {
            let result: NativeManualGpuStartResultV1 =
                serde_json::from_value(entry["value"].clone()).expect("accepted result shape");
            validate_start_result_shape(&result).expect("accepted result relation");
        }
        for entry in vectors["schemaRejections"].as_array().unwrap() {
            match entry["surface"].as_str() {
                Some("input") => {
                    let decoded =
                        serde_json::from_value::<NativeAutoGpuStartV1>(entry["value"].clone());
                    if let Ok(input) = decoded {
                        assert!(validate_auto_input(&input).is_err(), "{}", entry["id"]);
                    }
                }
                Some("result") => {
                    let decoded = serde_json::from_value::<NativeManualGpuStartResultV1>(
                        entry["value"].clone(),
                    );
                    if let Ok(result) = decoded {
                        assert!(
                            validate_start_result_shape(&result).is_err(),
                            "{}",
                            entry["id"]
                        );
                    }
                }
                other => panic!("unknown vector surface: {other:?}"),
            }
        }
        for entry in vectors["rawByteRejections"].as_array().unwrap() {
            let bytes = entry["utf8"].as_str().unwrap().as_bytes();
            let rejected = match entry["surface"].as_str() {
                Some("input") => strict_json_decode::<NativeAutoGpuStartV1>(bytes)
                    .and_then(|input| validate_auto_input(&input).map_err(|_| ()))
                    .is_err(),
                Some("result") => strict_json_decode::<NativeManualGpuStartResultV1>(bytes)
                    .and_then(|result| validate_start_result_shape(&result).map_err(|_| ()))
                    .is_err(),
                other => panic!("unknown raw vector surface: {other:?}"),
            };
            assert!(rejected, "{}", entry["id"]);
        }
        for entry in vectors["relationRejections"].as_array().unwrap() {
            let result: NativeManualGpuStartResultV1 =
                serde_json::from_value(entry["value"].clone()).expect("relation vector shape");
            assert!(
                validate_start_result_shape(&result).is_err(),
                "{}",
                entry["id"]
            );
        }

        let authority = &vectors["authorityVector"];
        let input = vectors["acceptedInputs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == authority["inputId"])
            .unwrap();
        let input: NativeAutoGpuStartV1 = serde_json::from_value(input["value"].clone()).unwrap();
        assert_eq!(
            jcs_value(&serde_json::to_value(&input).unwrap()).unwrap(),
            authority["inputJcs"].as_str().unwrap()
        );
        assert_eq!(
            start_input_sha256(&input).unwrap(),
            authority["inputSha256"].as_str().unwrap()
        );
        assert_eq!(
            jcs_value(&authority["requestBody"]).unwrap(),
            authority["requestBodyJcs"].as_str().unwrap()
        );
        assert_eq!(
            sha256_hex(authority["requestBodyJcs"].as_str().unwrap()),
            authority["requestBodySha256"].as_str().unwrap()
        );
        assert_eq!(
            jcs_value(&authority["orderedGpuIds"]).unwrap(),
            authority["orderedGpuIdsJcs"].as_str().unwrap()
        );
        assert_eq!(
            sha256_hex(authority["orderedGpuIdsJcs"].as_str().unwrap()),
            authority["orderedGpuIdsSha256"].as_str().unwrap()
        );
        assert_eq!(
            jcs_value(&authority["privateAuthority"]).unwrap(),
            authority["privateAuthorityJcs"].as_str().unwrap()
        );
        assert_eq!(
            sha256_hex(authority["privateAuthorityJcs"].as_str().unwrap()),
            authority["privateAuthoritySha256"].as_str().unwrap()
        );
    }

    #[test]
    fn capability_vectors_lock_production_and_qa_permission_boundaries() {
        let vectors = start_vectors();
        let boundary = &vectors["capabilityBoundary"];
        let production: Value =
            serde_json::from_str(include_str!("../../../src-tauri/capabilities/default.json"))
                .unwrap();
        assert_eq!(
            production["identifier"],
            boundary["productionCapabilityIdentifier"]
        );
        assert_eq!(production["windows"], boundary["productionWindowLabels"]);
        assert_eq!(
            production["permissions"],
            boundary["productionPluginPermissions"]
        );

        let qa: Value = serde_json::from_str(include_str!(
            "../../../src-tauri/capabilities/qa-gpu-selector-perf-v1.json"
        ))
        .unwrap();
        assert_eq!(qa["identifier"], boundary["qaCapabilityIdentifier"]);
        assert_eq!(qa["permissions"], boundary["qaOnlyPermissions"]);
    }

    fn sent_start_record() -> PersistedNormalStartV1 {
        let operation_id = "00000000-0000-4000-8000-000000000010".to_owned();
        PersistedNormalStartV1 {
            schema_version: START_JOURNAL_SCHEMA_VERSION,
            result: NativeManualGpuStartResultV1 {
                schema_version: 1,
                operation_id: operation_id.clone(),
                lifecycle_revision: 1,
                state: "create_intent".to_owned(),
                pod: None,
                confirmed_hourly_price_micro_usd: 690_000,
                actual_hourly_price_micro_usd: None,
                issue: None,
            },
            authority: PrivateNormalStartAuthorityV1 {
                schema_version: START_JOURNAL_SCHEMA_VERSION,
                kind: NormalStartAuthorityKind::NormalAutoStart,
                operation_id,
                observation_id: "00000000-0000-4000-8000-000000000020".to_owned(),
                receipt_id: "00000000-0000-4000-8000-000000000021".to_owned(),
                invocation_observation_id: "00000000-0000-4000-8000-000000000001".to_owned(),
                invocation_receipt_id: "00000000-0000-4000-8000-000000000002".to_owned(),
                session_id: "00000000-0000-4000-8000-000000000003".to_owned(),
                expected_lifecycle_revision: 0,
                requested_target_gpu_id: None,
                requested_price_micro_usd: None,
                ordered_gpu_ids_sha256: "a".repeat(64),
                request_body_sha256: "b".repeat(64),
            },
            post_state: NormalStartPostStateV1::PostSent,
        }
    }

    #[test]
    fn post_sent_start_recovers_to_create_uncertain_without_replaying_create() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("gpu-start");
        let journal = NormalStartJournal::new(root.clone()).unwrap();
        journal.persist(&sent_start_record()).unwrap();

        let recovered = GpuInventoryService::new_for_test(root).unwrap();
        let result = recovered.start_load().unwrap().unwrap();
        assert_eq!(result.state, "create_uncertain");
        assert_eq!(result.lifecycle_revision, 2);
        assert_eq!(
            result.issue.as_ref().map(|issue| issue.code.as_str()),
            Some("gpu_start_create_uncertain")
        );
        let persisted = recovered.start_journal.load().unwrap().unwrap();
        assert!(matches!(
            persisted.post_state,
            NormalStartPostStateV1::Settled
        ));
    }

    #[test]
    fn corrupt_current_start_journal_recovers_the_previous_valid_generation() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("gpu-start");
        let journal = NormalStartJournal::new(root).unwrap();
        let sent = sent_start_record();
        journal.persist(&sent).unwrap();
        let settled = start_result_transition(
            &sent,
            "create_uncertain",
            None,
            None,
            Some(start_issue("gpu_start_create_uncertain")),
        )
        .unwrap();
        journal.persist(&settled).unwrap();
        std::fs::write(journal.current_path(), b"{damaged").unwrap();

        let recovered = journal.load().unwrap().unwrap();
        assert_eq!(recovered.result.state, "create_intent");
        assert!(matches!(
            recovered.post_state,
            NormalStartPostStateV1::PostSent
        ));
    }
}
