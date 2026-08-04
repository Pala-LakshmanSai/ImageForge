import { invoke } from '@tauri-apps/api/core';
import { isGpuIdentityV1 } from '@imageforge/runpod-client';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POD_ID = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,56}[A-Za-z0-9])?$/;
const MAX_SAFE_REVISION = Number.MAX_SAFE_INTEGER;

export interface NativeAutoGpuStartV1 {
  readonly observationId: string;
  readonly receiptId: string;
  readonly sessionId: string;
  readonly expectedLifecycleRevision: number;
}

export interface NativeManualGpuStartV1 extends NativeAutoGpuStartV1 {
  readonly targetGpuId: string;
  readonly confirmedHourlyPriceMicroUsd: number;
}

export interface NativeManualGpuActualPriceV1 {
  readonly operationId: string;
  readonly expectedLifecycleRevision: number;
  readonly confirmedActualHourlyPriceMicroUsd: number;
}

export type NativeGpuStartIssueCodeV1 =
  | 'gpu_start_create_uncertain'
  | 'gpu_actual_price_changed'
  | 'gpu_actual_price_unavailable';

export interface NativeGpuStartIssueV1 {
  readonly code: NativeGpuStartIssueCodeV1;
  readonly retryable: false;
}

export interface NativeGpuStartPodV1 {
  readonly podId: string;
  readonly gpuId: string;
  readonly gpuDisplayName: string;
  readonly hourlyPriceMicroUsd: number | null;
}

export interface NativeGpuStartResultV1 {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly lifecycleRevision: number;
  readonly state: 'create_intent' | 'create_uncertain' | 'provisioning' | 'ready' | 'price_attention';
  readonly pod: NativeGpuStartPodV1 | null;
  readonly confirmedHourlyPriceMicroUsd: number;
  readonly actualHourlyPriceMicroUsd: number | null;
  readonly issue: NativeGpuStartIssueV1 | null;
}

export interface NativeGpuStartPort {
  load(): Promise<NativeGpuStartResultV1 | null>;
  startAuto(input: NativeAutoGpuStartV1): Promise<NativeGpuStartResultV1>;
  startSelected(input: NativeManualGpuStartV1): Promise<NativeGpuStartResultV1>;
  confirmActualPrice(input: NativeManualGpuActualPriceV1): Promise<NativeGpuStartResultV1>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

function isRevision(value: unknown, positive: boolean): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= (positive ? 1 : 0)
    && (value as number) <= MAX_SAFE_REVISION;
}

function isMicroUsd(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_SAFE_REVISION;
}

export function parseNativeAutoGpuStartV1(value: unknown): NativeAutoGpuStartV1 | null {
  if (!isRecord(value) || !exactKeys(value, [
    'observationId',
    'receiptId',
    'sessionId',
    'expectedLifecycleRevision',
  ])) return null;
  if (
    !isUuid(value.observationId)
    || !isUuid(value.receiptId)
    || !isUuid(value.sessionId)
    || !isRevision(value.expectedLifecycleRevision, false)
  ) return null;
  return Object.freeze({
    observationId: value.observationId,
    receiptId: value.receiptId,
    sessionId: value.sessionId,
    expectedLifecycleRevision: value.expectedLifecycleRevision as number,
  });
}

export function parseNativeManualGpuStartV1(value: unknown): NativeManualGpuStartV1 | null {
  if (!isRecord(value) || !exactKeys(value, [
    'observationId',
    'receiptId',
    'targetGpuId',
    'confirmedHourlyPriceMicroUsd',
    'sessionId',
    'expectedLifecycleRevision',
  ])) return null;
  const base = parseNativeAutoGpuStartV1({
    observationId: value.observationId,
    receiptId: value.receiptId,
    sessionId: value.sessionId,
    expectedLifecycleRevision: value.expectedLifecycleRevision,
  });
  if (base === null || !isGpuIdentityV1(value.targetGpuId) || !isMicroUsd(value.confirmedHourlyPriceMicroUsd)) {
    return null;
  }
  return Object.freeze({
    ...base,
    targetGpuId: value.targetGpuId,
    confirmedHourlyPriceMicroUsd: value.confirmedHourlyPriceMicroUsd as number,
  });
}

export function parseNativeManualGpuActualPriceV1(
  value: unknown,
): NativeManualGpuActualPriceV1 | null {
  if (!isRecord(value) || !exactKeys(value, [
    'operationId',
    'expectedLifecycleRevision',
    'confirmedActualHourlyPriceMicroUsd',
  ])) return null;
  if (
    !isUuid(value.operationId)
    || !isRevision(value.expectedLifecycleRevision, false)
    || !isMicroUsd(value.confirmedActualHourlyPriceMicroUsd)
  ) return null;
  return Object.freeze({
    operationId: value.operationId,
    expectedLifecycleRevision: value.expectedLifecycleRevision as number,
    confirmedActualHourlyPriceMicroUsd: value.confirmedActualHourlyPriceMicroUsd as number,
  });
}

function parsePod(value: unknown): NativeGpuStartPodV1 | null {
  if (!isRecord(value) || !exactKeys(value, [
    'podId',
    'gpuId',
    'gpuDisplayName',
    'hourlyPriceMicroUsd',
  ])) return null;
  if (
    typeof value.podId !== 'string'
    || !POD_ID.test(value.podId)
    || !isGpuIdentityV1(value.gpuId)
    || !isGpuIdentityV1(value.gpuDisplayName)
    || (value.hourlyPriceMicroUsd !== null && !isMicroUsd(value.hourlyPriceMicroUsd))
  ) return null;
  return Object.freeze({
    podId: value.podId,
    gpuId: value.gpuId,
    gpuDisplayName: value.gpuDisplayName,
    hourlyPriceMicroUsd: value.hourlyPriceMicroUsd as number | null,
  });
}

function parseIssue(value: unknown): NativeGpuStartIssueV1 | null {
  if (!isRecord(value) || !exactKeys(value, ['code', 'retryable']) || value.retryable !== false) {
    return null;
  }
  if (![
    'gpu_start_create_uncertain',
    'gpu_actual_price_changed',
    'gpu_actual_price_unavailable',
  ].includes(value.code as string)) return null;
  return Object.freeze({ code: value.code as NativeGpuStartIssueCodeV1, retryable: false });
}

export function parseNativeGpuStartResultV1(value: unknown): NativeGpuStartResultV1 | null {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion',
    'operationId',
    'lifecycleRevision',
    'state',
    'pod',
    'confirmedHourlyPriceMicroUsd',
    'actualHourlyPriceMicroUsd',
    'issue',
  ])) return null;
  if (
    value.schemaVersion !== 1
    || !isUuid(value.operationId)
    || !isRevision(value.lifecycleRevision, true)
    || !['create_intent', 'create_uncertain', 'provisioning', 'ready', 'price_attention'].includes(value.state as string)
    || !isMicroUsd(value.confirmedHourlyPriceMicroUsd)
    || (value.actualHourlyPriceMicroUsd !== null && !isMicroUsd(value.actualHourlyPriceMicroUsd))
  ) return null;
  const pod = value.pod === null ? null : parsePod(value.pod);
  if (value.pod !== null && pod === null) return null;
  const issue = value.issue === null ? null : parseIssue(value.issue);
  if (value.issue !== null && issue === null) return null;
  const state = value.state as NativeGpuStartResultV1['state'];
  const confirmed = value.confirmedHourlyPriceMicroUsd as number;
  const actual = value.actualHourlyPriceMicroUsd as number | null;
  if (
    (state === 'create_intent' && (pod !== null || actual !== null || issue !== null))
    || (state === 'create_uncertain' && (
      pod !== null || actual !== null || issue?.code !== 'gpu_start_create_uncertain'
    ))
    || (state === 'provisioning' && (
      pod === null
      || pod.hourlyPriceMicroUsd === null
      || actual === null
      || issue !== null
      || confirmed !== actual
      || pod.hourlyPriceMicroUsd !== actual
    ))
    || (state === 'ready' && (
      pod === null
      || pod.hourlyPriceMicroUsd === null
      || actual === null
      || issue !== null
      || confirmed !== actual
      || pod.hourlyPriceMicroUsd !== actual
    ))
    || (state === 'price_attention' && (
      pod === null
      || issue === null
      || (issue.code === 'gpu_actual_price_changed' && (
        actual === null
        || pod.hourlyPriceMicroUsd === null
        || pod.hourlyPriceMicroUsd !== actual
        || confirmed === actual
      ))
      || (issue.code === 'gpu_actual_price_unavailable' && (
        actual !== null || pod.hourlyPriceMicroUsd !== null
      ))
      || issue.code === 'gpu_start_create_uncertain'
    ))
  ) return null;
  return Object.freeze({
    schemaVersion: 1,
    operationId: value.operationId,
    lifecycleRevision: value.lifecycleRevision as number,
    state,
    pod,
    confirmedHourlyPriceMicroUsd: confirmed,
    actualHourlyPriceMicroUsd: actual,
    issue,
  });
}

function requireResult(value: unknown): NativeGpuStartResultV1 {
  const result = parseNativeGpuStartResultV1(value);
  if (result === null) throw new Error('Native GPU Start returned an invalid strict result.');
  return result;
}

export async function nativeGpuStartLoad(): Promise<NativeGpuStartResultV1 | null> {
  const value = await invoke('gpu_start_load');
  if (value === null) return null;
  return requireResult(value);
}

export async function nativeGpuStartAuto(
  input: NativeAutoGpuStartV1,
): Promise<NativeGpuStartResultV1> {
  const parsed = parseNativeAutoGpuStartV1(input);
  if (parsed === null) throw new TypeError('Native Auto GPU Start input is invalid.');
  return requireResult(await invoke('gpu_start_auto', { input: parsed }));
}

export async function nativeGpuStartSelected(
  input: NativeManualGpuStartV1,
): Promise<NativeGpuStartResultV1> {
  const parsed = parseNativeManualGpuStartV1(input);
  if (parsed === null) throw new TypeError('Native selected GPU Start input is invalid.');
  return requireResult(await invoke('gpu_start_selected', { input: parsed }));
}

export async function nativeGpuStartConfirmActualPrice(
  input: NativeManualGpuActualPriceV1,
): Promise<NativeGpuStartResultV1> {
  const parsed = parseNativeManualGpuActualPriceV1(input);
  if (parsed === null) throw new TypeError('Native GPU price confirmation input is invalid.');
  return requireResult(await invoke('gpu_start_confirm_actual_price', { input: parsed }));
}
