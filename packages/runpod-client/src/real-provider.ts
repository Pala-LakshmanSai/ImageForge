import {
  RunPodClientError,
  asRunPodClientError,
  type RunPodOperation,
} from "./errors.js";
import {
  approveCatalogGpu,
  approveManagedPodGpu,
  isDynamicGpuDisplayName,
  staticGpuPolicy,
} from "./gpu-policy.js";
import {
  AuthorizedRestClient,
  type ApiKeyProvider,
  type FetchTransport,
  validateRunPodBaseUrl,
} from "./http.js";
import { deriveRunPodProxyUrl, validateRunPodPodId } from "./proxy.js";
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
    this.#baseUrl = validateRunPodBaseUrl(
      options.baseUrl ?? "https://api.runpod.io/v2",
      "inventoryBaseUrl",
      "inventory",
    );
    this.#clock = options.clock ?? { now: () => Date.now() };
  }

  async listGpuInventory(
    request: GpuInventoryRequest,
    signal?: AbortSignal,
  ): Promise<readonly GpuOffer[]> {
    if (
      request.gpuCount !== 1 ||
      request.dataCenterId !== "EU-RO-1" ||
      request.cloudLanes.length !== 1 ||
      request.cloudLanes[0] !== "secure"
    ) {
      throw new RunPodClientError({
        code: "configuration_invalid",
        message: "GPU inventory requires one Secure Cloud GPU in EU-RO-1.",
        operation: "configuration",
        details: { field: "inventoryRequest" },
      });
    }
    try {
      const dataCenterPromise = this.#client.requestJson(
        `${this.#baseUrl}/catalog/datacenters`,
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
          minCudaVersion: "13.0",
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
      const dataCenterSupportsNetworkVolumes = this.#parseDataCenterSupport(
        dataCenterRaw,
        request.dataCenterId,
      );
      return Object.freeze(
        laneResponses.flatMap(({ cloud, raw }) =>
          this.#parseLane(raw, cloud, request, dataCenterSupportsNetworkVolumes),
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
    dataCenterSupportsNetworkVolumes: boolean,
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
      const laneSupported = asBoolean(gpu[cloud], "inventory", `${field}.${cloud}`);
      const price = asRecord(gpu.price, "inventory", `${field}.price`);
      const hourlyPriceUsd = asNumber(price[cloud], "inventory", `${field}.price.${cloud}`);
      const maxCount = asRecord(gpu.maxCount, "inventory", `${field}.maxCount`);
      const laneMaxCount = asNumber(
        maxCount[cloud],
        "inventory",
        `${field}.maxCount.${cloud}`,
      );
      const dataCenters = asArray(gpu.dataCenters, "inventory", `${field}.dataCenters`);
      let selectedDataCenterAvailability: AvailabilityLevel | null = null;
      for (const [dataCenterIndex, dataCenterEntry] of dataCenters.entries()) {
        const dataCenterField = `${field}.dataCenters[${dataCenterIndex}]`;
        const dataCenter = asRecord(dataCenterEntry, "inventory", dataCenterField);
        const dataCenterId = asNonEmptyString(
          dataCenter.id,
          "inventory",
          `${dataCenterField}.id`,
        );
        if (dataCenterId === request.dataCenterId) {
          if (selectedDataCenterAvailability !== null) {
            throw new RunPodClientError({
              code: "api_response_invalid",
              message: "RunPod returned duplicate GPU data-center records.",
              operation: "inventory",
              details: { field: `${dataCenterField}.id` },
            });
          }
          selectedDataCenterAvailability = parseAvailability(
            dataCenter.availability,
            `${dataCenterField}.availability`,
          );
        }
      }

      const approved = approveCatalogGpu(
        { id, name, manufacturer, memoryGb },
        request.includeEmergencyTier,
      );
      if (approved === null) {
        return;
      }
      const volumeCompatible =
        dataCenterSupportsNetworkVolumes &&
        laneSupported &&
        laneMaxCount >= request.gpuCount &&
        selectedDataCenterAvailability !== null;
      const availability = volumeCompatible ? (selectedDataCenterAvailability ?? "none") : "none";
      offers.push(
        Object.freeze({
          gpuId: approved.gpuId,
          policyKey: approved.policyKey,
          coldPriority: approved.coldPriority,
          emergency: approved.emergency,
          displayName: name,
          manufacturer,
          memoryGb,
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

  #parseDataCenterSupport(
    raw: unknown,
    requestedDataCenterId: string,
  ): boolean {
    const response = asRecord(raw, "inventory");
    const dataCenters = asArray(response.dataCenters, "inventory", "response.dataCenters");
    let selectedNetworkVolumeTypes: readonly unknown[] | null = null;
    for (const [index, entry] of dataCenters.entries()) {
      const field = `response.dataCenters[${index}]`;
      const dataCenter = asRecord(entry, "inventory", field);
      const id = asNonEmptyString(dataCenter.id, "inventory", `${field}.id`);
      if (id !== requestedDataCenterId) {
        continue;
      }
      const networkVolumeTypes = asArray(
        dataCenter.networkVolumeTypes,
        "inventory",
        `${field}.networkVolumeTypes`,
      );
      networkVolumeTypes.forEach((type, typeIndex) => {
        asNonEmptyString(type, "inventory", `${field}.networkVolumeTypes[${typeIndex}]`);
      });
      if (selectedNetworkVolumeTypes !== null) {
        throw new RunPodClientError({
          code: "api_response_invalid",
          message: "RunPod returned duplicate data-center records.",
          operation: "inventory",
          details: { field: `${field}.id` },
        });
      }
      selectedNetworkVolumeTypes = networkVolumeTypes;
    }
    return selectedNetworkVolumeTypes !== null && selectedNetworkVolumeTypes.length > 0;
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

function isNormalizedMountPath(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/") || value.endsWith("/")) {
    return false;
  }
  return value
    .slice(1)
    .split("/")
    .every(
      (segment) =>
        segment !== "." &&
        segment !== ".." &&
        /^[A-Za-z0-9._-]+$/.test(segment),
    );
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

function markCreateMayHaveSucceeded(error: unknown): RunPodClientError {
  const source = asRunPodClientError(error, {
    code: "api_response_invalid",
    message: "RunPod returned an invalid Pod creation response.",
    operation: "create_pod",
  });
  return new RunPodClientError({
    code: source.code,
    message: source.message,
    operation: "create_pod",
    retryable: source.retryable,
    mayHaveSucceeded: true,
    ...(source.httpStatus === null ? {} : { httpStatus: source.httpStatus }),
    details: source.details,
  });
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
  readonly requiresWorkerHealthProbe = true;
  readonly #client: AuthorizedRestClient;
  readonly #baseUrl: string;
  readonly #inventorySource: GpuInventorySource;
  #catalogApprovedGpuPolicies = new Map<ApprovedGpuId, string>();
  #verifiedManagedGpuPolicies = new Map<
    string,
    { readonly gpuId: ApprovedGpuId; readonly policyKey: string }
  >();

  constructor(options: RunPodRestProviderOptions) {
    this.#client = new AuthorizedRestClient(options.apiKeyProvider, options.fetchTransport);
    this.#baseUrl = validateRunPodBaseUrl(
      options.lifecycleBaseUrl ?? "https://rest.runpod.io/v1",
      "lifecycleBaseUrl",
      "lifecycle",
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

  async listGpuInventory(
    request: GpuInventoryRequest,
    signal?: AbortSignal,
  ): Promise<readonly GpuOffer[]> {
    if (
      request.gpuCount !== 1 ||
      request.dataCenterId !== "EU-RO-1" ||
      request.cloudLanes.length !== 1 ||
      request.cloudLanes[0] !== "secure"
    ) {
      throw new RunPodClientError({
        code: "configuration_invalid",
        message: "GPU inventory requires one Secure Cloud GPU in EU-RO-1.",
        operation: "configuration",
        details: { field: "inventoryRequest" },
      });
    }
    this.#catalogApprovedGpuPolicies = new Map();
    const rawOffers = await this.#inventorySource.listGpuInventory(request, signal);
    const approvedOffers = rawOffers.flatMap((offer) => {
      const approved = approveCatalogGpu(
        {
          id: offer.gpuId,
          name: offer.displayName,
          manufacturer: offer.manufacturer,
          memoryGb: offer.memoryGb,
        },
        request.includeEmergencyTier,
      );
      if (
        approved === null ||
        offer.cloud !== "secure" ||
        offer.dataCenterId !== "EU-RO-1" ||
        (approved.emergency && !request.includeEmergencyTier)
      ) {
        return [];
      }
      return [
        Object.freeze({
          ...offer,
          gpuId: approved.gpuId,
          policyKey: approved.policyKey,
          coldPriority: approved.coldPriority,
          emergency: approved.emergency,
          cloud: "secure" as const,
          dataCenterId: "EU-RO-1",
        }),
      ];
    });
    this.#catalogApprovedGpuPolicies = new Map(
      approvedOffers.map((offer) => [offer.gpuId, offer.policyKey] as const),
    );
    return Object.freeze(approvedOffers);
  }

  async listImageForgePods(
    criteria: PodDiscoveryCriteria,
    signal?: AbortSignal,
  ): Promise<readonly ManagedPod[]> {
    try {
      const query = new URLSearchParams({
        computeType: "GPU",
        includeMachine: "true",
        includeNetworkVolume: "true",
        templateId: criteria.templateId,
        networkVolumeId: criteria.networkVolumeId,
        dataCenterId: criteria.dataCenterId,
      });
      const raw = await this.#client.requestJson(
        `${this.#baseUrl}/pods?${query}`,
        {
          method: "GET",
          operation: "list_pods",
          expectedStatuses: [200],
          ...(signal === undefined ? {} : { signal }),
        },
      );
      const entries = asArray(raw, "list_pods", "response");
      const pods = entries.map((entry, index) =>
        this.#parsePod(entry, criteria, false, "list_pods", `response[${index}]`),
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
    const cudaVersions = request.constraints.allowedCudaVersions;
    const minRamPerGpuGb = request.constraints.minRamPerGpuGb;
    const requestMarker = `-${request.startRequestId}`;
    const podNamePrefix = request.name.endsWith(requestMarker)
      ? request.name.slice(0, -requestMarker.length)
      : "";
    const staticPolicies = new Map(
      staticGpuPolicy(true).map((entry) => [entry.gpuId, entry] as const),
    );
    const numericConstraints = [
      request.constraints.minDiskBandwidthMbps,
      request.constraints.minDownloadMbps,
      request.constraints.minUploadMbps,
    ];
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(request.startRequestId) ||
      !/^[a-z0-9][a-z0-9-]{0,47}$/.test(podNamePrefix) ||
      request.name.length > 191 ||
      request.gpuCount !== 1 ||
      request.cloud !== "secure" ||
      request.networkVolumeDataCenterId !== "EU-RO-1" ||
      request.workerPort !== 8000 ||
      request.gpuTypePriority !== "custom" ||
      request.interruptible !== false ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/.test(request.templateId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/.test(request.networkVolumeId) ||
      !isNormalizedMountPath(request.networkVolumeMountPath) ||
      cudaVersions === undefined ||
      cudaVersions.length !== 1 ||
      cudaVersions[0] !== "13.0" ||
      minRamPerGpuGb === undefined ||
      !Number.isInteger(minRamPerGpuGb) ||
      minRamPerGpuGb < 16 ||
      minRamPerGpuGb > 32 ||
      request.gpuTypeIds.length === 0 ||
      new Set(request.gpuTypeIds).size !== request.gpuTypeIds.length ||
      request.gpuTypeIds.some(
        (gpuId) => {
          const staticPolicy = staticPolicies.get(gpuId);
          return (
            !/^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,190}$/.test(gpuId) ||
            (staticPolicy === undefined
              ? !this.#catalogApprovedGpuPolicies.has(gpuId)
              : staticPolicy.emergency && !request.allowEmergencyGpuTier)
          );
        },
      ) ||
      typeof request.allowEmergencyGpuTier !== "boolean" ||
      numericConstraints.some(
        (value) =>
          value !== undefined &&
          (typeof value !== "number" || !Number.isFinite(value) || value <= 0),
      )
    ) {
      throw new RunPodClientError({
        code: "configuration_invalid",
        message:
          "Pod creation requires one Secure Cloud GPU in EU-RO-1 and a non-empty unique candidate list.",
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

    let raw: unknown;
    try {
      raw = await this.#client.requestJson(`${this.#baseUrl}/pods`, {
        method: "POST",
        operation: "create_pod",
        expectedStatuses: [201],
        body,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      const source = asRunPodClientError(error, {
        code: "api_request_failed",
        message: "RunPod could not create the ImageForge Pod.",
        operation: "create_pod",
      });
      if (
        source.httpStatus !== null &&
        source.httpStatus >= 200 &&
        source.httpStatus < 300
      ) {
        throw markCreateMayHaveSucceeded(source);
      }
      throw source;
    }
    const criteria: PodDiscoveryCriteria = {
      podNamePrefix,
      templateId: request.templateId,
      networkVolumeId: request.networkVolumeId,
      networkVolumeMountPath: request.networkVolumeMountPath,
      workerPort: request.workerPort,
      dataCenterId: request.networkVolumeDataCenterId,
      cloud: request.cloud,
      gpuCount: request.gpuCount,
      interruptible: request.interruptible,
      includeEmergencyGpuTier: request.allowEmergencyGpuTier,
    };
    try {
      const pod = this.#parsePod(raw, criteria, true, "create_pod", "response");
      if (
        pod === null ||
        pod.name !== request.name ||
        pod.startRequestId !== request.startRequestId ||
        pod.gpuId === null ||
        !request.gpuTypeIds.includes(pod.gpuId) ||
        pod.gpuCount !== request.gpuCount ||
        pod.cloud !== request.cloud ||
        pod.dataCenterId !== request.networkVolumeDataCenterId
      ) {
        throw new RunPodClientError({
          code: "api_response_invalid",
          message: "RunPod created a Pod with unexpected GPU or placement details.",
          operation: "create_pod",
        });
      }
      return pod;
    } catch (error) {
      throw markCreateMayHaveSucceeded(error);
    }
  }

  async getPod(
    podId: string,
    criteria: PodDiscoveryCriteria,
    signal?: AbortSignal,
  ): Promise<ManagedPod | null> {
    validateRunPodPodId(podId);
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
    const pod = this.#parsePod(raw, criteria, false, "get_pod", "response");
    if (pod !== null && pod.id !== podId) {
      throw new RunPodClientError({
        code: "api_response_invalid",
        message: "RunPod returned a different Pod than requested.",
        operation: "get_pod",
        details: { field: "response.id" },
      });
    }
    return pod;
  }

  async terminatePod(podId: string, signal?: AbortSignal): Promise<void> {
    validateRunPodPodId(podId, "terminate_pod");
    await this.#client.request(`${this.#baseUrl}/pods/${encodeURIComponent(podId)}`, {
      method: "DELETE",
      operation: "terminate_pod",
      expectedStatuses: [204],
      ...(signal === undefined ? {} : { signal }),
    });
  }

  #parsePod(
    raw: unknown,
    criteria: PodDiscoveryCriteria,
    createResponse: boolean,
    operation: RunPodOperation,
    field: string,
  ): ManagedPod | null {
    const pod = asRecord(raw, operation, field);
    const id = asNonEmptyString(pod.id, operation, `${field}.id`);
    const name = asNonEmptyString(pod.name, operation, `${field}.name`);
    const desiredStatus = asNonEmptyString(
      pod.desiredStatus ?? pod.status,
      operation,
      `${field}.desiredStatus`,
    );
    const templateId = asNullableString(pod.templateId, operation, `${field}.templateId`);
    const networkVolumeMountPath = asNullableString(
      pod.volumeMountPath,
      operation,
      `${field}.volumeMountPath`,
    );
    const interruptible = asBoolean(
      pod.interruptible,
      operation,
      `${field}.interruptible`,
    );
    const networkVolumeRaw = pod.networkVolume;

    const managedName = name === criteria.podNamePrefix || name.startsWith(`${criteria.podNamePrefix}-`);
    if (
      !managedName ||
      templateId !== criteria.templateId ||
      networkVolumeMountPath !== criteria.networkVolumeMountPath ||
      interruptible !== criteria.interruptible
    ) {
      return null;
    }

    if (networkVolumeRaw === null || networkVolumeRaw === undefined) {
      return null;
    }
    const networkVolume = asRecord(networkVolumeRaw, operation, `${field}.networkVolume`);
    const networkVolumeId = asNonEmptyString(
      networkVolume.id,
      operation,
      `${field}.networkVolume.id`,
    );
    const networkVolumeDataCenterId = asNonEmptyString(
      networkVolume.dataCenterId,
      operation,
      `${field}.networkVolume.dataCenterId`,
    );
    if (
      networkVolumeId !== criteria.networkVolumeId ||
      networkVolumeDataCenterId !== criteria.dataCenterId
    ) {
      return null;
    }

    let gpuId: ApprovedGpuId | null = null;
    let gpuDisplayName: string | null = null;
    let gpuCount: number | null = null;
    const gpuRaw = pod.gpu;
    if (gpuRaw !== null && gpuRaw !== undefined) {
      const gpu = asRecord(gpuRaw, operation, `${field}.gpu`);
      const value = asNonEmptyString(gpu.id, operation, `${field}.gpu.id`);
      const displayName = asNonEmptyString(
        gpu.displayName,
        operation,
        `${field}.gpu.displayName`,
      );
      const count = asNumber(gpu.count, operation, `${field}.gpu.count`);
      const podApprovedPolicies = new Map(this.#catalogApprovedGpuPolicies);
      const verified = this.#verifiedManagedGpuPolicies.get(id);
      if (verified !== undefined && verified.gpuId === value) {
        podApprovedPolicies.set(value, verified.policyKey);
      }
      const approved = approveManagedPodGpu(
        value,
        displayName,
        podApprovedPolicies,
        createResponse ? criteria.includeEmergencyGpuTier : true,
      );
      if (approved === null && isDynamicGpuDisplayName(displayName)) {
        throw new RunPodClientError({
          code: "api_response_invalid",
          message:
            "A matching ImageForge Pod has a dynamic GPU identity that could not be verified against live inventory.",
          operation,
          retryable: true,
          details: { field: `${field}.gpu.id` },
        });
      }
      if (approved === null || !Number.isInteger(count) || count !== criteria.gpuCount) {
        return null;
      }
      gpuId = approved.gpuId;
      gpuDisplayName = displayName;
      gpuCount = count;
    } else {
      return null;
    }
    let cloud: CloudLane | null = null;
    let dataCenterId: string | null = null;
    const machineRaw = pod.machine;
    if (machineRaw !== null && machineRaw !== undefined) {
      const machine = asRecord(machineRaw, operation, `${field}.machine`);
      const secureCloud = asBoolean(machine.secureCloud, operation, `${field}.machine.secureCloud`);
      dataCenterId = asNonEmptyString(
        machine.dataCenterId,
        operation,
        `${field}.machine.dataCenterId`,
      );
      cloud = secureCloud ? "secure" : "community";
      if (cloud !== criteria.cloud || dataCenterId !== criteria.dataCenterId) {
        return null;
      }
    } else {
      return null;
    }
    const ports = asArray(pod.ports, operation, `${field}.ports`).map((port, index) =>
      asNonEmptyString(port, operation, `${field}.ports[${index}]`),
    );
    if (!ports.includes(`${criteria.workerPort}/http`)) {
      return null;
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

    const parsed = Object.freeze({
      id,
      name,
      status: parsePodStatus(desiredStatus, createResponse),
      gpuId,
      gpuDisplayName,
      gpuCount,
      cloud,
      dataCenterId,
      templateId,
      networkVolumeId,
      networkVolumeMountPath,
      interruptible,
      hourlyPriceUsd: adjustedCost ?? regularCost,
      createdAt,
      startRequestId: extractStartRequestId(name, criteria.podNamePrefix),
      proxyUrl: deriveRunPodProxyUrl(id, criteria.workerPort),
    });
    const approvedPolicy = gpuId === null
      ? undefined
      : approveManagedPodGpu(gpuId, gpuDisplayName ?? "", this.#catalogApprovedGpuPolicies, true);
    if (approvedPolicy !== null && approvedPolicy !== undefined) {
      this.#verifiedManagedGpuPolicies.set(id, Object.freeze({
        gpuId: approvedPolicy.gpuId,
        policyKey: approvedPolicy.policyKey,
      }));
    }
    return parsed;
  }
}
