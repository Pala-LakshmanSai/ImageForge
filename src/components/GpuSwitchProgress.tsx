import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck } from 'lucide-react';
import { formatHourlyMicroUsdV1 } from '@imageforge/runpod-client';
import type { StudioGpuSwitchState } from '../domain/types';
import type {
  NativeGpuSwitchPhaseV1,
  NativeGpuSwitchAttentionCodeV1,
  NativeGpuSwitchSnapshotV1,
} from '../native/gpuSwitchBridge';
import { Button } from './primitives';

export type GpuSwitchProgressActionV1 =
  | 'resume'
  | 'sync_worker'
  | 'confirm_target'
  | 'finalize'
  | 'delete_old'
  | 'prepare_attempt'
  | 'confirm_attempt'
  | 'create_replacement'
  | 'confirm_actual_price'
  | 'delete_replacement'
  | 'reconcile_provider'
  | 'verify_replacement'
  | 'complete'
  | 'cancel';

interface GpuSwitchProgressProps {
  readonly snapshot: NativeGpuSwitchSnapshotV1;
  readonly workerRequest: StudioGpuSwitchState | null;
  readonly busyAction: GpuSwitchProgressActionV1 | null;
  readonly onAction: (action: GpuSwitchProgressActionV1) => void;
}

const PHASE_COPY: Record<NativeGpuSwitchPhaseV1, { title: string; detail: string }> = {
  planned: {
    title: 'Recovering switch setup',
    detail: 'Native state is resolving the exact worker request before any provider action.',
  },
  consent_pending: {
    title: 'Waiting for switch approval',
    detail: 'The current GPU remains online while ImageForge verifies every required response.',
  },
  pausing: {
    title: 'Finishing the current image',
    detail: 'The batch and local queue are moving to their durable pause boundary.',
  },
  ready_to_delete: {
    title: 'Ready to terminate the current Pod',
    detail: 'The worker is safely paused. The old Pod has not been deleted yet.',
  },
  delete_intent: {
    title: 'Terminating the current Pod',
    detail: 'ImageForge is waiting for exact provider evidence before creating a replacement.',
  },
  delete_uncertain: {
    title: 'Checking the current Pod deletion',
    detail: 'No replacement POST can run until native reconciliation proves the old Pod absent.',
  },
  old_absent: {
    title: 'Current Pod is off',
    detail: 'The preserved batch remains paused while the exact replacement attempt is prepared.',
  },
  create_intent: {
    title: 'Starting the replacement Pod',
    detail: 'One durable provider create is in progress. ImageForge will not issue another POST.',
  },
  create_uncertain: {
    title: 'Checking whether the replacement was created',
    detail: 'ImageForge is reconciling the exact attempt marker and will not guess or retry.',
  },
  replacement_identified: {
    title: 'Replacement found',
    detail: 'The actual billed price must be verified before worker adoption continues.',
  },
  provisioning: {
    title: 'Replacement GPU is provisioning',
    detail: 'ImageForge is checking the exact Pod and worker identity. Work remains paused.',
  },
  replacement_failed: {
    title: 'Replacement needs attention',
    detail: 'The failed replacement remains visible and billable until an explicit cleanup decision.',
  },
  replacement_delete_intent: {
    title: 'Terminating the failed replacement',
    detail: 'ImageForge is waiting for exact absence proof and will not resend the DELETE.',
  },
  replacement_delete_uncertain: {
    title: 'Checking failed-replacement termination',
    detail: 'The exact cleanup outcome is uncertain; no new attempt can begin yet.',
  },
  ready_paused: {
    title: 'Replacement GPU is ready',
    detail: 'The batch and queue remain paused until switch completion and a separate Resume action.',
  },
  completed: {
    title: 'GPU switch complete',
    detail: 'The replacement is verified. Generation and the local queue remain paused.',
  },
  needs_attention: {
    title: 'GPU switch needs attention',
    detail: 'No mutation will run until the exact blocked phase is safely reconciled.',
  },
  cancelled_pre_delete: {
    title: 'GPU switch cancelled',
    detail: 'The old Pod was not deleted. The batch and local queue remain paused.',
  },
};

function actionsFor(
  snapshot: NativeGpuSwitchSnapshotV1,
  workerRequest: StudioGpuSwitchState | null,
): readonly GpuSwitchProgressActionV1[] {
  const record = snapshot.record;
  if (record === null) return [];
  if (record.authorizationRequired) return ['resume'];
  if (record.phase === 'planned') return ['cancel'];
  if (record.phase === 'consent_pending') {
    const approved = workerRequest?.switchId === record.switchId
      && workerRequest.phase === 'approved';
    const primary: GpuSwitchProgressActionV1 = !approved
      ? 'sync_worker'
      : record.targetConfirmation === 'required'
        ? 'confirm_target'
        : 'finalize';
    return [primary, 'cancel'];
  }
  if (record.phase === 'pausing' || record.phase === 'ready_to_delete') {
    return record.phase === 'ready_to_delete'
      ? ['delete_old', 'cancel']
      : ['sync_worker', 'cancel'];
  }
  if (record.phase === 'delete_intent' || record.phase === 'delete_uncertain') {
    return ['reconcile_provider'];
  }
  if (record.phase === 'old_absent') {
    return record.preparedTarget === null
      ? ['create_replacement', 'prepare_attempt']
      : ['confirm_attempt'];
  }
  if (record.phase === 'create_intent' || record.phase === 'create_uncertain') {
    return ['reconcile_provider'];
  }
  if (record.phase === 'replacement_identified') {
    if (record.confirmedActualPrice) return ['verify_replacement'];
    return record.actualHourlyPriceMicroUsd === null
      ? ['reconcile_provider', 'delete_replacement']
      : ['confirm_actual_price', 'delete_replacement'];
  }
  if (record.phase === 'provisioning') {
    return ['verify_replacement', 'reconcile_provider'];
  }
  if (record.phase === 'replacement_failed') {
    return ['reconcile_provider', 'delete_replacement'];
  }
  if (
    record.phase === 'replacement_delete_intent'
    || record.phase === 'replacement_delete_uncertain'
  ) {
    return ['reconcile_provider'];
  }
  if (record.phase === 'ready_paused') return ['complete'];
  if (record.phase === 'needs_attention') {
    if (
      record.blockedAt === 'planned'
      && record.attentionCode === 'gpu_switch_worker_response_invalid'
    ) {
      return ['cancel'];
    }
    if (record.blockedAt === 'replacement_identified') {
      return record.actualHourlyPriceMicroUsd === null
        ? ['reconcile_provider', 'delete_replacement']
        : ['confirm_actual_price', 'delete_replacement'];
    }
    if (record.blockedAt === 'old_absent') {
      return record.preparedTarget === null
        ? ['reconcile_provider', 'prepare_attempt']
        : ['confirm_attempt'];
    }
    if (record.blockedAt === 'provisioning') {
      return ['verify_replacement', 'reconcile_provider'];
    }
    if (record.blockedAt === 'replacement_failed') {
      return ['reconcile_provider', 'delete_replacement'];
    }
    return ['reconcile_provider'];
  }
  return [];
}

const ACTION_LABELS: Record<GpuSwitchProgressActionV1, string> = {
  resume: 'Resume switch',
  sync_worker: 'Check worker state',
  confirm_target: 'Confirm target',
  finalize: 'Finalize switch',
  delete_old: 'Terminate current GPU',
  prepare_attempt: 'Prepare another attempt',
  confirm_attempt: 'Confirm replacement attempt',
  create_replacement: 'Start replacement GPU',
  confirm_actual_price: 'Accept actual price',
  delete_replacement: 'Terminate replacement',
  reconcile_provider: 'Check provider state',
  verify_replacement: 'Verify replacement',
  complete: 'Complete switch',
  cancel: 'Cancel switch',
};

const ATTENTION_COPY: Record<NativeGpuSwitchAttentionCodeV1, string> = {
  gpu_switch_revision_exhausted: 'The durable switch revision limit was reached.',
  gpu_actual_price_changed: 'The replacement price changed and needs exact confirmation.',
  gpu_actual_price_unavailable: 'RunPod did not return a valid actual replacement price.',
  gpu_switch_target_unavailable: 'The confirmed replacement GPU is no longer available.',
  gpu_switch_old_pod_changed: 'The current Pod identity changed before deletion.',
  gpu_switch_old_pod_disappeared_early: 'The current Pod disappeared before durable delete intent.',
  gpu_switch_profile_locked: 'Another native profile-control action owns this profile.',
  gpu_switch_worker_create_uncertain: 'The initial worker switch request has an uncertain outcome.',
  gpu_switch_worker_response_invalid: 'The worker returned an invalid switch response.',
  gpu_switch_worker_guard_missing: 'The durable worker guard could not be verified.',
  gpu_switch_replacement_ambiguous: 'Provider evidence cannot identify exactly one replacement Pod.',
  gpu_switch_replacement_mismatch: 'The replacement Pod does not match the durable attempt.',
  gpu_switch_provider_response_mismatch: 'Provider evidence did not match the durable switch request.',
  gpu_switch_zero_match_unproven: 'Native evidence does not yet prove that no replacement exists.',
  gpu_switch_peer_pod_present: 'Another managed Pod is present in this profile.',
  gpu_switch_peer_pod_overflow: 'Too many managed Pods are present to identify a safe target.',
  gpu_switch_pause_failed: 'The worker did not reach an artifact-safe pause boundary.',
  gpu_switch_completion_failed: 'Worker completion could not be verified.',
  gpu_switch_runtime_identity_unavailable: 'The replacement worker runtime identity is unavailable.',
};

export function GpuSwitchProgress({
  snapshot,
  workerRequest,
  busyAction,
  onAction,
}: GpuSwitchProgressProps) {
  const record = snapshot.record;
  if (record === null) return null;
  const copy = PHASE_COPY[record.phase];
  const actions = actionsFor(snapshot, workerRequest);
  const attention = record.phase === 'needs_attention'
    || record.phase === 'delete_uncertain'
    || record.phase === 'create_uncertain'
    || record.phase === 'replacement_failed'
    || record.phase === 'replacement_delete_uncertain';
  const Icon = record.phase === 'completed' ? CheckCircle2 : attention ? AlertTriangle : ShieldCheck;

  return (
    <aside
      className={`gpu-switch-progress${attention ? ' gpu-switch-progress--attention' : ''}`}
      role={attention ? 'alert' : 'status'}
      aria-live={attention ? 'assertive' : 'polite'}
    >
      <span className="gpu-switch-progress__icon"><Icon size={20} /></span>
      <div className="gpu-switch-progress__copy">
        <p className="eyebrow">Coordinated GPU switch · revision {record.recordRevision}</p>
        <strong>{copy.title}</strong>
        <span>{copy.detail}</span>
        <span className="gpu-switch-progress__route">
          {record.oldPod.gpuDisplayName} → {record.currentTarget.gpuDisplayName}
          {' · '}{formatHourlyMicroUsdV1(record.currentTarget.hourlyPriceMicroUsd)}/hr
        </span>
        {record.actualHourlyPriceMicroUsd !== null ? (
          <span>
            Actual replacement price: {formatHourlyMicroUsdV1(record.actualHourlyPriceMicroUsd)}/hr
          </span>
        ) : null}
        {record.phase === 'needs_attention' ? (
          <span>
            {record.attentionCode === null
              ? 'Native recovery evidence is incomplete.'
              : ATTENTION_COPY[record.attentionCode]}
            {record.blockedAt === null ? '' : ` · blocked at ${record.blockedAt.replaceAll('_', ' ')}`}
          </span>
        ) : null}
      </div>
      {actions.length > 0 ? (
        <div className="gpu-switch-progress__actions">
          {actions.map((action, index) => (
            <Button
              key={action}
              compact
              tone={action === 'cancel' || action === 'delete_replacement' || index > 0
                ? 'secondary'
                : 'primary'}
              pending={busyAction === action}
              disabled={busyAction !== null}
              onClick={() => onAction(action)}
            >
              {action === 'sync_worker' ? <RefreshCw size={14} /> : null}
              {action === 'cancel' && record.phase === 'planned'
                ? 'Cancel unresolved switch'
                : ACTION_LABELS[action]}
            </Button>
          ))}
        </div>
      ) : null}
    </aside>
  );
}
