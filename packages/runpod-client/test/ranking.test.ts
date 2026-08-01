import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rankGpuOffers } from "../src/index.js";
import { benchmarkContract, makeOffer } from "./helpers.js";

describe("rankGpuOffers", () => {
  it("uses the EU-RO cold priority and excludes unavailable or incompatible offers", () => {
    const ranked = rankGpuOffers({
      offers: [
        makeOffer({
          gpuId: "catalog-pro-4500-id",
          policyKey: "rtx_pro_4500_blackwell",
          coldPriority: 1,
          displayName: "RTX PRO 4500 Blackwell",
          hourlyPriceUsd: 0.25,
        }),
        makeOffer(),
        makeOffer({
          gpuId: "NVIDIA GeForce RTX 5090",
          policyKey: "rtx_5090",
          coldPriority: 2,
          displayName: "RTX 5090",
          hourlyPriceUsd: 0.1,
        }),
        makeOffer({
          gpuId: "NVIDIA L4",
          policyKey: "l4",
          coldPriority: 4,
          availability: "none",
        }),
        makeOffer({
          gpuId: "NVIDIA RTX A4500",
          policyKey: "rtx_a4500",
          coldPriority: 5,
          volumeCompatible: false,
        }),
      ],
      benchmarkProfiles: [],
      benchmarkContract,
      expectedImageCount: 450,
    });

    assert.deepEqual(
      ranked.map((offer) => offer.gpuId),
      [
        "NVIDIA GeForce RTX 4090",
        "catalog-pro-4500-id",
        "NVIDIA GeForce RTX 5090",
      ],
    );
    assert.ok(ranked.every((offer) => offer.rankingMode === "safe_4090_default"));
  });

  it("ranks compatible measurements by whole-batch cost rather than hourly price", () => {
    const ranked = rankGpuOffers({
      offers: [
        makeOffer({ hourlyPriceUsd: 0.4 }),
        makeOffer({
          gpuId: "NVIDIA GeForce RTX 5090",
          policyKey: "rtx_5090",
          coldPriority: 2,
          displayName: "RTX 5090",
          hourlyPriceUsd: 0.7,
        }),
      ],
      benchmarkProfiles: [
        {
          gpuId: "NVIDIA GeForce RTX 4090",
          measuredAt: "2026-07-01T00:00:00.000Z",
          promptSampleSize: 30,
          bootSeconds: 600,
          secondsPerImage: 10,
          contract: benchmarkContract,
        },
        {
          gpuId: "NVIDIA GeForce RTX 5090",
          measuredAt: "2026-07-02T00:00:00.000Z",
          promptSampleSize: 30,
          bootSeconds: 300,
          secondsPerImage: 4,
          contract: benchmarkContract,
        },
      ],
      benchmarkContract,
      expectedImageCount: 450,
    });

    assert.equal(ranked[0]?.gpuId, "NVIDIA GeForce RTX 5090");
    assert.equal(ranked[0]?.rankingMode, "measured_job_cost");
    assert.ok((ranked[0]?.estimatedJobCostUsd ?? Infinity) < (ranked[1]?.estimatedJobCostUsd ?? 0));
  });

  it("ignores measurements from a different image or model revision", () => {
    const ranked = rankGpuOffers({
      offers: [
        makeOffer(),
        makeOffer({
          gpuId: "NVIDIA GeForce RTX 5090",
          policyKey: "rtx_5090",
          coldPriority: 2,
          hourlyPriceUsd: 0.1,
        }),
      ],
      benchmarkProfiles: [
        {
          gpuId: "NVIDIA GeForce RTX 5090",
          measuredAt: "2026-07-01T00:00:00.000Z",
          promptSampleSize: 30,
          bootSeconds: 1,
          secondsPerImage: 1,
          contract: { ...benchmarkContract, softwareImage: "different@sha256:image" },
        },
      ],
      benchmarkContract,
      expectedImageCount: 450,
    });

    assert.equal(ranked[0]?.gpuId, "NVIDIA GeForce RTX 4090");
    assert.ok(ranked.every((offer) => offer.estimatedJobCostUsd === null));
  });

  it("keeps the explicitly enabled emergency GPU behind every normal candidate", () => {
    const ranked = rankGpuOffers({
      offers: [
        makeOffer({ hourlyPriceUsd: 0.8 }),
        makeOffer({
          gpuId: "NVIDIA RTX 2000 Ada Generation",
          policyKey: "rtx_2000_ada",
          coldPriority: 100,
          emergency: true,
          displayName: "RTX 2000 Ada",
          hourlyPriceUsd: 0.01,
        }),
      ],
      benchmarkProfiles: [
        {
          gpuId: "NVIDIA GeForce RTX 4090",
          measuredAt: "2026-07-01T00:00:00.000Z",
          promptSampleSize: 30,
          bootSeconds: 900,
          secondsPerImage: 12,
          contract: benchmarkContract,
        },
        {
          gpuId: "NVIDIA RTX 2000 Ada Generation",
          measuredAt: "2026-07-01T00:00:00.000Z",
          promptSampleSize: 30,
          bootSeconds: 1,
          secondsPerImage: 1,
          contract: benchmarkContract,
        },
      ],
      benchmarkContract,
      expectedImageCount: 450,
    });

    assert.deepEqual(ranked.map((offer) => offer.gpuId), [
      "NVIDIA GeForce RTX 4090",
      "NVIDIA RTX 2000 Ada Generation",
    ]);
  });
});
