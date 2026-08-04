import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  isGpuIdentityV1,
  isLowercaseRegistryImageDigestV1,
  parseInventorySecurePriceV1,
  parseLosslessJson,
  parsePodPriceV1,
} from "../src/index.js";

interface PriceVectorV1 {
  readonly id: string;
  readonly surface: "inventory" | "pod";
  readonly rawJson: string;
  readonly expectedValid: boolean;
  readonly expectedMicroUsd: number | null;
  readonly expectedSource: "adjusted" | "cost" | "unavailable" | "invalid";
}

function rootContract(name: string): string {
  return readFileSync(new URL(`../../../../contracts/${name}`, import.meta.url), "utf8");
}

describe("lossless RunPod price v1", () => {
  it("consumes every checked-in mixed-representation price vector without a float roundtrip", () => {
    const vectors = JSON.parse(rootContract("runpod-price-v1.vectors.json")) as {
      readonly schemaVersion: number;
      readonly cases: readonly PriceVectorV1[];
    };
    assert.equal(vectors.schemaVersion, 1);
    assert.equal(new Set(vectors.cases.map((vector) => vector.id)).size, vectors.cases.length);
    for (const vector of vectors.cases) {
      let raw: unknown;
      try {
        raw = parseLosslessJson(vector.rawJson);
      } catch {
        assert.equal(vector.expectedValid, false, `${vector.id}: malformed JSON marked valid`);
        continue;
      }
      const parsed = vector.surface === "inventory"
        ? parseInventorySecurePriceV1(raw)
        : parsePodPriceV1(raw);
      assert.equal(parsed.valid, vector.expectedValid, vector.id);
      assert.equal(parsed.hourlyPriceMicroUsd, vector.expectedMicroUsd, vector.id);
      if (vector.surface === "pod") {
        assert.equal(
          (parsed as ReturnType<typeof parsePodPriceV1>).source,
          vector.expectedSource === "invalid" ? null : vector.expectedSource,
          vector.id,
        );
      }
    }
  });

  it("rejects duplicate JSON keys before a price token can be selected", () => {
    assert.throws(
      () => parseLosslessJson('{"secure":0.69,"secure":0.7}'),
      /Duplicate JSON object key/,
    );
  });
});

describe("shared GPU and image identities", () => {
  it("consumes the shared GPU identity vectors byte-for-byte", () => {
    const vectors = JSON.parse(rootContract("gpu-identity-v1.vectors.json")) as {
      readonly accepted: ReadonlyArray<{ readonly label: string; readonly value: string }>;
      readonly rejected: ReadonlyArray<{ readonly label: string; readonly value: string }>;
    };
    for (const vector of vectors.accepted) {
      assert.equal(isGpuIdentityV1(vector.value), true, vector.label);
    }
    for (const vector of vectors.rejected) {
      assert.equal(isGpuIdentityV1(vector.value), false, vector.label);
    }
  });

  it("accepts only an immutable lowercase registry digest", () => {
    const valid = "ghcr.io/imageforge/worker@sha256:" + "a".repeat(64);
    assert.equal(isLowercaseRegistryImageDigestV1(valid), true);
    assert.equal(isLowercaseRegistryImageDigestV1(valid.toUpperCase()), false);
    assert.equal(isLowercaseRegistryImageDigestV1("ghcr.io/imageforge/worker:latest"), false);
  });
});
