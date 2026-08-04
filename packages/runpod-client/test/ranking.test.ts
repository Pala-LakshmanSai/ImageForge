import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rankGpuOffers } from "../src/index.js";
import { benchmarkContract, makeOffer } from "./helpers.js";

describe("rankGpuOffers legacy compatibility projection", () => {
  it("uses fixed policy order, excludes unavailable/incompatible rows, and never scores v1 profiles", () => {
    const ranked = rankGpuOffers({
      offers: [
        makeOffer({
          gpuId: "catalog-pro-4500-id",
          policyKey: "rtx_pro_4500_blackwell",
          coldPriority: 1,
          displayName: "RTX PRO 4500 Blackwell",
          hourlyPriceMicroUsd: 250_000,
        }),
        makeOffer(),
        makeOffer({
          gpuId: "NVIDIA GeForce RTX 5090",
          policyKey: "rtx_5090",
          coldPriority: 2,
          displayName: "RTX 5090",
          hourlyPriceMicroUsd: 100_000,
        }),
        makeOffer({ gpuId: "NVIDIA L4", policyKey: "l4", coldPriority: 4, availability: "none" }),
        makeOffer({ gpuId: "NVIDIA RTX A4500", policyKey: "rtx_a4500", coldPriority: 5, volumeCompatible: false }),
      ],
      benchmarkProfiles: [{
        gpuId: "NVIDIA GeForce RTX 5090",
        measuredAt: "2026-07-01T00:00:00.000Z",
        promptSampleSize: 30,
        bootSeconds: 1,
        secondsPerImage: 1,
        contract: benchmarkContract,
      }],
      benchmarkContract,
      expectedImageCount: 450,
    });
    assert.deepEqual(ranked.map((offer) => offer.gpuId), [
      "NVIDIA GeForce RTX 4090",
      "catalog-pro-4500-id",
      "NVIDIA GeForce RTX 5090",
    ]);
    assert.ok(ranked.every((offer) => offer.rankingMode === "fixed_policy"));
    assert.ok(ranked.every((offer) => offer.estimatedJobCostMicroUsd === null));
  });

  it("keeps emergency last and compares integer micro-USD only after policy", () => {
    const ranked = rankGpuOffers({
      offers: [
        makeOffer({ hourlyPriceMicroUsd: 800_000 }),
        makeOffer({
          gpuId: "NVIDIA GeForce RTX 5090",
          policyKey: "rtx_5090",
          coldPriority: 2,
          displayName: "RTX 5090",
          hourlyPriceMicroUsd: 1,
        }),
        makeOffer({
          gpuId: "NVIDIA RTX 2000 Ada Generation",
          policyKey: "rtx_2000_ada",
          coldPriority: 100,
          emergency: true,
          displayName: "RTX 2000 Ada",
          hourlyPriceMicroUsd: 0,
        }),
      ],
      benchmarkProfiles: [],
      benchmarkContract,
      expectedImageCount: 450,
    });
    assert.deepEqual(ranked.map((offer) => offer.gpuId), [
      "NVIDIA GeForce RTX 4090",
      "NVIDIA GeForce RTX 5090",
      "NVIDIA RTX 2000 Ada Generation",
    ]);
  });

  it("rejects an unsafe micro-USD integer instead of coercing it through float arithmetic", () => {
    const ranked = rankGpuOffers({
      offers: [makeOffer({ hourlyPriceMicroUsd: Number.MAX_SAFE_INTEGER + 1 })],
      benchmarkProfiles: [],
      benchmarkContract,
      expectedImageCount: 1,
    });
    assert.deepEqual(ranked, []);
  });

  it("never admits null-price or unknown-availability rows to the create order", () => {
    const ranked = rankGpuOffers({
      offers: [
        makeOffer({ hourlyPriceMicroUsd: null }),
        makeOffer({
          gpuId: "NVIDIA GeForce RTX 5090",
          policyKey: "rtx_5090",
          coldPriority: 2,
          displayName: "RTX 5090",
          availability: "unknown",
        }),
      ],
      benchmarkProfiles: [],
      benchmarkContract,
      expectedImageCount: 450,
    });
    assert.deepEqual(ranked, []);
  });
});
