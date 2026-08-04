//! Native-only profile-scoped Pod observation for Task 014.
//!
//! The renderer receives a small validated lifecycle projection. It never gets
//! a RunPod URL, profile identifier, provider response, or registry mutation
//! capability. The normal Stop input/result types live here as the shared
//! strict IPC boundary; the destructive handler is assembled by `lib.rs`.

use super::gpu_inventory::{utc_now_rfc3339_millis, GpuInventoryService, NativeGpuSwitchPodV1};
use super::gpu_stop::{
    default_normal_stop_root, stop_request_in_progress, NormalStopJournal, NormalStopLookupV1,
    NormalStopPhaseV1,
};
use super::runpod::{NativeRunPodDeleteDispositionV1, NativeRunPodManagedPodV1, RunPodTransport};
use super::worker::{NativeWorkerNormalStopFinalizeOutcomeV1, WorkerApi};
use super::{NativeError, NativeResult};
use futures_util::future::{BoxFuture, FutureExt, Shared};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::sync::{Arc, Mutex};
use uuid::{Uuid, Version};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_VISIBLE_PODS: usize = 16;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuObservedPodV1 {
    pub pod_id: String,
    pub gpu_id: String,
    pub gpu_display_name: String,
    pub hourly_price_micro_usd: Option<u64>,
    pub status: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuPodObservationIssueV1 {
    pub code: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuPodObservationV1 {
    pub schema_version: u8,
    pub process_epoch_id: String,
    pub lifecycle_revision: u64,
    pub state: String,
    pub observed_at: Option<String>,
    pub stale: bool,
    pub pods: Vec<NativeGpuObservedPodV1>,
    pub overflow: bool,
    pub issue: Option<NativeGpuPodObservationIssueV1>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuNormalStopV1 {
    pub pod_id: String,
    pub stop_request_id: String,
    pub session_id: String,
    pub expected_server_instance_id: String,
    pub expected_coordination_revision: u64,
    pub expected_lifecycle_revision: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuNormalStopResultV1 {
    pub schema_version: u8,
    pub operation_id: String,
    pub pod_id: String,
    pub disposition: String,
    pub observation: NativeGpuPodObservationV1,
    pub issue: Option<NativeGpuNormalStopIssueV1>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGpuNormalStopIssueV1 {
    pub code: String,
    pub retryable: bool,
}

/// The two mutation sockets owned by an ordinary coordinated Stop. The
/// command layer uses this to take its short process-local reservation gate
/// immediately before each wire boundary while the cross-process
/// `profile-control.lock` lease remains held by the outer IPC command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeNormalStopMutationBoundaryV1 {
    Finalize,
    Delete,
}

/// Private context used only by the native command coordinator. It is not an
/// IPC type: operation/finalization IDs must never cross the renderer boundary.
#[derive(Debug, Clone)]
pub(crate) struct NativeNormalStopMutationContextV1 {
    pub input: NativeGpuNormalStopV1,
    pub operation_id: String,
    pub finalization_id: String,
}

pub(crate) type NativeNormalStopMutationCheckV1 = Arc<
    dyn Fn(
            NativeNormalStopMutationBoundaryV1,
            NativeNormalStopMutationContextV1,
        ) -> BoxFuture<'static, NativeResult<()>>
        + Send
        + Sync,
>;

type ActiveObservationFuture = Shared<BoxFuture<'static, NativeResult<NativeGpuPodObservationV1>>>;

#[derive(Clone)]
enum ObservationCommitMode {
    Normal,
    /// A post-send DELETE outcome is ambiguous. The list read still occurs at
    /// R+2, but its result cannot erase the exact preflight Pod or publish a
    /// false Offline outcome.
    RetainUncertainStop {
        pod: NativeGpuObservedPodV1,
        observed_at: Option<String>,
    },
}

#[derive(Clone)]
struct ActiveObservation {
    /// A profile rebind invalidates every result reserved under the prior
    /// generation.  The generation stays process-private: it exists solely to
    /// prevent a late HTTP completion from the old credential profile from
    /// publishing into the newly bound profile.
    profile_generation: u64,
    /// Stop owns two exact list attempts. A foreground Stop advances this
    /// token before each attempt so a heartbeat begun before preflight or
    /// before the post-delete proof cannot publish into either boundary.
    observation_generation: u64,
    future: ActiveObservationFuture,
}

struct PodObservationInner {
    current: NativeGpuPodObservationV1,
    last_valid: Option<NativeGpuPodObservationV1>,
    profile_generation: u64,
    observation_generation: u64,
    stop_observation_active: bool,
    /// 0 means no Stop owns this observer. An admitted Stop reserves exactly
    /// two provider-list generations: R+1 preflight and R+2 result proof.
    stop_observation_attempts: u8,
    active: Option<ActiveObservation>,
}

/// Process-local Pod observation coordinator. A durable switch/Stop journal is
/// intentionally not stored here: this service is only the read-only current
/// Pod authority and loses its in-flight coalescing state at process exit.
#[derive(Clone)]
pub struct GpuPodService {
    process_epoch_id: String,
    inner: Arc<Mutex<PodObservationInner>>,
    normal_stop_root: Arc<std::path::PathBuf>,
}

/// Always releases the foreground Stop observer lane, including early worker,
/// journal, provider, and serialization errors. It intentionally ignores a
/// poisoned in-memory lock during drop: the original command already returns
/// a safe unavailable error in that case, and a destructor must not panic.
struct StopObservationActionGuard {
    service: GpuPodService,
}

impl StopObservationActionGuard {
    fn new(service: GpuPodService) -> NativeResult<Self> {
        service.begin_stop_observation_action()?;
        Ok(Self { service })
    }
}

impl Drop for StopObservationActionGuard {
    fn drop(&mut self) {
        let _ = self.service.finish_stop_observation_action();
    }
}

impl GpuPodService {
    pub fn new(process_epoch_id: String) -> Self {
        Self {
            process_epoch_id: process_epoch_id.clone(),
            inner: Arc::new(Mutex::new(PodObservationInner {
                current: initial_observation(&process_epoch_id),
                last_valid: None,
                profile_generation: 0,
                observation_generation: 0,
                stop_observation_active: false,
                stop_observation_attempts: 0,
                active: None,
            })),
            normal_stop_root: Arc::new(default_normal_stop_root()),
        }
    }

    pub fn load(&self) -> NativeResult<NativeGpuPodObservationV1> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| pod_state_unavailable())?
            .current
            .clone())
    }

    /// Process-private observation epoch used by the command coordinator to
    /// reject a Stop continuation after a profile/reset boundary. It never
    /// crosses renderer IPC.
    pub(crate) fn process_epoch_id(&self) -> &str {
        &self.process_epoch_id
    }

    /// Admit only the revision budget for a *new* normal Stop. This is a
    /// deliberately pure in-memory check for the IPC command to run before it
    /// acquires `profile-control.lock` or opens any durable store.
    ///
    /// A mismatching input is intentionally left eligible here: it might be
    /// an exact completed replay whose historical input revision predates the
    /// current R+2 observation. Only the later journal lookup can distinguish
    /// that byte-identical replay from an ordinary stale new request.
    pub(crate) fn assert_new_normal_stop_budget_before_profile_lease(
        &self,
        input: &NativeGpuNormalStopV1,
    ) -> NativeResult<()> {
        let inner = self.inner.lock().map_err(|_| pod_state_unavailable())?;
        if inner.current.lifecycle_revision == input.expected_lifecycle_revision
            && inner.current.lifecycle_revision > MAX_SAFE_INTEGER - 2
        {
            return Err(pod_revision_exhausted());
        }
        Ok(())
    }

    /// Renderer-safe relaunch lookup for an ordinary Stop. This remains a
    /// private-store read only: it cannot create the store, issue a provider
    /// request, or expose a journal operation/finalization identity.
    pub(crate) fn load_normal_stop_recovery(&self) -> NativeResult<Option<NativeGpuNormalStopV1>> {
        NormalStopJournal::load_recovery_input_from_root((*self.normal_stop_root).clone())
    }

    /// An exact profile rebind invalidates the entire process-local Pod view:
    /// its revision, retained rows and in-flight coalesced future belong to
    /// the prior profile. This is intentionally not a provider read.
    pub(crate) fn reset_for_profile_binding(&self) -> NativeResult<()> {
        let mut inner = self.inner.lock().map_err(|_| pod_state_unavailable())?;
        inner.profile_generation = inner
            .profile_generation
            .checked_add(1)
            .ok_or_else(pod_state_unavailable)?;
        inner.observation_generation = inner
            .observation_generation
            .checked_add(1)
            .ok_or_else(pod_state_unavailable)?;
        inner.current = initial_observation(&self.process_epoch_id);
        inner.last_valid = None;
        inner.stop_observation_active = false;
        inner.stop_observation_attempts = 0;
        inner.active = None;
        Ok(())
    }

    /// Run exactly one profile-scoped provider list call for all overlapping
    /// callers. The producer future owns the terminal revision; joined callers
    /// await and receive the same frozen output rather than starting a second
    /// endpoint call or incrementing lifecycle revision again.
    pub async fn observe(
        &self,
        inventory: GpuInventoryService,
        runpod: RunPodTransport,
    ) -> NativeResult<NativeGpuPodObservationV1> {
        self.observe_with_reader(Some(inventory), move |observation_generation| {
            async move {
                runpod
                    .native_pod_observation_list_pods(observation_generation)
                    .await
            }
            .boxed()
        })
        .await
    }

    /// The sole native owner for an ordinary approved Task 012 Stop DELETE.
    /// The renderer supplies only a strict compare-and-swap intent. All
    /// profile, worker-finalization, durable-delete, and provider authority
    /// remains native; exact replay never sends another socket mutation.
    pub(crate) async fn normal_stop(
        &self,
        inventory: GpuInventoryService,
        runpod: RunPodTransport,
        worker: WorkerApi,
        input: NativeGpuNormalStopV1,
        mutation_check: NativeNormalStopMutationCheckV1,
    ) -> NativeResult<NativeGpuNormalStopResultV1> {
        validate_normal_stop_input(&input)?;
        // This is the same pure pre-lease admission check used by the IPC
        // handler. Keep it here too because tests and future native callers
        // may invoke the service directly; MAX-1/MAX must not even open the
        // Stop journal or reserve an observer action.
        self.assert_new_normal_stop_budget_before_profile_lease(&input)?;
        // Reserve the observer lane before even looking at the Stop journal.
        // This invalidates a heartbeat already in flight and blocks every new
        // heartbeat until the action reaches its terminal/recovery fixed point.
        let _action_guard = StopObservationActionGuard::new(self.clone())?;
        let journal = NormalStopJournal::open((*self.normal_stop_root).clone())?;

        match journal.lookup(&input)? {
            NormalStopLookupV1::Exact(record) => match record.phase {
                NormalStopPhaseV1::Completed => {
                    return record.result.ok_or_else(stop_recovery_unavailable);
                }
                NormalStopPhaseV1::Preflight
                | NormalStopPhaseV1::DeleteIntent
                | NormalStopPhaseV1::DeleteUncertain => {
                    // A surviving preflight has no durable proof that the
                    // Finalize POST did *not* cross the socket, and a durable
                    // DELETE intent may have crossed before its response was
                    // observed. Both must become the same no-retry recovery
                    // boundary before the one permitted reconciliation read.
                    let record = if matches!(
                        record.phase,
                        NormalStopPhaseV1::Preflight | NormalStopPhaseV1::DeleteIntent
                    ) {
                        journal.mark_uncertain(&record)?
                    } else {
                        record
                    };
                    return self
                        .recover_uncertain_normal_stop(
                            inventory,
                            runpod,
                            &record.operation_id,
                            &record.preflight_pod,
                            record.preflight_observation.observed_at.clone(),
                        )
                        .await;
                }
            },
            NormalStopLookupV1::DifferentRequestActive => return Err(stop_request_in_progress()),
            NormalStopLookupV1::Missing => {}
        }

        // This is intentionally after exact replay lookup: a historical
        // completed Stop is evidence and must replay even after a process
        // relaunch reset its live lifecycle revision. New work, however, must
        // reserve both R+1 and R+2 before any provider/worker/journal write.
        self.assert_new_normal_stop_revision(&input)?;

        let preflight_runpod = runpod.clone();
        let preflight = self
            .reserve_stop_observation(
                input.expected_lifecycle_revision,
                Some(inventory.clone()),
                move |observation_generation| {
                    async move {
                        preflight_runpod
                            .native_pod_observation_list_pods(observation_generation)
                            .await
                    }
                    .boxed()
                },
            )?
            .await?;
        let preflight_pod = exact_fresh_normal_stop_preflight(&preflight, &input)?;

        let exact = runpod.native_switch_get_pod(&input.pod_id).await?;
        if !exact.is_some_and(|pod| managed_pod_matches_observed(&pod, &preflight_pod)) {
            return Err(stop_preflight_mismatch());
        }

        let operation_id = Uuid::new_v4().to_string();
        let plan = worker
            .prepare_native_normal_stop_finalization(&input, operation_id.clone())
            .await?;
        if plan.operation_id != operation_id
            || plan.request_id != input.stop_request_id
            || plan.session_id != input.session_id
            || plan.pod_id != input.pod_id
            || !canonical_uuid_v4(&plan.finalization_id)
        {
            return Err(stop_recovery_unavailable());
        }
        let record = match journal.create_preflight(
            input.clone(),
            operation_id,
            plan.finalization_id.clone(),
            preflight_pod.clone(),
            preflight.clone(),
        )? {
            super::gpu_stop::NormalStopCreatePreflightV1::Created(record) => record,
            super::gpu_stop::NormalStopCreatePreflightV1::CompletedReplay(record) => {
                return record.result.ok_or_else(stop_recovery_unavailable);
            }
        };

        let context = NativeNormalStopMutationContextV1 {
            input: input.clone(),
            operation_id: record.operation_id.clone(),
            finalization_id: record.finalization_id.clone(),
        };
        if let Err(error) = mutation_check(
            NativeNormalStopMutationBoundaryV1::Finalize,
            context.clone(),
        )
        .await
        {
            // The gate runs before the Finalize socket. A definitive local
            // veto therefore has zero provider/worker mutation and can use
            // the journal's abort-evidence cleanup path rather than creating
            // a relaunch DELETE ambiguity.
            journal.cancel_preflight(&record)?;
            return Err(error);
        }

        match worker
            .execute_native_normal_stop_finalization(&plan)
            .await?
        {
            NativeWorkerNormalStopFinalizeOutcomeV1::Finalized => {}
            NativeWorkerNormalStopFinalizeOutcomeV1::Rejected => {
                journal.cancel_preflight(&record)?;
                return Err(stop_request_in_progress());
            }
            NativeWorkerNormalStopFinalizeOutcomeV1::Uncertain => {
                let uncertain = journal.mark_uncertain(&record)?;
                return self
                    .recover_uncertain_normal_stop(
                        inventory,
                        runpod,
                        &uncertain.operation_id,
                        &uncertain.preflight_pod,
                        uncertain.preflight_observation.observed_at.clone(),
                    )
                    .await;
            }
        }

        // The local reread and the final worker marker are both mandatory
        // before the journal can mint the one-use provider DELETE authority.
        // A failure at either boundary is after Finalize, so it is retained as
        // a no-DELETE uncertainty rather than being silently cancelled.
        let delete_intent = match verify_normal_stop_delete_boundary(
            &mutation_check,
            context,
            worker.verify_native_normal_stop_finalization(&plan),
            || journal.mark_delete_intent(&record),
        )
        .await
        {
            Ok(delete_intent) => delete_intent,
            Err(error) => {
                journal.mark_uncertain(&record)?;
                return Err(error);
            }
        };
        let delete_disposition = if runpod
            .authorize_native_normal_stop_delete(&delete_intent.operation_id, &input.pod_id)
            .is_ok()
        {
            runpod
                .native_normal_stop_delete_pod(&delete_intent.operation_id, &input.pod_id)
                .await
                .unwrap_or(NativeRunPodDeleteDispositionV1::Uncertain)
        } else {
            // The private one-use authorization above deliberately has no
            // renderer handle. An authorization failure occurs after durable
            // intent, so it must still enter the no-retry uncertainty branch.
            NativeRunPodDeleteDispositionV1::Uncertain
        };

        if delete_disposition == NativeRunPodDeleteDispositionV1::Uncertain {
            let uncertain = journal.mark_uncertain(&delete_intent)?;
            return self
                .recover_uncertain_normal_stop(
                    inventory,
                    runpod,
                    &uncertain.operation_id,
                    &uncertain.preflight_pod,
                    uncertain.preflight_observation.observed_at.clone(),
                )
                .await;
        }

        let post_runpod = runpod.clone();
        let post = self
            .reserve_stop_observation(
                input
                    .expected_lifecycle_revision
                    .checked_add(1)
                    .ok_or_else(pod_revision_exhausted)?,
                Some(inventory.clone()),
                move |observation_generation| {
                    async move {
                        post_runpod
                            .native_pod_observation_list_pods(observation_generation)
                            .await
                    }
                    .boxed()
                },
            )?
            .await?;
        if fresh_absence_proof(&post, &input.pod_id) {
            let result = NativeGpuNormalStopResultV1 {
                schema_version: 1,
                operation_id: delete_intent.operation_id.clone(),
                pod_id: input.pod_id,
                disposition: match delete_disposition {
                    NativeRunPodDeleteDispositionV1::Deleted => "stopped",
                    NativeRunPodDeleteDispositionV1::NotFound => "already_stopped",
                    NativeRunPodDeleteDispositionV1::Uncertain => unreachable!(),
                }
                .to_owned(),
                observation: post,
                issue: None,
            };
            return journal
                .complete(&delete_intent, result)?
                .result
                .ok_or_else(stop_recovery_unavailable);
        }

        let uncertain = journal.mark_uncertain(&delete_intent)?;
        let observation = if post.pods.iter().any(|pod| pod.pod_id == input.pod_id) {
            post
        } else {
            self.overwrite_current_with_uncertain_stop(
                Some(inventory),
                &post,
                &uncertain.preflight_pod,
                uncertain.preflight_observation.observed_at.clone(),
            )?
        };
        Ok(uncertain_normal_stop_result(
            uncertain.operation_id,
            input.pod_id,
            observation,
        ))
    }

    fn assert_new_normal_stop_revision(&self, input: &NativeGpuNormalStopV1) -> NativeResult<()> {
        let inner = self.inner.lock().map_err(|_| pod_state_unavailable())?;
        if inner.current.lifecycle_revision != input.expected_lifecycle_revision {
            return Err(stop_preflight_mismatch());
        }
        if inner.current.lifecycle_revision > MAX_SAFE_INTEGER - 2 {
            return Err(pod_revision_exhausted());
        }
        Ok(())
    }

    async fn recover_uncertain_normal_stop(
        &self,
        inventory: GpuInventoryService,
        runpod: RunPodTransport,
        operation_id: &str,
        retained_pod: &NativeGpuObservedPodV1,
        retained_observed_at: Option<String>,
    ) -> NativeResult<NativeGpuNormalStopResultV1> {
        let recovery_runpod = runpod.clone();
        let observation = self
            .reserve_recovery_uncertain_stop_observation(
                Some(inventory),
                move |observation_generation| {
                    async move {
                        recovery_runpod
                            .native_pod_observation_list_pods(observation_generation)
                            .await
                    }
                    .boxed()
                },
                retained_pod.clone(),
                retained_observed_at,
            )?
            .await?;
        Ok(uncertain_normal_stop_result(
            operation_id.to_owned(),
            retained_pod.pod_id.clone(),
            observation,
        ))
    }

    async fn observe_with_reader<F>(
        &self,
        inventory: Option<GpuInventoryService>,
        reader: F,
    ) -> NativeResult<NativeGpuPodObservationV1>
    where
        F: FnOnce(u64) -> BoxFuture<'static, NativeResult<Vec<NativeRunPodManagedPodV1>>>
            + Send
            + 'static,
    {
        self.reserve_observation(inventory, reader)?.await
    }

    /// Reserve one coalesced profile observation.  Keeping reservation
    /// synchronous makes the single-producer boundary explicit: a second
    /// caller gets the exact shared terminal future, including the producer's
    /// revision/current-state commit, before either one has awaited it.
    fn reserve_observation<F>(
        &self,
        inventory: Option<GpuInventoryService>,
        reader: F,
    ) -> NativeResult<ActiveObservationFuture>
    where
        F: FnOnce(u64) -> BoxFuture<'static, NativeResult<Vec<NativeRunPodManagedPodV1>>>
            + Send
            + 'static,
    {
        let mut inner = self.inner.lock().map_err(|_| pod_state_unavailable())?;
        if inner.stop_observation_active {
            return inner
                .active
                .as_ref()
                .map(|active| active.future.clone())
                .ok_or_else(stop_observation_in_progress);
        }
        if let Some(active) = &inner.active {
            return Ok(active.future.clone());
        }
        self.install_observation_locked(
            &mut inner,
            inventory,
            reader,
            ObservationCommitMode::Normal,
        )
    }

    /// Reserve one action-owned list attempt. Normal Stop calls this exactly
    /// twice while its stop action is active: once for R+1 preflight and once
    /// for R+2 post-delete proof. It supersedes a previously started heartbeat
    /// and makes the active slot unavailable to a new heartbeat between the
    /// two attempts.
    fn reserve_stop_observation<F>(
        &self,
        expected_lifecycle_revision: u64,
        inventory: Option<GpuInventoryService>,
        reader: F,
    ) -> NativeResult<ActiveObservationFuture>
    where
        F: FnOnce(u64) -> BoxFuture<'static, NativeResult<Vec<NativeRunPodManagedPodV1>>>
            + Send
            + 'static,
    {
        let mut inner = self.inner.lock().map_err(|_| pod_state_unavailable())?;
        self.begin_stop_observation_locked(&mut inner, expected_lifecycle_revision)?;
        // A previously reserved future can still finish on the wire, but its
        // captured generation is now invalid and it may not mutate current
        // state, selector state, or the new active slot.
        inner.active = None;
        self.install_observation_locked(
            &mut inner,
            inventory,
            reader,
            ObservationCommitMode::Normal,
        )
    }

    /// A relaunch replay of `delete_intent`/`delete_uncertain` does not begin
    /// a new two-observation Stop. It performs one read-only current-process
    /// reconciliation at current R+1, retains the old Pod, and never sends a
    /// Finalize or DELETE. R == MAX-1 is therefore still a valid final
    /// recovery generation.
    fn reserve_recovery_uncertain_stop_observation<F>(
        &self,
        inventory: Option<GpuInventoryService>,
        reader: F,
        retained_pod: NativeGpuObservedPodV1,
        retained_observed_at: Option<String>,
    ) -> NativeResult<ActiveObservationFuture>
    where
        F: FnOnce(u64) -> BoxFuture<'static, NativeResult<Vec<NativeRunPodManagedPodV1>>>
            + Send
            + 'static,
    {
        let mut inner = self.inner.lock().map_err(|_| pod_state_unavailable())?;
        if !inner.stop_observation_active
            || inner.stop_observation_attempts != 0
            || inner.current.lifecycle_revision >= MAX_SAFE_INTEGER
        {
            return Err(if inner.current.lifecycle_revision >= MAX_SAFE_INTEGER {
                pod_revision_exhausted()
            } else {
                stop_observation_in_progress()
            });
        }
        let next_observation_generation = inner
            .observation_generation
            .checked_add(1)
            .ok_or_else(pod_state_unavailable)?;
        inner.observation_generation = next_observation_generation;
        inner.stop_observation_active = true;
        // Mark both action slots consumed. The Drop guard releases this lane;
        // a replay must never grow into a new destructive two-step Stop.
        inner.stop_observation_attempts = 2;
        inner.active = None;
        self.install_observation_locked(
            &mut inner,
            inventory,
            reader,
            ObservationCommitMode::RetainUncertainStop {
                pod: retained_pod,
                observed_at: retained_observed_at,
            },
        )
    }

    fn finish_stop_observation_action(&self) -> NativeResult<()> {
        let mut inner = self.inner.lock().map_err(|_| pod_state_unavailable())?;
        inner.stop_observation_active = false;
        inner.stop_observation_attempts = 0;
        Ok(())
    }

    /// Claim the Stop observer lane before journal/preflight work. A heartbeat
    /// already holding a future is superseded by a new private generation so
    /// it cannot publish into the Stop's R+1/R+2 sequence; a later heartbeat
    /// fails before it can open a provider socket.
    fn begin_stop_observation_action(&self) -> NativeResult<()> {
        let mut inner = self.inner.lock().map_err(|_| pod_state_unavailable())?;
        if inner.stop_observation_active {
            return Err(stop_observation_in_progress());
        }
        inner.observation_generation = inner
            .observation_generation
            .checked_add(1)
            .ok_or_else(pod_state_unavailable)?;
        inner.stop_observation_active = true;
        inner.stop_observation_attempts = 0;
        inner.active = None;
        Ok(())
    }

    fn begin_stop_observation_locked(
        &self,
        inner: &mut PodObservationInner,
        expected_lifecycle_revision: u64,
    ) -> NativeResult<()> {
        if inner.current.lifecycle_revision != expected_lifecycle_revision {
            return Err(stop_preflight_mismatch());
        }
        let next_observation_generation = inner
            .observation_generation
            .checked_add(1)
            .ok_or_else(pod_state_unavailable)?;
        match (
            inner.stop_observation_active,
            inner.stop_observation_attempts,
        ) {
            (true, 0) => {
                // A new Stop must be able to commit both R+1 and R+2. This
                // check happens before a reader is installed, which keeps the
                // MAX-1 vector at zero provider/worker/journal activity.
                if inner.current.lifecycle_revision > MAX_SAFE_INTEGER - 2 {
                    return Err(pod_revision_exhausted());
                }
                inner.stop_observation_active = true;
                inner.stop_observation_attempts = 1;
            }
            (true, 1) => {
                // The first attempt reserved the two-generation budget. The
                // R+2 attempt therefore legitimately starts at MAX-1 when
                // the admitted current revision was MAX-2.
                if inner.current.lifecycle_revision >= MAX_SAFE_INTEGER {
                    return Err(pod_revision_exhausted());
                }
                inner.stop_observation_attempts = 2;
            }
            _ => return Err(stop_observation_in_progress()),
        }
        inner.observation_generation = next_observation_generation;
        Ok(())
    }

    fn install_observation_locked<F>(
        &self,
        inner: &mut PodObservationInner,
        inventory: Option<GpuInventoryService>,
        reader: F,
        commit_mode: ObservationCommitMode,
    ) -> NativeResult<ActiveObservationFuture>
    where
        F: FnOnce(u64) -> BoxFuture<'static, NativeResult<Vec<NativeRunPodManagedPodV1>>>
            + Send
            + 'static,
    {
        if inner.current.lifecycle_revision >= MAX_SAFE_INTEGER {
            return Err(pod_revision_exhausted());
        }
        let profile_generation = inner.profile_generation;
        let observation_generation = inner.observation_generation;
        let service = self.clone();
        let future = async move {
            let provider_result = reader(observation_generation).await;
            let result = service.commit_provider_result_for_generations(
                provider_result,
                inventory.as_ref(),
                profile_generation,
                observation_generation,
                commit_mode,
            );
            // A reset or action-owned Stop observation can install a newer
            // future before this provider read returns. Only the exact
            // generation that installed this producer may clear its slot.
            if let Ok(mut inner) = service.inner.lock() {
                if matches!(
                    inner.active.as_ref(),
                    Some(active)
                        if active.profile_generation == profile_generation
                            && active.observation_generation == observation_generation
                ) {
                    inner.active = None;
                }
            }
            result
        }
        .boxed()
        .shared();
        inner.active = Some(ActiveObservation {
            profile_generation,
            observation_generation,
            future: future.clone(),
        });
        Ok(future)
    }

    fn commit_provider_result(
        &self,
        provider_result: NativeResult<Vec<NativeRunPodManagedPodV1>>,
        inventory: Option<&GpuInventoryService>,
    ) -> NativeResult<NativeGpuPodObservationV1> {
        let (profile_generation, observation_generation) = {
            let inner = self.inner.lock().map_err(|_| pod_state_unavailable())?;
            (inner.profile_generation, inner.observation_generation)
        };
        self.commit_provider_result_for_generations(
            provider_result,
            inventory,
            profile_generation,
            observation_generation,
            ObservationCommitMode::Normal,
        )
    }

    fn commit_provider_result_for_generations(
        &self,
        provider_result: NativeResult<Vec<NativeRunPodManagedPodV1>>,
        inventory: Option<&GpuInventoryService>,
        profile_generation: u64,
        observation_generation: u64,
        commit_mode: ObservationCommitMode,
    ) -> NativeResult<NativeGpuPodObservationV1> {
        let mut inner = self.inner.lock().map_err(|_| pod_state_unavailable())?;
        if inner.profile_generation != profile_generation
            || inner.observation_generation != observation_generation
        {
            return Err(observation_superseded());
        }
        let next_revision = inner
            .current
            .lifecycle_revision
            .checked_add(1)
            .filter(|revision| *revision <= MAX_SAFE_INTEGER)
            .ok_or_else(pod_revision_exhausted)?;
        let observed_at = utc_now_rfc3339_millis()?;
        let (snapshot, selector_projection) = match commit_mode {
            ObservationCommitMode::RetainUncertainStop { pod, observed_at } => {
                let _ = provider_result;
                let snapshot = NativeGpuPodObservationV1 {
                    schema_version: 1,
                    process_epoch_id: self.process_epoch_id.clone(),
                    lifecycle_revision: next_revision,
                    state: "unavailable".to_owned(),
                    observed_at: observed_at.clone(),
                    stale: true,
                    pods: vec![pod.clone()],
                    overflow: false,
                    issue: Some(observation_issue_unavailable()),
                };
                (
                    snapshot,
                    Some((Some(selector_pod(&pod)), observed_at, true)),
                )
            }
            ObservationCommitMode::Normal => match provider_result {
                Ok(pods) if pods.len() <= MAX_VISIBLE_PODS => {
                    let safe_pods = pods.into_iter().map(observed_pod).collect::<Vec<_>>();
                    if strict_sorted_unique_pods(&safe_pods) {
                        let state = match safe_pods.len() {
                            0 => "offline",
                            1 => "single",
                            _ => "multiple",
                        }
                        .to_owned();
                        let selector_projection = match safe_pods.as_slice() {
                            [pod] => {
                                Some((Some(selector_pod(pod)), Some(observed_at.clone()), false))
                            }
                            // A null currentPod is never accompanied by a
                            // timestamp or stale marker: that pair would
                            // falsely imply a concrete, retained identity.
                            _ => Some((None, None, false)),
                        };
                        let snapshot = NativeGpuPodObservationV1 {
                            schema_version: 1,
                            process_epoch_id: self.process_epoch_id.clone(),
                            lifecycle_revision: next_revision,
                            state,
                            observed_at: Some(observed_at.clone()),
                            stale: false,
                            pods: safe_pods,
                            overflow: false,
                            issue: None,
                        };
                        inner.last_valid = Some(snapshot.clone());
                        (snapshot, selector_projection)
                    } else {
                        unavailable_snapshot(
                            &self.process_epoch_id,
                            next_revision,
                            &inner.last_valid,
                            observation_issue_invalid(),
                        )
                    }
                }
                Ok(_) => {
                    let snapshot = NativeGpuPodObservationV1 {
                        schema_version: 1,
                        process_epoch_id: self.process_epoch_id.clone(),
                        lifecycle_revision: next_revision,
                        state: "multiple".to_owned(),
                        observed_at: Some(observed_at),
                        stale: false,
                        pods: Vec::new(),
                        overflow: true,
                        issue: Some(observation_issue_invalid()),
                    };
                    // A >16 valid row result must not leak a partial list. It
                    // is not a replacement for the last verified selector
                    // identity either, so preserve that join as stale.
                    (
                        snapshot,
                        Some(retained_selector_projection(&inner.last_valid)),
                    )
                }
                Err(error) => {
                    let issue = if error.retryable {
                        observation_issue_unavailable()
                    } else {
                        observation_issue_invalid()
                    };
                    unavailable_snapshot(
                        &self.process_epoch_id,
                        next_revision,
                        &inner.last_valid,
                        issue,
                    )
                }
            },
        };
        inner.current = snapshot.clone();
        // Keep the Pod generation lock through the tiny in-memory selector
        // join. Profile binding takes this lock before resetting selector
        // evidence, so an old-profile commit either publishes before that
        // reset or sees the new generation and publishes nothing at all.
        if let (Some(inventory), Some((pod, observed_at, stale))) = (inventory, selector_projection)
        {
            inventory.replace_current_pod_projection(pod, observed_at, stale)?;
        };
        Ok(snapshot)
    }

    /// Reclassify the already-completed R+2 list as deletion uncertainty
    /// without issuing a third provider read or advancing revision again. This
    /// is needed when a known 204/404 lacks a valid absence proof (overflow,
    /// malformed retention, or the exact old Pod still visible): uncertainty
    /// must preserve the old identity rather than publishing an empty/offline
    /// projection at the same generation.
    fn overwrite_current_with_uncertain_stop(
        &self,
        inventory: Option<GpuInventoryService>,
        post: &NativeGpuPodObservationV1,
        retained_pod: &NativeGpuObservedPodV1,
        retained_observed_at: Option<String>,
    ) -> NativeResult<NativeGpuPodObservationV1> {
        let Some(observed_at) = retained_observed_at else {
            return Err(stop_recovery_unavailable());
        };
        let mut inner = self.inner.lock().map_err(|_| pod_state_unavailable())?;
        if inner.current.lifecycle_revision != post.lifecycle_revision
            || inner.current.process_epoch_id != post.process_epoch_id
        {
            return Err(observation_superseded());
        }
        let snapshot = NativeGpuPodObservationV1 {
            schema_version: 1,
            process_epoch_id: self.process_epoch_id.clone(),
            lifecycle_revision: post.lifecycle_revision,
            state: "unavailable".to_owned(),
            observed_at: Some(observed_at.clone()),
            stale: true,
            pods: vec![retained_pod.clone()],
            overflow: false,
            issue: Some(observation_issue_unavailable()),
        };
        validate_pod_observation(&snapshot)?;
        inner.current = snapshot.clone();
        if let Some(inventory) = inventory {
            inventory.replace_current_pod_projection(
                Some(selector_pod(retained_pod)),
                Some(observed_at),
                true,
            )?;
        }
        Ok(snapshot)
    }
}

fn observed_pod(pod: NativeRunPodManagedPodV1) -> NativeGpuObservedPodV1 {
    NativeGpuObservedPodV1 {
        pod_id: pod.pod_id,
        gpu_id: pod.gpu_id,
        gpu_display_name: pod.gpu_display_name,
        hourly_price_micro_usd: pod.hourly_price_micro_usd,
        status: pod.status,
    }
}

/// Run the two final guards that sit between a successful worker Finalize and
/// native provider DELETE authority. The delete-intent closure is deliberately
/// last: a local Switch/profile veto or a mismatched worker finalization marker
/// therefore cannot authorize or send a DELETE.
async fn verify_normal_stop_delete_boundary<V, D, T>(
    mutation_check: &NativeNormalStopMutationCheckV1,
    context: NativeNormalStopMutationContextV1,
    verify_worker_finalization: V,
    mint_delete_intent: D,
) -> NativeResult<T>
where
    V: Future<Output = NativeResult<()>>,
    D: FnOnce() -> NativeResult<T>,
{
    mutation_check(NativeNormalStopMutationBoundaryV1::Delete, context).await?;
    verify_worker_finalization.await?;
    mint_delete_intent()
}

fn initial_observation(process_epoch_id: &str) -> NativeGpuPodObservationV1 {
    NativeGpuPodObservationV1 {
        schema_version: 1,
        process_epoch_id: process_epoch_id.to_owned(),
        lifecycle_revision: 0,
        state: "unavailable".to_owned(),
        observed_at: None,
        stale: true,
        pods: Vec::new(),
        overflow: false,
        issue: Some(observation_issue_unavailable()),
    }
}

fn unavailable_snapshot(
    process_epoch_id: &str,
    lifecycle_revision: u64,
    last_valid: &Option<NativeGpuPodObservationV1>,
    issue: NativeGpuPodObservationIssueV1,
) -> (
    NativeGpuPodObservationV1,
    Option<(Option<NativeGpuSwitchPodV1>, Option<String>, bool)>,
) {
    let (observed_at, pods) = last_valid
        .as_ref()
        .map(|prior| (prior.observed_at.clone(), prior.pods.clone()))
        .unwrap_or((None, Vec::new()));
    let snapshot = NativeGpuPodObservationV1 {
        schema_version: 1,
        process_epoch_id: process_epoch_id.to_owned(),
        lifecycle_revision,
        state: "unavailable".to_owned(),
        observed_at,
        stale: true,
        pods,
        overflow: false,
        issue: Some(issue),
    };
    let selector = retained_selector_projection(last_valid);
    (snapshot, Some(selector))
}

fn retained_selector_projection(
    last_valid: &Option<NativeGpuPodObservationV1>,
) -> (Option<NativeGpuSwitchPodV1>, Option<String>, bool) {
    let Some(prior) = last_valid
        .as_ref()
        .filter(|prior| prior.state == "single" && prior.pods.len() == 1)
    else {
        return (None, None, false);
    };
    let Some(observed_at) = prior.observed_at.clone() else {
        return (None, None, false);
    };
    (Some(selector_pod(&prior.pods[0])), Some(observed_at), true)
}

fn selector_pod(pod: &NativeGpuObservedPodV1) -> NativeGpuSwitchPodV1 {
    NativeGpuSwitchPodV1 {
        pod_id: pod.pod_id.clone(),
        gpu_id: pod.gpu_id.clone(),
        gpu_display_name: pod.gpu_display_name.clone(),
        hourly_price_micro_usd: pod.hourly_price_micro_usd,
    }
}

fn strict_sorted_unique_pods(pods: &[NativeGpuObservedPodV1]) -> bool {
    pods.iter().all(|pod| valid_status(&pod.status))
        && pods
            .windows(2)
            .all(|pair| pair[0].pod_id.as_str() < pair[1].pod_id.as_str())
}

fn valid_status(value: &str) -> bool {
    matches!(
        value,
        "provisioning" | "starting" | "running" | "exited" | "error" | "terminated" | "unknown"
    )
}

fn exact_fresh_normal_stop_preflight(
    observation: &NativeGpuPodObservationV1,
    input: &NativeGpuNormalStopV1,
) -> NativeResult<NativeGpuObservedPodV1> {
    validate_pod_observation(observation)?;
    let expected_preflight_revision = input
        .expected_lifecycle_revision
        .checked_add(1)
        .ok_or_else(pod_revision_exhausted)?;
    match observation.pods.as_slice() {
        [pod]
            if observation.state == "single"
                && !observation.stale
                && !observation.overflow
                && observation.issue.is_none()
                && observation.lifecycle_revision == expected_preflight_revision
                && pod.pod_id == input.pod_id =>
        {
            Ok(pod.clone())
        }
        _ => Err(stop_preflight_mismatch()),
    }
}

fn managed_pod_matches_observed(
    managed: &NativeRunPodManagedPodV1,
    observed: &NativeGpuObservedPodV1,
) -> bool {
    managed.pod_id == observed.pod_id
        && managed.gpu_id == observed.gpu_id
        && managed.gpu_display_name == observed.gpu_display_name
        && managed.hourly_price_micro_usd == observed.hourly_price_micro_usd
        && managed.status == observed.status
}

fn fresh_absence_proof(observation: &NativeGpuPodObservationV1, pod_id: &str) -> bool {
    validate_pod_observation(observation).is_ok()
        && !observation.stale
        && !observation.overflow
        && observation.issue.is_none()
        && matches!(
            observation.state.as_str(),
            "offline" | "single" | "multiple"
        )
        && !observation.pods.iter().any(|pod| pod.pod_id == pod_id)
}

fn uncertain_normal_stop_result(
    operation_id: String,
    pod_id: String,
    observation: NativeGpuPodObservationV1,
) -> NativeGpuNormalStopResultV1 {
    NativeGpuNormalStopResultV1 {
        schema_version: 1,
        operation_id,
        pod_id,
        disposition: "delete_uncertain".to_owned(),
        observation,
        issue: Some(NativeGpuNormalStopIssueV1 {
            code: "gpu_stop_delete_uncertain".to_owned(),
            retryable: false,
        }),
    }
}

fn observation_issue_unavailable() -> NativeGpuPodObservationIssueV1 {
    NativeGpuPodObservationIssueV1 {
        code: "gpu_pod_observation_unavailable".to_owned(),
        retryable: true,
    }
}

fn stop_preflight_mismatch() -> NativeError {
    NativeError::new(
        "gpu_pod_observation_invalid",
        "The GPU Pod changed before ImageForge could safely stop it. Refresh shared status before continuing.",
    )
}

fn stop_recovery_unavailable() -> NativeError {
    NativeError::new(
        "gpu_pod_observation_invalid",
        "Native ImageForge GPU Stop recovery state is unavailable.",
    )
}

fn observation_issue_invalid() -> NativeGpuPodObservationIssueV1 {
    NativeGpuPodObservationIssueV1 {
        code: "gpu_pod_observation_invalid".to_owned(),
        retryable: false,
    }
}

fn pod_state_unavailable() -> NativeError {
    NativeError::new(
        "gpu_pod_observation_invalid",
        "Native ImageForge Pod observation state is unavailable.",
    )
}

fn pod_revision_exhausted() -> NativeError {
    NativeError::new(
        "gpu_pod_revision_exhausted",
        "GPU Pod history reached its safe revision limit. Export recovery evidence before continuing.",
    )
}

fn observation_superseded() -> NativeError {
    NativeError::retryable(
        "gpu_pod_observation_unavailable",
        "The ImageForge Pod observation changed while its request was in progress. Refresh before continuing.",
    )
}

fn stop_observation_in_progress() -> NativeError {
    NativeError::retryable(
        "gpu_pod_observation_unavailable",
        "ImageForge is verifying a GPU Stop. Refresh after the current check completes.",
    )
}

pub(crate) fn validate_normal_stop_input(input: &NativeGpuNormalStopV1) -> NativeResult<()> {
    validate_pod_id(&input.pod_id)?;
    for value in [
        &input.stop_request_id,
        &input.session_id,
        &input.expected_server_instance_id,
    ] {
        validate_uuid(value)?;
    }
    if input.expected_coordination_revision > MAX_SAFE_INTEGER
        || input.expected_lifecycle_revision > MAX_SAFE_INTEGER
    {
        return Err(NativeError::new(
            "gpu_pod_observation_invalid",
            "The native GPU Stop request is invalid.",
        ));
    }
    Ok(())
}

/// Validate the public observation object independently of the live service.
///
/// This is deliberately usable by the private Stop journal as well as IPC
/// decoding: a persisted projection is still authority-bearing recovery data,
/// so serde's shape checks alone are not enough. Keep this in lockstep with
/// `contracts/gpu-pod-control-v1.schema.json` and its semantic vectors.
pub(crate) fn validate_pod_observation(
    observation: &NativeGpuPodObservationV1,
) -> NativeResult<()> {
    if observation.schema_version != 1
        || !canonical_uuid_v4(&observation.process_epoch_id)
        || observation.lifecycle_revision > MAX_SAFE_INTEGER
        || observation.pods.len() > MAX_VISIBLE_PODS
        || !observation.pods.iter().all(validate_observed_pod)
        || !strict_sorted_unique_pods(&observation.pods)
        || observation
            .observed_at
            .as_deref()
            .is_some_and(|value| !valid_rfc3339_millis(value))
    {
        return Err(invalid_projection());
    }

    let valid = match observation.state.as_str() {
        "offline" => {
            observation.observed_at.is_some()
                && !observation.stale
                && !observation.overflow
                && observation.pods.is_empty()
                && observation.issue.is_none()
        }
        "single" => {
            observation.observed_at.is_some()
                && !observation.stale
                && !observation.overflow
                && observation.pods.len() == 1
                && observation.issue.is_none()
        }
        "multiple" if observation.overflow => {
            observation.observed_at.is_some()
                && !observation.stale
                && observation.pods.is_empty()
                && matches!(
                    observation.issue.as_ref(),
                    Some(issue)
                        if issue.code == "gpu_pod_observation_invalid" && !issue.retryable
                )
        }
        "multiple" => {
            observation.observed_at.is_some()
                && !observation.stale
                && observation.pods.len() >= 2
                && observation.issue.is_none()
        }
        "unavailable" => {
            observation.stale
                && !observation.overflow
                // Retained Pod identity is only meaningful alongside its
                // original verified timestamp. A null time is allowed solely
                // for an empty no-prior-evidence failure projection.
                && (observation.observed_at.is_some() || observation.pods.is_empty())
                && matches!(
                    observation.issue.as_ref(),
                    Some(issue)
                        if (issue.code == "gpu_pod_observation_unavailable" && issue.retryable)
                            || (issue.code == "gpu_pod_observation_invalid" && !issue.retryable)
                )
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(invalid_projection())
    }
}

/// Validate the complete public result relation. `input` is optional because
/// structural vector tests also exercise results before a live request exists;
/// durable recovery always passes the original input and therefore binds the
/// exact Pod identity.
pub(crate) fn validate_normal_stop_result(
    result: &NativeGpuNormalStopResultV1,
    input: Option<&NativeGpuNormalStopV1>,
) -> NativeResult<()> {
    if result.schema_version != 1
        || !canonical_uuid_v4(&result.operation_id)
        || validate_pod_id(&result.pod_id).is_err()
        || input.is_some_and(|request| request.pod_id != result.pod_id)
        || validate_pod_observation(&result.observation).is_err()
    {
        return Err(invalid_projection());
    }

    let old_pod_present = result
        .observation
        .pods
        .iter()
        .any(|pod| pod.pod_id == result.pod_id);
    let fresh_absence_proof = !result.observation.stale
        && !result.observation.overflow
        && result.observation.issue.is_none()
        && matches!(
            result.observation.state.as_str(),
            "offline" | "single" | "multiple"
        )
        && !old_pod_present;
    let valid = match result.disposition.as_str() {
        "stopped" | "already_stopped" => result.issue.is_none() && fresh_absence_proof,
        "delete_uncertain" => {
            matches!(
                result.issue.as_ref(),
                Some(issue) if issue.code == "gpu_stop_delete_uncertain" && !issue.retryable
            ) && old_pod_present
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(invalid_projection())
    }
}

fn validate_observed_pod(pod: &NativeGpuObservedPodV1) -> bool {
    valid_pod_id_raw(&pod.pod_id)
        && valid_gpu_identity(&pod.gpu_id)
        && valid_gpu_identity(&pod.gpu_display_name)
        && pod
            .hourly_price_micro_usd
            .is_none_or(|value| value <= MAX_SAFE_INTEGER)
        && valid_status(&pod.status)
}

fn valid_pod_id_raw(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 58
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn valid_gpu_identity(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=128).contains(&bytes.len())
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.iter().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(*byte, b' ' | b'.' | b'_' | b'(' | b')' | b'+' | b':' | b'-')
        })
}

fn valid_rfc3339_millis(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 24
        || !matches!(
            (
                bytes.get(4),
                bytes.get(7),
                bytes.get(10),
                bytes.get(13),
                bytes.get(16),
                bytes.get(19),
                bytes.get(23)
            ),
            (
                Some(b'-'),
                Some(b'-'),
                Some(b'T'),
                Some(b':'),
                Some(b':'),
                Some(b'.'),
                Some(b'Z')
            )
        )
        || ![0..4, 5..7, 8..10, 11..13, 14..16, 17..19, 20..23]
            .into_iter()
            .flatten()
            .all(|index| bytes[index].is_ascii_digit())
    {
        return false;
    }
    let parse = |start: usize, end: usize| {
        std::str::from_utf8(&bytes[start..end])
            .ok()
            .and_then(|part| part.parse::<u32>().ok())
    };
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        parse(0, 4),
        parse(5, 7),
        parse(8, 10),
        parse(11, 13),
        parse(14, 16),
        parse(17, 19),
    ) else {
        return false;
    };
    if year == 0 || !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 59 {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=max_day).contains(&day)
}

fn canonical_uuid_v4(value: &str) -> bool {
    Uuid::parse_str(value).ok().is_some_and(|uuid| {
        uuid.get_version() == Some(Version::Random) && uuid.to_string() == value
    })
}

fn invalid_projection() -> NativeError {
    NativeError::new(
        "gpu_pod_observation_invalid",
        "The native GPU Pod projection is invalid.",
    )
}

fn validate_pod_id(value: &str) -> NativeResult<()> {
    if value.is_empty()
        || value.len() > 58
        || value.starts_with('-')
        || value.ends_with('-')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(NativeError::new(
            "gpu_pod_observation_invalid",
            "The native GPU Stop request is invalid.",
        ));
    }
    Ok(())
}

fn validate_uuid(value: &str) -> NativeResult<()> {
    let parsed = Uuid::parse_str(value).map_err(|_| {
        NativeError::new(
            "gpu_pod_observation_invalid",
            "The native GPU Stop request is invalid.",
        )
    })?;
    if parsed.get_version() != Some(Version::Random) || parsed.to_string() != value {
        return Err(NativeError::new(
            "gpu_pod_observation_invalid",
            "The native GPU Stop request is invalid.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::oneshot;

    fn pod(id: &str) -> NativeRunPodManagedPodV1 {
        NativeRunPodManagedPodV1 {
            pod_id: id.to_owned(),
            pod_name: format!("imageforge-{id}"),
            gpu_id: "NVIDIA GeForce RTX 4090".to_owned(),
            gpu_display_name: "NVIDIA GeForce RTX 4090".to_owned(),
            hourly_price_micro_usd: Some(540_000),
            status: "running".to_owned(),
            provider_response_sha256:
                "1111111111111111111111111111111111111111111111111111111111111111".to_owned(),
        }
    }

    fn test_inventory() -> (tempfile::TempDir, GpuInventoryService) {
        let directory = tempfile::tempdir().unwrap();
        let inventory =
            GpuInventoryService::new_for_test(directory.path().join("gpu-start")).unwrap();
        (directory, inventory)
    }

    fn normal_stop_input(expected_lifecycle_revision: u64) -> NativeGpuNormalStopV1 {
        NativeGpuNormalStopV1 {
            pod_id: "shared-pod-1".to_owned(),
            stop_request_id: "55555555-5555-4555-8555-555555555555".to_owned(),
            session_id: "22222222-2222-4222-8222-222222222222".to_owned(),
            expected_server_instance_id: "11111111-1111-4111-8111-111111111111".to_owned(),
            expected_coordination_revision: 7,
            expected_lifecycle_revision,
        }
    }

    fn normal_stop_mutation_context() -> NativeNormalStopMutationContextV1 {
        NativeNormalStopMutationContextV1 {
            input: normal_stop_input(0),
            operation_id: "44444444-4444-4444-8444-444444444444".to_owned(),
            finalization_id: "66666666-6666-4666-8666-666666666666".to_owned(),
        }
    }

    fn assert_null_pod_join(inventory: &GpuInventoryService) {
        let projection = inventory.load().unwrap();
        assert!(projection.current_pod.is_none());
        assert!(projection.current_pod_observed_at.is_none());
        assert!(!projection.current_pod_stale);
    }

    #[test]
    fn terminal_observation_retains_only_prior_valid_rows_on_invalid_provider_result() {
        let service = GpuPodService::new("50000000-0000-4000-8000-000000000000".to_owned());
        let first = service
            .commit_provider_result(Ok(vec![pod("pod-exact-1")]), None)
            .unwrap();
        assert_eq!(first.state, "single");
        assert_eq!(first.lifecycle_revision, 1);

        let invalid = service
            .commit_provider_result(
                Err(NativeError::new("gpu_pod_observation_invalid", "invalid")),
                None,
            )
            .unwrap();
        assert_eq!(invalid.state, "unavailable");
        assert!(invalid.stale);
        assert_eq!(invalid.lifecycle_revision, 2);
        assert_eq!(invalid.pods, first.pods);
        assert_eq!(
            invalid.issue.as_ref().map(|issue| issue.code.as_str()),
            Some("gpu_pod_observation_invalid")
        );
        let (selector, observed_at, stale) = retained_selector_projection(&Some(first));
        assert_eq!(
            selector.as_ref().map(|pod| pod.pod_id.as_str()),
            Some("pod-exact-1")
        );
        assert_eq!(observed_at, invalid.observed_at);
        assert!(stale);
    }

    #[test]
    fn overflow_never_crosses_a_partial_pod_list() {
        let service = GpuPodService::new("50000000-0000-4000-8000-000000000000".to_owned());
        let pods = (0..=MAX_VISIBLE_PODS)
            .map(|index| pod(&format!("pod-{index:02}")))
            .collect();
        let overflow = service.commit_provider_result(Ok(pods), None).unwrap();
        assert_eq!(overflow.state, "multiple");
        assert!(overflow.overflow);
        assert!(overflow.pods.is_empty());
        assert_eq!(
            overflow.issue.as_ref().map(|issue| issue.code.as_str()),
            Some("gpu_pod_observation_invalid")
        );
    }

    #[test]
    fn inventory_join_clears_pod_metadata_for_offline_and_multiple_success() {
        let (_directory, inventory) = test_inventory();
        let service = GpuPodService::new("50000000-0000-4000-8000-000000000000".to_owned());

        service
            .commit_provider_result(Ok(Vec::new()), Some(&inventory))
            .unwrap();
        assert_null_pod_join(&inventory);

        service
            .commit_provider_result(
                Ok(vec![pod("pod-exact-1"), pod("pod-exact-2")]),
                Some(&inventory),
            )
            .unwrap();
        assert_null_pod_join(&inventory);
    }

    #[test]
    fn inventory_join_clears_pod_metadata_for_no_prior_invalid_and_overflow() {
        let (_directory, inventory) = test_inventory();
        let service = GpuPodService::new("50000000-0000-4000-8000-000000000000".to_owned());
        service
            .commit_provider_result(
                Err(NativeError::new(
                    "gpu_pod_observation_invalid",
                    "malformed provider projection",
                )),
                Some(&inventory),
            )
            .unwrap();
        assert_null_pod_join(&inventory);

        let (_overflow_directory, overflow_inventory) = test_inventory();
        let overflow_service =
            GpuPodService::new("50000000-0000-4000-8000-000000000000".to_owned());
        let overflow = (0..=MAX_VISIBLE_PODS)
            .map(|index| pod(&format!("pod-{index:02}")))
            .collect();
        overflow_service
            .commit_provider_result(Ok(overflow), Some(&overflow_inventory))
            .unwrap();
        assert_null_pod_join(&overflow_inventory);
    }

    #[test]
    fn inventory_join_clears_pod_metadata_when_invalid_result_follows_non_single_state() {
        let (_directory, inventory) = test_inventory();
        let service = GpuPodService::new("50000000-0000-4000-8000-000000000000".to_owned());
        service
            .commit_provider_result(
                Ok(vec![pod("pod-exact-1"), pod("pod-exact-2")]),
                Some(&inventory),
            )
            .unwrap();
        service
            .commit_provider_result(
                Err(NativeError::new(
                    "gpu_pod_observation_invalid",
                    "malformed provider projection",
                )),
                Some(&inventory),
            )
            .unwrap();
        assert_null_pod_join(&inventory);
    }

    #[test]
    fn inventory_join_rejects_a_crafted_retained_single_pod_without_a_timestamp() {
        let (_directory, inventory) = test_inventory();
        let service = GpuPodService::new("50000000-0000-4000-8000-000000000000".to_owned());
        service.inner.lock().unwrap().last_valid = Some(NativeGpuPodObservationV1 {
            schema_version: 1,
            process_epoch_id: service.process_epoch_id.clone(),
            lifecycle_revision: 1,
            state: "single".to_owned(),
            observed_at: None,
            stale: false,
            pods: vec![observed_pod(pod("pod-missing-time"))],
            overflow: false,
            issue: None,
        });

        service
            .commit_provider_result(
                Err(NativeError::new(
                    "gpu_pod_observation_invalid",
                    "malformed provider projection",
                )),
                Some(&inventory),
            )
            .unwrap();
        assert_null_pod_join(&inventory);
        assert_eq!(
            retained_selector_projection(&service.inner.lock().unwrap().last_valid),
            (None, None, false)
        );
    }

    #[test]
    fn inventory_join_retains_a_verified_single_pod_across_invalid_and_transport_failures() {
        let (_directory, inventory) = test_inventory();
        let service = GpuPodService::new("50000000-0000-4000-8000-000000000000".to_owned());
        service
            .commit_provider_result(Ok(vec![pod("pod-exact-1")]), Some(&inventory))
            .unwrap();
        let verified = inventory.load().unwrap();
        let expected_pod = verified.current_pod.clone().unwrap();
        let expected_observed_at = verified.current_pod_observed_at.clone().unwrap();
        assert!(!verified.current_pod_stale);

        for provider_failure in [
            NativeError::new(
                "gpu_pod_observation_invalid",
                "malformed provider projection",
            ),
            NativeError::retryable(
                "gpu_pod_observation_unavailable",
                "transient provider transport failure",
            ),
        ] {
            service
                .commit_provider_result(Err(provider_failure), Some(&inventory))
                .unwrap();
            let retained = inventory.load().unwrap();
            assert_eq!(retained.current_pod, Some(expected_pod.clone()));
            assert_eq!(
                retained.current_pod_observed_at,
                Some(expected_observed_at.clone())
            );
            assert!(retained.current_pod_stale);
        }
    }

    #[test]
    fn profile_rebind_clears_revision_retained_rows_and_active_join() {
        let service = GpuPodService::new("50000000-0000-4000-8000-000000000000".to_owned());
        service
            .commit_provider_result(Ok(vec![pod("pod-exact-1")]), None)
            .unwrap();
        service.reset_for_profile_binding().unwrap();
        let reset = service.load().unwrap();
        assert_eq!(reset.lifecycle_revision, 0);
        assert_eq!(reset.state, "unavailable");
        assert!(reset.observed_at.is_none());
        assert!(reset.pods.is_empty());
        assert!(service.inner.lock().unwrap().last_valid.is_none());
    }

    #[tokio::test]
    async fn revision_exhaustion_rejects_before_invoking_the_provider_reader() {
        let service = GpuPodService::new("50000000-0000-4000-8000-000000000000".to_owned());
        service.inner.lock().unwrap().current.lifecycle_revision = MAX_SAFE_INTEGER;
        let error = service
            .observe_with_reader(None, |_| {
                async move {
                    panic!("revision exhaustion must not start a provider read");
                    #[allow(unreachable_code)]
                    Ok(Vec::new())
                }
                .boxed()
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, "gpu_pod_revision_exhausted");
        assert_eq!(
            error.message,
            "GPU Pod history reached its safe revision limit. Export recovery evidence before continuing."
        );
        assert_eq!(service.load().unwrap().lifecycle_revision, MAX_SAFE_INTEGER);
    }

    #[tokio::test]
    async fn overlapping_observers_share_one_reader_and_one_committed_snapshot() {
        let service = GpuPodService::new("50000000-0000-4000-8000-000000000000".to_owned());
        let reader_count = Arc::new(AtomicUsize::new(0));
        let first_count = reader_count.clone();
        let producer = service
            .reserve_observation(None, move |_| {
                first_count.fetch_add(1, Ordering::SeqCst);
                async move { Ok(vec![pod("pod-exact-1")]) }.boxed()
            })
            .unwrap();
        let joined_count = reader_count.clone();
        let joined = service
            .reserve_observation(None, move |_| {
                joined_count.fetch_add(1, Ordering::SeqCst);
                async move {
                    Err(NativeError::new(
                        "gpu_pod_observation_invalid",
                        "a joined Pod observer must not invoke a second provider read",
                    ))
                }
                .boxed()
            })
            .unwrap();

        let (producer_result, joined_result) = tokio::join!(producer, joined);
        let producer_result = producer_result.unwrap();
        let joined_result = joined_result.unwrap();
        assert_eq!(reader_count.load(Ordering::SeqCst), 1);
        assert_eq!(
            serde_json::to_vec(&producer_result).unwrap(),
            serde_json::to_vec(&joined_result).unwrap()
        );
        assert_eq!(producer_result, service.load().unwrap());
        assert_eq!(producer_result.lifecycle_revision, 1);
        assert!(service.inner.lock().unwrap().active.is_none());
    }

    #[tokio::test]
    async fn old_profile_completion_after_rebind_cannot_publish_or_clear_new_active_observer() {
        let service = GpuPodService::new("50000000-0000-4000-8000-000000000000".to_owned());
        let (_directory, inventory) = test_inventory();
        let (old_started_send, old_started_receive) = oneshot::channel::<()>();
        let (old_release_send, old_release_receive) =
            oneshot::channel::<NativeResult<Vec<NativeRunPodManagedPodV1>>>();
        let old_inventory = inventory.clone();
        let old_observation = service
            .reserve_observation(Some(old_inventory), move |_| {
                async move {
                    let _ = old_started_send.send(());
                    old_release_receive.await.unwrap_or_else(|_| {
                        Err(NativeError::new(
                            "gpu_pod_observation_invalid",
                            "old observation test producer was cancelled",
                        ))
                    })
                }
                .boxed()
            })
            .unwrap();
        let old_task = tokio::spawn(old_observation);
        old_started_receive.await.unwrap();

        service.reset_for_profile_binding().unwrap();
        inventory.reset_for_profile_binding().unwrap();
        let current_generation = service.inner.lock().unwrap().profile_generation;
        assert_eq!(current_generation, 1);

        let (new_started_send, new_started_receive) = oneshot::channel::<()>();
        let (new_release_send, new_release_receive) =
            oneshot::channel::<NativeResult<Vec<NativeRunPodManagedPodV1>>>();
        let new_observation = service
            .reserve_observation(None, move |_| {
                async move {
                    let _ = new_started_send.send(());
                    new_release_receive.await.unwrap_or_else(|_| {
                        Err(NativeError::new(
                            "gpu_pod_observation_invalid",
                            "new observation test producer was cancelled",
                        ))
                    })
                }
                .boxed()
            })
            .unwrap();
        let new_task = tokio::spawn(new_observation);
        new_started_receive.await.unwrap();

        old_release_send
            .send(Ok(vec![pod("pod-old-profile")]))
            .unwrap();
        let old_error = old_task.await.unwrap().unwrap_err();
        assert_eq!(old_error.code, "gpu_pod_observation_unavailable");
        assert!(old_error.retryable);
        let after_old_completion = service.load().unwrap();
        assert_eq!(after_old_completion.lifecycle_revision, 0);
        assert!(after_old_completion.pods.is_empty());
        assert_null_pod_join(&inventory);
        let active_generation = service
            .inner
            .lock()
            .unwrap()
            .active
            .as_ref()
            .map(|active| active.profile_generation);
        assert_eq!(active_generation, Some(current_generation));

        new_release_send
            .send(Ok(vec![pod("pod-new-profile")]))
            .unwrap();
        let new_snapshot = new_task.await.unwrap().unwrap();
        assert_eq!(new_snapshot.lifecycle_revision, 1);
        assert_eq!(new_snapshot.pods[0].pod_id, "pod-new-profile");
        assert_eq!(new_snapshot, service.load().unwrap());
        assert!(service.inner.lock().unwrap().active.is_none());
    }

    #[tokio::test]
    async fn stop_owned_observations_supersede_a_heartbeat_and_reserve_two_new_revisions() {
        let service = GpuPodService::new("50000000-0000-4000-8000-000000000000".to_owned());
        let (heartbeat_started_send, heartbeat_started_receive) = oneshot::channel::<()>();
        let (heartbeat_release_send, heartbeat_release_receive) =
            oneshot::channel::<NativeResult<Vec<NativeRunPodManagedPodV1>>>();
        let heartbeat = service
            .reserve_observation(None, move |_| {
                async move {
                    let _ = heartbeat_started_send.send(());
                    heartbeat_release_receive.await.unwrap_or_else(|_| {
                        Err(NativeError::new(
                            "gpu_pod_observation_invalid",
                            "heartbeat test producer was cancelled",
                        ))
                    })
                }
                .boxed()
            })
            .unwrap();
        let heartbeat_task = tokio::spawn(heartbeat);
        heartbeat_started_receive.await.unwrap();

        // Stop admission owns the observer before it reserves R+1. The
        // existing heartbeat may still finish its socket, but its captured
        // generation can no longer publish and no new heartbeat can begin.
        service.begin_stop_observation_action().unwrap();

        let preflight = service
            .reserve_stop_observation(0, None, |_| {
                async move { Ok(vec![pod("pod-stop-target")]) }.boxed()
            })
            .unwrap()
            .await
            .unwrap();
        assert_eq!(preflight.lifecycle_revision, 1);
        assert_eq!(preflight.pods[0].pod_id, "pod-stop-target");
        let blocked = service
            .reserve_observation(None, |_| async move { Ok(Vec::new()) }.boxed())
            .unwrap_err();
        assert_eq!(blocked.code, "gpu_pod_observation_unavailable");

        // The heartbeat began before Stop-owned preflight. Its delayed result
        // cannot become R+1 or overwrite the Stop's exact target evidence.
        heartbeat_release_send
            .send(Ok(vec![pod("pod-heartbeat-old")]))
            .unwrap();
        assert_eq!(
            heartbeat_task.await.unwrap().unwrap_err().code,
            "gpu_pod_observation_unavailable"
        );
        assert_eq!(service.load().unwrap(), preflight);

        let post_delete = service
            .reserve_stop_observation(1, None, |_| async move { Ok(Vec::new()) }.boxed())
            .unwrap()
            .await
            .unwrap();
        assert_eq!(post_delete.lifecycle_revision, 2);
        assert_eq!(post_delete.state, "offline");
        service.finish_stop_observation_action().unwrap();
        assert!(!service.inner.lock().unwrap().stop_observation_active);
    }

    #[test]
    fn retained_pod_identity_without_its_verified_timestamp_is_not_a_valid_projection() {
        let invalid = NativeGpuPodObservationV1 {
            schema_version: 1,
            process_epoch_id: "50000000-0000-4000-8000-000000000000".to_owned(),
            lifecycle_revision: 12,
            state: "unavailable".to_owned(),
            observed_at: None,
            stale: true,
            pods: vec![observed_pod(pod("pod-exact-1"))],
            overflow: false,
            issue: Some(observation_issue_unavailable()),
        };
        assert_eq!(
            validate_pod_observation(&invalid).unwrap_err().code,
            "gpu_pod_observation_invalid"
        );
    }

    #[test]
    fn new_stop_at_max_minus_one_rejects_before_reserving_a_provider_reader() {
        let service = GpuPodService::new("50000000-0000-4000-8000-000000000000".to_owned());
        service.inner.lock().unwrap().current.lifecycle_revision = MAX_SAFE_INTEGER - 1;
        service.begin_stop_observation_action().unwrap();
        let reader_calls = Arc::new(AtomicUsize::new(0));
        let calls = reader_calls.clone();
        let error = match service.reserve_stop_observation(MAX_SAFE_INTEGER - 1, None, move |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            async move { Ok(Vec::new()) }.boxed()
        }) {
            Err(error) => error,
            Ok(_) => panic!("MAX-1 must not reserve a Stop reader"),
        };
        assert_eq!(error.code, "gpu_pod_revision_exhausted");
        assert_eq!(reader_calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            service.load().unwrap().lifecycle_revision,
            MAX_SAFE_INTEGER - 1
        );
    }

    #[test]
    fn prelease_new_stop_budget_rejects_before_any_stop_store_or_observer_access() {
        let directory = tempfile::tempdir().unwrap();
        let stop_root = directory.path().join("must-not-be-created");
        let mut service = GpuPodService::new("50000000-0000-4000-8000-000000000000".to_owned());
        service.normal_stop_root = Arc::new(stop_root.clone());
        service.inner.lock().unwrap().current.lifecycle_revision = MAX_SAFE_INTEGER - 1;

        // The pre-lease API has no RunPod, WorkerApi, journal, or file-lease
        // parameter. This missing root and untouched action state make the
        // no-I/O boundary observable rather than relying on a mock socket.
        let error = service
            .assert_new_normal_stop_budget_before_profile_lease(&normal_stop_input(
                MAX_SAFE_INTEGER - 1,
            ))
            .unwrap_err();

        assert_eq!(error.code, "gpu_pod_revision_exhausted");
        assert!(!stop_root.exists());
        let inner = service.inner.lock().unwrap();
        assert!(!inner.stop_observation_active);
        assert_eq!(inner.stop_observation_attempts, 0);
        assert!(inner.active.is_none());
    }

    #[test]
    fn prelease_budget_keeps_an_old_completed_replay_eligible_for_journal_lookup() {
        let service = GpuPodService::new("50000000-0000-4000-8000-000000000000".to_owned());
        // A completed Stop admitted at MAX-2 later owns its historical R+2
        // result at MAX. Its old request must reach the exact-replay journal
        // branch instead of being rejected as a new MAX Stop.
        service.inner.lock().unwrap().current.lifecycle_revision = MAX_SAFE_INTEGER;
        assert!(service
            .assert_new_normal_stop_budget_before_profile_lease(&normal_stop_input(
                MAX_SAFE_INTEGER - 2,
            ))
            .is_ok());
    }

    #[tokio::test]
    async fn normal_stop_delete_boundary_orders_finalize_marker_and_delete_intent() {
        let events = Arc::new(Mutex::new(Vec::<String>::new()));
        let callback_events = events.clone();
        let mutation_check: NativeNormalStopMutationCheckV1 = Arc::new(move |boundary, _| {
            let events = callback_events.clone();
            async move {
                let name = match boundary {
                    NativeNormalStopMutationBoundaryV1::Finalize => "finalize_gate",
                    NativeNormalStopMutationBoundaryV1::Delete => "delete_gate",
                };
                events.lock().unwrap().push(name.to_owned());
                Ok(())
            }
            .boxed()
        });
        let context = normal_stop_mutation_context();

        // Production invokes this first, before the Finalize socket.
        mutation_check(
            NativeNormalStopMutationBoundaryV1::Finalize,
            context.clone(),
        )
        .await
        .unwrap();
        events.lock().unwrap().push("worker_finalize".to_owned());

        let verify_events = events.clone();
        let mint_events = events.clone();
        let minted = verify_normal_stop_delete_boundary(
            &mutation_check,
            context,
            async move {
                verify_events
                    .lock()
                    .unwrap()
                    .push("worker_verify".to_owned());
                Ok(())
            },
            move || {
                mint_events.lock().unwrap().push("delete_intent".to_owned());
                Ok::<_, NativeError>("intent")
            },
        )
        .await
        .unwrap();

        assert_eq!(minted, "intent");
        assert_eq!(
            events.lock().unwrap().as_slice(),
            [
                "finalize_gate",
                "worker_finalize",
                "delete_gate",
                "worker_verify",
                "delete_intent",
            ]
        );
    }

    #[tokio::test]
    async fn normal_stop_delete_boundary_never_mints_delete_intent_after_guard_or_marker_failure() {
        let context = normal_stop_mutation_context();
        let callback_failure: NativeNormalStopMutationCheckV1 = Arc::new(|_, _| {
            async move {
                Err(NativeError::new(
                    "gpu_switch_pending",
                    "test local Switch veto",
                ))
            }
            .boxed()
        });
        let callback_verify_calls = Arc::new(AtomicUsize::new(0));
        let callback_delete_calls = Arc::new(AtomicUsize::new(0));
        let verify_calls = callback_verify_calls.clone();
        let delete_calls = callback_delete_calls.clone();
        let callback_error = verify_normal_stop_delete_boundary(
            &callback_failure,
            context.clone(),
            async move {
                verify_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
            move || {
                delete_calls.fetch_add(1, Ordering::SeqCst);
                Ok::<_, NativeError>(())
            },
        )
        .await
        .unwrap_err();
        assert_eq!(callback_error.code, "gpu_switch_pending");
        assert_eq!(callback_verify_calls.load(Ordering::SeqCst), 0);
        assert_eq!(callback_delete_calls.load(Ordering::SeqCst), 0);

        let marker_failure: NativeNormalStopMutationCheckV1 =
            Arc::new(|_, _| async move { Ok(()) }.boxed());
        let marker_delete_calls = Arc::new(AtomicUsize::new(0));
        let delete_calls = marker_delete_calls.clone();
        let marker_error = verify_normal_stop_delete_boundary(
            &marker_failure,
            context,
            async move {
                Err(NativeError::new(
                    "stop_request_in_progress",
                    "test worker marker mismatch",
                ))
            },
            move || {
                delete_calls.fetch_add(1, Ordering::SeqCst);
                Ok::<_, NativeError>(())
            },
        )
        .await
        .unwrap_err();
        assert_eq!(marker_error.code, "stop_request_in_progress");
        assert_eq!(marker_delete_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn stop_preflight_rechecks_the_expected_revision_before_starting_a_reader() {
        let service = GpuPodService::new("50000000-0000-4000-8000-000000000000".to_owned());
        service.inner.lock().unwrap().current.lifecycle_revision = 4;
        service.begin_stop_observation_action().unwrap();
        let reader_calls = Arc::new(AtomicUsize::new(0));
        let calls = reader_calls.clone();
        let error = match service.reserve_stop_observation(3, None, move |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            async move { Ok(Vec::new()) }.boxed()
        }) {
            Err(error) => error,
            Ok(_) => panic!("a stale Stop revision must not start a provider read"),
        };
        assert_eq!(error.code, "gpu_pod_observation_invalid");
        assert_eq!(reader_calls.load(Ordering::SeqCst), 0);
        assert_eq!(service.load().unwrap().lifecycle_revision, 4);
    }
}
