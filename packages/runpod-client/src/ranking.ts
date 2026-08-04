import { RunPodClientError } from "./errors.js";
import type {
  GpuBenchmarkProfile,
  GpuOffer,
  RankedGpuOffer,
} from "./types.js";

export interface RankGpuOffersInput {
  readonly offers: readonly GpuOffer[];
  /** Retained for config migration only. Legacy v1 profiles never score. */
  readonly benchmarkProfiles: readonly GpuBenchmarkProfile[];
  readonly benchmarkContract: unknown;
  readonly expectedImageCount: number;
}

function availabilityWeight(availability: GpuOffer["availability"]): number {
  switch (availability) {
    case "high": return 3;
    case "medium": return 2;
    case "low": return 1;
    case "none":
    case "unknown": return 0;
  }
}

/**
 * Compatibility ranking for the existing lifecycle. Task 014 v1/float
 * benchmark profiles are deliberately ineligible, so this path uses only the
 * fixed approved policy order and exact integer micro-USD as a late tie-break.
 * Measured v2 Auto ranking lives in `projectAutoGpuSelectionV1`.
 */
export function rankGpuOffers(input: RankGpuOffersInput): readonly RankedGpuOffer[] {
  if (!Number.isSafeInteger(input.expectedImageCount) || input.expectedImageCount < 1) {
    throw new RunPodClientError({
      code: "configuration_invalid",
      message: "Expected image count must be a positive safe integer.",
      operation: "configuration",
      details: { field: "expectedImageCount" },
    });
  }
  const available = input.offers.filter((offer) =>
    offer.volumeCompatible &&
    (offer.availability === "low" || offer.availability === "medium" || offer.availability === "high") &&
    offer.hourlyPriceMicroUsd !== null &&
    Number.isSafeInteger(offer.hourlyPriceMicroUsd) && offer.hourlyPriceMicroUsd >= 0,
  );
  available.sort((left, right) => {
    if (left.emergency !== right.emergency) return left.emergency ? 1 : -1;
    if (left.coldPriority !== right.coldPriority) return left.coldPriority - right.coldPriority;
    if (
      left.hourlyPriceMicroUsd !== null && right.hourlyPriceMicroUsd !== null &&
      left.hourlyPriceMicroUsd !== right.hourlyPriceMicroUsd
    ) return left.hourlyPriceMicroUsd - right.hourlyPriceMicroUsd;
    if (left.hourlyPriceMicroUsd !== null || right.hourlyPriceMicroUsd !== null) {
      return left.hourlyPriceMicroUsd !== null ? -1 : 1;
    }
    const availability = availabilityWeight(right.availability) - availabilityWeight(left.availability);
    if (availability !== 0) return availability;
    return left.gpuId < right.gpuId ? -1 : left.gpuId > right.gpuId ? 1 : 0;
  });
  return Object.freeze(available.map((offer, index) => Object.freeze({
    ...offer,
    rank: index + 1,
    rankingMode: "fixed_policy" as const,
    estimatedGenerationCostPerImageMicroUsd: null,
    estimatedJobCostMicroUsd: null,
    estimatedJobCostPerImageMicroUsd: null,
  })));
}
