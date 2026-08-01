export const PRIMARY_APPROVED_GPU_IDS = [
  "NVIDIA GeForce RTX 4090",
  "NVIDIA GeForce RTX 5090",
  "NVIDIA L4",
  "NVIDIA RTX A4500",
  "NVIDIA RTX 4000 Ada Generation",
] as const;

export const EMERGENCY_GPU_IDS = [
  "NVIDIA RTX 2000 Ada Generation",
] as const;

export const APPROVED_GPU_IDS = [
  ...PRIMARY_APPROVED_GPU_IDS,
  ...EMERGENCY_GPU_IDS,
] as const;

/** Exact ID returned by the live catalog. Some approved Blackwell IDs are dynamic. */
export type ApprovedGpuId = string;

export const CLOUD_LANES = ["secure", "community"] as const;
export type CloudLane = (typeof CLOUD_LANES)[number];

export const AVAILABILITY_LEVELS = ["unknown", "none", "low", "medium", "high"] as const;
export type AvailabilityLevel = (typeof AVAILABILITY_LEVELS)[number];

export const POD_STATUSES = [
  "provisioning",
  "starting",
  "running",
  "exited",
  "error",
  "terminated",
  "unknown",
] as const;
export type PodStatus = (typeof POD_STATUSES)[number];

export const WORKER_PHASES = [
  "process",
  "storage",
  "weights",
  "gpu_load",
  "warmup",
  "ready",
  "error",
] as const;
export type WorkerPhase = (typeof WORKER_PHASES)[number];

export const LIFECYCLE_PHASES = [
  "offline",
  "selecting",
  "provisioning",
  "booting",
  "loading",
  "warming",
  "ready",
  "stopping",
  "reconnecting",
  "error",
] as const;
export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];

export interface GpuInventoryRequest {
  readonly gpuIds: readonly ApprovedGpuId[];
  readonly includeEmergencyTier: boolean;
  readonly cloudLanes: readonly ["secure"];
  readonly gpuCount: 1;
  readonly dataCenterId: "EU-RO-1";
}

export interface GpuOffer {
  readonly gpuId: ApprovedGpuId;
  readonly policyKey: string;
  readonly coldPriority: number;
  readonly emergency: boolean;
  readonly displayName: string;
  readonly manufacturer: string;
  readonly memoryGb: number;
  readonly cloud: CloudLane;
  readonly hourlyPriceUsd: number | null;
  readonly availability: AvailabilityLevel;
  readonly dataCenterId: string;
  readonly volumeCompatible: boolean;
  readonly observedAt: string;
}

export interface BenchmarkContract {
  readonly model: "black-forest-labs/FLUX.2-klein-4B";
  readonly modelRevision: string;
  readonly softwareImage: string;
  readonly precision: "BF16";
  readonly width: 1280;
  readonly height: 720;
  readonly steps: 4;
  readonly guidance: 1;
  readonly jpegQuality: 95;
}

export interface GpuBenchmarkProfile {
  readonly gpuId: ApprovedGpuId;
  readonly measuredAt: string;
  readonly promptSampleSize: number;
  readonly bootSeconds: number;
  readonly secondsPerImage: number;
  readonly contract: BenchmarkContract;
}

export type RankingMode = "measured_job_cost" | "safe_4090_default";

export interface RankedGpuOffer extends GpuOffer {
  readonly rank: number;
  readonly rankingMode: RankingMode;
  readonly estimatedGenerationCostPerImageUsd: number | null;
  readonly estimatedJobCostUsd: number | null;
  readonly estimatedJobCostPerImageUsd: number | null;
}

export interface PodConstraintInput {
  readonly allowedCudaVersions?: readonly ["13.0"];
  readonly minRamPerGpuGb?: number;
  readonly minDiskBandwidthMbps?: number;
  readonly minDownloadMbps?: number;
  readonly minUploadMbps?: number;
}

export interface PodConstraints {
  readonly allowedCudaVersions: readonly ["13.0"];
  readonly minRamPerGpuGb: number;
  readonly minDiskBandwidthMbps?: number;
  readonly minDownloadMbps?: number;
  readonly minUploadMbps?: number;
}

export interface RunPodClientConfig {
  readonly templateId: string;
  readonly networkVolumeId: string;
  readonly networkVolumeDataCenterId: "EU-RO-1";
  readonly networkVolumeMountPath: string;
  readonly podNamePrefix: string;
  readonly workerPort: 8000;
  readonly gpuCount: 1;
  readonly cloudLanes: readonly ["secure"];
  readonly allowEmergencyGpuTier: boolean;
  readonly defaultImageCount: number;
  readonly refreshIntervalMs: number;
  readonly provisioningTimeoutMs: number;
  readonly operationTimeoutMs: number;
  readonly stopConfirmationTtlMs: number;
  readonly constraints: PodConstraints;
  readonly benchmarkContract: BenchmarkContract;
  readonly benchmarkProfiles: readonly GpuBenchmarkProfile[];
}

export interface PodDiscoveryCriteria {
  readonly podNamePrefix: string;
  readonly templateId: string;
  readonly networkVolumeId: string;
  readonly networkVolumeMountPath: string;
  readonly workerPort: 8000;
  readonly dataCenterId: "EU-RO-1";
  readonly cloud: "secure";
  readonly gpuCount: 1;
  readonly interruptible: false;
  readonly includeEmergencyGpuTier: boolean;
}

export interface ManagedPod {
  readonly id: string;
  readonly name: string;
  readonly status: PodStatus;
  readonly gpuId: ApprovedGpuId | null;
  readonly gpuDisplayName: string | null;
  readonly gpuCount: number | null;
  readonly cloud: CloudLane | null;
  readonly dataCenterId: string | null;
  readonly templateId: string | null;
  readonly networkVolumeId: string | null;
  readonly networkVolumeMountPath: string | null;
  readonly interruptible: boolean | null;
  readonly hourlyPriceUsd: number | null;
  readonly createdAt: string | null;
  readonly startRequestId: string | null;
  readonly proxyUrl: string;
}

export interface CreatePodFromTemplateRequest {
  readonly name: string;
  readonly startRequestId: string;
  readonly templateId: string;
  readonly networkVolumeId: string;
  readonly networkVolumeDataCenterId: "EU-RO-1";
  readonly networkVolumeMountPath: string;
  readonly workerPort: 8000;
  readonly cloud: "secure";
  readonly gpuTypeIds: readonly ApprovedGpuId[];
  readonly gpuCount: 1;
  readonly gpuTypePriority: "custom";
  readonly interruptible: false;
  readonly allowEmergencyGpuTier: boolean;
  readonly constraints: PodConstraints;
}

export interface RunPodProvider {
  readonly requiresWorkerHealthProbe?: boolean;

  listGpuInventory(
    request: GpuInventoryRequest,
    signal?: AbortSignal,
  ): Promise<readonly GpuOffer[]>;

  listImageForgePods(
    criteria: PodDiscoveryCriteria,
    signal?: AbortSignal,
  ): Promise<readonly ManagedPod[]>;

  createPodFromTemplate(
    request: CreatePodFromTemplateRequest,
    signal?: AbortSignal,
  ): Promise<ManagedPod>;

  getPod(
    podId: string,
    criteria: PodDiscoveryCriteria,
    signal?: AbortSignal,
  ): Promise<ManagedPod | null>;

  terminatePod(podId: string, signal?: AbortSignal): Promise<void>;
}

export interface WorkerHealth {
  readonly schemaVersion: 1;
  readonly phase: WorkerPhase;
  readonly phaseProgress: number | null;
}

export interface WorkerHealthProbe {
  getHealth(proxyUrl: string, signal?: AbortSignal): Promise<WorkerHealth>;
}

export interface PodView extends ManagedPod {
  readonly lifecyclePhase: LifecyclePhase;
  readonly workerHealth: WorkerHealth | null;
  readonly healthError: string | null;
}

export type SnapshotWarningCode =
  | "duplicate_pods"
  | "inventory_fallback"
  | "worker_health_unreachable"
  | "post_create_discovery_failed"
  | "ambiguous_create_unresolved";

export interface SnapshotWarning {
  readonly code: SnapshotWarningCode;
  readonly message: string;
  readonly podIds: readonly string[];
}

export interface SafeErrorSummary {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface RunPodSnapshot {
  readonly revision: number;
  readonly phase: LifecyclePhase;
  readonly inventory: readonly GpuOffer[];
  readonly rankedCandidates: readonly RankedGpuOffer[];
  readonly pods: readonly PodView[];
  readonly selectedPodId: string | null;
  readonly proxyUrl: string | null;
  readonly expectedImageCount: number;
  readonly refreshedAt: string | null;
  readonly warnings: readonly SnapshotWarning[];
  readonly error: SafeErrorSummary | null;
}

export interface ForegroundStartIntent {
  readonly intent: "start_gpu";
  readonly source: "foreground_user";
  readonly expectedImageCount?: number;
  readonly requestId?: string;
}

export interface StartGpuResult {
  readonly outcome:
    | "connected_existing"
    | "created"
    | "reconciled_ambiguous_create";
  readonly pod: PodView;
  readonly snapshot: RunPodSnapshot;
}

export interface ForegroundStopIntent {
  readonly intent: "stop_gpu";
  readonly source: "foreground_user";
  readonly podId: string;
}

export interface StopConfirmation {
  readonly intent: "confirm_stop_gpu";
  readonly podId: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly message: string;
}

export interface ConfirmedStopIntent {
  readonly intent: "confirm_stop_gpu";
  readonly source: "foreground_user";
  readonly podId: string;
  readonly confirmationToken: string;
}

export interface ResolveAmbiguousCreateIntent {
  readonly intent: "resolve_ambiguous_create";
  readonly source: "foreground_user";
  readonly requestId: string;
}

export interface StopGpuResult {
  readonly terminatedPodId: string;
  readonly snapshot: RunPodSnapshot;
}

export interface RefreshOptions {
  readonly expectedImageCount?: number;
  readonly signal?: AbortSignal;
}

export interface WaitUntilReadyOptions extends RefreshOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly onSnapshot?: (snapshot: RunPodSnapshot) => void;
}

export interface Clock {
  now(): number;
}

export type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export type TokenFactory = () => string;
