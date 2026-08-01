import type { ApprovedGpuId } from "./types.js";

export interface GpuPolicyEntry {
  readonly key: string;
  readonly catalogNames: readonly string[];
  readonly exactIds: readonly string[];
  readonly coldPriority: number;
  readonly emergency: boolean;
}

/**
 * EU-RO-1 studio policy. Display-name matches are exact after case/whitespace
 * normalization. The returned catalog ID is always passed through unchanged.
 */
export const GPU_POLICY: readonly GpuPolicyEntry[] = Object.freeze([
  {
    key: "rtx_4090",
    catalogNames: ["RTX 4090"],
    exactIds: ["NVIDIA GeForce RTX 4090"],
    coldPriority: 0,
    emergency: false,
  },
  {
    key: "rtx_pro_4500_blackwell",
    catalogNames: ["RTX PRO 4500 Blackwell"],
    exactIds: [],
    coldPriority: 1,
    emergency: false,
  },
  {
    key: "rtx_5090",
    catalogNames: ["RTX 5090"],
    exactIds: ["NVIDIA GeForce RTX 5090"],
    coldPriority: 2,
    emergency: false,
  },
  {
    key: "rtx_pro_4000_blackwell",
    catalogNames: ["RTX PRO 4000 Blackwell"],
    exactIds: [],
    coldPriority: 3,
    emergency: false,
  },
  {
    key: "l4",
    catalogNames: ["L4"],
    exactIds: ["NVIDIA L4"],
    coldPriority: 4,
    emergency: false,
  },
  {
    key: "rtx_a4500",
    catalogNames: ["RTX A4500"],
    exactIds: ["NVIDIA RTX A4500"],
    coldPriority: 5,
    emergency: false,
  },
  {
    key: "rtx_4000_ada",
    catalogNames: ["RTX 4000 Ada"],
    exactIds: ["NVIDIA RTX 4000 Ada Generation"],
    coldPriority: 6,
    emergency: false,
  },
  {
    key: "rtx_2000_ada",
    catalogNames: ["RTX 2000 Ada"],
    exactIds: ["NVIDIA RTX 2000 Ada Generation"],
    coldPriority: 100,
    emergency: true,
  },
  {
    key: "a40",
    catalogNames: ["A40"],
    exactIds: ["NVIDIA A40"],
    coldPriority: 101,
    emergency: true,
  },
  {
    key: "rtx_a6000",
    catalogNames: ["RTX A6000"],
    exactIds: ["NVIDIA RTX A6000"],
    coldPriority: 102,
    emergency: true,
  },
  {
    key: "l40",
    catalogNames: ["L40"],
    exactIds: ["NVIDIA L40"],
    coldPriority: 103,
    emergency: true,
  },
  {
    key: "l40s",
    catalogNames: ["L40S"],
    exactIds: ["NVIDIA L40S"],
    coldPriority: 104,
    emergency: true,
  },
]);

function normalizeCatalogName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
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
  if (normalizeCatalogName(gpu.manufacturer) !== "NVIDIA" || gpu.memoryGb < 16) {
    return null;
  }
  const normalizedName = normalizeCatalogName(gpu.name);
  const policy = GPU_POLICY.find(
    (entry) =>
      (entry.exactIds.includes(gpu.id) ||
        entry.catalogNames.some((name) => normalizeCatalogName(name) === normalizedName)) &&
      (!entry.emergency || includeEmergencyTier),
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

export function staticGpuPolicy(includeEmergencyTier: boolean): ReadonlyArray<
  GpuPolicyEntry & { readonly gpuId: ApprovedGpuId }
> {
  return Object.freeze(
    GPU_POLICY.flatMap((entry) => {
      if (entry.exactIds.length === 0 || (entry.emergency && !includeEmergencyTier)) {
        return [];
      }
      const gpuId = entry.exactIds[0];
      return gpuId === undefined ? [] : [{ ...entry, gpuId }];
    }),
  );
}
