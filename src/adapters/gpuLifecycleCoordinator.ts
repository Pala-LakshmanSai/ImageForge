import {
  HttpWorkerHealthProbe as RunPodHealthProbe,
  RunPodLifecycleController,
  RunPodRestProvider,
  type RunPodClientConfig,
  type RunPodClientConfigInput,
  type RunPodSnapshot,
} from '@imageforge/runpod-client';
import { NATIVE_RUNPOD_API_KEY_SENTINEL } from '../native/tauriBridge';
import { IMAGEFORGE_WORKER_IMAGE, parseStudioProfile, type StudioProfile } from './imageForgeAdapter';

const MODEL_REVISION = 'e7b7dc27f91deacad38e78976d1f2b499d76a294';

export interface GpuLifecycleNativePort {
  runPodFetch: typeof fetch;
  workerHealthFetch: typeof fetch;
  bindProfile(templateId: string, networkVolumeId: string): Promise<void>;
  authorizeStart(allowSlowEmergency: boolean): Promise<void>;
  clearStartAuthorization(): Promise<void>;
  clearWorkerSession(): Promise<void>;
}

export type LifecycleControllerFactory = (
  config: RunPodClientConfigInput,
) => RunPodLifecycleController;

function configFor(profile: StudioProfile, allowSlowEmergency: boolean): RunPodClientConfigInput {
  return {
    templateId: profile.templateId,
    networkVolumeId: profile.networkVolumeId,
    networkVolumeDataCenterId: 'EU-RO-1',
    networkVolumeMountPath: '/workspace',
    podNamePrefix: 'imageforge',
    workerPort: 8000,
    gpuCount: 1,
    cloudLanes: ['secure'],
    allowEmergencyGpuTier: allowSlowEmergency,
    defaultImageCount: 450,
    refreshIntervalMs: 1_000,
    provisioningTimeoutMs: 20 * 60_000,
    operationTimeoutMs: 30_000,
    stopConfirmationTtlMs: 2 * 60_000,
    constraints: { allowedCudaVersions: ['13.0'], minRamPerGpuGb: 16 },
    benchmarkContract: {
      model: 'black-forest-labs/FLUX.2-klein-4B',
      modelRevision: MODEL_REVISION,
      // A RunPod template is immutable from ImageForge's perspective. Paid
      // benchmark profiles are admitted only when recorded against this exact
      // template binding and all other fixed image/model settings.
      softwareImage: IMAGEFORGE_WORKER_IMAGE,
      precision: 'BF16',
      width: 1280,
      height: 720,
      steps: 4,
      guidance: 1,
      jpegQuality: 95,
    },
    benchmarkProfiles: [],
  };
}

function canReplaceController(snapshot: RunPodSnapshot): boolean {
  return (
    snapshot.pods.length === 0 &&
    snapshot.selectedPodId === null &&
    !snapshot.warnings.some((warning) => warning.code === 'ambiguous_create_unresolved') &&
    ['offline', 'error'].includes(snapshot.phase)
  );
}

export class GpuLifecycleCoordinator {
  readonly #port: GpuLifecycleNativePort;
  readonly #factory: LifecycleControllerFactory;
  readonly #listeners = new Set<(snapshot: RunPodSnapshot) => void>();
  #controller: RunPodLifecycleController | null = null;
  #fingerprint: string | null = null;
  #allowSlowEmergency = false;
  #unresolvedRequestId: string | null = null;
  #unsubscribe: (() => void) | null = null;

  constructor(port: GpuLifecycleNativePort, factory?: LifecycleControllerFactory) {
    this.#port = port;
    this.#factory = factory ?? ((config) => {
      const provider = new RunPodRestProvider({
        apiKeyProvider: () => NATIVE_RUNPOD_API_KEY_SENTINEL,
        fetchTransport: port.runPodFetch,
      });
      return new RunPodLifecycleController({
        provider,
        config,
        workerHealthProbe: new RunPodHealthProbe({ fetchTransport: port.workerHealthFetch }),
      });
    });
  }

  subscribe(listener: (snapshot: RunPodSnapshot) => void): () => void {
    this.#listeners.add(listener);
    if (this.#controller !== null) listener(this.#controller.getSnapshot());
    return () => this.#listeners.delete(listener);
  }

  getSnapshot(): RunPodSnapshot | null {
    return this.#controller?.getSnapshot() ?? null;
  }

  async refresh(
    profileSource: string,
    expectedImageCount = 450,
    allowSlowEmergency = this.#allowSlowEmergency,
  ): Promise<RunPodSnapshot> {
    const controller = await this.#ensureController(profileSource, allowSlowEmergency);
    return controller.refresh({ expectedImageCount });
  }

  async start(
    profileSource: string,
    expectedImageCount: number,
    allowSlowEmergency: boolean,
  ): Promise<RunPodSnapshot> {
    const controller = await this.#ensureController(profileSource, allowSlowEmergency);
    const requestId = crypto.randomUUID();
    await this.#port.authorizeStart(allowSlowEmergency);
    try {
      const result = await controller.startGpu({
        intent: 'start_gpu',
        source: 'foreground_user',
        expectedImageCount,
        requestId,
      });
      this.#unresolvedRequestId = null;
      const ready = result.snapshot.phase === 'ready'
        ? result.snapshot
        : await controller.waitUntilReady({ expectedImageCount });
      await this.#port.clearStartAuthorization();
      return ready;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'mayHaveSucceeded' in error &&
        error.mayHaveSucceeded === true
      ) {
        this.#unresolvedRequestId = requestId;
      }
      // Preserve the authoritative lifecycle error if clearing a grant that
      // was never consumed also fails.
      try { await this.#port.clearStartAuthorization(); } catch { /* fail remains surfaced above */ }
      throw error;
    }
  }

  resolveAmbiguousStart(): RunPodSnapshot {
    if (this.#controller === null || this.#unresolvedRequestId === null) {
      throw new Error('There is no unresolved GPU start to resolve.');
    }
    const snapshot = this.#controller.resolveAmbiguousCreate({
      intent: 'resolve_ambiguous_create',
      source: 'foreground_user',
      requestId: this.#unresolvedRequestId,
    });
    this.#unresolvedRequestId = null;
    return snapshot;
  }

  async stop(podId: string): Promise<RunPodSnapshot> {
    const controller = this.#controller;
    if (controller === null) throw new Error('Refresh the ImageForge Pod before stopping it.');
    const confirmation = controller.requestStopConfirmation({
      intent: 'stop_gpu',
      source: 'foreground_user',
      podId,
    });
    const result = await controller.stopGpu({
      intent: 'confirm_stop_gpu',
      source: 'foreground_user',
      podId,
      confirmationToken: confirmation.token,
    });
    await this.#port.clearWorkerSession();
    return result.snapshot;
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#listeners.clear();
  }

  async #ensureController(
    profileSource: string,
    allowSlowEmergency: boolean,
  ): Promise<RunPodLifecycleController> {
    const profile = parseStudioProfile(profileSource);
    if (profile === null) throw new Error('The ImageForge studio profile is invalid.');
    const fingerprint = `${profile.templateId}\u0000${profile.networkVolumeId}\u0000${allowSlowEmergency}`;
    if (this.#controller !== null && this.#fingerprint === fingerprint) return this.#controller;
    if (this.#controller !== null && !canReplaceController(this.#controller.getSnapshot())) {
      throw new Error('The active or unresolved Pod must be handled before changing GPU policy.');
    }

    await this.#port.bindProfile(profile.templateId, profile.networkVolumeId);
    await this.#port.clearWorkerSession();
    this.#unsubscribe?.();
    const controller = this.#factory(configFor(profile, allowSlowEmergency));
    this.#controller = controller;
    this.#fingerprint = fingerprint;
    this.#allowSlowEmergency = allowSlowEmergency;
    this.#unsubscribe = controller.subscribe((snapshot) => {
      for (const listener of this.#listeners) listener(snapshot);
    });
    return controller;
  }
}

export function productionRunPodConfig(
  profileSource: string,
  allowSlowEmergency: boolean,
): RunPodClientConfigInput {
  const profile = parseStudioProfile(profileSource);
  if (profile === null) throw new Error('The ImageForge studio profile is invalid.');
  return configFor(profile, allowSlowEmergency);
}

export type { RunPodClientConfig };
