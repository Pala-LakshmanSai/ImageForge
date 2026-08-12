import { describe, expect, it, vi } from 'vitest';
import type { NativeGpuInventorySnapshotV1, RunPodSnapshot } from '@imageforge/runpod-client';
import { createConfiguredInitialState } from '../domain/reducer';
import type { CredentialMetadataMap } from '../domain/types';
import { DEFAULT_STUDIO_PROFILE } from './imageForgeAdapter';
import { GpuLifecycleCoordinator } from './gpuLifecycleCoordinator';
import { createMemoryQueueHost } from './queueStore';
import {
  createProductionImageForgeAdapter,
  type ProductionDesktopPort,
  type ProductionRuntimeEvent,
} from './productionImageForgeAdapter';
import type { NativeGpuPodObservationV1, NativeGpuPodPort } from '../native/gpuPodBridge';
import type { NativeGpuSwitchSnapshotV1 } from '../native/gpuSwitchBridge';

const batchId = '11111111-1111-4111-8111-111111111111';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function manifest() {
  return {
    schema_version: 1,
    batch_id: batchId,
    owner: { user_id: 'lakshman', display_name: 'Lakshman' },
    state: 'completed',
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T10:01:00.000Z',
    completed_at: '2026-08-01T10:01:00.000Z',
    interrupted_at: null,
    pause_requested: false,
    cancel_requested: false,
    images: [{
      index: 1,
      prompt: 'A documentary shipyard at dawn',
      seed: 700,
      status: 'downloaded',
      attempts: 1,
      retry_rounds: 0,
      filename: 'artifacts/000001.jpg',
      sha256: 'a'.repeat(64),
      size_bytes: 2_048,
      generation_ms: 8_100,
      error: null,
      receipt: { sha256: 'a'.repeat(64), size_bytes: 2_048, acknowledged_at: '2026-08-01T10:01:00.000Z' },
    }],
    progress: { total: 1, completed: 1, downloaded: 1, failed: 0, cancelled: 0, processed: 1, current_index: null },
  };
}

function credentials(): CredentialMetadataMap {
  return {
    runpodApiKey: { configured: true, suffix: 'K7P9', provider: 'macOS Keychain' },
    workerToken: { configured: true, suffix: 'F2M4', provider: 'macOS Keychain' },
  };
}

function studioState(sessionId: string) {
  return {
    schema_version: 1,
    server_instance_id: '22222222-2222-4222-8222-222222222222',
    coordination_revision: 1,
    server_time: '2026-08-01T10:00:00.000Z',
    presence_ttl_seconds: 12,
    response_ttl_seconds: 30,
    finalization_ttl_seconds: 10,
    current_session: {
      session_id: sessionId,
      display_name: 'Lakshman',
      availability: 'foreground',
      expires_at: '2026-08-01T10:00:12.000Z',
    },
    sessions: [{
      session_id: sessionId,
      display_name: 'Lakshman',
      availability: 'foreground',
      expires_at: '2026-08-01T10:00:12.000Z',
    }],
    active_batch: null,
    gpu_switch_can_respond: false,
    gpu_switch_request: null,
    stop_request: null,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: status === 204 ? undefined : { 'content-type': 'application/json' },
  });
}

function runPodPod() {
  return {
    id: 'pod-exact-1',
    name: 'imageforge-existing',
    desiredStatus: 'RUNNING',
    gpu: { id: 'NVIDIA GeForce RTX 4090', displayName: 'RTX 4090', count: 1 },
    templateId: 'q8sfgixfy2',
    interruptible: false,
    networkVolume: { id: 'ukh207b26r', dataCenterId: 'EU-RO-1' },
    volumeMountPath: '/workspace',
    machine: { secureCloud: true, dataCenterId: 'EU-RO-1' },
    ports: ['8000/http'],
    adjustedCostPerHr: 0.54,
    costPerHr: 0.54,
    createdAt: '2026-08-01T10:00:00.000Z',
  };
}

function workerHealth() {
  return {
    schema_version: 1,
    service: 'imageforge-worker',
    // Mirrors the released worker. The binding guard against the worker's
    // own constants lives in src/adapters/workerHealthContract.test.ts.
    version: '0.2.0',
    process: { status: 'ok', uptime_ms: 100 },
    model: {
      id: 'Comfy-Org/Mage-Flow',
      revision: 'd8c99241f6fa80fbd453014234af2bf337ea21e6',
      precision: 'bfloat16',
      status: 'ready',
    },
    gpu: {
      state: 'ready',
      available: true,
      approved: true,
      name: 'NVIDIA GeForce RTX 4090',
      device_count: 1,
    },
    phase: 'ready',
    phase_progress: 1,
  };
}

function productionRunPodFetch(deletes: string[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/catalog/datacenters')) {
      return jsonResponse({ dataCenters: [{ id: 'EU-RO-1', networkVolumeTypes: ['STANDARD'] }] });
    }
    if (url.includes('/catalog/gpus')) {
      return jsonResponse({
        gpus: [{
          id: 'NVIDIA GeForce RTX 4090',
          name: 'RTX 4090',
          manufacturer: 'NVIDIA',
          memory: 24,
          secure: true,
          price: { secure: 0.54 },
          maxCount: { secure: 1 },
          dataCenters: [{ id: 'EU-RO-1', availability: 'HIGH' }],
        }],
      });
    }
    if (init?.method === 'DELETE') {
      deletes.push(url);
      return jsonResponse(null, 204);
    }
    if (url.includes('/pods/pod-exact-1?')) return jsonResponse(runPodPod());
    if (url.includes('/pods?')) return jsonResponse([runPodPod()]);
    throw new Error(`Unexpected RunPod request: ${url}`);
  }) as unknown as typeof fetch;
}

function offlineRunPodFetch() {
  const base = productionRunPodFetch([]);
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/pods/pod-exact-1?')) {
      return jsonResponse({ error: { code: 'pod_not_found', message: 'Pod is offline.' } }, 404);
    }
    if (url.includes('/pods?')) return jsonResponse([]);
    return base(input, init);
  }) as unknown as typeof fetch;
}

function gpuPodObservation(podPresent: boolean): NativeGpuPodObservationV1 {
  return Object.freeze({
    schemaVersion: 1,
    processEpochId: '50000000-0000-4000-8000-000000000000',
    lifecycleRevision: 1,
    state: podPresent ? 'single' : 'offline',
    observedAt: '2026-08-04T00:00:00.000Z',
    stale: false,
    pods: podPresent
      ? Object.freeze([Object.freeze({
          podId: 'pod-exact-1',
          gpuId: 'NVIDIA GeForce RTX 4090',
          gpuDisplayName: 'RTX 4090',
          hourlyPriceMicroUsd: 540_000,
          status: 'running' as const,
        })])
      : Object.freeze([]),
    overflow: false,
    issue: null,
  });
}

function gpuPodPort(podPresent: boolean): NativeGpuPodPort {
  const observation = gpuPodObservation(podPresent);
  return {
    observe: vi.fn(async () => observation),
    loadNormalStop: vi.fn(async () => null),
    normalStop: vi.fn(async (input) => ({
      schemaVersion: 1,
      operationId: '60000000-0000-4000-8000-000000000000',
      podId: input.podId,
      disposition: 'stopped',
      observation: gpuPodObservation(false),
      issue: null,
    } as const)),
  };
}

function readyGpuInventory(): NativeGpuInventorySnapshotV1 {
  const processEpochId = '10000000-0000-4000-8000-000000000000';
  const observationId = '20000000-0000-4000-8000-000000000000';
  const receiptId = '30000000-0000-4000-8000-000000000000';
  const observedAt = '2026-08-04T00:00:00.000Z';
  return {
    schemaVersion: 1,
    observationId,
    processEpochId,
    includeEmergencyTier: false,
    state: 'ready',
    observedAt,
    receipt: {
      schemaVersion: 1,
      receiptId,
      processEpochId,
      receivedAt: observedAt,
      validForMs: 60_000,
      catalogSha256: 'a'.repeat(64),
    },
    offers: [{
      schemaVersion: 1,
      observationId,
      receiptId,
      gpuId: 'NVIDIA GeForce RTX 4090',
      policyKey: 'rtx_4090',
      displayName: 'RTX 4090',
      memoryGb: 24,
      emergency: false,
      availability: 'high',
      hourlyPriceMicroUsd: 500_000,
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
    }],
    currentPod: null,
    currentPodObservedAt: null,
    currentPodStale: false,
    issue: null,
  };
}

function port(overrides: Partial<ProductionDesktopPort> = {}): ProductionDesktopPort {
  const unusedFetch = vi.fn(async () => { throw new Error('unused'); }) as unknown as typeof fetch;
  const unusedSwitch = async (): Promise<never> => { throw new Error('unused GPU Switch'); };
  const inventory = readyGpuInventory();
  return {
    ...createMemoryQueueHost(),
    workerHealthFetch: unusedFetch,
    bindProfile: vi.fn(async () => undefined),
    authorizeStart: vi.fn(async () => undefined),
    clearStartAuthorization: vi.fn(async () => undefined),
    createMarkerMetadata: vi.fn(async () => ({ pending: false, attemptId: null, podName: null, gpuId: null, podId: null })),
    resolveCreateMarker: vi.fn(async () => undefined),
    reconcileReceipts: vi.fn(async () => ({ schemaVersion: 1, batchId, receipts: [] })),
    revealDestination: vi.fn(async () => undefined),
    fetchPreview: vi.fn(async () => ({ contentType: 'image/webp' as const, sha256: 'a'.repeat(64), sizeBytes: 12, bytes: [] })),
    downloadAsset: vi.fn(async () => '/safe/downloads/Atlas of Quiet Work - 001.jpg'),
    writeManifest: vi.fn(async (batchId) => `${batchId}/manifest.csv`),
    clearWorkerSession: vi.fn(async () => undefined),
    chooseDestination: vi.fn(async (path) => ({ path, writable: true })),
    validateDestination: vi.fn(async (path) => ({ path, writable: true })),
    credentialMetadata: vi.fn(async () => credentials()),
    replaceCredential: vi.fn(async (_kind, value) => ({ configured: true, suffix: value.slice(-4), provider: 'macOS Keychain' })),
    status: vi.fn(async () => ({ status: 200, body: { schema_version: 1, ready: true, active_batch: null, permissions: { can_create: true, can_manage_active: false, is_owner: false, create_block_reason: null } } })),
    studioHeartbeat: vi.fn(async (sessionId) => ({ status: 200, body: studioState(sessionId) })),
    studioStatus: vi.fn(async (sessionId) => ({ status: 200, body: studioState(sessionId) })),
    studioCreateStopRequest: vi.fn(async (_requestId, sessionId) => ({ status: 201, body: studioState(sessionId) })),
    studioRespondToStopRequest: vi.fn(async (_requestId, sessionId) => ({ status: 200, body: studioState(sessionId) })),
    studioRespondToGpuSwitch: vi.fn(async (_switchId, sessionId) => ({ status: 200, body: studioState(sessionId) })),
    studioCancelStopRequest: vi.fn(async (_requestId, sessionId) => ({ status: 200, body: studioState(sessionId) })),
    createBatch: vi.fn(async () => ({ status: 201, body: manifest() })),
    getBatch: vi.fn(async () => ({ status: 200, body: manifest() })),
    pauseBatch: vi.fn(async () => ({ status: 200, body: manifest() })),
    resumeBatch: vi.fn(async () => ({ status: 200, body: manifest() })),
    cancelBatch: vi.fn(async () => ({ status: 200, body: manifest() })),
    retryFailed: vi.fn(async () => ({ status: 200, body: manifest() })),
    readReceipts: vi.fn(async () => [{
      schemaVersion: 1 as const,
      batchId,
      index: 1,
      filename: `batches/${batchId}/000001.jpg`,
      sha256: 'a'.repeat(64),
      sizeBytes: 2_048,
      verifiedAtUnixMs: 1,
    }]),
    downloadArtifact: vi.fn(async () => { throw new Error('already reconciled'); }),
    ...overrides,
    gpuInventory: overrides.gpuInventory ?? {
      load: vi.fn(async () => inventory),
      beginRefresh: vi.fn(async () => inventory),
      listen: vi.fn(async () => () => undefined),
    },
    gpuStart: overrides.gpuStart ?? {
      load: vi.fn(async () => null),
      startAuto: vi.fn(async () => ({
        schemaVersion: 1,
        operationId: '40000000-0000-4000-8000-000000000000',
        lifecycleRevision: 1,
        state: 'create_intent',
        pod: null,
        confirmedHourlyPriceMicroUsd: 500_000,
        actualHourlyPriceMicroUsd: null,
        issue: null,
      } as const)),
      startSelected: vi.fn(async () => { throw new Error('unused selected Start'); }),
      confirmActualPrice: vi.fn(async () => { throw new Error('unused price confirmation'); }),
    },
    gpuPod: overrides.gpuPod ?? gpuPodPort(true),
    gpuSwitch: overrides.gpuSwitch ?? {
      load: unusedSwitch,
      authorizeForeground: unusedSwitch,
      begin: unusedSwitch,
      acquire: unusedSwitch,
      release: unusedSwitch,
      syncWorker: unusedSwitch,
      finalize: unusedSwitch,
      confirmTarget: unusedSwitch,
      deleteOld: unusedSwitch,
      prepareAttempt: unusedSwitch,
      confirmAttempt: unusedSwitch,
      createReplacement: unusedSwitch,
      confirmActualPrice: unusedSwitch,
      deleteReplacement: unusedSwitch,
      reconcileProvider: unusedSwitch,
      verifyReplacement: unusedSwitch,
      complete: unusedSwitch,
      cancel: unusedSwitch,
    },
  };
}

function stateWithValidatingBatch() {
  const state = createConfiguredInitialState();
  state.batch = {
    id: 'local-provisional',
    name: 'History Brief',
    owner: 'Lakshman',
    phase: 'validating',
    prompts: [{
      id: 'prompt-1', index: 1, sourceLine: 1, text: 'A documentary shipyard at dawn', seed: 700, issues: [], status: 'pending', attempts: 0,
    }],
    destination: '/safe/downloads',
    startedAt: '2026-08-01T10:00:00.000Z',
    elapsedSeconds: 0,
    estimatedSecondsPerImage: 8.4,
    estimatedCost: 0,
    aspectRatio: '16:9',
    lockMessage: null,
    statusMessage: 'Validating',
  };
  return state;
}

function stateWithReadyPod() {
  const state = createConfiguredInitialState();
  state.pod = {
    ...state.pod,
    phase: 'ready',
    phaseProgress: 100,
    statusDetail: 'Model warm',
    gpu: 'RTX 4090',
    vram: '24 GB',
    hourlyRate: 0.54,
    health: 'healthy',
    podId: 'pod-exact-1',
    matchingPodIds: ['pod-exact-1'],
  };
  return state;
}

function gpuSwitchSnapshot(
  targetConfirmation: 'required' | 'confirmed',
  authorizationRequired = false,
  recordRevision = 3,
): NativeGpuSwitchSnapshotV1 {
  const target = {
    replacementAttemptId: '81000000-0000-4000-8000-000000000000',
    attemptRevision: 1,
    gpuId: 'NVIDIA GeForce RTX 4090',
    gpuDisplayName: 'RTX 4090',
    hourlyPriceMicroUsd: 500_000,
    observationId: '82000000-0000-4000-8000-000000000000',
    receiptId: '83000000-0000-4000-8000-000000000000',
    inventoryObservedAt: '2026-08-04T00:00:00.000Z',
    priceConfirmedAt: '2026-08-04T00:00:01.000Z',
  } as const;
  return {
    schemaVersion: 1,
    storeRevision: 7,
    record: {
      schemaVersion: 1,
      switchId: '80000000-0000-4000-8000-000000000000',
      recordRevision,
      phase: 'consent_pending',
      blockedAt: null,
      attentionCode: null,
      authorizationRequired,
      targetConfirmation,
      oldPod: {
        podId: 'pod-old-1',
        gpuId: 'NVIDIA GeForce RTX 5090',
        gpuDisplayName: 'RTX 5090',
        hourlyPriceMicroUsd: 890_000,
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
    },
    issues: [],
  };
}

describe('production ImageForge adapter', () => {
  it('loads the durable native GPU Switch journal without starting recovery actions', async () => {
    const base = port();
    const expected = { schemaVersion: 1 as const, storeRevision: 0, record: null, issues: [] };
    const load = vi.fn(async () => expected);
    const authorizeForeground = vi.fn(async () => { throw new Error('must remain read only'); });
    const native = port({ gpuSwitch: { ...base.gpuSwitch, load, authorizeForeground } });
    const adapter = createProductionImageForgeAdapter(native);

    await expect(adapter.runtime!.loadGpuSwitch()).resolves.toEqual(expected);
    expect(load).toHaveBeenCalledOnce();
    expect(authorizeForeground).not.toHaveBeenCalled();
  });

  it('mints native foreground authority before loading and beginning an exact Switch', async () => {
    const base = port();
    const grant = {
      schemaVersion: 1 as const,
      grantId: '70000000-0000-4000-8000-000000000000',
      processEpochId: '71000000-0000-4000-8000-000000000000',
      action: 'begin' as const,
      expiresAt: '2026-08-04T00:00:05.000Z',
    };
    const empty = { schemaVersion: 1 as const, storeRevision: 4, record: null, issues: [] };
    const authorizeForeground = vi.fn(async () => grant);
    const load = vi.fn(async () => empty);
    const begin = vi.fn(async () => empty);
    const native = port({ gpuSwitch: { ...base.gpuSwitch, authorizeForeground, load, begin } });
    const adapter = createProductionImageForgeAdapter(native);
    const state = stateWithReadyPod();
    state.queue.storeRevision = 9;
    state.queue.document.run = {
      runRevision: '72000000-0000-4000-8000-000000000000',
      cohortItemIds: [],
      runnerState: 'paused',
      authorizationRequired: true,
      keepAwake: false,
    };

    await expect(adapter.runtime!.beginGpuSwitch(state, {
      kind: 'switch',
      projection: {
        schemaVersion: 1,
        observationId: '73000000-0000-4000-8000-000000000000',
        receiptId: '74000000-0000-4000-8000-000000000000',
        targetGpuId: 'NVIDIA GeForce RTX 5090',
        confirmedHourlyPriceMicroUsd: 890_000,
      },
      offer: {
        schemaVersion: 1,
        observationId: '73000000-0000-4000-8000-000000000000',
        receiptId: '74000000-0000-4000-8000-000000000000',
        gpuId: 'NVIDIA GeForce RTX 5090',
        policyKey: 'rtx_5090',
        displayName: 'RTX 5090',
        memoryGb: 32,
        emergency: false,
        availability: 'high',
        hourlyPriceMicroUsd: 890_000,
        dataCenterId: 'EU-RO-1',
        source: 'live',
        observedAt: '2026-08-04T00:00:00.000Z',
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
      },
    })).resolves.toEqual(empty);

    expect(authorizeForeground).toHaveBeenCalledWith({
      action: 'begin',
      switchId: null,
      observationId: '73000000-0000-4000-8000-000000000000',
      targetGpuId: 'NVIDIA GeForce RTX 5090',
    });
    expect(authorizeForeground.mock.invocationCallOrder[0]).toBeLessThan(load.mock.invocationCallOrder[0]);
    expect(begin).toHaveBeenCalledWith(expect.objectContaining({
      expectedStoreRevision: 4,
      queueExpectedStoreRevision: 9,
      queueRunRevision: '72000000-0000-4000-8000-000000000000',
      foregroundGrantId: grant.grantId,
      targetGpuId: 'NVIDIA GeForce RTX 5090',
      confirmedHourlyPriceMicroUsd: 890_000,
    }));
  });

  it('uses the durable target-confirmation field to expose one exact next action', async () => {
    const base = port();
    const required = gpuSwitchSnapshot('required');
    const confirmed = gpuSwitchSnapshot('confirmed', false, 4);
    const confirmTarget = vi.fn(async () => confirmed);
    const finalize = vi.fn(async () => ({ ...confirmed, record: { ...confirmed.record!, phase: 'pausing' as const } }));

    const confirmPort = port({
      gpuSwitch: {
        ...base.gpuSwitch,
        load: vi.fn(async () => required),
        confirmTarget,
        finalize,
      },
    });
    const confirmAdapter = createProductionImageForgeAdapter(confirmPort);
    await expect(confirmAdapter.runtime!.confirmGpuSwitchTarget(
      stateWithReadyPod(),
      required,
    )).resolves.toEqual(confirmed);
    expect(confirmTarget).toHaveBeenCalledWith(expect.objectContaining({
      switchId: required.record!.switchId,
      expectedRecordRevision: required.record!.recordRevision,
      targetGpuId: 'NVIDIA GeForce RTX 4090',
      confirmedHourlyPriceMicroUsd: 500_000,
      observationId: '20000000-0000-4000-8000-000000000000',
      receiptId: '30000000-0000-4000-8000-000000000000',
    }));
    expect(finalize).not.toHaveBeenCalled();

    const finalizePort = port({
      gpuSwitch: {
        ...base.gpuSwitch,
        load: vi.fn(async () => confirmed),
        confirmTarget,
        finalize,
      },
    });
    const finalizeAdapter = createProductionImageForgeAdapter(finalizePort);
    await finalizeAdapter.runtime!.finalizeGpuSwitch(stateWithReadyPod(), confirmed);
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({
      switchId: confirmed.record!.switchId,
      expectedRecordRevision: confirmed.record!.recordRevision,
      targetGpuId: 'NVIDIA GeForce RTX 4090',
      confirmedHourlyPriceMicroUsd: 500_000,
      sessionId: expect.any(String),
    }));
    await expect(finalizeAdapter.runtime!.confirmGpuSwitchTarget(
      stateWithReadyPod(),
      confirmed,
    )).rejects.toThrow('already confirmed');
  });

  it('mints fresh resume authority and acquires the exact switch before any recovery action', async () => {
    const base = port();
    const blocked = gpuSwitchSnapshot('confirmed', true);
    const held = gpuSwitchSnapshot('confirmed', false);
    const grant = {
      schemaVersion: 1 as const,
      grantId: '84000000-0000-4000-8000-000000000000',
      processEpochId: '85000000-0000-4000-8000-000000000000',
      action: 'resume' as const,
      expiresAt: '2026-08-04T00:00:05.000Z',
    };
    const load = vi.fn(async () => held);
    const authorizeForeground = vi.fn(async () => grant);
    const acquire = vi.fn(async () => ({ switchId: blocked.record!.switchId, held: true }));
    const native = port({
      gpuSwitch: { ...base.gpuSwitch, load, authorizeForeground, acquire },
    });
    const adapter = createProductionImageForgeAdapter(native);

    await expect(adapter.runtime!.resumeGpuSwitch(blocked)).resolves.toEqual(held);
    expect(authorizeForeground).toHaveBeenCalledWith({
      action: 'resume',
      switchId: blocked.record!.switchId,
      observationId: null,
      targetGpuId: null,
    });
    expect(authorizeForeground.mock.invocationCallOrder[0])
      .toBeLessThan(acquire.mock.invocationCallOrder[0]);
    expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(load.mock.invocationCallOrder[0]);
  });

  it('returns native sent-uncertain attention when Resume reconciliation releases the lease', async () => {
    const base = port();
    const blocked = gpuSwitchSnapshot('confirmed', true);
    const grant = {
      schemaVersion: 1 as const,
      grantId: '84000000-0000-4000-8000-000000000000',
      processEpochId: '85000000-0000-4000-8000-000000000000',
      action: 'resume' as const,
      expiresAt: '2026-08-04T00:00:05.000Z',
    };
    const load = vi.fn(async () => blocked);
    const authorizeForeground = vi.fn(async () => grant);
    const acquire = vi.fn(async () => ({ switchId: blocked.record!.switchId, held: false }));
    const native = port({
      gpuSwitch: { ...base.gpuSwitch, load, authorizeForeground, acquire },
    });
    const adapter = createProductionImageForgeAdapter(native);

    await expect(adapter.runtime!.resumeGpuSwitch(blocked)).resolves.toEqual(blocked);
    expect(acquire).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
  });

  it('validates setup without starting compute and returns only vault metadata', async () => {
    const native = port();
    const adapter = createProductionImageForgeAdapter(native);
    expect(adapter.mode).toBe('production');
    expect(await adapter.validateStudioProfile(DEFAULT_STUDIO_PROFILE)).toBe(true);
    expect(await adapter.credentialMetadata()).toEqual(credentials());
    const result = await adapter.testConnection({
      profile: DEFAULT_STUDIO_PROFILE,
      destination: '/safe/downloads',
      destinationValidated: true,
      credentials: credentials(),
    });
    expect(result).toMatchObject({ ok: true });
    expect(native.bindProfile).toHaveBeenCalledOnce();
    expect(native.authorizeStart).not.toHaveBeenCalled();
  });

  it('refuses to terminate while a batch is generating and never asks a peer', async () => {
    // Stop no longer creates a worker stop request, so the refusal comes from
    // reading worker status directly. Cancel the batch first, then stop.
    const native = port({
      status: vi.fn(async () => ({
        status: 200,
        body: {
          schema_version: 1,
          ready: true,
          active_batch: {
            batch_id: '77777777-7777-4777-8777-777777777777',
            owner: { user_id: 'user-sujal', display_name: 'Sujal' },
            state: 'running',
            progress: {
              total: 450,
              completed: 73,
              downloaded: 73,
              failed: 0,
              cancelled: 0,
              processed: 73,
              current_index: 74,
            },
            pause_requested: false,
            cancel_requested: false,
          },
          permissions: {
            can_create: false,
            can_manage_active: false,
            is_owner: false,
            create_block_reason: null,
          },
        },
      })),
    });
    const adapter = createProductionImageForgeAdapter(native);
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));

    await adapter.runtime!.requestGpuStop(stateWithReadyPod());

    expect(events.at(-1)).toEqual({
      type: 'stop-blocked',
      owner: 'Sujal',
      completed: 73,
      total: 450,
      message: 'Sujal is generating 73 of 450 images. Stop the batch before terminating the GPU.',
    });
    expect(native.studioCreateStopRequest).not.toHaveBeenCalled();
    expect(native.gpuPod.normalStop).not.toHaveBeenCalled();
  });

  it('terminates directly with no stop request and no approval wait', async () => {
    const native = port();
    const adapter = createProductionImageForgeAdapter(native);
    // Production binds the Pod controller during startup refresh; Stop needs
    // that exact-Pod projection before it can authorize a termination.
    await adapter.runtime!.refresh(stateWithReadyPod());

    await adapter.runtime!.requestGpuStop(stateWithReadyPod());

    expect(native.studioCreateStopRequest).not.toHaveBeenCalled();
    expect(native.studioRespondToStopRequest).not.toHaveBeenCalled();
    expect(native.gpuPod.normalStop).toHaveBeenCalledWith(
      expect.objectContaining({ podId: 'pod-exact-1', direct: true }),
    );
  });

  it('loads and replays an interrupted native Stop with its exact persisted input after profile bind', async () => {
    const recoveryInput = {
      podId: 'pod-exact-1',
      stopRequestId: '40000000-0000-4000-8000-000000000000',
      sessionId: '50000000-0000-4000-8000-000000000000',
      expectedServerInstanceId: '60000000-0000-4000-8000-000000000000',
      expectedCoordinationRevision: 7,
      expectedLifecycleRevision: 3,
      direct: false,
    } as const;
    const retained = {
      ...gpuPodObservation(true),
      lifecycleRevision: 11,
      state: 'unavailable' as const,
      stale: true,
      issue: { code: 'gpu_pod_observation_unavailable' as const, retryable: true as const },
    };
    const gpuPod: NativeGpuPodPort = {
      observe: vi.fn(async () => gpuPodObservation(false)),
      loadNormalStop: vi.fn(async () => recoveryInput),
      normalStop: vi.fn(async (input) => ({
        schemaVersion: 1,
        operationId: '70000000-0000-4000-8000-000000000000',
        podId: input.podId,
        disposition: 'delete_uncertain',
        observation: retained,
        issue: { code: 'gpu_stop_delete_uncertain', retryable: false },
      } as const)),
    };
    const native = port({ gpuPod });
    const adapter = createProductionImageForgeAdapter(native);
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));

    await adapter.runtime!.refresh(stateWithReadyPod());

    expect(gpuPod.loadNormalStop).toHaveBeenCalledOnce();
    expect(gpuPod.normalStop).toHaveBeenCalledWith(recoveryInput);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'stop-failed',
      retryable: false,
      message: expect.stringContaining('RunPod did not confirm'),
    }));
    expect(adapter.runtime!.getAuthoritativePodState!()).toMatchObject({
      podId: recoveryInput.podId,
    });
    // Profile binding clears once before recovery; the unresolved Stop must
    // not clear the recovered old-Pod worker binding afterward.
    expect(native.clearWorkerSession).toHaveBeenCalledTimes(1);
  });

  it('projects idle-but-not-creatable worker truth as a temporary stop guard, not busy or error', async () => {
    const native = port({
      status: vi.fn(async () => ({
        status: 200,
        body: {
          schema_version: 1,
          ready: true,
          active_batch: null,
          permissions: { can_create: false, can_manage_active: false, is_owner: false, create_block_reason: 'gpu_stop_pending' },
        },
      })),
    });
    const adapter = createProductionImageForgeAdapter(native);
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));

    await adapter.runtime!.pollBatch(stateWithReadyPod());

    expect(events).toEqual([{
      type: 'stop-guard-active',
      podId: 'pod-exact-1',
      message: 'GPU Stop is finalizing; new generation is temporarily blocked.',
    }]);
    expect(events.some((event) => event.type === 'busy' || event.type === 'error')).toBe(false);
  });

  it('projects corrupt submission history as its exact non-retryable error, never a Stop guard', async () => {
    const native = port({
      status: vi.fn(async () => ({
        status: 200,
        body: {
          schema_version: 1,
          ready: true,
          active_batch: null,
          permissions: {
            can_create: false,
            can_manage_active: false,
            is_owner: false,
            create_block_reason: 'submission_store_corrupt',
          },
        },
      })),
    });
    const adapter = createProductionImageForgeAdapter(native);
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));

    await adapter.runtime!.pollBatch(stateWithReadyPod());

    expect(events).toEqual([{
      type: 'error',
      scope: 'batch',
      code: 'submission_store_corrupt',
      message: 'Worker submission history is unavailable. Repair the shared volume before starting generation.',
      retryable: false,
    }]);
    expect(events.some((event) => event.type === 'stop-guard-active')).toBe(false);
  });

  it('flushes the newest heartbeat availability after an in-flight heartbeat', async () => {
    const first = deferred<{ status: number; body: unknown }>();
    const heartbeat = vi.fn((sessionId: string, availability: 'foreground' | 'background') => (
      heartbeat.mock.calls.length === 1
        ? first.promise
        : Promise.resolve({
            status: 200,
            body: {
              ...studioState(sessionId),
              current_session: { ...studioState(sessionId).current_session, availability },
              sessions: [{ ...studioState(sessionId).current_session, availability }],
            },
          })
    ));
    const native = port({ studioHeartbeat: heartbeat });
    const adapter = createProductionImageForgeAdapter(native);
    const state = stateWithReadyPod();

    const background = adapter.runtime!.heartbeat(state, 'background');
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(1));
    const foreground = adapter.runtime!.heartbeat(state, 'foreground');
    first.resolve({ status: 200, body: studioState(heartbeat.mock.calls[0][0]) });
    await Promise.all([background, foreground]);

    expect(heartbeat.mock.calls.map((call) => call[1])).toEqual(['background', 'foreground']);
  });

  it('cancels a synchronized user request only through its exact current Pod', async () => {
    const requestId = '44444444-4444-4444-8444-444444444444';
    const cancel = vi.fn(async (_requestId: string, sessionId: string) => ({
      status: 200,
      body: { ...studioState(sessionId), coordination_revision: 3 },
    }));
    const native = port({
      studioHeartbeat: vi.fn(async (sessionId) => ({
        status: 200,
        body: {
          ...studioState(sessionId),
          coordination_revision: 2,
          stop_request: {
            request_id: requestId,
            pod_id: 'pod-exact-1',
            gpu_display_name: 'RTX 4090',
            requester: { session_id: sessionId, display_name: 'Lakshman' },
            state: 'pending',
            reason: null,
            requested_at: '2026-08-01T10:00:00.000Z',
            response_deadline: '2026-08-01T10:00:30.000Z',
            finalization_expires_at: null,
            waiting_for: [],
            approved_by: [],
            denied_by: [],
            finalization_id: null,
          },
        },
      })),
      studioCancelStopRequest: cancel,
    });
    const adapter = createProductionImageForgeAdapter(native);
    const state = stateWithReadyPod();
    await adapter.runtime!.heartbeat(state, 'foreground');

    await adapter.runtime!.cancelGpuStop(requestId);

    expect(cancel).toHaveBeenCalledWith(requestId, expect.any(String), 'pod-exact-1', null);
  });

  it('fails user cancellation closed when synchronized request and current Pod disagree', async () => {
    const requestId = '44444444-4444-4444-8444-444444444444';
    const cancel = vi.fn();
    const native = port({
      studioHeartbeat: vi.fn(async (sessionId) => ({
        status: 200,
        body: {
          ...studioState(sessionId),
          coordination_revision: 2,
          stop_request: {
            request_id: requestId,
            pod_id: 'pod-before-replacement',
            gpu_display_name: 'RTX 4090',
            requester: { session_id: sessionId, display_name: 'Lakshman' },
            state: 'pending',
            reason: null,
            requested_at: '2026-08-01T10:00:00.000Z',
            response_deadline: '2026-08-01T10:00:30.000Z',
            finalization_expires_at: null,
            waiting_for: [],
            approved_by: [],
            denied_by: [],
            finalization_id: null,
          },
        },
      })),
      studioCancelStopRequest: cancel,
    });
    const adapter = createProductionImageForgeAdapter(native);
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));
    const state = stateWithReadyPod();
    await adapter.runtime!.heartbeat(state, 'foreground');

    await adapter.runtime!.cancelGpuStop(requestId);

    expect(cancel).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: 'stop-failed',
      retryable: false,
      message: expect.stringContaining('another Pod'),
    });
  });

  it('rejects an older in-flight studio snapshot after a newer mutation response', async () => {
    const staleHeartbeat = deferred<{ status: number; body: unknown }>();
    let currentSessionId = '';
    const native = port({
      studioHeartbeat: vi.fn((sessionId) => {
        currentSessionId = sessionId;
        return staleHeartbeat.promise;
      }),
      studioRespondToStopRequest: vi.fn(async () => ({
        status: 200,
        body: { ...studioState(currentSessionId), coordination_revision: 5 },
      })),
    });
    const adapter = createProductionImageForgeAdapter(native);
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));

    const heartbeat = adapter.runtime!.heartbeat(stateWithReadyPod(), 'foreground');
    await vi.waitFor(() => expect(native.studioHeartbeat).toHaveBeenCalledOnce());
    await adapter.runtime!.respondToGpuStop('44444444-4444-4444-8444-444444444444', 'approve');
    staleHeartbeat.resolve({
      status: 200,
      body: { ...studioState(currentSessionId), coordination_revision: 1 },
    });
    await heartbeat;

    expect(events.filter((event) => event.type === 'studio')).toEqual([
      expect.objectContaining({ type: 'studio', studio: expect.objectContaining({ coordinationRevision: 5 }) }),
    ]);
  });

  it('never lets a pre-offline heartbeat revive a finalizing Stop after RunPod proves Offline', async () => {
    const staleHeartbeat = deferred<{ status: number; body: unknown }>();
    const offlineClear = deferred<void>();
    let sessionId = '';
    let clearCalls = 0;
    const clearWorkerSession = vi.fn(() => {
      clearCalls += 1;
      return clearCalls === 2 ? offlineClear.promise : Promise.resolve();
    });
    const native = port({
      gpuPod: gpuPodPort(false),
      clearWorkerSession,
      studioHeartbeat: vi.fn((currentSessionId) => {
        sessionId = currentSessionId;
        return staleHeartbeat.promise;
      }),
    });
    const adapter = createProductionImageForgeAdapter(native);
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));
    const state = stateWithReadyPod();

    const heartbeat = adapter.runtime!.heartbeat(state, 'foreground');
    await vi.waitFor(() => expect(native.studioHeartbeat).toHaveBeenCalledOnce());
    const refresh = adapter.runtime!.refresh(state);
    await vi.waitFor(() => {
      expect(clearWorkerSession).toHaveBeenCalledTimes(2);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'pod',
        pod: expect.objectContaining({ phase: 'offline' }),
      }));
    });
    staleHeartbeat.resolve({
      status: 200,
      body: {
        ...studioState(sessionId),
        coordination_revision: 9,
        stop_request: {
          request_id: '44444444-4444-4444-8444-444444444444',
          pod_id: 'pod-exact-1',
          gpu_display_name: 'RTX 4090',
          requester: { session_id: sessionId, display_name: 'Lakshman' },
          state: 'finalizing',
          reason: null,
          requested_at: '2026-08-01T10:00:00.000Z',
          response_deadline: '2026-08-01T10:00:30.000Z',
          finalization_expires_at: '2026-08-01T10:01:00.000Z',
          waiting_for: [],
          approved_by: [],
          denied_by: [],
          finalization_id: '55555555-5555-4555-8555-555555555555',
        },
      },
    });
    await heartbeat;

    expect(events.some((event) => event.type === 'studio')).toBe(false);
    offlineClear.resolve(undefined);
    await refresh;
  });

  it('never lets a later stale AppState revive a worker epoch after RunPod proves Offline', async () => {
    let sessionId = '';
    const native = port({
      gpuPod: gpuPodPort(false),
      studioHeartbeat: vi.fn(async (currentSessionId) => {
        sessionId = currentSessionId;
        return {
          status: 200,
          body: {
            ...studioState(currentSessionId),
            coordination_revision: 9,
            stop_request: {
              request_id: '44444444-4444-4444-8444-444444444444',
              pod_id: 'pod-exact-1',
              gpu_display_name: 'RTX 4090',
              requester: { session_id: currentSessionId, display_name: 'Lakshman' },
              state: 'finalizing',
              reason: null,
              requested_at: '2026-08-01T10:00:00.000Z',
              response_deadline: '2026-08-01T10:00:30.000Z',
              finalization_expires_at: '2026-08-01T10:01:00.000Z',
              waiting_for: [],
              approved_by: [],
              denied_by: [],
              finalization_id: '55555555-5555-4555-8555-555555555555',
            },
          },
        };
      }),
    });
    const adapter = createProductionImageForgeAdapter(native);
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));
    const staleReadyState = stateWithReadyPod();

    await adapter.runtime!.refresh(staleReadyState);
    expect(adapter.runtime!.getAuthoritativePodState?.()).toMatchObject({ phase: 'offline', podId: null });

    events.length = 0;
    await adapter.runtime!.heartbeat(staleReadyState, 'foreground');

    expect(sessionId).not.toBe('');
    expect(adapter.runtime!.getAuthoritativePodState?.()).toMatchObject({ phase: 'offline', podId: null });
    expect(events.some((event) => event.type === 'studio')).toBe(false);
    expect(events.some((event) => event.type === 'stop-guard-active')).toBe(false);
  });

  it('projects an owned native batch and verified local receipt into the UI', async () => {
    const native = port();
    const adapter = createProductionImageForgeAdapter(native);
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));
    const state = stateWithValidatingBatch();
    state.pod.hourlyRate = 0.5;
    await adapter.runtime!.startBatch(state);

    const event = events.filter((candidate) => candidate.type === 'batch').at(-1);
    expect(event).toMatchObject({ type: 'batch', batch: { id: batchId, name: 'History Brief', phase: 'complete' } });
    if (event?.type === 'batch') expect(event.assets[0].filename).toBe(`batches/${batchId}/000001.jpg`);
    expect(native.downloadArtifact).not.toHaveBeenCalled();
  });

  it('rejects a queued worker create when the durable run paused before the effect', async () => {
    const native = port();
    const adapter = createProductionImageForgeAdapter(native);
    const state = stateWithValidatingBatch();
    const queueItemId = '22222222-2222-4222-8222-222222222222';
    const submissionId = '33333333-3333-4333-8333-333333333333';
    const runRevision = '44444444-4444-4444-8444-444444444444';
    state.batch = {
      ...state.batch!,
      queueItemId,
      clientSubmissionId: submissionId,
      admissionMode: 'queue',
    };
    state.queue.lease = { runRevision, held: true };
    state.queue.document = {
      schemaVersion: 1,
      items: [{
        schemaVersion: 1,
        queueItemId,
        clientSubmissionId: submissionId,
        recordRevision: 3,
        runRevision,
        remoteBatchId: null,
        state: 'dispatching',
        attentionCode: null,
        name: 'Paused overnight work',
        prompts: ['A documentary shipyard at dawn'],
        baseSeed: 700,
        destination: '/safe/downloads',
        aspectRatio: '16:9',
        styleSuffix: null,
        references: [],
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-01T10:00:01.000Z',
      }],
      run: {
        runRevision,
        cohortItemIds: [queueItemId],
        runnerState: 'paused',
        authorizationRequired: true,
        keepAwake: false,
      },
      alarm: {
        eventId: `queue-complete:${runRevision}`,
        runRevision,
        state: 'disarmed',
        kind: null,
        snoozeUsed: false,
        snoozeDueAt: null,
        notificationDisposition: null,
        snoozeNotificationDisposition: null,
      },
    };

    await expect(adapter.runtime!.startBatch(state)).rejects.toThrow('paused before worker admission');
    expect(native.createBatch).not.toHaveBeenCalled();

    state.queue.document = {
      ...state.queue.document,
      run: {
        ...state.queue.document.run!,
        runnerState: 'running',
        authorizationRequired: false,
      },
    };
    await expect(adapter.runtime!.startBatch(state)).resolves.toBeUndefined();
    expect(native.createBatch).toHaveBeenCalledWith(
      ['A documentary shipyard at dawn'],
      700,
      [],
      '16:9',
      submissionId,
      'queue',
    );
  });

  it('suppresses a create-time worker failure when RunPod proves the Pod was stopped remotely', async () => {
    const native = port({
      createBatch: vi.fn(async () => ({
        status: 409,
        body: { error: { code: 'worker_api_incompatible', message: 'Worker API version is incompatible.', details: null } },
      })),
    });
    const adapter = createProductionImageForgeAdapter(native);
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));
    const observe = vi.spyOn(GpuLifecycleCoordinator.prototype, 'observe')
      .mockResolvedValue({ phase: 'offline' } as unknown as RunPodSnapshot);
    try {
      await expect(adapter.runtime!.startBatch(stateWithValidatingBatch())).resolves.toBeUndefined();
      expect(native.createBatch).toHaveBeenCalledOnce();
      expect(observe).toHaveBeenCalledOnce();
      expect(native.clearWorkerSession).toHaveBeenCalledOnce();
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
    } finally {
      observe.mockRestore();
    }
  });

  it('preserves a genuine create-time worker failure while RunPod remains active', async () => {
    const native = port({
      createBatch: vi.fn(async () => ({
        status: 503,
        body: { error: { code: 'worker_unavailable', message: 'Worker is warming.', details: null } },
      })),
    });
    const adapter = createProductionImageForgeAdapter(native);
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));
    const observe = vi.spyOn(GpuLifecycleCoordinator.prototype, 'observe')
      .mockResolvedValue({ phase: 'ready' } as unknown as RunPodSnapshot);
    try {
      await expect(adapter.runtime!.startBatch(stateWithValidatingBatch())).rejects.toThrow('Worker is warming.');
      expect(observe).toHaveBeenCalledOnce();
      expect(native.clearWorkerSession).not.toHaveBeenCalled();
      expect(events.filter((event) => event.type === 'error')).toEqual([{
        type: 'error',
        scope: 'batch',
        code: 'worker_unavailable',
        message: 'Worker is warming.',
        retryable: true,
      }]);
    } finally {
      observe.mockRestore();
    }
  });

  it('reconciles a remote Stop that lands after strict refresh reports Ready but before its worker poll', async () => {
    const native = port({
      status: vi.fn(async () => ({
        status: 409,
        body: { error: { code: 'worker_api_incompatible', message: 'Worker API version is incompatible.', details: null } },
      })),
    });
    const adapter = createProductionImageForgeAdapter(native);
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));
    const refresh = vi.spyOn(GpuLifecycleCoordinator.prototype, 'refresh')
      .mockResolvedValue({ phase: 'ready' } as unknown as RunPodSnapshot);
    const observe = vi.spyOn(GpuLifecycleCoordinator.prototype, 'observe')
      .mockResolvedValue({ phase: 'offline' } as unknown as RunPodSnapshot);
    try {
      await expect(adapter.runtime!.refresh(createConfiguredInitialState())).resolves.toBeUndefined();
      expect(refresh).toHaveBeenCalledOnce();
      expect(observe).toHaveBeenCalledOnce();
      expect(native.clearWorkerSession).toHaveBeenCalledOnce();
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
    } finally {
      refresh.mockRestore();
      observe.mockRestore();
    }
  });

  it('restores a recovered batch name from its durable named-folder receipt', async () => {
    const namedReceipt = {
      schemaVersion: 1 as const,
      batchId,
      index: 1,
      filename: 'batches/Atlas of Quiet Work/000001.jpg',
      sha256: 'a'.repeat(64),
      sizeBytes: 2_048,
      verifiedAtUnixMs: 1,
    };
    const native = port({
      status: vi.fn(async () => ({
        status: 200,
        body: {
          schema_version: 1,
          ready: true,
          active_batch: {
            batch_id: batchId,
            owner: { user_id: 'lakshman', display_name: 'Lakshman' },
            state: 'running',
            progress: manifest().progress,
            pause_requested: false,
            cancel_requested: false,
          },
          permissions: { can_create: false, can_manage_active: true, is_owner: true, create_block_reason: null },
        },
      })),
      readReceipts: vi.fn(async () => [namedReceipt]),
    });
    const adapter = createProductionImageForgeAdapter(native, batchId);
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));

    await adapter.runtime!.pollBatch(createConfiguredInitialState());

    expect(native.readReceipts).toHaveBeenCalledWith(batchId, undefined);
    expect(events.filter((event) => event.type === 'batch').at(-1)).toMatchObject({
      type: 'batch',
      batch: { id: batchId, name: 'Atlas of Quiet Work', phase: 'complete' },
      assets: [{ batchName: 'Atlas of Quiet Work', filename: namedReceipt.filename }],
    });
  });

  it('retains the persisted user batch name while migrating legacy UUID receipts', async () => {
    const native = port();
    const adapter = createProductionImageForgeAdapter(native, batchId, 'Atlas of Quiet Work');
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));

    await adapter.runtime!.pollBatch(createConfiguredInitialState());

    expect(native.readReceipts).toHaveBeenCalledWith(batchId, 'Atlas of Quiet Work');
    expect(events.filter((event) => event.type === 'batch').at(-1)).toMatchObject({
      type: 'batch',
      batch: { id: batchId, name: 'Atlas of Quiet Work', phase: 'complete' },
      assets: [{ batchName: 'Atlas of Quiet Work' }],
    });
  });

  it('projects a foreign active batch before touching a stale device-local recovery pointer', async () => {
    const reconcileReceipts = vi.fn(async () => {
      throw { code: 'destination_unavailable', message: 'Windows folder is unavailable.', retryable: true };
    });
    const readReceipts = vi.fn(async () => { throw new Error('must remain device-local and untouched'); });
    const status = vi.fn(async () => ({
      status: 200,
      body: {
        schema_version: 1,
        ready: true,
        active_batch: {
          batch_id: '33333333-3333-4333-8333-333333333333',
          owner: { user_id: 'sujal', display_name: 'Sujal' },
          state: 'running',
          progress: { total: 450, completed: 73, downloaded: 73, failed: 0, cancelled: 0, processed: 73, current_index: 74 },
          pause_requested: false,
          cancel_requested: false,
        },
        permissions: { can_create: false, can_manage_active: false, is_owner: false, create_block_reason: null },
      },
    }));
    const native = port({ status, reconcileReceipts, readReceipts });
    const adapter = createProductionImageForgeAdapter(native, batchId, 'Old Mac batch');
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));

    await expect(adapter.runtime!.pollBatch(createConfiguredInitialState())).resolves.toBeUndefined();

    expect(events).toEqual([expect.objectContaining({
      type: 'busy',
      batch: expect.objectContaining({ owner: 'Sujal', phase: 'locked' }),
    })]);
    expect(reconcileReceipts).not.toHaveBeenCalled();
    expect(readReceipts).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'error' || event.type === 'local-error')).toBe(false);
  });

  it('keeps owned worker truth visible when local recovery fails after status', async () => {
    const reconcileReceipts = vi.fn(async () => {
      throw { code: 'destination_unavailable', message: 'Choose a writable Windows folder.', retryable: true };
    });
    const status = vi.fn(async () => ({
      status: 200,
      body: {
        schema_version: 1,
        ready: true,
        active_batch: {
          batch_id: batchId,
          owner: { user_id: 'lakshman', display_name: 'Lakshman' },
          state: 'running',
          progress: manifest().progress,
          pause_requested: false,
          cancel_requested: false,
        },
        permissions: { can_create: false, can_manage_active: true, is_owner: true, create_block_reason: null },
      },
    }));
    const native = port({ status, reconcileReceipts });
    const adapter = createProductionImageForgeAdapter(native, batchId, 'Atlas of Quiet Work');
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));

    await expect(adapter.runtime!.pollBatch(createConfiguredInitialState())).resolves.toBeUndefined();

    expect(status.mock.invocationCallOrder[0]).toBeLessThan(reconcileReceipts.mock.invocationCallOrder[0]);
    expect(events[0]).toMatchObject({ type: 'batch', batch: { id: batchId, canManage: true } });
    expect(events[1]).toEqual({
      type: 'local-error',
      batchId,
      code: 'destination_unavailable',
      message: 'Choose a writable Windows folder.',
      retryable: true,
    });
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('projects owned worker truth before a pending local recovery operation settles', async () => {
    const recovery = deferred<{ schemaVersion: 1; batchId: string; receipts: [] }>();
    const reconcileReceipts = vi.fn(() => recovery.promise);
    const status = vi.fn(async () => ({
      status: 200,
      body: {
        schema_version: 1,
        ready: true,
        active_batch: {
          batch_id: batchId,
          owner: { user_id: 'lakshman', display_name: 'Lakshman' },
          state: 'running',
          progress: manifest().progress,
          pause_requested: false,
          cancel_requested: false,
        },
        permissions: { can_create: false, can_manage_active: true, is_owner: true, create_block_reason: null },
      },
    }));
    const native = port({ status, reconcileReceipts });
    const adapter = createProductionImageForgeAdapter(native, batchId, 'Atlas of Quiet Work');
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));

    const poll = adapter.runtime!.pollBatch(createConfiguredInitialState());
    await vi.waitFor(() => expect(reconcileReceipts).toHaveBeenCalledOnce());

    expect(events[0]).toMatchObject({
      type: 'batch',
      batch: { id: batchId, canManage: true },
    });
    recovery.resolve({ schemaVersion: 1, batchId, receipts: [] });
    await poll;
  });

  it('indexes the offline Library read-only without projecting or mutating Pod or batch state', async () => {
    const namedReceipt = {
      schemaVersion: 1 as const,
      batchId,
      index: 1,
      filename: 'batches/Atlas of Quiet Work/000001.jpg',
      sha256: 'a'.repeat(64),
      sizeBytes: 2_048,
      verifiedAtUnixMs: Date.parse('2026-08-02T12:00:00.000Z'),
    };
    const native = port({ readReceipts: vi.fn(async () => [namedReceipt]) });
    const adapter = createProductionImageForgeAdapter(native, batchId);
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));
    const state = createConfiguredInitialState();

    await adapter.runtime!.restoreLocalLibrary(state);

    expect(native.validateDestination).toHaveBeenCalledWith(state.settings.defaultDestination);
    expect(native.readReceipts).toHaveBeenCalledWith(batchId, undefined);
    expect(events).toEqual([{
      type: 'library',
      assets: [expect.objectContaining({
        id: `${batchId}-1`,
        batchId,
        batchName: 'Atlas of Quiet Work',
        index: 1,
        prompt: 'Saved image 001',
        filename: namedReceipt.filename,
        checksum: namedReceipt.sha256,
        recovered: true,
      })],
    }]);
    expect(native.status).not.toHaveBeenCalled();
    expect(native.gpuPod.observe).not.toHaveBeenCalled();
    expect(native.workerHealthFetch).not.toHaveBeenCalled();
    expect(native.reconcileReceipts).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'pod' || event.type === 'batch' || event.type === 'busy')).toBe(false);
  });

  it('keeps simulated lifecycle entry points unreachable in production mode', () => {
    const adapter = createProductionImageForgeAdapter(port());
    expect(() => adapter.runPodLifecycle({ preference: 'best_value', allowSlowEmergency: false }, () => undefined)).toThrow(
      'native runtime facade',
    );
    expect(() => adapter.validateBatch(() => undefined)).toThrow('native runtime facade');
  });

  it('routes an explicit peer GPU-switch decision through the narrow studio port', async () => {
    const respond = vi.fn(async (_switchId: string, sessionId: string, _decision: 'approve' | 'deny') => ({
      status: 200,
      body: studioState(sessionId),
    }));
    const adapter = createProductionImageForgeAdapter(port({ studioRespondToGpuSwitch: respond }));
    const switchId = '66666666-6666-4666-8666-666666666666';

    await adapter.runtime!.respondToGpuSwitch(switchId, 'approve');

    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      switchId,
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      'approve',
    );
  });

  it('emits one retryable redacted event for one failed worker poll', async () => {
    const native = port({
      status: vi.fn(async () => ({
        status: 503,
        body: { error: { code: 'worker_unavailable', message: 'Worker is warming.', details: null } },
      })),
    });
    const adapter = createProductionImageForgeAdapter(native);
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));
    const observe = vi.spyOn(GpuLifecycleCoordinator.prototype, 'observe')
      .mockRejectedValue(new Error('RunPod status unavailable'));
    try {
      await expect(adapter.runtime!.pollBatch(createConfiguredInitialState())).rejects.toThrow('Worker is warming.');
      expect(events).toEqual([{
        type: 'error',
        scope: 'batch',
        code: 'worker_unavailable',
        message: 'Worker is warming.',
        retryable: true,
      }]);
    } finally {
      observe.mockRestore();
    }
  });

  it('suppresses a stale worker failure when RunPod authoritatively reports no Pod', async () => {
    const native = port({
      status: vi.fn(async () => ({
        status: 409,
        body: { error: { code: 'worker_api_incompatible', message: 'Worker API version is incompatible.', details: null } },
      })),
    });
    const adapter = createProductionImageForgeAdapter(native);
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));
    const observe = vi.spyOn(GpuLifecycleCoordinator.prototype, 'observe')
      .mockResolvedValue({ phase: 'offline' } as unknown as RunPodSnapshot);
    try {
      await expect(adapter.runtime!.pollBatch(createConfiguredInitialState())).resolves.toBeUndefined();
      expect(observe).toHaveBeenCalledOnce();
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
      expect(native.clearWorkerSession).toHaveBeenCalledOnce();
    } finally {
      observe.mockRestore();
    }
  });

  it('clears a restart-persistent create marker only through explicit resolution', async () => {
    const native = port({
      createMarkerMetadata: vi.fn(async () => ({
        pending: true,
        attemptId: 'attempt-1',
        podName: 'imageforge-attempt-1',
        gpuId: 'gpu-1',
        podId: null,
      })),
    });
    const adapter = createProductionImageForgeAdapter(native);
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));

    await adapter.runtime!.resolveAmbiguousStart();
    expect(native.resolveCreateMarker).toHaveBeenCalledWith('attempt-1', null);
    expect(events.at(-1)).toEqual({ type: 'create-recovery', marker: null });
    expect(native.authorizeStart).not.toHaveBeenCalled();
  });

  it('surfaces the pending create attempt when a Start is refused by it', async () => {
    // A Start blocked by an unreconciled create attempt previously published
    // nothing, so the recovery panel never rendered and the button looked dead.
    const native = port({
      createMarkerMetadata: vi.fn(async () => ({
        pending: true,
        attemptId: 'attempt-9',
        podName: 'imageforge-attempt-9',
        gpuId: 'NVIDIA L4',
        podId: 'pod-stopped-1',
      })),
    });
    const adapter = createProductionImageForgeAdapter(native);
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));
    const startSelected = vi.spyOn(GpuLifecycleCoordinator.prototype, 'startSelected')
      .mockRejectedValue(Object.assign(new Error('in progress'), {
        code: 'gpu_start_operation_in_progress',
      }));
    try {
      await expect(adapter.runtime!.startGpuChoice(createConfiguredInitialState(), {
        kind: 'manual_start',
        projection: {
          schemaVersion: 1,
          observationId: '11111111-1111-4111-8111-111111111111',
          receiptId: '22222222-2222-4222-8222-222222222222',
          targetGpuId: 'NVIDIA L4',
          confirmedHourlyPriceMicroUsd: 490_000,
        },
        offer: { gpuId: 'NVIDIA L4' },
      } as never)).rejects.toThrow();
      const recovery = events.filter((event) => event.type === 'create-recovery');
      expect(recovery.at(-1)).toEqual({
        type: 'create-recovery',
        marker: {
          attemptId: 'attempt-9',
          podName: 'imageforge-attempt-9',
          gpuId: 'NVIDIA L4',
          podId: 'pod-stopped-1',
        },
      });
    } finally {
      startSelected.mockRestore();
    }
  });
});
