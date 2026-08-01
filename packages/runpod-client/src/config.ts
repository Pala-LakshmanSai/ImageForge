import { RunPodClientError } from "./errors.js";
import {
  CLOUD_LANES,
  type BenchmarkContract,
  type CloudLane,
  type GpuBenchmarkProfile,
  type PodConstraints,
  type RunPodClientConfig,
} from "./types.js";

export interface RunPodClientConfigInput {
  readonly templateId: string;
  readonly networkVolumeId: string;
  readonly networkVolumeDataCenterId: string;
  readonly networkVolumeMountPath?: string;
  readonly podNamePrefix?: string;
  readonly workerPort?: number;
  readonly cloudLanes?: readonly CloudLane[];
  readonly allowEmergencyGpuTier?: boolean;
  readonly defaultImageCount?: number;
  readonly refreshIntervalMs?: number;
  readonly provisioningTimeoutMs?: number;
  readonly stopConfirmationTtlMs?: number;
  readonly constraints?: PodConstraints;
  readonly benchmarkContract: BenchmarkContract;
  readonly benchmarkProfiles?: readonly GpuBenchmarkProfile[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;
const SAFE_PREFIX = /^[a-z0-9][a-z0-9-]{0,47}$/;
const CUDA_VERSION = /^\d{2}(?:\.\d)?$/;

function configurationError(message: string, field: string): never {
  throw new RunPodClientError({
    code: "configuration_invalid",
    message,
    operation: "configuration",
    details: { field },
  });
}

function requireSafeId(value: string, field: string): string {
  if (!SAFE_ID.test(value)) {
    configurationError(`${field} must be a non-empty RunPod identifier.`, field);
  }
  return value;
}

function requireIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    configurationError(`${field} must be an integer from ${minimum} to ${maximum}.`, field);
  }
  return value;
}

function requirePositiveFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    configurationError(`${field} must be a positive finite number.`, field);
  }
  return value;
}

function validateBenchmarkContract(contract: BenchmarkContract, field: string): void {
  if (contract.model !== "black-forest-labs/FLUX.2-klein-4B") {
    configurationError(`${field}.model must use FLUX.2 Klein 4B.`, `${field}.model`);
  }
  if (contract.modelRevision.trim().length === 0) {
    configurationError(`${field}.modelRevision must pin a revision.`, `${field}.modelRevision`);
  }
  if (contract.softwareImage.trim().length === 0) {
    configurationError(`${field}.softwareImage must pin a container image.`, `${field}.softwareImage`);
  }
  if (
    contract.precision !== "BF16" ||
    contract.width !== 1280 ||
    contract.height !== 720 ||
    contract.steps !== 4 ||
    contract.guidance !== 1 ||
    contract.jpegQuality !== 95
  ) {
    configurationError(
      `${field} must match the ImageForge BF16 1280x720, four-step, guidance 1.0, JPEG 95 contract.`,
      field,
    );
  }
}

function validateConstraints(constraints: PodConstraints): PodConstraints {
  const cudaVersions = constraints.allowedCudaVersions;
  if (cudaVersions !== undefined) {
    if (cudaVersions.length === 0 || cudaVersions.some((version) => !CUDA_VERSION.test(version))) {
      configurationError(
        "constraints.allowedCudaVersions must contain CUDA major or major.minor versions.",
        "constraints.allowedCudaVersions",
      );
    }
  }

  const numericConstraints: ReadonlyArray<readonly [number | undefined, string]> = [
    [constraints.minRamPerGpuGb, "constraints.minRamPerGpuGb"],
    [constraints.minDiskBandwidthMbps, "constraints.minDiskBandwidthMbps"],
    [constraints.minDownloadMbps, "constraints.minDownloadMbps"],
    [constraints.minUploadMbps, "constraints.minUploadMbps"],
  ];
  for (const [value, field] of numericConstraints) {
    if (value !== undefined) {
      requirePositiveFinite(value, field);
    }
  }

  return Object.freeze({
    ...constraints,
    ...(cudaVersions === undefined ? {} : { allowedCudaVersions: Object.freeze([...cudaVersions]) }),
  });
}

function validateProfiles(
  profiles: readonly GpuBenchmarkProfile[],
): readonly GpuBenchmarkProfile[] {
  return Object.freeze(
    profiles.map((profile, index) => {
      const field = `benchmarkProfiles[${index}]`;
      if (profile.gpuId.trim().length === 0 || profile.gpuId.length > 191) {
        configurationError(`${field}.gpuId must be a catalog GPU identifier.`, `${field}.gpuId`);
      }
      if (!Number.isFinite(Date.parse(profile.measuredAt))) {
        configurationError(`${field}.measuredAt must be an ISO timestamp.`, `${field}.measuredAt`);
      }
      requireIntegerInRange(profile.promptSampleSize, 1, 10_000, `${field}.promptSampleSize`);
      requirePositiveFinite(profile.bootSeconds, `${field}.bootSeconds`);
      requirePositiveFinite(profile.secondsPerImage, `${field}.secondsPerImage`);
      validateBenchmarkContract(profile.contract, `${field}.contract`);
      return Object.freeze({ ...profile, contract: Object.freeze({ ...profile.contract }) });
    }),
  );
}

export function createRunPodClientConfig(input: RunPodClientConfigInput): RunPodClientConfig {
  const templateId = requireSafeId(input.templateId, "templateId");
  const networkVolumeId = requireSafeId(input.networkVolumeId, "networkVolumeId");
  const networkVolumeDataCenterId = requireSafeId(
    input.networkVolumeDataCenterId,
    "networkVolumeDataCenterId",
  );
  const networkVolumeMountPath = input.networkVolumeMountPath ?? "/workspace";
  if (!networkVolumeMountPath.startsWith("/") || networkVolumeMountPath.includes("..")) {
    configurationError(
      "networkVolumeMountPath must be an absolute normalized container path.",
      "networkVolumeMountPath",
    );
  }

  const podNamePrefix = input.podNamePrefix ?? "imageforge";
  if (!SAFE_PREFIX.test(podNamePrefix)) {
    configurationError(
      "podNamePrefix must use lowercase letters, digits, or hyphens.",
      "podNamePrefix",
    );
  }

  const cloudLanes = input.cloudLanes ?? (["secure"] as const);
  if (
    cloudLanes.length === 0 ||
    cloudLanes.some((lane) => !CLOUD_LANES.includes(lane)) ||
    new Set(cloudLanes).size !== cloudLanes.length
  ) {
    configurationError(
      "cloudLanes must contain unique secure and/or community values.",
      "cloudLanes",
    );
  }
  if (cloudLanes.some((lane) => lane !== "secure")) {
    configurationError(
      "ImageForge network-volume Pods require the secure cloud lane.",
      "cloudLanes",
    );
  }

  validateBenchmarkContract(input.benchmarkContract, "benchmarkContract");

  return Object.freeze({
    templateId,
    networkVolumeId,
    networkVolumeDataCenterId,
    networkVolumeMountPath,
    podNamePrefix,
    workerPort: requireIntegerInRange(input.workerPort ?? 8000, 1, 65_535, "workerPort"),
    cloudLanes: Object.freeze([...cloudLanes]),
    allowEmergencyGpuTier: input.allowEmergencyGpuTier ?? false,
    defaultImageCount: requireIntegerInRange(
      input.defaultImageCount ?? 450,
      1,
      500,
      "defaultImageCount",
    ),
    refreshIntervalMs: requireIntegerInRange(
      input.refreshIntervalMs ?? 1_000,
      100,
      60_000,
      "refreshIntervalMs",
    ),
    provisioningTimeoutMs: requireIntegerInRange(
      input.provisioningTimeoutMs ?? 20 * 60_000,
      1_000,
      60 * 60_000,
      "provisioningTimeoutMs",
    ),
    stopConfirmationTtlMs: requireIntegerInRange(
      input.stopConfirmationTtlMs ?? 2 * 60_000,
      1_000,
      10 * 60_000,
      "stopConfirmationTtlMs",
    ),
    constraints: validateConstraints(input.constraints ?? {}),
    benchmarkContract: Object.freeze({ ...input.benchmarkContract }),
    benchmarkProfiles: validateProfiles(input.benchmarkProfiles ?? []),
  });
}
