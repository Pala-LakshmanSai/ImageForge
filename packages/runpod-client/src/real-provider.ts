import { RunPodClientError, asRunPodClientError } from "./errors.js";
import { approveCatalogGpu } from "./gpu-policy.js";
import {
  AuthorizedRestClient,
  type ApiKeyProvider,
  type FetchTransport,
  validateBaseUrl,
} from "./http.js";
import { deriveRunPodProxyUrl } from "./proxy.js";
import {
  type ApprovedGpuId,
  type AvailabilityLevel,
  type Clock,
  type CloudLane,
  type CreatePodFromTemplateRequest,
  type GpuInventoryRequest,
  type GpuOffer,
  type ManagedPod,
  type PodDiscoveryCriteria,
  type PodStatus,
  type RunPodProvider,
} from "./types.js";
import {
  asArray,
  asBoolean,
  asNonEmptyString,
  asNullableFiniteNumber,
  asNullableString,
  asNumber,
  asRecord,
  asString,
} from "./validation.js";

export interface GpuInventorySource {
  listGpuInventory(
    request: GpuInventoryRequest,
    signal?: AbortSignal,
  ): Promise<readonly GpuOffer[]>;
}

export interface RunPodV2InventorySourceOptions {
  readonly apiKeyProvider: ApiKeyProvider;
  readonly fetchTransport?: FetchTransport;
  readonly baseUrl?: string;
  readonly clock?: Clock;
}

function parseAvailability(value: unknown, field: string): AvailabilityLevel {
  const normalized = asString(value, "inventory", field).toLowerCase();
  if (
    normalized !== "none" &&
    normalized !== "low" &&
    normalized !== "medium" &&
    normalized !== "high"
  ) {
    throw new RunPodClientError({
      code: "api_response_invalid",
      message: "RunPod returned an unknown GPU availability value.",
      operation: "inventory",
      details: { field },
    });
  }
  return normalized;
}

export class RunPodV2InventorySource implements GpuInventorySource {
  readonly #client: AuthorizedRestClient;
  readonly #baseUrl: string;
  readonly #clock: Clock;

  constructor(options: RunPodV2InventorySourceOptions) {
    this.#client = new AuthorizedRestClient(options.apiKeyProvider, options.fetchTransport);
    this.#baseUrl = validateBaseUrl(
      options.baseUrl ?? "https://api.runpod.io/v2",
      "inventoryBaseUrl",
    );
    this.#clock = options.clock ?? { now: () => Date.now() };
  }

  async listGpuInventory(
    request: GpuInventoryRequest,
    signal?: AbortSignal,
  ): Promise<readonly GpuOffer[]> {
    try {
      const dataCenterPromise = this.#client.requestJson(
        `${this.#baseUrl}/catalog/datacenters?include=GPU_AVAILABILITY`,
        {
          method: "GET",
          operation: "inventory",
          expectedStatuses: [200],
          ...(signal === undefined ? {} : { signal }),
        },
      );
      const lanePromises = request.cloudLanes.map(async (cloud) => {
          const query = new URLSearchParams({
            include: "AVAILABILITY",
            product: "POD",
            count: String(request.gpuCount),
            cloud: cloud.toUpperCase(),
            minCudaVersion: "12.8",
          });
          const raw = await this.#client.requestJson(`${this.#baseUrl}/catalog/gpus?${query}`, {
            method: "GET",
            operation: "inventory",
            expectedStatuses: [200],
            ...(signal === undefined ? {} : { signal }),
          });
          return { cloud, raw } as const;
        });
      const [dataCenterRaw, ...laneResponses] = await Promise.all([
        dataCenterPromise,
        ...lanePromises,
      ]);
      const dataCenterAvailability = this.#parseDataCenterAvailability(
        dataCenterRaw,
        request.dataCenterId,
      );
      return Object.freeze(
        laneResponses.flatMap(({ cloud, raw }) =>
          this.#parseLane(raw, cloud, request, dataCenterAvailability),
        ),
      );
    } catch (error) {
      throw asRunPodClientError(error, {
        code: "inventory_unavailable",
        message: "Live RunPod GPU inventory could not be loaded.",
        operation: "inventory",
        retryable: true,
      });
    }
  }

  #parseLane(
    raw: unknown,
    cloud: CloudLane,
    request: GpuInventoryRequest,
    dataCenterAvailability: ReadonlyMap<string, AvailabilityLevel>,
  ): readonly GpuOffer[] {
    const response = asRecord(raw, "inventory");
    const gpus = asArray(response.gpus, "inventory", "response.gpus");
    const observedAt = new Date(this.#clock.now()).toISOString();
    const offers: GpuOffer[] = [];

    gpus.forEach((entry, index) => {
      const field = `response.gpus[${index}]`;
      const gpu = asRecord(entry, "inventory", field);
      const id = asNonEmptyString(gpu.id, "inventory", `${field}.id`);
      const name = asNonEmptyString(gpu.name, "inventory", `${field}.name`);
      const manufacturer = asNonEmptyString(
        gpu.manufacturer,
        "inventory",
        `${field}.manufacturer`,
      );
      const memoryGb = asNumber(gpu.memory, "inventory", `${field}.memory`);
      asBoolean(gpu.secure, "inventory", `${field}.secure`);
      asBoolean(gpu.community, "inventory", `${field}.community`);
      const price = asRecord(gpu.price, "inventory", `${field}.price`);
      const securePrice = asNumber(price.secure, "inventory", `${field}.price.secure`);
      const communityPrice = asNumber(
        price.community,
        "inventory",
        `${field}.price.community`,
      );
      const maxCount = asRecord(gpu.maxCount, "inventory", `${field}.maxCount`);
      asNumber(maxCount.secure, "inventory", `${field}.maxCount.secure`);
      asNumber(maxCount.community, "inventory", `${field}.maxCount.community`);
      parseAvailability(
        gpu.availability,
        `${field}.availability`,
      );
      if (gpu.dataCenters !== undefined) {
        const dataCenters = asArray(gpu.dataCenters, "inventory", `${field}.dataCenters`);
        for (const [dataCenterIndex, dataCenterEntry] of dataCenters.entries()) {
          const dataCenterField = `${field}.dataCenters[${dataCenterIndex}]`;
          const dataCenter = asRecord(dataCenterEntry, "inventory", dataCenterField);
          asNonEmptyString(dataCenter.id, "inventory", `${dataCenterField}.id`);
          asNonEmptyString(dataCenter.name, "inventory", `${dataCenterField}.name`);
          parseAvailability(dataCenter.availability, `${dataCenterField}.availability`);
        }
      }

      const approved = approveCatalogGpu(
        { id, name, manufacturer, memoryGb },
        request.includeEmergencyTier,
      );
      if (approved === null) {
        return;
      }
      const laneSupported = cloud === "secure" ? gpu.secure === true : gpu.community === true;
      const selectedDataCenterAvailability = dataCenterAvailability.get(id) ?? null;
      const volumeCompatible = laneSupported && selectedDataCenterAvailability !== null;
      const availability = volumeCompatible ? (selectedDataCenterAvailability ?? "none") : "none";
      const hourlyPriceUsd = cloud === "secure" ? securePrice : communityPrice;
      offers.push(
        Object.freeze({
          gpuId: approved.gpuId,
          policyKey: approved.policyKey,
          coldPriority: approved.coldPriority,
          emergency: approved.emergency,
          displayName: name,
          cloud,
          hourlyPriceUsd,
          availability,
          dataCenterId: request.dataCenterId,
          volumeCompatible,
          observedAt,
        }),
      );
    });

    return Object.freeze(offers);
  }

  #parseDataCenterAvailability(
    raw: unknown,
    requestedDataCenterId: string,
  ): ReadonlyMap<string, AvailabilityLevel> {
    const response = asRecord(raw, "inventory");
    const dataCenters = asArray(response.dataCenters, "inventory", "response.dataCenters");
    let selected: Record<string, unknown> | null = null;
    for (const [index, entry] of dataCenters.entries()) {
      const field = `response.dataCenters[${index}]`;
      const dataCenter = asRecord(entry, "inventory", field);
      const id = asNonEmptyString(dataCenter.id, "inventory", `${field}.id`);
      asNonEmptyString(dataCenter.name, "inventory", `${field}.name`);
      asNonEmptyString(dataCenter.region, "inventory", `${field}.region`);
      asBoolean(dataCenter.globalNetwork, "inventory", `${field}.globalNetwork`);
      asArray(dataCenter.networkVolumeTypes, "inventory", `${field}.networkVolumeTypes`);
      asArray(dataCenter.compliance, "inventory", `${field}.compliance`);
      if (id === requestedDataCenterId) {
        selected = dataCenter;
      }
    }
    if (selected === null) {
      return new Map();
    }
    const availabilityEntries = asArray(
      selected.gpuAvailability,
      "inventory",
      "response.dataCenters[].gpuAvailability",
    );
    const availability = new Map<string, AvailabilityLevel>();
    for (const [index, entry] of availabilityEntries.entries()) {
      const field = `response.dataCenters[].gpuAvailability[${index}]`;
      const gpu = asRecord(entry, "inventory", field);
      const id = asNonEmptyString(gpu.id, "inventory", `${field}.id`);
      asNonEmptyString(gpu.name, "inventory", `${field}.name`);
      availability.set(id, parseAvailability(gpu.availability, `${field}.availability`));
    }
    return availability;
  }
}

export interface RunPodRestProviderOptions {
  readonly apiKeyProvider: ApiKeyProvider;
  readonly fetchTransport?: FetchTransport;
  readonly lifecycleBaseUrl?: string;
  readonly inventoryBaseUrl?: string;
  readonly inventorySource?: GpuInventorySource;
  readonly clock?: Clock;
}

function extractStartRequestId(name: string, prefix: string): string | null {
  const marker = `${prefix}-`;
  if (!name.startsWith(marker)) {
    return null;
  }
  const requestId = name.slice(marker.length);
  return requestId.length === 0 ? null : requestId;
}

export function buildManagedPodName(prefix: string, startRequestId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(startRequestId)) {
    throw new RunPodClientError({
      code: "configuration_invalid",
      message: "The start request identifier is invalid.",
      operation: "configuration",
      details: { field: "requestId" },
    });
  }
  const name = `${prefix}-${startRequestId}`;
  if (name.length > 191) {
    throw new RunPodClientError({
      code: "configuration_invalid",
      message: "The managed Pod name is too long.",
      operation: "configuration",
      details: { field: "podNamePrefix" },
    });
  }
  return name;
}

function parsePodStatus(rawStatus: string, createResponse: boolean): PodStatus {
  switch (rawStatus.toUpperCase()) {
    case "RUNNING":
      return createResponse ? "provisioning" : "running";
    case "PROVISIONING":
      return "provisioning";
    case "STARTING":
      return "starting";
    case "EXITED":
    case "STOPPED":
      return "exited";
    case "ERROR":
      return "error";
    case "TERMINATED":
      return "terminated";
    default:
      return "unknown";
  }
}

export class RunPodRestProvider implements RunPodProvider {
  readonly #client: AuthorizedRestClient;
  readonly #baseUrl: string;
  readonly #inventorySource: GpuInventorySource;

  constructor(options: RunPodRestProviderOptions) {
    this.#client = new AuthorizedRestClient(options.apiKeyProvider, options.fetchTransport);
    this.#baseUrl = validateBaseUrl(
      options.lifecycleBaseUrl ?? "https://rest.runpod.io/v1",
      "lifecycleBaseUrl",
    );
    this.#inventorySource =
      options.inventorySource ??
      new RunPodV2InventorySource({
        apiKeyProvider: options.apiKeyProvider,
        ...(options.fetchTransport === undefined
          ? {}
          : { fetchTransport: options.fetchTransport }),
        ...(options.inventoryBaseUrl === undefined ? {} : { baseUrl: options.inventoryBaseUrl }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });
  }

  listGpuInventory(
    request: GpuInventoryRequest,
    signal?: AbortSignal,
  ): Promise<readonly GpuOffer[]> {
    return this.#inventorySource.listGpuInventory(request, signal);
  }

  async listImageForgePods(
    criteria: PodDiscoveryCriteria,
    signal?: AbortSignal,
  ): Promise<readonly ManagedPod[]> {
    try {
      const raw = await this.#client.requestJson(
        `${this.#baseUrl}/pods?computeType=GPU&includeMachine=true&includeNetworkVolume=true`,
        {
          method: "GET",
          operation: "list_pods",
          expectedStatuses: [200],
          ...(signal === undefined ? {} : { signal }),
        },
      );
      const entries = asArray(raw, "list_pods", "response");
      const pods = entries.map((entry, index) =>
        this.#parsePod(entry, criteria, false, `response[${index}]`),
      );
      return Object.freeze(pods.filter((pod): pod is ManagedPod => pod !== null));
    } catch (error) {
      throw asRunPodClientError(error, {
        code: "pod_discovery_failed",
        message: "Existing ImageForge Pods could not be discovered.",
        operation: "list_pods",
        retryable: true,
      });
    }
  }

  async createPodFromTemplate(
    request: CreatePodFromTemplateRequest,
    signal?: AbortSignal,
  ): Promise<ManagedPod> {
    if (
      request.gpuTypeIds.length === 0 ||
      new Set(request.gpuTypeIds).size !== request.gpuTypeIds.length ||
      request.gpuTypeIds.some((gpuId) => !/^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,190}$/.test(gpuId))
    ) {
      throw new RunPodClientError({
        code: "configuration_invalid",
        message: "Pod creation requires a non-empty unique list of approved GPU candidates.",
        operation: "configuration",
        details: { field: "gpuTypeIds" },
      });
    }

    const body: Record<string, unknown> = {
      name: request.name,
      templateId: request.templateId,
      networkVolumeId: request.networkVolumeId,
      volumeMountPath: request.networkVolumeMountPath,
      ports: [`${request.workerPort}/http`],
      computeType: "GPU",
      cloudType: request.cloud.toUpperCase(),
      gpuTypeIds: [...request.gpuTypeIds],
      gpuTypePriority: request.gpuTypePriority,
      gpuCount: request.gpuCount,
      interruptible: request.interruptible,
      dataCenterIds: [request.networkVolumeDataCenterId],
    };
    const constraints = request.constraints;
    if (constraints.allowedCudaVersions !== undefined) {
      body.allowedCudaVersions = [...constraints.allowedCudaVersions];
    }
    if (constraints.minRamPerGpuGb !== undefined) {
      body.minRAMPerGPU = constraints.minRamPerGpuGb;
    }
    if (constraints.minDiskBandwidthMbps !== undefined) {
      body.minDiskBandwidthMBps = constraints.minDiskBandwidthMbps;
    }
    if (constraints.minDownloadMbps !== undefined) {
      body.minDownloadMbps = constraints.minDownloadMbps;
    }
    if (constraints.minUploadMbps !== undefined) {
      body.minUploadMbps = constraints.minUploadMbps;
    }

    const raw = await this.#client.requestJson(`${this.#baseUrl}/pods`, {
      method: "POST",
      operation: "create_pod",
      expectedStatuses: [200, 201],
      body,
      ...(signal === undefined ? {} : { signal }),
    });
    const criteria: PodDiscoveryCriteria = {
      podNamePrefix: request.name.slice(0, -(request.startRequestId.length + 1)),
      templateId: request.templateId,
      networkVolumeId: request.networkVolumeId,
      workerPort: request.workerPort,
    };
    const pod = this.#parsePod(raw, criteria, true, "response");
    if (pod === null || pod.gpuId === null) {
      throw new RunPodClientError({
        code: "api_response_invalid",
        message: "RunPod created a Pod but did not return its approved GPU details.",
        operation: "create_pod",
        mayHaveSucceeded: true,
      });
    }
    return pod;
  }

  async getPod(
    podId: string,
    criteria: PodDiscoveryCriteria,
    signal?: AbortSignal,
  ): Promise<ManagedPod | null> {
    const response = await this.#client.request(
      `${this.#baseUrl}/pods/${encodeURIComponent(podId)}?includeMachine=true&includeNetworkVolume=true`,
      {
        method: "GET",
        operation: "get_pod",
        expectedStatuses: [200, 404],
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (response.status === 404) {
      return null;
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error) {
      throw new RunPodClientError({
        code: "api_response_invalid",
        message: "RunPod returned malformed JSON.",
        operation: "get_pod",
        cause: error,
      });
    }
    return this.#parsePod(raw, criteria, false, "response");
  }

  async terminatePod(podId: string, signal?: AbortSignal): Promise<void> {
    await this.#client.request(`${this.#baseUrl}/pods/${encodeURIComponent(podId)}`, {
      method: "DELETE",
      operation: "terminate_pod",
      expectedStatuses: [200, 204],
      ...(signal === undefined ? {} : { signal }),
    });
  }

  #parsePod(
    raw: unknown,
    criteria: PodDiscoveryCriteria,
    createResponse: boolean,
    field: string,
  ): ManagedPod | null {
    const pod = asRecord(raw, createResponse ? "create_pod" : "list_pods", field);
    const operation = createResponse ? "create_pod" : "list_pods";
    const id = asNonEmptyString(pod.id, operation, `${field}.id`);
    const name = asNonEmptyString(pod.name, operation, `${field}.name`);
    const desiredStatus = asNonEmptyString(
      pod.desiredStatus ?? pod.status,
      operation,
      `${field}.desiredStatus`,
    );
    const templateId = asNullableString(pod.templateId, operation, `${field}.templateId`);
    const networkVolumeRaw = pod.networkVolume;
    const networkVolumeId =
      networkVolumeRaw === null || networkVolumeRaw === undefined
        ? null
        : asNonEmptyString(
            asRecord(networkVolumeRaw, operation, `${field}.networkVolume`).id,
            operation,
            `${field}.networkVolume.id`,
          );

    const managedName = name === criteria.podNamePrefix || name.startsWith(`${criteria.podNamePrefix}-`);
    const templateMatches = templateId === null || templateId === criteria.templateId;
    const volumeMatches = networkVolumeId === null || networkVolumeId === criteria.networkVolumeId;
    if (!managedName || !templateMatches || !volumeMatches) {
      return null;
    }

    let gpuId: ApprovedGpuId | null = null;
    const gpuRaw = pod.gpu;
    if (gpuRaw !== null && gpuRaw !== undefined) {
      const value = asNonEmptyString(
        asRecord(gpuRaw, operation, `${field}.gpu`).id,
        operation,
        `${field}.gpu.id`,
      );
      gpuId = value;
    }
    let cloud: CloudLane | null = null;
    const machineRaw = pod.machine;
    if (machineRaw !== null && machineRaw !== undefined) {
      const secureCloud = asBoolean(
        asRecord(machineRaw, operation, `${field}.machine`).secureCloud,
        operation,
        `${field}.machine.secureCloud`,
      );
      cloud = secureCloud ? "secure" : "community";
    }
    const adjustedCost = asNullableFiniteNumber(
      pod.adjustedCostPerHr,
      operation,
      `${field}.adjustedCostPerHr`,
    );
    const regularCost = asNullableFiniteNumber(
      pod.costPerHr,
      operation,
      `${field}.costPerHr`,
    );
    const createdAt = asNullableString(
      pod.createdAt ?? pod.lastStartedAt,
      operation,
      `${field}.createdAt`,
    );

    return Object.freeze({
      id,
      name,
      status: parsePodStatus(desiredStatus, createResponse),
      gpuId,
      cloud,
      templateId,
      networkVolumeId,
      hourlyPriceUsd: adjustedCost ?? regularCost,
      createdAt,
      startRequestId: extractStartRequestId(name, criteria.podNamePrefix),
      proxyUrl: deriveRunPodProxyUrl(id, criteria.workerPort),
    });
  }
}
