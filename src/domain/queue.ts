import type { AspectRatio } from './aspectRatio';
import type { BatchReference, DraftState, SettingsState } from './types';

export const QUEUE_SCHEMA_VERSION = 1 as const;
export const QUEUE_MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
export const QUEUE_VISIBLE_ROW_LIMIT = 40;
export const ACTIVE_PROMPT_VISIBLE_ROW_LIMIT = 30;

export type QueueItemState =
  | 'staged'
  | 'dispatching'
  | 'active'
  | 'saving'
  | 'completed'
  | 'completed_with_failures'
  | 'needs_attention'
  | 'interrupted'
  | 'cancelled'
  | 'historical';

export type QueueRunnerState =
  | 'idle'
  | 'running'
  | 'pause_after_current'
  | 'paused'
  | 'needs_attention'
  | 'completed';

export type QueueAlarmState = 'disarmed' | 'armed' | 'ringing' | 'snoozed' | 'acknowledged';
export type QueueAlertKind = 'complete' | 'attention' | 'snooze';
export type QueueNotificationDisposition = 'pending' | 'delivered' | 'permission_denied' | 'failed';

export interface NativeQueueIssue {
  code: string;
  queueItemId: string | null;
  retryable: boolean;
}

export interface NativeQueueReferenceV1 {
  id: string;
  name: string;
  mimeType: BatchReference['mimeType'];
  sizeBytes: number;
  sha256: string;
}

export interface NativeQueueItemV1 {
  schemaVersion: 1;
  queueItemId: string;
  clientSubmissionId: string;
  recordRevision: number;
  runRevision: string | null;
  remoteBatchId: string | null;
  state: QueueItemState;
  attentionCode: string | null;
  name: string;
  prompts: string[];
  baseSeed: number;
  destination: string;
  aspectRatio: AspectRatio;
  styleSuffix: string | null;
  references: NativeQueueReferenceV1[];
  createdAt: string;
  updatedAt: string;
}

export interface NativeQueueItemPlaceholderV1 {
  schemaVersion: 1;
  queueItemId: string;
  recordRevision: number;
  state: 'needs_attention';
  attentionCode: 'queue_item_corrupt';
  name: string;
  promptCount: number;
  referenceCount: number;
  createdAt: string;
  updatedAt: string;
}

export type NativeQueueRowV1 = NativeQueueItemV1 | NativeQueueItemPlaceholderV1;

export interface NativeQueueRunV1 {
  runRevision: string;
  cohortItemIds: string[];
  runnerState: QueueRunnerState;
  authorizationRequired: boolean;
  keepAwake: boolean;
}

export interface NativeQueueAlarmV1 {
  eventId: string;
  runRevision: string;
  state: QueueAlarmState;
  kind: 'complete' | 'attention' | null;
  snoozeUsed: boolean;
  snoozeDueAt: string | null;
  notificationDisposition: QueueNotificationDisposition | null;
  snoozeNotificationDisposition: QueueNotificationDisposition | null;
}

export interface NativeQueueDocumentV1 {
  schemaVersion: 1;
  items: NativeQueueRowV1[];
  run: NativeQueueRunV1 | null;
  alarm: NativeQueueAlarmV1 | null;
}

export interface NativeQueueSnapshotV1 {
  schemaVersion: 1;
  storeRevision: number;
  document: NativeQueueDocumentV1;
  issues: NativeQueueIssue[];
}

export interface NativeReferenceBlobV1 {
  sha256: string;
  mimeType: BatchReference['mimeType'];
  sizeBytes: number;
  bytes: number[];
}

export interface NativeQueueCommitV1 {
  expectedRevision: number;
  document: NativeQueueDocumentV1;
  referenceBlobs: NativeReferenceBlobV1[];
}

export interface NativeQueueItemKey {
  queueItemId: string;
  clientSubmissionId: string;
  purpose: 'edit' | 'dispatch';
}

export interface NativeQueueDispatchReferenceV1 extends NativeQueueReferenceV1 {
  bytes: number[];
}

export interface NativeQueueDispatchPayloadV1 {
  queueItemId: string;
  clientSubmissionId: string;
  name: string;
  prompts: string[];
  baseSeed: number;
  destination: string;
  aspectRatio: AspectRatio;
  references: NativeQueueDispatchReferenceV1[];
}

export interface NativeRunKey {
  runRevision: string;
}

export interface NativeRunnerLease {
  runRevision: string;
  held: boolean;
}

export interface NativePowerInput extends NativeRunKey {
  enabled: boolean;
}

export interface NativePowerState {
  runRevision: string | null;
  active: boolean;
  platform: 'macos' | 'windows';
  displaySleepAllowed: true;
}

export interface NativeAlertInput {
  eventId: string;
  kind: QueueAlertKind;
}

export interface NativeAlertResult {
  eventId: string;
  notificationId: number;
  disposition: 'delivered' | 'already_delivered' | 'permission_denied' | 'failed';
}

export interface NativeQueueResetV1 {
  confirmation: 'RESET LOCAL QUEUE';
}

export interface QueueHostPort {
  load(): Promise<NativeQueueSnapshotV1>;
  reset(input: NativeQueueResetV1): Promise<NativeQueueSnapshotV1>;
  commit(input: NativeQueueCommitV1): Promise<NativeQueueSnapshotV1>;
  prepareDispatch(input: NativeQueueItemKey): Promise<NativeQueueDispatchPayloadV1>;
  acquireRunner(input: NativeRunKey): Promise<NativeRunnerLease>;
  releaseRunner(input: NativeRunKey): Promise<NativeRunnerLease>;
  setSleepPrevention(input: NativePowerInput): Promise<NativePowerState>;
  signalAlert(input: NativeAlertInput): Promise<NativeAlertResult>;
  isNotificationPermissionGranted(): Promise<boolean>;
  requestNotificationPermission(): Promise<'granted' | 'denied' | 'prompt' | 'prompt-with-rationale'>;
}

export interface QueueUiState extends NativeQueueSnapshotV1 {
  loadState: 'loading' | 'ready' | 'error';
  lease: NativeRunnerLease | null;
  power: NativePowerState | null;
  alarmTest: 'idle' | 'playing' | 'tested' | 'heard' | 'blocked';
  notificationPermission: 'unknown' | 'granted' | 'denied';
  keepAwakePreference: boolean;
}

export interface StagedQueueItem {
  item: NativeQueueItemV1;
  referenceBlobs: NativeReferenceBlobV1[];
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EVENT_ID = /^queue-complete:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const ITEM_STATES: readonly QueueItemState[] = [
  'staged', 'dispatching', 'active', 'saving', 'completed',
  'completed_with_failures', 'needs_attention', 'interrupted',
  'cancelled', 'historical',
];
const RUNNER_STATES: readonly QueueRunnerState[] = [
  'idle', 'running', 'pause_after_current', 'paused', 'needs_attention', 'completed',
];
const ALARM_STATES: readonly QueueAlarmState[] = ['disarmed', 'armed', 'ringing', 'snoozed', 'acknowledged'];
const ASPECT_RATIOS: readonly AspectRatio[] = ['16:9', '1:1', '9:16', '4:3', '3:4'];
const MIME_TYPES: readonly BatchReference['mimeType'][] = ['image/jpeg', 'image/png', 'image/webp'];
const ITEM_TRANSITIONS: Readonly<Record<QueueItemState, readonly QueueItemState[]>> = {
  staged: ['staged', 'dispatching', 'needs_attention', 'cancelled'],
  dispatching: ['dispatching', 'staged', 'active', 'needs_attention', 'interrupted', 'cancelled'],
  active: ['active', 'saving', 'needs_attention', 'interrupted', 'cancelled'],
  saving: ['saving', 'completed', 'completed_with_failures', 'needs_attention', 'interrupted', 'cancelled'],
  completed: ['completed', 'historical'],
  completed_with_failures: ['completed_with_failures', 'historical'],
  needs_attention: ['needs_attention', 'staged', 'dispatching', 'active', 'cancelled'],
  interrupted: ['interrupted', 'active', 'needs_attention', 'cancelled'],
  cancelled: ['cancelled', 'historical'],
  historical: [],
};
const RUNNER_TRANSITIONS: Readonly<Record<QueueRunnerState, readonly QueueRunnerState[]>> = {
  idle: ['idle', 'running', 'paused'],
  running: ['running', 'pause_after_current', 'paused', 'needs_attention', 'completed'],
  pause_after_current: ['pause_after_current', 'paused', 'needs_attention', 'completed'],
  paused: ['paused', 'running', 'needs_attention', 'completed'],
  needs_attention: ['needs_attention', 'running', 'paused', 'completed'],
  completed: ['completed'],
};
const ALARM_TRANSITIONS: Readonly<Record<QueueAlarmState, readonly QueueAlarmState[]>> = {
  disarmed: ['disarmed', 'acknowledged'],
  armed: ['armed', 'ringing'],
  ringing: ['ringing', 'snoozed', 'acknowledged'],
  snoozed: ['snoozed', 'ringing', 'acknowledged'],
  acknowledged: ['acknowledged'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function containsControl(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

export function isAbsoluteQueueDestination(value: string): boolean {
  if (value.includes('\0')) return false;
  // Queue snapshots are shared between the common TypeScript layer and the
  // target-native Rust hosts. Accept the two target-OS absolute path shapes,
  // while rejecting relative paths on both platforms.
  return value.startsWith('/')
    || /^[A-Za-z]:[\\/]/u.test(value)
    || /^\\\\\?\\[A-Za-z]:[\\/]/u.test(value)
    || /^\\\\(?!\?\\)[^\\/]+[\\/][^\\/]+/u.test(value);
}

export function isCanonicalQueueUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

export function isQueueEventId(value: unknown): value is string {
  return typeof value === 'string' && EVENT_ID.test(value);
}

export function isQueueLocallyRemovableIssue(
  row: NativeQueueRowV1,
): row is NativeQueueItemV1 & {
  state: 'needs_attention';
  attentionCode: 'queue_reference_missing' | 'queue_reference_mismatch' | 'queue_destination_unavailable';
} {
  return !isQueuePlaceholder(row)
    && row.state === 'needs_attention'
    && [
      'queue_reference_missing',
      'queue_reference_mismatch',
      'queue_destination_unavailable',
    ].includes(row.attentionCode ?? '');
}

function parseReference(value: unknown): NativeQueueReferenceV1 {
  if (!isRecord(value) || !exactKeys(value, ['id', 'name', 'mimeType', 'sizeBytes', 'sha256'])) {
    throw new Error('A queue reference has an invalid schema.');
  }
  if (
    !isCanonicalQueueUuid(value.id)
    || typeof value.name !== 'string'
    || value.name.length < 1
    || new TextEncoder().encode(value.name).length > 255
    || /[\\/\0]/u.test(value.name)
    || !MIME_TYPES.includes(value.mimeType as BatchReference['mimeType'])
    || !safeInteger(value.sizeBytes)
    || value.sizeBytes < 1
    || value.sizeBytes > 8 * 1024 * 1024
    || typeof value.sha256 !== 'string'
    || !SHA256.test(value.sha256)
  ) throw new Error('A queue reference is invalid.');
  return value as unknown as NativeQueueReferenceV1;
}

export function assertQueueItemStateFields(item: NativeQueueItemV1): void {
  const attentionRequired = item.state === 'needs_attention' || item.state === 'interrupted';
  if (attentionRequired !== (item.attentionCode !== null)) {
    throw new Error('The queue attention state is inconsistent.');
  }
  if (['staged', 'dispatching'].includes(item.state) && item.remoteBatchId !== null) {
    throw new Error('An unaccepted queue item cannot have a remote batch ID.');
  }
  if (['active', 'saving', 'completed', 'completed_with_failures', 'interrupted'].includes(item.state) && item.remoteBatchId === null) {
    throw new Error('An accepted queue item requires its exact remote batch ID.');
  }
  if (!['staged', 'needs_attention'].includes(item.state) && item.runRevision === null) {
    throw new Error('A progressed queue item must belong to a run.');
  }
}

export function assertQueueItemTransition(previous: NativeQueueItemV1, next: NativeQueueItemV1): void {
  const promptsMatch = previous.prompts.length === next.prompts.length
    && previous.prompts.every((prompt, index) => prompt === next.prompts[index]);
  const referencesMatch = previous.references.length === next.references.length
    && previous.references.every((reference, index) => {
      const candidate = next.references[index];
      return candidate !== undefined
        && reference.id === candidate.id
        && reference.name === candidate.name
        && reference.mimeType === candidate.mimeType
        && reference.sizeBytes === candidate.sizeBytes
        && reference.sha256 === candidate.sha256;
    });
  if (
    previous.schemaVersion !== next.schemaVersion
    || previous.queueItemId !== next.queueItemId
    || previous.clientSubmissionId !== next.clientSubmissionId
    || previous.name !== next.name
    || previous.baseSeed !== next.baseSeed
    || previous.destination !== next.destination
    || previous.aspectRatio !== next.aspectRatio
    || previous.styleSuffix !== next.styleSuffix
    || previous.createdAt !== next.createdAt
    || !promptsMatch
    || !referencesMatch
  ) {
    throw new Error('A staged queue snapshot cannot change after admission.');
  }
  if (previous.state === 'historical') {
    throw new Error('A historical queue item is immutable.');
  }
  if (!ITEM_TRANSITIONS[previous.state].includes(next.state)) {
    throw new Error(`Queue item cannot move from ${previous.state} to ${next.state}.`);
  }
  if (next.recordRevision !== previous.recordRevision + 1) {
    throw new Error('A queue item mutation must advance its record revision exactly once.');
  }
  if (previous.remoteBatchId !== null && next.remoteBatchId !== previous.remoteBatchId) {
    throw new Error('A queue item cannot change its exact remote batch association.');
  }
  if (previous.runRevision !== null && next.runRevision !== previous.runRevision) {
    throw new Error('A queue item cannot leave or change its assigned run revision.');
  }
  if (
    previous.runRevision === null
    && next.runRevision !== null
    && (previous.state !== 'staged' || next.state !== 'staged')
  ) {
    throw new Error('Only a staged cohort-admission commit may assign a run revision.');
  }
  assertQueueItemStateFields(next);
}

function notificationDispositionCanAdvance(
  previous: QueueNotificationDisposition | null,
  next: QueueNotificationDisposition | null,
): boolean {
  if (previous === null) return true;
  if (previous === 'pending') return next !== null;
  if (previous === 'delivered') return next === 'delivered';
  return next === 'delivered' || next === 'permission_denied' || next === 'failed';
}

export function assertQueueAlarmTransition(
  previous: NativeQueueAlarmV1,
  next: NativeQueueAlarmV1,
  nowMs = Date.now(),
): void {
  if (previous.runRevision !== next.runRevision || previous.eventId !== next.eventId) {
    throw new Error('A queue alarm cannot change its run or event identity.');
  }
  if (!ALARM_TRANSITIONS[previous.state].includes(next.state)) {
    throw new Error(`Queue alarm cannot move from ${previous.state} to ${next.state}.`);
  }
  if (previous.kind !== null && next.kind !== previous.kind) {
    throw new Error('A queue alarm cannot change its completion kind.');
  }
  if (previous.snoozeUsed && !next.snoozeUsed) {
    throw new Error('A queue alarm cannot restore its one-time snooze.');
  }
  if (
    previous.state === 'snoozed'
    && next.state === 'snoozed'
    && previous.snoozeDueAt !== next.snoozeDueAt
  ) {
    throw new Error('A queue alarm cannot extend its one-time snooze.');
  }
  if (previous.state === 'snoozed' && next.state === 'ringing') {
    const dueAt = previous.snoozeDueAt === null ? Number.NaN : new Date(previous.snoozeDueAt).valueOf();
    if (!Number.isFinite(dueAt) || nowMs < dueAt || next.snoozeNotificationDisposition !== 'pending') {
      throw new Error('A snoozed queue alarm cannot ring before its due time.');
    }
  }
  if (
    !notificationDispositionCanAdvance(previous.notificationDisposition, next.notificationDisposition)
    || !notificationDispositionCanAdvance(previous.snoozeNotificationDisposition, next.snoozeNotificationDisposition)
  ) {
    throw new Error('A queue notification disposition cannot move backward.');
  }
}

export function isQueuePlaceholder(row: NativeQueueRowV1): row is NativeQueueItemPlaceholderV1 {
  return 'promptCount' in row;
}

function parseItem(value: unknown): NativeQueueRowV1 {
  if (!isRecord(value)) throw new Error('A queue item is invalid.');
  if ('promptCount' in value) {
    const keys = ['schemaVersion', 'queueItemId', 'recordRevision', 'state', 'attentionCode', 'name', 'promptCount', 'referenceCount', 'createdAt', 'updatedAt'];
    if (
      !exactKeys(value, keys)
      || value.schemaVersion !== 1
      || !isCanonicalQueueUuid(value.queueItemId)
      || !safeInteger(value.recordRevision)
      || value.state !== 'needs_attention'
      || value.attentionCode !== 'queue_item_corrupt'
      || typeof value.name !== 'string'
      || !safeInteger(value.promptCount)
      || !safeInteger(value.referenceCount)
      || !timestamp(value.createdAt)
      || !timestamp(value.updatedAt)
    ) throw new Error('A corrupt queue placeholder is invalid.');
    return value as unknown as NativeQueueItemPlaceholderV1;
  }
  const keys = [
    'schemaVersion', 'queueItemId', 'clientSubmissionId', 'recordRevision', 'runRevision',
    'remoteBatchId', 'state', 'attentionCode', 'name', 'prompts', 'baseSeed', 'destination',
    'aspectRatio', 'styleSuffix', 'references', 'createdAt', 'updatedAt',
  ];
  if (!exactKeys(value, keys) || value.schemaVersion !== 1) throw new Error('A queue item has an invalid schema.');
  const prompts = value.prompts;
  const references = value.references;
  if (
    !isCanonicalQueueUuid(value.queueItemId)
    || !isCanonicalQueueUuid(value.clientSubmissionId)
    || value.queueItemId === value.clientSubmissionId
    || !safeInteger(value.recordRevision)
    || (value.runRevision !== null && !isCanonicalQueueUuid(value.runRevision))
    || (value.remoteBatchId !== null && !isCanonicalQueueUuid(value.remoteBatchId))
    || !ITEM_STATES.includes(value.state as QueueItemState)
    || (value.attentionCode !== null && (
      typeof value.attentionCode !== 'string'
      || value.attentionCode.length < 1
      || new TextEncoder().encode(value.attentionCode).length > 80
      || containsControl(value.attentionCode)
    ))
    || typeof value.name !== 'string'
    || value.name.trim() !== value.name
    || !value.name
    || new TextEncoder().encode(value.name).length > 120
    || containsControl(value.name)
    || !Array.isArray(prompts)
    || prompts.length < 1
    || prompts.some((prompt) => typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0'))
    || !safeInteger(value.baseSeed)
    || value.baseSeed + prompts.length - 1 > QUEUE_MAX_SAFE_INTEGER
    || typeof value.destination !== 'string'
    || !isAbsoluteQueueDestination(value.destination)
    || !ASPECT_RATIOS.includes(value.aspectRatio as AspectRatio)
    || (value.styleSuffix !== null && (
      typeof value.styleSuffix !== 'string'
      || value.styleSuffix.trim() !== value.styleSuffix
      || !value.styleSuffix
      || value.styleSuffix.includes('\0')
    ))
    || !Array.isArray(references)
    || references.length > 8
    || !timestamp(value.createdAt)
    || !timestamp(value.updatedAt)
  ) throw new Error('A queue item is invalid.');
  const parsedReferences = references.map(parseReference);
  if (new Set(parsedReferences.map((reference) => reference.id)).size !== parsedReferences.length) {
    throw new Error('Queue reference IDs must be distinct.');
  }
  if (parsedReferences.reduce((total, reference) => total + reference.sizeBytes, 0) > 32 * 1024 * 1024) {
    throw new Error('Queue references exceed the total byte limit.');
  }
  const item = { ...value, references: parsedReferences } as unknown as NativeQueueItemV1;
  assertQueueItemStateFields(item);
  return item;
}

function parseRun(value: unknown): NativeQueueRunV1 | null {
  if (value === null) return null;
  if (!isRecord(value) || !exactKeys(value, ['runRevision', 'cohortItemIds', 'runnerState', 'authorizationRequired', 'keepAwake'])) {
    throw new Error('The queue run has an invalid schema.');
  }
  if (
    !isCanonicalQueueUuid(value.runRevision)
    || !Array.isArray(value.cohortItemIds)
    || (value.cohortItemIds.length < 1 && value.runnerState !== 'completed')
    || value.cohortItemIds.some((id) => !isCanonicalQueueUuid(id))
    || new Set(value.cohortItemIds).size !== value.cohortItemIds.length
    || !RUNNER_STATES.includes(value.runnerState as QueueRunnerState)
    || typeof value.authorizationRequired !== 'boolean'
    || typeof value.keepAwake !== 'boolean'
  ) throw new Error('The queue run is invalid.');
  const authorizationRequired = value.authorizationRequired as boolean;
  const runnerState = value.runnerState as QueueRunnerState;
  if (['running', 'pause_after_current'].includes(runnerState) === authorizationRequired) {
    throw new Error('The queue run authorization state is inconsistent.');
  }
  return value as unknown as NativeQueueRunV1;
}

function parseAlarm(value: unknown): NativeQueueAlarmV1 | null {
  if (value === null) return null;
  const keys = [
    'eventId', 'runRevision', 'state', 'kind', 'snoozeUsed', 'snoozeDueAt',
    'notificationDisposition', 'snoozeNotificationDisposition',
  ];
  if (!isRecord(value) || !exactKeys(value, keys)) throw new Error('The queue alarm has an invalid schema.');
  const dispositions = ['pending', 'delivered', 'permission_denied', 'failed'];
  if (
    !isQueueEventId(value.eventId)
    || !isCanonicalQueueUuid(value.runRevision)
    || value.eventId !== `queue-complete:${value.runRevision}`
    || !ALARM_STATES.includes(value.state as QueueAlarmState)
    || ![null, 'complete', 'attention'].includes(value.kind as null | string)
    || typeof value.snoozeUsed !== 'boolean'
    || (value.snoozeDueAt !== null && !timestamp(value.snoozeDueAt))
    || (value.notificationDisposition !== null && !dispositions.includes(value.notificationDisposition as string))
    || (value.snoozeNotificationDisposition !== null && !dispositions.includes(value.snoozeNotificationDisposition as string))
  ) throw new Error('The queue alarm is invalid.');
  const state = value.state as QueueAlarmState;
  const kind = value.kind as NativeQueueAlarmV1['kind'];
  const snoozeUsed = value.snoozeUsed as boolean;
  if (
    (kind === null && !['armed', 'disarmed'].includes(state))
    || (kind !== null && state === 'armed')
    || (state === 'snoozed' && (!snoozeUsed || value.snoozeDueAt === null))
    || (state !== 'snoozed' && value.snoozeDueAt !== null)
    || (!snoozeUsed && value.snoozeNotificationDisposition !== null)
    || (kind === null && (value.notificationDisposition !== null || value.snoozeNotificationDisposition !== null))
    || (['armed', 'disarmed'].includes(state) && (snoozeUsed || value.snoozeNotificationDisposition !== null))
    || (state === 'disarmed' && kind !== null && value.notificationDisposition !== null)
  ) throw new Error('The queue alarm lifecycle is inconsistent.');
  return value as unknown as NativeQueueAlarmV1;
}

export function parseNativeQueueSnapshot(value: unknown): NativeQueueSnapshotV1 {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'storeRevision', 'document', 'issues'])) {
    throw new Error('The native queue snapshot has an invalid schema.');
  }
  if (value.schemaVersion !== 1 || !safeInteger(value.storeRevision) || !isRecord(value.document) || !Array.isArray(value.issues)) {
    throw new Error('The native queue snapshot is invalid.');
  }
  const document = value.document;
  if (!exactKeys(document, ['schemaVersion', 'items', 'run', 'alarm']) || document.schemaVersion !== 1 || !Array.isArray(document.items)) {
    throw new Error('The native queue document is invalid.');
  }
  const items = document.items.map(parseItem);
  const ids = items.map((item) => item.queueItemId);
  if (new Set(ids).size !== ids.length) throw new Error('Queue item IDs must be distinct.');
  const run = parseRun(document.run);
  if (run !== null && run.cohortItemIds.some((id) => !ids.includes(id))) throw new Error('The queue cohort references a missing item.');
  const alarm = parseAlarm(document.alarm);
  if ((run === null) !== (alarm === null) || (run !== null && alarm?.runRevision !== run.runRevision)) {
    throw new Error('Queue run and alarm revisions do not match.');
  }
  if (run !== null && alarm !== null) {
    const completed = run.runnerState === 'completed';
    if (completed !== (alarm.kind !== null)) throw new Error('Queue completion and alarm state do not match.');
  }
  if (run === null) {
    const invalid = items.some((row) => !isQueuePlaceholder(row) && (
      !['staged', 'needs_attention', 'historical'].includes(row.state)
      || (row.state !== 'historical' && row.runRevision !== null)
    ));
    if (invalid) throw new Error('A queue item cannot belong to a missing current run.');
  } else {
    const cohort = new Set(run.cohortItemIds);
    for (const row of items) {
      if (isQueuePlaceholder(row)) continue;
      if (cohort.has(row.queueItemId) && row.runRevision !== run.runRevision) {
        throw new Error('Every queue cohort item must belong to the current run.');
      }
      if (
        row.runRevision !== null
        && row.state !== 'historical'
        && (row.runRevision !== run.runRevision || !cohort.has(row.queueItemId))
      ) {
        throw new Error('An assigned queue item must belong to the current cohort.');
      }
    }
  }
  const issues = value.issues.map((issue) => {
    if (
      !isRecord(issue)
      || !exactKeys(issue, ['code', 'queueItemId', 'retryable'])
      || typeof issue.code !== 'string'
      || (issue.queueItemId !== null && !isCanonicalQueueUuid(issue.queueItemId))
      || typeof issue.retryable !== 'boolean'
    ) throw new Error('A native queue issue is invalid.');
    return issue as unknown as NativeQueueIssue;
  });
  return {
    schemaVersion: 1,
    storeRevision: value.storeRevision,
    document: { schemaVersion: 1, items, run, alarm },
    issues,
  };
}

export function createEmptyQueueSnapshot(): NativeQueueSnapshotV1 {
  return {
    schemaVersion: 1,
    storeRevision: 0,
    document: { schemaVersion: 1, items: [], run: null, alarm: null },
    issues: [],
  };
}

export function createInitialQueueUiState(): QueueUiState {
  return {
    ...createEmptyQueueSnapshot(),
    loadState: 'loading',
    lease: null,
    power: null,
    alarmTest: 'idle',
    notificationPermission: 'unknown',
    keepAwakePreference: false,
  };
}

export function isQueueItemTerminal(state: QueueItemState): boolean {
  return ['completed', 'completed_with_failures', 'cancelled', 'historical'].includes(state);
}

export function activeQueueItem(document: NativeQueueDocumentV1): NativeQueueItemV1 | null {
  const run = document.run;
  if (run === null) return null;
  for (const id of run.cohortItemIds) {
    const row = document.items.find((item) => item.queueItemId === id);
    if (row !== undefined && !isQueuePlaceholder(row) && ['dispatching', 'active', 'saving', 'interrupted', 'needs_attention'].includes(row.state)) {
      return row;
    }
  }
  return null;
}

export function nextQueueItem(document: NativeQueueDocumentV1): NativeQueueItemV1 | null {
  const run = document.run;
  if (run === null || run.runnerState !== 'running' || run.authorizationRequired) return null;
  if (run.cohortItemIds.some((id) => {
    const row = document.items.find((item) => item.queueItemId === id);
    return row === undefined || isQueuePlaceholder(row);
  })) return null;
  for (const id of run.cohortItemIds) {
    const row = document.items.find((item) => item.queueItemId === id);
    if (row !== undefined && !isQueuePlaceholder(row) && row.state === 'staged') return row;
  }
  return null;
}

export function queueCohortAtFixedPoint(document: NativeQueueDocumentV1): boolean {
  const run = document.run;
  if (run === null || run.cohortItemIds.length === 0) return false;
  return run.cohortItemIds.every((id) => {
    const row = document.items.find((item) => item.queueItemId === id);
    return row !== undefined && !isQueuePlaceholder(row) && isQueueItemTerminal(row.state);
  });
}

export function queueCompletionKind(document: NativeQueueDocumentV1): 'complete' | 'attention' {
  const run = document.run;
  if (run === null) return 'attention';
  return run.cohortItemIds.some((id) => {
    const row = document.items.find((item) => item.queueItemId === id);
    return row === undefined || isQueuePlaceholder(row) || ['completed_with_failures', 'cancelled'].includes(row.state);
  }) ? 'attention' : 'complete';
}

export function queueRunIsActive(document: NativeQueueDocumentV1): boolean {
  return document.run !== null && ['running', 'pause_after_current', 'paused', 'needs_attention'].includes(document.run.runnerState);
}

export function queueCanStartNewRun(document: NativeQueueDocumentV1): boolean {
  if (document.run === null) return document.items.some((row) => !isQueuePlaceholder(row) && row.state === 'staged' && row.runRevision === null);
  if (document.run.runnerState !== 'completed' || document.alarm?.state !== 'acknowledged') return false;
  return document.items.some((row) => !isQueuePlaceholder(row) && row.state === 'staged' && row.runRevision === null);
}

export function resolveQueuePrompts(draft: DraftState, settings: SettingsState): { prompts: string[]; styleSuffix: string | null; baseSeed: number } {
  const styleSuffix = settings.editorialSuffixEnabled && settings.editorialSuffix.trim()
    ? settings.editorialSuffix.trim()
    : null;
  const prompts = draft.prompts.map((prompt) => styleSuffix ? `${prompt.text} ${styleSuffix}` : prompt.text);
  const baseSeed = draft.prompts[0]?.seed ?? 100_000;
  if (prompts.length < 1 || !Number.isSafeInteger(baseSeed) || baseSeed < 0 || baseSeed + prompts.length - 1 > QUEUE_MAX_SAFE_INTEGER) {
    throw new Error('The queue prompt snapshot is invalid.');
  }
  return { prompts, styleSuffix, baseSeed };
}

export function createStagedQueueItem(
  draft: DraftState,
  settings: SettingsState,
  references: Array<{ metadata: NativeQueueReferenceV1; blob: NativeReferenceBlobV1 }>,
  now: string,
  uuid: () => string = () => crypto.randomUUID(),
): StagedQueueItem {
  if (draft.destination === null || !draft.destination.trim()) throw new Error('Choose a downloads folder before staging.');
  if (!timestamp(now)) throw new Error('The queue timestamp is invalid.');
  const queueItemId = uuid();
  const clientSubmissionId = uuid();
  if (!isCanonicalQueueUuid(queueItemId) || !isCanonicalQueueUuid(clientSubmissionId) || queueItemId === clientSubmissionId) {
    throw new Error('The queue IDs are invalid.');
  }
  const resolved = resolveQueuePrompts(draft, settings);
  return {
    item: {
      schemaVersion: 1,
      queueItemId,
      clientSubmissionId,
      recordRevision: 1,
      runRevision: null,
      remoteBatchId: null,
      state: 'staged',
      attentionCode: null,
      name: draft.name.trim() || 'Untitled batch',
      prompts: resolved.prompts,
      baseSeed: resolved.baseSeed,
      destination: draft.destination,
      aspectRatio: draft.aspectRatio,
      styleSuffix: resolved.styleSuffix,
      references: references.map(({ metadata }) => metadata),
      createdAt: now,
      updatedAt: now,
    },
    referenceBlobs: references.map(({ blob }) => blob),
  };
}

export function replaceQueueItem(
  document: NativeQueueDocumentV1,
  replacement: NativeQueueItemV1,
  replacedId: string | null,
): NativeQueueDocumentV1 {
  const items = [...document.items];
  if (replacedId === null) items.push(replacement);
  else {
    const index = items.findIndex((row) => row.queueItemId === replacedId);
    if (index < 0) throw new Error('The queue item being edited no longer exists.');
    const prior = items[index];
    if (isQueuePlaceholder(prior) || prior.state !== 'staged') throw new Error('Only a staged queue item can be edited.');
    if (prior.runRevision === null) items.splice(index, 1, replacement);
    else {
      const cancelled = { ...prior, state: 'cancelled' as const, updatedAt: replacement.updatedAt, recordRevision: prior.recordRevision + 1 };
      assertQueueItemTransition(prior, cancelled);
      items[index] = cancelled;
      items.push(replacement);
    }
  }
  return { ...document, items };
}

export function moveQueueItem(document: NativeQueueDocumentV1, queueItemId: string, direction: -1 | 1): NativeQueueDocumentV1 {
  const index = document.items.findIndex((row) => row.queueItemId === queueItemId);
  if (index < 0) throw new Error('The queue item no longer exists.');
  const row = document.items[index];
  if (isQueuePlaceholder(row) || row.state !== 'staged') throw new Error('Only staged queue items can move.');
  const target = index + direction;
  if (target < 0 || target >= document.items.length) return document;
  const other = document.items[target];
  if (isQueuePlaceholder(other) || other.state !== 'staged' || other.runRevision !== row.runRevision) return document;
  const items = [...document.items];
  [items[index], items[target]] = [items[target], items[index]];
  let run = document.run;
  if (run !== null && row.runRevision === run.runRevision) {
    const cohort = [...run.cohortItemIds];
    const cohortIndex = cohort.indexOf(row.queueItemId);
    const otherIndex = cohort.indexOf(other.queueItemId);
    if (cohortIndex >= 0 && otherIndex >= 0) {
      [cohort[cohortIndex], cohort[otherIndex]] = [cohort[otherIndex], cohort[cohortIndex]];
      run = { ...run, cohortItemIds: cohort };
    }
  }
  return { ...document, items, run };
}

export function removeQueueItem(document: NativeQueueDocumentV1, queueItemId: string, now: string): NativeQueueDocumentV1 {
  const index = document.items.findIndex((row) => row.queueItemId === queueItemId);
  if (index < 0) throw new Error('The queue item no longer exists.');
  const row = document.items[index];
  if (isQueuePlaceholder(row)) {
    const items = [...document.items];
    items.splice(index, 1);
    return { ...document, items };
  }
  if (row.state !== 'staged' && !isQueueLocallyRemovableIssue(row)) {
    throw new Error('Only a staged or locally damaged queue item can be removed.');
  }
  const items = [...document.items];
  if (row.runRevision === null) items.splice(index, 1);
  else {
    const cancelled = {
      ...row,
      state: 'cancelled' as const,
      attentionCode: null,
      updatedAt: now,
      recordRevision: row.recordRevision + 1,
    };
    assertQueueItemTransition(row, cancelled);
    items[index] = cancelled;
  }
  return { ...document, items };
}

export function clearQueueHistory(document: NativeQueueDocumentV1): NativeQueueDocumentV1 {
  const historicalIds = new Set(
    document.items
      .filter((row): row is NativeQueueItemV1 => !isQueuePlaceholder(row) && row.state === 'historical')
      .map((row) => row.queueItemId),
  );
  if (historicalIds.size === 0) return document;
  const currentRunTouchesHistory = document.run?.cohortItemIds.some((id) => historicalIds.has(id)) ?? false;
  if (currentRunTouchesHistory && !document.run!.cohortItemIds.every((id) => historicalIds.has(id))) {
    throw new Error('Current run history cannot be removed until every cohort row is archived.');
  }
  return {
    ...document,
    items: document.items.filter((row) => !historicalIds.has(row.queueItemId)),
    ...(currentRunTouchesHistory ? { run: null, alarm: null } : {}),
  };
}

export function createQueueRun(
  document: NativeQueueDocumentV1,
  runRevision: string,
  armed: boolean,
  keepAwake: boolean,
): NativeQueueDocumentV1 {
  if (!isCanonicalQueueUuid(runRevision)) throw new Error('The queue run ID is invalid.');
  if (queueRunIsActive(document)) throw Object.assign(new Error('Finish or resolve the current queue run first.'), { code: 'queue_run_active' });
  if (document.run !== null && (document.run.runnerState !== 'completed' || document.alarm?.state !== 'acknowledged')) {
    throw Object.assign(new Error('Acknowledge the completed queue before starting another run.'), { code: 'queue_run_active' });
  }
  const cohort = document.items
    .filter((row): row is NativeQueueItemV1 => !isQueuePlaceholder(row) && row.state === 'staged' && row.runRevision === null)
    .map((row) => row.queueItemId);
  if (cohort.length === 0) throw new Error('Stage at least one batch before running the queue.');
  const cohortSet = new Set(cohort);
  const items = document.items.map((row) => (
    !isQueuePlaceholder(row) && cohortSet.has(row.queueItemId)
      ? { ...row, runRevision, recordRevision: row.recordRevision + 1 }
      : row
  ));
  return {
    schemaVersion: 1,
    items,
    run: {
      runRevision,
      cohortItemIds: cohort,
      // A new run is durably admitted in a non-dispatching state. Native then
      // leases this exact revision before the renderer may authorize it.
      runnerState: 'paused',
      authorizationRequired: true,
      keepAwake,
    },
    alarm: {
      eventId: `queue-complete:${runRevision}`,
      runRevision,
      state: armed ? 'armed' : 'disarmed',
      kind: null,
      snoozeUsed: false,
      snoozeDueAt: null,
      notificationDisposition: null,
      snoozeNotificationDisposition: null,
    },
  };
}

export function updateQueueItem(
  document: NativeQueueDocumentV1,
  queueItemId: string,
  update: Partial<Pick<NativeQueueItemV1, 'state' | 'attentionCode' | 'remoteBatchId'>>,
  now: string,
): NativeQueueDocumentV1 {
  const items = document.items.map((row) => {
    if (row.queueItemId !== queueItemId) return row;
    if (isQueuePlaceholder(row)) throw new Error('A corrupt queue placeholder cannot change state.');
    const next = { ...row, ...update, recordRevision: row.recordRevision + 1, updatedAt: now };
    assertQueueItemTransition(row, next);
    return next;
  });
  return { ...document, items };
}

export function updateQueueRun(
  document: NativeQueueDocumentV1,
  update: Partial<NativeQueueRunV1>,
): NativeQueueDocumentV1 {
  if (document.run === null) throw new Error('There is no queue run to update.');
  const next = { ...document.run, ...update };
  assertQueueRunTransition(document.run, next, document);
  return { ...document, run: next };
}

export function assertQueueRunTransition(
  previous: NativeQueueRunV1,
  next: NativeQueueRunV1,
  candidateDocument: NativeQueueDocumentV1,
): void {
  if (
    next.runRevision !== previous.runRevision
    || next.keepAwake !== previous.keepAwake
    || next.cohortItemIds.length !== previous.cohortItemIds.length
    || next.cohortItemIds.some((id, index) => id !== previous.cohortItemIds[index])
  ) throw new Error('The current queue run identity and cohort are immutable.');
  if (!RUNNER_TRANSITIONS[previous.runnerState].includes(next.runnerState)) {
    throw new Error(`Queue runner cannot move from ${previous.runnerState} to ${next.runnerState}.`);
  }
  const shouldRequireAuthorization = !['running', 'pause_after_current'].includes(next.runnerState);
  if (next.authorizationRequired !== shouldRequireAuthorization) {
    throw new Error('The queue runner authorization state is inconsistent.');
  }
  if (next.runnerState === 'completed' && !queueCohortAtFixedPoint(candidateDocument)) {
    throw new Error('The queue runner cannot complete before every cohort item reaches its local fixed point.');
  }
}

export function createVirtualWindow(total: number, scrollTop: number, rowHeight: number, viewportHeight: number) {
  const visible = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const count = Math.min(QUEUE_VISIBLE_ROW_LIMIT, visible + 8, total);
  const start = Math.max(0, Math.min(total - count, Math.floor(scrollTop / rowHeight) - 4));
  return { start, end: start + count, offset: start * rowHeight, totalHeight: total * rowHeight };
}
