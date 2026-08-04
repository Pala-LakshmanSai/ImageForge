import { invoke } from '@tauri-apps/api/core';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  createElement,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactElement,
} from 'react';
import { createFakeImageForgeAdapter } from '../adapters/imageForgeAdapter';
import { WebAudioQueueAlarm } from '../adapters/queueAlarm';
import { QueueRail } from '../components/QueueRail';
import {
  ACTIVE_PROMPT_VISIBLE_ROW_LIMIT,
  QUEUE_VISIBLE_ROW_LIMIT,
  createEmptyQueueSnapshot,
  moveQueueItem,
  parseNativeQueueSnapshot,
  updateQueueItem,
  updateQueueRun,
  type NativeQueueDocumentV1,
  type NativeQueueItemV1,
  type NativeQueueSnapshotV1,
} from '../domain/queue';
import { createConfiguredInitialState } from '../domain/reducer';
import type { AppAction, AppState, BatchPrompt } from '../domain/types';
import { ProgressScreen } from '../screens/ProgressScreen';
import {
  nativeQueueAcquireRunner,
  nativeQueueCommit,
  nativeQueueLoad,
  nativeQueuePrepareDispatch,
  nativeQueueReleaseRunner,
  nativeQueueReleaseSmokeExchange,
  parseQueueReleaseSmokeEvidence,
  queueReleaseSmokeP95,
  type NativeQueueReleaseSmokeInputV1,
  type NativeQueueReleaseSmokeResultV1,
  type QueueReleaseSmokeBatchEvidenceV1,
  type QueueReleaseSmokeEvidenceV1,
} from './tauriBridge';

const QUEUE_ROW_COUNT = 450;
const ACTIVE_PROMPT_COUNT = 450;
const KEYBOARD_SAMPLE_COUNT = 30;
const BATCH_COUNT = 3;
const SMOKE_BATCH_NAME = 'Queue release smoke batch 2';
const RESTART_OBSERVATION_MS = 1_000;

type QueueReleaseSmokePhase = 'run' | 'resume' | 'relaunch';

interface QueueReleaseSmokeUiFacts {
  alarmRole: 'alert';
  ringNowVisible: boolean;
  snoozeVisible: boolean;
  permissionDeniedFallbackVisible: boolean;
  trustedRingNowActivation: boolean;
  webAudioRingSucceeded: boolean;
  queueListSemantic: boolean;
  promptListSemantic: boolean;
  liveRegionPresent: boolean;
  focusedControlLabel: 'Ring now';
  viewports: QueueReleaseViewportObservation[];
}

interface QueueReleaseViewportObservation {
  width: number;
  height: number;
  horizontalOverflowPx: number;
  clippedAction: boolean;
  mountedQueueRows: number;
  mountedPromptRows: number;
}

/**
 * WebKit can report an NSEvent-backed DOM timestamp in epoch milliseconds,
 * while performance.now() is relative to performance.timeOrigin. Keep the
 * trusted-event requirement, but normalize either clock domain before timing
 * the next-paint response.
 */
export function normalizeTrustedEventTimestamp(
  timestamp: number,
  observedAt: number,
  timeOrigin: number,
): number | null {
  if (![timestamp, observedAt, timeOrigin].every(Number.isFinite)) return null;
  const candidates = [timestamp, timestamp - timeOrigin, timestamp + timeOrigin];
  const plausible = candidates.filter((candidate) => (
    candidate >= 0 && candidate <= observedAt + 100
  ));
  return plausible.length === 1 ? plausible[0]! : null;
}

type ExtendedSmokeInput =
  | { schemaVersion: 1; operation: 'phase' }
  | { schemaVersion: 1; operation: 'settle_batch'; ordinal: number; queueItemId: string; clientSubmissionId: string; remoteBatchId: string }
  | { schemaVersion: 1; operation: 'set_power'; runRevision: string; enabled: boolean }
  | { schemaVersion: 1; operation: 'checkpoint_restart'; runRevision: string; observedStoreRevision: number }
  | { schemaVersion: 1; operation: 'observe_restart'; runRevision: string; observedStoreRevision: number; observationMillis: number }
  | { schemaVersion: 1; operation: 'record_ui_facts'; facts: QueueReleaseSmokeUiFacts }
  | { schemaVersion: 1; operation: 'signal_permission_denied'; eventId: string }
  | { schemaVersion: 1; operation: 'finalize_relaunch'; observedStoreRevision: number; observationMillis: number };

type ExtendedSmokeResult =
  | { schemaVersion: 1; operation: 'phase'; phase: QueueReleaseSmokePhase }
  | { schemaVersion: 1; operation: 'settle_batch'; ordinal: number; receiptCount: number; artifactSha256: string }
  | { schemaVersion: 1; operation: 'set_power'; runRevision: string | null; active: boolean; platform: 'macos' | 'windows'; displaySleepAllowed: boolean }
  | { schemaVersion: 1; operation: 'checkpoint_restart'; written: true; artifactSha256: string }
  | { schemaVersion: 1; operation: 'observe_restart'; observed: true; phaseOnePid: number; artifactSha256: string }
  | { schemaVersion: 1; operation: 'record_ui_facts'; recorded: true }
  | { schemaVersion: 1; operation: 'signal_permission_denied'; eventId: string; notificationId: number; disposition: 'permission_denied' }
  | { schemaVersion: 1; operation: 'finalize_relaunch'; written: true; attestationSha256: string };

function uuid(index: number, variant: '8' | '9' | 'a' | 'b' = '8'): string {
  return `00000000-0000-4000-${variant}000-${index.toString(16).padStart(12, '0')}`;
}

function animationFrame(): Promise<number> {
  return new Promise((resolve) => window.requestAnimationFrame(resolve));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function waitFor<T>(read: () => T | null, description: string, timeoutMs = 15_000): Promise<T> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = read();
      if (value !== null) {
        resolve(value);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Queue release smoke timed out waiting for ${description}.`));
        return;
      }
      window.setTimeout(poll, 25);
    };
    poll();
  });
}

function stagedItems(destination: string, now: string): NativeQueueItemV1[] {
  return Array.from({ length: QUEUE_ROW_COUNT }, (_, index) => ({
    schemaVersion: 1,
    queueItemId: uuid(index + 1),
    clientSubmissionId: uuid(index + 2_000, '9'),
    recordRevision: 1,
    runRevision: null,
    remoteBatchId: null,
    state: 'staged',
    attentionCode: null,
    name: `Queue release smoke batch ${index + 1}`,
    prompts: [`A deterministic release-smoke image prompt ${index + 1}`],
    baseSeed: 700_000 + index,
    destination,
    aspectRatio: '16:9',
    styleSuffix: null,
    references: [],
    createdAt: now,
    updatedAt: now,
  }));
}

function activePrompts(): BatchPrompt[] {
  return Array.from({ length: ACTIVE_PROMPT_COUNT }, (_, index) => ({
    id: `queue-release-prompt-${index + 1}`,
    index: index + 1,
    sourceLine: index + 1,
    text: `Queue release active prompt ${index + 1}`,
    seed: 900_000 + index,
    issues: [],
    status: index === 0 ? 'generating' : 'pending',
    attempts: index === 0 ? 1 : 0,
  }));
}

const ACTIVE_PROMPTS = activePrompts();

function harnessState(snapshot: NativeQueueSnapshotV1): AppState {
  const state = createConfiguredInitialState();
  state.pod = {
    ...state.pod,
    phase: 'ready',
    phaseProgress: 100,
    statusDetail: 'Release smoke fake worker ready',
    gpu: 'Fake release GPU',
    vram: 'No paid GPU',
    hourlyRate: 0,
    health: 'healthy',
    podId: 'queue-release-smoke-pod',
  };
  state.queue = {
    ...state.queue,
    ...snapshot,
    loadState: 'ready',
    lease: snapshot.document.run !== null
      && snapshot.document.run.runnerState === 'running'
      && !snapshot.document.run.authorizationRequired
      ? { runRevision: snapshot.document.run.runRevision, held: true }
      : null,
    alarmTest: 'heard',
    notificationPermission: 'denied',
    keepAwakePreference: true,
  };
  state.batch = {
    id: uuid(8_800),
    name: '450-prompt release benchmark',
    owner: state.settings.userName,
    canManage: true,
    phase: 'running',
    prompts: ACTIVE_PROMPTS,
    destination: '/release-smoke-only',
    startedAt: '2026-08-03T00:00:00.000Z',
    elapsedSeconds: 0,
    estimatedSecondsPerImage: 1,
    estimatedCost: 0,
    lockMessage: null,
    statusMessage: 'Fake inference benchmark — no RunPod calls',
    aspectRatio: '16:9',
  };
  return state;
}

/** Small external store used only by the explicit installed-app smoke mode. */
export class QueueReleaseSmokeController {
  private snapshot = createEmptyQueueSnapshot();
  private readonly listeners = new Set<() => void>();
  private mounted = false;
  private readonly mountWaiters: Array<() => void> = [];
  private actionHandler: ((action: AppAction) => void) | null = null;

  getSnapshot = (): NativeQueueSnapshotV1 => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  publish(snapshot: NativeQueueSnapshotV1): void {
    this.snapshot = parseNativeQueueSnapshot(snapshot);
    this.listeners.forEach((listener) => listener());
  }

  markMounted(): void {
    this.mounted = true;
    this.mountWaiters.splice(0).forEach((resolve) => resolve());
  }

  waitUntilMounted(): Promise<void> {
    if (this.mounted) return Promise.resolve();
    return new Promise((resolve) => this.mountWaiters.push(resolve));
  }

  setActionHandler(handler: ((action: AppAction) => void) | null): void {
    this.actionHandler = handler;
  }

  dispatch = (action: AppAction): void => {
    if (action.type === 'MOVE_QUEUE_ITEM') {
      this.publish({
        ...this.snapshot,
        document: moveQueueItem(
          this.snapshot.document,
          action.queueItemId,
          action.direction,
        ),
      });
      return;
    }
    this.actionHandler?.(action);
  };
}

export function QueueReleaseSmokeHarness({
  controller,
}: {
  controller: QueueReleaseSmokeController;
}): ReactElement {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const state = useMemo(() => harnessState(snapshot), [snapshot]);
  const adapter = useMemo(() => createFakeImageForgeAdapter(), []);
  useEffect(() => controller.markMounted(), [controller]);

  return createElement(
    'main',
    {
      'data-queue-release-smoke': 'v1',
      style: { width: '100%', minWidth: 0 },
    },
    createElement(QueueRail, { state, dispatch: controller.dispatch }),
    createElement(ProgressScreen, { state, dispatch: controller.dispatch, adapter }),
  );
}

function exactResult<T extends NativeQueueReleaseSmokeResultV1['operation']>(
  result: NativeQueueReleaseSmokeResultV1,
  operation: T,
): Extract<NativeQueueReleaseSmokeResultV1, { operation: T }> {
  if (result.operation !== operation) {
    throw new Error(`The native queue release smoke returned ${result.operation} during ${operation}.`);
  }
  return result as Extract<NativeQueueReleaseSmokeResultV1, { operation: T }>;
}

function strictRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The native queue release smoke returned a non-object result.');
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('The native queue release smoke returned unexpected fields.');
  }
  return record;
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function lowerSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function parseExtendedSmokeResult(value: unknown): ExtendedSmokeResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The native queue release smoke result is invalid.');
  }
  const operation = (value as { operation?: unknown }).operation;
  if (operation === 'phase') {
    const record = strictRecord(value, ['schemaVersion', 'operation', 'phase']);
    if (record.schemaVersion !== 1 || !['run', 'resume', 'relaunch'].includes(String(record.phase))) throw new Error('The queue smoke phase is invalid.');
    return record as unknown as ExtendedSmokeResult;
  }
  if (operation === 'settle_batch') {
    const record = strictRecord(value, ['schemaVersion', 'operation', 'ordinal', 'receiptCount', 'artifactSha256']);
    if (record.schemaVersion !== 1 || !safeInteger(record.ordinal) || !safeInteger(record.receiptCount) || !lowerSha256(record.artifactSha256)) throw new Error('The queue smoke artifact result is invalid.');
    return record as unknown as ExtendedSmokeResult;
  }
  if (operation === 'set_power') {
    const record = strictRecord(value, ['schemaVersion', 'operation', 'runRevision', 'active', 'platform', 'displaySleepAllowed']);
    if (record.schemaVersion !== 1 || (record.runRevision !== null && typeof record.runRevision !== 'string') || typeof record.active !== 'boolean' || !['macos', 'windows'].includes(String(record.platform)) || record.displaySleepAllowed !== true) throw new Error('The queue smoke power result is invalid.');
    return record as unknown as ExtendedSmokeResult;
  }
  if (operation === 'checkpoint_restart') {
    const record = strictRecord(value, ['schemaVersion', 'operation', 'written', 'artifactSha256']);
    if (record.schemaVersion !== 1 || record.written !== true || !lowerSha256(record.artifactSha256)) throw new Error('The queue smoke restart checkpoint is invalid.');
    return record as unknown as ExtendedSmokeResult;
  }
  if (operation === 'observe_restart') {
    const record = strictRecord(value, ['schemaVersion', 'operation', 'observed', 'phaseOnePid', 'artifactSha256']);
    if (record.schemaVersion !== 1 || record.observed !== true || !safeInteger(record.phaseOnePid) || record.phaseOnePid < 1 || !lowerSha256(record.artifactSha256)) throw new Error('The queue smoke restart observation is invalid.');
    return record as unknown as ExtendedSmokeResult;
  }
  if (operation === 'record_ui_facts') {
    const record = strictRecord(value, ['schemaVersion', 'operation', 'recorded']);
    if (record.schemaVersion !== 1 || record.recorded !== true) throw new Error('The queue smoke UI attestation is invalid.');
    return record as unknown as ExtendedSmokeResult;
  }
  if (operation === 'signal_permission_denied') {
    const record = strictRecord(value, ['schemaVersion', 'operation', 'eventId', 'notificationId', 'disposition']);
    if (record.schemaVersion !== 1 || typeof record.eventId !== 'string' || !safeInteger(record.notificationId) || record.notificationId < 1 || record.disposition !== 'permission_denied') throw new Error('The queue smoke permission-denied result is invalid.');
    return record as unknown as ExtendedSmokeResult;
  }
  if (operation === 'finalize_relaunch') {
    const record = strictRecord(value, ['schemaVersion', 'operation', 'written', 'attestationSha256']);
    if (record.schemaVersion !== 1 || record.written !== true || !lowerSha256(record.attestationSha256)) throw new Error('The queue smoke relaunch attestation is invalid.');
    return record as unknown as ExtendedSmokeResult;
  }
  throw new Error('The native queue release smoke returned an unsupported operation.');
}

async function nativeExtendedExchange(input: ExtendedSmokeInput): Promise<ExtendedSmokeResult> {
  return parseExtendedSmokeResult(await invoke('native_queue_release_smoke_exchange', { input }));
}

function exactExtendedResult<T extends ExtendedSmokeResult['operation']>(
  result: ExtendedSmokeResult,
  operation: T,
): Extract<ExtendedSmokeResult, { operation: T }> {
  if (result.operation !== operation) throw new Error(`The native queue release smoke returned ${result.operation} during ${operation}.`);
  return result as Extract<ExtendedSmokeResult, { operation: T }>;
}

export interface QueueReleaseUiMeasurement {
  maxMountedQueueRows: number;
  maxMountedPromptRows: number;
  horizontalOverflowPx: number;
  viewportWidth: number;
  viewportHeight: number;
  keyboardSamplesMs: number[];
  trustedSampleCount: number;
}

async function trustedMoveSample(
  controller: QueueReleaseSmokeController,
  sampleIndex: number,
  exchange: (input: NativeQueueReleaseSmokeInputV1) => Promise<NativeQueueReleaseSmokeResultV1>,
): Promise<number> {
  const direction = sampleIndex % 2 === 1 ? 1 : -1;
  const directionLabel = direction === 1 ? 'down' : 'up';
  const item = controller.getSnapshot().document.items.find((row) => row.name === SMOKE_BATCH_NAME);
  if (item === undefined) throw new Error('The keyboard benchmark row is missing.');
  const beforeIndex = controller.getSnapshot().document.items.findIndex((row) => row.queueItemId === item.queueItemId);
  const target = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.getAttribute('aria-label') === `Move ${SMOKE_BATCH_NAME} ${directionLabel}`);
  if (!(target instanceof HTMLButtonElement) || target.disabled) {
    throw new Error(`The keyboard benchmark ${directionLabel} control is unavailable.`);
  }

  let cleanup = () => undefined;
  const sample = new Promise<number>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Trusted keyboard sample ${sampleIndex} timed out.`));
    }, 3_000);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.target !== target) return;
      window.removeEventListener('keydown', onKeyDown, true);
      if (!event.isTrusted) {
        window.clearTimeout(timeout);
        reject(new Error(`Keyboard sample ${sampleIndex} was not a trusted OS event.`));
        return;
      }
      const observedAt = performance.now();
      const startedAt = normalizeTrustedEventTimestamp(
        event.timeStamp,
        observedAt,
        performance.timeOrigin,
      );
      if (startedAt === null) {
        window.clearTimeout(timeout);
        reject(new Error(`Keyboard sample ${sampleIndex} had an invalid OS-event timestamp.`));
        return;
      }
      // The normalized DOM timestamp proves that the native event belongs to
      // the current monotonic window, but WebKit may deliver it after a
      // background/minimized interval. Measure input-to-next-paint from the
      // monotonic trusted-keydown receipt, never by subtracting clock domains.
      const keydownAt = performance.now();
      window.requestAnimationFrame(() => {
        window.clearTimeout(timeout);
        const afterIndex = controller.getSnapshot().document.items.findIndex((row) => row.queueItemId === item.queueItemId);
        if (afterIndex !== beforeIndex + direction) {
          reject(new Error(`Keyboard sample ${sampleIndex} did not move the focused queue row.`));
          return;
        }
        resolve(Number((performance.now() - keydownAt).toFixed(3)));
      });
    };
    cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener('keydown', onKeyDown, true);
    };
    window.addEventListener('keydown', onKeyDown, true);
  });

  target.focus();
  try {
    const result = await exchange({
      schemaVersion: 1,
      operation: 'dispatch_trusted_key',
      sampleIndex,
      key: 'Enter',
    });
    exactResult(result, 'dispatch_trusted_key');
    return await sample;
  } catch (error) {
    cleanup();
    void sample.catch(() => undefined);
    throw error;
  }
}

export async function measureQueueReleaseUi(
  controller: QueueReleaseSmokeController,
  exchange: (input: NativeQueueReleaseSmokeInputV1) => Promise<NativeQueueReleaseSmokeResultV1> = nativeQueueReleaseSmokeExchange,
): Promise<QueueReleaseUiMeasurement> {
  await controller.waitUntilMounted();
  await waitFor(
    () => document.querySelector('[aria-label="450 local queue batches"]'),
    'the 450-row device queue',
  );
  await waitFor(
    () => document.querySelector('[aria-label="450 prompts"]'),
    'the 450-prompt active batch',
  );
  await animationFrame();
  const mountedQueueRows = document.querySelectorAll('.queue-row').length;
  const mountedPromptRows = document.querySelectorAll('.prompt-row').length;
  if (mountedQueueRows < 1 || mountedQueueRows > QUEUE_VISIBLE_ROW_LIMIT) {
    throw new Error(`The queue mounted ${mountedQueueRows} rows; the cap is ${QUEUE_VISIBLE_ROW_LIMIT}.`);
  }
  if (mountedPromptRows < 1 || mountedPromptRows > ACTIVE_PROMPT_VISIBLE_ROW_LIMIT) {
    throw new Error(`The active batch mounted ${mountedPromptRows} prompts; the cap is ${ACTIVE_PROMPT_VISIBLE_ROW_LIMIT}.`);
  }
  const keyboardSamplesMs: number[] = [];
  for (let sampleIndex = 1; sampleIndex <= KEYBOARD_SAMPLE_COUNT; sampleIndex += 1) {
    keyboardSamplesMs.push(await trustedMoveSample(controller, sampleIndex, exchange));
  }
  const p95 = queueReleaseSmokeP95(keyboardSamplesMs);
  if (p95 >= 100) throw new Error(`Queue keyboard p95 was ${p95.toFixed(3)} ms; the release gate is below 100 ms.`);
  const rootWidth = document.documentElement.clientWidth || window.innerWidth;
  const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  return {
    maxMountedQueueRows: mountedQueueRows,
    maxMountedPromptRows: mountedPromptRows,
    horizontalOverflowPx: Math.max(0, scrollWidth - rootWidth),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    keyboardSamplesMs,
    trustedSampleCount: keyboardSamplesMs.length,
  };
}

async function measureCanonicalViewports(
  setSize: (size: LogicalSize) => Promise<void>,
  setFullscreen?: (fullscreen: boolean) => Promise<void>,
): Promise<QueueReleaseViewportObservation[]> {
  const observations: QueueReleaseViewportObservation[] = [];
  for (const [width, height] of [[1280, 720], [1440, 900], [1920, 1080]] as const) {
    // A 1920×1080 logical client can exceed the non-fullscreen work area on
    // CI Macs (the title/menu bars consume the remaining vertical pixels).
    // Use fullscreen only for this canonical target; the CSS client-size gate
    // below remains exact and still rejects any clamped viewport.
    if (setFullscreen !== undefined) await setFullscreen(height === 1080);
    await setSize(new LogicalSize(width, height));
    const measureExact = () => waitFor(() => {
      const measuredWidth = window.innerWidth;
      const measuredHeight = window.innerHeight;
      return Math.abs(measuredWidth - width) <= 1 && Math.abs(measuredHeight - height) <= 1
        ? { width: measuredWidth, height: measuredHeight }
        : null;
    }, `the ${width}×${height} canonical viewport`);
    let measured: { width: number; height: number } | undefined;
    try {
      measured = await measureExact();
    } catch (error) {
      const nativeWindow = getCurrentWindow();
      const [inner, outer] = await Promise.all([nativeWindow.innerSize(), nativeWindow.outerSize()]);
      // Tauri reports the native inner frame in physical pixels while WebKit's
      // CSS client excludes the titlebar/content offset. Derive only that
      // measured native-inner-to-CSS delta (in CSS pixels), then keep the exact
      // CSS gate below. Never infer a target from DOM outer dimensions (which
      // WKWebView reports as zero on macOS) or accept a substituted viewport.
      const nativeScale = await nativeWindow.scaleFactor();
      const scale = Number.isFinite(nativeScale) && nativeScale > 0 ? nativeScale : 1;
      const nativeInnerCssWidth = inner.width / scale;
      const nativeInnerCssHeight = inner.height / scale;
      const contentOffsetWidth = Math.round(nativeInnerCssWidth - window.innerWidth);
      const contentOffsetHeight = Math.round(nativeInnerCssHeight - window.innerHeight);
      const adjustedWidth = contentOffsetWidth > 0 && contentOffsetWidth < 200
        ? width + contentOffsetWidth
        : width;
      const adjustedHeight = contentOffsetHeight > 0 && contentOffsetHeight < 200
        ? height + contentOffsetHeight
        : height;
      await setSize(new LogicalSize(adjustedWidth, adjustedHeight));
      await animationFrame();
      try {
        measured = await measureExact();
      } catch (retryError) {
        error = retryError;
      }
      if (measured !== undefined) {
        // The measured inner viewport reached the exact target after the
        // native-inner delta retry above.
      } else {
        const [maximized, fullscreen] = await Promise.all([
          nativeWindow.isMaximized(),
          nativeWindow.isFullscreen(),
        ]);
        const detail = error instanceof Error ? error.message : `The ${width}×${height} canonical viewport was not reached.`;
        throw new Error(`${detail} (css inner ${window.innerWidth}×${window.innerHeight}; css outer ${window.outerWidth}×${window.outerHeight}; native inner ${inner.width}×${inner.height}; native outer ${outer.width}×${outer.height}; dpr ${window.devicePixelRatio}; maximized ${maximized}; fullscreen ${fullscreen})`);
      }
    }
    if (measured === undefined) {
      throw new Error(`The ${width}×${height} canonical viewport was not reached.`);
    }
    await animationFrame();
    const measuredWidth = measured.width;
    const measuredHeight = measured.height;
    const rootWidth = document.documentElement.clientWidth || measuredWidth;
    const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    const clippedAction = Array.from(document.querySelectorAll<HTMLElement>('.queue-rail button, .queue-alarm-card button'))
      .some((control) => {
        const bounds = control.getBoundingClientRect();
        return bounds.width > 0 && (bounds.left < -1 || bounds.right > measuredWidth + 1 || control.scrollWidth > control.clientWidth + 1);
      });
    observations.push({
      width,
      height,
      horizontalOverflowPx: Math.max(0, scrollWidth - rootWidth),
      clippedAction,
      mountedQueueRows: document.querySelectorAll('.queue-row').length,
      mountedPromptRows: document.querySelectorAll('.prompt-row').length,
    });
  }
  if (observations.some((value) => value.horizontalOverflowPx !== 0 || value.clippedAction)) {
    throw new Error('A canonical queue viewport overflowed or clipped an action.');
  }
  return observations;
}

function admitThreeBatchRun(
  document: NativeQueueDocumentV1,
  runRevision: string,
): NativeQueueDocumentV1 {
  const cohort = document.items.slice(0, BATCH_COUNT).map((row) => row.queueItemId);
  const cohortSet = new Set(cohort);
  return {
    schemaVersion: 1,
    items: document.items.map((row) => (
      cohortSet.has(row.queueItemId) && 'clientSubmissionId' in row
        ? { ...row, runRevision, recordRevision: row.recordRevision + 1 }
        : row
    )),
    run: {
      runRevision,
      cohortItemIds: cohort,
      runnerState: 'paused',
      authorizationRequired: true,
      keepAwake: true,
    },
    alarm: {
      eventId: `queue-complete:${runRevision}`,
      runRevision,
      state: 'armed',
      kind: null,
      snoozeUsed: false,
      snoozeDueAt: null,
      notificationDisposition: null,
      snoozeNotificationDisposition: null,
    },
  };
}

function snoozeDueAt(now: string): string {
  const parsed = new Date(now);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== now) {
    throw new Error('The queue release smoke clock is not canonical.');
  }
  return new Date(parsed.valueOf() + 15 * 60 * 1_000).toISOString();
}

export interface QueueReleaseSmokeRuntime {
  exchange(input: NativeQueueReleaseSmokeInputV1): Promise<NativeQueueReleaseSmokeResultV1>;
  phase(): Promise<QueueReleaseSmokePhase>;
  settleBatch(input: Extract<ExtendedSmokeInput, { operation: 'settle_batch' }>): Promise<Extract<ExtendedSmokeResult, { operation: 'settle_batch' }>>;
  setPower(input: Extract<ExtendedSmokeInput, { operation: 'set_power' }>): Promise<Extract<ExtendedSmokeResult, { operation: 'set_power' }>>;
  checkpointRestart(input: Extract<ExtendedSmokeInput, { operation: 'checkpoint_restart' }>): Promise<Extract<ExtendedSmokeResult, { operation: 'checkpoint_restart' }>>;
  observeRestart(input: Extract<ExtendedSmokeInput, { operation: 'observe_restart' }>): Promise<Extract<ExtendedSmokeResult, { operation: 'observe_restart' }>>;
  recordUiFacts(facts: QueueReleaseSmokeUiFacts): Promise<void>;
  signalPermissionDenied(eventId: string): Promise<Extract<ExtendedSmokeResult, { operation: 'signal_permission_denied' }>>;
  finalizeRelaunch(input: Extract<ExtendedSmokeInput, { operation: 'finalize_relaunch' }>): Promise<void>;
  load(): Promise<NativeQueueSnapshotV1>;
  commit(input: Parameters<typeof nativeQueueCommit>[0]): Promise<NativeQueueSnapshotV1>;
  prepareDispatch(input: Parameters<typeof nativeQueuePrepareDispatch>[0]): ReturnType<typeof nativeQueuePrepareDispatch>;
  acquireRunner(input: Parameters<typeof nativeQueueAcquireRunner>[0]): ReturnType<typeof nativeQueueAcquireRunner>;
  releaseRunner(input: Parameters<typeof nativeQueueReleaseRunner>[0]): ReturnType<typeof nativeQueueReleaseRunner>;
  measureUi(controller: QueueReleaseSmokeController): Promise<QueueReleaseUiMeasurement>;
  measureViewports(): Promise<QueueReleaseViewportObservation[]>;
  observeAlarmUi(controller: QueueReleaseSmokeController): Promise<QueueReleaseSmokeUiFacts>;
  minimize(): Promise<void>;
  isMinimized(): Promise<boolean>;
  restore(): Promise<void>;
  wait(milliseconds: number): Promise<void>;
  ringAudio(): Promise<void>;
  stopAudio(): void;
  disposeAudio(): void;
  now(): string;
  smokeId(): string;
}

function nativeRuntime(): QueueReleaseSmokeRuntime {
  const appWindow = getCurrentWindow();
  const alarm = new WebAudioQueueAlarm();
  const runtime: QueueReleaseSmokeRuntime = {
    exchange: nativeQueueReleaseSmokeExchange,
    phase: async () => exactExtendedResult(
      await nativeExtendedExchange({ schemaVersion: 1, operation: 'phase' }),
      'phase',
    ).phase,
    settleBatch: async (input) => exactExtendedResult(await nativeExtendedExchange(input), 'settle_batch'),
    setPower: async (input) => exactExtendedResult(await nativeExtendedExchange(input), 'set_power'),
    checkpointRestart: async (input) => exactExtendedResult(await nativeExtendedExchange(input), 'checkpoint_restart'),
    observeRestart: async (input) => exactExtendedResult(await nativeExtendedExchange(input), 'observe_restart'),
    recordUiFacts: async (facts) => {
      exactExtendedResult(await nativeExtendedExchange({ schemaVersion: 1, operation: 'record_ui_facts', facts }), 'record_ui_facts');
    },
    signalPermissionDenied: async (eventId) => exactExtendedResult(await nativeExtendedExchange({ schemaVersion: 1, operation: 'signal_permission_denied', eventId }), 'signal_permission_denied'),
    finalizeRelaunch: async (input) => {
      exactExtendedResult(await nativeExtendedExchange(input), 'finalize_relaunch');
    },
    load: nativeQueueLoad,
    commit: nativeQueueCommit,
    prepareDispatch: nativeQueuePrepareDispatch,
    acquireRunner: nativeQueueAcquireRunner,
    releaseRunner: nativeQueueReleaseRunner,
    measureUi: async (controller) => {
      await appWindow.unmaximize();
      await appWindow.show();
      await appWindow.setFocus();
      await appWindow.setSize(new LogicalSize(1440, 900));
      await delay(120);
      return measureQueueReleaseUi(controller);
    },
    measureViewports: async () => {
      await appWindow.unminimize();
      await appWindow.show();
      await appWindow.setFocus();
      await delay(120);
      await appWindow.unmaximize();
      await delay(120);
      return measureCanonicalViewports(
        (size) => appWindow.setSize(size),
        (fullscreen) => appWindow.setFullscreen(fullscreen),
      );
    },
    observeAlarmUi: (controller) => observeAlarmUiAndRing(controller, runtime),
    minimize: () => appWindow.minimize(),
    isMinimized: () => appWindow.isMinimized(),
    restore: async () => {
      await appWindow.unmaximize();
      await appWindow.unminimize();
      await appWindow.show();
      await appWindow.setFocus();
    },
    wait: delay,
    ringAudio: () => alarm.ring(),
    stopAudio: () => alarm.stop(),
    disposeAudio: () => alarm.dispose(),
    now: () => new Date().toISOString(),
    smokeId: () => crypto.randomUUID(),
  };
  return runtime;
}

async function commitDocument(
  runtime: QueueReleaseSmokeRuntime,
  snapshot: NativeQueueSnapshotV1,
  document: NativeQueueDocumentV1,
): Promise<NativeQueueSnapshotV1> {
  return runtime.commit({ expectedRevision: snapshot.storeRevision, document, referenceBlobs: [] });
}

async function settleQueueBatch(
  runtime: QueueReleaseSmokeRuntime,
  snapshot: NativeQueueSnapshotV1,
  ordinal: 1 | 2 | 3,
): Promise<{ snapshot: NativeQueueSnapshotV1; evidence: QueueReleaseSmokeBatchEvidenceV1 }> {
  const requireMinimized = async (boundary: string): Promise<void> => {
    if (!await runtime.isMinimized()) {
      throw new Error(`Batch ${ordinal} left minimized state at ${boundary}.`);
    }
  };
  const queueItemId = snapshot.document.run?.cohortItemIds[ordinal - 1];
  if (queueItemId === undefined) throw new Error(`Queue release batch ${ordinal} is missing from the cohort.`);
  const row = snapshot.document.items.find((item) => item.queueItemId === queueItemId);
  if (row === undefined || !('clientSubmissionId' in row)) throw new Error('The queue smoke cohort row is missing.');
  const prepared = await runtime.prepareDispatch({
    queueItemId,
    clientSubmissionId: row.clientSubmissionId,
    purpose: 'dispatch',
  });
  await requireMinimized('prepare_dispatch');
  if (prepared.queueItemId !== queueItemId || prepared.clientSubmissionId !== row.clientSubmissionId) {
    throw new Error('Native dispatch preflight returned the wrong staged batch.');
  }
  let next = await commitDocument(runtime, snapshot, updateQueueItem(
    snapshot.document,
    queueItemId,
    { state: 'dispatching', attentionCode: null, remoteBatchId: null },
    runtime.now(),
  ));
  await requireMinimized('dispatching_commit');
  const remoteBatchId = uuid(10_000 + ordinal, 'b');
  next = await commitDocument(runtime, next, updateQueueItem(
    next.document,
    queueItemId,
    { state: 'active', attentionCode: null, remoteBatchId },
    runtime.now(),
  ));
  await requireMinimized('active_commit');
  const settled = await runtime.settleBatch({
    schemaVersion: 1,
    operation: 'settle_batch',
    ordinal,
    queueItemId,
    clientSubmissionId: prepared.clientSubmissionId,
    remoteBatchId,
  });
  await requireMinimized('settle_batch');
  if (settled.ordinal !== ordinal || settled.receiptCount !== prepared.prompts.length || !lowerSha256(settled.artifactSha256)) {
    throw new Error(`Native artifact settlement for batch ${ordinal} was incomplete.`);
  }
  next = await commitDocument(runtime, next, updateQueueItem(
    next.document,
    queueItemId,
    { state: 'saving', attentionCode: null, remoteBatchId },
    runtime.now(),
  ));
  await requireMinimized('saving_commit');
  next = await commitDocument(runtime, next, updateQueueItem(
    next.document,
    queueItemId,
    { state: 'completed', attentionCode: null, remoteBatchId },
    runtime.now(),
  ));
  await requireMinimized('completed_commit');
  return {
    snapshot: next,
    evidence: {
      ordinal,
      queueItemId,
      clientSubmissionId: prepared.clientSubmissionId,
      remoteBatchId,
      promptCount: prepared.prompts.length,
      preparedWithNativeBridge: true,
      receiptCount: settled.receiptCount,
      receiptFixedPoint: true,
      terminalState: 'completed',
      minimizedAtCompletion: true,
    },
  };
}

function recoveredFirstBatchEvidence(snapshot: NativeQueueSnapshotV1): QueueReleaseSmokeBatchEvidenceV1 {
  const queueItemId = snapshot.document.run?.cohortItemIds[0];
  const row = queueItemId === undefined
    ? undefined
    : snapshot.document.items.find((item) => item.queueItemId === queueItemId);
  if (
    row === undefined
    || !('clientSubmissionId' in row)
    || row.state !== 'completed'
    || row.remoteBatchId !== uuid(10_001, 'b')
    || row.prompts.length < 1
  ) throw new Error('The first batch did not survive the installed-process restart at its receipt fixed point.');
  return {
    ordinal: 1,
    queueItemId: row.queueItemId,
    clientSubmissionId: row.clientSubmissionId,
    remoteBatchId: row.remoteBatchId,
    promptCount: row.prompts.length,
    preparedWithNativeBridge: true,
    receiptCount: row.prompts.length,
    receiptFixedPoint: true,
    terminalState: 'completed',
    minimizedAtCompletion: true,
  };
}

async function observeAlarmUiAndRing(
  controller: QueueReleaseSmokeController,
  runtime: QueueReleaseSmokeRuntime,
): Promise<QueueReleaseSmokeUiFacts> {
  await animationFrame();
  const ringNow = await waitFor(
    () => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Ring now') ?? null,
    'the Ring now fallback',
  );
  const snooze = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent?.includes('Snooze 15 min'));
  const alarmCard = document.querySelector<HTMLElement>('.queue-alarm-card[role="alert"]');
  if (snooze === undefined || alarmCard === null) throw new Error('The completion alarm actions were not rendered accessibly.');

  let trustedRingActivation = false;
  const onTrustedKey = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && event.target === ringNow && event.isTrusted) trustedRingActivation = true;
  };
  window.addEventListener('keydown', onTrustedKey, true);
  const ringCompleted = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Ring now did not start Web Audio.')), 3_000);
    controller.setActionHandler((action) => {
      if (action.type !== 'RING_QUEUE_ALARM') return;
      void runtime.ringAudio().then(() => {
        window.clearTimeout(timeout);
        resolve();
      }, (error: unknown) => {
        window.clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error('Web Audio ring failed.'));
      });
    });
  });
  ringNow.focus();
  try {
    exactResult(await runtime.exchange({
      schemaVersion: 1,
      operation: 'dispatch_trusted_key',
      sampleIndex: KEYBOARD_SAMPLE_COUNT,
      key: 'Enter',
    }), 'dispatch_trusted_key');
    await ringCompleted;
  } finally {
    window.removeEventListener('keydown', onTrustedKey, true);
    controller.setActionHandler(null);
  }
  if (!trustedRingActivation || document.activeElement !== ringNow) {
    throw new Error('Ring now was not activated by a focused trusted OS key event.');
  }
  const viewports = await runtime.measureViewports();
  const facts: QueueReleaseSmokeUiFacts = {
    alarmRole: 'alert',
    ringNowVisible: true,
    snoozeVisible: true,
    permissionDeniedFallbackVisible: document.body.textContent?.includes('In-app fallback stays visible') === true,
    trustedRingNowActivation: true,
    webAudioRingSucceeded: true,
    queueListSemantic: document.querySelector('ol[aria-label="450 local queue batches"]') !== null,
    promptListSemantic: document.querySelector('[aria-label="450 prompts"]') !== null,
    liveRegionPresent: document.querySelector('[role="status"]') !== null,
    focusedControlLabel: 'Ring now',
    viewports,
  };
  const failedFacts = Object.entries(facts)
    .filter(([, value]) => value === false)
    .map(([key]) => key);
  if (failedFacts.length > 0) {
    throw new Error(`The queue alarm fallback or semantic UI proof was incomplete: ${failedFacts.join(', ')}.`);
  }
  let snoozeActivated = false;
  controller.setActionHandler((action) => {
    if (action.type === 'SNOOZE_QUEUE_ALARM') snoozeActivated = true;
  });
  snooze.click();
  controller.setActionHandler(null);
  if (!snoozeActivated) throw new Error('The one-snooze UI action did not dispatch.');
  return facts;
}

/**
 * Installed-app Task 013 release gate. It uses the real native queue journal,
 * runner lease, dispatch preflight, and alert outbox. Inference is deliberately
 * deterministic and local; this flow has no production adapter and therefore
 * no RunPod start/stop surface.
 */
export async function runQueueReleaseSmoke(
  controller: QueueReleaseSmokeController,
  runtime: QueueReleaseSmokeRuntime = nativeRuntime(),
): Promise<QueueReleaseSmokeEvidenceV1 | null> {
  let heldRunRevision: string | null = null;
  let powerEnabled = false;
  try {
    const phase = await runtime.phase();
    if (phase === 'relaunch') {
      let snapshot = await runtime.load();
      controller.publish(snapshot);
      const observedRevision = snapshot.storeRevision;
      const observedDocument = JSON.stringify(snapshot.document);
      await runtime.wait(RESTART_OBSERVATION_MS);
      snapshot = await runtime.load();
      const run = snapshot.document.run;
      const alarm = snapshot.document.alarm;
      const cohort = new Set(run?.cohortItemIds ?? []);
      if (
        snapshot.storeRevision !== observedRevision
        || JSON.stringify(snapshot.document) !== observedDocument
        || run?.runnerState !== 'completed'
        || !run.authorizationRequired
        || !run.keepAwake
        || alarm?.state !== 'snoozed'
        || !alarm.snoozeUsed
        || alarm.snoozeDueAt === null
        || snapshot.document.items.filter((row) => cohort.has(row.queueItemId) && row.state === 'completed').length !== 3
        || snapshot.document.items.filter((row) => 'clientSubmissionId' in row && row.runRevision === null && row.state === 'staged').length !== 447
      ) throw new Error('The completed queue and one-snooze alarm did not survive the installed-app relaunch unchanged.');
      const audit = exactResult(await runtime.exchange({ schemaVersion: 1, operation: 'audit' }), 'audit');
      if (audit.runPodCreateCalls !== 0 || audit.runPodDeleteCalls !== 0) {
        throw new Error('The alarm relaunch attempted a forbidden RunPod mutation.');
      }
      await runtime.finalizeRelaunch({
        schemaVersion: 1,
        operation: 'finalize_relaunch',
        observedStoreRevision: observedRevision,
        observationMillis: RESTART_OBSERVATION_MS,
      });
      return null;
    }

    const bootstrap = exactResult(
      await runtime.exchange({ schemaVersion: 1, operation: 'bootstrap' }),
      'bootstrap',
    );
    let snapshot = await runtime.load();
    const runRevision = uuid(9_500, 'a');

    if (phase === 'run') {
      if (snapshot.storeRevision !== 0 || snapshot.document.items.length !== 0 || snapshot.document.run !== null) {
        throw new Error('The queue release smoke requires an isolated, empty native queue store.');
      }
      snapshot = await commitDocument(runtime, snapshot, {
        schemaVersion: 1,
        items: stagedItems(bootstrap.destination, runtime.now()),
        run: null,
        alarm: null,
      });
      snapshot = await commitDocument(runtime, snapshot, admitThreeBatchRun(snapshot.document, runRevision));
      await runtime.acquireRunner({ runRevision });
      heldRunRevision = runRevision;
      snapshot = await commitDocument(runtime, snapshot, updateQueueRun(snapshot.document, {
        runnerState: 'running',
        authorizationRequired: false,
      }));
      const power = await runtime.setPower({ schemaVersion: 1, operation: 'set_power', runRevision, enabled: true });
      if (!power.active || power.runRevision !== runRevision || !power.displaySleepAllowed) throw new Error('Native keep-awake did not acquire for the running queue.');
      powerEnabled = true;
      controller.publish(snapshot);
      await runtime.minimize();
      await runtime.wait(100);
      if (!await runtime.isMinimized()) throw new Error('The installed window did not enter the minimized state.');
      const first = await settleQueueBatch(runtime, snapshot, 1);
      snapshot = first.snapshot;
      controller.publish(snapshot);
      if (!await runtime.isMinimized()) throw new Error('Batch 1 completed after the window left minimized state.');
      await runtime.checkpointRestart({
        schemaVersion: 1,
        operation: 'checkpoint_restart',
        runRevision,
        observedStoreRevision: snapshot.storeRevision,
      });
      // The workflow now terminates this installed process. Deliberately keep
      // the lease and power assertion live so process-exit cleanup and native
      // startup pause are exercised instead of simulated in the renderer.
      return null;
    }

    if (
      snapshot.document.run?.runRevision !== runRevision
      || snapshot.document.run.runnerState !== 'paused'
      || !snapshot.document.run.authorizationRequired
      || !snapshot.document.run.keepAwake
    ) throw new Error('Relaunch did not force the interrupted queue to paused and authorization-required.');
    controller.publish(snapshot);
    const pausedRevision = snapshot.storeRevision;
    const pausedDocument = JSON.stringify(snapshot.document);
    await runtime.wait(RESTART_OBSERVATION_MS);
    snapshot = await runtime.load();
    if (snapshot.storeRevision !== pausedRevision || JSON.stringify(snapshot.document) !== pausedDocument) {
      throw new Error('The relaunched queue dispatched or mutated before explicit resume authorization.');
    }
    await runtime.observeRestart({
      schemaVersion: 1,
      operation: 'observe_restart',
      runRevision,
      observedStoreRevision: pausedRevision,
      observationMillis: RESTART_OBSERVATION_MS,
    });
    let audit = exactResult(await runtime.exchange({ schemaVersion: 1, operation: 'audit' }), 'audit');
    if (audit.runPodCreateCalls !== 0 || audit.runPodDeleteCalls !== 0) throw new Error('The paused restart mutated RunPod.');

    await runtime.acquireRunner({ runRevision });
    heldRunRevision = runRevision;
    snapshot = await commitDocument(runtime, snapshot, updateQueueRun(snapshot.document, {
      runnerState: 'running',
      authorizationRequired: false,
    }));
    const power = await runtime.setPower({ schemaVersion: 1, operation: 'set_power', runRevision, enabled: true });
    if (!power.active || power.runRevision !== runRevision || !power.displaySleepAllowed) throw new Error('Native keep-awake did not reacquire after Resume queue.');
    powerEnabled = true;
    controller.publish(snapshot);
    // The interrupted run deliberately leaves the process minimized. Restore
    // it before the trusted-key benchmark; `show()` alone does not unminimize
    // an already minimized macOS window.
    await runtime.restore();
    const ui = await runtime.measureUi(controller);
    if (ui.horizontalOverflowPx !== 0) {
      throw new Error(`The queue release smoke overflowed horizontally by ${ui.horizontalOverflowPx}px.`);
    }
    // Restore the authoritative native order after the renderer-only keyboard
    // benchmark before dispatching the successor.
    controller.publish(snapshot);
    await runtime.minimize();
    await runtime.wait(100);
    if (!await runtime.isMinimized()) throw new Error('The resumed installed window did not enter the minimized state.');

    const batches: QueueReleaseSmokeBatchEvidenceV1[] = [recoveredFirstBatchEvidence(snapshot)];
    for (const ordinal of [2, 3] as const) {
      const settled = await settleQueueBatch(runtime, snapshot, ordinal);
      snapshot = settled.snapshot;
      controller.publish(snapshot);
      if (!await runtime.isMinimized()) throw new Error(`Batch ${ordinal} completed after the window left minimized state.`);
      batches.push(settled.evidence);
    }

    const eventId = `queue-complete:${runRevision}`;
    snapshot = await commitDocument(runtime, snapshot, {
      ...updateQueueRun(snapshot.document, {
        runnerState: 'completed',
        authorizationRequired: true,
      }),
      alarm: {
        ...snapshot.document.alarm!,
        state: 'ringing',
        kind: 'complete',
        notificationDisposition: 'pending',
      },
    });
    const alert = await runtime.signalPermissionDenied(eventId);
    const storedDisposition = alert.disposition;
    snapshot = await commitDocument(runtime, snapshot, {
      ...snapshot.document,
      alarm: { ...snapshot.document.alarm!, notificationDisposition: storedDisposition },
    });
    controller.publish(snapshot);
    await runtime.restore();
    const uiFacts = await runtime.observeAlarmUi(controller);
    await runtime.recordUiFacts(uiFacts);
    runtime.stopAudio();
    const dueAt = snoozeDueAt(runtime.now());
    snapshot = await commitDocument(runtime, snapshot, {
      ...snapshot.document,
      alarm: {
        ...snapshot.document.alarm!,
        state: 'snoozed',
        snoozeUsed: true,
        snoozeDueAt: dueAt,
        snoozeNotificationDisposition: null,
      },
    });
    controller.publish(snapshot);
    const releasedPower = await runtime.setPower({ schemaVersion: 1, operation: 'set_power', runRevision, enabled: false });
    if (releasedPower.active || releasedPower.runRevision !== null || !releasedPower.displaySleepAllowed) throw new Error('Native keep-awake did not release at the completion fixed point.');
    powerEnabled = false;
    await runtime.releaseRunner({ runRevision });
    heldRunRevision = null;
    runtime.disposeAudio();

    audit = exactResult(await runtime.exchange({ schemaVersion: 1, operation: 'audit' }), 'audit');
    if (audit.runPodCreateCalls !== 0 || audit.runPodDeleteCalls !== 0) {
      throw new Error('The queue release smoke observed a forbidden RunPod create or delete.');
    }

    const evidence = parseQueueReleaseSmokeEvidence({
      schemaVersion: 1,
      smokeId: runtime.smokeId(),
      platform: bootstrap.platform,
      architecture: bootstrap.architecture,
      appVersion: bootstrap.appVersion,
      completedAt: runtime.now(),
      viewport: {
        width: ui.viewportWidth,
        height: ui.viewportHeight,
        horizontalOverflowPx: ui.horizontalOverflowPx,
      },
      queue: {
        requestedRows: QUEUE_ROW_COUNT,
        maxMountedRows: ui.maxMountedQueueRows,
        visibleRowLimit: QUEUE_VISIBLE_ROW_LIMIT,
        realNativeBridge: true,
        runRevision,
        runnerLeaseReleased: true,
        batches,
      },
      prompts: {
        requestedRows: ACTIVE_PROMPT_COUNT,
        maxMountedRows: ui.maxMountedPromptRows,
        visibleRowLimit: ACTIVE_PROMPT_VISIBLE_ROW_LIMIT,
      },
      keyboard: {
        sampleCount: KEYBOARD_SAMPLE_COUNT,
        trustedSampleCount: ui.trustedSampleCount,
        key: 'Enter',
        operation: 'move',
        samplesMs: ui.keyboardSamplesMs,
        p95Ms: queueReleaseSmokeP95(ui.keyboardSamplesMs),
      },
      minimized: { observed: true, sequentialBatches: BATCH_COUNT },
      alarm: {
        eventId,
        signalCalls: 1,
        uniqueEvents: 1,
        fixedPoint: true,
        disposition: alert.disposition,
      },
      runPod: { createCalls: audit.runPodCreateCalls, deleteCalls: audit.runPodDeleteCalls },
    });
    exactResult(
      await runtime.exchange({ schemaVersion: 1, operation: 'write_evidence', evidence }),
      'write_evidence',
    );
    return evidence;
  } catch (error) {
    runtime.stopAudio();
    runtime.disposeAudio();
    if (powerEnabled && heldRunRevision !== null) {
      await runtime.setPower({
        schemaVersion: 1,
        operation: 'set_power',
        runRevision: heldRunRevision,
        enabled: false,
      }).catch(() => undefined);
      powerEnabled = false;
    }
    if (heldRunRevision !== null) {
      await runtime.releaseRunner({ runRevision: heldRunRevision }).catch(() => undefined);
    }
    await runtime.restore().catch(() => undefined);
    const detail = (() => {
      if (error instanceof Error) return error.message;
      if (typeof error === 'string') return error;
      if (typeof error === 'object' && error !== null) {
        const candidate = error as { message?: unknown; error?: unknown };
        if (typeof candidate.message === 'string') return candidate.message;
        if (typeof candidate.error === 'string') return candidate.error;
        try {
          const encoded = JSON.stringify(error);
          if (encoded && encoded !== '{}') return encoded;
        } catch {
          // Fall through to the safe fixed message below.
        }
      }
      return 'Queue release smoke failed.';
    })()
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
      .slice(0, 240);
    await runtime.exchange({ schemaVersion: 1, operation: 'write_failure', detail }).catch(() => undefined);
    return null;
  }
}
