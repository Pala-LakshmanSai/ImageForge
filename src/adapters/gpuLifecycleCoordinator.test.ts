import { describe, expect, it, vi } from 'vitest';
import {
  FakeRunPodProvider,
  FakeWorkerHealthProbe,
  RunPodClientError,
  RunPodLifecycleController,
  deriveRunPodProxyUrl,
  type ManagedPod,
  type RunPodClientConfigInput,
} from '@imageforge/runpod-client';
import { DEFAULT_STUDIO_PROFILE, IMAGEFORGE_WORKER_IMAGE } from './imageForgeAdapter';
import {
  GpuLifecycleCoordinator,
  productionRunPodConfig,
  type GpuLifecycleNativePort,
} from './gpuLifecycleCoordinator';

function nativePort(): GpuLifecycleNativePort {
  const unusedFetch = vi.fn(async () => { throw new Error('unused native fetch'); }) as unknown as typeof fetch;
  return {
    runPodFetch: unusedFetch,
    workerHealthFetch: unusedFetch,
    bindProfile: vi.fn(async () => undefined),
    authorizeStart: vi.fn(async () => undefined),
    clearStartAuthorization: vi.fn(async () => undefined),
    clearWorkerSession: vi.fn(async () => undefined),
  };
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
    hourlyPriceUsd: 0.5,
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
  it('binds the exact profile and wraps each explicit Start in a one-use native grant', async () => {
    const port = nativePort();
    const providers: FakeRunPodProvider[] = [];
    const coordinator = new GpuLifecycleCoordinator(port, (config) => readyController(config, providers));
    const snapshot = await coordinator.start(DEFAULT_STUDIO_PROFILE, 450, false);

    expect(snapshot.phase).toBe('ready');
    expect(port.bindProfile).toHaveBeenCalledWith('q8sfgixfy2', 'ukh207b26r');
    expect(port.authorizeStart).toHaveBeenCalledWith(false);
    expect(port.clearStartAuthorization).toHaveBeenCalledOnce();
    expect(providers[0].calls.create).toHaveLength(0);
  });

  it('stops only the exact confirmed Pod and clears the worker session without any timer', async () => {
    const port = nativePort();
    const providers: FakeRunPodProvider[] = [];
    const coordinator = new GpuLifecycleCoordinator(port, (config) => readyController(config, providers));
    const ready = await coordinator.start(DEFAULT_STUDIO_PROFILE, 12, false);
    const stopped = await coordinator.stop(ready.selectedPodId!);

    expect(stopped.phase).toBe('offline');
    expect(providers[0].calls.terminate).toEqual([ready.selectedPodId]);
    expect(port.clearWorkerSession).toHaveBeenCalled();
  });

  it('reconciles a Pod stopped by another client without a second DELETE', async () => {
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

    const reconciled = await coordinator.stop(ready.selectedPodId!);

    expect(reconciled.alreadyStopped).toBe(true);
    expect(reconciled.phase).toBe('offline');
    expect(provider!.calls.terminate).toEqual([]);
    expect(port.clearWorkerSession).toHaveBeenCalledOnce();
  });

  it('reconciles a Pod that vanishes during DELETE after Stop preflight', async () => {
    const port = nativePort();
    let provider: FakeRunPodProvider | null = null;
    const coordinator = new GpuLifecycleCoordinator(port, (config) => {
      const pod = managedPod(config, 'vanishafterpreflight1');
      provider = new FakeRunPodProvider({ inventory: [], pods: [pod] });
      const health = new FakeWorkerHealthProbe();
      health.setHealth(pod.proxyUrl, { schemaVersion: 1, phase: 'ready', phaseProgress: 1 });
      return new RunPodLifecycleController({ provider, config, workerHealthProbe: health });
    });
    const ready = await coordinator.start(DEFAULT_STUDIO_PROFILE, 12, false);
    provider!.onTerminate((_podId, current) => current.setPods([]));
    vi.mocked(port.clearWorkerSession).mockClear();

    const reconciled = await coordinator.stop(ready.selectedPodId!);

    expect(reconciled.alreadyStopped).toBe(true);
    expect(reconciled.phase).toBe('offline');
    expect(provider!.calls.terminate).toEqual([ready.selectedPodId]);
    expect(port.clearWorkerSession).toHaveBeenCalledOnce();
  });

  it('keeps an authentication failure from Stop visible instead of reconciling it away', async () => {
    const port = nativePort();
    let provider: FakeRunPodProvider | null = null;
    const coordinator = new GpuLifecycleCoordinator(port, (config) => {
      const pod = managedPod(config, 'stopauthfailure1');
      provider = new FakeRunPodProvider({ inventory: [], pods: [pod] });
      const health = new FakeWorkerHealthProbe();
      health.setHealth(pod.proxyUrl, { schemaVersion: 1, phase: 'ready', phaseProgress: 1 });
      return new RunPodLifecycleController({ provider, config, workerHealthProbe: health });
    });
    const ready = await coordinator.start(DEFAULT_STUDIO_PROFILE, 12, false);
    provider!.failNext('terminate', new RunPodClientError({
      code: 'api_authentication_failed',
      message: 'RunPod credentials were rejected.',
      operation: 'terminate_pod',
    }));
    vi.mocked(port.clearWorkerSession).mockClear();

    await expect(coordinator.stop(ready.selectedPodId!)).rejects.toMatchObject({
      code: 'pod_termination_failed',
    });
    expect(provider!.calls.terminate).toEqual([ready.selectedPodId]);
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
    const coordinator = new GpuLifecycleCoordinator(port, (config) => {
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
          hourlyPriceUsd: 0.5,
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
      return new RunPodLifecycleController({ provider, config });
    });

    await expect(coordinator.start(DEFAULT_STUDIO_PROFILE, 450, false)).rejects.toMatchObject({
      code: 'pod_create_ambiguous',
      mayHaveSucceeded: true,
    });
    expect(() => coordinator.resolveAmbiguousStart()).not.toThrow();
  });

  it('pins the portable BF16 contract and keeps emergency capacity opt-in', () => {
    const normal = productionRunPodConfig(DEFAULT_STUDIO_PROFILE, false);
    const emergency = productionRunPodConfig(DEFAULT_STUDIO_PROFILE, true);
    expect(normal.benchmarkContract).toMatchObject({
      model: 'black-forest-labs/FLUX.2-klein-4B',
      modelRevision: 'e7b7dc27f91deacad38e78976d1f2b499d76a294',
      softwareImage: IMAGEFORGE_WORKER_IMAGE,
      precision: 'BF16',
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
