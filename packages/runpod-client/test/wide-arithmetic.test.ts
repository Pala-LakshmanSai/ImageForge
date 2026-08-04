import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  U128_MAX_V1,
  checkedU128AddV1,
  checkedU128MultiplyV1,
  divideU128HalfUpV1,
  gpuAutoValueProductV1,
  gpuEstimatedCostTraceV1,
  parseCanonicalU128DecimalV1,
  rankGpuAutoValueCandidatesV1,
} from "../src/index.js";

interface WideVectorsV1 {
  readonly u128Max: string;
  readonly u128MaxPlusOne: string;
  readonly checkedMultiply: ReadonlyArray<{
    readonly id: string;
    readonly left: string;
    readonly right: string;
    readonly expected: string | null;
  }>;
  readonly checkedAdd: ReadonlyArray<{
    readonly id: string;
    readonly left: string;
    readonly right: string;
    readonly expected: string | null;
  }>;
  readonly autoProducts: ReadonlyArray<{
    readonly id: string;
    readonly price: number;
    readonly durationUs: number;
    readonly expected: string;
  }>;
  readonly estimatedCosts: ReadonlyArray<{
    readonly id: string;
    readonly input: {
      readonly hourlyPriceMicroUsd: number;
      readonly bootDurationMs: number;
      readonly medianDurationUs: number;
      readonly remainingImages: number;
    };
    readonly runtimeUs: string;
    readonly numerator: string;
    readonly quotient: string;
    readonly remainder: string;
    readonly expected: string;
  }>;
  readonly halfUpNumerators: ReadonlyArray<{ readonly numerator: string; readonly expected: string }>;
  readonly canonicalValues: ReadonlyArray<{ readonly value: string; readonly valid: boolean }>;
}

function vectors(): WideVectorsV1 {
  return JSON.parse(readFileSync(
    new URL("../../../../contracts/gpu-wide-arithmetic-v1.vectors.json", import.meta.url),
    "utf8",
  )) as WideVectorsV1;
}

describe("WIDE_UNSIGNED_V1 arithmetic", () => {
  it("matches all checked-in products, cost traces, half-up edges, and canonical bounds", () => {
    const fixture = vectors();
    assert.equal(U128_MAX_V1.toString(), fixture.u128Max);
    assert.equal(parseCanonicalU128DecimalV1(fixture.u128MaxPlusOne), null);
    for (const vector of fixture.checkedMultiply) {
      assert.equal(
        checkedU128MultiplyV1(BigInt(vector.left), BigInt(vector.right))?.toString() ?? null,
        vector.expected,
        vector.id,
      );
    }
    for (const vector of fixture.checkedAdd) {
      assert.equal(
        checkedU128AddV1(BigInt(vector.left), BigInt(vector.right))?.toString() ?? null,
        vector.expected,
        vector.id,
      );
    }
    for (const vector of fixture.autoProducts) {
      assert.equal(
        gpuAutoValueProductV1(vector.price, vector.durationUs)?.toString(),
        vector.expected,
        vector.id,
      );
    }
    for (const vector of fixture.estimatedCosts) {
      const trace = gpuEstimatedCostTraceV1(vector.input);
      assert.notEqual(trace, null, vector.id);
      assert.equal(trace?.runtimeUs.toString(), vector.runtimeUs, vector.id);
      assert.equal(trace?.numerator.toString(), vector.numerator, vector.id);
      assert.equal(trace?.quotient.toString(), vector.quotient, vector.id);
      assert.equal(trace?.remainder.toString(), vector.remainder, vector.id);
      assert.equal(trace?.roundedMicroUsd, vector.expected, vector.id);
    }
    for (const vector of fixture.halfUpNumerators) {
      assert.equal(divideU128HalfUpV1(BigInt(vector.numerator), 3_600_000_000n), vector.expected);
    }
    for (const vector of fixture.canonicalValues) {
      assert.equal(parseCanonicalU128DecimalV1(vector.value) !== null, vector.valid, vector.value);
    }
  });

  it("uses exact products, then fixed policy and raw ASCII identity for ties", () => {
    const ranked = rankGpuAutoValueCandidatesV1([
      { gpuId: "GPU:B", policyPriority: 2, hourlyPriceMicroUsd: 1_000_001, medianDurationUs: 1_000_000 },
      { gpuId: "GPU:C", policyPriority: 1, hourlyPriceMicroUsd: 1_000_000, medianDurationUs: 1_000_001 },
      { gpuId: "GPU:A", policyPriority: 1, hourlyPriceMicroUsd: 1_000_000, medianDurationUs: 1_000_001 },
    ]);
    assert.deepEqual(ranked?.map((entry) => entry.gpuId), ["GPU:A", "GPU:C", "GPU:B"]);
  });
});
