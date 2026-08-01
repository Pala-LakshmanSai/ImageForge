import { describe, expect, it } from 'vitest';
import { appReducer, batchCounts, canStartBatch, createInitialState } from './reducer';
import type { AppState } from './types';

function readyDraft(promptCount: number): AppState {
  let state = createInitialState();
  const text = Array.from({ length: promptCount }, (_, index) =>
    `Editorial documentary frame ${String(index + 1).padStart(3, '0')} with natural light and honest texture`,
  ).join('\n');
  state = appReducer(state, { type: 'SET_PROMPT_TEXT', text });
  state = appReducer(state, { type: 'SET_DESTINATION', path: '/tmp/imageforge-test' });
  state = appReducer(state, { type: 'SET_POD_PHASE', phase: 'ready', progress: 100, detail: 'Ready', podId: 'pod-test-1' });
  return state;
}

describe('appReducer', () => {
  it('moves through the explicit Pod lifecycle and records the disposable Pod ID', () => {
    let state = createInitialState();
    state = appReducer(state, { type: 'START_POD' });
    expect(state.pod.phase).toBe('selecting');
    state = appReducer(state, { type: 'SET_POD_PHASE', phase: 'provisioning', progress: 23, detail: 'Creating one Pod' });
    expect(state.pod).toMatchObject({ phase: 'provisioning', health: 'checking', phaseProgress: 23 });
    state = appReducer(state, { type: 'SET_POD_PHASE', phase: 'ready', progress: 100, detail: 'Warm', podId: 'pod-if-next' });
    expect(state.pod).toMatchObject({ phase: 'ready', health: 'healthy', podId: 'pod-if-next', matchingPodIds: ['pod-if-next'] });

    state = appReducer(state, { type: 'REQUEST_STOP_POD' });
    expect(state.dialog).toEqual({ type: 'stop-pod' });
    state = appReducer(state, { type: 'CONFIRM_STOP_POD' });
    expect(state.pod.phase).toBe('stopping');
    state = appReducer(state, { type: 'POD_STOPPED' });
    expect(state.pod).toMatchObject({ phase: 'offline', gpu: null, podId: null });
  });

  it('guards batch launch until prompts, destination, lock, and ready GPU agree', () => {
    let state = createInitialState();
    expect(canStartBatch(state)).toBe(false);
    state = readyDraft(3);
    expect(canStartBatch(state)).toBe(true);
    state = appReducer(state, { type: 'START_BATCH', startedAt: '2026-08-01T10:00:00.000Z' });
    expect(state.batch?.phase).toBe('validating');
    expect(canStartBatch(state)).toBe(false);
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
    state = appReducer(state, { type: 'BATCH_TICK' });
    expect(batchCounts(state.batch).completed).toBe(1);
    state = appReducer(state, { type: 'REQUEST_CANCEL_BATCH' });
    state = appReducer(state, { type: 'CONFIRM_CANCEL_BATCH' });
    expect(state.batch?.phase).toBe('cancelled');
    expect(state.library).toHaveLength(1);
  });

  it('completes a deterministic 450-prompt run in order and retries only failed slots', () => {
    let state = readyDraft(450);
    state = appReducer(state, { type: 'START_BATCH', startedAt: '2026-08-01T10:00:00.000Z' });
    state = appReducer(state, { type: 'BATCH_VALIDATED' });

    for (let tick = 0; tick < 460 && state.batch?.phase === 'running'; tick += 1) {
      state = appReducer(state, { type: 'BATCH_TICK' });
    }

    expect(state.batch?.phase).toBe('partial_failure');
    const firstPass = batchCounts(state.batch);
    expect(firstPass.completed + firstPass.failed).toBe(450);
    expect(firstPass.failed).toBeGreaterThan(0);
    const alreadyDownloaded = state.batch!.prompts.filter((prompt) => prompt.status === 'downloaded').map((prompt) => prompt.checksum);

    state = appReducer(state, { type: 'RETRY_FAILED' });
    for (let tick = 0; tick < 40 && state.batch?.phase === 'running'; tick += 1) {
      state = appReducer(state, { type: 'BATCH_TICK' });
    }

    expect(state.batch?.phase).toBe('complete');
    expect(batchCounts(state.batch)).toMatchObject({ completed: 450, failed: 0, progress: 100 });
    expect(state.batch!.prompts.map((prompt) => prompt.filename)).toEqual(
      Array.from({ length: 450 }, (_, index) => `${String(index + 1).padStart(4, '0')}.jpg`),
    );
    expect(state.batch!.prompts.filter((prompt) => prompt.attempts === 0).map((prompt) => prompt.checksum))
      .toEqual(alreadyDownloaded);
    expect(state.library.map((asset) => asset.index)).toEqual(Array.from({ length: 450 }, (_, index) => index + 1));
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
});
