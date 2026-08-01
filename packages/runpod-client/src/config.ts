import { RunPodClientError } from "./errors.js";
import {
  CLOUD_LANES,
  type BenchmarkContract,
  type GpuBenchmarkProfile,
  type PodConstraintInput,
  type PodConstraints,
  type RunPodClientConfig,
} from "./types.js";

export interface RunPodClientConfigInput {
  readonly templateId: string;
  readonly networkVolumeId: string;
  readonly networkVolumeDataCenterId: "EU-RO-1";
  readonly networkVolumeMountPath?: string;
  readonly podNamePrefix?: string;
  readonly workerPort?: 8000;
  readonly gpuCount?: 1;
  readonly cloudLanes?: readonly ["secure"];
  readonly allowEmergencyGpuTier?: boolean;
  readonly defaultImageCount?: number;
  readonly refreshIntervalMs?: number;
  readonly provisioningTimeoutMs?: number;
  readonly stopConfirmationTtlMs?: number;
  readonly constraints?: PodConstraintInput;
  readonly benchmarkContract: BenchmarkContract;
  readonly benchmarkProfiles?: readonly GpuBenchmarkProfile[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;
const SAFE_PREFIX = /^[a-z0-9][a-z0-9-]{0,47}$/;
const REQUIRED_DATA_CENTER_ID = "EU-RO-1" as const;
const REQUIRED_WORKER_PORT = 8000 as const;
const REQUIRED_CUDA_VERSION = "13.0" as const;

const CONFIG_KEYS = new Set([
  "$schema",
  "templateId",
  "networkVolumeId",
  "networkVolumeDataCenterId",
  "networkVolumeMountPath",
  "podNamePrefix",
  "workerPort",
  "gpuCount",
  "cloudLanes",
  "allowEmergencyGpuTier",
  "defaultImageCount",
  "refreshIntervalMs",
  "provisioningTimeoutMs",
  "stopConfirmationTtlMs",
  "constraints",
  "benchmarkContract",
  "benchmarkProfiles",
]);
const CONSTRAINT_KEYS = new Set([
  "allowedCudaVersions",
  "minRamPerGpuGb",
  "minDiskBandwidthMbps",
  "minDownloadMbps",
  "minUploadMbps",
]);
const BENCHMARK_CONTRACT_KEYS = new Set([
  "model",
  "modelRevision",
  "softwareImage",
  "precision",
  "width",
  "height",
  "steps",
  "guidance",
  "jpegQuality",
]);
const BENCHMARK_PROFILE_KEYS = new Set([
  "gpuId",
  "measuredAt",
  "promptSampleSize",
  "bootSeconds",
  "secondsPerImage",
  "contract",
]);

function configurationError(message: string, field: string): never {
  throw new RunPodClientError({
    code: "configuration_invalid",
    message,
    operation: "configuration",
    details: { field },
  });
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    configurationError(`${field} must be an object.`, field);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: ReadonlySet<string>,
  field: string,
): void {
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey !== undefined) {
    configurationError(`${field} contains an unsupported field.`, `${field}.${unknownKey}`);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    configurationError(`${field} must be a string.`, field);
  }
  return value;
}

function requireSafeId(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    configurationError(`${field} must be a non-empty RunPod identifier.`, field);
  }
  return value;
}

function isNormalizedMountPath(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/") || value.endsWith("/")) {
    return false;
  }
  const segments = value.slice(1).split("/");
  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        segment !== "." &&
        segment !== ".." &&
        /^[A-Za-z0-9._-]+$/.test(segment),
    )
  );
}

function isCanonicalDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
    value,
  );
  if (match === null || !Number.isFinite(Date.parse(value))) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  return (
    calendarDate.getUTCFullYear() === year &&
    calendarDate.getUTCMonth() === month - 1 &&
    calendarDate.getUTCDate() === day
  );
}

function requireIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    configurationError(`${field} must be an integer from ${minimum} to ${maximum}.`, field);
  }
  return value as number;
}

function requirePositiveFinite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    configurationError(`${field} must be a positive finite number.`, field);
  }
  return value;
}

function validateBenchmarkContract(value: unknown, field: string): BenchmarkContract {
  const contract = requireRecord(value, field);
  rejectUnknownKeys(contract, BENCHMARK_CONTRACT_KEYS, field);
  if (contract.model !== "black-forest-labs/FLUX.2-klein-4B") {
    configurationError(`${field}.model must use FLUX.2 Klein 4B.`, `${field}.model`);
  }
  const modelRevision = requireString(contract.modelRevision, `${field}.modelRevision`);
  if (modelRevision.trim().length === 0) {
    configurationError(`${field}.modelRevision must pin a revision.`, `${field}.modelRevision`);
  }
  const softwareImage = requireString(contract.softwareImage, `${field}.softwareImage`);
  if (softwareImage.trim().length === 0) {
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
  return Object.freeze({
    model: "black-forest-labs/FLUX.2-klein-4B",
    modelRevision,
    softwareImage,
    precision: "BF16",
    width: 1280,
    height: 720,
    steps: 4,
    guidance: 1,
    jpegQuality: 95,
  });
}

function validateConstraints(value: unknown): PodConstraints {
  const constraints = requireRecord(value, "constraints");
  rejectUnknownKeys(constraints, CONSTRAINT_KEYS, "constraints");
  const cudaVersions =
    constraints.allowedCudaVersions === undefined
      ? [REQUIRED_CUDA_VERSION]
      : constraints.allowedCudaVersions;
  if (
    !Array.isArray(cudaVersions) ||
    cudaVersions.length !== 1 ||
    cudaVersions[0] !== REQUIRED_CUDA_VERSION
  ) {
    configurationError(
      "constraints.allowedCudaVersions must contain only CUDA 13.0.",
      "constraints.allowedCudaVersions",
    );
  }

  const minRamPerGpuGb = constraints.minRamPerGpuGb === undefined
    ? 16
    : constraints.minRamPerGpuGb;
  if (
    typeof minRamPerGpuGb !== "number" ||
    !Number.isInteger(minRamPerGpuGb) ||
    minRamPerGpuGb < 16 ||
    minRamPerGpuGb > 32
  ) {
    configurationError(
      "constraints.minRamPerGpuGb must be from 16 to 32 GB.",
      "constraints.minRamPerGpuGb",
    );
  }
  const numericConstraints: ReadonlyArray<readonly [unknown, string]> = [
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
    allowedCudaVersions: Object.freeze([REQUIRED_CUDA_VERSION] as const),
    minRamPerGpuGb: minRamPerGpuGb as number,
    ...(constraints.minDiskBandwidthMbps === undefined
      ? {}
      : { minDiskBandwidthMbps: constraints.minDiskBandwidthMbps as number }),
    ...(constraints.minDownloadMbps === undefined
      ? {}
      : { minDownloadMbps: constraints.minDownloadMbps as number }),
    ...(constraints.minUploadMbps === undefined
      ? {}
      : { minUploadMbps: constraints.minUploadMbps as number }),
  });
}

function validateProfiles(
  value: unknown,
): readonly GpuBenchmarkProfile[] {
  if (!Array.isArray(value)) {
    configurationError("benchmarkProfiles must be an array.", "benchmarkProfiles");
  }
  return Object.freeze(
    value.map((entry, index) => {
      const field = `benchmarkProfiles[${index}]`;
      const profile = requireRecord(entry, field);
      rejectUnknownKeys(profile, BENCHMARK_PROFILE_KEYS, field);
      const gpuId = requireString(profile.gpuId, `${field}.gpuId`);
      if (gpuId.trim().length === 0 || gpuId.length > 191) {
        configurationError(`${field}.gpuId must be a catalog GPU identifier.`, `${field}.gpuId`);
      }
      const measuredAt = requireString(profile.measuredAt, `${field}.measuredAt`);
      if (!isCanonicalDateTime(measuredAt)) {
        configurationError(
          `${field}.measuredAt must be an RFC 3339 date-time.`,
          `${field}.measuredAt`,
        );
      }
      const promptSampleSize = requireIntegerInRange(
        profile.promptSampleSize,
        1,
        10_000,
        `${field}.promptSampleSize`,
      );
      const bootSeconds = requirePositiveFinite(profile.bootSeconds, `${field}.bootSeconds`);
      const secondsPerImage = requirePositiveFinite(
        profile.secondsPerImage,
        `${field}.secondsPerImage`,
      );
      const contract = validateBenchmarkContract(profile.contract, `${field}.contract`);
      return Object.freeze({
        gpuId,
        measuredAt,
        promptSampleSize,
        bootSeconds,
        secondsPerImage,
        contract,
      });
    }),
  );
}

export function createRunPodClientConfig(input: RunPodClientConfigInput): RunPodClientConfig {
  const raw = requireRecord(input, "configuration");
  rejectUnknownKeys(raw, CONFIG_KEYS, "configuration");
  if (raw.$schema !== undefined) {
    requireString(raw.$schema, "$schema");
  }
  const templateId = requireSafeId(raw.templateId, "templateId");
  const networkVolumeId = requireSafeId(raw.networkVolumeId, "networkVolumeId");
  const networkVolumeDataCenterId = requireSafeId(
    raw.networkVolumeDataCenterId,
    "networkVolumeDataCenterId",
  );
  if (networkVolumeDataCenterId !== REQUIRED_DATA_CENTER_ID) {
    configurationError(
      "networkVolumeDataCenterId must be EU-RO-1 for the ImageForge studio volume.",
      "networkVolumeDataCenterId",
    );
  }
  const networkVolumeMountPath = raw.networkVolumeMountPath === undefined
    ? "/workspace"
    : requireString(raw.networkVolumeMountPath, "networkVolumeMountPath");
  if (!isNormalizedMountPath(networkVolumeMountPath)) {
    configurationError(
      "networkVolumeMountPath must be an absolute normalized container path.",
      "networkVolumeMountPath",
    );
  }

  const podNamePrefix = raw.podNamePrefix === undefined
    ? "imageforge"
    : requireString(raw.podNamePrefix, "podNamePrefix");
  if (!SAFE_PREFIX.test(podNamePrefix)) {
    configurationError(
      "podNamePrefix must use lowercase letters, digits, or hyphens.",
      "podNamePrefix",
    );
  }

  const cloudLanes = raw.cloudLanes === undefined ? ["secure"] : raw.cloudLanes;
  if (
    !Array.isArray(cloudLanes) ||
    cloudLanes.length === 0 ||
    cloudLanes.some(
      (lane) =>
        typeof lane !== "string" ||
        !CLOUD_LANES.includes(lane as (typeof CLOUD_LANES)[number]),
    ) ||
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
  if (cloudLanes.length !== 1 || cloudLanes[0] !== "secure") {
    configurationError(
      "ImageForge requires exactly the secure cloud lane.",
      "cloudLanes",
    );
  }

  const workerPort = requireIntegerInRange(
    raw.workerPort === undefined ? REQUIRED_WORKER_PORT : raw.workerPort,
    REQUIRED_WORKER_PORT,
    REQUIRED_WORKER_PORT,
    "workerPort",
  );
  const gpuCount = requireIntegerInRange(
    raw.gpuCount === undefined ? 1 : raw.gpuCount,
    1,
    1,
    "gpuCount",
  );

  const allowEmergencyGpuTier = raw.allowEmergencyGpuTier === undefined
    ? false
    : raw.allowEmergencyGpuTier;
  if (typeof allowEmergencyGpuTier !== "boolean") {
    configurationError("allowEmergencyGpuTier must be a boolean.", "allowEmergencyGpuTier");
  }
  const benchmarkContract = validateBenchmarkContract(
    raw.benchmarkContract,
    "benchmarkContract",
  );

  return Object.freeze({
    templateId,
    networkVolumeId,
    networkVolumeDataCenterId: REQUIRED_DATA_CENTER_ID,
    networkVolumeMountPath,
    podNamePrefix,
    workerPort: workerPort as 8000,
    gpuCount: gpuCount as 1,
    cloudLanes: Object.freeze(["secure"] as const),
    allowEmergencyGpuTier,
    defaultImageCount: requireIntegerInRange(
      raw.defaultImageCount === undefined ? 450 : raw.defaultImageCount,
      1,
      500,
      "defaultImageCount",
    ),
    refreshIntervalMs: requireIntegerInRange(
      raw.refreshIntervalMs === undefined ? 1_000 : raw.refreshIntervalMs,
      100,
      60_000,
      "refreshIntervalMs",
    ),
    provisioningTimeoutMs: requireIntegerInRange(
      raw.provisioningTimeoutMs === undefined ? 20 * 60_000 : raw.provisioningTimeoutMs,
      1_000,
      60 * 60_000,
      "provisioningTimeoutMs",
    ),
    stopConfirmationTtlMs: requireIntegerInRange(
      raw.stopConfirmationTtlMs === undefined ? 2 * 60_000 : raw.stopConfirmationTtlMs,
      1_000,
      10 * 60_000,
      "stopConfirmationTtlMs",
    ),
    constraints: validateConstraints(raw.constraints === undefined ? {} : raw.constraints),
    benchmarkContract,
    benchmarkProfiles: validateProfiles(
      raw.benchmarkProfiles === undefined ? [] : raw.benchmarkProfiles,
    ),
  });
}
