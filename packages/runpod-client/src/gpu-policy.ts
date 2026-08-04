import type { ApprovedGpuId } from "./types.js";

export const IMAGEFORGE_GPU_IDENTITY_V1 =
  /^[A-Za-z0-9](?:[A-Za-z0-9 ._()+:-]{0,126}[A-Za-z0-9])?$/;

export function isGpuIdentityV1(value: unknown): value is string {
  return typeof value === "string" && IMAGEFORGE_GPU_IDENTITY_V1.test(value);
}

export interface GpuPolicyEntry {
  readonly key: string;
  readonly catalogNames: readonly string[];
  readonly exactIds: readonly string[];
  readonly coldPriority: number;
  readonly emergency: boolean;
  readonly minimumMemoryGb: number;
  readonly maximumMemoryGb: number;
  readonly expectedMemoryGb: number;
}

/**
 * EU-RO-1 studio policy. Display-name matches are exact and byte-preserving.
 * The returned catalog ID is always passed through unchanged.
 */
const GPU_POLICY_DEFINITIONS: readonly GpuPolicyEntry[] = [
  {
    key: "rtx_4090",
    catalogNames: ["RTX 4090"],
    exactIds: ["NVIDIA GeForce RTX 4090"],
    coldPriority: 0,
    emergency: false,
    minimumMemoryGb: 16,
    maximumMemoryGb: 32,
    expectedMemoryGb: 24,
  },
  {
    key: "rtx_pro_4500_blackwell",
    catalogNames: ["RTX PRO 4500 Blackwell"],
    exactIds: [],
    coldPriority: 1,
    emergency: false,
    minimumMemoryGb: 16,
    maximumMemoryGb: 32,
    expectedMemoryGb: 32,
  },
  {
    key: "rtx_5090",
    catalogNames: ["RTX 5090"],
    exactIds: ["NVIDIA GeForce RTX 5090"],
    coldPriority: 2,
    emergency: false,
    minimumMemoryGb: 16,
    maximumMemoryGb: 32,
    expectedMemoryGb: 32,
  },
  {
    key: "rtx_pro_4000_blackwell",
    catalogNames: ["RTX PRO 4000 Blackwell"],
    exactIds: [],
    coldPriority: 3,
    emergency: false,
    minimumMemoryGb: 16,
    maximumMemoryGb: 32,
    expectedMemoryGb: 24,
  },
  {
    key: "l4",
    catalogNames: ["L4"],
    exactIds: ["NVIDIA L4"],
    coldPriority: 4,
    emergency: false,
    minimumMemoryGb: 16,
    maximumMemoryGb: 32,
    expectedMemoryGb: 24,
  },
  {
    key: "rtx_a4500",
    catalogNames: ["RTX A4500"],
    exactIds: ["NVIDIA RTX A4500"],
    coldPriority: 5,
    emergency: false,
    minimumMemoryGb: 16,
    maximumMemoryGb: 32,
    expectedMemoryGb: 20,
  },
  {
    key: "rtx_4000_ada",
    catalogNames: ["RTX 4000 Ada"],
    exactIds: ["NVIDIA RTX 4000 Ada Generation"],
    coldPriority: 6,
    emergency: false,
    minimumMemoryGb: 16,
    maximumMemoryGb: 32,
    expectedMemoryGb: 20,
  },
  {
    key: "rtx_2000_ada",
    catalogNames: ["RTX 2000 Ada"],
    exactIds: ["NVIDIA RTX 2000 Ada Generation"],
    coldPriority: 100,
    emergency: true,
    minimumMemoryGb: 16,
    maximumMemoryGb: 32,
    expectedMemoryGb: 16,
  },
];

export const GPU_POLICY: readonly GpuPolicyEntry[] = Object.freeze(
  GPU_POLICY_DEFINITIONS.map((entry) =>
    Object.freeze({
      ...entry,
      catalogNames: Object.freeze([...entry.catalogNames]),
      exactIds: Object.freeze([...entry.exactIds]),
    }),
  ),
);

export function isDynamicGpuDisplayName(displayName: string): boolean {
  if (!isGpuIdentityV1(displayName)) return false;
  return GPU_POLICY.some(
    (entry) =>
      entry.exactIds.length === 0 &&
      entry.catalogNames.includes(displayName),
  );
}

export function isEmergencyGpuId(gpuId: string): boolean {
  return GPU_POLICY.some(
    (entry) => entry.emergency && entry.exactIds.includes(gpuId),
  );
}

const REMOVED_GPU_IDS = new Set<string>([
  "NVIDIA A40",
  "NVIDIA RTX A6000",
  "NVIDIA L40",
  "NVIDIA L40S",
  "NVIDIA B200",
]);

function isExplicitlyRemovedGpuId(value: string): boolean {
  return REMOVED_GPU_IDS.has(value) || value.includes("RTX PRO 6000");
}

export interface CatalogGpuIdentity {
  readonly id: string;
  readonly name: string;
  readonly manufacturer: string;
  readonly memoryGb: number;
}

export interface ApprovedCatalogGpu {
  readonly gpuId: ApprovedGpuId;
  readonly policyKey: string;
  readonly coldPriority: number;
  readonly emergency: boolean;
}

export function approveCatalogGpu(
  gpu: CatalogGpuIdentity,
  includeEmergencyTier: boolean,
): ApprovedCatalogGpu | null {
  if (
    gpu.manufacturer !== "NVIDIA" ||
    !isGpuIdentityV1(gpu.id) ||
    !isGpuIdentityV1(gpu.name) ||
    !Number.isSafeInteger(gpu.memoryGb) ||
    isExplicitlyRemovedGpuId(gpu.id)
  ) {
    return null;
  }
  const policy = GPU_POLICY.find(
    (entry) => {
      const identityMatches =
        entry.exactIds.length > 0
          ? entry.exactIds.includes(gpu.id)
          : entry.catalogNames.includes(gpu.name);
      return (
        identityMatches &&
        gpu.memoryGb >= entry.minimumMemoryGb &&
        gpu.memoryGb <= entry.maximumMemoryGb &&
        (!entry.emergency || includeEmergencyTier)
      );
    },
  );
  if (policy === undefined) {
    return null;
  }
  return Object.freeze({
    gpuId: gpu.id,
    policyKey: policy.key,
    coldPriority: policy.coldPriority,
    emergency: policy.emergency,
  });
}

/**
 * Validates identity fields available on the Pod API. Static types require the
 * documented exact ID. Only the two Blackwell types may use an exact catalog
 * ID discovered from their canonical display name.
 */
export function approveManagedPodGpu(
  gpuId: string,
  displayName: string,
  catalogApprovedGpuPolicies: ReadonlyMap<string, string> = new Map(),
  includeEmergencyTier = false,
): ApprovedCatalogGpu | null {
  if (
    !isGpuIdentityV1(gpuId) ||
    !isGpuIdentityV1(displayName) ||
    isExplicitlyRemovedGpuId(gpuId)
  ) {
    return null;
  }
  const policy = GPU_POLICY.find(
    (entry) =>
      (!entry.emergency || includeEmergencyTier) &&
      (entry.exactIds.length > 0
        ? entry.exactIds.includes(gpuId)
        : catalogApprovedGpuPolicies.get(gpuId) === entry.key &&
          entry.catalogNames.includes(displayName)),
  );
  if (policy === undefined) {
    return null;
  }
  return Object.freeze({
    gpuId,
    policyKey: policy.key,
    coldPriority: policy.coldPriority,
    emergency: policy.emergency,
  });
}

export function staticGpuPolicy(includeEmergencyTier: boolean): ReadonlyArray<
  GpuPolicyEntry & { readonly gpuId: ApprovedGpuId }
> {
  return Object.freeze(
    GPU_POLICY.flatMap((entry) => {
      if (entry.exactIds.length === 0 || (entry.emergency && !includeEmergencyTier)) {
        return [];
      }
      const gpuId = entry.exactIds[0];
      return gpuId === undefined ? [] : [Object.freeze({ ...entry, gpuId })];
    }),
  );
}
