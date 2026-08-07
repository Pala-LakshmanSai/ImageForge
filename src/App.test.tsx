import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GpuSelectorOfferV1, NativeGpuInventorySnapshotV1 } from '@imageforge/runpod-client';
import App from './App';
import type { ImageForgeAdapter } from './adapters/imageForgeAdapter';
import type { ProductionRuntimeFacade } from './adapters/productionImageForgeAdapter';
import type { ProductionRuntimeEvent } from './adapters/productionImageForgeAdapter';
import { DEFAULT_STUDIO_PROFILE } from './adapters/imageForgeAdapter';
import { createMemoryQueueHost, QueueStoreError } from './adapters/queueStore';
import { appReducer, createConfiguredInitialState, createDemoState, createInitialState } from './domain/reducer';
import type { CredentialMetadataMap, PodState } from './domain/types';
import type { NativeGpuStartResultV1 } from './native/gpuStartBridge';
import type { NativeGpuSwitchSnapshotV1 } from './native/gpuSwitchBridge';
import {
  createQueueRun,
  updateQueueItem,
  updateQueueRun,
  type NativeQueueItemV1,
  type NativeQueueSnapshotV1,
  type QueueHostPort,
} from './domain/queue';

const QUEUE_ITEM_ID = '11111111-1111-4111-8111-111111111111';
const QUEUE_SUBMISSION_ID = '22222222-2222-4222-8222-222222222222';
const QUEUE_RUN_ID = '33333333-3333-4333-8333-333333333333';
const QUEUE_REMOTE_ID = '44444444-4444-4444-8444-444444444444';
const GPU_OBSERVATION_ID = '55555555-5555-4555-8555-555555555555';
const GPU_RECEIPT_ID = '66666666-6666-4666-8666-666666666666';
const GPU_PROCESS_EPOCH_ID = '77777777-7777-4777-8777-777777777777';

function liveGpuInventory(): NativeGpuInventorySnapshotV1 {
  // A live receipt authorizes a paid Start for 60s only, and the selector now
  // projects that expiry. Anchor the fixture to the run clock so these tests
  // exercise selection rather than an already-expired receipt.
  const observedAt = new Date().toISOString();
  const offer: GpuSelectorOfferV1 = {
    schemaVersion: 1,
    observationId: GPU_OBSERVATION_ID,
    receiptId: GPU_RECEIPT_ID,
    gpuId: 'NVIDIA GeForce RTX 4090',
    policyKey: 'rtx_4090',
    displayName: 'RTX 4090',
    memoryGb: 24,
    emergency: false,
    availability: 'high',
    hourlyPriceMicroUsd: 690_000,
    dataCenterId: 'EU-RO-1',
    source: 'live',
    observedAt,
    stale: false,
    selectable: true,
    disabledReason: null,
    benchmarkState: 'unmeasured',
    benchmarkAgeMs: null,
    speedScore: null,
    benchmarkMedianDurationUs: null,
    benchmarkP95DurationUs: null,
    benchmarkMeasuredAt: null,
    benchmarkEvidenceSha256: null,
    estimatedSwitchRemainingCostMicroUsd: null,
  };
  return {
    schemaVersion: 1,
    observationId: GPU_OBSERVATION_ID,
    processEpochId: GPU_PROCESS_EPOCH_ID,
    includeEmergencyTier: false,
    state: 'ready',
    observedAt,
    receipt: {
      schemaVersion: 1,
      receiptId: GPU_RECEIPT_ID,
      processEpochId: GPU_PROCESS_EPOCH_ID,
      receivedAt: observedAt,
      validForMs: 60_000,
      catalogSha256: 'a'.repeat(64),
    },
    offers: [offer],
    currentPod: null,
    currentPodObservedAt: null,
    currentPodStale: false,
    issue: null,
  };
}

function switchGpuInventory(): NativeGpuInventorySnapshotV1 {
  const snapshot = liveGpuInventory();
  const target = {
    ...snapshot.offers[0],
    gpuId: 'NVIDIA GeForce RTX 5090',
    policyKey: 'rtx_5090' as const,
    displayName: 'RTX 5090',
    memoryGb: 32,
    hourlyPriceMicroUsd: 890_000,
  };
  return {
    ...snapshot,
    offers: [target],
    currentPod: {
      podId: 'pod-exact-1',
      gpuId: 'NVIDIA GeForce RTX 4090',
      gpuDisplayName: 'RTX 4090',
      hourlyPriceMicroUsd: 690_000,
    },
    currentPodObservedAt: snapshot.observedAt,
  };
}

function queuedItem(state: NativeQueueItemV1['state'] = 'staged'): NativeQueueItemV1 {
  return {
    schemaVersion: 1,
    queueItemId: QUEUE_ITEM_ID,
    clientSubmissionId: QUEUE_SUBMISSION_ID,
    recordRevision: 1,
    runRevision: state === 'staged' ? null : QUEUE_RUN_ID,
    remoteBatchId: null,
    state,
    attentionCode: state === 'needs_attention' ? 'submission_uncertain' : null,
    name: 'Overnight editorial',
    prompts: ['A quiet documentary frame at dawn'],
    baseSeed: 100_000,
    destination: '/tmp/imageforge-output',
    aspectRatio: '16:9',
    styleSuffix: null,
    references: [],
    createdAt: '2026-08-03T12:00:00.000Z',
    updatedAt: '2026-08-03T12:00:00.000Z',
  };
}

function queueSnapshot(item: NativeQueueItemV1, running = false): NativeQueueSnapshotV1 {
  const run = item.runRevision === null ? null : {
    runRevision: QUEUE_RUN_ID,
    cohortItemIds: [QUEUE_ITEM_ID],
    runnerState: running ? 'running' as const : 'paused' as const,
    authorizationRequired: !running,
    keepAwake: false,
  };
  return {
    schemaVersion: 1,
    storeRevision: 1,
    document: {
      schemaVersion: 1,
      items: [item],
      run,
      alarm: run === null ? null : {
        eventId: `queue-complete:${QUEUE_RUN_ID}`,
        runRevision: QUEUE_RUN_ID,
        state: 'disarmed',
        kind: null,
        snoozeUsed: false,
        snoozeDueAt: null,
        notificationDisposition: null,
        snoozeNotificationDisposition: null,
      },
    },
    issues: [],
  };
}

function ringingQueueSnapshot(disposition: 'pending' | 'delivered' | 'failed' | 'permission_denied' = 'failed'): NativeQueueSnapshotV1 {
  const item: NativeQueueItemV1 = {
    ...queuedItem(),
    recordRevision: 6,
    runRevision: QUEUE_RUN_ID,
    remoteBatchId: QUEUE_REMOTE_ID,
    state: 'completed',
  };
  return {
    schemaVersion: 1,
    storeRevision: 5,
    document: {
      schemaVersion: 1,
      items: [item],
      run: {
        runRevision: QUEUE_RUN_ID,
        cohortItemIds: [QUEUE_ITEM_ID],
        runnerState: 'completed',
        authorizationRequired: true,
        keepAwake: false,
      },
      alarm: {
        eventId: `queue-complete:${QUEUE_RUN_ID}`,
        runRevision: QUEUE_RUN_ID,
        state: 'ringing',
        kind: 'complete',
        snoozeUsed: false,
        snoozeDueAt: null,
        notificationDisposition: disposition,
        snoozeNotificationDisposition: null,
      },
    },
    issues: [],
  };
}

function withQueueSnapshot(snapshot: NativeQueueSnapshotV1) {
  const state = createConfiguredInitialState();
  state.queue = { ...state.queue, ...snapshot, loadState: 'ready' };
  return state;
}

function immediateAdapter(configured = true): ImageForgeAdapter {
  let credentials: CredentialMetadataMap = {
    runpodApiKey: { configured, suffix: configured ? 'K7P9' : null, provider: 'Test vault' },
    workerToken: { configured, suffix: configured ? 'F2M4' : null, provider: 'Test vault' },
  };
  return {
    queue: createMemoryQueueHost(),
    chooseDestination: async () => '/tmp/imageforge-output',
    validateDestination: async () => true,
    revealPath: async () => undefined,
    writeManifest: async (batchId) => `${batchId}/manifest.csv`,
    credentialMetadata: async () => credentials,
    async replaceCredential(kind, value) {
      const metadata = { configured: true, suffix: value.slice(-4), provider: 'Test vault' };
      credentials = { ...credentials, [kind]: metadata };
      return metadata;
    },
    validateStudioProfile: async (profile) => profile === DEFAULT_STUDIO_PROFILE,
    async testConnection(input) {
      const ok = input.credentials.runpodApiKey.configured && input.credentials.workerToken.configured && input.destinationValidated;
      return { ok, message: ok ? 'Validated without creating a Pod.' : 'Setup is incomplete.' };
    },
    runPodLifecycle(_policy, onUpdate) {
      onUpdate({ phase: 'ready', progress: 100, detail: 'Model warm', podId: 'pod-ui-test', gpu: 'RTX 4090', vram: '24 GB', hourlyRate: 0.54 });
      return () => undefined;
    },
    finishPodStop(onStopped) {
      onStopped();
      return () => undefined;
    },
    validateBatch(onValidated) {
      onValidated();
      return () => undefined;
    },
    runBatchClock() {
      return () => undefined;
    },
  };
}

function gpuSwitchProgressSnapshot(
  input: Partial<NonNullable<NativeGpuSwitchSnapshotV1['record']>> = {},
): NativeGpuSwitchSnapshotV1 {
  const target = {
    replacementAttemptId: '11111111-1111-4111-8111-111111111111',
    attemptRevision: 1,
    gpuId: 'NVIDIA GeForce RTX 5090',
    gpuDisplayName: 'RTX 5090',
    hourlyPriceMicroUsd: 890_000,
    observationId: '22222222-2222-4222-8222-222222222222',
    receiptId: '33333333-3333-4333-8333-333333333333',
    inventoryObservedAt: '2026-08-04T00:00:00.000Z',
    priceConfirmedAt: '2026-08-04T00:00:01.000Z',
  } as const;
  return {
    schemaVersion: 1,
    storeRevision: 2,
    record: {
      schemaVersion: 1,
      switchId: '44444444-4444-4444-8444-444444444444',
      recordRevision: 3,
      phase: 'consent_pending',
      blockedAt: null,
      attentionCode: null,
      authorizationRequired: false,
      targetConfirmation: 'confirmed',
      oldPod: {
        podId: 'pod-old-1',
        gpuId: 'NVIDIA GeForce RTX 4090',
        gpuDisplayName: 'RTX 4090',
        hourlyPriceMicroUsd: 690_000,
      },
      initialTarget: target,
      currentTarget: target,
      preparedTarget: null,
      priorAttempts: [],
      queueReservation: { active: true, queueRunRevision: null },
      expectedBatchId: null,
      oldDeleteWireAttempts: 0,
      replacementPodId: null,
      peerPodIds: [],
      peerPodOverflow: false,
      actualHourlyPriceMicroUsd: null,
      confirmedActualPrice: false,
      createdAt: '2026-08-04T00:00:02.000Z',
      updatedAt: '2026-08-04T00:00:02.000Z',
      ...input,
    },
    issues: [],
  };
}

function productionAdapter() {
  const listeners = new Set<Parameters<ProductionRuntimeFacade['subscribe']>[0]>();
  const inventoryListeners = new Set<(snapshot: NativeGpuInventorySnapshotV1) => void>();
  let authoritativePod: PodState | null | undefined;
  let gpuInventory: NativeGpuInventorySnapshotV1 | null = null;
  let gpuSwitch: NativeGpuSwitchSnapshotV1 = {
    schemaVersion: 1,
    storeRevision: 0,
    record: null,
    issues: [],
  };
  const createIntent: NativeGpuStartResultV1 = {
    schemaVersion: 1,
    operationId: '88888888-8888-4888-8888-888888888888',
    lifecycleRevision: 1,
    state: 'create_intent',
    pod: null,
    confirmedHourlyPriceMicroUsd: 690_000,
    actualHourlyPriceMicroUsd: null,
    issue: null,
  };
  const runtime: ProductionRuntimeFacade = {
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    getAuthoritativePodState: vi.fn(() => authoritativePod ?? null),
    getGpuInventory: vi.fn(() => gpuInventory),
    subscribeGpuInventory: vi.fn((listener) => {
      inventoryListeners.add(listener);
      if (gpuInventory !== null) listener(gpuInventory);
      return () => inventoryListeners.delete(listener);
    }),
    loadGpuInventory: vi.fn(async () => {
      if (gpuInventory === null) throw new Error('GPU inventory is not configured by this fixture.');
      return gpuInventory;
    }),
    loadGpuStart: vi.fn(async () => null),
    loadGpuSwitch: vi.fn(async () => gpuSwitch),
    recoverGpuStop: vi.fn(async () => undefined),
    beginGpuSwitch: vi.fn(async () => gpuSwitch),
    resumeGpuSwitch: vi.fn(async () => gpuSwitch),
    syncGpuSwitch: vi.fn(async () => gpuSwitch),
    confirmGpuSwitchTarget: vi.fn(async () => gpuSwitch),
    finalizeGpuSwitch: vi.fn(async () => gpuSwitch),
    deleteOldGpuSwitch: vi.fn(async () => gpuSwitch),
    prepareGpuSwitchAttempt: vi.fn(async () => gpuSwitch),
    confirmGpuSwitchAttempt: vi.fn(async () => gpuSwitch),
    createGpuSwitchReplacement: vi.fn(async () => gpuSwitch),
    confirmGpuSwitchActualPrice: vi.fn(async () => gpuSwitch),
    deleteGpuSwitchReplacement: vi.fn(async () => gpuSwitch),
    reconcileGpuSwitchProvider: vi.fn(async () => gpuSwitch),
    verifyGpuSwitchReplacement: vi.fn(async () => gpuSwitch),
    completeGpuSwitch: vi.fn(async () => gpuSwitch),
    cancelGpuSwitch: vi.fn(async () => gpuSwitch),
    refreshGpuInventory: vi.fn(async () => {
      if (gpuInventory === null) throw new Error('GPU inventory is not configured by this fixture.');
      return gpuInventory;
    }),
    prepareGpuInventory: vi.fn(async () => {
      if (gpuInventory === null) throw new Error('GPU inventory is not configured by this fixture.');
      return gpuInventory;
    }),
    startGpuChoice: vi.fn(async () => createIntent),
    confirmGpuActualPrice: vi.fn(async () => { throw new Error('GPU price confirmation is not used by this fixture.'); }),
    restoreLocalLibrary: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    observe: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
    startGpu: vi.fn(async () => undefined),
    requestGpuStop: vi.fn(async () => undefined),
    respondToGpuStop: vi.fn(async () => undefined),
    respondToGpuSwitch: vi.fn(async () => undefined),
    cancelGpuStop: vi.fn(async () => undefined),
    startBatch: vi.fn(async () => undefined),
    pollBatch: vi.fn(async () => undefined),
    beginNewBatch: vi.fn(),
    controlBatch: vi.fn(async () => undefined),
    resolveAmbiguousStart: vi.fn(async () => undefined),
    reconcileQueueSubmission: vi.fn(async () => null),
    dispose: vi.fn(),
  };
  const fake = immediateAdapter();
  const adapter: ImageForgeAdapter = {
    ...fake,
    mode: 'production',
    runtime,
    runPodLifecycle: vi.fn(() => () => undefined),
    finishPodStop: vi.fn(() => () => undefined),
    validateBatch: vi.fn(() => () => undefined),
    runBatchClock: vi.fn(() => () => undefined),
  };
  return {
    adapter,
    runtime,
    listeners,
    emit: (event: ProductionRuntimeEvent) => listeners.forEach((listener) => listener(event)),
    setAuthoritativePod: (pod: PodState | null | undefined) => { authoritativePod = pod; },
    setGpuInventory: (snapshot: NativeGpuInventorySnapshotV1) => {
      gpuInventory = snapshot;
      inventoryListeners.forEach((listener) => listener(snapshot));
    },
    setGpuSwitch: (snapshot: NativeGpuSwitchSnapshotV1) => { gpuSwitch = snapshot; },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ImageForge shell', () => {
  it('refreshes production read-only on launch and starts compute only after a foreground click', async () => {
    const production = productionAdapter();
    production.setGpuInventory(liveGpuInventory());
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);

    await waitFor(() => expect(production.runtime.refresh).toHaveBeenCalledOnce());
    await waitFor(() => expect(production.runtime.restoreLocalLibrary).toHaveBeenCalledOnce());
    await waitFor(() => expect(production.runtime.loadGpuInventory).toHaveBeenCalledOnce());
    await waitFor(() => expect(production.runtime.loadGpuSwitch).toHaveBeenCalledOnce());
    expect(production.runtime.startGpu).not.toHaveBeenCalled();
    expect(production.adapter.runPodLifecycle).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: 'Start GPU' })[0]);
    expect(await screen.findByRole('radio', { name: /Auto best value/i })).toBeVisible();
    fireEvent.click(screen.getByRole('radio', { name: /Auto best value/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Review Auto start' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start Auto best value' }));
    await waitFor(() => expect(production.runtime.startGpuChoice).toHaveBeenCalledOnce());
    expect(production.runtime.startGpuChoice).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ kind: 'auto_start' }),
    );
    expect(production.runtime.startGpu).not.toHaveBeenCalled();
    expect(production.adapter.runPodLifecycle).not.toHaveBeenCalled();
  });

  it('quiesces an in-flight advisory Pod observation before one selected native Start', async () => {
    const production = productionAdapter();
    production.setGpuInventory(liveGpuInventory());
    let resolveObservation: (() => void) | null = null;
    vi.mocked(production.runtime.observe).mockImplementation(() => new Promise<void>((resolve) => {
      resolveObservation = resolve;
    }));
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);

    await waitFor(() => expect(production.runtime.refresh).toHaveBeenCalledOnce());
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(production.runtime.observe).toHaveBeenCalledOnce());

    fireEvent.click(screen.getAllByRole('button', { name: 'Start GPU' })[0]);
    fireEvent.click(await screen.findByRole('radio', { name: /RTX 4090/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Start selected GPU at $0.69/hr' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start RTX 4090' }));

    expect(production.runtime.startGpuChoice).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('focus'));
    await act(async () => { await Promise.resolve(); });
    expect(production.runtime.observe).toHaveBeenCalledOnce();

    await act(async () => { resolveObservation?.(); });
    await waitFor(() => expect(production.runtime.startGpuChoice).toHaveBeenCalledOnce());
    expect(production.runtime.startGpuChoice).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ kind: 'manual_start' }),
    );
  });

  it('preserves a structured native Start rejection and keeps the selector available for recovery', async () => {
    const production = productionAdapter();
    production.setGpuInventory(liveGpuInventory());
    vi.mocked(production.runtime.startGpuChoice).mockRejectedValueOnce({
      code: 'gpu_start_target_changed',
      message: 'The selected GPU changed. Review the refreshed choice.',
      retryable: true,
    });
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);

    await waitFor(() => expect(production.runtime.loadGpuSwitch).toHaveBeenCalledOnce());
    fireEvent.click(screen.getAllByRole('button', { name: 'Start GPU' })[0]);
    const gpuRow = await screen.findByRole('radio', { name: /RTX 4090/i });
    expect(gpuRow).toBeVisible();
    fireEvent.click(gpuRow);
    fireEvent.click(screen.getByRole('button', { name: 'Start selected GPU at $0.69/hr' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start RTX 4090' }));

    await waitFor(() => expect(production.runtime.startGpuChoice).toHaveBeenCalledOnce());
    expect(await screen.findByText('The selected GPU changed. Review the refreshed choice.')).toBeVisible();
    expect(screen.getByRole('dialog', { name: 'Choose a GPU' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Close GPU selector' })).toBeVisible();
  });

  it('re-observes live inventory when native rejects Start with an expired receipt', async () => {
    const production = productionAdapter();
    production.setGpuInventory(liveGpuInventory());
    vi.mocked(production.runtime.startGpuChoice).mockRejectedValueOnce({
      code: 'gpu_start_inventory_stale',
      message: 'Live GPU inventory expired. Refresh GPUs and choose again.',
      retryable: true,
    });
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);

    await waitFor(() => expect(production.runtime.loadGpuSwitch).toHaveBeenCalledOnce());
    fireEvent.click(screen.getAllByRole('button', { name: 'Start GPU' })[0]);
    fireEvent.click(await screen.findByRole('radio', { name: /RTX 4090/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Start selected GPU at $0.69/hr' }));
    const preparedBeforeStart = vi.mocked(production.runtime.prepareGpuInventory).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Start RTX 4090' }));

    await waitFor(() => expect(production.runtime.startGpuChoice).toHaveBeenCalledOnce());
    expect(await screen.findByText('Live GPU inventory expired. Refresh GPUs and choose again.')).toBeVisible();
    // The sheet stays open, so the expired receipt must be replaced without a
    // second manual Refresh; otherwise every following click fails the same way.
    await waitFor(() => expect(
      vi.mocked(production.runtime.prepareGpuInventory).mock.calls.length,
    ).toBeGreaterThan(preparedBeforeStart));
    expect(screen.getByRole('dialog', { name: 'Choose a GPU' })).toBeVisible();
  });

  it('shows GPU rows after delayed Start inventory preparation resolves', async () => {
    const production = productionAdapter();
    let resolvePreparation: ((snapshot: NativeGpuInventorySnapshotV1) => void) | null = null;
    production.runtime.prepareGpuInventory = vi.fn(() => new Promise<NativeGpuInventorySnapshotV1>((resolve) => {
      resolvePreparation = resolve;
    }));
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);

    await waitFor(() => expect(production.runtime.loadGpuSwitch).toHaveBeenCalledOnce());
    fireEvent.click(screen.getAllByRole('button', { name: 'Start GPU' })[0]);
    expect(await screen.findByRole('dialog', { name: 'Choose a GPU' })).toBeVisible();
    expect(screen.getByText('Loading the native inventory journal…')).toBeVisible();

    await act(async () => {
      resolvePreparation?.(liveGpuInventory());
    });
    expect(await screen.findByRole('radio', { name: /Auto best value/i })).toBeVisible();
    expect(screen.getByRole('radio', { name: /RTX 4090/i })).toBeVisible();
  });

  it('keeps terminal rows when native loading resolves through the inventory subscription first', async () => {
    const production = productionAdapter();
    const loadingSnapshot: NativeGpuInventorySnapshotV1 = {
      ...liveGpuInventory(),
      state: 'loading',
      observedAt: null,
      receipt: null,
      offers: [],
      currentPod: null,
      currentPodObservedAt: null,
      currentPodStale: false,
      issue: null,
    };
    production.runtime.prepareGpuInventory = vi.fn(async () => {
      // This models the native coordinator publishing its terminal event
      // before the immediate loading promise continuation resumes.
      production.setGpuInventory(liveGpuInventory());
      return loadingSnapshot;
    });
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);

    await waitFor(() => expect(production.runtime.loadGpuSwitch).toHaveBeenCalledOnce());
    fireEvent.click(screen.getAllByRole('button', { name: 'Start GPU' })[0]);

    expect(await screen.findByRole('radio', { name: /Auto best value/i })).toBeVisible();
    expect(screen.getByRole('radio', { name: /RTX 4090/i })).toBeVisible();
    expect(screen.queryByText('Loading the native inventory journal…')).not.toBeInTheDocument();
  });

  it('keeps the selector surface mounted while an in-place refresh is pending', async () => {
    const production = productionAdapter();
    production.setGpuInventory(liveGpuInventory());
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);

    await waitFor(() => expect(production.runtime.loadGpuSwitch).toHaveBeenCalledOnce());
    fireEvent.click(screen.getAllByRole('button', { name: 'Start GPU' })[0]);
    expect(await screen.findByRole('radio', { name: /RTX 4090/i })).toBeVisible();

    production.runtime.prepareGpuInventory = vi.fn(() => new Promise<NativeGpuInventorySnapshotV1>(() => undefined));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh GPUs' }));

    expect(screen.getByRole('dialog', { name: 'Choose a GPU' })).toBeVisible();
    expect(screen.getByRole('radio', { name: /RTX 4090/i })).toBeVisible();
    expect(screen.queryByText('Loading the native inventory journal…')).not.toBeInTheDocument();
  });

  it('replaces a failed Start inventory load with a retryable terminal state', async () => {
    const production = productionAdapter();
    production.runtime.prepareGpuInventory = vi.fn(async () => {
      throw new Error('RunPod inventory could not be reached.');
    });
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);

    await waitFor(() => expect(production.runtime.loadGpuSwitch).toHaveBeenCalledOnce());
    fireEvent.click(screen.getAllByRole('button', { name: 'Start GPU' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'GPU inventory unavailable' });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('RunPod inventory could not be reached.');
    expect(within(dialog).getByRole('button', { name: 'Retry GPU list' })).toBeVisible();
    expect(screen.queryByText('Loading the native inventory journal…')).not.toBeInTheDocument();
    expect(production.runtime.startGpuChoice).not.toHaveBeenCalled();
  });

  it('routes a secure-storage credential failure to Settings instead of offering a useless retry', async () => {
    const production = productionAdapter();
    production.runtime.prepareGpuInventory = vi.fn(async () => {
      throw {
        code: 'credential_read_failed',
        message: 'The required credential could not be loaded from secure storage.',
        retryable: false,
      };
    });
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);

    await waitFor(() => expect(production.runtime.loadGpuSwitch).toHaveBeenCalledOnce());
    fireEvent.click(screen.getAllByRole('button', { name: 'Start GPU' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'RunPod credential needs attention' });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('could not be loaded from secure storage');
    expect(within(dialog).queryByRole('button', { name: 'Retry GPU list' })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Open settings' }));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  it('opens Switch from the current GPU chip and begins only through the native switch facade', async () => {
    const production = productionAdapter();
    production.setGpuInventory(switchGpuInventory());
    const state = createConfiguredInitialState();
    state.pod = {
      ...state.pod,
      phase: 'ready',
      phaseProgress: 100,
      statusDetail: 'Model warm',
      gpu: 'RTX 4090',
      vram: '24 GB',
      hourlyRate: 0.69,
      health: 'healthy',
      podId: 'pod-exact-1',
      matchingPodIds: ['pod-exact-1'],
    };
    render(<App initialState={state} adapter={production.adapter} />);
    await waitFor(() => expect(production.runtime.loadGpuSwitch).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'Current GPU / Switch GPU' }));
    expect(await screen.findByRole('dialog', { name: 'Current GPU / Switch GPU' })).toBeVisible();
    fireEvent.click(screen.getByRole('radio', { name: /RTX 5090/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Review switch to RTX 5090' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to RTX 5090' }));

    await waitFor(() => expect(production.runtime.beginGpuSwitch).toHaveBeenCalledOnce());
    expect(production.runtime.beginGpuSwitch).toHaveBeenCalledWith(
      expect.objectContaining({ pod: expect.objectContaining({ podId: 'pod-exact-1' }) }),
      expect.objectContaining({ kind: 'switch' }),
    );
    expect(production.runtime.startGpuChoice).not.toHaveBeenCalled();
  });

  it('keeps Create power control aligned with TopBar when active Pod health degrades', () => {
    const state = createConfiguredInitialState();
    state.pod = {
      ...state.pod,
      phase: 'error',
      health: 'degraded',
      statusDetail: 'RunPod health check failed; Pod may still be accruing cost',
      podId: 'pod-still-billed',
      matchingPodIds: ['pod-still-billed'],
      gpu: 'RTX 4090',
    };

    render(<App initialState={state} adapter={immediateAdapter()} />);

    expect(screen.queryByRole('button', { name: 'Start GPU' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Stop GPU' }).length).toBeGreaterThan(0);
    expect(screen.getByText('GPU active · review status')).toBeVisible();
  });

  it('does not offer Start GPU from Progress while a degraded Pod identity remains active', () => {
    const state = createConfiguredInitialState();
    state.activeView = 'progress';
    state.pod = {
      ...state.pod,
      phase: 'error',
      health: 'degraded',
      errorMessage: 'Worker health could not be verified',
      podId: 'pod-still-billed',
      matchingPodIds: ['pod-still-billed'],
      gpu: 'RTX 4090',
    };

    render(<App initialState={state} adapter={immediateAdapter()} />);

    expect(screen.getByText('GPU needs attention')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Start GPU' })).not.toBeInTheDocument();
  });

  it.each(['create', 'progress', 'settings'] as const)('uses the exact Pod identity for %s power controls when health is degraded', (view) => {
    const state = createConfiguredInitialState();
    state.activeView = view;
    state.pod = {
      ...state.pod,
      phase: 'error',
      health: 'degraded',
      statusDetail: 'The worker status is temporarily unavailable; the Pod may still be billed.',
      errorMessage: 'The worker status is temporarily unavailable.',
      podId: 'pod-degraded-014',
      matchingPodIds: ['pod-degraded-014'],
      gpu: 'RTX 4090',
    };

    render(<App initialState={state} adapter={immediateAdapter()} />);

    expect(screen.queryByRole('button', { name: 'Start GPU' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start GPU explicitly' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Stop GPU' }).length).toBeGreaterThan(0);
    if (view === 'settings') expect(screen.getByRole('button', { name: 'Stop GPU with confirmation' })).toBeVisible();
  });

  it('keeps Stop authoritative through an unknown-style reconnecting state', () => {
    const state = createConfiguredInitialState();
    state.activeView = 'progress';
    state.pod = {
      ...state.pod,
      phase: 'reconnecting',
      health: 'checking',
      statusDetail: 'The exact worker status is unknown while reconnecting.',
      podId: 'pod-unknown-014',
      matchingPodIds: ['pod-unknown-014'],
      gpu: 'RTX 4090',
    };

    render(<App initialState={state} adapter={immediateAdapter()} />);

    expect(screen.getAllByRole('button', { name: 'Stop GPU' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Start GPU' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart GPU to resume' })).not.toBeInTheDocument();
  });

  it('fails closed when a Ready phase has no exact Pod identity', () => {
    const state = createConfiguredInitialState();
    state.pod = {
      ...state.pod,
      phase: 'ready',
      health: 'degraded',
      statusDetail: 'The worker identity is unavailable.',
      podId: null,
      matchingPodIds: [],
      gpu: 'RTX 4090',
    };

    render(<App initialState={state} adapter={immediateAdapter()} />);

    expect(screen.queryByRole('button', { name: 'Stop GPU' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'GPU identity needed' }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });

  it('does not expose interrupted resume or stale GPU metadata without an exact Pod identity', () => {
    let state = createDemoState();
    state = appReducer(state, { type: 'CONFIRM_STOP_POD' });
    state = appReducer(state, { type: 'POD_STOPPED' });
    state = {
      ...state,
      pod: {
        ...state.pod,
        phase: 'ready',
        health: 'degraded',
        podId: null,
        matchingPodIds: [],
        gpu: 'RTX 4090',
      },
    };

    render(<App initialState={state} adapter={immediateAdapter()} />);

    expect(screen.queryByRole('button', { name: 'Resume interrupted batch' })).not.toBeInTheDocument();
    expect(screen.getByText(/The exact GPU identity is unavailable/)).toBeVisible();
    expect(screen.queryByText(/· RTX 4090$/)).not.toBeInTheDocument();
  });

  it('shows a peer GPU-switch consent prompt and records only the explicit decision', async () => {
    const production = productionAdapter();
    production.setGpuInventory(liveGpuInventory());
    const initial = createConfiguredInitialState();
    initial.pod = {
      ...initial.pod,
      phase: 'ready',
      phaseProgress: 100,
      statusDetail: 'Model warm',
      podId: 'pod-exact-1',
      gpu: 'RTX 4090',
      vram: '24 GB',
      hourlyRate: 0.69,
    };
    render(<App initialState={initial} adapter={production.adapter} />);
    await waitFor(() => expect(production.runtime.subscribe).toHaveBeenCalledOnce());

    act(() => production.emit({
      type: 'studio',
      studio: {
        ...initial.studio,
        connected: true,
        serverInstanceId: '99999999-9999-4999-8999-999999999999',
        coordinationRevision: 2,
        currentSession: {
          sessionId: '22222222-2222-4222-8222-222222222222',
          displayName: 'Sujal',
          availability: 'foreground',
          expiresAt: '2999-08-03T10:00:12.000Z',
        },
        sessions: [{
          sessionId: '22222222-2222-4222-8222-222222222222',
          displayName: 'Sujal',
          availability: 'foreground',
          expiresAt: '2999-08-03T10:00:12.000Z',
        }],
        gpuSwitch: {
          switchId: '66666666-6666-4666-8666-666666666666',
          oldPodId: 'pod-exact-1',
          oldGpuId: 'NVIDIA GeForce RTX 4090',
          oldGpuDisplayName: 'RTX 4090',
          initialTargetGpuId: 'NVIDIA RTX 5090',
          initialTargetGpuDisplayName: 'RTX 5090',
          requester: {
            sessionId: '11111111-1111-4111-8111-111111111111',
            displayName: 'Lakshman',
          },
          isRequester: false,
          canRespond: true,
          phase: 'pending',
          reason: null,
          requestedAt: '2026-08-03T10:00:00.000Z',
          responseDeadline: '2999-08-03T10:00:30.000Z',
          readyToDeleteAt: null,
          waitingFor: [{
            sessionId: '22222222-2222-4222-8222-222222222222',
            displayName: 'Sujal',
          }],
          approvedBy: [],
          deniedBy: [],
          batchId: null,
          batchOwner: null,
          batchProgress: null,
          batchStateAtFinalization: null,
          replacementPodId: null,
          actualTargetGpuId: null,
        },
      },
    }));

    fireEvent.click(await screen.findByRole('button', { name: 'Keep current GPU' }));

    await waitFor(() => expect(production.runtime.respondToGpuSwitch).toHaveBeenCalledWith(
      '66666666-6666-4666-8666-666666666666',
      'deny',
    ));
  });

  it('loads a durable GPU Switch with an explicit native Resume action and blocks ordinary Start', async () => {
    const production = productionAdapter();
    production.setGpuInventory(liveGpuInventory());
    const target = {
      replacementAttemptId: '11111111-1111-4111-8111-111111111111',
      attemptRevision: 1,
      gpuId: 'NVIDIA GeForce RTX 5090',
      gpuDisplayName: 'RTX 5090',
      hourlyPriceMicroUsd: 890_000,
      observationId: '22222222-2222-4222-8222-222222222222',
      receiptId: '33333333-3333-4333-8333-333333333333',
      inventoryObservedAt: '2026-08-03T12:00:00.000Z',
      priceConfirmedAt: '2026-08-03T12:00:01.000Z',
    } as const;
    production.setGpuSwitch({
      schemaVersion: 1,
      storeRevision: 2,
      record: {
        schemaVersion: 1,
        switchId: '44444444-4444-4444-8444-444444444444',
        recordRevision: 1,
        phase: 'consent_pending',
        blockedAt: null,
        attentionCode: null,
        authorizationRequired: true,
        targetConfirmation: 'required',
        oldPod: {
          podId: 'pod-old-1',
          gpuId: 'NVIDIA GeForce RTX 4090',
          gpuDisplayName: 'RTX 4090',
          hourlyPriceMicroUsd: 690_000,
        },
        initialTarget: target,
        currentTarget: target,
        preparedTarget: null,
        priorAttempts: [],
        queueReservation: { active: true, queueRunRevision: null },
        expectedBatchId: null,
        oldDeleteWireAttempts: 0,
        replacementPodId: null,
        peerPodIds: [],
        peerPodOverflow: false,
        actualHourlyPriceMicroUsd: null,
        confirmedActualPrice: false,
        createdAt: '2026-08-03T12:00:02.000Z',
        updatedAt: '2026-08-03T12:00:02.000Z',
      },
      issues: [],
    });

    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);
    expect(await screen.findByText('Waiting for switch approval')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Resume switch' }));
    await waitFor(() => expect(production.runtime.resumeGpuSwitch).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole('button', { name: 'Start GPU' })[0]);
    expect(await screen.findByText(/found a durable GPU Switch/i)).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Choose a GPU' })).not.toBeInTheDocument();
    expect(production.runtime.startGpuChoice).not.toHaveBeenCalled();
  });

  it.each([
    [{ phase: 'ready_to_delete' }, 'Terminate current GPU', 'deleteOldGpuSwitch'],
    [{ phase: 'old_absent' }, 'Prepare another attempt', 'prepareGpuSwitchAttempt'],
    [{
      phase: 'old_absent',
      preparedTarget: {
        quoteId: '66666666-6666-4666-8666-666666666666',
        preparedFromRecordRevision: 3,
        gpuId: 'NVIDIA GeForce RTX 5090',
        gpuDisplayName: 'RTX 5090',
        hourlyPriceMicroUsd: 890_000,
        observationId: '22222222-2222-4222-8222-222222222222',
        receiptId: '33333333-3333-4333-8333-333333333333',
        preparedAt: '2026-08-04T00:00:03.000Z',
        expiresAt: '2026-08-04T00:01:03.000Z',
      },
    }, 'Confirm replacement attempt', 'confirmGpuSwitchAttempt'],
    [{ phase: 'old_absent' }, 'Start replacement GPU', 'createGpuSwitchReplacement'],
    [{
      phase: 'replacement_identified',
      replacementPodId: 'pod-replacement-1',
      actualHourlyPriceMicroUsd: 910_000,
    }, 'Accept actual price', 'confirmGpuSwitchActualPrice'],
    [{
      phase: 'replacement_failed',
      replacementPodId: 'pod-replacement-1',
    }, 'Terminate replacement', 'deleteGpuSwitchReplacement'],
    [{ phase: 'delete_uncertain' }, 'Check provider state', 'reconcileGpuSwitchProvider'],
    [{
      phase: 'provisioning',
      replacementPodId: 'pod-replacement-1',
      actualHourlyPriceMicroUsd: 890_000,
      confirmedActualPrice: true,
    }, 'Verify replacement', 'verifyGpuSwitchReplacement'],
    [{
      phase: 'ready_paused',
      replacementPodId: 'pod-replacement-1',
      actualHourlyPriceMicroUsd: 890_000,
      confirmedActualPrice: true,
    }, 'Complete switch', 'completeGpuSwitch'],
  ] satisfies ReadonlyArray<readonly [
    Partial<NonNullable<NativeGpuSwitchSnapshotV1['record']>>,
    string,
    | 'deleteOldGpuSwitch'
    | 'prepareGpuSwitchAttempt'
    | 'confirmGpuSwitchAttempt'
    | 'createGpuSwitchReplacement'
    | 'confirmGpuSwitchActualPrice'
    | 'deleteGpuSwitchReplacement'
    | 'reconcileGpuSwitchProvider'
    | 'verifyGpuSwitchReplacement'
    | 'completeGpuSwitch',
  ]>)('dispatches later Switch phase %s through %s', async (record, label, method) => {
    const production = productionAdapter();
    production.setGpuInventory(liveGpuInventory());
    production.setGpuSwitch(gpuSwitchProgressSnapshot(record));
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);

    fireEvent.click(await screen.findByRole('button', { name: label }));
    await waitFor(() => expect(production.runtime[method]).toHaveBeenCalledOnce());
  });

  it('binds provider reconciliation and replacement cleanup to the exact rendered reason', async () => {
    const production = productionAdapter();
    production.setGpuInventory(liveGpuInventory());
    production.setGpuSwitch(gpuSwitchProgressSnapshot({
      phase: 'replacement_failed',
      replacementPodId: 'pod-replacement-1',
    }));
    const { unmount } = render(
      <App initialState={createConfiguredInitialState()} adapter={production.adapter} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Terminate replacement' }));
    await waitFor(() => expect(production.runtime.deleteGpuSwitchReplacement).toHaveBeenCalledWith(
      expect.any(Object),
      'replacement_failed',
    ));
    unmount();

    const uncertain = productionAdapter();
    uncertain.setGpuInventory(liveGpuInventory());
    uncertain.setGpuSwitch(gpuSwitchProgressSnapshot({ phase: 'create_uncertain' }));
    render(<App initialState={createConfiguredInitialState()} adapter={uncertain.adapter} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check provider state' }));
    await waitFor(() => expect(uncertain.runtime.reconcileGpuSwitchProvider).toHaveBeenCalledWith(
      expect.any(Object),
      'after_create',
    ));
  });

  it('does not let a foreground Start outrun durable GPU Switch journal loading', async () => {
    const production = productionAdapter();
    production.setGpuInventory(liveGpuInventory());
    vi.mocked(production.runtime.loadGpuSwitch).mockReturnValueOnce(new Promise(() => undefined));
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Start GPU' })[0]);
    expect(await screen.findByText(/still verifying the durable GPU Switch journal/i)).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Choose a GPU' })).not.toBeInTheDocument();
    expect(production.runtime.startGpuChoice).not.toHaveBeenCalled();
  });

  it('keeps GPU mutation blocked when the durable Switch journal cannot be verified', async () => {
    const production = productionAdapter();
    production.setGpuInventory(liveGpuInventory());
    vi.mocked(production.runtime.loadGpuSwitch).mockRejectedValueOnce(new Error('private journal detail'));
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);

    expect(await screen.findByText(/durable Switch journal could not be verified/i)).toBeVisible();
    fireEvent.click(screen.getAllByRole('button', { name: 'Start GPU' })[0]);
    expect(await screen.findByText(/could not verify the durable GPU Switch journal/i)).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Choose a GPU' })).not.toBeInTheDocument();
    expect(production.runtime.startGpuChoice).not.toHaveBeenCalled();
    expect(screen.queryByText(/private journal detail/i)).not.toBeInTheDocument();
  });

  it('keeps exact native price attention visible and confirms it only from a second click', async () => {
    const production = productionAdapter();
    production.setGpuInventory(liveGpuInventory());
    const attention: NativeGpuStartResultV1 = {
      schemaVersion: 1,
      operationId: '99999999-9999-4999-8999-999999999999',
      lifecycleRevision: 3,
      state: 'price_attention',
      pod: {
        podId: 'imageforge-pod-1',
        gpuId: 'NVIDIA GeForce RTX 4090',
        gpuDisplayName: 'RTX 4090',
        hourlyPriceMicroUsd: 700_000,
      },
      confirmedHourlyPriceMicroUsd: 690_000,
      actualHourlyPriceMicroUsd: 700_000,
      issue: { code: 'gpu_actual_price_changed', retryable: false },
    };
    const ready: NativeGpuStartResultV1 = {
      ...attention,
      lifecycleRevision: 4,
      state: 'ready',
      confirmedHourlyPriceMicroUsd: 700_000,
      issue: null,
    };
    vi.mocked(production.runtime.startGpuChoice).mockResolvedValueOnce(attention);
    vi.mocked(production.runtime.confirmGpuActualPrice).mockResolvedValueOnce(ready);
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);

    await waitFor(() => expect(production.runtime.loadGpuSwitch).toHaveBeenCalledOnce());
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getAllByRole('button', { name: 'Start GPU' })[0]);
    fireEvent.click(await screen.findByRole('radio', { name: /Auto best value/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Review Auto start' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start Auto best value' }));

    expect(await screen.findByText('Actual GPU price needs confirmation')).toBeVisible();
    expect(screen.getByText(/Confirmed \$0\.69\/hr · actual \$0\.7\/hr/)).toBeVisible();
    expect(production.runtime.confirmGpuActualPrice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Accept actual price' }));
    await waitFor(() => expect(production.runtime.confirmGpuActualPrice).toHaveBeenCalledWith(
      expect.any(Object),
      attention.operationId,
      700_000,
    ));
    await waitFor(() => expect(screen.queryByText('Actual GPU price needs confirmation')).not.toBeInTheDocument());
  });

  it('uses a bounded, receipt-free cross-client heartbeat while Create is idle', async () => {
    vi.useFakeTimers();
    const production = productionAdapter();
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);

    await act(async () => { await Promise.resolve(); });
    expect(production.runtime.refresh).toHaveBeenCalledTimes(1);
    expect(production.runtime.heartbeat).toHaveBeenCalledWith(expect.any(Object), 'foreground');
    expect(production.runtime.heartbeat).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(3_999);
      await Promise.resolve();
    });
    expect(production.runtime.observe).not.toHaveBeenCalled();
    expect(production.runtime.heartbeat).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(production.runtime.observe).toHaveBeenCalledTimes(1);
    expect(production.runtime.heartbeat).toHaveBeenCalledTimes(2);
    expect(production.runtime.refresh).toHaveBeenCalledTimes(1);
  });

  it('waits for the strict startup refresh before publishing the first studio heartbeat', async () => {
    let releaseRefresh!: () => void;
    const production = productionAdapter();
    vi.mocked(production.runtime.refresh).mockImplementation(() => new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    }));
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);

    await waitFor(() => expect(production.runtime.refresh).toHaveBeenCalledOnce());
    expect(production.runtime.heartbeat).not.toHaveBeenCalled();

    releaseRefresh();
    await waitFor(() => expect(production.runtime.heartbeat).toHaveBeenCalledOnce());
    expect(vi.mocked(production.runtime.refresh).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(production.runtime.heartbeat).mock.invocationCallOrder[0]);
  });

  it('shows a direct synchronized notice when the confirmed GPU was already stopped elsewhere', async () => {
    const production = productionAdapter();
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);

    act(() => production.emit({
      type: 'notice',
      tone: 'info',
      title: 'GPU already stopped',
      message: 'No second termination was sent.',
    }));

    expect(await screen.findByText('GPU already stopped')).toBeVisible();
    expect(screen.getByText('No second termination was sent.')).toBeVisible();
  });

  it('waits for native RunPod credential metadata before startup refresh', async () => {
    let resolveMetadata!: (credentials: CredentialMetadataMap) => void;
    const metadata = new Promise<CredentialMetadataMap>((resolve) => { resolveMetadata = resolve; });
    const production = productionAdapter();
    const adapter = { ...production.adapter, credentialMetadata: vi.fn(() => metadata) };
    const state = createConfiguredInitialState();
    state.setup.credentials = {
      runpodApiKey: { configured: false, suffix: null, provider: 'macOS Keychain' },
      workerToken: { configured: false, suffix: null, provider: 'macOS Keychain' },
    };
    render(<App initialState={state} adapter={adapter} />);

    await waitFor(() => expect(adapter.credentialMetadata).toHaveBeenCalledOnce());
    expect(production.runtime.refresh).not.toHaveBeenCalled();

    resolveMetadata({
      runpodApiKey: { configured: true, suffix: 'K7P9', provider: 'macOS Keychain' },
      workerToken: { configured: false, suffix: null, provider: 'macOS Keychain' },
    });
    await waitFor(() => expect(production.runtime.refresh).toHaveBeenCalledOnce());
  });

  it('revalidates the shared GPU before production generation and blocks a stale ready card', async () => {
    const user = userEvent.setup();
    const production = productionAdapter();
    let state = createConfiguredInitialState();
    state = appReducer(state, {
      type: 'SET_POD_PHASE',
      phase: 'ready',
      progress: 100,
      detail: 'Model warm',
      podId: 'pod-stopped-by-sujal',
      gpu: 'RTX 4090',
      vram: '24 GB',
      hourlyRate: 0.54,
    });
    state = appReducer(state, { type: 'SET_PROMPT_TEXT', text: 'A sufficiently detailed editorial documentary frame at dawn' });
    state = appReducer(state, { type: 'SET_DESTINATION', path: '/tmp/imageforge-output' });
    production.setAuthoritativePod({
      ...state.pod,
      phase: 'offline',
      phaseProgress: 0,
      statusDetail: 'GPU is safely offline',
      gpu: null,
      vram: null,
      hourlyRate: null,
      health: 'offline',
      podId: null,
      matchingPodIds: [],
    });

    render(<App initialState={state} adapter={production.adapter} />);
    const generate = screen.getByRole('button', { name: /Generate 1 images/i });
    expect(generate).toBeEnabled();
    await user.click(generate);

    await waitFor(() => expect(screen.getByText('GPU is not ready')).toBeVisible());
    expect(production.runtime.startBatch).not.toHaveBeenCalled();
    expect(screen.getByText('Currently offline')).toBeVisible();
  });

  it('shows that production Generate is checking the shared GPU instead of appearing inert', async () => {
    const production = productionAdapter();
    let releaseRefresh!: () => void;
    vi.mocked(production.runtime.refresh).mockImplementation(() => new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    }));
    let state = createConfiguredInitialState();
    state = appReducer(state, {
      type: 'SET_POD_PHASE',
      phase: 'ready',
      progress: 100,
      detail: 'Model warm',
      podId: 'pod-ready-for-preflight',
      gpu: 'RTX 4090',
      vram: '24 GB',
      hourlyRate: 0.54,
    });
    state = appReducer(state, { type: 'SET_PROMPT_TEXT', text: 'A sufficiently detailed editorial documentary frame at dawn' });
    state = appReducer(state, { type: 'SET_DESTINATION', path: '/tmp/imageforge-output' });

    render(<App initialState={state} adapter={production.adapter} />);
    await waitFor(() => expect(production.runtime.refresh).toHaveBeenCalledOnce());

    const generate = screen.getByRole('button', { name: /Generate 1 images/i });
    expect(generate).toBeEnabled();
    fireEvent.click(generate);

    await waitFor(() => expect(screen.getByRole('button', { name: /Checking GPU/i })).toBeDisabled());
    expect(screen.getByText('Verifying the shared GPU before generation starts…')).toBeVisible();
    expect(production.runtime.refresh).toHaveBeenCalledOnce();

    releaseRefresh();
    await waitFor(() => expect(production.runtime.startBatch).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('button', { name: /Checking GPU/i })).not.toBeInTheDocument());
  });

  it('shows an active local queue as an unticked blocker for direct Generate', async () => {
    const snapshot = queueSnapshot(queuedItem('active'));
    let state = withQueueSnapshot(snapshot);
    state = appReducer(state, {
      type: 'SET_POD_PHASE',
      phase: 'ready',
      progress: 100,
      detail: 'Model warm',
      podId: 'pod-ready-for-queue',
      gpu: 'RTX 4090',
      vram: '24 GB',
      hourlyRate: 0.54,
    });
    state = appReducer(state, { type: 'SET_PROMPT_TEXT', text: 'A sufficiently detailed editorial documentary frame at dawn' });
    state = appReducer(state, { type: 'SET_DESTINATION', path: '/tmp/imageforge-output' });
    const base = immediateAdapter();
    const adapter: ImageForgeAdapter = {
      ...base,
      queue: { ...base.queue, load: vi.fn(async () => snapshot) },
    };

    render(<App initialState={state} adapter={adapter} />);

    expect(await screen.findByText('Local queue is active')).toBeVisible();
    expect(screen.getByText('Finish the device queue before starting a direct batch')).toBeVisible();
    expect(screen.getByRole('button', { name: /Generate 1 images/i })).toBeDisabled();
  });

  it('runs a strict Generate preflight even while an advisory observation is in flight', async () => {
    vi.useFakeTimers();
    const production = productionAdapter();
    let releaseObservation!: () => void;
    vi.mocked(production.runtime.observe).mockImplementation(() => new Promise<void>((resolve) => {
      releaseObservation = resolve;
    }));
    let state = createConfiguredInitialState();
    state = appReducer(state, {
      type: 'SET_POD_PHASE',
      phase: 'ready',
      progress: 100,
      detail: 'Model warm',
      podId: 'pod-stopped-remotely',
      gpu: 'RTX 4090',
      vram: '24 GB',
      hourlyRate: 0.54,
    });
    state = appReducer(state, { type: 'SET_PROMPT_TEXT', text: 'A sufficiently detailed editorial documentary frame at dawn' });
    state = appReducer(state, { type: 'SET_DESTINATION', path: '/tmp/imageforge-output' });
    production.setAuthoritativePod({
      ...state.pod,
      phase: 'offline',
      phaseProgress: 0,
      statusDetail: 'GPU is safely offline',
      gpu: null,
      vram: null,
      hourlyRate: null,
      health: 'offline',
      podId: null,
      matchingPodIds: [],
    });

    render(<App initialState={state} adapter={production.adapter} />);
    await act(async () => { await Promise.resolve(); });
    expect(production.runtime.refresh).toHaveBeenCalledOnce();
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(production.runtime.observe).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: /Generate 1 images/i }));
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });

    expect(production.runtime.refresh).toHaveBeenCalledTimes(2);
    expect(production.runtime.startBatch).not.toHaveBeenCalled();
    await act(async () => {
      releaseObservation();
      await Promise.resolve();
    });
  });

  it('labels a read-only inventory refresh without implying that a GPU is starting', () => {
    let state = createConfiguredInitialState();
    state = appReducer(state, {
      type: 'SET_POD_PHASE',
      phase: 'selecting',
      progress: 4,
      detail: 'Checking approved Secure GPUs in EU-RO-1',
    });
    render(<App initialState={state} adapter={immediateAdapter()} />);

    expect(screen.getByText('checking inventory')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refreshing' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Starting' })).not.toBeInTheDocument();
  });

  it('routes production batch controls to the authoritative runtime without optimistic fake state', async () => {
    const user = userEvent.setup();
    const production = productionAdapter();
    const state = createDemoState();
    state.batch!.canManage = true;
    state.batch!.owner = 'Server Display Name';
    render(<App initialState={state} adapter={production.adapter} />);

    await user.click(screen.getByRole('button', { name: 'Pause after frame' }));
    expect(production.runtime.controlBatch).toHaveBeenCalledWith('pause', expect.objectContaining({ batch: expect.objectContaining({ phase: 'running' }) }));
    expect(screen.getByRole('button', { name: 'Pause after frame' })).toBeVisible();
    expect(production.adapter.runBatchClock).not.toHaveBeenCalled();
  });

  it('forgets a completed recovered batch before starting a new production brief', async () => {
    const user = userEvent.setup();
    const production = productionAdapter();
    const state = createDemoState();
    state.activeView = 'create';
    state.batch = { ...state.batch!, phase: 'complete', statusMessage: '1 image verified in order' };
    render(<App initialState={state} adapter={production.adapter} />);

    expect(screen.getByText('Previous batch still open')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'New brief' }));
    expect(production.runtime.beginNewBatch).toHaveBeenCalledOnce();
    expect(screen.getByRole('heading', { name: 'Finish these items' })).toBeVisible();
  });

  it('keeps polling while a local terminal batch is visible so a remote lease can replace it', async () => {
    const production = productionAdapter();
    const state = createDemoState();
    state.batch = { ...state.batch!, phase: 'complete', statusMessage: '1 image verified in order' };
    render(<App initialState={state} adapter={production.adapter} />);

    await waitFor(() => expect(production.runtime.pollBatch).toHaveBeenCalled());
  });

  it('disables Generate and shows finalizing truth for an adopted worker guard', async () => {
    const production = productionAdapter();
    let state = createConfiguredInitialState();
    state = appReducer(state, { type: 'SET_POD_PHASE', phase: 'ready', progress: 100, detail: 'Ready', podId: 'pod-guarded' });
    state = appReducer(state, { type: 'SET_PROMPT_TEXT', text: 'A sufficiently detailed editorial documentary frame at dawn' });
    state = appReducer(state, { type: 'SET_DESTINATION', path: '/tmp/imageforge-output' });
    render(<App initialState={state} adapter={production.adapter} />);

    act(() => production.emit({
      type: 'stop-guard-active',
      podId: 'pod-guarded',
      message: 'GPU Stop is finalizing; new generation is temporarily blocked.',
    }));

    expect(screen.getByText('Exact GPU termination is being finalized')).toBeVisible();
    expect(screen.getByText('GPU Stop is finalizing')).toBeVisible();
    expect(screen.getByRole('button', { name: /Generate 1 images/i })).toBeDisabled();
  });

  it('distinguishes an owned active batch from a remote batch lock', () => {
    const owned = createDemoState();
    owned.activeView = 'create';
    owned.batch = { ...owned.batch!, phase: 'validating', canManage: true };
    const ownedProduction = productionAdapter();
    const { unmount } = render(<App initialState={owned} adapter={ownedProduction.adapter} />);

    expect(screen.getAllByText('Your batch is active')).toHaveLength(2);
    expect(screen.queryByText('Another batch is already running')).not.toBeInTheDocument();
    expect(screen.getByText('Your batch · validating')).toBeVisible();

    unmount();
    const remote = appReducer(createConfiguredInitialState(), { type: 'PREVIEW_SCENARIO', scenario: 'locked' });
    remote.activeView = 'create';
    render(<App initialState={remote} adapter={immediateAdapter()} />);

    expect(screen.getAllByText('Another batch is already running')).toHaveLength(1);
    expect(screen.getByText('Sujal · locked')).toBeVisible();
    expect(screen.queryByText('Your batch is active')).not.toBeInTheDocument();
  });

  it('renders the exact paused state for a foreign locked batch', () => {
    const remote = appReducer(createConfiguredInitialState(), { type: 'PREVIEW_SCENARIO', scenario: 'locked' });
    remote.activeView = 'progress';
    remote.batch = {
      ...remote.batch!,
      remoteState: 'paused',
      statusMessage: 'Sujal paused after 73 of 450',
      lockMessage: 'Paused after 73 of 450 images were processed.',
    };
    render(<App initialState={remote} adapter={immediateAdapter()} />);

    expect(screen.getByText('Sujal paused this batch')).toBeVisible();
    expect(screen.getAllByText('Another user paused this batch')).toHaveLength(2);
    expect(screen.queryByText('Sujal is running this batch')).not.toBeInTheDocument();
  });

  it('renders a remote paused batch as interrupted after authoritative Offline truth', () => {
    let remote = appReducer(createConfiguredInitialState(), { type: 'PREVIEW_SCENARIO', scenario: 'locked' });
    remote.batch = { ...remote.batch!, remoteState: 'paused' };
    remote = appReducer(remote, {
      type: 'SYNC_RUNTIME_POD',
      pod: {
        ...remote.pod,
        phase: 'offline',
        phaseProgress: 0,
        statusDetail: 'GPU is safely offline',
        health: 'offline',
        podId: null,
        matchingPodIds: [],
      },
    });
    remote.activeView = 'progress';
    render(<App initialState={remote} adapter={immediateAdapter()} />);

    expect(document.querySelector('.progress-heading .phase-badge')).toHaveTextContent('interrupted');
    expect(screen.queryByText('Another user paused this batch')).not.toBeInTheDocument();
    expect(screen.getByText(/Sujal must resume or cancel this batch/)).toBeVisible();
  });

  it('blocks duplicate starts and exposes explicit ambiguous-create recovery', async () => {
    const user = userEvent.setup();
    const production = productionAdapter();
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);
    const listener = [...production.listeners][0];

    act(() => listener({
      type: 'create-recovery',
      marker: { attemptId: 'attempt-1', podName: 'imageforge-attempt-1', gpuId: 'gpu-1', podId: null },
    }));
    expect(screen.getByText('Interrupted RunPod start needs reconciliation')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Start GPU' })[0]).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Resolve start' }));
    expect(screen.getByRole('heading', { name: 'Confirm that no matching Pod exists' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'I confirmed no Pod exists' }));
    expect(production.runtime.resolveAmbiguousStart).toHaveBeenCalledOnce();
  });

  it('does not present an unresolved RunPod start as completed work', () => {
    const production = productionAdapter();
    const state = createConfiguredInitialState();
    state.pod = {
      ...state.pod,
      phase: 'error',
      phaseProgress: 100,
      statusDetail: 'RunPod may have created a Pod, but the result could not be confirmed.',
      errorMessage: 'RunPod may have created a Pod, but the result could not be confirmed.',
      createRecovery: {
        attemptId: 'attempt-1',
        podName: 'imageforge-attempt-1',
        gpuId: 'NVIDIA GeForce RTX 4090',
        podId: null,
      },
    };

    render(<App initialState={state} adapter={production.adapter} />);

    const track = screen.getByLabelText('Current status');
    expect(track).toHaveTextContent('RunPod start needs confirmation');
    expect(track).toHaveTextContent('—');
    expect(track).toHaveTextContent('eta action needed');
    expect(screen.getByRole('progressbar', { name: 'Current operation' })).toHaveAttribute('aria-valuenow', '0');
    expect(track).not.toHaveTextContent('100%');
  });

  it('navigates all five real destinations', async () => {
    const user = userEvent.setup();
    render(<App initialState={createConfiguredInitialState()} adapter={immediateAdapter()} />);

    for (const [label, heading] of [
      ['Progress', 'No batch running'],
      ['Library', 'Your images.'],
      ['Usage', 'Usage and cost'],
      ['Settings', 'Settings'],
      ['Create', 'New batch'],
    ] as const) {
      await user.click(screen.getByRole('button', { name: label }));
      expect(screen.getByRole('heading', { name: heading })).toBeVisible();
    }
  });

  it('shows plain batch availability and keeps the optional style instruction visible but off', () => {
    render(<App initialState={createConfiguredInitialState()} adapter={immediateAdapter()} />);

    expect(screen.getByText('Ready for a new batch')).toBeVisible();
    const styleToggle = screen.getByRole('checkbox', { name: /Optional style instruction/i });
    expect(styleToggle).not.toBeChecked();
    const styleEditor = screen.getByRole('textbox', { name: /Style instruction/i });
    expect(styleEditor).toBeVisible();
    fireEvent.change(styleEditor, { target: { value: 'soft daylight, documentary photography' } });
    expect(styleEditor).toHaveValue('soft daylight, documentary photography');
    expect(screen.getByText('Off — prompts are sent exactly as written.')).toBeVisible();
    expect(screen.queryByText('Shared batch lock available')).not.toBeInTheDocument();
  });

  it('keeps internal details out of Progress and reveals the actual named batch folder', async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const savedPrompt = state.batch!.prompts.find((prompt) => prompt.status === 'downloaded')!;
    savedPrompt.filename = 'batches/Atlas of Quiet Work/000001.jpg';
    const adapter = immediateAdapter();
    adapter.revealPath = vi.fn(async () => undefined);
    render(<App initialState={state} adapter={adapter} />);

    const progress = screen.getByRole('heading', { name: state.batch!.name }).closest('.progress-screen')!;
    expect(progress).not.toHaveTextContent(state.batch!.id);
    expect(progress).not.toHaveTextContent(/seed|checksum|receipt|sha-256|atomic rename|\.part/i);
    expect(progress).toHaveTextContent('saving images as they finish');
    await user.click(screen.getByRole('button', { name: 'Show in folder' }));
    expect(adapter.revealPath).toHaveBeenCalledWith(
      'batches/Atlas of Quiet Work/000001.jpg',
    );
    expect(state.batch!.prompts[0]).toMatchObject({ seed: expect.any(Number), checksum: expect.any(String) });
  });

  it('keeps a 450-image Progress queue incremental and seed-free', () => {
    const state = createDemoState();
    const template = state.batch!.prompts[0];
    state.batch!.prompts = Array.from({ length: 450 }, (_, index) => ({
      ...template,
      id: `prompt-${index + 1}`,
      index: index + 1,
      text: `Image prompt ${index + 1}`,
      seed: 200_000 + index,
      status: index === 0 ? ('generating' as const) : ('pending' as const),
      checksum: undefined,
      filename: undefined,
      durationSeconds: undefined,
    }));
    render(<App initialState={state} adapter={immediateAdapter()} />);

    const queue = screen.getByLabelText('450 prompts');
    expect(queue.querySelectorAll('.prompt-row').length).toBeLessThan(30);
    expect(queue).not.toHaveTextContent(/seed/i);
  });

  it('advances saved counts and live preview one image at a time from production events', () => {
    const production = productionAdapter();
    const state = createDemoState();
    state.activeView = 'progress';
    const source = state.batch!;
    const basePrompts = source.prompts.slice(0, 3).map((prompt, index) => ({
      ...prompt,
      index: index + 1,
      status: 'pending' as const,
      filename: undefined,
      checksum: undefined,
    }));
    render(<App initialState={{ ...state, batch: { ...source, prompts: basePrompts } }} adapter={production.adapter} />);
    const listener = [...production.listeners][0];
    const emitBatch = (statuses: readonly ('ready' | 'downloaded' | 'generating' | 'pending')[]) => {
      const prompts = basePrompts.map((prompt, index) => ({
        ...prompt,
        status: statuses[index],
        ...(statuses[index] === 'downloaded'
          ? { filename: `batches/Live progress/${String(index + 1).padStart(6, '0')}.jpg`, checksum: 'a'.repeat(64) }
          : {}),
      }));
      act(() => listener({
        type: 'batch',
        batch: { ...source, prompts, phase: 'running', statusMessage: 'Saving images as they finish' },
        assets: [],
      }));
    };

    emitBatch(['ready', 'generating', 'pending']);
    expect(screen.getByRole('heading', { name: 'Saving image 1 of 3' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Frame 001' })).toBeVisible();
    expect(screen.getByText('Preparing full image')).toBeVisible();
    expect(screen.getAllByText('0 saved').length).toBeGreaterThan(0);

    emitBatch(['downloaded', 'generating', 'pending']);
    expect(screen.getByRole('heading', { name: 'Creating image 2 of 3' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Frame 002' })).toBeVisible();
    expect(screen.getAllByText('1 saved').length).toBeGreaterThan(0);

    emitBatch(['downloaded', 'downloaded', 'generating']);
    expect(screen.getByRole('heading', { name: 'Creating image 3 of 3' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Frame 003' })).toBeVisible();
    expect(screen.getAllByText('2 saved').length).toBeGreaterThan(0);

    const firstPromptRow = screen.getAllByRole('button').find((button) =>
      button.textContent?.includes(basePrompts[0].text),
    );
    expect(firstPromptRow).toBeDefined();
    fireEvent.click(firstPromptRow!);
    expect(screen.getByRole('heading', { name: 'Frame 001' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Creating image 3 of 3' })).toBeVisible();

    emitBatch(['downloaded', 'downloaded', 'ready']);
    expect(screen.getByRole('heading', { name: 'Saving image 3 of 3' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Frame 001' })).toBeVisible();
    // Pause stops generation after the current frame, which is meaningless
    // once every image is generated and only saving remains.
    expect(screen.queryByRole('button', { name: 'Pause after frame' })).not.toBeInTheDocument();
    // Cancel must survive the saving tail. The batch is still running, and on a
    // long batch this tail is the stretch where the user has no other way out.
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New brief' })).not.toBeInTheDocument();
  });

  it('runs the critical fake Create-to-Progress flow with no backend', async () => {
    const user = userEvent.setup();
    render(<App initialState={createConfiguredInitialState()} adapter={immediateAdapter()} />);

    await user.click(screen.getByRole('button', { name: 'Load sample brief' }));
    await user.click(screen.getByRole('button', { name: /Choose output folder/i }));
    await user.click(screen.getAllByRole('button', { name: 'Start GPU' })[0]);

    await waitFor(() => expect(screen.getByRole('button', { name: /Generate 24 images/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /Generate 24 images/i }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Atlas of Quiet Work' })).toBeVisible());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause after frame' })).toBeVisible());
    await user.click(screen.getByRole('button', { name: 'Pause after frame' }));
    expect(screen.getByRole('button', { name: 'Resume' })).toBeVisible();
  });

  it('completes every asynchronous phase with the production fake adapter', async () => {
    vi.useFakeTimers();
    const configured = createConfiguredInitialState();
    const fastest = {
      ...configured,
      settings: { ...configured.settings, gpuPreference: 'fastest' as const, slowEmergencyGpuEnabled: true },
    };
    render(<App initialState={fastest} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Start GPU' })[0]);
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(screen.getByText(/RTX 2000 Ada enabled as the final slow emergency fallback/)).toBeVisible();
    await act(async () => {
      vi.advanceTimersByTime(2_700);
      await Promise.resolve();
    });

    expect(screen.getAllByText('GPU ready').length).toBeGreaterThan(0);
    expect(screen.getAllByText('RTX 5090').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Stop GPU' }).length).toBeGreaterThan(0);
  });

  it('requires a genuine first-run setup and never reuses the name node as a password field', async () => {
    const user = userEvent.setup();
    render(<App initialState={createInitialState()} adapter={immediateAdapter(false)} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(document.querySelector('.app-shell')).toHaveAttribute('inert');

    await user.type(screen.getByRole('textbox', { name: 'Your name' }), 'Lakshman');
    const firstContinue = screen.getByRole('button', { name: 'Continue' });
    await waitFor(() => expect(firstContinue).toBeEnabled());
    await user.click(firstContinue);
    await screen.findByRole('heading', { name: 'Connect RunPod.' });
    const apiKey = screen.getByPlaceholderText('Paste restricted key') as HTMLInputElement;
    expect(apiKey.value).toBe('');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Paste a RunPod API key');

    const requiredApiKey = screen.getByPlaceholderText('Paste restricted key') as HTMLInputElement;
    await user.type(requiredApiKey, 'runpod-secret-1234');
    expect(requiredApiKey.value).toBe('runpod-secret-1234');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Bring in the studio profile.' });
    const workerToken = screen.getByPlaceholderText('Paste personal worker token') as HTMLInputElement;
    expect(workerToken.value).toBe('');
    await user.type(workerToken, 'worker-secret-5678');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await user.click(await screen.findByRole('button', { name: /Pictures\/ImageForge/i }));
    await user.click(await screen.findByRole('button', { name: 'Run connection test' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'New batch' })).toBeVisible();
  });

  it('moves keyboard focus to the first control on every setup step', async () => {
    const user = userEvent.setup();
    render(<App initialState={createInitialState()} adapter={immediateAdapter(false)} />);

    const name = screen.getByRole('textbox', { name: 'Your name' });
    expect(name).toHaveFocus();
    await user.type(name, 'Lakshman');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const apiKey = await screen.findByPlaceholderText('Paste restricted key');
    expect(apiKey).toHaveFocus();
    await user.type(apiKey, 'runpod-secret-1234');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const profile = await screen.findByRole('textbox', { name: 'Connection profile' });
    expect(profile).toHaveFocus();
    const workerToken = screen.getByPlaceholderText('Paste personal worker token');
    await user.type(workerToken, 'worker-secret-5678');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('button', { name: /Pictures\/ImageForge/i })).toHaveFocus();
  });

  it('clears prior destination validation when the native folder chooser is cancelled', async () => {
    const user = userEvent.setup();
    const configured = createConfiguredInitialState();
    const adapter = { ...immediateAdapter(), chooseDestination: async () => null };
    render(<App initialState={{ ...configured, setup: { ...configured.setup, completed: false } }} adapter={adapter} />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Connect RunPod.' });
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Bring in the studio profile.' });
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const chooser = await screen.findByRole('button', { name: /Pictures\/ImageForge/i });
    expect(screen.getByText('Folder ready')).toBeVisible();
    await user.click(chooser);
    await waitFor(() => expect(screen.queryByText('Folder ready')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Run connection test' })).toBeDisabled();
  });

  it('closes a portaled confirmation with Escape and restores trigger focus', async () => {
    const user = userEvent.setup();
    let state = createConfiguredInitialState();
    state = appReducer(state, { type: 'SET_POD_PHASE', phase: 'ready', progress: 100, detail: 'Ready', podId: 'pod-test' });
    render(<App initialState={state} adapter={immediateAdapter()} />);

    const trigger = screen.getByRole('button', { name: 'Stop GPU' });
    await user.click(trigger);
    expect(screen.getByRole('alertdialog')).toBeVisible();
    expect(document.querySelector('.app-shell')).toHaveAttribute('inert');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('surfaces a failed batch cancel instead of silently doing nothing', async () => {
    const user = userEvent.setup();
    const production = productionAdapter();
    // The worker that hosted this batch is gone, so the RunPod proxy answers
    // instead and native rejects the body. The user must be told; a Cancel
    // that quietly fails leaves no way to tell it from a Cancel that worked.
    production.runtime.controlBatch = vi.fn(async () => {
      throw {
        code: 'worker_schema_mismatch',
        message: 'The worker API version is incompatible with this ImageForge app.',
        retryable: false,
      };
    });
    render(<App initialState={createDemoState()} adapter={production.adapter} />);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel remaining' }));

    expect(await screen.findByText(/incompatible with this ImageForge app/i)).toBeVisible();
  });

  it('routes production Stop straight to termination with no approval step', async () => {
    const user = userEvent.setup();
    const production = productionAdapter();
    let state = createConfiguredInitialState();
    state = appReducer(state, { type: 'SET_POD_PHASE', phase: 'ready', progress: 100, detail: 'Ready', podId: 'pod-exact-1', gpu: 'RTX 4090' });
    render(<App initialState={state} adapter={production.adapter} />);

    await user.click(screen.getByRole('button', { name: 'Stop GPU' }));
    // The confirm control now carries the same plain label as the trigger,
    // because there is no coordinated request to describe. The confirm is the
    // one rendered last, inside the modal.
    const stopButtons = await screen.findAllByRole('button', { name: 'Stop GPU' });
    await user.click(stopButtons[stopButtons.length - 1]);

    expect(production.runtime.requestGpuStop).toHaveBeenCalledWith(
      expect.objectContaining({ pod: expect.objectContaining({ podId: 'pod-exact-1', phase: 'ready' }) }),
    );
    expect(screen.getByText('Checking for an active batch before stopping')).toBeVisible();
    expect(screen.queryByText('Terminating the confirmed ImageForge Pod')).not.toBeInTheDocument();
  });

  it('exposes owner resume and cancel controls for a restarted interrupted batch', async () => {
    const user = userEvent.setup();
    let state = createDemoState();
    state = appReducer(state, { type: 'CONFIRM_STOP_POD' });
    state = appReducer(state, { type: 'POD_STOPPED' });
    state = appReducer(state, { type: 'SET_POD_PHASE', phase: 'ready', progress: 100, detail: 'Ready', podId: 'pod-next' });
    render(<App initialState={state} adapter={immediateAdapter()} />);

    expect(screen.getByRole('button', { name: 'Cancel interrupted batch' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Resume interrupted batch' }));
    expect(screen.getByRole('button', { name: 'Pause after frame' })).toBeVisible();
  });

  it('routes credential replacement into the relevant setup step', async () => {
    const user = userEvent.setup();
    render(<App initialState={{ ...createConfiguredInitialState(), activeView: 'settings' }} adapter={immediateAdapter()} />);

    const replaceButtons = screen.getAllByRole('button', { name: 'Replace' });
    await user.click(replaceButtons[0]);
    expect(screen.getByRole('heading', { name: 'Connect RunPod.' })).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers worker credential replacement after an authentication failure', async () => {
    const user = userEvent.setup();
    const production = productionAdapter();
    const state = createDemoState();
    state.activeView = 'progress';
    render(<App initialState={state} adapter={production.adapter} />);
    const listener = [...production.listeners][0];

    act(() => listener({
      type: 'error',
      scope: 'batch',
      code: 'authentication_required',
      message: 'A valid worker bearer credential is required.',
      retryable: false,
    }));

    expect(screen.getByRole('button', { name: 'Replace worker credential' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Replace worker credential' }));
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  it('allows replacing the worker credential while an idle GPU remains attached', async () => {
    const user = userEvent.setup();
    const production = productionAdapter();
    let state = createConfiguredInitialState();
    state.activeView = 'settings';
    state = appReducer(state, {
      type: 'SET_POD_PHASE',
      phase: 'ready',
      progress: 100,
      detail: 'Model warm',
      podId: 'pod-ui-test',
      gpu: 'RTX 4090',
      vram: '24 GB',
      hourlyRate: 0.54,
    });
    render(<App initialState={state} adapter={production.adapter} />);

    const replaceButtons = screen.getAllByRole('button', { name: 'Replace' });
    expect(replaceButtons[1]).toBeEnabled();
    await user.click(replaceButtons[1]);
    const workerToken = screen.getByLabelText('Worker token');
    await user.type(workerToken, 'worker-secret-new');
    await user.click(screen.getByRole('button', { name: 'Save worker credential' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('Worker credential replaced')).toBeVisible();
  });

  it('allows replacing the RunPod API key while an idle GPU remains attached', async () => {
    const user = userEvent.setup();
    const production = productionAdapter();
    let state = createConfiguredInitialState();
    state.activeView = 'settings';
    state = appReducer(state, {
      type: 'SET_POD_PHASE',
      phase: 'ready',
      progress: 100,
      detail: 'Model warm',
      podId: 'pod-ui-test',
      gpu: 'RTX 4090',
      vram: '24 GB',
      hourlyRate: 0.54,
    });
    render(<App initialState={state} adapter={production.adapter} />);

    const replaceButtons = screen.getAllByRole('button', { name: 'Replace' });
    expect(replaceButtons[0]).toBeEnabled();
    await user.click(replaceButtons[0]);
    const apiKey = screen.getByLabelText('RunPod API key');
    await user.type(apiKey, 'runpod-secret-new');
    await user.click(screen.getByRole('button', { name: 'Save RunPod API key' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('RunPod API key replaced')).toBeVisible();
  });

  it('persists a paused run before native lease acquisition, then authorizes dispatch', async () => {
    const user = userEvent.setup();
    const base = createMemoryQueueHost(queueSnapshot(queuedItem()));
    const events: string[] = [];
    const queue: QueueHostPort = {
      ...base,
      commit: vi.fn(async (input) => {
        events.push(`commit:${input.document.run?.runnerState ?? 'none'}`);
        return base.commit(input);
      }),
      acquireRunner: vi.fn(async (input) => {
        events.push('acquire');
        return base.acquireRunner(input);
      }),
    };
    let state = createConfiguredInitialState();
    state = appReducer(state, { type: 'SET_POD_PHASE', phase: 'ready', progress: 100, detail: 'Model warm', podId: 'pod-ui-test' });
    render(<App initialState={state} adapter={{ ...immediateAdapter(), queue }} />);

    await user.click(await screen.findByRole('button', { name: 'Run queue' }));
    await waitFor(() => expect(events).toContain('commit:running'));
    expect(events.slice(0, 3)).toEqual(['commit:paused', 'acquire', 'commit:running']);
  });

  it('does not submit a prepared batch when Pause wins before the dispatch transition', async () => {
    const user = userEvent.setup();
    const base = createMemoryQueueHost(queueSnapshot(queuedItem()));
    let releasePrepared!: () => void;
    const preparedGate = new Promise<void>((resolve) => { releasePrepared = resolve; });
    const prepareStarted = vi.fn();
    const queue: QueueHostPort = {
      ...base,
      prepareDispatch: vi.fn(async (input) => {
        const payload = await base.prepareDispatch(input);
        prepareStarted();
        await preparedGate;
        return payload;
      }),
    };
    const production = productionAdapter();
    let state = createConfiguredInitialState();
    state = appReducer(state, {
      type: 'SET_POD_PHASE',
      phase: 'ready',
      progress: 100,
      detail: 'Model warm',
      podId: 'pod-ui-test',
    });
    production.setAuthoritativePod(state.pod);
    render(<App initialState={state} adapter={{ ...production.adapter, queue }} />);

    await user.click(await screen.findByRole('button', { name: 'Run queue' }));
    await waitFor(() => expect(prepareStarted).toHaveBeenCalledOnce());
    await user.click(screen.getByRole('button', { name: 'Pause after current' }));
    await waitFor(async () => expect((await base.load()).document.run).toMatchObject({
      runnerState: 'paused',
      authorizationRequired: true,
    }));
    releasePrepared();

    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(production.runtime.startBatch).not.toHaveBeenCalled();
    expect((await base.load()).document.items[0]).toMatchObject({ state: 'staged' });
  });

  it('does not start the worker when Pause is durable before the validating effect', async () => {
    const item: NativeQueueItemV1 = {
      ...queuedItem(),
      recordRevision: 3,
      runRevision: QUEUE_RUN_ID,
      state: 'dispatching',
    };
    const snapshot = queueSnapshot(item);
    const host = createMemoryQueueHost(snapshot);
    const production = productionAdapter();
    let state = withQueueSnapshot(snapshot);
    state = appReducer(state, {
      type: 'SET_POD_PHASE',
      phase: 'ready',
      progress: 100,
      detail: 'Model warm',
      podId: 'pod-ui-test',
    });
    state = appReducer(state, {
      type: 'QUEUE_DISPATCH_ITEM',
      payload: {
        queueItemId: item.queueItemId,
        clientSubmissionId: item.clientSubmissionId,
        name: item.name,
        prompts: item.prompts,
        baseSeed: item.baseSeed,
        destination: item.destination,
        aspectRatio: item.aspectRatio,
        references: [],
      },
      startedAt: '2026-08-03T12:00:01.000Z',
    });

    render(<App initialState={state} adapter={{ ...production.adapter, queue: host }} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    expect(production.runtime.startBatch).not.toHaveBeenCalled();
    expect((await host.load()).document.run).toMatchObject({
      runnerState: 'paused',
      authorizationRequired: true,
    });
  });

  it('does exact submission lookup before status and destination preflight on Resume', async () => {
    const user = userEvent.setup();
    const production = productionAdapter();
    const base = createMemoryQueueHost(queueSnapshot(queuedItem('needs_attention')));
    const events: string[] = [];
    const queue: QueueHostPort = {
      ...base,
      prepareDispatch: vi.fn(async (input) => {
        events.push('prepare');
        return base.prepareDispatch(input);
      }),
    };
    const adapter = { ...production.adapter, queue };
    production.runtime.reconcileQueueSubmission = vi.fn(async () => {
      events.push('lookup');
      return null;
    });
    production.runtime.refresh = vi.fn(async () => { events.push('status'); });
    let state = createConfiguredInitialState();
    state = appReducer(state, { type: 'SET_POD_PHASE', phase: 'ready', progress: 100, detail: 'Model warm', podId: 'pod-ui-test' });
    production.setAuthoritativePod(state.pod);
    render(<App initialState={state} adapter={adapter} />);

    const resume = await screen.findByRole('button', { name: 'Resume queue' });
    events.length = 0;
    await user.click(resume);
    await waitFor(() => expect(events).toContain('prepare'));
    expect(events.indexOf('lookup')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('lookup')).toBeLessThan(events.indexOf('status'));
    expect(events.indexOf('status')).toBeLessThan(events.indexOf('prepare'));
  });

  it('removes an assigned reference-damaged row under a short exact runner lease only', async () => {
    const user = userEvent.setup();
    const damaged = {
      ...queuedItem('needs_attention'),
      attentionCode: 'queue_reference_missing',
    };
    const initial = queueSnapshot(damaged);
    const base = createMemoryQueueHost(initial);
    const acquireRunner = vi.spyOn(base, 'acquireRunner');
    const releaseRunner = vi.spyOn(base, 'releaseRunner');
    const production = productionAdapter();
    const state = withQueueSnapshot(initial);
    render(<App initialState={state} adapter={{ ...production.adapter, queue: base }} />);

    await user.click(await screen.findByRole('button', { name: 'Remove damaged item Overnight editorial' }));

    await waitFor(async () => {
      expect((await base.load()).document.items[0]).toMatchObject({
        state: 'cancelled',
        attentionCode: null,
        runRevision: QUEUE_RUN_ID,
      });
    });
    expect(acquireRunner).toHaveBeenCalledWith({ runRevision: QUEUE_RUN_ID });
    expect(releaseRunner).toHaveBeenCalledWith({ runRevision: QUEUE_RUN_ID });
    expect(production.runtime.startGpu).not.toHaveBeenCalled();
    expect(production.runtime.requestGpuStop).not.toHaveBeenCalled();
    expect(production.runtime.startBatch).not.toHaveBeenCalled();
  });

  it('persists the exact non-retryable worker code when queue error effects race', async () => {
    const production = productionAdapter();
    const host = createMemoryQueueHost();
    const item = queuedItem();
    const stagedDocument = { schemaVersion: 1 as const, items: [item], run: null, alarm: null };
    await host.commit({ expectedRevision: 0, document: stagedDocument, referenceBlobs: [] });
    const paused = createQueueRun(stagedDocument, QUEUE_RUN_ID, false, false);
    await host.commit({ expectedRevision: 1, document: paused, referenceBlobs: [] });
    await host.acquireRunner({ runRevision: QUEUE_RUN_ID });
    const running = updateQueueRun(paused, { runnerState: 'running', authorizationRequired: false });
    await host.commit({ expectedRevision: 2, document: running, referenceBlobs: [] });
    const dispatching = updateQueueItem(running, QUEUE_ITEM_ID, { state: 'dispatching', attentionCode: null }, '2026-08-03T12:01:00.000Z');
    const snapshot = await host.commit({ expectedRevision: 3, document: dispatching, referenceBlobs: [] });

    let state = withQueueSnapshot(snapshot);
    state = appReducer(state, {
      type: 'SET_POD_PHASE',
      phase: 'ready',
      progress: 100,
      detail: 'Model warm',
      podId: 'pod-ui-test',
    });
    state = appReducer(state, {
      type: 'QUEUE_DISPATCH_ITEM',
      payload: {
        queueItemId: item.queueItemId,
        clientSubmissionId: item.clientSubmissionId,
        name: item.name,
        prompts: item.prompts,
        baseSeed: item.baseSeed,
        destination: item.destination,
        aspectRatio: item.aspectRatio,
        references: [],
      },
      startedAt: '2026-08-03T12:01:00.000Z',
    });
    render(<App initialState={state} adapter={{ ...production.adapter, queue: host }} />);
    await waitFor(() => expect(production.listeners.size).toBe(1));

    act(() => production.emit({
      type: 'error',
      scope: 'batch',
      code: 'submission_store_corrupt',
      message: 'The worker submission store needs operator repair.',
      retryable: false,
    }));

    await waitFor(async () => {
      const row = (await host.load()).document.items[0];
      expect(row).toMatchObject({ state: 'needs_attention', attentionCode: 'submission_store_corrupt' });
    });
  });

  it('requires explicit confirmation to quarantine an unrecoverable queue without mutating the Pod', async () => {
    const user = userEvent.setup();
    const production = productionAdapter();
    const base = createMemoryQueueHost();
    const resetSnapshot: NativeQueueSnapshotV1 = {
      schemaVersion: 1,
      storeRevision: 0,
      document: { schemaVersion: 1, items: [], run: null, alarm: null },
      issues: [],
    };
    const reset = vi.fn(async () => resetSnapshot);
    const adapter = { ...production.adapter, queue: {
      ...base,
      load: vi.fn(async () => { throw new QueueStoreError('queue_store_unrecoverable', 'No valid generation remains.'); }),
      reset,
    } };
    render(<App initialState={createConfiguredInitialState()} adapter={adapter} />);

    await user.click(await screen.findByRole('button', { name: 'Reset local queue…' }));
    expect(screen.getByRole('heading', { name: 'Reset the unrecoverable local queue?' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Keep queue files' }));
    expect(reset).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Reset local queue…' }));
    await user.click(screen.getByRole('button', { name: 'Reset local queue' }));
    await waitFor(() => expect(reset).toHaveBeenCalledWith({ confirmation: 'RESET LOCAL QUEUE' }));
    expect(production.runtime.startGpu).not.toHaveBeenCalled();
    expect(production.runtime.requestGpuStop).not.toHaveBeenCalled();
    expect(production.runtime.startBatch).not.toHaveBeenCalled();
  });

  it('retries one failed notification once after relaunch and never loops in one process', async () => {
    const initial = ringingQueueSnapshot('failed');
    let deliveryAttempt = 0;
    const base = createMemoryQueueHost(initial, {
      deliverAlert: () => deliveryAttempt++ === 0 ? 'failed' : 'delivered',
    });
    const signalAlert = vi.spyOn(base, 'signalAlert');
    const adapter = { ...immediateAdapter(), queue: base };
    const first = render(<App initialState={withQueueSnapshot(initial)} adapter={adapter} />);

    await waitFor(() => expect(signalAlert).toHaveBeenCalledTimes(1));
    await waitFor(async () => expect((await base.load()).document.alarm?.notificationDisposition).toBe('failed'));
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 25)); });
    expect(signalAlert).toHaveBeenCalledTimes(1);
    first.unmount();

    const recovered = await base.load();
    render(<App initialState={withQueueSnapshot(recovered)} adapter={adapter} />);
    await waitFor(() => expect(signalAlert).toHaveBeenCalledTimes(2));
    await waitFor(async () => expect((await base.load()).document.alarm?.notificationDisposition).toBe('delivered'));
    expect(signalAlert).toHaveBeenCalledTimes(2);
  });

  it('does not let a stale snooze timer resurrect an acknowledged alarm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const snapshot = ringingQueueSnapshot('delivered');
    snapshot.document.alarm = {
      ...snapshot.document.alarm!,
      state: 'snoozed',
      snoozeUsed: true,
      snoozeDueAt: '2026-08-03T12:00:01.000Z',
      snoozeNotificationDisposition: null,
    };
    const host = createMemoryQueueHost(snapshot);
    const alarmPort = {
      test: vi.fn(async () => undefined),
      ring: vi.fn(async () => undefined),
      stop: vi.fn(),
      dispose: vi.fn(),
    };
    render(<App initialState={withQueueSnapshot(snapshot)} adapter={{ ...immediateAdapter(), queue: host }} alarmPort={alarmPort} />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss alarm' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect((await host.load()).document.alarm?.state).toBe('acknowledged');

    await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve(); });
    expect((await host.load()).document.alarm?.state).toBe('acknowledged');
    expect(alarmPort.ring).not.toHaveBeenCalled();
  });
});
