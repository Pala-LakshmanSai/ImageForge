import { invoke } from '@tauri-apps/api/core';
import { createConfiguredInitialState } from '../domain/reducer';
import type { AppState } from '../domain/types';
import type {
  ProductionRuntimeEvent,
  ProductionRuntimeFacade,
} from '../adapters/productionImageForgeAdapter';
import type {
  TwoClientSmokeCounters,
  TwoClientSmokeRole,
  TwoClientSmokeCheckpoint,
} from './twoClientSmokePort';

const FIRST_POD_ID = 'pod-native-smoke-a';
const SECOND_POD_ID = 'pod-native-smoke-b';

interface SmokeControls {
  counters: TwoClientSmokeCounters;
  checkpoint(name: TwoClientSmokeCheckpoint): Promise<unknown>;
  audit(): Promise<unknown>;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function lifecycleState(podId: string, phase: 'loading' | 'warming' | 'ready'): AppState {
  const state = createConfiguredInitialState();
  const progress = phase === 'loading' ? 61 : phase === 'warming' ? 82 : 100;
  state.pod = {
    ...state.pod,
    phase,
    phaseProgress: progress,
    statusDetail: phase === 'ready' ? 'Model warm' : `GPU ${phase}`,
    gpu: 'RTX 4090',
    vram: '24 GB',
    hourlyRate: 0.54,
    health: phase === 'ready' ? 'healthy' : 'checking',
    podId,
    matchingPodIds: [podId],
  };
  return state;
}

function readyState(podId: string): AppState {
  return lifecycleState(podId, 'ready');
}

function validatingState(podId: string): AppState {
  const state = readyState(podId);
  state.batch = {
    id: 'local-native-smoke',
    name: 'Two-client installed smoke',
    owner: 'Sujal',
    phase: 'validating',
    prompts: [{
      id: 'prompt-native-smoke',
      index: 1,
      sourceLine: 1,
      text: 'A deterministic ImageForge coordination probe',
      seed: 700,
      issues: [],
      status: 'pending',
      attempts: 0,
    }],
    destination: '/native-smoke',
    startedAt: '2026-08-03T10:00:00.000Z',
    elapsedSeconds: 0,
    estimatedSecondsPerImage: 8.4,
    estimatedCost: 0,
    aspectRatio: '16:9',
    lockMessage: null,
    statusMessage: 'Validating',
  };
  return state;
}

function lastEvent<T extends ProductionRuntimeEvent['type']>(
  events: readonly ProductionRuntimeEvent[],
  type: T,
): Extract<ProductionRuntimeEvent, { type: T }> | undefined {
  return [...events].reverse().find(
    (event): event is Extract<ProductionRuntimeEvent, { type: T }> => event.type === type,
  );
}


function auditResult(value: unknown): {
  passed: boolean;
  deletes: string[];
  unexpectedCreates: number;
  unexpectedDeletes: number;
  principals: string[];
} {
  invariant(typeof value === 'object' && value !== null && !Array.isArray(value), 'fixture audit was invalid');
  const candidate = value as Record<string, unknown>;
  invariant(candidate.passed === true, 'fixture audit did not pass');
  invariant(Array.isArray(candidate.deletes) && candidate.deletes.every((item) => typeof item === 'string'), 'fixture delete audit was invalid');
  invariant(Number.isSafeInteger(candidate.unexpectedCreates), 'fixture create audit was invalid');
  invariant(Number.isSafeInteger(candidate.unexpectedDeletes), 'fixture delete count was invalid');
  invariant(Array.isArray(candidate.principals) && candidate.principals.every((item) => typeof item === 'string'), 'fixture principal audit was invalid');
  return {
    passed: true,
    deletes: candidate.deletes as string[],
    unexpectedCreates: candidate.unexpectedCreates as number,
    unexpectedDeletes: candidate.unexpectedDeletes as number,
    principals: candidate.principals as string[],
  };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  invariant(predicate(), message);
}

async function waitForFreshWorkerEvent<T extends ProductionRuntimeEvent['type']>(
  runtime: ProductionRuntimeFacade,
  state: AppState,
  events: readonly ProductionRuntimeEvent[],
  eventOffset: number,
  type: T,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await runtime.pollBatch(state);
    if (events.slice(eventOffset).some((event) => event.type === type)) return;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  invariant(
    events.slice(eventOffset).some((event) => event.type === type),
    message,
  );
}

function renderedTextIncludes(...needles: string[]): boolean {
  const text = document.body.textContent ?? '';
  return needles.every((needle) => text.includes(needle));
}

function clickRenderedButton(label: string): void {
  const button = [...document.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === label);
  invariant(button instanceof HTMLButtonElement, `The ${label} button was not rendered`);
  button.click();
}

async function heartbeat(runtime: ProductionRuntimeFacade, podId: string): Promise<void> {
  await runtime.heartbeat(readyState(podId), 'foreground');
}

async function runRole(
  role: TwoClientSmokeRole,
  runtime: ProductionRuntimeFacade,
  controls: SmokeControls,
): Promise<string> {
  const events: ProductionRuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));

  await runtime.refresh(createConfiguredInitialState());
  let authoritative = runtime.getAuthoritativePodState?.();
  invariant(authoritative?.phase === 'loading', `${role} did not project the loading lifecycle`);
  invariant(authoritative.podId === FIRST_POD_ID, `${role} projected the wrong loading Pod`);
  await waitFor(
    () => renderedTextIncludes('Currently loading', 'GPU active · review status'),
    `${role} did not render the loading lifecycle`,
  );
  await controls.checkpoint('lifecycle_loading');

  await runtime.observe(lifecycleState(FIRST_POD_ID, 'loading'));
  authoritative = runtime.getAuthoritativePodState?.();
  invariant(authoritative?.phase === 'warming', `${role} did not project the warming lifecycle`);
  await waitFor(
    () => renderedTextIncludes('Currently warming', 'GPU active · review status'),
    `${role} did not render the warming lifecycle`,
  );
  await controls.checkpoint('lifecycle_warming');

  await runtime.observe(lifecycleState(FIRST_POD_ID, 'warming'));
  await runtime.pollBatch(readyState(FIRST_POD_ID));
  authoritative = runtime.getAuthoritativePodState?.();
  invariant(authoritative?.phase === 'ready', `${role} did not converge on Ready`);
  invariant(authoritative.podId === FIRST_POD_ID, `${role} projected the wrong first Pod`);
  if (role === 'A') {
    const batch = lastEvent(events, 'batch')?.batch;
    invariant(batch?.prompts.length === 450, 'A did not project its 450-image batch');
    invariant(
      batch.prompts.filter((prompt) => prompt.status === 'downloaded').length === 137
      && batch.prompts.find((prompt) => prompt.index === 138)?.status === 'generating',
      'A did not project exact 137/450 progress',
    );
    invariant(controls.counters.artifactDownloads === 137, 'A did not exercise streamed owner artifact downloads');
    await waitFor(
      () => renderedTextIncludes('GPU ready', 'Your batch is active'),
      'A did not render its active Ready batch',
    );
    clickRenderedButton('View progress');
    await waitFor(
      () => renderedTextIncludes('137 / 450', 'Creating image 138 of 450'),
      'A did not render exact owned progress',
    );
  } else {
    const batch = lastEvent(events, 'busy')?.batch;
    invariant(batch?.prompts.length === 0, 'B received private remote prompt rows');
    invariant(
      batch?.reportedProgress?.total === 450
      && batch.reportedProgress.completed === 137
      && batch.reportedProgress.currentIndex === 138,
      'B did not project exact 137/450 progress',
    );
    await waitFor(
      () => renderedTextIncludes(
        'Lakshman is running this batch',
        '137 / 450',
        'Prompt text stays private to Lakshman',
      ),
      'B did not render the remote locked Ready batch and exact progress',
    );
    invariant(controls.counters.artifactDownloads === 0, 'B downloaded private remote artifacts');
    await waitFor(
      () => controls.counters.readOnlyReceiptReads > 0,
      'B did not exercise the unavailable read-only stale receipt path',
    );
    invariant(controls.counters.mutatingReceiptReconciliations === 0, 'B mutated stale receipts before owner status');
    invariant(
      !renderedTextIncludes('GPU starting')
      && !renderedTextIncludes('Reconnecting to the GPU'),
      'B rendered a provisioning or reconnecting state over authoritative Ready/busy truth',
    );
  }
  await controls.checkpoint('startup');

  if (role === 'B') {
    await runtime.requestGpuStop(readyState(FIRST_POD_ID));
    invariant(lastEvent(events, 'stop-blocked')?.type === 'stop-blocked', 'active batch did not veto B Stop');
  }
  await controls.checkpoint('veto_done');
  const initialReleaseEventOffset = events.length;
  await controls.checkpoint('release_initial_batch');
  await waitForFreshWorkerEvent(
    runtime,
    readyState(FIRST_POD_ID),
    events,
    initialReleaseEventOffset,
    'idle',
    `${role} did not observe busy release`,
  );
  await controls.checkpoint('idle_after_release');

  await heartbeat(runtime, FIRST_POD_ID);
  if (role === 'A') {
    await runtime.requestGpuStop(readyState(FIRST_POD_ID));
    const outcome = events.at(-1);
    invariant(
      outcome?.type === 'stop-complete',
      `A direct Stop did not complete: ${JSON.stringify(outcome).slice(0, 160)}`,
    );
  }
  await controls.checkpoint('direct_stop_a');
  if (role === 'B') await runtime.observe(readyState(FIRST_POD_ID));
  invariant(runtime.getAuthoritativePodState?.()?.phase === 'offline', `${role} did not converge Offline after A Stop`);
  await controls.checkpoint('offline_a_to_b');

  await controls.checkpoint('reset_second_pod');
  await runtime.observe(createConfiguredInitialState());
  invariant(runtime.getAuthoritativePodState?.()?.podId === SECOND_POD_ID, `${role} did not discover the replacement Pod`);
  await heartbeat(runtime, SECOND_POD_ID);
  await controls.checkpoint('ready_second_pod');

  if (role === 'B') {
    await runtime.startBatch(validatingState(SECOND_POD_ID));
    invariant(lastEvent(events, 'batch')?.batch.owner === 'Sujal', 'B generation did not acquire the shared lease');
  }
  await controls.checkpoint('generation_started_b');

  // Stop no longer asks the other editor. The one guard that survives is a
  // batch that is actually generating, and it must refuse without destroying
  // anything.
  if (role === 'A') {
    await heartbeat(runtime, SECOND_POD_ID);
    await runtime.requestGpuStop(readyState(SECOND_POD_ID));
    invariant(lastEvent(events, 'stop-blocked')?.type === 'stop-blocked', 'B generation did not veto A Stop');
    invariant(runtime.getAuthoritativePodState?.()?.phase !== 'offline', 'A destroyed a generating Pod');
  }
  await controls.checkpoint('generation_veto_a');

  const generatedReleaseEventOffset = events.length;
  await controls.checkpoint('release_generated_batch');
  await waitForFreshWorkerEvent(
    runtime,
    readyState(SECOND_POD_ID),
    events,
    generatedReleaseEventOffset,
    'idle',
    `${role} did not observe generated-batch release`,
  );

  await heartbeat(runtime, SECOND_POD_ID);
  if (role === 'B') {
    await runtime.requestGpuStop(readyState(SECOND_POD_ID));
    const outcome = events.at(-1);
    invariant(
      outcome?.type === 'stop-complete',
      `B direct Stop did not complete: ${JSON.stringify(outcome).slice(0, 160)}`,
    );
  }
  await controls.checkpoint('direct_stop_b');
  if (role === 'A') await runtime.observe(readyState(SECOND_POD_ID));
  invariant(runtime.getAuthoritativePodState?.()?.phase === 'offline', `${role} did not converge Offline after B Stop`);
  await controls.checkpoint('offline_b_to_a');
  await controls.checkpoint('final');

  const audit = auditResult(await controls.audit());
  invariant(
    audit.deletes.length === 2
      && audit.deletes[0] === FIRST_POD_ID
      && audit.deletes[1] === SECOND_POD_ID,
    'fixture did not record the two exact guarded deletes',
  );
  invariant(audit.unexpectedCreates === 0 && audit.unexpectedDeletes === 0, 'fixture recorded an unexpected lifecycle mutation');
  invariant(audit.principals.includes('Lakshman') && audit.principals.includes('Sujal'), 'fixture did not observe both principals');
  invariant(controls.counters.mutatingReceiptReconciliations === 0, `${role} performed a forbidden receipt mutation`);

  return `${role}: two installed clients passed status-first recovery, shared busy/progress, the active-batch veto, and bidirectional direct Stop`;
}

export async function runTwoClientNativeSmoke(
  role: TwoClientSmokeRole,
  runtime: ProductionRuntimeFacade,
  controls: SmokeControls,
): Promise<void> {
  try {
    const detail = await runRole(role, runtime, controls);
    await invoke('native_smoke_result', { passed: true, detail: detail.slice(0, 240) });
  } catch (error) {
    // A rejected Tauri command surfaces as a plain payload rather than an
    // Error, and reporting that as a generic sentence hides the only useful
    // diagnostic the CI run will ever produce.
    const detail = error instanceof Error
      ? error.message
      : `non-Error failure: ${(() => {
        try {
          return JSON.stringify(error) ?? String(error);
        } catch {
          return String(error);
        }
      })()}`;
    await invoke('native_smoke_result', { passed: false, detail: `${role}: ${detail}`.slice(0, 240) });
  }
}
