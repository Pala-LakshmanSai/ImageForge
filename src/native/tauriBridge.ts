import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import type { BatchReference, CredentialKind, CredentialMetadata, CredentialMetadataMap } from '../domain/types';
import type { AspectRatio } from '../domain/aspectRatio';
import {
  isAbsoluteQueueDestination,
  isCanonicalQueueUuid,
  isQueueEventId,
  parseNativeQueueSnapshot,
  type NativeAlertInput,
  type NativeAlertResult,
  type NativePowerInput,
  type NativePowerState,
  type NativeQueueCommitV1,
  type NativeQueueDispatchPayloadV1,
  type NativeQueueItemKey,
  type NativeQueueResetV1,
  type NativeQueueSnapshotV1,
  type NativeRunKey,
  type NativeRunnerLease,
} from '../domain/queue';

export interface NativeErrorShape {
  code: string;
  message: string;
  retryable: boolean;
}

interface NativeCredentialMetadata extends CredentialMetadata {
  kind: CredentialKind;
}

export interface NativeDestinationMetadata {
  path: string;
  writable: boolean;
}

export interface NativeDestinationSelection {
  path: string;
  chooserGrant: string;
}

export interface NativeHttpResponse<T = unknown> {
  status: number;
  body: T;
}

export type NativeStudioAvailability = 'foreground' | 'background';
export type NativeStudioStopDecision = 'approve' | 'deny';

export interface NativeStudioSession {
  session_id: string;
  display_name: string;
  availability: NativeStudioAvailability;
  expires_at: string;
}

export interface NativeStudioParticipant {
  session_id: string;
  display_name: string;
}

export interface NativeStudioActiveBatch {
  batch_id: string;
  owner: { user_id: string; display_name: string };
  state: 'running' | 'paused' | 'interrupted';
  progress: {
    total: number;
    completed: number;
    downloaded: number;
    failed: number;
    cancelled: number;
    processed: number;
    current_index: number | null;
  };
  pause_requested: boolean;
  cancel_requested: boolean;
}

export interface NativeStudioStopRequest {
  request_id: string;
  pod_id: string;
  gpu_display_name: string;
  requester: NativeStudioParticipant;
  state: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'finalizing';
  reason:
    | 'peer_denied'
    | 'response_timeout'
    | 'requester_cancelled'
    | 'requester_expired'
    | 'generation_started'
    | 'finalization_expired'
    | null;
  requested_at: string;
  response_deadline: string;
  finalization_expires_at: string | null;
  waiting_for: NativeStudioParticipant[];
  approved_by: NativeStudioParticipant[];
  denied_by: NativeStudioParticipant[];
  finalization_id: string | null;
}

export interface NativeStudioGpuSwitchRequest {
  schema_version: 1;
  switch_id: string;
  old_pod_id: string;
  old_gpu_id: string;
  old_gpu_display_name: string;
  initial_target_gpu_id: string;
  initial_target_gpu_display_name: string;
  initial_replacement_attempt_id: string;
  requester: NativeStudioParticipant;
  state:
    | 'pending'
    | 'approved'
    | 'denied'
    | 'expired'
    | 'cancelled'
    | 'pausing'
    | 'ready_to_delete'
    | 'delete_intent'
    | 'replacement_ready'
    | 'completed'
    | 'needs_attention';
  reason:
    | 'peer_denied'
    | 'response_timeout'
    | 'requester_cancelled'
    | 'requester_expired'
    | 'generation_started'
    | 'batch_changed'
    | 'stop_started'
    | 'target_changed_pre_delete'
    | 'pause_failed'
    | 'replacement_mismatch'
    | 'completion_failed'
    | null;
  requested_at: string;
  response_deadline: string;
  ready_to_delete_at: string | null;
  waiting_for: NativeStudioParticipant[];
  approved_by: NativeStudioParticipant[];
  denied_by: NativeStudioParticipant[];
  batch_id: string | null;
  batch_owner: { display_name: string } | null;
  batch_state_at_finalization: 'running' | 'paused' | 'interrupted' | null;
  replacement_attempt_id: string | null;
  replacement_attempt_revision: number | null;
  replacement_pod_id: string | null;
  actual_target_gpu_id: string | null;
}

export interface NativeStudioState {
  schema_version: 1;
  server_instance_id: string;
  coordination_revision: number;
  server_time: string;
  presence_ttl_seconds: number;
  response_ttl_seconds: number;
  finalization_ttl_seconds: number;
  current_session: NativeStudioSession;
  sessions: NativeStudioSession[];
  active_batch: NativeStudioActiveBatch | null;
  stop_request: NativeStudioStopRequest | null;
  gpu_switch_request: NativeStudioGpuSwitchRequest | null;
  gpu_switch_can_respond: boolean;
}

export interface NativeStudioErrorEnvelope {
  error: {
    code: string;
    message: string;
    details:
      | { owner: string; completed: number; total: number }
      | { request_id: string; requester: string; expires_at: string }
      | { request_id: string; requester: string; state: 'pending' | 'approved' | 'finalizing' }
      | { waiting_for: string[] }
      | { state: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'finalizing' }
      | null;
  };
}

export type NativeStudioHttpResponse = NativeHttpResponse<NativeStudioState | NativeStudioErrorEnvelope>;

interface PendingRunPodStartGrant {
  createGrant: string;
  emergencyGrant: string | null;
}

let pendingRunPodStartGrant: PendingRunPodStartGrant | null = null;

export interface NativeDownloadRequest {
  batchId: string;
  batchName?: string;
  index: number;
  expectedSha256: string;
  expectedSizeBytes: number;
  expectedWidth: number;
  expectedHeight: number;
}

export interface NativeDownloadReceipt {
  schemaVersion: 1;
  batchId: string;
  index: number;
  filename: string;
  sha256: string;
  sizeBytes: number;
  verifiedAtUnixMs: number;
}

export interface NativeReceiptLedger {
  schemaVersion: 1;
  batchId: string;
  receipts: NativeDownloadReceipt[];
}

export interface NativePreviewResponse {
  contentType: 'image/jpeg' | 'image/webp';
  sha256: string;
  sizeBytes: number;
  bytes: number[];
}

export interface NativeExportArtifactRequest {
  batchId: string;
  index: number;
  batchName: string;
  checksum: string;
}

export interface NativeRunPodCreateMarkerMetadata {
  pending: boolean;
  attemptId: string | null;
  attemptedAtUnixMs: number | null;
  podName: string | null;
  gpuId: string | null;
  podId: string | null;
}

export type QueueReleaseSmokePlatform = 'macos' | 'windows';
export type QueueReleaseSmokeArchitecture = 'aarch64' | 'x86_64';

export interface QueueReleaseSmokeBatchEvidenceV1 {
  ordinal: 1 | 2 | 3;
  queueItemId: string;
  clientSubmissionId: string;
  remoteBatchId: string;
  promptCount: number;
  preparedWithNativeBridge: true;
  receiptCount: number;
  receiptFixedPoint: true;
  terminalState: 'completed';
  minimizedAtCompletion: true;
}

export interface QueueReleaseSmokeEvidenceV1 {
  schemaVersion: 1;
  smokeId: string;
  platform: QueueReleaseSmokePlatform;
  architecture: QueueReleaseSmokeArchitecture;
  appVersion: string;
  completedAt: string;
  viewport: {
    width: number;
    height: number;
    horizontalOverflowPx: number;
  };
  queue: {
    requestedRows: 450;
    maxMountedRows: number;
    visibleRowLimit: 40;
    realNativeBridge: true;
    runRevision: string;
    runnerLeaseReleased: true;
    batches: [
      QueueReleaseSmokeBatchEvidenceV1,
      QueueReleaseSmokeBatchEvidenceV1,
      QueueReleaseSmokeBatchEvidenceV1,
    ];
  };
  prompts: {
    requestedRows: 450;
    maxMountedRows: number;
    visibleRowLimit: 30;
  };
  keyboard: {
    sampleCount: 30;
    trustedSampleCount: 30;
    key: 'Enter';
    operation: 'move';
    samplesMs: number[];
    p95Ms: number;
  };
  minimized: {
    observed: true;
    sequentialBatches: 3;
  };
  alarm: {
    eventId: string;
    signalCalls: 1;
    uniqueEvents: 1;
    fixedPoint: true;
    disposition: NativeAlertResult['disposition'];
  };
  runPod: {
    createCalls: 0;
    deleteCalls: 0;
  };
}

export type NativeQueueReleaseSmokeInputV1 =
  | { schemaVersion: 1; operation: 'bootstrap' }
  | { schemaVersion: 1; operation: 'dispatch_trusted_key'; sampleIndex: number; key: 'Enter' }
  | { schemaVersion: 1; operation: 'audit' }
  | { schemaVersion: 1; operation: 'write_evidence'; evidence: QueueReleaseSmokeEvidenceV1 }
  | { schemaVersion: 1; operation: 'write_failure'; detail: string };

export type NativeQueueReleaseSmokeResultV1 =
  | {
      schemaVersion: 1;
      operation: 'bootstrap';
      platform: QueueReleaseSmokePlatform;
      architecture: QueueReleaseSmokeArchitecture;
      appVersion: string;
      destination: string;
    }
  | {
      schemaVersion: 1;
      operation: 'dispatch_trusted_key';
      sampleIndex: number;
      dispatched: true;
    }
  | {
      schemaVersion: 1;
      operation: 'audit';
      runPodCreateCalls: number;
      runPodDeleteCalls: number;
    }
  | {
      schemaVersion: 1;
      operation: 'write_evidence';
      written: true;
      evidenceSha256: string;
    }
  | {
      schemaVersion: 1;
      operation: 'write_failure';
      written: true;
    };

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __IMAGEFORGE_NATIVE_SMOKE__?: boolean;
    __IMAGEFORGE_NATIVE_SMOKE_ROLE__?: 'A' | 'B';
    __IMAGEFORGE_QUEUE_RELEASE_SMOKE__?: boolean;
    __IMAGEFORGE_GPU_SELECTOR_PERF_QA__?: boolean;
    __IMAGEFORGE_GPU_SELECTOR_PERF_QA_CONFIG__?: {
      action: GpuSelectorPerfActionV1;
      initialOrdinal: number;
      viewportWidth: 1280 | 1440;
      viewportHeight: 720 | 900;
    };
  }
}

export type GpuSelectorPerfActionV1 =
  | 'cold_open'
  | 'warm_open'
  | 'refresh_loading'
  | 'keyboard_move'
  | 'keyboard_select';

export interface GpuSelectorPerfArmV1 {
  readonly fixtureSha256: string;
  readonly action: GpuSelectorPerfActionV1;
  readonly ordinal: number;
  readonly viewportWidth: 1280 | 1440;
  readonly viewportHeight: 720 | 900;
}

export interface GpuSelectorPerfArmResultV1 {
  readonly schemaVersion: 1;
  readonly armed: true;
  readonly qaSessionId: string;
}

export interface GpuSelectorPerfStartedEventV1 {
  readonly schemaVersion: 1;
  readonly event: 'gpu-selector-perf-started-v1';
  readonly qaSessionId: string;
  readonly sampleId: string;
  readonly action: GpuSelectorPerfActionV1;
  readonly ordinal: number;
  readonly viewportWidth: 1280 | 1440;
  readonly viewportHeight: 720 | 900;
}

export interface GpuSelectorPerfCommitV1 {
  readonly qaSessionId: string;
  readonly sampleId: string;
  readonly mountedRowIds: readonly string[];
}

export interface GpuSelectorPerfSampleV1 {
  readonly schemaVersion: 1;
  readonly sampleId: string;
  readonly platform: string;
  readonly appVersion: string;
  readonly commitSha: string;
  readonly artifactSha256: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly action: GpuSelectorPerfActionV1;
  readonly ordinal: number;
  readonly durationUs: number;
  readonly mountedGpuRows: number;
  readonly mountedRowIdsSha256: string;
}

export function isNativeDesktop(): boolean {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;
}

export function asNativeError(error: unknown): NativeErrorShape {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as Partial<NativeErrorShape>;
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
      return {
        code: candidate.code,
        message: candidate.message,
        retryable: candidate.retryable === true,
      };
    }
  }
  return {
    code: 'native_operation_failed',
    message: 'The native ImageForge operation could not be completed.',
    retryable: false,
  };
}

function strictRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`The native ${label} response is invalid.`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`The native ${label} response has an invalid schema.`);
  }
  return record;
}

function safeUnsignedInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseQueueDispatchPayload(value: unknown): NativeQueueDispatchPayloadV1 {
  const record = strictRecord(value, [
    'queueItemId', 'clientSubmissionId', 'name', 'prompts', 'baseSeed',
    'destination', 'aspectRatio', 'references',
  ], 'queue dispatch');
  const prompts = record.prompts;
  const references = record.references;
  if (
    !isCanonicalQueueUuid(record.queueItemId)
    || !isCanonicalQueueUuid(record.clientSubmissionId)
    || record.queueItemId === record.clientSubmissionId
    || typeof record.name !== 'string'
    || record.name.trim() !== record.name
    || record.name.length < 1
    || new TextEncoder().encode(record.name).length > 120
    || /[\u0000-\u001f\u007f-\u009f]/u.test(record.name)
    || !Array.isArray(prompts)
    || prompts.length < 1
    || prompts.some((prompt) => typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0'))
    || !safeUnsignedInteger(record.baseSeed)
    || record.baseSeed + prompts.length - 1 > Number.MAX_SAFE_INTEGER
    || typeof record.destination !== 'string'
    || record.destination.includes('\0')
    || !(
      record.destination.startsWith('/')
      || /^[A-Za-z]:[\\/]/u.test(record.destination)
      || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(record.destination)
    )
    || !['16:9', '1:1', '9:16', '4:3', '3:4'].includes(record.aspectRatio as string)
    || !Array.isArray(references)
    || references.length > 8
  ) throw new Error('The native queue dispatch response is invalid.');

  const parsedReferences = references.map((value) => {
    const reference = strictRecord(value, ['id', 'name', 'mimeType', 'sizeBytes', 'sha256', 'bytes'], 'queue reference');
    if (
      !isCanonicalQueueUuid(reference.id)
      || typeof reference.name !== 'string'
      || !reference.name.trim()
      || new TextEncoder().encode(reference.name).length > 255
      || /[\\/\0]/u.test(reference.name)
      || !['image/jpeg', 'image/png', 'image/webp'].includes(reference.mimeType as string)
      || !safeUnsignedInteger(reference.sizeBytes)
      || reference.sizeBytes < 1
      || reference.sizeBytes > 8 * 1024 * 1024
      || typeof reference.sha256 !== 'string'
      || !/^[0-9a-f]{64}$/u.test(reference.sha256)
      || !Array.isArray(reference.bytes)
      || reference.bytes.length !== reference.sizeBytes
      || reference.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
    ) throw new Error('The native queue reference response is invalid.');
    return reference;
  });
  if (
    new Set(parsedReferences.map((reference) => reference.id)).size !== parsedReferences.length
    || parsedReferences.reduce((total, reference) => total + (reference.sizeBytes as number), 0) > 32 * 1024 * 1024
  ) throw new Error('The native queue reference response is invalid.');
  return record as unknown as NativeQueueDispatchPayloadV1;
}

function parseRunnerLease(value: unknown): NativeRunnerLease {
  const record = strictRecord(value, ['runRevision', 'held'], 'queue runner lease');
  if (!isCanonicalQueueUuid(record.runRevision) || typeof record.held !== 'boolean') {
    throw new Error('The native queue runner lease response is invalid.');
  }
  return record as unknown as NativeRunnerLease;
}

function parsePowerState(value: unknown): NativePowerState {
  const record = strictRecord(value, ['runRevision', 'active', 'platform', 'displaySleepAllowed'], 'queue power');
  if (
    (record.runRevision !== null && !isCanonicalQueueUuid(record.runRevision))
    || typeof record.active !== 'boolean'
    || (record.active !== (record.runRevision !== null))
    || !['macos', 'windows'].includes(record.platform as string)
    || record.displaySleepAllowed !== true
  ) throw new Error('The native queue power response is invalid.');
  return record as unknown as NativePowerState;
}

function parseAlertResult(value: unknown): NativeAlertResult {
  const record = strictRecord(value, ['eventId', 'notificationId', 'disposition'], 'queue alert');
  if (
    !isQueueEventId(record.eventId)
    || !Number.isSafeInteger(record.notificationId)
    || (record.notificationId as number) < 1
    || (record.notificationId as number) > 0x7fffffff
    || !['delivered', 'already_delivered', 'permission_denied', 'failed'].includes(record.disposition as string)
  ) throw new Error('The native queue alert response is invalid.');
  return record as unknown as NativeAlertResult;
}

function exactIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function queueReleaseSmokeP95(samplesMs: readonly number[]): number {
  if (samplesMs.length === 0 || samplesMs.some((sample) => !finiteNonNegative(sample))) {
    throw new Error('The queue release keyboard samples are invalid.');
  }
  const ordered = [...samplesMs].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1]!;
}

export function parseQueueReleaseSmokeEvidence(value: unknown): QueueReleaseSmokeEvidenceV1 {
  const record = strictRecord(value, [
    'schemaVersion', 'smokeId', 'platform', 'architecture', 'appVersion', 'completedAt',
    'viewport', 'queue', 'prompts', 'keyboard', 'minimized', 'alarm', 'runPod',
  ], 'queue release smoke evidence');
  const viewport = strictRecord(record.viewport, ['width', 'height', 'horizontalOverflowPx'], 'queue release smoke viewport');
  const queue = strictRecord(record.queue, ['requestedRows', 'maxMountedRows', 'visibleRowLimit', 'realNativeBridge', 'runRevision', 'runnerLeaseReleased', 'batches'], 'queue release smoke queue');
  const prompts = strictRecord(record.prompts, ['requestedRows', 'maxMountedRows', 'visibleRowLimit'], 'queue release smoke prompts');
  const keyboard = strictRecord(record.keyboard, ['sampleCount', 'trustedSampleCount', 'key', 'operation', 'samplesMs', 'p95Ms'], 'queue release smoke keyboard');
  const minimized = strictRecord(record.minimized, ['observed', 'sequentialBatches'], 'queue release smoke minimized run');
  const alarm = strictRecord(record.alarm, ['eventId', 'signalCalls', 'uniqueEvents', 'fixedPoint', 'disposition'], 'queue release smoke alarm');
  const runPod = strictRecord(record.runPod, ['createCalls', 'deleteCalls'], 'queue release smoke RunPod audit');
  if (!Array.isArray(queue.batches) || queue.batches.length !== 3) {
    throw new Error('The native queue release smoke evidence is invalid.');
  }
  const batches = queue.batches.map((batchValue, index) => {
    const batch = strictRecord(batchValue, [
      'ordinal', 'queueItemId', 'clientSubmissionId', 'remoteBatchId', 'promptCount',
      'preparedWithNativeBridge', 'receiptCount', 'receiptFixedPoint', 'terminalState',
      'minimizedAtCompletion',
    ], 'queue release smoke batch');
    if (
      batch.ordinal !== index + 1
      || !isCanonicalQueueUuid(batch.queueItemId)
      || !isCanonicalQueueUuid(batch.clientSubmissionId)
      || !isCanonicalQueueUuid(batch.remoteBatchId)
      || new Set([batch.queueItemId, batch.clientSubmissionId, batch.remoteBatchId]).size !== 3
      || !safeUnsignedInteger(batch.promptCount)
      || (batch.promptCount as number) < 1
      || batch.preparedWithNativeBridge !== true
      || batch.receiptCount !== batch.promptCount
      || batch.receiptFixedPoint !== true
      || batch.terminalState !== 'completed'
      || batch.minimizedAtCompletion !== true
    ) throw new Error('The native queue release smoke batch evidence is invalid.');
    return batch;
  });
  const samples = keyboard.samplesMs;
  if (
    record.schemaVersion !== 1
    || !isCanonicalQueueUuid(record.smokeId)
    || !['macos', 'windows'].includes(record.platform as string)
    || !['aarch64', 'x86_64'].includes(record.architecture as string)
    || typeof record.appVersion !== 'string'
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(record.appVersion)
    || !exactIsoTimestamp(record.completedAt)
    || !safeUnsignedInteger(viewport.width)
    || (viewport.width as number) < 900
    || !safeUnsignedInteger(viewport.height)
    || (viewport.height as number) < 650
    || viewport.horizontalOverflowPx !== 0
    || queue.requestedRows !== 450
    || !safeUnsignedInteger(queue.maxMountedRows)
    || (queue.maxMountedRows as number) < 1
    || (queue.maxMountedRows as number) > 40
    || queue.visibleRowLimit !== 40
    || queue.realNativeBridge !== true
    || !isCanonicalQueueUuid(queue.runRevision)
    || queue.runnerLeaseReleased !== true
    || new Set(batches.map((batch) => batch.queueItemId)).size !== 3
    || new Set(batches.map((batch) => batch.clientSubmissionId)).size !== 3
    || new Set(batches.map((batch) => batch.remoteBatchId)).size !== 3
    || prompts.requestedRows !== 450
    || !safeUnsignedInteger(prompts.maxMountedRows)
    || (prompts.maxMountedRows as number) < 1
    || (prompts.maxMountedRows as number) > 30
    || prompts.visibleRowLimit !== 30
    || keyboard.sampleCount !== 30
    || keyboard.trustedSampleCount !== 30
    || keyboard.key !== 'Enter'
    || keyboard.operation !== 'move'
    || !Array.isArray(samples)
    || samples.length !== 30
    || samples.some((sample) => !finiteNonNegative(sample))
    || !finiteNonNegative(keyboard.p95Ms)
    || keyboard.p95Ms !== queueReleaseSmokeP95(samples as number[])
    || (keyboard.p95Ms as number) >= 100
    || minimized.observed !== true
    || minimized.sequentialBatches !== 3
    || !isQueueEventId(alarm.eventId)
    || alarm.eventId !== `queue-complete:${queue.runRevision as string}`
    || alarm.signalCalls !== 1
    || alarm.uniqueEvents !== 1
    || alarm.fixedPoint !== true
    || !['delivered', 'already_delivered', 'permission_denied', 'failed'].includes(alarm.disposition as string)
    || runPod.createCalls !== 0
    || runPod.deleteCalls !== 0
  ) throw new Error('The native queue release smoke evidence is invalid.');
  return record as unknown as QueueReleaseSmokeEvidenceV1;
}

function parseQueueReleaseSmokeResult(value: unknown): NativeQueueReleaseSmokeResultV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The native queue release smoke response is invalid.');
  }
  const operation = (value as Record<string, unknown>).operation;
  if (operation === 'bootstrap') {
    const record = strictRecord(value, ['schemaVersion', 'operation', 'platform', 'architecture', 'appVersion', 'destination'], 'queue release smoke bootstrap');
    if (
      record.schemaVersion !== 1
      || !['macos', 'windows'].includes(record.platform as string)
      || !['aarch64', 'x86_64'].includes(record.architecture as string)
      || typeof record.appVersion !== 'string'
      || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(record.appVersion)
      || typeof record.destination !== 'string'
      || !isAbsoluteQueueDestination(record.destination)
    ) throw new Error('The native queue release smoke bootstrap response is invalid.');
    return record as unknown as NativeQueueReleaseSmokeResultV1;
  }
  if (operation === 'dispatch_trusted_key') {
    const record = strictRecord(value, ['schemaVersion', 'operation', 'sampleIndex', 'dispatched'], 'queue release smoke key dispatch');
    if (record.schemaVersion !== 1 || !safeUnsignedInteger(record.sampleIndex) || (record.sampleIndex as number) < 1 || (record.sampleIndex as number) > 30 || record.dispatched !== true) {
      throw new Error('The native queue release smoke key response is invalid.');
    }
    return record as unknown as NativeQueueReleaseSmokeResultV1;
  }
  if (operation === 'audit') {
    const record = strictRecord(value, ['schemaVersion', 'operation', 'runPodCreateCalls', 'runPodDeleteCalls'], 'queue release smoke audit');
    if (record.schemaVersion !== 1 || !safeUnsignedInteger(record.runPodCreateCalls) || !safeUnsignedInteger(record.runPodDeleteCalls)) {
      throw new Error('The native queue release smoke audit response is invalid.');
    }
    return record as unknown as NativeQueueReleaseSmokeResultV1;
  }
  if (operation === 'write_evidence') {
    const record = strictRecord(value, ['schemaVersion', 'operation', 'written', 'evidenceSha256'], 'queue release smoke evidence write');
    if (record.schemaVersion !== 1 || record.written !== true || typeof record.evidenceSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(record.evidenceSha256)) {
      throw new Error('The native queue release smoke evidence write response is invalid.');
    }
    return record as unknown as NativeQueueReleaseSmokeResultV1;
  }
  if (operation === 'write_failure') {
    const record = strictRecord(value, ['schemaVersion', 'operation', 'written'], 'queue release smoke failure write');
    if (record.schemaVersion !== 1 || record.written !== true) {
      throw new Error('The native queue release smoke failure response is invalid.');
    }
    return record as unknown as NativeQueueReleaseSmokeResultV1;
  }
  throw new Error('The native queue release smoke response is invalid.');
}

export async function nativeCredentialMetadata(): Promise<CredentialMetadataMap> {
  const entries = await invoke<NativeCredentialMetadata[]>('credential_metadata');
  const byKind = new Map(entries.map((entry) => [entry.kind, entry] as const));
  const runpodApiKey = byKind.get('runpodApiKey');
  const workerToken = byKind.get('workerToken');
  if (!runpodApiKey || !workerToken) {
    throw new Error('The native credential vault returned incomplete metadata.');
  }
  return { runpodApiKey, workerToken };
}

export function nativeReplaceCredential(
  kind: CredentialKind,
  value: string,
): Promise<CredentialMetadata> {
  return invoke<NativeCredentialMetadata>('replace_credential', { kind, value });
}

export function nativeChooseDestination(defaultPath: string): Promise<NativeDestinationSelection | null> {
  return invoke<NativeDestinationSelection | null>('choose_destination', { defaultPath });
}

export function nativeValidateDestination(
  path: string,
  chooserGrant: string,
): Promise<NativeDestinationMetadata> {
  return invoke<NativeDestinationMetadata>('validate_destination', { path, chooserGrant });
}

export function nativeRestoreDestination(): Promise<NativeDestinationMetadata | null> {
  return invoke<NativeDestinationMetadata | null>('restore_destination');
}

export function nativeRevealDestination(relativePath?: string): Promise<void> {
  return invoke('reveal_destination', { relativePath: relativePath ?? null });
}

export function nativeWriteManifest(batchId: string, content: string): Promise<string> {
  return invoke<string>('write_manifest', { batchId, content });
}

export function bindNativeWorkerSession(podId: string): Promise<void> {
  return invoke('bind_worker_session', { podId });
}

export function clearNativeWorkerSession(): Promise<void> {
  return invoke('clear_worker_session');
}

export function bindNativeRunPodProfile(templateId: string, networkVolumeId: string): Promise<void> {
  return invoke('bind_runpod_profile', { templateId, networkVolumeId });
}

/** Arms exactly one foreground Pod create. RTX 2000 Ada additionally requires
 * the separately issued emergency grant. Grants expire natively and are
 * cleared from renderer memory before the create invoke begins. */
export async function nativeAuthorizeRunPodStart(allowSlowEmergency: boolean): Promise<void> {
  const createGrant = await invoke<string>('authorize_runpod_create');
  try {
    const emergencyGrant = allowSlowEmergency
      ? await invoke<string>('authorize_emergency_gpu')
      : null;
    pendingRunPodStartGrant = { createGrant, emergencyGrant };
  } catch (error) {
    await invoke('clear_runpod_start_authorization').catch(() => undefined);
    throw error;
  }
}

export async function nativeClearRunPodStartAuthorization(): Promise<void> {
  pendingRunPodStartGrant = null;
  await invoke('clear_runpod_start_authorization');
}

export function nativeRunPodCreateMarkerMetadata(): Promise<NativeRunPodCreateMarkerMetadata> {
  return invoke<NativeRunPodCreateMarkerMetadata>('runpod_create_marker_metadata');
}

export function nativeResolveRunPodCreateMarker(
  attemptId: string,
  reconciledPodId: string | null,
): Promise<void> {
  return invoke('resolve_runpod_create_marker', { attemptId, reconciledPodId });
}

export function nativeWorkerHealth(): Promise<NativeHttpResponse> {
  return invoke('worker_health');
}

export function nativeWorkerStatus(): Promise<NativeHttpResponse> {
  return invoke('worker_status');
}

export function nativeWorkerStudioHeartbeat(
  sessionId: string,
  availability: NativeStudioAvailability,
): Promise<NativeStudioHttpResponse> {
  return invoke('worker_studio_heartbeat', { input: { sessionId, availability } });
}

export function nativeWorkerStudioStatus(sessionId: string): Promise<NativeStudioHttpResponse> {
  return invoke('worker_studio_status', { sessionId });
}

export function nativeWorkerStudioCreateStopRequest(
  requestId: string,
  sessionId: string,
  podId: string,
  gpuDisplayName: string,
): Promise<NativeStudioHttpResponse> {
  return invoke('worker_studio_create_stop_request', {
    input: { requestId, sessionId, podId, gpuDisplayName },
  });
}

export function nativeWorkerStudioRespondToStopRequest(
  requestId: string,
  sessionId: string,
  decision: NativeStudioStopDecision,
): Promise<NativeStudioHttpResponse> {
  return invoke('worker_studio_respond_to_stop_request', {
    input: { requestId, sessionId, decision },
  });
}

export function nativeWorkerStudioRespondToGpuSwitch(
  switchId: string,
  sessionId: string,
  decision: NativeStudioStopDecision,
): Promise<NativeStudioHttpResponse> {
  return invoke('worker_studio_respond_to_gpu_switch', {
    input: { switchId, sessionId, decision },
  });
}

export function nativeWorkerStudioCancelStopRequest(
  requestId: string,
  sessionId: string,
  podId: string,
  finalizationId: string | null,
): Promise<NativeStudioHttpResponse> {
  return invoke('worker_studio_cancel_stop_request', {
    input: { requestId, sessionId, podId, finalizationId },
  });
}

export interface NativeWorkerReference {
  name: string;
  mimeType: BatchReference['mimeType'];
  bytes: number[];
}

export function nativeWorkerCreateBatch(
  prompts: string[],
  baseSeed: number,
  references: NativeWorkerReference[] = [],
  aspectRatio: AspectRatio = '16:9',
  clientSubmissionId = crypto.randomUUID(),
  admissionMode: 'foreground' | 'queue' = 'foreground',
): Promise<NativeHttpResponse> {
  return invoke('worker_create_batch', {
    input: { prompts, baseSeed, references, aspectRatio, clientSubmissionId, admissionMode },
  });
}

export function nativeWorkerGetSubmission(clientSubmissionId: string): Promise<NativeHttpResponse> {
  return invoke('worker_get_submission', { clientSubmissionId });
}

export function nativeWorkerGetBatch(batchId: string): Promise<NativeHttpResponse> {
  return invoke('worker_get_batch', { batchId });
}

export function nativeWorkerPauseBatch(batchId: string): Promise<NativeHttpResponse> {
  return invoke('worker_pause_batch', { batchId });
}

export function nativeWorkerResumeBatch(batchId: string): Promise<NativeHttpResponse> {
  return invoke('worker_resume_batch', { batchId });
}

export function nativeWorkerCancelBatch(batchId: string): Promise<NativeHttpResponse> {
  return invoke('worker_cancel_batch', { batchId });
}

export function nativeWorkerRetryFailed(batchId: string): Promise<NativeHttpResponse> {
  return invoke('worker_retry_failed', { batchId });
}

export function nativeWorkerFetchPreview(batchId: string, index: number): Promise<NativePreviewResponse> {
  return invoke('worker_fetch_preview', { batchId, index });
}

export function nativeReadLocalArtifact(batchId: string, index: number): Promise<NativePreviewResponse> {
  return invoke('read_local_artifact', { batchId, index });
}

export function nativeExportArtifact(request: NativeExportArtifactRequest): Promise<string | null> {
  return invoke('export_artifact', { request });
}

export function nativeDownloadArtifact(request: NativeDownloadRequest): Promise<NativeDownloadReceipt> {
  return invoke('download_artifact', { request });
}

export function nativeReadReceiptLedger(batchId: string, batchName?: string): Promise<NativeReceiptLedger> {
  return invoke<NativeReceiptLedger>('read_receipt_ledger', {
    batchId,
    batchName: batchName ?? null,
  });
}

export function nativeReconcileReceipts(batchId: string): Promise<NativeReceiptLedger> {
  return invoke<NativeReceiptLedger>('reconcile_receipts', { batchId });
}

export async function nativeQueueLoad(): Promise<NativeQueueSnapshotV1> {
  return parseNativeQueueSnapshot(await invoke('queue_load'));
}

export async function nativeQueueReset(input: NativeQueueResetV1): Promise<NativeQueueSnapshotV1> {
  return parseNativeQueueSnapshot(await invoke('queue_reset', { input }));
}

export async function nativeQueueCommit(input: NativeQueueCommitV1): Promise<NativeQueueSnapshotV1> {
  return parseNativeQueueSnapshot(await invoke('queue_commit', { input }));
}

export async function nativeQueuePrepareDispatch(input: NativeQueueItemKey): Promise<NativeQueueDispatchPayloadV1> {
  return parseQueueDispatchPayload(await invoke('queue_prepare_dispatch', { input }));
}

export async function nativeQueueAcquireRunner(input: NativeRunKey): Promise<NativeRunnerLease> {
  return parseRunnerLease(await invoke('queue_acquire_runner', { input }));
}

export async function nativeQueueReleaseRunner(input: NativeRunKey): Promise<NativeRunnerLease> {
  return parseRunnerLease(await invoke('queue_release_runner', { input }));
}

export async function nativeQueueSetSleepPrevention(input: NativePowerInput): Promise<NativePowerState> {
  return parsePowerState(await invoke('queue_set_sleep_prevention', { input }));
}

export async function nativeQueueSignalAlert(input: NativeAlertInput): Promise<NativeAlertResult> {
  return parseAlertResult(await invoke('queue_signal_alert', { input }));
}

/** Installed-only Task 014 selector instrumentation. The native host rejects
 * these commands unless an artifact-bound QA session was established before
 * the window was created. */
export function nativeGpuSelectorPerfArm(
  input: GpuSelectorPerfArmV1,
): Promise<GpuSelectorPerfArmResultV1> {
  return invoke('gpu_selector_perf_arm', { input });
}

export function nativeGpuSelectorPerfCommit(
  input: GpuSelectorPerfCommitV1,
): Promise<GpuSelectorPerfSampleV1> {
  return invoke('gpu_selector_perf_commit', { input });
}

/**
 * Release-only installed-app probe. The native host exposes this command only
 * when IMAGEFORGE_NATIVE_SMOKE=queue-release; production launches reject it.
 * The discriminated envelope is intentionally narrower than a general input
 * or filesystem automation surface.
 */
export async function nativeQueueReleaseSmokeExchange(
  input: NativeQueueReleaseSmokeInputV1,
): Promise<NativeQueueReleaseSmokeResultV1> {
  if (input.operation === 'write_evidence') parseQueueReleaseSmokeEvidence(input.evidence);
  if (
    input.operation === 'dispatch_trusted_key'
    && (!safeUnsignedInteger(input.sampleIndex) || input.sampleIndex < 1 || input.sampleIndex > 30 || input.key !== 'Enter')
  ) throw new Error('The queue release smoke key request is invalid.');
  if (
    input.operation === 'write_failure'
    && (!input.detail || input.detail.length > 240 || /[\u0000-\u001f\u007f-\u009f]/u.test(input.detail))
  ) throw new Error('The queue release smoke failure detail is invalid.');
  return parseQueueReleaseSmokeResult(await invoke('native_queue_release_smoke_exchange', { input }));
}

export function nativeQueueNotificationPermissionGranted(): Promise<boolean> {
  return isPermissionGranted();
}

export function nativeQueueRequestNotificationPermission(): Promise<'granted' | 'denied' | 'prompt' | 'prompt-with-rationale'> {
  return requestPermission().then((permission) => permission === 'default' ? 'prompt' : permission);
}

const WORKER_PROXY_HOST = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,56}[A-Za-z0-9])?)-8000\.proxy\.runpod\.net$/;

/** Health-only fetch surface used by the RunPod readiness controller. The
 * lifecycle has already verified the managed Pod; this binds its derived ID to
 * the native worker session and performs the public health request natively. */
export const nativeWorkerHealthFetch: typeof fetch = async (input, init = {}) => {
  if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  const rawUrl = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
  const url = new URL(rawUrl);
  const match = WORKER_PROXY_HOST.exec(url.hostname);
  if (
    !match ||
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.pathname !== '/v1/health' ||
    url.search !== '' ||
    url.hash !== '' ||
    (init.method ?? 'GET').toUpperCase() !== 'GET'
  ) {
    throw new Error('Worker health is restricted to a derived RunPod proxy endpoint.');
  }
  await bindNativeWorkerSession(match[1]);
  const result = await nativeWorkerHealth();
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': 'application/json' },
  });
};
