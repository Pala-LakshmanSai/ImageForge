import { RunPodClientError } from "./errors.js";
import {
  type ApprovedGpuId,
  type BenchmarkContract,
  type GpuBenchmarkProfile,
  type GpuOffer,
  type RankedGpuOffer,
} from "./types.js";

export function benchmarkContractsMatch(
  left: BenchmarkContract,
  right: BenchmarkContract,
): boolean {
  return (
    left.model === right.model &&
    left.modelRevision === right.modelRevision &&
    left.softwareImage === right.softwareImage &&
    left.precision === right.precision &&
    left.width === right.width &&
    left.height === right.height &&
    left.steps === right.steps &&
    left.guidance === right.guidance &&
    left.jpegQuality === right.jpegQuality
  );
}

function latestComparableProfiles(
  profiles: readonly GpuBenchmarkProfile[],
  contract: BenchmarkContract,
): ReadonlyMap<ApprovedGpuId, GpuBenchmarkProfile> {
  const latest = new Map<ApprovedGpuId, GpuBenchmarkProfile>();
  for (const profile of profiles) {
    if (!benchmarkContractsMatch(profile.contract, contract)) {
      continue;
    }
    const current = latest.get(profile.gpuId);
    if (current === undefined || Date.parse(profile.measuredAt) > Date.parse(current.measuredAt)) {
      latest.set(profile.gpuId, profile);
    }
  }
  return latest;
}

function availabilityWeight(availability: GpuOffer["availability"]): number {
  switch (availability) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    case "none":
      return 0;
    case "unknown":
      return 0;
  }
}

export interface RankGpuOffersInput {
  readonly offers: readonly GpuOffer[];
  readonly benchmarkProfiles: readonly GpuBenchmarkProfile[];
  readonly benchmarkContract: BenchmarkContract;
  readonly expectedImageCount: number;
}

/**
 * Ranks only currently available, volume-compatible, approved one-GPU offers.
 * Compatible measured offers are ordered by batch-aware cost. Offers without
 * a matching benchmark retain the reviewed cold-start priority, led by 4090.
 */
export function rankGpuOffers(input: RankGpuOffersInput): readonly RankedGpuOffer[] {
  if (
    !Number.isInteger(input.expectedImageCount) ||
    input.expectedImageCount < 1 ||
    input.expectedImageCount > 500
  ) {
    throw new RunPodClientError({
      code: "configuration_invalid",
      message: "Expected image count must be an integer from 1 to 500.",
      operation: "configuration",
      details: { field: "expectedImageCount" },
    });
  }

  const available = input.offers.filter(
    (offer) =>
      offer.volumeCompatible &&
      offer.availability !== "none" &&
      (offer.hourlyPriceUsd === null ||
        (Number.isFinite(offer.hourlyPriceUsd) && offer.hourlyPriceUsd > 0)),
  );
  const profiles = latestComparableProfiles(input.benchmarkProfiles, input.benchmarkContract);
  const ordinaryAvailable = available.filter((offer) => !offer.emergency);
  const safeDefault = ordinaryAvailable.find((offer) => offer.coldPriority === 0);
  const comparableOrdinaryProfileCount = new Set(
    ordinaryAvailable.map((offer) => offer.gpuId).filter((gpuId) => profiles.has(gpuId)),
  ).size;
  const hasMeasuredOrdinaryQuorum =
    safeDefault !== undefined &&
    profiles.has(safeDefault.gpuId) &&
    comparableOrdinaryProfileCount >= 2;

  const estimated = available.map((offer) => {
    const profile = hasMeasuredOrdinaryQuorum && !offer.emergency
      ? profiles.get(offer.gpuId)
      : undefined;
    const generationCost =
      profile === undefined || offer.hourlyPriceUsd === null
        ? null
        : (offer.hourlyPriceUsd * profile.secondsPerImage) / 3_600;
    const jobCost =
      profile === undefined || offer.hourlyPriceUsd === null
        ? null
        : (offer.hourlyPriceUsd *
            (profile.bootSeconds + profile.secondsPerImage * input.expectedImageCount)) /
          3_600;
    return {
      ...offer,
      rank: 0,
      rankingMode: jobCost !== null
        ? ("measured_job_cost" as const)
        : ("safe_4090_default" as const),
      estimatedGenerationCostPerImageUsd: generationCost,
      estimatedJobCostUsd: jobCost,
      estimatedJobCostPerImageUsd:
        jobCost === null ? null : jobCost / input.expectedImageCount,
    };
  });

  estimated.sort((left, right) => {
    if (left.emergency !== right.emergency) {
      return left.emergency ? 1 : -1;
    }
    if (left.estimatedJobCostUsd !== null && right.estimatedJobCostUsd !== null) {
      const costDifference = left.estimatedJobCostUsd - right.estimatedJobCostUsd;
      if (costDifference !== 0) {
        return costDifference;
      }
    } else if (left.estimatedJobCostUsd !== null || right.estimatedJobCostUsd !== null) {
      return left.estimatedJobCostUsd !== null ? -1 : 1;
    } else {
      if (left.coldPriority !== right.coldPriority) {
        return left.coldPriority - right.coldPriority;
      }
    }

    if (
      left.hourlyPriceUsd !== null &&
      right.hourlyPriceUsd !== null &&
      left.hourlyPriceUsd !== right.hourlyPriceUsd
    ) {
      return left.hourlyPriceUsd - right.hourlyPriceUsd;
    }
    const availabilityDifference =
      availabilityWeight(right.availability) - availabilityWeight(left.availability);
    if (availabilityDifference !== 0) {
      return availabilityDifference;
    }
    if (left.gpuId !== right.gpuId) {
      return left.gpuId.localeCompare(right.gpuId);
    }
    return left.cloud === right.cloud ? 0 : left.cloud === "secure" ? -1 : 1;
  });

  return Object.freeze(
    estimated.map((offer, index) => Object.freeze({ ...offer, rank: index + 1 })),
  );
}
