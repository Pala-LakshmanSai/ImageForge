import { invoke } from '@tauri-apps/api/core';
import { isGpuIdentityV1 } from '@imageforge/runpod-client';
import codeRegistryJson from '../../contracts/gpu-switch-codes-v1.json';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POD_ID = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,56}[A-Za-z0-9])?$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export const NATIVE_GPU_SWITCH_PHASES_V1 = [
  'planned', 'consent_pending', 'pausing', 'ready_to_delete',
  'delete_intent', 'delete_uncertain', 'old_absent',
  'create_intent', 'create_uncertain', 'replacement_identified',
  'provisioning', 'replacement_failed', 'replacement_delete_intent',
  'replacement_delete_uncertain', 'ready_paused', 'completed',
  'needs_attention', 'cancelled_pre_delete',
] as const;

export type NativeGpuSwitchPhaseV1 = typeof NATIVE_GPU_SWITCH_PHASES_V1[number];
export type NativeGpuSwitchTargetConfirmationV1 = 'required' | 'confirmed';
export type NativeGpuSwitchBlockedPhaseV1 = Exclude<
  NativeGpuSwitchPhaseV1,
  'needs_attention' | 'completed' | 'cancelled_pre_delete'
>;

const BLOCKED_PHASES = new Set<NativeGpuSwitchPhaseV1>(
  NATIVE_GPU_SWITCH_PHASES_V1.filter((phase) => ![
    'needs_attention', 'completed', 'cancelled_pre_delete',
  ].includes(phase)),
);

const registry = codeRegistryJson as {
  schemaVersion: number;
  codes: Array<{
    code: string;
    scope: string;
    retryable: boolean;
    permittedBlockedPhases: string[];
  }>;
};
if (registry.schemaVersion !== 1) throw new Error('GPU Switch code registry version is unsupported.');
const NATIVE_ISSUE_REGISTRY = new Map(
  registry.codes
    .filter((entry) => entry.scope === 'native_issue')
    .map((entry) => [entry.code, entry] as const),
);
const NATIVE_ATTENTION_REGISTRY = new Map(
  registry.codes
    .filter((entry) => entry.scope === 'native_attention')
    .map((entry) => [entry.code, entry] as const),
);

export type NativeGpuSwitchIssueCodeV1 = string;
export type NativeGpuSwitchAttentionCodeV1 =
  | 'gpu_switch_revision_exhausted'
  | 'gpu_actual_price_changed' | 'gpu_actual_price_unavailable'
  | 'gpu_switch_target_unavailable' | 'gpu_switch_old_pod_changed'
  | 'gpu_switch_old_pod_disappeared_early' | 'gpu_switch_profile_locked'
  | 'gpu_switch_worker_create_uncertain' | 'gpu_switch_worker_response_invalid'
  | 'gpu_switch_worker_guard_missing' | 'gpu_switch_replacement_ambiguous'
  | 'gpu_switch_replacement_mismatch' | 'gpu_switch_provider_response_mismatch'
  | 'gpu_switch_zero_match_unproven' | 'gpu_switch_peer_pod_present'
  | 'gpu_switch_peer_pod_overflow' | 'gpu_switch_pause_failed'
  | 'gpu_switch_completion_failed' | 'gpu_switch_runtime_identity_unavailable';

const ATTENTION_CODES = new Set<NativeGpuSwitchAttentionCodeV1>([
  'gpu_switch_revision_exhausted',
  'gpu_actual_price_changed', 'gpu_actual_price_unavailable',
  'gpu_switch_target_unavailable', 'gpu_switch_old_pod_changed',
  'gpu_switch_old_pod_disappeared_early', 'gpu_switch_profile_locked',
  'gpu_switch_worker_create_uncertain', 'gpu_switch_worker_response_invalid',
  'gpu_switch_worker_guard_missing', 'gpu_switch_replacement_ambiguous',
  'gpu_switch_replacement_mismatch', 'gpu_switch_provider_response_mismatch',
  'gpu_switch_zero_match_unproven', 'gpu_switch_peer_pod_present',
  'gpu_switch_peer_pod_overflow', 'gpu_switch_pause_failed',
  'gpu_switch_completion_failed', 'gpu_switch_runtime_identity_unavailable',
]);

export interface NativeGpuSwitchIssueV1 {
  readonly code: NativeGpuSwitchIssueCodeV1;
  readonly retryable: boolean;
}

export interface NativeGpuSwitchPodV1 {
  readonly podId: string;
  readonly gpuId: string;
  readonly gpuDisplayName: string;
  readonly hourlyPriceMicroUsd: number | null;
}

export interface NativeGpuSwitchTargetV1 {
  readonly replacementAttemptId: string;
  readonly attemptRevision: number;
  readonly gpuId: string;
  readonly gpuDisplayName: string;
  readonly hourlyPriceMicroUsd: number;
  readonly observationId: string;
  readonly receiptId: string;
  readonly inventoryObservedAt: string;
  readonly priceConfirmedAt: string;
}

export interface NativeGpuSwitchPreparedTargetV1 {
  readonly quoteId: string;
  readonly preparedFromRecordRevision: number;
  readonly gpuId: string;
  readonly gpuDisplayName: string;
  readonly hourlyPriceMicroUsd: number;
  readonly observationId: string;
  readonly receiptId: string;
  readonly preparedAt: string;
  readonly expiresAt: string;
}

export interface NativeGpuSwitchPriorAttemptV1 extends NativeGpuSwitchTargetV1 {
  readonly replacementPodId: string | null;
  readonly outcome: 'not_created' | 'failed_replacement_deleted';
  readonly settledAt: string;
}

export interface NativeGpuSwitchQueueReservationV1 {
  readonly active: boolean;
  readonly queueRunRevision: string | null;
}

export interface NativeGpuSwitchRecordV1 {
  readonly schemaVersion: 1;
  readonly switchId: string;
  readonly recordRevision: number;
  readonly phase: NativeGpuSwitchPhaseV1;
  readonly blockedAt: NativeGpuSwitchBlockedPhaseV1 | null;
  readonly attentionCode: NativeGpuSwitchAttentionCodeV1 | null;
  readonly authorizationRequired: boolean;
  readonly targetConfirmation: NativeGpuSwitchTargetConfirmationV1;
  readonly oldPod: NativeGpuSwitchPodV1;
  readonly initialTarget: NativeGpuSwitchTargetV1;
  readonly currentTarget: NativeGpuSwitchTargetV1;
  readonly preparedTarget: NativeGpuSwitchPreparedTargetV1 | null;
  readonly priorAttempts: readonly NativeGpuSwitchPriorAttemptV1[];
  readonly queueReservation: NativeGpuSwitchQueueReservationV1;
  readonly expectedBatchId: string | null;
  readonly oldDeleteWireAttempts: 0 | 1 | 2;
  readonly replacementPodId: string | null;
  readonly peerPodIds: readonly string[];
  readonly peerPodOverflow: boolean;
  readonly actualHourlyPriceMicroUsd: number | null;
  readonly confirmedActualPrice: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NativeGpuSwitchSnapshotV1 {
  readonly schemaVersion: 1;
  readonly storeRevision: number;
  readonly record: NativeGpuSwitchRecordV1 | null;
  readonly issues: readonly NativeGpuSwitchIssueV1[];
}

export interface NativeGpuObservationChoiceV1 {
  readonly observationId: string;
  readonly receiptId: string;
  readonly targetGpuId: string;
  readonly confirmedHourlyPriceMicroUsd: number;
}

export type NativeGpuSwitchForegroundGrantRequestV1 =
  | { readonly action: 'begin'; readonly switchId: null; readonly observationId: string; readonly targetGpuId: string }
  | { readonly action: 'resume'; readonly switchId: string; readonly observationId: null; readonly targetGpuId: null };

export interface NativeGpuSwitchForegroundGrantV1 {
  readonly schemaVersion: 1;
  readonly grantId: string;
  readonly processEpochId: string;
  readonly action: 'begin' | 'resume';
  readonly expiresAt: string;
}

export interface NativeGpuSwitchBeginV1 extends NativeGpuObservationChoiceV1 {
  readonly expectedStoreRevision: number;
  readonly sessionId: string;
  readonly queueExpectedStoreRevision: number;
  readonly queueRunRevision: string | null;
  readonly foregroundGrantId: string;
}
export interface NativeGpuSwitchKeyV1 { readonly switchId: string }
export interface NativeGpuSwitchAcquireV1 extends NativeGpuSwitchKeyV1 { readonly foregroundGrantId: string }
export interface NativeGpuSwitchRevisionKeyV1 extends NativeGpuSwitchKeyV1 { readonly expectedRecordRevision: number }
export interface NativeGpuSwitchWorkerSyncV1 extends NativeGpuSwitchRevisionKeyV1 { readonly sessionId: string }
export interface NativeGpuSwitchFreshWorkerV1 extends NativeGpuSwitchWorkerSyncV1, NativeGpuObservationChoiceV1 {}
export interface NativeGpuSwitchPrepareTargetV1 extends NativeGpuSwitchRevisionKeyV1, NativeGpuObservationChoiceV1 {}
export interface NativeGpuSwitchConfirmAttemptV1 extends NativeGpuSwitchPrepareTargetV1 { readonly quoteId: string }
export interface NativeGpuSwitchProviderReconcileV1 extends NativeGpuSwitchRevisionKeyV1 {
  readonly reason: 'resume' | 'after_delete' | 'after_create' | 'provisioning' | 'zero_match_proof' | 'after_replacement_delete';
}
export interface NativeGpuSwitchReplacementDeleteV1 extends NativeGpuSwitchRevisionKeyV1 {
  readonly replacementPodId: string;
  readonly reason: 'replacement_failed' | 'actual_price_rejected';
  readonly confirmation: 'TERMINATE FAILED REPLACEMENT' | 'TERMINATE UNACCEPTED REPLACEMENT';
}
export interface NativeGpuSwitchActualPriceV1 extends NativeGpuSwitchRevisionKeyV1 {
  readonly confirmedActualHourlyPriceMicroUsd: number;
}
export interface NativeGpuSwitchLeaseV1 { readonly switchId: string; readonly held: boolean }

export interface NativeGpuSwitchPort {
  load(): Promise<NativeGpuSwitchSnapshotV1>;
  authorizeForeground(input: NativeGpuSwitchForegroundGrantRequestV1): Promise<NativeGpuSwitchForegroundGrantV1>;
  begin(input: NativeGpuSwitchBeginV1): Promise<NativeGpuSwitchSnapshotV1>;
  acquire(input: NativeGpuSwitchAcquireV1): Promise<NativeGpuSwitchLeaseV1>;
  release(input: NativeGpuSwitchKeyV1): Promise<NativeGpuSwitchLeaseV1>;
  syncWorker(input: NativeGpuSwitchWorkerSyncV1): Promise<NativeGpuSwitchSnapshotV1>;
  finalize(input: NativeGpuSwitchFreshWorkerV1): Promise<NativeGpuSwitchSnapshotV1>;
  confirmTarget(input: NativeGpuSwitchPrepareTargetV1): Promise<NativeGpuSwitchSnapshotV1>;
  deleteOld(input: NativeGpuSwitchFreshWorkerV1): Promise<NativeGpuSwitchSnapshotV1>;
  prepareAttempt(input: NativeGpuSwitchPrepareTargetV1): Promise<NativeGpuSwitchSnapshotV1>;
  confirmAttempt(input: NativeGpuSwitchConfirmAttemptV1): Promise<NativeGpuSwitchSnapshotV1>;
  createReplacement(input: NativeGpuSwitchFreshWorkerV1): Promise<NativeGpuSwitchSnapshotV1>;
  confirmActualPrice(input: NativeGpuSwitchActualPriceV1): Promise<NativeGpuSwitchSnapshotV1>;
  deleteReplacement(input: NativeGpuSwitchReplacementDeleteV1): Promise<NativeGpuSwitchSnapshotV1>;
  reconcileProvider(input: NativeGpuSwitchProviderReconcileV1): Promise<NativeGpuSwitchSnapshotV1>;
  verifyReplacement(input: NativeGpuSwitchWorkerSyncV1): Promise<NativeGpuSwitchSnapshotV1>;
  complete(input: NativeGpuSwitchWorkerSyncV1): Promise<NativeGpuSwitchSnapshotV1>;
  cancel(input: NativeGpuSwitchWorkerSyncV1): Promise<NativeGpuSwitchSnapshotV1>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}
function isUuid(value: unknown): value is string { return typeof value === 'string' && UUID_V4.test(value); }
function isPodId(value: unknown): value is string { return typeof value === 'string' && POD_ID.test(value); }
function isRevision(value: unknown, positive = false): value is number {
  return Number.isSafeInteger(value) && (value as number) >= (positive ? 1 : 0) && (value as number) <= MAX_SAFE;
}
function isMicroUsd(value: unknown): value is number { return isRevision(value); }
function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && UTC_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function parseIssue(value: unknown): NativeGpuSwitchIssueV1 | null {
  if (!isRecord(value) || !exactKeys(value, ['code', 'retryable']) || typeof value.code !== 'string') return null;
  const entry = NATIVE_ISSUE_REGISTRY.get(value.code);
  if (entry === undefined || value.retryable !== entry.retryable) return null;
  return Object.freeze({ code: value.code, retryable: entry.retryable });
}

function parsePod(value: unknown): NativeGpuSwitchPodV1 | null {
  if (!isRecord(value) || !exactKeys(value, ['podId', 'gpuId', 'gpuDisplayName', 'hourlyPriceMicroUsd'])) return null;
  if (
    !isPodId(value.podId) || !isGpuIdentityV1(value.gpuId) || !isGpuIdentityV1(value.gpuDisplayName)
    || (value.hourlyPriceMicroUsd !== null && !isMicroUsd(value.hourlyPriceMicroUsd))
  ) return null;
  return Object.freeze({
    podId: value.podId,
    gpuId: value.gpuId,
    gpuDisplayName: value.gpuDisplayName,
    hourlyPriceMicroUsd: value.hourlyPriceMicroUsd as number | null,
  });
}

const TARGET_KEYS = [
  'replacementAttemptId', 'attemptRevision', 'gpuId', 'gpuDisplayName',
  'hourlyPriceMicroUsd', 'observationId', 'receiptId', 'inventoryObservedAt',
  'priceConfirmedAt',
] as const;

function targetFields(value: Record<string, unknown>): NativeGpuSwitchTargetV1 | null {
  if (
    !isUuid(value.replacementAttemptId) || !isRevision(value.attemptRevision, true)
    || !isGpuIdentityV1(value.gpuId) || !isGpuIdentityV1(value.gpuDisplayName)
    || !isMicroUsd(value.hourlyPriceMicroUsd) || !isUuid(value.observationId)
    || !isUuid(value.receiptId) || !isTimestamp(value.inventoryObservedAt)
    || !isTimestamp(value.priceConfirmedAt)
  ) return null;
  return Object.freeze({
    replacementAttemptId: value.replacementAttemptId,
    attemptRevision: value.attemptRevision,
    gpuId: value.gpuId,
    gpuDisplayName: value.gpuDisplayName,
    hourlyPriceMicroUsd: value.hourlyPriceMicroUsd,
    observationId: value.observationId,
    receiptId: value.receiptId,
    inventoryObservedAt: value.inventoryObservedAt,
    priceConfirmedAt: value.priceConfirmedAt,
  });
}

function parseTarget(value: unknown): NativeGpuSwitchTargetV1 | null {
  return isRecord(value) && exactKeys(value, TARGET_KEYS) ? targetFields(value) : null;
}

function parsePreparedTarget(value: unknown): NativeGpuSwitchPreparedTargetV1 | null {
  const keys = ['quoteId', 'preparedFromRecordRevision', 'gpuId', 'gpuDisplayName', 'hourlyPriceMicroUsd', 'observationId', 'receiptId', 'preparedAt', 'expiresAt'];
  if (!isRecord(value) || !exactKeys(value, keys)) return null;
  if (
    !isUuid(value.quoteId) || !isRevision(value.preparedFromRecordRevision, true)
    || !isGpuIdentityV1(value.gpuId) || !isGpuIdentityV1(value.gpuDisplayName)
    || !isMicroUsd(value.hourlyPriceMicroUsd) || !isUuid(value.observationId)
    || !isUuid(value.receiptId) || !isTimestamp(value.preparedAt) || !isTimestamp(value.expiresAt)
    || Date.parse(value.expiresAt) <= Date.parse(value.preparedAt)
  ) return null;
  return Object.freeze(value as unknown as NativeGpuSwitchPreparedTargetV1);
}

function parsePriorAttempt(value: unknown): NativeGpuSwitchPriorAttemptV1 | null {
  if (!isRecord(value) || !exactKeys(value, [...TARGET_KEYS, 'replacementPodId', 'outcome', 'settledAt'])) return null;
  const target = targetFields(value);
  if (
    target === null || (value.replacementPodId !== null && !isPodId(value.replacementPodId))
    || !['not_created', 'failed_replacement_deleted'].includes(value.outcome as string)
    || !isTimestamp(value.settledAt)
    || (value.outcome === 'not_created' ? value.replacementPodId !== null : value.replacementPodId === null)
  ) return null;
  return Object.freeze({
    ...target,
    replacementPodId: value.replacementPodId as string | null,
    outcome: value.outcome as NativeGpuSwitchPriorAttemptV1['outcome'],
    settledAt: value.settledAt,
  });
}

function parseQueueReservation(value: unknown): NativeGpuSwitchQueueReservationV1 | null {
  if (!isRecord(value) || !exactKeys(value, ['active', 'queueRunRevision'])) return null;
  if (typeof value.active !== 'boolean' || (value.queueRunRevision !== null && !isUuid(value.queueRunRevision))) return null;
  if (!value.active && value.queueRunRevision !== null) return null;
  return Object.freeze({ active: value.active, queueRunRevision: value.queueRunRevision as string | null });
}

function parseRecord(value: unknown, issues: readonly NativeGpuSwitchIssueV1[]): NativeGpuSwitchRecordV1 | null {
  const keys = [
    'schemaVersion', 'switchId', 'recordRevision', 'phase', 'blockedAt', 'attentionCode',
    'authorizationRequired', 'targetConfirmation', 'oldPod', 'initialTarget', 'currentTarget', 'preparedTarget',
    'priorAttempts', 'queueReservation', 'expectedBatchId', 'oldDeleteWireAttempts',
    'replacementPodId', 'peerPodIds', 'peerPodOverflow', 'actualHourlyPriceMicroUsd',
    'confirmedActualPrice', 'createdAt', 'updatedAt',
  ];
  if (!isRecord(value) || !exactKeys(value, keys)) return null;
  if (
    value.schemaVersion !== 1 || !isUuid(value.switchId) || !isRevision(value.recordRevision, true)
    || !NATIVE_GPU_SWITCH_PHASES_V1.includes(value.phase as NativeGpuSwitchPhaseV1)
    || typeof value.authorizationRequired !== 'boolean'
    || !['required', 'confirmed'].includes(value.targetConfirmation as string)
    || !Array.isArray(value.priorAttempts)
    || (value.expectedBatchId !== null && !isUuid(value.expectedBatchId))
    || ![0, 1, 2].includes(value.oldDeleteWireAttempts as number)
    || (value.replacementPodId !== null && !isPodId(value.replacementPodId))
    || !Array.isArray(value.peerPodIds) || typeof value.peerPodOverflow !== 'boolean'
    || (value.actualHourlyPriceMicroUsd !== null && !isMicroUsd(value.actualHourlyPriceMicroUsd))
    || typeof value.confirmedActualPrice !== 'boolean'
    || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)
    || Date.parse(value.updatedAt) < Date.parse(value.createdAt)
  ) return null;
  const phase = value.phase as NativeGpuSwitchPhaseV1;
  const attentionCode = value.attentionCode as NativeGpuSwitchAttentionCodeV1 | null;
  if (phase === 'needs_attention') {
    if (!BLOCKED_PHASES.has(value.blockedAt as NativeGpuSwitchPhaseV1) || !ATTENTION_CODES.has(attentionCode!)) return null;
    const registryEntry = NATIVE_ATTENTION_REGISTRY.get(attentionCode!);
    if (
      registryEntry === undefined
      || (registryEntry.permittedBlockedPhases.length > 0 && !registryEntry.permittedBlockedPhases.includes(value.blockedAt as string))
      || !issues.some((issue) => issue.code === attentionCode)
    ) return null;
  } else if (value.blockedAt !== null || value.attentionCode !== null) return null;

  const oldPod = parsePod(value.oldPod);
  const initialTarget = parseTarget(value.initialTarget);
  const currentTarget = parseTarget(value.currentTarget);
  const preparedTarget = value.preparedTarget === null ? null : parsePreparedTarget(value.preparedTarget);
  const queueReservation = parseQueueReservation(value.queueReservation);
  const priorAttempts = value.priorAttempts.map(parsePriorAttempt);
  if (
    oldPod === null || initialTarget === null || currentTarget === null || queueReservation === null
    || (value.preparedTarget !== null && preparedTarget === null) || priorAttempts.some((attempt) => attempt === null)
    || initialTarget.attemptRevision !== 1 || currentTarget.attemptRevision !== priorAttempts.length + 1
    || priorAttempts.some((attempt, index) => attempt!.attemptRevision !== index + 1)
    || (preparedTarget !== null && preparedTarget.preparedFromRecordRevision !== value.recordRevision)
  ) return null;
  const peerPodIds = value.peerPodIds as unknown[];
  if (
    peerPodIds.length > 16 || peerPodIds.some((podId) => !isPodId(podId))
    || new Set(peerPodIds).size !== peerPodIds.length
    || peerPodIds.some((podId, index) => index > 0 && (peerPodIds[index - 1] as string) >= (podId as string))
    || (value.peerPodOverflow && peerPodIds.length !== 0)
    || (value.peerPodOverflow && attentionCode !== 'gpu_switch_peer_pod_overflow')
    || (peerPodIds.length > 0 && attentionCode !== 'gpu_switch_peer_pod_present')
    || (value.confirmedActualPrice && value.actualHourlyPriceMicroUsd === null)
  ) return null;
  const deleteAttemptPhases = new Set<NativeGpuSwitchPhaseV1>([
    'delete_intent', 'delete_uncertain', 'old_absent', 'create_intent', 'create_uncertain',
    'replacement_identified', 'provisioning', 'replacement_failed', 'replacement_delete_intent',
    'replacement_delete_uncertain', 'ready_paused', 'completed', 'needs_attention',
  ]);
  if (!deleteAttemptPhases.has(phase) && value.oldDeleteWireAttempts !== 0) return null;
  if (phase === 'delete_uncertain' && value.oldDeleteWireAttempts === 0) return null;
  const effectivePhase = phase === 'needs_attention'
    ? value.blockedAt as NativeGpuSwitchPhaseV1
    : phase;
  const targetConfirmation = value.targetConfirmation as NativeGpuSwitchTargetConfirmationV1;
  if (
    (effectivePhase === 'planned' && targetConfirmation !== 'required')
    || (!['planned', 'consent_pending', 'cancelled_pre_delete'].includes(effectivePhase)
      && targetConfirmation !== 'confirmed')
  ) return null;
  return Object.freeze({
    schemaVersion: 1,
    switchId: value.switchId,
    recordRevision: value.recordRevision,
    phase,
    blockedAt: value.blockedAt as NativeGpuSwitchBlockedPhaseV1 | null,
    attentionCode,
    authorizationRequired: value.authorizationRequired,
    targetConfirmation,
    oldPod,
    initialTarget,
    currentTarget,
    preparedTarget,
    priorAttempts: Object.freeze(priorAttempts as NativeGpuSwitchPriorAttemptV1[]),
    queueReservation,
    expectedBatchId: value.expectedBatchId as string | null,
    oldDeleteWireAttempts: value.oldDeleteWireAttempts as 0 | 1 | 2,
    replacementPodId: value.replacementPodId as string | null,
    peerPodIds: Object.freeze(peerPodIds as string[]),
    peerPodOverflow: value.peerPodOverflow,
    actualHourlyPriceMicroUsd: value.actualHourlyPriceMicroUsd as number | null,
    confirmedActualPrice: value.confirmedActualPrice,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}

export function parseNativeGpuSwitchSnapshotV1(value: unknown): NativeGpuSwitchSnapshotV1 | null {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'storeRevision', 'record', 'issues'])) return null;
  if (value.schemaVersion !== 1 || !isRevision(value.storeRevision) || !Array.isArray(value.issues) || value.issues.length > 2) return null;
  const issues = value.issues.map(parseIssue);
  if (issues.some((issue) => issue === null) || new Set(issues.map((issue) => issue!.code)).size !== issues.length) return null;
  const record = value.record === null ? null : parseRecord(value.record, issues as NativeGpuSwitchIssueV1[]);
  if (value.record !== null && record === null) return null;
  if (record === null && issues.some((issue) => issue!.code !== 'gpu_switch_store_recovered' && issue!.code !== 'gpu_switch_store_unrecoverable')) return null;
  return Object.freeze({ schemaVersion: 1, storeRevision: value.storeRevision, record, issues: Object.freeze(issues as NativeGpuSwitchIssueV1[]) });
}

export function parseNativeGpuSwitchForegroundGrantV1(value: unknown): NativeGpuSwitchForegroundGrantV1 | null {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'grantId', 'processEpochId', 'action', 'expiresAt'])) return null;
  if (value.schemaVersion !== 1 || !isUuid(value.grantId) || !isUuid(value.processEpochId) || !['begin', 'resume'].includes(value.action as string) || !isTimestamp(value.expiresAt)) return null;
  return Object.freeze(value as unknown as NativeGpuSwitchForegroundGrantV1);
}

export function parseNativeGpuSwitchLeaseV1(value: unknown): NativeGpuSwitchLeaseV1 | null {
  if (!isRecord(value) || !exactKeys(value, ['switchId', 'held']) || !isUuid(value.switchId) || typeof value.held !== 'boolean') return null;
  return Object.freeze({ switchId: value.switchId, held: value.held });
}

function assertExactInput(value: unknown, keys: readonly string[], validate: (record: Record<string, unknown>) => boolean): void {
  if (!isRecord(value) || !exactKeys(value, keys) || !validate(value)) throw new TypeError('GPU Switch input is invalid.');
}
function validChoice(value: Record<string, unknown>): boolean {
  return isUuid(value.observationId) && isUuid(value.receiptId) && isGpuIdentityV1(value.targetGpuId) && isMicroUsd(value.confirmedHourlyPriceMicroUsd);
}
function validRevisionKey(value: Record<string, unknown>): boolean { return isUuid(value.switchId) && isRevision(value.expectedRecordRevision, true); }
function resultSnapshot(value: unknown): NativeGpuSwitchSnapshotV1 {
  const parsed = parseNativeGpuSwitchSnapshotV1(value);
  if (parsed === null) throw new Error('Native GPU Switch snapshot is invalid.');
  return parsed;
}

export async function nativeGpuSwitchLoad(): Promise<NativeGpuSwitchSnapshotV1> {
  return resultSnapshot(await invoke('gpu_switch_load'));
}
export async function nativeGpuSwitchAuthorizeForeground(input: NativeGpuSwitchForegroundGrantRequestV1): Promise<NativeGpuSwitchForegroundGrantV1> {
  assertExactInput(input, ['action', 'switchId', 'observationId', 'targetGpuId'], (value) =>
    value.action === 'begin'
      ? value.switchId === null && isUuid(value.observationId) && isGpuIdentityV1(value.targetGpuId)
      : value.action === 'resume' && isUuid(value.switchId) && value.observationId === null && value.targetGpuId === null);
  const parsed = parseNativeGpuSwitchForegroundGrantV1(await invoke('gpu_switch_authorize_foreground', { input }));
  if (parsed === null) throw new Error('Native GPU Switch foreground grant is invalid.');
  return parsed;
}
export async function nativeGpuSwitchBegin(input: NativeGpuSwitchBeginV1): Promise<NativeGpuSwitchSnapshotV1> {
  assertExactInput(input, ['observationId', 'receiptId', 'targetGpuId', 'confirmedHourlyPriceMicroUsd', 'expectedStoreRevision', 'sessionId', 'queueExpectedStoreRevision', 'queueRunRevision', 'foregroundGrantId'], (v) => validChoice(v) && isRevision(v.expectedStoreRevision) && isUuid(v.sessionId) && isRevision(v.queueExpectedStoreRevision) && (v.queueRunRevision === null || isUuid(v.queueRunRevision)) && isUuid(v.foregroundGrantId));
  return resultSnapshot(await invoke('gpu_switch_begin', { input }));
}
export async function nativeGpuSwitchAcquire(input: NativeGpuSwitchAcquireV1): Promise<NativeGpuSwitchLeaseV1> {
  assertExactInput(input, ['switchId', 'foregroundGrantId'], (v) => isUuid(v.switchId) && isUuid(v.foregroundGrantId));
  const parsed = parseNativeGpuSwitchLeaseV1(await invoke('gpu_switch_acquire', { input }));
  if (parsed === null) throw new Error('Native GPU Switch lease is invalid.');
  return parsed;
}
export async function nativeGpuSwitchRelease(input: NativeGpuSwitchKeyV1): Promise<NativeGpuSwitchLeaseV1> {
  assertExactInput(input, ['switchId'], (v) => isUuid(v.switchId));
  const parsed = parseNativeGpuSwitchLeaseV1(await invoke('gpu_switch_release', { input }));
  if (parsed === null) throw new Error('Native GPU Switch lease is invalid.');
  return parsed;
}

async function revisionCommand(command: string, input: NativeGpuSwitchRevisionKeyV1, extraKeys: readonly string[], validateExtra: (v: Record<string, unknown>) => boolean): Promise<NativeGpuSwitchSnapshotV1> {
  assertExactInput(input, ['switchId', 'expectedRecordRevision', ...extraKeys], (v) => validRevisionKey(v) && validateExtra(v));
  return resultSnapshot(await invoke(command, { input }));
}
const validWorkerSync = (v: Record<string, unknown>) => isUuid(v.sessionId);
const validFreshWorker = (v: Record<string, unknown>) => validWorkerSync(v) && validChoice(v);
const validPrepareTarget = (v: Record<string, unknown>) => validChoice(v);

export const nativeGpuSwitchSyncWorker = (input: NativeGpuSwitchWorkerSyncV1) => revisionCommand('gpu_switch_sync_worker', input, ['sessionId'], validWorkerSync);
export const nativeGpuSwitchFinalize = (input: NativeGpuSwitchFreshWorkerV1) => revisionCommand('gpu_switch_finalize', input, ['sessionId', 'observationId', 'receiptId', 'targetGpuId', 'confirmedHourlyPriceMicroUsd'], validFreshWorker);
export const nativeGpuSwitchConfirmTarget = (input: NativeGpuSwitchPrepareTargetV1) => revisionCommand('gpu_switch_confirm_target', input, ['observationId', 'receiptId', 'targetGpuId', 'confirmedHourlyPriceMicroUsd'], validPrepareTarget);
export const nativeGpuSwitchDeleteOld = (input: NativeGpuSwitchFreshWorkerV1) => revisionCommand('gpu_switch_delete_old', input, ['sessionId', 'observationId', 'receiptId', 'targetGpuId', 'confirmedHourlyPriceMicroUsd'], validFreshWorker);
export const nativeGpuSwitchPrepareAttempt = (input: NativeGpuSwitchPrepareTargetV1) => revisionCommand('gpu_switch_prepare_attempt', input, ['observationId', 'receiptId', 'targetGpuId', 'confirmedHourlyPriceMicroUsd'], validPrepareTarget);
export const nativeGpuSwitchConfirmAttempt = (input: NativeGpuSwitchConfirmAttemptV1) => revisionCommand('gpu_switch_confirm_attempt', input, ['observationId', 'receiptId', 'targetGpuId', 'confirmedHourlyPriceMicroUsd', 'quoteId'], (v) => validPrepareTarget(v) && isUuid(v.quoteId));
export const nativeGpuSwitchCreateReplacement = (input: NativeGpuSwitchFreshWorkerV1) => revisionCommand('gpu_switch_create_replacement', input, ['sessionId', 'observationId', 'receiptId', 'targetGpuId', 'confirmedHourlyPriceMicroUsd'], validFreshWorker);
export const nativeGpuSwitchConfirmActualPrice = (input: NativeGpuSwitchActualPriceV1) => revisionCommand('gpu_switch_confirm_actual_price', input, ['confirmedActualHourlyPriceMicroUsd'], (v) => isMicroUsd(v.confirmedActualHourlyPriceMicroUsd));
export const nativeGpuSwitchDeleteReplacement = (input: NativeGpuSwitchReplacementDeleteV1) => revisionCommand('gpu_switch_delete_replacement', input, ['replacementPodId', 'reason', 'confirmation'], (v) => isPodId(v.replacementPodId) && (v.reason === 'replacement_failed' ? v.confirmation === 'TERMINATE FAILED REPLACEMENT' : v.reason === 'actual_price_rejected' && v.confirmation === 'TERMINATE UNACCEPTED REPLACEMENT'));
export const nativeGpuSwitchReconcileProvider = (input: NativeGpuSwitchProviderReconcileV1) => revisionCommand('gpu_switch_reconcile_provider', input, ['reason'], (v) => ['resume', 'after_delete', 'after_create', 'provisioning', 'zero_match_proof', 'after_replacement_delete'].includes(v.reason as string));
export const nativeGpuSwitchVerifyReplacement = (input: NativeGpuSwitchWorkerSyncV1) => revisionCommand('gpu_switch_verify_replacement', input, ['sessionId'], validWorkerSync);
export const nativeGpuSwitchComplete = (input: NativeGpuSwitchWorkerSyncV1) => revisionCommand('gpu_switch_complete', input, ['sessionId'], validWorkerSync);
export const nativeGpuSwitchCancel = (input: NativeGpuSwitchWorkerSyncV1) => revisionCommand('gpu_switch_cancel', input, ['sessionId'], validWorkerSync);

export const nativeGpuSwitchPort: NativeGpuSwitchPort = Object.freeze({
  load: nativeGpuSwitchLoad,
  authorizeForeground: nativeGpuSwitchAuthorizeForeground,
  begin: nativeGpuSwitchBegin,
  acquire: nativeGpuSwitchAcquire,
  release: nativeGpuSwitchRelease,
  syncWorker: nativeGpuSwitchSyncWorker,
  finalize: nativeGpuSwitchFinalize,
  confirmTarget: nativeGpuSwitchConfirmTarget,
  deleteOld: nativeGpuSwitchDeleteOld,
  prepareAttempt: nativeGpuSwitchPrepareAttempt,
  confirmAttempt: nativeGpuSwitchConfirmAttempt,
  createReplacement: nativeGpuSwitchCreateReplacement,
  confirmActualPrice: nativeGpuSwitchConfirmActualPrice,
  deleteReplacement: nativeGpuSwitchDeleteReplacement,
  reconcileProvider: nativeGpuSwitchReconcileProvider,
  verifyReplacement: nativeGpuSwitchVerifyReplacement,
  complete: nativeGpuSwitchComplete,
  cancel: nativeGpuSwitchCancel,
});
