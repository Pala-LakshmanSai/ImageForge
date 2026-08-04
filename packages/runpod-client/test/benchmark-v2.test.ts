import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  gpuBenchmarkRawBytesV2,
  parseGpuBenchmarkContractV2,
  parseGpuBenchmarkRawV2,
  projectGpuBenchmarkV2,
  sha256HexV1,
  validateGpuBenchmarkPairV2,
  type GpuBenchmarkProfileV2,
  type GpuBenchmarkRawV2,
} from "../src/index.js";

function bytes(name: string): Uint8Array {
  return readFileSync(new URL(`../../../../contracts/${name}`, import.meta.url));
}

function vectorDocument(): {
  readonly contract: unknown;
  readonly durationVector: {
    readonly ascendingStartUs: number;
    readonly incrementUs: number;
    readonly expectedMedianUs: number;
    readonly expectedP95Us: number;
  };
  readonly timestampCases: ReadonlyArray<{ readonly value: string; readonly valid: boolean }>;
  readonly sampleRelationCases: ReadonlyArray<{
    readonly id: string;
    readonly outcome: "success" | "failure";
    readonly durationUs: number | null;
    readonly failureCode: string | null;
    readonly valid: boolean;
  }>;
  readonly ageCases: ReadonlyArray<{ readonly ageMs: number; readonly state: string }>;
} {
  return JSON.parse(new TextDecoder().decode(bytes("gpu-benchmark-v2.vectors.json"))) as ReturnType<typeof vectorDocument>;
}

async function evidence(): Promise<{
  readonly raw: GpuBenchmarkRawV2;
  readonly rawBytes: Uint8Array;
  readonly profile: GpuBenchmarkProfileV2;
  readonly promptFixtureBytes: Uint8Array;
  readonly seedFixtureBytes: Uint8Array;
}> {
  const vectors = vectorDocument();
  const contract = parseGpuBenchmarkContractV2(vectors.contract);
  assert.notEqual(contract, null);
  const seedFixtureBytes = bytes("gpu-benchmark-seeds-v2.json");
  const promptFixtureBytes = bytes("gpu-benchmark-prompts-v2.json");
  const seeds = JSON.parse(new TextDecoder().decode(seedFixtureBytes)) as number[];
  const parsedRaw = parseGpuBenchmarkRawV2({
    schemaVersion: 2,
    gpuId: "NVIDIA GeForce RTX 4090",
    policyKey: "rtx_4090",
    measuredAt: "2026-08-01T00:00:00.000Z",
    bootDurationMs: 125_000,
    contract,
    samples: seeds.map((seed, index) => ({
      ordinal: index + 1,
      promptFixtureOrdinal: index + 1,
      seed,
      outcome: "success",
      durationUs: vectors.durationVector.ascendingStartUs + index * vectors.durationVector.incrementUs,
      failureCode: null,
    })),
  });
  assert.notEqual(parsedRaw, null);
  const raw = parsedRaw as GpuBenchmarkRawV2;
  const rawBytes = gpuBenchmarkRawBytesV2(raw);
  const rawEvidenceSha256 = await sha256HexV1(rawBytes);
  const profile: GpuBenchmarkProfileV2 = Object.freeze({
    schemaVersion: 2,
    gpuId: raw.gpuId,
    policyKey: raw.policyKey,
    measuredAt: raw.measuredAt,
    bootDurationMs: raw.bootDurationMs,
    attemptedSampleCount: 30,
    successfulSampleCount: 30,
    failedSampleCount: 0,
    medianDurationUs: vectors.durationVector.expectedMedianUs,
    p95DurationUs: vectors.durationVector.expectedP95Us,
    contract: raw.contract,
    rawEvidenceSha256,
  });
  return { raw, rawBytes, profile, promptFixtureBytes, seedFixtureBytes };
}

describe("GPU benchmark evidence v2", () => {
  it("recomputes exact evidence bytes/hash, sample pairing, median/p95, and the 90-day boundary", async () => {
    const fixture = await evidence();
    const valid = await validateGpuBenchmarkPairV2(fixture, fixture.raw.contract);
    assert.notEqual(valid, null);
    assert.equal(valid?.profile.medianDurationUs, 1_014_500);
    assert.equal(valid?.profile.p95DurationUs, 1_028_000);
    assert.equal(valid?.rawEvidenceSha256, await sha256HexV1(gpuBenchmarkRawBytesV2(fixture.raw)));

    const measuredAtMs = Date.parse(fixture.raw.measuredAt);
    for (const ageCase of vectorDocument().ageCases) {
      const projection = await projectGpuBenchmarkV2({
        gpuId: fixture.raw.gpuId,
        policyKey: fixture.raw.policyKey,
        expectedContract: fixture.raw.contract,
        evaluationUtcMs: measuredAtMs + ageCase.ageMs,
        candidates: [fixture],
      });
      assert.equal(projection.benchmarkState, ageCase.state, String(ageCase.ageMs));
    }
  });

  it("rejects tampered raw bytes, a wrong fixture, seed substitution, and uppercase image identity", async () => {
    const fixture = await evidence();
    const tamperedRaw = new Uint8Array(fixture.rawBytes.length + 1);
    tamperedRaw.set(fixture.rawBytes.subarray(0, fixture.rawBytes.length - 1));
    tamperedRaw[tamperedRaw.length - 2] = 0x20;
    tamperedRaw[tamperedRaw.length - 1] = 0x0a;
    assert.equal(await validateGpuBenchmarkPairV2({ ...fixture, rawBytes: tamperedRaw }, fixture.raw.contract), null);
    assert.equal(await validateGpuBenchmarkPairV2({
      ...fixture,
      promptFixtureBytes: new TextEncoder().encode("[]\n"),
    }, fixture.raw.contract), null);

    const swappedSeeds = JSON.parse(new TextDecoder().decode(fixture.seedFixtureBytes)) as number[];
    [swappedSeeds[0], swappedSeeds[1]] = [swappedSeeds[1] as number, swappedSeeds[0] as number];
    assert.equal(await validateGpuBenchmarkPairV2({
      ...fixture,
      seedFixtureBytes: new TextEncoder().encode(`${JSON.stringify(swappedSeeds)}\n`),
    }, fixture.raw.contract), null);

    const uppercaseContract = {
      ...fixture.raw.contract,
      workerImageDigest: fixture.raw.contract.workerImageDigest.toUpperCase(),
    };
    assert.equal(parseGpuBenchmarkContractV2(uppercaseContract), null);
  });

  it("shares canonical timestamp and success/failure relational boundary vectors with the schemas", async () => {
    const fixture = await evidence();
    const vectors = vectorDocument();
    for (const timestamp of vectors.timestampCases) {
      assert.equal(
        parseGpuBenchmarkRawV2({ ...fixture.raw, measuredAt: timestamp.value }) !== null,
        timestamp.valid,
        timestamp.value,
      );
    }
    for (const relation of vectors.sampleRelationCases) {
      const samples = fixture.raw.samples.map((sample, index) => index === 0
        ? { ...sample, outcome: relation.outcome, durationUs: relation.durationUs, failureCode: relation.failureCode }
        : sample);
      assert.equal(
        parseGpuBenchmarkRawV2({ ...fixture.raw, samples }) !== null,
        relation.valid,
        relation.id,
      );
    }

    const rawSchema = JSON.parse(new TextDecoder().decode(bytes("gpu-benchmark-raw-v2.schema.json"))) as {
      readonly properties: { readonly measuredAt: { readonly pattern: string } };
      readonly $defs: { readonly sample: { readonly allOf: readonly unknown[] } };
    };
    const profileSchema = JSON.parse(new TextDecoder().decode(bytes("gpu-benchmark-profile-v2.schema.json"))) as {
      readonly properties: { readonly measuredAt: { readonly pattern: string } };
    };
    assert.equal(rawSchema.properties.measuredAt.pattern, "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$");
    assert.equal(profileSchema.properties.measuredAt.pattern, rawSchema.properties.measuredAt.pattern);
    assert.equal(rawSchema.$defs.sample.allOf.length, 2);
  });

  it("keeps legacy profile-only evidence unmeasured instead of inferring v2 provenance", async () => {
    const fixture = await evidence();
    const projection = await projectGpuBenchmarkV2({
      gpuId: fixture.raw.gpuId,
      policyKey: fixture.raw.policyKey,
      expectedContract: fixture.raw.contract,
      evaluationUtcMs: Date.parse(fixture.raw.measuredAt),
      candidates: [{
        ...fixture,
        profile: {
          gpuId: fixture.raw.gpuId,
          secondsPerImage: 1.2,
          measuredAt: fixture.raw.measuredAt,
        },
      }],
    });
    assert.equal(projection.benchmarkState, "unmeasured");
  });
});
