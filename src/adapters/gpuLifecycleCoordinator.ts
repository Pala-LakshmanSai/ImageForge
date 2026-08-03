import {
  HttpWorkerHealthProbe as RunPodHealthProbe,
  RunPodLifecycleController,
  RunPodRestProvider,
  type RunPodClientConfig,
  type RunPodClientConfigInput,
  type RunPodSnapshot,
  type StopGuard,
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
  stopGuard?: StopGuard,
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
  readonly #stopGuard: StopGuard | undefined;
  readonly #listeners = new Set<(snapshot: RunPodSnapshot) => void>();
  #controller: RunPodLifecycleController | null = null;
  #fingerprint: string | null = null;
  #allowSlowEmergency = false;
  #unresolvedRequestId: string | null = null;
  #unsubscribe: (() => void) | null = null;
  #observationAbort: AbortController | null = null;
  #observationPromise: Promise<RunPodSnapshot> | null = null;
  #controllerGeneration = 0;

  constructor(port: GpuLifecycleNativePort, factory?: LifecycleControllerFactory, stopGuard?: StopGuard) {
    this.#port = port;
    this.#stopGuard = stopGuard;
    this.#factory = factory ?? ((config, controllerStopGuard) => {
      const provider = new RunPodRestProvider({
        apiKeyProvider: () => NATIVE_RUNPOD_API_KEY_SENTINEL,
        fetchTransport: port.runPodFetch,
      });
      return new RunPodLifecycleController({
        provider,
        config,
        workerHealthProbe: new RunPodHealthProbe({ fetchTransport: port.workerHealthFetch }),
        stopGuard: controllerStopGuard,
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
    // Foreground/manual/Generate refreshes are authoritative and must not sit
    // behind a slow advisory heartbeat. Abort the receipt-free observation;
    // its queued lifecycle work sees the same signal and becomes inert.
    this.#observationAbort?.abort();
    return controller.refresh({ expectedImageCount });
  }

  /**
   * A bounded, read-only cross-client heartbeat. It retains the current
   * visible phase until RunPod returns, so an idle offline screen cannot
   * flicker through `selecting` between observations.
   */
  async observe(
    profileSource: string,
    expectedImageCount = 450,
    allowSlowEmergency = this.#allowSlowEmergency,
  ): Promise<RunPodSnapshot> {
    const controller = await this.#ensureController(profileSource, allowSlowEmergency);
    if (this.#observationPromise !== null) return this.#observationPromise;
    const abort = new AbortController();
    this.#observationAbort = abort;
    const operation = controller.refresh({
      expectedImageCount,
      suppressTransientPhase: true,
      signal: abort.signal,
    }).finally(() => {
      if (this.#observationPromise === operation) this.#observationPromise = null;
      if (this.#observationAbort === abort) this.#observationAbort = null;
    });
    this.#observationPromise = operation;
    return operation;
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

  async stop(podId: string): Promise<RunPodSnapshot & { readonly alreadyStopped: boolean }> {
    const controller = this.#controller;
    if (controller === null) throw new Error('Refresh the ImageForge Pod before stopping it.');
    const confirmation = controller.requestStopConfirmation({
      intent: 'stop_gpu',
      source: 'foreground_user',
      podId,
    });
    let result: RunPodSnapshot;
    try {
      result = (await controller.stopGpu({
        intent: 'confirm_stop_gpu',
        source: 'foreground_user',
        podId,
        confirmationToken: confirmation.token,
      })).snapshot;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : null;
      // A preflight absence or profile drift is not a completed Stop. Refresh
      // so every observer sees a replacement/offline truth, but preserve the
      // failure and the existing worker binding until ordinary offline
      // reconciliation handles it.
      if (code === 'termination_target_mismatch') {
        await controller.refresh({
          expectedImageCount: controller.getSnapshot().expectedImageCount,
        });
        throw error;
      }
      // A Pod can disappear in the small gap after the fresh preflight and
      // before DELETE. Only that typed DELETE absence is safely reconcilable;
      // auth, timeout, and 5xx errors must remain errors for the operator.
      if (code !== 'pod_not_found') throw error;
      const reconciled = await controller.refresh({
        expectedImageCount: controller.getSnapshot().expectedImageCount,
      });
      // `pod_not_found` reaches this branch only after the exact Pod passed
      // lifecycle revalidation and RunPod then returned DELETE 404. A newly
      // active replacement must never be collapsed into "already stopped".
      const anyActive = reconciled.pods.some((pod) =>
        ['provisioning', 'starting', 'running', 'unknown', 'error'].includes(pod.status));
      if (anyActive) throw error;
      await this.#port.clearWorkerSession();
      return Object.freeze({ ...reconciled, alreadyStopped: true });
    }
    await this.#port.clearWorkerSession();
    return Object.freeze({ ...result, alreadyStopped: false });
  }

  dispose(): void {
    this.#observationAbort?.abort();
    this.#observationAbort = null;
    this.#observationPromise = null;
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
    const generation = this.#controllerGeneration + 1;
    this.#controllerGeneration = generation;
    const controller = this.#factory(configFor(profile, allowSlowEmergency), this.#stopGuard);
    this.#controller = controller;
    this.#fingerprint = fingerprint;
    this.#allowSlowEmergency = allowSlowEmergency;
    this.#unsubscribe = controller.subscribe((snapshot) => {
      if (generation !== this.#controllerGeneration) return;
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
