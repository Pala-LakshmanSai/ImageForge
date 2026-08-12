import { describe, expect, it, vi } from 'vitest';
import {
  FakeRunPodProvider,
  FakeWorkerHealthProbe,
  RunPodClientError,
  RunPodLifecycleController,
  deriveRunPodProxyUrl,
  type NativeGpuInventorySnapshotV1,
  type ManagedPod,
  type RunPodClientConfigInput,
} from '@imageforge/runpod-client';
import { DEFAULT_STUDIO_PROFILE, IMAGEFORGE_WORKER_IMAGE } from './imageForgeAdapter';
import {
  GpuLifecycleCoordinator,
  productionRunPodConfig,
  type GpuLifecycleNativePort,
} from './gpuLifecycleCoordinator';

const INVENTORY_EPOCH = '10000000-0000-4000-8000-000000000000';
const INVENTORY_OBSERVATION = '20000000-0000-4000-8000-000000000000';
const INVENTORY_RECEIPT = '30000000-0000-4000-8000-000000000000';

function stopAuthority(podId: string) {
  return {
    podId,
    stopRequestId: '40000000-0000-4000-8000-000000000000',
    sessionId: '50000000-0000-4000-8000-000000000000',
    expectedServerInstanceId: '60000000-0000-4000-8000-000000000000',
    expectedCoordinationRevision: 7,
    direct: false,
  } as const;
}

function readyInventory(): NativeGpuInventorySnapshotV1 {
  const observedAt = '2026-08-04T00:00:00.000Z';
  return {
    schemaVersion: 1,
    observationId: INVENTORY_OBSERVATION,
    processEpochId: INVENTORY_EPOCH,
    includeEmergencyTier: false,
    state: 'ready',
    observedAt,
    receipt: {
      schemaVersion: 1,
      receiptId: INVENTORY_RECEIPT,
      processEpochId: INVENTORY_EPOCH,
      receivedAt: observedAt,
      validForMs: 60_000,
      catalogSha256: 'a'.repeat(64),
    },
    offers: [{
      schemaVersion: 1,
      observationId: INVENTORY_OBSERVATION,
      receiptId: INVENTORY_RECEIPT,
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

function nativePort(): GpuLifecycleNativePort {
  const unusedFetch = vi.fn(async () => { throw new Error('unused native fetch'); }) as unknown as typeof fetch;
  const inventory = readyInventory();
  return {
    workerHealthFetch: unusedFetch,
    gpuInventory: {
      load: vi.fn(async () => inventory),
      beginRefresh: vi.fn(async () => inventory),
      listen: vi.fn(async () => () => undefined),
    },
    gpuStart: {
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
    gpuPod: {
      observe: vi.fn(async () => ({
        schemaVersion: 1,
        processEpochId: '50000000-0000-4000-8000-000000000000',
        lifecycleRevision: 1,
        state: 'offline',
        observedAt: '2026-08-04T00:00:00.000Z',
        stale: false,
        pods: [],
        overflow: false,
        issue: null,
      } as const)),
      loadNormalStop: vi.fn(async () => null),
      normalStop: vi.fn(async () => { throw new Error('unused normal Stop'); }),
    },
    bindProfile: vi.fn(async () => undefined),
    authorizeStart: vi.fn(async () => undefined),
    clearStartAuthorization: vi.fn(async () => undefined),
    clearWorkerSession: vi.fn(async () => undefined),
  };
}

function podObservation(
  podId: string | null,
  lifecycleRevision = 10,
  state: 'offline' | 'single' | 'unavailable' = podId === null ? 'offline' : 'single',
) {
  return Object.freeze({
    schemaVersion: 1 as const,
    processEpochId: '70000000-0000-4000-8000-000000000000',
    lifecycleRevision,
    state,
    observedAt: '2026-08-04T00:00:00.000Z',
    stale: state === 'unavailable',
    pods: podId === null
      ? Object.freeze([])
      : Object.freeze([Object.freeze({
          podId,
          gpuId: 'NVIDIA GeForce RTX 4090',
          gpuDisplayName: 'RTX 4090',
          hourlyPriceMicroUsd: 500_000,
          status: 'running' as const,
        })]),
    overflow: false,
    issue: state === 'unavailable'
      ? Object.freeze({ code: 'gpu_pod_observation_unavailable' as const, retryable: true as const })
      : null,
  });
}

function managedPod(config: RunPodClientConfigInput, id = 'approvedpod1'): ManagedPod {
  return {
    id,
    name: 'imageforge-existing',
    status: 'running',
    gpuId: 'NVIDIA GeForce RTX 4090',
    gpuDisplayName: 'RTX 4090',
    gpuCount: 1,
    cloud: 'secure',
    dataCenterId: 'EU-RO-1',
    templateId: String(config.templateId),
    networkVolumeId: String(config.networkVolumeId),
    networkVolumeMountPath: '/workspace',
    interruptible: false,
    hourlyPriceMicroUsd: 500_000,
    createdAt: '2026-08-01T10:00:00.000Z',
    startRequestId: 'existing',
    proxyUrl: deriveRunPodProxyUrl(id, 8000),
  };
}

function readyController(
  config: RunPodClientConfigInput,
  providers: FakeRunPodProvider[],
): RunPodLifecycleController {
  const pod = managedPod(config, `approvedpod${providers.length + 1}`);
  const provider = new FakeRunPodProvider({ pods: [pod] });
  const health = new FakeWorkerHealthProbe();
  health.setHealth(pod.proxyUrl, { schemaVersion: 1, phase: 'ready', phaseProgress: 1 });
  providers.push(provider);
  return new RunPodLifecycleController({ provider, config, workerHealthProbe: health });
}

describe('GpuLifecycleCoordinator', () => {
  it('injects native inventory authority and keeps the heartbeat Pod-only', async () => {
    const port = nativePort();
    let provider: FakeRunPodProvider | null = null;
    let injectedSource: unknown = null;
    const coordinator = new GpuLifecycleCoordinator(port, (config, _stopGuard, gpuSelectionSource) => {
      injectedSource = gpuSelectionSource;
      const pod = managedPod(config, 'heartbeatpod1');
      provider = new FakeRunPodProvider({ pods: [pod] });
      const health = new FakeWorkerHealthProbe();
      health.setHealth(pod.proxyUrl, { schemaVersion: 1, phase: 'ready', phaseProgress: 1 });
      return new RunPodLifecycleController({
        provider,
        config,
        workerHealthProbe: health,
        gpuSelectionSource,
      });
    });

    await coordinator.observe(DEFAULT_STUDIO_PROFILE, 450, false);
    expect(injectedSource).not.toBeNull();
    expect(provider!.calls.inventory).toEqual([]);
    expect(provider!.calls.list).toHaveLength(1);
    await coordinator.loadInventory();
    expect(port.gpuInventory.load).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it('routes Auto Start through the typed native authority without a legacy provider grant', async () => {
    const port = nativePort();
    const coordinator = new GpuLifecycleCoordinator(
      port,
      (config, _stopGuard, gpuSelectionSource) => new RunPodLifecycleController({
        provider: new FakeRunPodProvider({ pods: [] }),
        config,
        gpuSelectionSource,
      }),
    );
    const input = {
      observationId: INVENTORY_OBSERVATION,
      receiptId: INVENTORY_RECEIPT,
      sessionId: '60000000-0000-4000-8000-000000000000',
      expectedLifecycleRevision: 0,
    } as const;

    await coordinator.prepareInventory(DEFAULT_STUDIO_PROFILE, false);
    await expect(coordinator.startAuto(DEFAULT_STUDIO_PROFILE, false, input)).resolves.toMatchObject({
      state: 'create_intent',
      lifecycleRevision: 1,
    });

    expect(port.gpuStart.startAuto).toHaveBeenCalledWith(input);
    expect(port.authorizeStart).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it('reloads profile-bound native inventory before replacing offline GPU policy', async () => {
    const port = nativePort();
    const coordinator = new GpuLifecycleCoordinator(
      port,
      (config, _stopGuard, gpuSelectionSource) => new RunPodLifecycleController({
        provider: new FakeRunPodProvider({ pods: [] }),
        config,
        gpuSelectionSource,
      }),
    );

    await coordinator.observe(DEFAULT_STUDIO_PROFILE, 450, false);
    await coordinator.observe(DEFAULT_STUDIO_PROFILE, 450, true);

    expect(port.bindProfile).toHaveBeenCalledTimes(2);
    expect(port.gpuInventory.load).toHaveBeenCalledTimes(4);
    expect(port.gpuInventory.listen).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it('binds the exact profile and wraps each explicit Start in a one-use native grant', async () => {
    const port = nativePort();
    const providers: FakeRunPodProvider[] = [];
    const coordinator = new GpuLifecycleCoordinator(port, (config) => readyController(config, providers));
    const snapshot = await coordinator.start(DEFAULT_STUDIO_PROFILE, 450, false);

    expect(snapshot.phase).toBe('ready');
    expect(port.bindProfile).toHaveBeenCalledWith('q8sfgixfy2', 'kdqerqkwdh');
    expect(port.authorizeStart).toHaveBeenCalledWith(false);
    expect(port.clearStartAuthorization).toHaveBeenCalledOnce();
    expect(providers[0].calls.create).toHaveLength(0);
  });

  it('consumes the fresh native R+2 Stop projection without a third Pod observation', async () => {
    const port = nativePort();
    const providers: FakeRunPodProvider[] = [];
    let currentObservation = podObservation('approvedpod1');
    vi.mocked(port.gpuPod.observe).mockImplementation(async () => currentObservation);
    vi.mocked(port.gpuPod.normalStop).mockImplementation(async (input) => {
      providers[0].setPods([]);
      currentObservation = podObservation(null, 13);
      return {
        schemaVersion: 1,
        operationId: '80000000-0000-4000-8000-000000000000',
        podId: input.podId,
        disposition: 'stopped',
        observation: podObservation(null, 12),
        issue: null,
      } as const;
    });
    const coordinator = new GpuLifecycleCoordinator(port, (config) => readyController(config, providers));
    const ready = await coordinator.start(DEFAULT_STUDIO_PROFILE, 12, false);
    const stopped = await coordinator.stop(stopAuthority(ready.selectedPodId!));

    expect(stopped.phase).toBe('offline');
    expect(port.gpuPod.normalStop).toHaveBeenCalledWith({
      ...stopAuthority(ready.selectedPodId!),
      expectedLifecycleRevision: 10,
    });
    expect(port.gpuPod.observe).toHaveBeenCalledTimes(1);
    expect(providers[0].calls.terminate).toEqual([]);
    expect(port.clearWorkerSession).toHaveBeenCalled();
  });

  it('leaves worker finalization to the native normal-Stop authority', async () => {
    const port = nativePort();
    vi.mocked(port.gpuPod.observe).mockResolvedValue(podObservation('guardedpod1'));
    vi.mocked(port.gpuPod.normalStop).mockRejectedValue(Object.assign(
      new Error('Sujal kept the GPU running.'),
      { code: 'stop_consent_denied', retryable: false, mayHaveSucceeded: false },
    ));
    let provider: FakeRunPodProvider | null = null;
    const guard = vi.fn(async () => ({
      allow: false as const,
      code: 'stop_consent_denied' as const,
      message: 'Sujal kept the GPU running.',
    }));
    const coordinator = new GpuLifecycleCoordinator(
      port,
      (config, stopGuard) => {
        const pod = managedPod(config, 'guardedpod1');
        provider = new FakeRunPodProvider({ pods: [pod] });
        const health = new FakeWorkerHealthProbe();
        health.setHealth(pod.proxyUrl, { schemaVersion: 1, phase: 'ready', phaseProgress: 1 });
        return new RunPodLifecycleController({ provider, config, workerHealthProbe: health, stopGuard });
      },
      guard,
    );
    const ready = await coordinator.start(DEFAULT_STUDIO_PROFILE, 12, false);

    await expect(coordinator.stop(stopAuthority(ready.selectedPodId!))).rejects.toMatchObject({
      code: 'stop_consent_denied',
    });

    expect(guard).not.toHaveBeenCalled();
    expect(port.gpuPod.normalStop).toHaveBeenCalledOnce();
    expect(provider!.calls.terminate).toEqual([]);
  });

  it('fails closed when the current native projection no longer contains the approved Pod', async () => {
    const port = nativePort();
    let provider: FakeRunPodProvider | null = null;
    const coordinator = new GpuLifecycleCoordinator(port, (config) => {
      const pod = managedPod(config, 'stoppedelsewhere1');
      provider = new FakeRunPodProvider({ inventory: [], pods: [pod] });
      const health = new FakeWorkerHealthProbe();
      health.setHealth(pod.proxyUrl, { schemaVersion: 1, phase: 'ready', phaseProgress: 1 });
      return new RunPodLifecycleController({ provider, config, workerHealthProbe: health });
    });
    const ready = await coordinator.start(DEFAULT_STUDIO_PROFILE, 12, false);
    provider!.setPods([]);
    vi.mocked(port.clearWorkerSession).mockClear();

    await expect(coordinator.stop(stopAuthority(ready.selectedPodId!))).rejects.toMatchObject({
      code: 'termination_target_mismatch',
      mayHaveSucceeded: false,
    });

    expect(coordinator.getSnapshot()?.phase).toBe('ready');
    expect(port.gpuPod.normalStop).not.toHaveBeenCalled();
    expect(provider!.calls.terminate).toEqual([]);
    expect(port.clearWorkerSession).not.toHaveBeenCalled();
  });

  it('never reports success or clears the worker session when the confirmed Pod was replaced', async () => {
    const port = nativePort();
    let provider: FakeRunPodProvider | null = null;
    let health: FakeWorkerHealthProbe | null = null;
    let config: RunPodClientConfigInput | null = null;
    const coordinator = new GpuLifecycleCoordinator(port, (nextConfig) => {
      config = nextConfig;
      const pod = managedPod(nextConfig, 'replacedbeforestop1');
      provider = new FakeRunPodProvider({ inventory: [], pods: [pod] });
      health = new FakeWorkerHealthProbe();
      health.setHealth(pod.proxyUrl, { schemaVersion: 1, phase: 'ready', phaseProgress: 1 });
      return new RunPodLifecycleController({
        provider,
        config: nextConfig,
        workerHealthProbe: health,
      });
    });
    const ready = await coordinator.start(DEFAULT_STUDIO_PROFILE, 12, false);
    const replacement = managedPod(config!, 'replacementpod1');
    provider!.setPods([replacement]);
    health!.setHealth(replacement.proxyUrl, {
      schemaVersion: 1,
      phase: 'ready',
      phaseProgress: 1,
    });
    vi.mocked(port.clearWorkerSession).mockClear();

    await expect(coordinator.stop(stopAuthority(ready.selectedPodId!))).rejects.toMatchObject({
      code: 'termination_target_mismatch',
      mayHaveSucceeded: false,
    });

    expect(provider!.calls.terminate).toEqual([]);
    expect(port.clearWorkerSession).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'ready',
      selectedPodId: ready.selectedPodId,
    });
  });

  it('never reports success when the confirmed Pod keeps its ID but drifts outside the profile', async () => {
    const port = nativePort();
    let provider: FakeRunPodProvider | null = null;
    const coordinator = new GpuLifecycleCoordinator(port, (config) => {
      const pod = managedPod(config, 'profiledriftstop1');
      provider = new FakeRunPodProvider({ inventory: [], pods: [pod] });
      const health = new FakeWorkerHealthProbe();
      health.setHealth(pod.proxyUrl, { schemaVersion: 1, phase: 'ready', phaseProgress: 1 });
      return new RunPodLifecycleController({ provider, config, workerHealthProbe: health });
    });
    const ready = await coordinator.start(DEFAULT_STUDIO_PROFILE, 12, false);
    provider!.setPods([
      {
        ...managedPod(productionRunPodConfig(DEFAULT_STUDIO_PROFILE, false), ready.selectedPodId!),
        networkVolumeId: 'different-volume',
      },
    ]);
    vi.mocked(port.clearWorkerSession).mockClear();

    await expect(coordinator.stop(stopAuthority(ready.selectedPodId!))).rejects.toMatchObject({
      code: 'termination_target_mismatch',
      mayHaveSucceeded: false,
    });

    expect(provider!.calls.terminate).toEqual([]);
    expect(port.clearWorkerSession).not.toHaveBeenCalled();
  });

  it('consumes a fresh native already-stopped R+2 projection without another read', async () => {
    const port = nativePort();
    let provider: FakeRunPodProvider | null = null;
    let currentObservation = podObservation('vanishafterpreflight1');
    vi.mocked(port.gpuPod.observe).mockImplementation(async () => currentObservation);
    vi.mocked(port.gpuPod.normalStop).mockImplementation(async (input) => {
      provider!.setPods([]);
      currentObservation = podObservation(null, 13);
      return {
        schemaVersion: 1,
        operationId: '80000000-0000-4000-8000-000000000000',
        podId: input.podId,
        disposition: 'already_stopped',
        observation: podObservation(null, 12),
        issue: null,
      } as const;
    });
    const coordinator = new GpuLifecycleCoordinator(port, (config) => {
      const pod = managedPod(config, 'vanishafterpreflight1');
      provider = new FakeRunPodProvider({ inventory: [], pods: [pod] });
      const health = new FakeWorkerHealthProbe();
      health.setHealth(pod.proxyUrl, { schemaVersion: 1, phase: 'ready', phaseProgress: 1 });
      return new RunPodLifecycleController({ provider, config, workerHealthProbe: health });
    });
    const ready = await coordinator.start(DEFAULT_STUDIO_PROFILE, 12, false);
    vi.mocked(port.clearWorkerSession).mockClear();

    const reconciled = await coordinator.stop(stopAuthority(ready.selectedPodId!));

    expect(reconciled.alreadyStopped).toBe(true);
    expect(reconciled.phase).toBe('offline');
    expect(port.gpuPod.observe).toHaveBeenCalledTimes(1);
    expect(provider!.calls.terminate).toEqual([]);
    expect(port.clearWorkerSession).toHaveBeenCalledOnce();
  });

  it('treats a completed recovery replay as historical and observes current Pod state first', async () => {
    const port = nativePort();
    const recoveryInput = {
      ...stopAuthority('historicalstop1'),
      expectedLifecycleRevision: 10,
    } as const;
    let provider: FakeRunPodProvider | null = null;
    vi.mocked(port.gpuPod.observe).mockResolvedValue(podObservation(null, 20));
    vi.mocked(port.gpuPod.normalStop).mockImplementation(async (input) => ({
      schemaVersion: 1,
      operationId: '80000000-0000-4000-8000-000000000000',
      podId: input.podId,
      disposition: 'stopped',
      observation: podObservation(null, 12),
      issue: null,
    } as const));
    const coordinator = new GpuLifecycleCoordinator(port, (config) => {
      provider = new FakeRunPodProvider({ pods: [] });
      return new RunPodLifecycleController({ provider, config });
    });
    await coordinator.observe(DEFAULT_STUDIO_PROFILE, 12, false);
    vi.mocked(port.gpuPod.observe).mockClear();
    vi.mocked(port.clearWorkerSession).mockClear();

    const reconciled = await coordinator.recoverStop(recoveryInput);

    expect(reconciled.phase).toBe('offline');
    expect(port.gpuPod.normalStop).toHaveBeenCalledWith(recoveryInput);
    expect(port.gpuPod.observe).toHaveBeenCalledOnce();
    expect(provider!.calls.terminate).toEqual([]);
    expect(port.clearWorkerSession).toHaveBeenCalledOnce();
  });

  it('keeps a native Stop authentication failure visible without clearing the worker binding', async () => {
    const port = nativePort();
    vi.mocked(port.gpuPod.observe).mockResolvedValue(podObservation('stopauthfailure1'));
    vi.mocked(port.gpuPod.normalStop).mockRejectedValue(Object.assign(
      new Error('RunPod credentials were rejected.'),
      { code: 'gpu_stop_provider_authentication_failed', retryable: false, mayHaveSucceeded: false },
    ));
    let provider: FakeRunPodProvider | null = null;
    const coordinator = new GpuLifecycleCoordinator(port, (config) => {
      const pod = managedPod(config, 'stopauthfailure1');
      provider = new FakeRunPodProvider({ inventory: [], pods: [pod] });
      const health = new FakeWorkerHealthProbe();
      health.setHealth(pod.proxyUrl, { schemaVersion: 1, phase: 'ready', phaseProgress: 1 });
      return new RunPodLifecycleController({ provider, config, workerHealthProbe: health });
    });
    const ready = await coordinator.start(DEFAULT_STUDIO_PROFILE, 12, false);
    vi.mocked(port.clearWorkerSession).mockClear();

    await expect(coordinator.stop(stopAuthority(ready.selectedPodId!))).rejects.toMatchObject({
      code: 'gpu_stop_provider_authentication_failed',
    });
    expect(provider!.calls.terminate).toEqual([]);
    expect(port.clearWorkerSession).not.toHaveBeenCalled();
  });

  it('retains the visible Pod and worker binding when native Stop is delete-uncertain', async () => {
    const port = nativePort();
    let provider: FakeRunPodProvider | null = null;
    vi.mocked(port.gpuPod.observe).mockResolvedValue(podObservation('uncertainstop1'));
    vi.mocked(port.gpuPod.normalStop).mockImplementation(async (input) => ({
      schemaVersion: 1,
      operationId: '80000000-0000-4000-8000-000000000000',
      podId: input.podId,
      disposition: 'delete_uncertain',
      observation: podObservation(input.podId, 12, 'unavailable'),
      issue: { code: 'gpu_stop_delete_uncertain', retryable: false },
    } as const));
    const coordinator = new GpuLifecycleCoordinator(port, (config) => {
      const pod = managedPod(config, 'uncertainstop1');
      provider = new FakeRunPodProvider({ pods: [pod] });
      const health = new FakeWorkerHealthProbe();
      health.setHealth(pod.proxyUrl, { schemaVersion: 1, phase: 'ready', phaseProgress: 1 });
      return new RunPodLifecycleController({ provider, config, workerHealthProbe: health });
    });
    const ready = await coordinator.start(DEFAULT_STUDIO_PROFILE, 12, false);
    vi.mocked(port.clearWorkerSession).mockClear();

    await expect(coordinator.stop(stopAuthority(ready.selectedPodId!))).rejects.toMatchObject({
      code: 'gpu_stop_delete_uncertain',
      retryable: false,
      mayHaveSucceeded: true,
    });

    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'ready',
      selectedPodId: ready.selectedPodId,
    });
    expect(provider!.calls.terminate).toEqual([]);
    expect(port.clearWorkerSession).not.toHaveBeenCalled();
  });

  it('replays the byte-identical native Stop recovery input without rebuilding session or revision', async () => {
    const port = nativePort();
    const recoveryInput = {
      ...stopAuthority('recoveredstop1'),
      expectedLifecycleRevision: 3,
    } as const;
    vi.mocked(port.gpuPod.loadNormalStop).mockResolvedValue(recoveryInput);
    vi.mocked(port.gpuPod.observe).mockResolvedValue(podObservation(null, 10));
    vi.mocked(port.gpuPod.normalStop).mockImplementation(async (input) => ({
      schemaVersion: 1,
      operationId: '80000000-0000-4000-8000-000000000000',
      podId: input.podId,
      disposition: 'delete_uncertain',
      observation: podObservation(input.podId, 11, 'unavailable'),
      issue: { code: 'gpu_stop_delete_uncertain', retryable: false },
    } as const));
    const coordinator = new GpuLifecycleCoordinator(port);
    await coordinator.observe(DEFAULT_STUDIO_PROFILE, 12, false);
    vi.mocked(port.clearWorkerSession).mockClear();

    await expect(coordinator.recoverStop(recoveryInput)).rejects.toMatchObject({
      code: 'gpu_stop_delete_uncertain',
      mayHaveSucceeded: true,
    });

    expect(port.gpuPod.normalStop).toHaveBeenCalledWith(recoveryInput);
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'booting',
      selectedPodId: recoveryInput.podId,
    });
    expect(port.clearWorkerSession).not.toHaveBeenCalled();
  });

  it('does not replace controller policy while a Pod or ambiguity is active', async () => {
    const port = nativePort();
    const providers: FakeRunPodProvider[] = [];
    const coordinator = new GpuLifecycleCoordinator(port, (config) => readyController(config, providers));
    await coordinator.start(DEFAULT_STUDIO_PROFILE, 450, false);

    await expect(coordinator.start(DEFAULT_STUDIO_PROFILE, 450, true)).rejects.toThrow(
      'must be handled before changing GPU policy',
    );
    expect(port.authorizeStart).toHaveBeenCalledTimes(1);
    expect(providers).toHaveLength(1);
  });

  it('clears a native grant without masking an ambiguous lifecycle error', async () => {
    const port = nativePort();
    vi.mocked(port.clearStartAuthorization).mockRejectedValueOnce(new Error('vault state unavailable'));
    const coordinator = new GpuLifecycleCoordinator(port, (config, _stopGuard, gpuSelectionSource) => {
      const provider = new FakeRunPodProvider({
        inventory: [{
          gpuId: 'NVIDIA GeForce RTX 4090',
          policyKey: 'rtx_4090',
          coldPriority: 0,
          emergency: false,
          displayName: 'RTX 4090',
          manufacturer: 'NVIDIA',
          memoryGb: 24,
          cloud: 'secure',
          hourlyPriceMicroUsd: 500_000,
          availability: 'high',
          dataCenterId: 'EU-RO-1',
          volumeCompatible: true,
          observedAt: '2026-08-01T10:00:00.000Z',
        }],
      });
      provider.failNext('create', new RunPodClientError({
        code: 'api_network_error',
        message: 'create result unknown',
        operation: 'create_pod',
        mayHaveSucceeded: true,
      }));
      return new RunPodLifecycleController({ provider, config, gpuSelectionSource });
    });

    await expect(coordinator.start(DEFAULT_STUDIO_PROFILE, 450, false)).rejects.toMatchObject({
      code: 'pod_create_ambiguous',
      mayHaveSucceeded: true,
    });
    expect(() => coordinator.resolveAmbiguousStart()).not.toThrow();
  });

  it('pins the portable INT8 contract and keeps emergency capacity opt-in', () => {
    const normal = productionRunPodConfig(DEFAULT_STUDIO_PROFILE, false);
    const emergency = productionRunPodConfig(DEFAULT_STUDIO_PROFILE, true);
    expect(normal.benchmarkContract).toMatchObject({
      model: 'Comfy-Org/Mage-Flow',
      modelRevision: 'd8c99241f6fa80fbd453014234af2bf337ea21e6',
      softwareImage: IMAGEFORGE_WORKER_IMAGE,
      precision: 'INT8',
      width: 1280,
      height: 720,
      steps: 4,
      guidance: 1,
      jpegQuality: 95,
    });
    expect(normal.allowEmergencyGpuTier).toBe(false);
    expect(emergency.allowEmergencyGpuTier).toBe(true);
    expect(normal.benchmarkProfiles).toEqual([]);
  });
});
