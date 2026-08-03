import type {
  StudioParticipant,
  StudioSession,
  StudioStopState,
  StudioSyncState,
} from '../domain/types';
import { parseWorkerApiError, parseWorkerBatchSummary, type WorkerBatchSummary } from './workerContracts';
import type { WorkerHttpResult } from './workerBatchCoordinator';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STOP_STATES = ['pending', 'approved', 'denied', 'expired', 'cancelled', 'finalizing'] as const;
const STOP_REASONS = [
  'peer_denied',
  'response_timeout',
  'requester_cancelled',
  'requester_expired',
  'generation_started',
  'finalization_expired',
] as const;
export const MIN_FINALIZATION_REMAINING_MS = 30_000;

type StudioStopWireState = (typeof STOP_STATES)[number];
type StudioStopReason = (typeof STOP_REASONS)[number];

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
    gpuDisplayName: string(item.gpu_display_name, 'stop_request.gpu_display_name', 120),
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
  ], 'studio state');
  if (item.schema_version !== 1) throw new Error('studio state schema version is unsupported.');
  const parsedSessions = sessions(item.sessions);
  const currentSession = session(item.current_session, 'current_session');
  if (!parsedSessions.some((candidate) => candidate.sessionId === currentSession.sessionId)) {
    throw new Error('current_session is missing from sessions.');
  }
  const parsedStopRequest = stopRequest(item.stop_request);
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
  return {
    connected: true,
    serverInstanceId: state.serverInstanceId,
    coordinationRevision: state.coordinationRevision,
    currentSession: state.currentSession,
    sessions: state.sessions,
    stop,
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
