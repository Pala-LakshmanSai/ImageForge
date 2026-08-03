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
import type { AppState, BatchState, LibraryAsset } from './types';

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

  it('leaves the optional style instruction off by default and provides platform-correct destinations', () => {
    let state = readyDraft(1);
    const prompt = state.draft.prompts[0].text;
    expect(state.settings.editorialSuffixEnabled).toBe(false);
    state = appReducer(state, { type: 'START_BATCH', startedAt: '2026-08-01T10:00:00.000Z' });
    expect(state.batch?.prompts[0].text).toBe(prompt);
    expect(defaultDestinationForPlatform('Mozilla/5.0 (Windows NT 10.0)')).toBe('C:\\Users\\Editor\\Pictures\\ImageForge');
    expect(defaultDestinationForPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X)')).toBe('/Users/Shared/Pictures/ImageForge');
  });

  it('uses an edited default suffix exactly, and omits it when disabled', () => {
    let state = readyDraft(1);
    state = appReducer(state, { type: 'SET_SETTING', key: 'editorialSuffix', value: 'cinematic tungsten, clean frame' });
    state = appReducer(state, { type: 'SET_SETTING', key: 'editorialSuffixEnabled', value: true });
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
    expect(state.batch).toMatchObject({ phase: 'locked', owner: 'Sujal', canManage: false });
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

  it('restores local Library assets without inventing a terminal batch', () => {
    const recovered = {
      id: '11111111-1111-4111-8111-111111111111-1',
      batchId: '11111111-1111-4111-8111-111111111111',
      batchName: 'Atlas of Quiet Work',
      index: 1,
      prompt: 'Saved image 001',
      seed: 1,
      filename: 'batches/Atlas of Quiet Work/000001.jpg',
      checksum: 'a'.repeat(64),
      createdAt: '2026-08-02T12:00:00.000Z',
      durationSeconds: 0,
      destination: '/safe',
      palette: 1,
      recovered: true,
    };
    const state = appReducer(createConfiguredInitialState(), {
      type: 'SYNC_RUNTIME_LIBRARY',
      assets: [recovered],
    });

    expect(state.batch).toBeNull();
    expect(state.library).toEqual([recovered]);
  });

  it('merges 450 successive durable receipt projections without duplicates or order drift', () => {
    const batch: BatchState = {
      id: 'large-batch',
      name: 'Large batch',
      owner: 'Lakshman',
      canManage: true,
      phase: 'running',
      prompts: [],
      destination: '/safe',
      startedAt: '2026-08-03T06:00:00.000Z',
      elapsedSeconds: 0,
      estimatedSecondsPerImage: 8.4,
      estimatedCost: 0,
      lockMessage: null,
      statusMessage: 'Saving images',
      aspectRatio: '16:9',
    };
    const assets: LibraryAsset[] = Array.from({ length: 450 }, (_, offset) => ({
      id: `large-batch-${offset + 1}`,
      batchId: batch.id,
      batchName: batch.name,
      index: offset + 1,
      prompt: `Prompt ${offset + 1}`,
      seed: 700 + offset,
      filename: `batches/Large batch/${String(offset + 1).padStart(6, '0')}.jpg`,
      checksum: (offset + 1).toString(16).padStart(64, '0'),
      createdAt: batch.startedAt,
      durationSeconds: 8,
      destination: batch.destination,
      palette: offset % 6,
    }));
    let state = createConfiguredInitialState();
    for (let count = 1; count <= assets.length; count += 1) {
      state = appReducer(state, {
        type: 'SYNC_RUNTIME_BATCH',
        batch,
        assets: assets.slice(0, count),
      });
    }

    expect(state.library).toHaveLength(450);
    expect(state.library.map((asset) => asset.index)).toEqual(
      Array.from({ length: 450 }, (_, index) => index + 1),
    );
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

  it('keeps Ready and remote busy truth when device-local receipt recovery fails', () => {
    let state = readyDraft(1);
    const lockedBatch: BatchState = {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Sujal’s active batch',
      owner: 'Sujal',
      canManage: false,
      phase: 'locked',
      prompts: [],
      destination: 'Sujal’s computer',
      startedAt: '2026-08-03T09:00:00.000Z',
      elapsedSeconds: 42,
      estimatedSecondsPerImage: 8.4,
      estimatedCost: 0,
      lockMessage: '73 of 450 images are complete.',
      statusMessage: 'Sujal is generating image 074 of 450',
      aspectRatio: '16:9',
      reportedProgress: { total: 450, completed: 73, failed: 0, cancelled: 0, currentIndex: 74 },
    };
    state = appReducer(state, { type: 'SYNC_RUNTIME_BUSY', batch: lockedBatch });
    state = appReducer(state, {
      type: 'RUNTIME_LOCAL_ERROR',
      batchId: '11111111-1111-4111-8111-111111111111',
      code: 'destination_unavailable',
      message: 'Choose a writable Windows folder.',
      retryable: true,
    });

    expect(state.pod.phase).toBe('ready');
    expect(state.batch).toEqual(lockedBatch);
    expect(state.localSyncIssue).toMatchObject({ code: 'destination_unavailable' });
  });

  it('moves a remote locked batch to truthful unmanageable interruption when RunPod proves Offline', () => {
    let state = appReducer(createConfiguredInitialState(), { type: 'PREVIEW_SCENARIO', scenario: 'locked' });
    const completed = batchCounts(state.batch).completed;
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

    expect(state.batch).toMatchObject({
      phase: 'interrupted',
      canManage: false,
      remoteState: 'interrupted',
    });
    expect(state.batch?.statusMessage).toContain('offline');
    expect(batchCounts(state.batch).completed).toBe(completed);
  });

  it('settles an in-flight coordinated stop when authoritative RunPod truth proves its exact Pod offline', () => {
    let state = readyDraft(1);
    state.studio.stop = {
      ...state.studio.stop,
      phase: 'pending',
      requestId: '44444444-4444-4444-8444-444444444444',
      podId: 'pod-test-1',
      gpuDisplayName: 'RTX 4090',
      isRequester: true,
    };

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

    expect(state.studio.stop).toMatchObject({
      phase: 'stopped',
      podId: 'pod-test-1',
      finalizationId: null,
      finalizationExpiresAt: null,
      retryable: false,
    });

    state = appReducer(state, {
      type: 'SYNC_STUDIO_STATE',
      studio: {
        ...state.studio,
        stop: {
          ...state.studio.stop,
          phase: 'finalizing',
          finalizationId: '55555555-5555-4555-8555-555555555555',
          finalizationExpiresAt: '2026-08-01T10:01:00.000Z',
        },
      },
    });
    expect(state.studio.stop.phase).toBe('stopped');
  });

  it('blocks Generate for an adopted worker finalization guard and releases it only on idle admission truth', () => {
    let state = readyDraft(1);
    expect(canStartBatch(state)).toBe(true);

    state = appReducer(state, {
      type: 'RUNTIME_STOP_GUARD_ACTIVE',
      podId: 'pod-test-1',
      message: 'GPU Stop is finalizing; new generation is temporarily blocked.',
    });
    expect(state.studio.stop).toMatchObject({
      phase: 'finalizing',
      podId: 'pod-test-1',
      reason: 'worker_finalization_guard',
    });
    expect(canStartBatch(state)).toBe(false);

    state = appReducer(state, { type: 'RUNTIME_BATCH_IDLE' });
    expect(state.studio.stop.phase).toBe('idle');
    expect(canStartBatch(state)).toBe(true);
  });

  it('allows generation during approval but blocks it only while the deletion guard is finalizing', () => {
    const ready = readyDraft(1);
    const pending = appReducer(ready, {
      type: 'SYNC_STUDIO_STATE',
      studio: {
        ...ready.studio,
        connected: true,
        stop: {
          ...ready.studio.stop,
          phase: 'pending',
          requestId: '44444444-4444-4444-8444-444444444444',
          podId: ready.pod.podId,
          gpuDisplayName: 'RTX 4090',
          isRequester: true,
          responseDeadline: '2026-08-03T10:00:30.000Z',
        },
      },
    });
    expect(canStartBatch(pending)).toBe(true);

    const finalizing = appReducer(pending, {
      type: 'SYNC_STUDIO_STATE',
      studio: {
        ...pending.studio,
        stop: {
          ...pending.studio.stop,
          phase: 'finalizing',
          finalizationExpiresAt: '2026-08-03T10:00:40.000Z',
        },
      },
    });
    expect(canStartBatch(finalizing)).toBe(false);
  });

  it('returns a generation race to Create when the final GPU-stop guard wins', () => {
    let state = readyDraft(1);
    state = appReducer(state, { type: 'START_BATCH', startedAt: '2026-08-03T10:00:00.000Z' });
    expect(state.batch?.phase).toBe('validating');

    state = appReducer(state, {
      type: 'RUNTIME_ERROR',
      scope: 'batch',
      code: 'gpu_stop_pending',
      message: 'GPU termination is being finalized.',
      retryable: true,
    });

    expect(state.pod.phase).toBe('ready');
    expect(state.batch).toBeNull();
    expect(state.activeView).toBe('create');
    expect(state.toast?.title).toBe('GPU stop is finalizing');
  });
});
