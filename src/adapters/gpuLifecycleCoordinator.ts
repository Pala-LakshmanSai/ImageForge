import {
  HttpWorkerHealthProbe as RunPodHealthProbe,
  RunPodLifecycleController,
  type GpuAutoSelectionSourceV1,
  type NativeGpuInventorySnapshotV1,
  type RunPodClientConfig,
  type RunPodClientConfigInput,
  type RunPodSnapshot,
  type StopGuard,
} from '@imageforge/runpod-client';
import { IMAGEFORGE_WORKER_IMAGE, parseStudioProfile, type StudioProfile } from './imageForgeAdapter';
import {
  NativeGpuInventoryCoordinator,
  type NativeGpuInventoryPort,
} from './nativeGpuInventoryCoordinator';
import type {
  NativeAutoGpuStartV1,
  NativeGpuStartPort,
  NativeGpuStartResultV1,
  NativeManualGpuActualPriceV1,
  NativeManualGpuStartV1,
} from '../native/gpuStartBridge';
import type {
  NativeGpuNormalStopResultV1,
  NativeGpuNormalStopV1,
  NativeGpuPodObservationV1,
  NativeGpuPodPort,
} from '../native/gpuPodBridge';
import { NativeObservedRunPodProvider } from './nativeRunPodProvider';

const MODEL_REVISION = 'd8c99241f6fa80fbd453014234af2bf337ea21e6';

export interface GpuLifecycleNativePort {
  workerHealthFetch: typeof fetch;
  gpuInventory: NativeGpuInventoryPort;
  gpuStart: NativeGpuStartPort;
  gpuPod: NativeGpuPodPort;
  bindProfile(templateId: string, networkVolumeId: string): Promise<void>;
  authorizeStart(allowSlowEmergency: boolean): Promise<void>;
  clearStartAuthorization(): Promise<void>;
  clearWorkerSession(): Promise<void>;
}

export type LifecycleControllerFactory = (
  config: RunPodClientConfigInput,
  stopGuard?: StopGuard,
  gpuSelectionSource?: GpuAutoSelectionSourceV1,
) => RunPodLifecycleController;

export interface NativeNormalGpuStopAuthority {
  readonly podId: string;
  readonly stopRequestId: string;
  readonly sessionId: string;
  readonly expectedServerInstanceId: string;
  readonly expectedCoordinationRevision: number;
  /** Terminate without the worker stop-request approval handshake. */
  readonly direct: boolean;
}

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
      model: 'Comfy-Org/Mage-Flow',
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
  readonly #inventory: NativeGpuInventoryCoordinator;
  readonly #nativeProvider: NativeObservedRunPodProvider;
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
    this.#inventory = new NativeGpuInventoryCoordinator(port.gpuInventory);
    this.#nativeProvider = new NativeObservedRunPodProvider(port.gpuPod);
    this.#factory = factory ?? ((config, controllerStopGuard, gpuSelectionSource) => {
      return new RunPodLifecycleController({
        provider: this.#nativeProvider,
        config,
        workerHealthProbe: new RunPodHealthProbe({ fetchTransport: port.workerHealthFetch }),
        stopGuard: controllerStopGuard,
        gpuSelectionSource,
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

  getInventorySnapshot(): NativeGpuInventorySnapshotV1 | null {
    return this.#inventory.getSnapshot();
  }

  subscribeInventory(listener: (snapshot: NativeGpuInventorySnapshotV1) => void): () => void {
    return this.#inventory.subscribe(listener);
  }

  loadInventory(): Promise<NativeGpuInventorySnapshotV1> {
    return this.#inventory.load();
  }

  beginInventoryRefresh(includeEmergencyTier: boolean): Promise<NativeGpuInventorySnapshotV1> {
    return this.#inventory.beginVisibleRefresh(includeEmergencyTier);
  }

  async prepareInventory(
    profileSource: string,
    allowSlowEmergency: boolean,
  ): Promise<NativeGpuInventorySnapshotV1> {
    await this.#ensureController(profileSource, allowSlowEmergency);
    return this.#inventory.refreshForVisibleSelector(allowSlowEmergency);
  }

  loadStart(): Promise<NativeGpuStartResultV1 | null> {
    return this.#port.gpuStart.load();
  }

  async startAuto(
    profileSource: string,
    allowSlowEmergency: boolean,
    input: NativeAutoGpuStartV1,
  ): Promise<NativeGpuStartResultV1> {
    await this.#ensureController(profileSource, allowSlowEmergency);
    return this.#port.gpuStart.startAuto(input);
  }

  async startSelected(
    profileSource: string,
    allowSlowEmergency: boolean,
    input: NativeManualGpuStartV1,
  ): Promise<NativeGpuStartResultV1> {
    await this.#ensureController(profileSource, allowSlowEmergency);
    return this.#port.gpuStart.startSelected(input);
  }

  confirmActualPrice(input: NativeManualGpuActualPriceV1): Promise<NativeGpuStartResultV1> {
    return this.#port.gpuStart.confirmActualPrice(input);
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
    return controller.observePods({ expectedImageCount });
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
    const operation = controller.observePods({
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

  async stop(
    authority: NativeNormalGpuStopAuthority,
  ): Promise<RunPodSnapshot & { readonly alreadyStopped: boolean }> {
    const controller = this.#controller;
    if (controller === null) throw new Error('Refresh the ImageForge Pod before stopping it.');
    // The input revision must name the exact current native Pod projection.
    // Production normally already has this from observe/refresh; a newly
    // constructed controller may establish it once here before the mutation.
    const current = this.#nativeProvider.lastObservation ?? await this.#port.gpuPod.observe();
    if (
      current.overflow
      || current.pods.every((pod) => pod.podId !== authority.podId)
    ) {
      throw Object.assign(
        new Error('The confirmed Pod changed before native Stop authorization.'),
        { code: 'termination_target_mismatch', retryable: false, mayHaveSucceeded: false },
      );
    }

    const nativeResult = await this.#port.gpuPod.normalStop({
      ...authority,
      expectedLifecycleRevision: current.lifecycleRevision,
    });

    return this.#applyNormalStopResult(authority.podId, nativeResult, current);
  }

  /**
   * Replays only the exact input returned by `gpu_normal_stop_load`.
   * Do not rebuild its process/session/revision fields from renderer state:
   * native journal identity is the authority that makes this path
   * observation-only after relaunch.
   */
  async recoverStop(
    input: NativeGpuNormalStopV1,
  ): Promise<RunPodSnapshot & { readonly alreadyStopped: boolean }> {
    const controller = this.#controller;
    if (controller === null) {
      throw new Error('Refresh the ImageForge Pod before recovering its interrupted Stop.');
    }
    const nativeResult = await this.#port.gpuPod.normalStop(input);
    return this.#applyNormalStopResult(input.podId, nativeResult, null);
  }

  async #applyNormalStopResult(
    podId: string,
    nativeResult: NativeGpuNormalStopResultV1,
    freshBase: NativeGpuPodObservationV1 | null,
  ): Promise<RunPodSnapshot & { readonly alreadyStopped: boolean }> {
    const controller = this.#controller;
    if (controller === null) {
      throw new Error('Refresh the ImageForge Pod before applying its native Stop result.');
    }

    if (nativeResult.disposition === 'delete_uncertain') {
      // The strict uncertainty result intentionally retains the old Pod. Keep
      // the already-visible lifecycle projection and worker binding exactly as
      // they are; an unavailable retained observation is evidence, not fresh
      // authority, and must not collapse the UI to Offline or trigger retry.
      this.#nativeProvider.useRetainedStopObservationOnce(nativeResult.observation);
      try {
        await controller.observePods({
          expectedImageCount: controller.getSnapshot().expectedImageCount,
          suppressTransientPhase: true,
        });
      } finally {
        this.#nativeProvider.clearRetainedStopObservation();
      }
      throw Object.assign(
        new Error('RunPod did not confirm whether termination completed. Check the RunPod dashboard before taking another action.'),
        {
          code: 'gpu_stop_delete_uncertain',
          retryable: false,
          mayHaveSucceeded: true,
        },
      );
    }

    // A fresh native Stop owns exactly R+1 preflight and R+2 settlement reads.
    // Consume that R+2 result directly so the renderer cannot add an unbound
    // third provider GET. Relaunch recovery has no live base; a completed
    // journal replay therefore remains historical evidence and must obtain a
    // current projection before clearing the proxy/session binding.
    const isFreshSettlement = freshBase !== null
      && nativeResult.observation.processEpochId === freshBase.processEpochId
      && nativeResult.observation.lifecycleRevision === freshBase.lifecycleRevision + 2;
    const currentProjection = isFreshSettlement
      ? nativeResult.observation
      : await this.#port.gpuPod.observe();
    const oldPodStillPresent = currentProjection.pods.some(
      (pod) => pod.podId === podId,
    );
    if (
      currentProjection.state === 'unavailable'
      || currentProjection.stale
      || currentProjection.overflow
      || currentProjection.issue !== null
      || oldPodStillPresent
    ) {
      throw Object.assign(
        new Error(
          oldPodStillPresent
            ? 'Native Stop completed, but the current Pod projection still contains the old Pod. Refresh before continuing.'
            : 'Native Stop completed, but current Pod state could not be verified. Refresh before continuing.',
        ),
        {
          code: oldPodStillPresent
            ? 'termination_target_mismatch'
            : currentProjection.issue?.code ?? 'gpu_pod_observation_invalid',
          retryable: currentProjection.issue?.retryable === true,
          mayHaveSucceeded: true,
        },
      );
    }
    this.#nativeProvider.useObservationOnce(currentProjection);
    // Either the action-owned R+2 settlement or a post-replay current read is
    // the authority that permits dropping the old proxy/session binding.
    await this.#port.clearWorkerSession();
    const reconciled = await controller.observePods({
      expectedImageCount: controller.getSnapshot().expectedImageCount,
      suppressTransientPhase: true,
    });
    return Object.freeze({
      ...reconciled,
      alreadyStopped: nativeResult.disposition === 'already_stopped',
    });
  }

  dispose(): void {
    this.#observationAbort?.abort();
    this.#observationAbort = null;
    this.#observationPromise = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#inventory.dispose();
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
    this.#nativeProvider.reset();
    // Native inventory receipts are profile-bound. Recreate the renderer
    // listener/load baseline only after the native profile-control boundary
    // has invalidated its private cache, so no old offer can authorize Start.
    await this.#inventory.resetForProfileChange();
    await this.#port.clearWorkerSession();
    this.#unsubscribe?.();
    const generation = this.#controllerGeneration + 1;
    this.#controllerGeneration = generation;
    const controller = this.#factory(
      configFor(profile, allowSlowEmergency),
      this.#stopGuard,
      this.#inventory,
    );
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
