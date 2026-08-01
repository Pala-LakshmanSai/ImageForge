import { RunPodClientError } from "./errors.js";
import { deriveRunPodProxyUrl } from "./proxy.js";
import type {
  ApprovedGpuId,
  CreatePodFromTemplateRequest,
  GpuInventoryRequest,
  GpuOffer,
  ManagedPod,
  PodDiscoveryCriteria,
  RunPodProvider,
  WorkerHealth,
  WorkerHealthProbe,
} from "./types.js";

type ProviderOperation = "inventory" | "list" | "create" | "get" | "terminate";

export interface FakeRunPodProviderOptions {
  readonly inventory?: readonly GpuOffer[];
  readonly pods?: readonly ManagedPod[];
  readonly idFactory?: () => string;
}

export interface FakeProviderCalls {
  readonly inventory: GpuInventoryRequest[];
  readonly list: PodDiscoveryCriteria[];
  readonly create: CreatePodFromTemplateRequest[];
  readonly get: Array<{ readonly podId: string; readonly criteria: PodDiscoveryCriteria }>;
  readonly terminate: string[];
}

type CreateHook = (
  request: CreatePodFromTemplateRequest,
  provider: FakeRunPodProvider,
) => Promise<ManagedPod | undefined> | ManagedPod | undefined;

export class FakeRunPodProvider implements RunPodProvider {
  readonly calls: FakeProviderCalls = {
    inventory: [],
    list: [],
    create: [],
    get: [],
    terminate: [],
  };

  #inventory: GpuOffer[];
  #pods: ManagedPod[];
  #failures = new Map<ProviderOperation, unknown[]>();
  #idFactory: () => string;
  #nextId = 1;
  #createHook: CreateHook | null = null;
  #nextActualGpuId: ApprovedGpuId | null = null;

  constructor(options: FakeRunPodProviderOptions = {}) {
    this.#inventory = [...(options.inventory ?? [])];
    this.#pods = [...(options.pods ?? [])];
    this.#idFactory = options.idFactory ?? (() => `fakepod${this.#nextId++}`);
  }

  setInventory(inventory: readonly GpuOffer[]): void {
    this.#inventory = [...inventory];
  }

  setPods(pods: readonly ManagedPod[]): void {
    this.#pods = [...pods];
  }

  addPod(pod: ManagedPod): void {
    this.#pods.push(Object.freeze({ ...pod }));
  }

  replacePodId(oldPodId: string, newPodId: string, workerPort = 8000): void {
    this.#pods = this.#pods.map((pod) =>
      pod.id === oldPodId
        ? Object.freeze({
            ...pod,
            id: newPodId,
            proxyUrl: deriveRunPodProxyUrl(newPodId, workerPort),
          })
        : pod,
    );
  }

  failNext(operation: ProviderOperation, error: unknown): void {
    const failures = this.#failures.get(operation) ?? [];
    failures.push(error);
    this.#failures.set(operation, failures);
  }

  onCreate(hook: CreateHook | null): void {
    this.#createHook = hook;
  }

  useActualGpuForNextCreate(gpuId: ApprovedGpuId): void {
    this.#nextActualGpuId = gpuId;
  }

  async listGpuInventory(
    request: GpuInventoryRequest,
    _signal?: AbortSignal,
  ): Promise<readonly GpuOffer[]> {
    this.calls.inventory.push(Object.freeze({ ...request }));
    this.#throwFailure("inventory");
    return Object.freeze(this.#inventory.map((offer) => Object.freeze({ ...offer })));
  }

  async listImageForgePods(
    criteria: PodDiscoveryCriteria,
    _signal?: AbortSignal,
  ): Promise<readonly ManagedPod[]> {
    this.calls.list.push(Object.freeze({ ...criteria }));
    this.#throwFailure("list");
    return Object.freeze(
      this.#pods
        .filter(
          (pod) =>
            (pod.name === criteria.podNamePrefix ||
              pod.name.startsWith(`${criteria.podNamePrefix}-`)) &&
            (pod.templateId === null || pod.templateId === criteria.templateId) &&
            (pod.networkVolumeId === null ||
              pod.networkVolumeId === criteria.networkVolumeId),
        )
        .map((pod) => Object.freeze({ ...pod })),
    );
  }

  async createPodFromTemplate(
    request: CreatePodFromTemplateRequest,
    _signal?: AbortSignal,
  ): Promise<ManagedPod> {
    this.calls.create.push(
      Object.freeze({
        ...request,
        gpuTypeIds: Object.freeze([...request.gpuTypeIds]),
        constraints: Object.freeze({ ...request.constraints }),
      }),
    );
    this.#throwFailure("create");
    if (this.#createHook !== null) {
      const hooked = await this.#createHook(request, this);
      if (hooked !== undefined) {
        return Object.freeze({ ...hooked });
      }
    }

    const actualGpuId = this.#nextActualGpuId ?? request.gpuTypeIds[0];
    this.#nextActualGpuId = null;
    if (actualGpuId === undefined) {
      throw new RunPodClientError({
        code: "configuration_invalid",
        message: "The fake create request has no GPU candidate.",
        operation: "configuration",
      });
    }
    const podId = this.#idFactory();
    const pod: ManagedPod = Object.freeze({
      id: podId,
      name: request.name,
      status: "provisioning",
      gpuId: actualGpuId,
      cloud: request.cloud,
      templateId: request.templateId,
      networkVolumeId: request.networkVolumeId,
      hourlyPriceUsd: null,
      createdAt: new Date(0).toISOString(),
      startRequestId: request.startRequestId,
      proxyUrl: deriveRunPodProxyUrl(podId, request.workerPort),
    });
    this.#pods.push(pod);
    return pod;
  }

  async getPod(
    podId: string,
    criteria: PodDiscoveryCriteria,
    _signal?: AbortSignal,
  ): Promise<ManagedPod | null> {
    this.calls.get.push(Object.freeze({ podId, criteria: Object.freeze({ ...criteria }) }));
    this.#throwFailure("get");
    const pod = this.#pods.find((candidate) => candidate.id === podId);
    return pod === undefined ? null : Object.freeze({ ...pod });
  }

  async terminatePod(podId: string, _signal?: AbortSignal): Promise<void> {
    this.calls.terminate.push(podId);
    this.#throwFailure("terminate");
    const index = this.#pods.findIndex((pod) => pod.id === podId);
    if (index === -1) {
      throw new RunPodClientError({
        code: "pod_not_found",
        message: "The selected fake Pod does not exist.",
        operation: "terminate_pod",
      });
    }
    this.#pods.splice(index, 1);
  }

  #throwFailure(operation: ProviderOperation): void {
    const failures = this.#failures.get(operation);
    if (failures === undefined || failures.length === 0) {
      return;
    }
    throw failures.shift();
  }
}

export class FakeWorkerHealthProbe implements WorkerHealthProbe {
  readonly calls: string[] = [];
  #healthByProxy = new Map<string, WorkerHealth>();
  #failureByProxy = new Map<string, unknown>();

  setHealth(proxyUrl: string, health: WorkerHealth): void {
    this.#healthByProxy.set(proxyUrl, Object.freeze({ ...health }));
    this.#failureByProxy.delete(proxyUrl);
  }

  setFailure(proxyUrl: string, error: unknown): void {
    this.#failureByProxy.set(proxyUrl, error);
    this.#healthByProxy.delete(proxyUrl);
  }

  async getHealth(proxyUrl: string, _signal?: AbortSignal): Promise<WorkerHealth> {
    this.calls.push(proxyUrl);
    const failure = this.#failureByProxy.get(proxyUrl);
    if (failure !== undefined) {
      throw failure;
    }
    const health = this.#healthByProxy.get(proxyUrl);
    if (health === undefined) {
      throw new RunPodClientError({
        code: "api_network_error",
        message: "Fake worker health is not configured.",
        operation: "worker_health",
        retryable: true,
      });
    }
    return Object.freeze({ ...health });
  }
}
