import { describe, expect, it } from 'vitest';
import {
  appReducer,
  batchCounts,
  canStartBatch,
  createConfiguredInitialState,
  createDemoState,
  createInitialState,
  defaultDestinationForPlatform,
} from './reducer';
import type { AppState } from './types';

function readyDraft(promptCount: number): AppState {
  let state = createConfiguredInitialState();
  const text = Array.from({ length: promptCount }, (_, index) =>
    `Editorial documentary frame ${String(index + 1).padStart(3, '0')} with natural light and honest texture`,
  ).join('\n');
  state = appReducer(state, { type: 'SET_PROMPT_TEXT', text });
  state = appReducer(state, { type: 'SET_DESTINATION', path: '/tmp/imageforge-test' });
  state = appReducer(state, { type: 'SET_POD_PHASE', phase: 'ready', progress: 100, detail: 'Ready', podId: 'pod-test-1' });
  return state;
}

describe('appReducer', () => {
  it('does not mark a failed or ambiguous Pod start as complete', () => {
    const state = appReducer(createInitialState(), {
      type: 'RUNTIME_ERROR',
      scope: 'pod',
      retryable: false,
      message: 'RunPod may have created a Pod, but the result could not be confirmed.',
    });
    expect(state.pod.phase).toBe('error');
    expect(state.pod.phaseProgress).toBe(0);
    expect(state.pod.errorMessage).toContain('result could not be confirmed');
  });

  it('moves through the explicit Pod lifecycle and records the disposable Pod ID', () => {
    let state = createInitialState();
    state = appReducer(state, { type: 'START_POD' });
    expect(state.pod.phase).toBe('selecting');
    state = appReducer(state, { type: 'SET_POD_PHASE', phase: 'provisioning', progress: 23, detail: 'Creating one Pod' });
    expect(state.pod).toMatchObject({ phase: 'provisioning', health: 'checking', phaseProgress: 23 });
    state = appReducer(state, { type: 'SET_POD_PHASE', phase: 'ready', progress: 100, detail: 'Warm', podId: 'pod-if-next' });
    expect(state.pod).toMatchObject({ phase: 'ready', health: 'healthy', podId: 'pod-if-next', matchingPodIds: ['pod-if-next'] });

    state = appReducer(state, { type: 'REQUEST_STOP_POD' });
    expect(state.dialog).toEqual({ type: 'stop-pod', podId: 'pod-if-next' });
    state = appReducer(state, { type: 'CONFIRM_STOP_POD' });
    expect(state.pod.phase).toBe('stopping');
    state = appReducer(state, { type: 'POD_STOPPED' });
    expect(state.pod).toMatchObject({ phase: 'offline', gpu: null, podId: null });
  });

  it('refuses a stop confirmation when the authoritative Pod changed', () => {
    let state = readyDraft(1);
    state = appReducer(state, { type: 'REQUEST_STOP_POD' });
    state = appReducer(state, {
      type: 'SYNC_RUNTIME_POD',
      pod: { ...state.pod, podId: 'pod-replaced', phase: 'ready' },
    });
    const result = appReducer(state, { type: 'CONFIRM_STOP_POD' });
    expect(result.pod.phase).toBe('ready');
    expect(result.dialog).toBeNull();
    expect(result.toast?.title).toBe('Stop confirmation expired');
  });

  it('clears the bound stop target when the authoritative lifecycle reports the Pod gone', () => {
    let state = readyDraft(1);
    state = appReducer(state, { type: 'REQUEST_STOP_POD' });
    state = appReducer(state, { type: 'CONFIRM_STOP_POD' });
    state = appReducer(state, { type: 'SYNC_RUNTIME_POD', pod: { ...state.pod, phase: 'offline', podId: null, gpu: null, vram: null, hourlyRate: null } });
    expect(state.pod).toMatchObject({ phase: 'offline', podId: null, stopTargetPodId: null });
  });

  it('guards batch launch until prompts, destination, lock, and ready GPU agree', () => {
    let state = createInitialState();
    expect(canStartBatch(state)).toBe(false);
    state = readyDraft(3);
    expect(canStartBatch(state)).toBe(true);
    expect(canStartBatch({ ...state, setup: { ...state.setup, completed: false } })).toBe(false);
    state = appReducer(state, { type: 'START_BATCH', startedAt: '2026-08-01T10:00:00.000Z' });
    expect(state.batch?.phase).toBe('validating');
    expect(canStartBatch(state)).toBe(false);
  });

  it('stores the selected aspect ratio on the submitted batch', () => {
    let state = readyDraft(1);
    state = appReducer(state, { type: 'SET_ASPECT_RATIO', aspectRatio: '9:16' });
    expect(state.draft.aspectRatio).toBe('9:16');
    state = appReducer(state, { type: 'START_BATCH', startedAt: '2026-08-01T10:00:00.000Z' });
    expect(state.batch?.aspectRatio).toBe('9:16');
  });

  it('pauses without advancing, resumes, and keeps completed files on cancellation', () => {
    let state = readyDraft(4);
    state = appReducer(state, { type: 'START_BATCH', startedAt: '2026-08-01T10:00:00.000Z' });
    state = appReducer(state, { type: 'BATCH_VALIDATED' });
    state = appReducer(state, { type: 'TOGGLE_BATCH_PAUSE' });
    const paused = state;
    state = appReducer(state, { type: 'BATCH_TICK' });
    expect(state.batch?.prompts).toEqual(paused.batch?.prompts);
    state = appReducer(state, { type: 'TOGGLE_BATCH_PAUSE' });
    for (let tick = 0; tick < 3; tick += 1) state = appReducer(state, { type: 'BATCH_TICK' });
    expect(batchCounts(state.batch).completed).toBe(1);
    state = appReducer(state, { type: 'REQUEST_CANCEL_BATCH' });
    state = appReducer(state, { type: 'CONFIRM_CANCEL_BATCH' });
    expect(state.batch?.phase).toBe('cancelled');
    expect(state.library).toHaveLength(1);
  });

  it('marks every in-flight prompt cancelled while preserving verified downloads', () => {
    let state = readyDraft(5);
    state = appReducer(state, { type: 'START_BATCH', startedAt: '2026-08-01T10:00:00.000Z' });
    state = {
      ...state,
      batch: {
        ...state.batch!,
        prompts: state.batch!.prompts.map((prompt, index) => ({
          ...prompt,
          status: (['downloaded', 'generating', 'retrying', 'ready', 'downloading'][index] ?? 'pending') as typeof prompt.status,
        })),
      },
    };
    state = appReducer(state, { type: 'REQUEST_CANCEL_BATCH' });
    state = appReducer(state, { type: 'CONFIRM_CANCEL_BATCH' });
    expect(state.batch?.prompts.map((prompt) => prompt.status)).toEqual([
      'downloaded', 'cancelled', 'cancelled', 'cancelled', 'cancelled',
    ]);
  });

  it('completes a deterministic 450-prompt run in order and retries only failed slots', () => {
    let state = readyDraft(450);
    state = appReducer(state, { type: 'START_BATCH', startedAt: '2026-08-01T10:00:00.000Z' });
    state = appReducer(state, { type: 'BATCH_VALIDATED' });

    for (let tick = 0; tick < 1_600 && state.batch?.phase === 'running'; tick += 1) {
      state = appReducer(state, { type: 'BATCH_TICK' });
    }

    expect(state.batch?.phase).toBe('partial_failure');
    const firstPass = batchCounts(state.batch);
    expect(firstPass.completed + firstPass.failed).toBe(450);
    expect(firstPass.failed).toBeGreaterThan(0);
    const alreadyDownloaded = new Map(
      state.batch!.prompts
        .filter((prompt) => prompt.status === 'downloaded')
        .map((prompt) => [prompt.id, prompt.checksum]),
    );

    state = appReducer(state, { type: 'RETRY_FAILED' });
    for (let tick = 0; tick < 150 && state.batch?.phase === 'running'; tick += 1) {
      state = appReducer(state, { type: 'BATCH_TICK' });
    }

    expect(state.batch?.phase).toBe('complete');
    expect(batchCounts(state.batch)).toMatchObject({ completed: 450, failed: 0, progress: 100 });
    expect(state.batch!.prompts.map((prompt) => prompt.filename)).toEqual(
      Array.from({ length: 450 }, (_, index) => `${String(index + 1).padStart(4, '0')}.jpg`),
    );
    for (const prompt of state.batch!.prompts) {
      if (alreadyDownloaded.has(prompt.id)) expect(prompt.checksum).toBe(alreadyDownloaded.get(prompt.id));
      expect(prompt.checksum).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(state.library.map((asset) => asset.index)).toEqual(Array.from({ length: 450 }, (_, index) => index + 1));
  });

  it('authors ready and downloading receipts before download and automatically retries twice', () => {
    let state = readyDraft(19);
    state = appReducer(state, { type: 'START_BATCH', startedAt: '2026-08-01T10:00:00.000Z' });
    state = appReducer(state, { type: 'BATCH_VALIDATED' });

    state = appReducer(state, { type: 'BATCH_TICK' });
    expect(state.batch?.prompts[0]).toMatchObject({ status: 'ready', attempts: 1 });
    state = appReducer(state, { type: 'BATCH_TICK' });
    expect(state.batch?.prompts[0].status).toBe('downloading');
    state = appReducer(state, { type: 'BATCH_TICK' });
    expect(state.batch?.prompts[0].status).toBe('downloaded');
    expect(state.library[0].checksum).toMatch(/^[a-f0-9]{64}$/);

    for (let tick = 0; tick < 51; tick += 1) state = appReducer(state, { type: 'BATCH_TICK' });
    expect(state.batch?.prompts[18]).toMatchObject({ status: 'generating', attempts: 1 });
    state = appReducer(state, { type: 'BATCH_TICK' });
    expect(state.batch?.prompts[18]).toMatchObject({ status: 'retrying', attempts: 2 });
    state = appReducer(state, { type: 'BATCH_TICK' });
    expect(state.batch?.prompts[18]).toMatchObject({ status: 'retrying', attempts: 3 });
    state = appReducer(state, { type: 'BATCH_TICK' });
    expect(state.batch?.prompts[18]).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('resolves an interrupted owner batch only after a GPU restart', () => {
    let state = readyDraft(3);
    state = { ...state, settings: { ...state.settings, userName: 'Lakshman' } };
    state = appReducer(state, { type: 'START_BATCH', startedAt: '2026-08-01T10:00:00.000Z' });
    state = appReducer(state, { type: 'BATCH_VALIDATED' });
    state = appReducer(state, { type: 'REQUEST_STOP_POD' });
    state = appReducer(state, { type: 'CONFIRM_STOP_POD' });
    state = appReducer(state, { type: 'POD_STOPPED' });
    expect(state.batch).toMatchObject({ phase: 'interrupted', owner: 'Lakshman' });
    expect(state.batch?.prompts[0].status).toBe('pending');

    const offlineResume = appReducer(state, { type: 'RESUME_INTERRUPTED_BATCH' });
    expect(offlineResume.batch?.phase).toBe('interrupted');
    state = appReducer(state, { type: 'SET_POD_PHASE', phase: 'ready', progress: 100, detail: 'Ready', podId: 'pod-next' });
    state = appReducer(state, { type: 'RESUME_INTERRUPTED_BATCH' });
    expect(state.batch?.phase).toBe('running');
    expect(state.batch?.prompts[0].status).toBe('generating');
  });

  it('applies the visible editorial suffix and provides platform-correct defaults', () => {
    let state = readyDraft(1);
    state = appReducer(state, { type: 'START_BATCH', startedAt: '2026-08-01T10:00:00.000Z' });
    expect(state.batch?.prompts[0].text).toContain(state.settings.editorialSuffix);
    expect(defaultDestinationForPlatform('Mozilla/5.0 (Windows NT 10.0)')).toBe('C:\\Users\\Editor\\Pictures\\ImageForge');
    expect(defaultDestinationForPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X)')).toBe('/Users/Shared/Pictures/ImageForge');
  });

  it('uses an edited default suffix exactly, and omits it when disabled', () => {
    let state = readyDraft(1);
    state = appReducer(state, { type: 'SET_SETTING', key: 'editorialSuffix', value: 'cinematic tungsten, clean frame' });
    state = appReducer(state, { type: 'START_BATCH', startedAt: '2026-08-01T10:01:00.000Z' });
    expect(state.batch?.prompts[0].text).toBe('Editorial documentary frame 001 with natural light and honest texture cinematic tungsten, clean frame');

    state = readyDraft(1);
    state = appReducer(state, { type: 'SET_SETTING', key: 'editorialSuffixEnabled', value: false });
    state = appReducer(state, { type: 'START_BATCH', startedAt: '2026-08-01T10:02:00.000Z' });
    expect(state.batch?.prompts[0].text).toBe('Editorial documentary frame 001 with natural light and honest texture');
  });

  it('keeps batch-level references local until launch and preserves them on the batch', () => {
    let state = readyDraft(1);
    const reference = {
      id: 'reference-1',
      name: 'anchor.png',
      mimeType: 'image/png' as const,
      sizeBytes: 24,
      bytes: [0x89, 0x50, 0x4e, 0x47],
    };
    state = appReducer(state, { type: 'ADD_REFERENCE', reference });
    expect(state.draft.references).toEqual([reference]);
    state = appReducer(state, { type: 'START_BATCH', startedAt: '2026-08-01T10:00:00.000Z' });
    expect(state.batch?.references).toEqual([reference]);
    state = appReducer(state, { type: 'REMOVE_REFERENCE', id: reference.id });
    expect(state.draft.references).toHaveLength(0);
  });

  it('authors other-user lock, duplicate Pod, recovery, failure, and complete scenarios', () => {
    let state = createInitialState();
    state = appReducer(state, { type: 'PREVIEW_SCENARIO', scenario: 'locked' });
    expect(state.batch).toMatchObject({ phase: 'locked', owner: 'Sujal' });
    const locked = state;
    expect(appReducer(state, { type: 'TOGGLE_BATCH_PAUSE' }).batch).toEqual(locked.batch);

    state = appReducer(state, { type: 'PREVIEW_SCENARIO', scenario: 'duplicate_pods' });
    expect(state.pod.matchingPodIds).toHaveLength(2);
    expect(state.activeView).toBe('settings');
    state = appReducer(state, { type: 'PREVIEW_SCENARIO', scenario: 'reconnecting' });
    expect(state.pod.phase).toBe('reconnecting');
    state = appReducer(state, { type: 'PREVIEW_SCENARIO', scenario: 'partial_failure' });
    expect(batchCounts(state.batch).failed).toBe(2);
    state = appReducer(state, { type: 'PREVIEW_SCENARIO', scenario: 'complete' });
    expect(batchCounts(state.batch).progress).toBe(100);
  });

  it('applies authoritative runtime Pod, busy, owned batch, and lock-release events', () => {
    let state = createInitialState();
    state = appReducer(state, {
      type: 'SYNC_RUNTIME_POD',
      pod: {
        ...state.pod,
        phase: 'ready',
        phaseProgress: 100,
        statusDetail: 'Model warm',
        gpu: 'RTX 4090',
        vram: '24 GB',
        hourlyRate: 0.5,
        health: 'healthy',
        podId: 'verifiedpod1',
        matchingPodIds: ['verifiedpod1'],
      },
    });
    expect(state.pod).toMatchObject({ phase: 'ready', podId: 'verifiedpod1' });

    const lockedBatch = {
      id: 'busy-batch',
      name: 'Sujal’s active batch',
      owner: 'Sujal',
      phase: 'locked' as const,
      prompts: [],
      destination: 'Owner’s selected computer',
      startedAt: '2026-08-01T10:00:00.000Z',
      elapsedSeconds: 0,
      estimatedSecondsPerImage: 8.4,
      estimatedCost: 0,
      aspectRatio: '16:9' as const,
      lockMessage: '17 of 400 images are generated.',
      statusMessage: 'Sujal is generating 17 of 400',
      reportedProgress: { total: 400, completed: 17, failed: 0, cancelled: 0, currentIndex: 18 },
    };
    state = appReducer(state, { type: 'SYNC_RUNTIME_BUSY', batch: lockedBatch });
    expect(batchCounts(state.batch)).toMatchObject({ total: 400, completed: 17, pending: 383 });
    expect(state.activeView).toBe('progress');

    state = appReducer(state, { type: 'RUNTIME_BATCH_IDLE' });
    expect(state.batch).toBeNull();
    expect(state.activeView).toBe('create');
  });

  it('keeps durable work recoverable across transient worker errors and explicit Pod termination', () => {
    let state = createDemoState();
    state = appReducer(state, {
      type: 'RUNTIME_ERROR',
      scope: 'batch',
      message: 'Worker status temporarily unavailable.',
      retryable: true,
    });
    expect(state.pod).toMatchObject({ phase: 'reconnecting', health: 'degraded' });
    expect(state.batch?.phase).toBe('running');

    state = appReducer(state, { type: 'RUNTIME_BATCH_IDLE' });
    expect(state.pod).toMatchObject({ phase: 'ready', health: 'healthy' });

    state = createDemoState();
    state = appReducer(state, {
      type: 'SYNC_RUNTIME_POD',
      pod: {
        ...state.pod,
        phase: 'offline',
        phaseProgress: 0,
        statusDetail: 'GPU is safely offline',
        health: 'offline',
        podId: null,
        matchingPodIds: [],
      },
    });
    expect(state.batch?.phase).toBe('interrupted');
    expect(state.batch?.prompts.some((prompt) => prompt.status === 'generating')).toBe(false);
  });
});
