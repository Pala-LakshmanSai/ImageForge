import type {
  StudioParticipant,
  StudioGpuSwitchState,
  StudioSession,
  StudioStopState,
  StudioSyncState,
} from '../domain/types';
import { parseWorkerApiError, parseWorkerBatchSummary, type WorkerBatchSummary } from './workerContracts';
import type { WorkerHttpResult } from './workerBatchCoordinator';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GPU_IDENTITY_V1 = /^[A-Za-z0-9](?:[A-Za-z0-9 ._()+:-]{0,126}[A-Za-z0-9])?$/;
const STOP_STATES = ['pending', 'approved', 'denied', 'expired', 'cancelled', 'finalizing'] as const;
const STOP_REASONS = [
  'peer_denied',
  'response_timeout',
  'requester_cancelled',
  'requester_expired',
  'generation_started',
  'finalization_expired',
] as const;
const GPU_SWITCH_STATES = [
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled',
  'pausing',
  'ready_to_delete',
  'delete_intent',
  'replacement_ready',
  'completed',
  'needs_attention',
] as const;
const GPU_SWITCH_REASONS = [
  'peer_denied',
  'response_timeout',
  'requester_cancelled',
  'requester_expired',
  'generation_started',
  'batch_changed',
  'stop_started',
  'target_changed_pre_delete',
  'pause_failed',
  'replacement_mismatch',
  'completion_failed',
] as const;
const POD_ID = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,56}[A-Za-z0-9])?$/;
export const MIN_FINALIZATION_REMAINING_MS = 30_000;

type StudioStopWireState = (typeof STOP_STATES)[number];
type StudioStopReason = (typeof STOP_REASONS)[number];
type StudioGpuSwitchWireState = (typeof GPU_SWITCH_STATES)[number];
type StudioGpuSwitchReason = (typeof GPU_SWITCH_REASONS)[number];
type ActiveStudioGpuSwitchWireState = Exclude<
  StudioGpuSwitchWireState,
  'denied' | 'expired' | 'cancelled' | 'completed'
>;

interface StudioGpuSwitchRequest {
  schemaVersion: 1;
  switchId: string;
  oldPodId: string;
  oldGpuId: string;
  oldGpuDisplayName: string;
  initialTargetGpuId: string;
  initialTargetGpuDisplayName: string;
  initialReplacementAttemptId: string;
  requester: StudioParticipant;
  state: ActiveStudioGpuSwitchWireState;
  reason: StudioGpuSwitchReason | null;
  requestedAt: string;
  responseDeadline: string;
  readyToDeleteAt: string | null;
  waitingFor: StudioParticipant[];
  approvedBy: StudioParticipant[];
  deniedBy: StudioParticipant[];
  batchId: string | null;
  batchOwner: { displayName: string } | null;
  batchStateAtFinalization: 'running' | 'paused' | 'interrupted' | null;
  replacementAttemptId: string | null;
  replacementAttemptRevision: number | null;
  replacementPodId: string | null;
  actualTargetGpuId: string | null;
}

export interface StudioState {
  schemaVersion: 1;
  serverInstanceId: string;
  coordinationRevision: number;
  serverTime: string;
  presenceTtlSeconds: number;
  responseTtlSeconds: number;
  finalizationTtlSeconds: number;
  currentSession: StudioSession;
  sessions: StudioSession[];
  activeBatch: WorkerBatchSummary | null;
  stopRequest: {
    requestId: string;
    podId: string;
    gpuDisplayName: string;
    requester: StudioParticipant;
    state: StudioStopWireState;
    reason: StudioStopReason | null;
    requestedAt: string;
    responseDeadline: string;
    finalizationExpiresAt: string | null;
    waitingFor: StudioParticipant[];
    approvedBy: StudioParticipant[];
    deniedBy: StudioParticipant[];
    finalizationId: string | null;
  } | null;
  gpuSwitchRequest: StudioGpuSwitchRequest | null;
  gpuSwitchCanRespond: boolean;
}

export class StudioContractError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | null;

  constructor(
    code: string,
    message: string,
    status: number,
    details: Readonly<Record<string, unknown>> | null = null,
  ) {
    super(message);
    this.name = 'StudioContractError';
    this.code = code;
    this.status = status;
    this.retryable = status === 408 || status === 409 || status === 423 || status === 429 || status >= 500;
    this.details = details;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new Error(`${label} contained an unknown field.`);
  }
}

function string(value: unknown, label: string, maximum = 160): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value.includes('\0')) {
    throw new Error(`${label} must be a safe string.`);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  const parsed = string(value, label, 36);
  if (!UUID_V4.test(parsed)) throw new Error(`${label} must be a UUID v4.`);
  return parsed;
}

function canonicalUuid(value: unknown, label: string): string {
  const parsed = uuid(value, label);
  if (parsed !== parsed.toLowerCase()) throw new Error(`${label} must be a canonical UUID v4.`);
  return parsed;
}

function podId(value: unknown, label: string): string {
  const parsed = string(value, label, 58);
  if (!POD_ID.test(parsed)) throw new Error(`${label} must be a safe RunPod ID.`);
  return parsed;
}

function gpuIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be an ImageForge GPU identity.`);
  const byteLength = new TextEncoder().encode(value).byteLength;
  if (byteLength < 1 || byteLength > 128 || !GPU_IDENTITY_V1.test(value)) {
    throw new Error(`${label} must be an ImageForge GPU identity.`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be a bounded safe integer.`);
  }
  return value as number;
}

function timestamp(value: unknown, label: string): string {
  const parsed = string(value, label, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed)) {
    throw new Error(`${label} must be an RFC3339 UTC millisecond timestamp.`);
  }
  const milliseconds = Date.parse(parsed);
  if (Number.isNaN(milliseconds) || new Date(milliseconds).toISOString() !== parsed) {
    throw new Error(`${label} must be a real RFC3339 UTC calendar timestamp.`);
  }
  return parsed;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function enumeration<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${label} is invalid.`);
  return value as T;
}

function participant(value: unknown, label: string): StudioParticipant {
  const item = record(value, label);
  exactKeys(item, ['session_id', 'display_name'], label);
  const displayName = string(item.display_name, `${label}.display_name`, 80);
  if (displayName.trim() !== displayName) throw new Error(`${label}.display_name must be normalized.`);
  return { sessionId: uuid(item.session_id, `${label}.session_id`), displayName };
}

function participants(value: unknown, label: string): StudioParticipant[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error(`${label} must be a bounded array.`);
  const parsed = value.map((candidate, index) => participant(candidate, `${label}[${index}]`));
  if (new Set(parsed.map((candidate) => candidate.sessionId)).size !== parsed.length) {
    throw new Error(`${label} contained duplicate sessions.`);
  }
  return parsed;
}

function switchParticipants(value: unknown, label: string): StudioParticipant[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error(`${label} must be a bounded array.`);
  const parsed = value.map((candidate, index) => participant(candidate, `${label}[${index}]`));
  if (new Set(parsed.map((candidate) => candidate.sessionId)).size !== parsed.length) {
    throw new Error(`${label} contained duplicate sessions.`);
  }
  const sorted = [...parsed].sort((left, right) => {
    if (left.displayName < right.displayName) return -1;
    if (left.displayName > right.displayName) return 1;
    if (left.sessionId < right.sessionId) return -1;
    if (left.sessionId > right.sessionId) return 1;
    return 0;
  });
  if (parsed.some((candidate, index) => candidate !== sorted[index]
    && (candidate.displayName !== sorted[index]?.displayName || candidate.sessionId !== sorted[index]?.sessionId))) {
    throw new Error(`${label} must be canonically sorted.`);
  }
  return parsed;
}

function session(value: unknown, label: string): StudioSession {
  const item = record(value, label);
  exactKeys(item, ['session_id', 'display_name', 'availability', 'expires_at'], label);
  const base = participant(
    { session_id: item.session_id, display_name: item.display_name },
    label,
  );
  return {
    ...base,
    availability: enumeration(item.availability, ['foreground', 'background'] as const, `${label}.availability`),
    expiresAt: timestamp(item.expires_at, `${label}.expires_at`),
  };
}

function sessions(value: unknown): StudioSession[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('sessions must be a bounded array.');
  const parsed = value.map((candidate, index) => session(candidate, `sessions[${index}]`));
  if (new Set(parsed.map((candidate) => candidate.sessionId)).size !== parsed.length) {
    throw new Error('sessions contained duplicate IDs.');
  }
  return parsed;
}

function stopRequest(value: unknown): NonNullable<StudioState['stopRequest']> | null {
  if (value === null) return null;
  const item = record(value, 'stop_request');
  exactKeys(item, [
    'request_id',
    'pod_id',
    'gpu_display_name',
    'requester',
    'state',
    'reason',
    'requested_at',
    'response_deadline',
    'finalization_expires_at',
    'waiting_for',
    'approved_by',
    'denied_by',
    'finalization_id',
  ], 'stop_request');
  const state = enumeration(item.state, STOP_STATES, 'stop_request.state');
  const finalizationId = item.finalization_id === null ? null : uuid(item.finalization_id, 'stop_request.finalization_id');
  const finalizationExpiresAt = nullableTimestamp(item.finalization_expires_at, 'stop_request.finalization_expires_at');
  if (state === 'finalizing' && finalizationExpiresAt === null) {
    throw new Error('A finalizing stop request must contain its guard expiry.');
  }
  if (state !== 'finalizing' && (finalizationId !== null || finalizationExpiresAt !== null)) {
    throw new Error('An inactive stop request cannot expose a deletion guard.');
  }
  return {
    requestId: uuid(item.request_id, 'stop_request.request_id'),
    podId: string(item.pod_id, 'stop_request.pod_id', 128),
    gpuDisplayName: gpuIdentity(item.gpu_display_name, 'stop_request.gpu_display_name'),
    requester: participant(item.requester, 'stop_request.requester'),
    state,
    reason: item.reason === null ? null : enumeration(item.reason, STOP_REASONS, 'stop_request.reason'),
    requestedAt: timestamp(item.requested_at, 'stop_request.requested_at'),
    responseDeadline: timestamp(item.response_deadline, 'stop_request.response_deadline'),
    finalizationExpiresAt,
    waitingFor: participants(item.waiting_for, 'stop_request.waiting_for'),
    approvedBy: participants(item.approved_by, 'stop_request.approved_by'),
    deniedBy: participants(item.denied_by, 'stop_request.denied_by'),
    finalizationId,
  };
}

function gpuSwitchRequest(value: unknown): StudioGpuSwitchRequest | null {
  if (value === null) return null;
  const item = record(value, 'gpu_switch_request');
  exactKeys(item, [
    'schema_version',
    'switch_id',
    'old_pod_id',
    'old_gpu_id',
    'old_gpu_display_name',
    'initial_target_gpu_id',
    'initial_target_gpu_display_name',
    'initial_replacement_attempt_id',
    'requester',
    'state',
    'reason',
    'requested_at',
    'response_deadline',
    'ready_to_delete_at',
    'waiting_for',
    'approved_by',
    'denied_by',
    'batch_id',
    'batch_owner',
    'batch_state_at_finalization',
    'replacement_attempt_id',
    'replacement_attempt_revision',
    'replacement_pod_id',
    'actual_target_gpu_id',
  ], 'gpu_switch_request');
  if (item.schema_version !== 1) throw new Error('gpu_switch_request schema version is unsupported.');

  const wireState = enumeration(item.state, GPU_SWITCH_STATES, 'gpu_switch_request.state');
  if (['denied', 'expired', 'cancelled', 'completed'].includes(wireState)) {
    throw new Error('A terminal GPU Switch must be represented by its tombstone.');
  }
  const state = wireState as ActiveStudioGpuSwitchWireState;
  const reason = item.reason === null
    ? null
    : enumeration(item.reason, GPU_SWITCH_REASONS, 'gpu_switch_request.reason');
  const expectedReasons: Record<ActiveStudioGpuSwitchWireState, readonly (StudioGpuSwitchReason | null)[]> = {
    pending: [null],
    approved: [null],
    pausing: [null, 'requester_cancelled'],
    ready_to_delete: [null],
    delete_intent: [null],
    replacement_ready: [null],
    needs_attention: ['pause_failed'],
  };
  if (!expectedReasons[state].includes(reason)) {
    throw new Error('gpu_switch_request state and reason are incompatible.');
  }

  const batchId = item.batch_id === null ? null : canonicalUuid(item.batch_id, 'gpu_switch_request.batch_id');
  let batchOwner: StudioGpuSwitchRequest['batchOwner'] = null;
  if (item.batch_owner !== null) {
    const owner = record(item.batch_owner, 'gpu_switch_request.batch_owner');
    exactKeys(owner, ['display_name'], 'gpu_switch_request.batch_owner');
    batchOwner = { displayName: string(owner.display_name, 'gpu_switch_request.batch_owner.display_name', 80) };
  }
  if ((batchId === null) !== (batchOwner === null)) {
    throw new Error('gpu_switch_request batch identity must be all null or all populated.');
  }
  const batchStateAtFinalization = item.batch_state_at_finalization === null
    ? null
    : enumeration(
      item.batch_state_at_finalization,
      ['running', 'paused', 'interrupted'] as const,
      'gpu_switch_request.batch_state_at_finalization',
    );
  const finalized = ['pausing', 'ready_to_delete', 'delete_intent', 'replacement_ready', 'needs_attention'].includes(state);
  if (!finalized && batchStateAtFinalization !== null) {
    throw new Error('A pre-finalization GPU Switch cannot expose a batch finalization state.');
  }
  if (finalized && batchId !== null && batchStateAtFinalization === null) {
    throw new Error('A finalized batch-bound GPU Switch must expose its batch state.');
  }
  if (state === 'needs_attention' && (batchId === null || batchStateAtFinalization !== 'running')) {
    throw new Error('Pause attention requires its exact running batch identity.');
  }
  if (state === 'pausing' && reason === 'requester_cancelled'
    && (batchId === null || batchStateAtFinalization !== 'running')) {
    throw new Error('In-flight cancellation requires its exact running batch identity.');
  }

  const readyToDeleteAt = nullableTimestamp(item.ready_to_delete_at, 'gpu_switch_request.ready_to_delete_at');
  const fixedPoint = ['ready_to_delete', 'delete_intent', 'replacement_ready'].includes(state);
  if (fixedPoint !== (readyToDeleteAt !== null)) {
    throw new Error('gpu_switch_request pause fixed-point timestamp is incompatible with its state.');
  }

  const replacementAttemptId = item.replacement_attempt_id === null
    ? null
    : canonicalUuid(item.replacement_attempt_id, 'gpu_switch_request.replacement_attempt_id');
  const replacementAttemptRevision = item.replacement_attempt_revision === null
    ? null
    : integer(item.replacement_attempt_revision, 'gpu_switch_request.replacement_attempt_revision', 1);
  const replacementPodId = item.replacement_pod_id === null
    ? null
    : podId(item.replacement_pod_id, 'gpu_switch_request.replacement_pod_id');
  const actualTargetGpuId = item.actual_target_gpu_id === null
    ? null
    : gpuIdentity(item.actual_target_gpu_id, 'gpu_switch_request.actual_target_gpu_id');
  const replacementValues = [
    replacementAttemptId,
    replacementAttemptRevision,
    replacementPodId,
    actualTargetGpuId,
  ];
  const anyReplacementNull = replacementValues.some((candidate) => candidate === null);
  const allReplacementNull = replacementValues.every((candidate) => candidate === null);
  const hasReplacement = !anyReplacementNull;
  if (anyReplacementNull !== allReplacementNull || hasReplacement !== (state === 'replacement_ready')) {
    throw new Error('gpu_switch_request replacement identity is incompatible with its state.');
  }

  return {
    schemaVersion: 1,
    switchId: canonicalUuid(item.switch_id, 'gpu_switch_request.switch_id'),
    oldPodId: podId(item.old_pod_id, 'gpu_switch_request.old_pod_id'),
    oldGpuId: gpuIdentity(item.old_gpu_id, 'gpu_switch_request.old_gpu_id'),
    oldGpuDisplayName: gpuIdentity(item.old_gpu_display_name, 'gpu_switch_request.old_gpu_display_name'),
    initialTargetGpuId: gpuIdentity(item.initial_target_gpu_id, 'gpu_switch_request.initial_target_gpu_id'),
    initialTargetGpuDisplayName: gpuIdentity(item.initial_target_gpu_display_name, 'gpu_switch_request.initial_target_gpu_display_name'),
    initialReplacementAttemptId: canonicalUuid(item.initial_replacement_attempt_id, 'gpu_switch_request.initial_replacement_attempt_id'),
    requester: participant(item.requester, 'gpu_switch_request.requester'),
    state,
    reason,
    requestedAt: timestamp(item.requested_at, 'gpu_switch_request.requested_at'),
    responseDeadline: timestamp(item.response_deadline, 'gpu_switch_request.response_deadline'),
    readyToDeleteAt,
    waitingFor: switchParticipants(item.waiting_for, 'gpu_switch_request.waiting_for'),
    approvedBy: switchParticipants(item.approved_by, 'gpu_switch_request.approved_by'),
    deniedBy: switchParticipants(item.denied_by, 'gpu_switch_request.denied_by'),
    batchId,
    batchOwner,
    batchStateAtFinalization,
    replacementAttemptId,
    replacementAttemptRevision,
    replacementPodId,
    actualTargetGpuId,
  };
}

export function parseStudioState(value: unknown): StudioState {
  const item = record(value, 'studio state');
  exactKeys(item, [
    'schema_version',
    'server_instance_id',
    'coordination_revision',
    'server_time',
    'presence_ttl_seconds',
    'response_ttl_seconds',
    'finalization_ttl_seconds',
    'current_session',
    'sessions',
    'active_batch',
    'stop_request',
    'gpu_switch_request',
    'gpu_switch_can_respond',
  ], 'studio state');
  if (item.schema_version !== 1) throw new Error('studio state schema version is unsupported.');
  const parsedSessions = sessions(item.sessions);
  const currentSession = session(item.current_session, 'current_session');
  if (!parsedSessions.some((candidate) => candidate.sessionId === currentSession.sessionId)) {
    throw new Error('current_session is missing from sessions.');
  }
  const parsedStopRequest = stopRequest(item.stop_request);
  const parsedGpuSwitchRequest = gpuSwitchRequest(item.gpu_switch_request);
  if (typeof item.gpu_switch_can_respond !== 'boolean') {
    throw new Error('gpu_switch_can_respond must be a boolean.');
  }
  const gpuSwitchCanRespond = item.gpu_switch_can_respond;
  if (
    gpuSwitchCanRespond
    && (
      parsedGpuSwitchRequest === null
      || parsedGpuSwitchRequest.state !== 'pending'
      || currentSession.availability !== 'foreground'
      || parsedGpuSwitchRequest.requester.sessionId === currentSession.sessionId
    )
  ) {
    throw new Error('gpu_switch_can_respond is incompatible with the current Studio state.');
  }
  if (
    parsedGpuSwitchRequest?.waitingFor.some(
      (candidate) => candidate.sessionId === currentSession.sessionId,
    )
    && !gpuSwitchCanRespond
  ) {
    throw new Error('A waiting current session must receive its GPU Switch response capability.');
  }
  if (parsedStopRequest?.state === 'finalizing') {
    const requesterView = parsedStopRequest.requester.sessionId === currentSession.sessionId;
    if (requesterView && parsedStopRequest.finalizationId === null) {
      throw new Error('The exact requester must receive its finalization ID.');
    }
    if (!requesterView && parsedStopRequest.finalizationId !== null) {
      throw new Error('A non-requester cannot receive another session finalization ID.');
    }
  }
  return {
    schemaVersion: 1,
    serverInstanceId: uuid(item.server_instance_id, 'server_instance_id'),
    coordinationRevision: integer(item.coordination_revision, 'coordination_revision'),
    serverTime: timestamp(item.server_time, 'server_time'),
    presenceTtlSeconds: integer(item.presence_ttl_seconds, 'presence_ttl_seconds', 1, 300),
    responseTtlSeconds: integer(item.response_ttl_seconds, 'response_ttl_seconds', 1, 600),
    finalizationTtlSeconds: integer(item.finalization_ttl_seconds, 'finalization_ttl_seconds', 1, 120),
    currentSession,
    sessions: parsedSessions,
    activeBatch: item.active_batch === null ? null : parseWorkerBatchSummary(item.active_batch),
    stopRequest: parsedStopRequest,
    gpuSwitchRequest: parsedGpuSwitchRequest,
    gpuSwitchCanRespond,
  };
}

export function requireStudioState(result: WorkerHttpResult, expected: readonly number[]): StudioState {
  if (!expected.includes(result.status)) {
    try {
      const error = parseWorkerApiError(result.body);
      throw new StudioContractError(error.code, error.message, result.status, error.details);
    } catch (error) {
      if (error instanceof StudioContractError) throw error;
      throw new StudioContractError(
        'studio_response_invalid',
        'The ImageForge coordination service returned an invalid error response.',
        result.status,
      );
    }
  }
  try {
    return parseStudioState(result.body);
  } catch {
    throw new StudioContractError(
      'studio_response_invalid',
      'The ImageForge coordination service returned an invalid state.',
      result.status,
    );
  }
}

export function projectStudioState(state: StudioState): StudioSyncState {
  const request = state.stopRequest;
  let stop: StudioStopState;
  if (request === null) {
    stop = {
      phase: 'idle',
      requestId: null,
      podId: null,
      gpuDisplayName: null,
      requester: null,
      isRequester: false,
      canRespond: false,
      waitingFor: [],
      approvedBy: [],
      deniedBy: [],
      responseDeadline: null,
      finalizationExpiresAt: null,
      finalizationId: null,
      reason: null,
      message: null,
      retryable: false,
      blockedByBatch: null,
    };
  } else {
    const isRequester = request.requester.sessionId === state.currentSession.sessionId;
    stop = {
      phase: request.state,
      requestId: request.requestId,
      podId: request.podId,
      gpuDisplayName: request.gpuDisplayName,
      requester: request.requester,
      isRequester,
      canRespond: request.waitingFor.some((participant) => participant.sessionId === state.currentSession.sessionId),
      waitingFor: request.waitingFor,
      approvedBy: request.approvedBy,
      deniedBy: request.deniedBy,
      responseDeadline: request.responseDeadline,
      finalizationExpiresAt: request.finalizationExpiresAt,
      finalizationId: request.finalizationId,
      reason: request.reason,
      message: null,
      retryable: false,
      blockedByBatch: null,
    };
  }
  const switchRequest = state.gpuSwitchRequest;
  const gpuSwitch: StudioGpuSwitchState | null = switchRequest === null ? null : {
    switchId: switchRequest.switchId,
    oldPodId: switchRequest.oldPodId,
    oldGpuId: switchRequest.oldGpuId,
    oldGpuDisplayName: switchRequest.oldGpuDisplayName,
    initialTargetGpuId: switchRequest.initialTargetGpuId,
    initialTargetGpuDisplayName: switchRequest.initialTargetGpuDisplayName,
    requester: switchRequest.requester,
    isRequester: switchRequest.requester.sessionId === state.currentSession.sessionId,
    canRespond: state.gpuSwitchCanRespond,
    phase: switchRequest.state,
    reason: switchRequest.reason,
    requestedAt: switchRequest.requestedAt,
    responseDeadline: switchRequest.responseDeadline,
    readyToDeleteAt: switchRequest.readyToDeleteAt,
    waitingFor: switchRequest.waitingFor,
    approvedBy: switchRequest.approvedBy,
    deniedBy: switchRequest.deniedBy,
    batchId: switchRequest.batchId,
    batchOwner: switchRequest.batchOwner?.displayName ?? null,
    batchProgress: state.activeBatch?.batchId === switchRequest.batchId
      ? {
          completed: state.activeBatch.progress.completed,
          total: state.activeBatch.progress.total,
        }
      : null,
    batchStateAtFinalization: switchRequest.batchStateAtFinalization,
    replacementPodId: switchRequest.replacementPodId,
    actualTargetGpuId: switchRequest.actualTargetGpuId,
  };
  return {
    connected: true,
    serverInstanceId: state.serverInstanceId,
    coordinationRevision: state.coordinationRevision,
    currentSession: state.currentSession,
    sessions: state.sessions,
    stop,
    gpuSwitch,
  };
}

export type FinalizationGrantValidation =
  | { valid: true; remainingMs: number }
  | {
      valid: false;
      reason:
        | 'epoch_mismatch'
        | 'revision_stale'
        | 'session_mismatch'
        | 'request_missing'
        | 'state_mismatch'
        | 'request_mismatch'
        | 'pod_mismatch'
        | 'requester_mismatch'
        | 'finalization_mismatch'
        | 'expiry_missing'
        | 'expiry_too_short';
    };

/** Validates the single-use worker grant against renderer-local intent. The
 * remaining budget is derived from worker time and reduced by the full native
 * round trip, so client clock skew cannot make a stale grant look fresh. */
export function validateFinalizationGrant(
  state: StudioState,
  expected: {
    serverInstanceId: string;
    approvedCoordinationRevision: number;
    sessionId: string;
    requestId: string;
    podId: string;
    finalizationId: string;
  },
  roundTripMs: number,
  minimumRemainingMs = MIN_FINALIZATION_REMAINING_MS,
): FinalizationGrantValidation {
  if (state.serverInstanceId !== expected.serverInstanceId) return { valid: false, reason: 'epoch_mismatch' };
  if (state.coordinationRevision <= expected.approvedCoordinationRevision) {
    return { valid: false, reason: 'revision_stale' };
  }
  if (state.currentSession.sessionId !== expected.sessionId) return { valid: false, reason: 'session_mismatch' };
  const request = state.stopRequest;
  if (request === null) return { valid: false, reason: 'request_missing' };
  if (request.state !== 'finalizing') return { valid: false, reason: 'state_mismatch' };
  if (request.requestId !== expected.requestId) return { valid: false, reason: 'request_mismatch' };
  if (request.podId !== expected.podId) return { valid: false, reason: 'pod_mismatch' };
  if (request.requester.sessionId !== expected.sessionId) return { valid: false, reason: 'requester_mismatch' };
  if (request.finalizationId !== expected.finalizationId) return { valid: false, reason: 'finalization_mismatch' };
  if (request.finalizationExpiresAt === null) return { valid: false, reason: 'expiry_missing' };
  const boundedRoundTrip = Number.isFinite(roundTripMs) && roundTripMs >= 0 ? roundTripMs : Number.POSITIVE_INFINITY;
  const remainingMs = Date.parse(request.finalizationExpiresAt) - Date.parse(state.serverTime) - boundedRoundTrip;
  if (remainingMs < minimumRemainingMs) return { valid: false, reason: 'expiry_too_short' };
  return { valid: true, remainingMs };
}
