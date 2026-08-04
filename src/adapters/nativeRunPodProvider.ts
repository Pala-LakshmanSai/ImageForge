import type {
  CreatePodFromTemplateRequest,
  GpuInventoryRequest,
  GpuOffer,
  ManagedPod,
  PodDiscoveryCriteria,
  RunPodProvider,
} from '@imageforge/runpod-client';
import type {
  NativeGpuPodObservationV1,
  NativeGpuPodPort,
} from '../native/gpuPodBridge';

function aborted(signal: AbortSignal | undefined): Error | null {
  if (signal?.aborted !== true) return null;
  return signal.reason instanceof Error ? signal.reason : new DOMException('Operation aborted.', 'AbortError');
}

function unavailable(message: string): Error {
  return Object.assign(new Error(message), {
    code: 'pod_discovery_failed',
    retryable: true,
  });
}

/**
 * Compatibility projection for the existing lifecycle view. Provider access
 * stays native-owned: this adapter can only read the strict profile-scoped Pod
 * observation and cannot list catalog inventory, create, or terminate compute.
 */
export class NativeObservedRunPodProvider implements RunPodProvider {
  readonly requiresWorkerHealthProbe = true;
  readonly #port: NativeGpuPodPort;
  #lastObservation: NativeGpuPodObservationV1 | null = null;
  #nextObservation: NativeGpuPodObservationV1 | null = null;
  #retainedStopObservation: NativeGpuPodObservationV1 | null = null;

  constructor(port: NativeGpuPodPort) {
    this.#port = port;
  }

  get lastObservation(): NativeGpuPodObservationV1 | null {
    return this.#lastObservation;
  }

  reset(): void {
    this.#lastObservation = null;
    this.#nextObservation = null;
    this.#retainedStopObservation = null;
  }

  useObservationOnce(observation: NativeGpuPodObservationV1): void {
    this.#nextObservation = observation;
  }

  /**
   * Preserve an ambiguity-bound Pod as display-only lifecycle evidence. The
   * `unknown` status keeps it active/visible for Stop safety but outside the
   * reusable Ready admission set.
   */
  useRetainedStopObservationOnce(observation: NativeGpuPodObservationV1): void {
    this.#retainedStopObservation = Object.freeze({
      ...observation,
      state: 'unavailable',
      stale: true,
      overflow: false,
      pods: Object.freeze(observation.pods.map((pod) => Object.freeze({
        ...pod,
        status: 'unknown' as const,
      }))),
      issue: Object.freeze({
        code: 'gpu_pod_observation_unavailable' as const,
        retryable: true as const,
      }),
    });
  }

  clearRetainedStopObservation(): void {
    this.#retainedStopObservation = null;
  }

  async listGpuInventory(
    _request: GpuInventoryRequest,
    _signal?: AbortSignal,
  ): Promise<readonly GpuOffer[]> {
    throw unavailable('Catalog inventory is available only through the native GPU inventory commands.');
  }

  async listImageForgePods(
    criteria: PodDiscoveryCriteria,
    signal?: AbortSignal,
  ): Promise<readonly ManagedPod[]> {
    const abortError = aborted(signal);
    if (abortError !== null) throw abortError;
    const observation = this.#retainedStopObservation
      ?? this.#nextObservation
      ?? await this.#port.observe();
    this.#nextObservation = null;
    const afterReadAbort = aborted(signal);
    if (afterReadAbort !== null) throw afterReadAbort;
    this.#lastObservation = observation;
    if (observation.state === 'unavailable' && observation.pods.length === 0) {
      throw unavailable(
        observation.issue?.code === 'gpu_pod_observation_invalid'
          ? 'Native Pod observation rejected an invalid provider response.'
          : 'Native Pod observation is temporarily unavailable.',
      );
    }
    if (observation.overflow) {
      throw unavailable('Native Pod observation found too many managed Pods to project safely.');
    }
    return Object.freeze(observation.pods.map((pod): ManagedPod => Object.freeze({
      id: pod.podId,
      // Pod name is not an authority in Task 014. Keep a deterministic local
      // label only for the legacy lifecycle view while all matching remains by
      // the strict native-filtered Pod ID and bound profile below.
      name: `${criteria.podNamePrefix}-${pod.podId}`,
      status: observation.state === 'unavailable' ? 'unknown' : pod.status,
      gpuId: pod.gpuId,
      gpuDisplayName: pod.gpuDisplayName,
      gpuCount: criteria.gpuCount,
      cloud: criteria.cloud,
      dataCenterId: criteria.dataCenterId,
      templateId: criteria.templateId,
      networkVolumeId: criteria.networkVolumeId,
      networkVolumeMountPath: criteria.networkVolumeMountPath,
      interruptible: criteria.interruptible,
      hourlyPriceMicroUsd: pod.hourlyPriceMicroUsd,
      createdAt: null,
      startRequestId: null,
      proxyUrl: `https://${pod.podId}-${criteria.workerPort}.proxy.runpod.net`,
    })));
  }

  async getPod(
    podId: string,
    criteria: PodDiscoveryCriteria,
    signal?: AbortSignal,
  ): Promise<ManagedPod | null> {
    const pods = await this.listImageForgePods(criteria, signal);
    return pods.find((pod) => pod.id === podId) ?? null;
  }

  async createPodFromTemplate(
    _request: CreatePodFromTemplateRequest,
    _signal?: AbortSignal,
  ): Promise<ManagedPod> {
    throw unavailable('GPU creation is available only through the native GPU Start commands.');
  }

  async terminatePod(_podId: string, _signal?: AbortSignal): Promise<void> {
    throw unavailable('GPU deletion is available only through the native coordinated Stop command.');
  }
}
