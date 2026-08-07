import { invoke } from '@tauri-apps/api/core';
import { isGpuIdentityV1 } from '@imageforge/runpod-client';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POD_ID = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,56}[A-Za-z0-9])?$/;
const RFC3339_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type NativeGpuObservedPodStatusV1 =
  | 'provisioning'
  | 'starting'
  | 'running'
  | 'exited'
  | 'error'
  | 'terminated'
  | 'unknown';

export interface NativeGpuObservedPodV1 {
  readonly podId: string;
  readonly gpuId: string;
  readonly gpuDisplayName: string;
  readonly hourlyPriceMicroUsd: number | null;
  readonly status: NativeGpuObservedPodStatusV1;
}

export type NativeGpuPodObservationIssueV1 =
  | { readonly code: 'gpu_pod_observation_unavailable'; readonly retryable: true }
  | { readonly code: 'gpu_pod_observation_invalid'; readonly retryable: false };

export interface NativeGpuPodObservationV1 {
  readonly schemaVersion: 1;
  readonly processEpochId: string;
  readonly lifecycleRevision: number;
  readonly state: 'offline' | 'single' | 'multiple' | 'unavailable';
  readonly observedAt: string | null;
  readonly stale: boolean;
  readonly pods: readonly NativeGpuObservedPodV1[];
  readonly overflow: boolean;
  readonly issue: NativeGpuPodObservationIssueV1 | null;
}

export interface NativeGpuNormalStopV1 {
  readonly podId: string;
  readonly stopRequestId: string;
  readonly sessionId: string;
  readonly expectedServerInstanceId: string;
  readonly expectedCoordinationRevision: number;
  readonly expectedLifecycleRevision: number;
  /** Terminate without the worker stop-request approval handshake. The two
   * editors coordinate outside the app, so Stop never waits on a peer. */
  readonly direct: boolean;
}

export interface NativeGpuNormalStopResultV1 {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly podId: string;
  readonly disposition: 'stopped' | 'already_stopped' | 'delete_uncertain';
  readonly observation: NativeGpuPodObservationV1;
  readonly issue:
    | { readonly code: 'gpu_stop_delete_uncertain'; readonly retryable: false }
    | null;
}

export interface NativeGpuPodPort {
  observe(): Promise<NativeGpuPodObservationV1>;
  loadNormalStop(): Promise<NativeGpuNormalStopV1 | null>;
  normalStop(input: NativeGpuNormalStopV1): Promise<NativeGpuNormalStopResultV1>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  optional: readonly string[] = [],
): boolean {
  // `optional` keeps the shape closed while allowing a field the native side
  // defaults. Rust defaults `direct` to false, so a recovery record written
  // before the field existed must still parse identically on both sides.
  const actual = Object.keys(value).sort();
  const keys = [...expected, ...optional.filter((key) => key in value)].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

function isPodId(value: unknown): value is string {
  return typeof value === 'string' && POD_ID.test(value);
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isMicroUsd(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !RFC3339_MILLISECONDS.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function parseObservedPod(value: unknown): NativeGpuObservedPodV1 | null {
  if (!isRecord(value) || !exactKeys(value, [
    'podId',
    'gpuId',
    'gpuDisplayName',
    'hourlyPriceMicroUsd',
    'status',
  ])) return null;
  if (
    !isPodId(value.podId)
    || !isGpuIdentityV1(value.gpuId)
    || !isGpuIdentityV1(value.gpuDisplayName)
    || (value.hourlyPriceMicroUsd !== null && !isMicroUsd(value.hourlyPriceMicroUsd))
    || ![
      'provisioning',
      'starting',
      'running',
      'exited',
      'error',
      'terminated',
      'unknown',
    ].includes(value.status as string)
  ) return null;
  return Object.freeze({
    podId: value.podId,
    gpuId: value.gpuId,
    gpuDisplayName: value.gpuDisplayName,
    hourlyPriceMicroUsd: value.hourlyPriceMicroUsd as number | null,
    status: value.status as NativeGpuObservedPodStatusV1,
  });
}

function parseObservationIssue(value: unknown): NativeGpuPodObservationIssueV1 | null {
  if (!isRecord(value) || !exactKeys(value, ['code', 'retryable'])) return null;
  if (value.code === 'gpu_pod_observation_unavailable' && value.retryable === true) {
    return Object.freeze({ code: value.code, retryable: true });
  }
  if (value.code === 'gpu_pod_observation_invalid' && value.retryable === false) {
    return Object.freeze({ code: value.code, retryable: false });
  }
  return null;
}

export function parseNativeGpuPodObservationV1(value: unknown): NativeGpuPodObservationV1 | null {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion',
    'processEpochId',
    'lifecycleRevision',
    'state',
    'observedAt',
    'stale',
    'pods',
    'overflow',
    'issue',
  ])) return null;
  if (
    value.schemaVersion !== 1
    || !isUuid(value.processEpochId)
    || !isRevision(value.lifecycleRevision)
    || !['offline', 'single', 'multiple', 'unavailable'].includes(value.state as string)
    || (value.observedAt !== null && !isTimestamp(value.observedAt))
    || typeof value.stale !== 'boolean'
    || !Array.isArray(value.pods)
    || typeof value.overflow !== 'boolean'
  ) return null;
  const pods = value.pods.map(parseObservedPod);
  if (pods.some((pod) => pod === null)) return null;
  const safePods = pods as NativeGpuObservedPodV1[];
  if (
    safePods.length > 16
    || safePods.some((pod, index) => index > 0 && safePods[index - 1].podId >= pod.podId)
  ) return null;
  const issue = value.issue === null ? null : parseObservationIssue(value.issue);
  if (value.issue !== null && issue === null) return null;
  const state = value.state as NativeGpuPodObservationV1['state'];
  const observedAt = value.observedAt as string | null;
  const stale = value.stale;
  const overflow = value.overflow;
  const successRelation = issue === null
    && observedAt !== null
    && stale === false
    && overflow === false
    && (
      (state === 'offline' && safePods.length === 0)
      || (state === 'single' && safePods.length === 1)
      || (state === 'multiple' && safePods.length >= 2 && safePods.length <= 16)
    );
  const overflowRelation = state === 'multiple'
    && safePods.length === 0
    && observedAt !== null
    && stale === false
    && overflow === true
    && issue?.code === 'gpu_pod_observation_invalid';
  const unavailableRelation = state === 'unavailable'
    && stale === true
    && overflow === false
    && issue !== null
    && !(observedAt === null && safePods.length > 0);
  if (!successRelation && !overflowRelation && !unavailableRelation) return null;
  return Object.freeze({
    schemaVersion: 1,
    processEpochId: value.processEpochId,
    lifecycleRevision: value.lifecycleRevision as number,
    state,
    observedAt,
    stale,
    pods: Object.freeze(safePods),
    overflow,
    issue,
  });
}

export function parseNativeGpuNormalStopV1(value: unknown): NativeGpuNormalStopV1 | null {
  if (!isRecord(value) || !exactKeys(value, [
    'podId',
    'stopRequestId',
    'sessionId',
    'expectedServerInstanceId',
    'expectedCoordinationRevision',
    'expectedLifecycleRevision',
  ], ['direct'])) return null;
  if (
    !isPodId(value.podId)
    || !isUuid(value.stopRequestId)
    || !isUuid(value.sessionId)
    || !isUuid(value.expectedServerInstanceId)
    || !isRevision(value.expectedCoordinationRevision)
    || !isRevision(value.expectedLifecycleRevision)
    || (value.direct !== undefined && typeof value.direct !== 'boolean')
  ) return null;
  return Object.freeze({
    podId: value.podId,
    stopRequestId: value.stopRequestId,
    sessionId: value.sessionId,
    expectedServerInstanceId: value.expectedServerInstanceId,
    expectedCoordinationRevision: value.expectedCoordinationRevision as number,
    expectedLifecycleRevision: value.expectedLifecycleRevision as number,
    direct: value.direct === true,
  });
}

export function parseNativeGpuNormalStopResultV1(
  value: unknown,
): NativeGpuNormalStopResultV1 | null {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion',
    'operationId',
    'podId',
    'disposition',
    'observation',
    'issue',
  ])) return null;
  if (
    value.schemaVersion !== 1
    || !isUuid(value.operationId)
    || !isPodId(value.podId)
    || !['stopped', 'already_stopped', 'delete_uncertain'].includes(value.disposition as string)
  ) return null;
  const observation = parseNativeGpuPodObservationV1(value.observation);
  if (observation === null) return null;
  const issue = value.issue;
  if (
    issue !== null
    && (!isRecord(issue)
      || !exactKeys(issue, ['code', 'retryable'])
      || issue.code !== 'gpu_stop_delete_uncertain'
      || issue.retryable !== false)
  ) return null;
  const disposition = value.disposition as NativeGpuNormalStopResultV1['disposition'];
  if ((disposition === 'delete_uncertain') !== (issue !== null)) return null;
  const oldPodPresent = observation.pods.some((pod) => pod.podId === value.podId);
  if (
    (disposition === 'delete_uncertain' && !oldPodPresent)
    || (disposition !== 'delete_uncertain'
      && (observation.state === 'unavailable'
        || observation.stale
        || observation.overflow
        || observation.issue !== null
        || oldPodPresent))
  ) return null;
  return Object.freeze({
    schemaVersion: 1,
    operationId: value.operationId,
    podId: value.podId,
    disposition,
    observation,
    issue: issue === null
      ? null
      : Object.freeze({ code: 'gpu_stop_delete_uncertain', retryable: false }),
  });
}

function requireObservation(value: unknown): NativeGpuPodObservationV1 {
  const parsed = parseNativeGpuPodObservationV1(value);
  if (parsed === null) throw new Error('Native GPU Pod observation returned an invalid strict result.');
  return parsed;
}

export async function nativeGpuPodObserve(): Promise<NativeGpuPodObservationV1> {
  return requireObservation(await invoke('gpu_pod_observe'));
}

export async function nativeGpuNormalStopLoad(): Promise<NativeGpuNormalStopV1 | null> {
  const value: unknown = await invoke('gpu_normal_stop_load');
  if (value === null) return null;
  const parsed = parseNativeGpuNormalStopV1(value);
  if (parsed === null) {
    throw new Error('Native normal GPU Stop recovery returned an invalid strict input.');
  }
  return parsed;
}

export async function nativeGpuNormalStop(
  input: NativeGpuNormalStopV1,
): Promise<NativeGpuNormalStopResultV1> {
  const parsedInput = parseNativeGpuNormalStopV1(input);
  if (parsedInput === null) throw new TypeError('Native normal GPU Stop input is invalid.');
  const result = parseNativeGpuNormalStopResultV1(
    await invoke('gpu_normal_stop', { input: parsedInput }),
  );
  if (result === null || result.podId !== parsedInput.podId) {
    throw new Error('Native normal GPU Stop returned an invalid strict result.');
  }
  return result;
}

export const nativeGpuPodPort: NativeGpuPodPort = Object.freeze({
  observe: nativeGpuPodObserve,
  loadNormalStop: nativeGpuNormalStopLoad,
  normalStop: nativeGpuNormalStop,
});
