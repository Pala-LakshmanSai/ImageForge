import { isGpuIdentityV1 } from "./gpu-policy.js";
import { isLowercaseRegistryImageDigestV1 } from "./image-identity.js";

export const BENCHMARK_MAX_AGE_MS_V1 = 7_776_000_000;
const HASH_V1 = /^[0-9a-f]{64}$/;
const FAILURE_CODE_V1 = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const UTC_MILLISECONDS_V1 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface GpuBenchmarkContractV2 {
  readonly modelId: "Comfy-Org/Mage-Flow";
  readonly modelRevision: string;
  readonly workerImageDigest: string;
  readonly templateId: string;
  readonly precision: "bf16";
  readonly width: 1280;
  readonly height: 720;
  readonly steps: 4;
  readonly guidanceMilli: 1000;
  readonly jpegQuality: 95;
  readonly referenceMode: "none";
  readonly promptFixtureId: "imageforge-gpu-benchmark-30-v1";
  readonly promptFixtureSha256: string;
  readonly seedFixtureSha256: string;
}

export interface GpuBenchmarkSampleV2 {
  readonly ordinal: number;
  readonly promptFixtureOrdinal: number;
  readonly seed: number;
  readonly outcome: "success" | "failure";
  readonly durationUs: number | null;
  readonly failureCode: string | null;
}

export interface GpuBenchmarkRawV2 {
  readonly schemaVersion: 2;
  readonly gpuId: string;
  readonly policyKey: string;
  readonly measuredAt: string;
  readonly bootDurationMs: number;
  readonly contract: GpuBenchmarkContractV2;
  readonly samples: readonly GpuBenchmarkSampleV2[];
}

export interface GpuBenchmarkProfileV2 {
  readonly schemaVersion: 2;
  readonly gpuId: string;
  readonly policyKey: string;
  readonly measuredAt: string;
  readonly bootDurationMs: number;
  readonly attemptedSampleCount: 30;
  readonly successfulSampleCount: 30;
  readonly failedSampleCount: 0;
  readonly medianDurationUs: number;
  readonly p95DurationUs: number;
  readonly contract: GpuBenchmarkContractV2;
  readonly rawEvidenceSha256: string;
}

export type GpuBenchmarkStateV2 = "measured" | "stale" | "unmeasured";

export interface GpuBenchmarkProjectionV2 {
  readonly benchmarkState: GpuBenchmarkStateV2;
  readonly benchmarkAgeMs: number | null;
  readonly benchmarkMedianDurationUs: number | null;
  readonly benchmarkP95DurationUs: number | null;
  readonly benchmarkMeasuredAt: string | null;
  readonly benchmarkEvidenceSha256: string | null;
  readonly bootDurationMs: number | null;
}

export interface GpuBenchmarkEvidenceCandidateV2 {
  readonly rawBytes: Uint8Array;
  readonly profile: unknown;
  readonly promptFixtureBytes: Uint8Array;
  readonly seedFixtureBytes: Uint8Array;
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return null;
  return record;
}

function safeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_MILLISECONDS_V1.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === value;
}

function sameContract(left: GpuBenchmarkContractV2, right: GpuBenchmarkContractV2): boolean {
  return Object.keys(left).every((key) =>
    left[key as keyof GpuBenchmarkContractV2] === right[key as keyof GpuBenchmarkContractV2],
  );
}

export function parseGpuBenchmarkContractV2(value: unknown): GpuBenchmarkContractV2 | null {
  const keys = [
    "modelId", "modelRevision", "workerImageDigest", "templateId", "precision",
    "width", "height", "steps", "guidanceMilli", "jpegQuality", "referenceMode",
    "promptFixtureId", "promptFixtureSha256", "seedFixtureSha256",
  ] as const;
  const record = exactRecord(value, keys);
  if (
    record === null ||
    record.modelId !== "Comfy-Org/Mage-Flow" ||
    typeof record.modelRevision !== "string" || record.modelRevision.length < 1 || record.modelRevision.length > 128 ||
    !isLowercaseRegistryImageDigestV1(record.workerImageDigest) ||
    typeof record.templateId !== "string" || record.templateId.length < 1 || record.templateId.length > 191 ||
    record.precision !== "bf16" || record.width !== 1280 || record.height !== 720 ||
    record.steps !== 4 || record.guidanceMilli !== 1000 || record.jpegQuality !== 95 ||
    record.referenceMode !== "none" ||
    record.promptFixtureId !== "imageforge-gpu-benchmark-30-v1" ||
    typeof record.promptFixtureSha256 !== "string" || !HASH_V1.test(record.promptFixtureSha256) ||
    typeof record.seedFixtureSha256 !== "string" || !HASH_V1.test(record.seedFixtureSha256)
  ) return null;
  return Object.freeze(record as unknown as GpuBenchmarkContractV2);
}

export function parseGpuBenchmarkRawV2(value: unknown): GpuBenchmarkRawV2 | null {
  const record = exactRecord(value, [
    "schemaVersion", "gpuId", "policyKey", "measuredAt", "bootDurationMs", "contract", "samples",
  ]);
  const contract = record === null ? null : parseGpuBenchmarkContractV2(record.contract);
  if (
    record === null || record.schemaVersion !== 2 ||
    typeof record.gpuId !== "string" || !isGpuIdentityV1(record.gpuId) ||
    typeof record.policyKey !== "string" || !/^[a-z0-9][a-z0-9_]{0,63}$/.test(record.policyKey) ||
    !canonicalTimestamp(record.measuredAt) ||
    !safeInteger(record.bootDurationMs, 0, 1_200_000) || contract === null ||
    !Array.isArray(record.samples) || record.samples.length !== 30
  ) return null;

  const samples: GpuBenchmarkSampleV2[] = [];
  for (let index = 0; index < record.samples.length; index += 1) {
    const sample = exactRecord(record.samples[index], [
      "ordinal", "promptFixtureOrdinal", "seed", "outcome", "durationUs", "failureCode",
    ]);
    const ordinal = index + 1;
    if (
      sample === null || sample.ordinal !== ordinal || sample.promptFixtureOrdinal !== ordinal ||
      !safeInteger(sample.seed, 0, Number.MAX_SAFE_INTEGER) ||
      (sample.outcome !== "success" && sample.outcome !== "failure")
    ) return null;
    if (sample.outcome === "success") {
      if (!safeInteger(sample.durationUs, 1, 3_600_000_000) || sample.failureCode !== null) return null;
    } else if (sample.durationUs !== null || typeof sample.failureCode !== "string" || !FAILURE_CODE_V1.test(sample.failureCode)) {
      return null;
    }
    samples.push(Object.freeze(sample as unknown as GpuBenchmarkSampleV2));
  }
  return Object.freeze({
    schemaVersion: 2,
    gpuId: record.gpuId,
    policyKey: record.policyKey,
    measuredAt: record.measuredAt,
    bootDurationMs: record.bootDurationMs,
    contract,
    samples: Object.freeze(samples),
  });
}

export function recomputeGpuBenchmarkDurationsV2(
  raw: GpuBenchmarkRawV2,
): { readonly medianDurationUs: number; readonly p95DurationUs: number } | null {
  const durations = raw.samples.flatMap((sample) =>
    sample.outcome === "success" && sample.durationUs !== null ? [sample.durationUs] : [],
  );
  if (durations.length !== 30) return null;
  durations.sort((left, right) => left - right);
  const leftMedian = durations[14];
  const rightMedian = durations[15];
  const p95 = durations[28];
  if (leftMedian === undefined || rightMedian === undefined || p95 === undefined) return null;
  return Object.freeze({
    medianDurationUs: Math.floor((leftMedian + rightMedian + 1) / 2),
    p95DurationUs: p95,
  });
}

export function parseGpuBenchmarkProfileV2(value: unknown): GpuBenchmarkProfileV2 | null {
  const record = exactRecord(value, [
    "schemaVersion", "gpuId", "policyKey", "measuredAt", "bootDurationMs",
    "attemptedSampleCount", "successfulSampleCount", "failedSampleCount",
    "medianDurationUs", "p95DurationUs", "contract", "rawEvidenceSha256",
  ]);
  const contract = record === null ? null : parseGpuBenchmarkContractV2(record.contract);
  if (
    record === null || record.schemaVersion !== 2 ||
    typeof record.gpuId !== "string" || !isGpuIdentityV1(record.gpuId) ||
    typeof record.policyKey !== "string" || !/^[a-z0-9][a-z0-9_]{0,63}$/.test(record.policyKey) ||
    !canonicalTimestamp(record.measuredAt) || !safeInteger(record.bootDurationMs, 0, 1_200_000) ||
    record.attemptedSampleCount !== 30 || record.successfulSampleCount !== 30 || record.failedSampleCount !== 0 ||
    !safeInteger(record.medianDurationUs, 1, 3_600_000_000) ||
    !safeInteger(record.p95DurationUs, 1, 3_600_000_000) || contract === null ||
    typeof record.rawEvidenceSha256 !== "string" || !HASH_V1.test(record.rawEvidenceSha256)
  ) return null;
  return Object.freeze({ ...record, contract } as unknown as GpuBenchmarkProfileV2);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function parseCanonicalFixtureBytesV2(bytes: Uint8Array): unknown | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.endsWith("\n") || text.startsWith("\ufeff")) return null;
    const value = JSON.parse(text.slice(0, -1)) as unknown;
    return equalBytes(bytes, new TextEncoder().encode(`${jcsStringifyV1(value)}\n`)) ? value : null;
  } catch {
    return null;
  }
}

export async function validateGpuBenchmarkPairV2(
  candidate: GpuBenchmarkEvidenceCandidateV2,
  expectedContract: GpuBenchmarkContractV2,
): Promise<{ readonly raw: GpuBenchmarkRawV2; readonly profile: GpuBenchmarkProfileV2; readonly rawEvidenceSha256: string } | null> {
  const rawValue = parseCanonicalFixtureBytesV2(candidate.rawBytes);
  const raw = parseGpuBenchmarkRawV2(rawValue);
  const profile = parseGpuBenchmarkProfileV2(candidate.profile);
  const prompts = parseCanonicalFixtureBytesV2(candidate.promptFixtureBytes);
  const seeds = parseCanonicalFixtureBytesV2(candidate.seedFixtureBytes);
  if (
    raw === null || profile === null || !Array.isArray(prompts) || prompts.length !== 30 ||
    prompts.some((prompt) => typeof prompt !== "string" || prompt.length < 1 || prompt.length > 2_000) ||
    !Array.isArray(seeds) || seeds.length !== 30 ||
    seeds.some((seed) => !safeInteger(seed, 0, Number.MAX_SAFE_INTEGER))
  ) return null;
  const [rawEvidenceSha256, promptFixtureSha256, seedFixtureSha256] = await Promise.all([
    sha256HexV1(candidate.rawBytes),
    sha256HexV1(candidate.promptFixtureBytes),
    sha256HexV1(candidate.seedFixtureBytes),
  ]);
  if (
    profile.rawEvidenceSha256 !== rawEvidenceSha256 ||
    raw.contract.promptFixtureSha256 !== promptFixtureSha256 ||
    raw.contract.seedFixtureSha256 !== seedFixtureSha256 ||
    raw.gpuId !== profile.gpuId || raw.policyKey !== profile.policyKey ||
    raw.measuredAt !== profile.measuredAt || raw.bootDurationMs !== profile.bootDurationMs ||
    !sameContract(raw.contract, profile.contract) || !sameContract(raw.contract, expectedContract)
  ) return null;
  if (raw.samples.some((sample, index) => sample.seed !== seeds[index])) return null;
  const durations = recomputeGpuBenchmarkDurationsV2(raw);
  if (
    durations === null || durations.medianDurationUs !== profile.medianDurationUs ||
    durations.p95DurationUs !== profile.p95DurationUs
  ) return null;
  return Object.freeze({ raw, profile, rawEvidenceSha256 });
}

const UNMEASURED: GpuBenchmarkProjectionV2 = Object.freeze({
  benchmarkState: "unmeasured",
  benchmarkAgeMs: null,
  benchmarkMedianDurationUs: null,
  benchmarkP95DurationUs: null,
  benchmarkMeasuredAt: null,
  benchmarkEvidenceSha256: null,
  bootDurationMs: null,
});

export async function projectGpuBenchmarkV2(input: {
  readonly gpuId: string;
  readonly policyKey: string;
  readonly expectedContract: GpuBenchmarkContractV2;
  readonly evaluationUtcMs: number;
  readonly candidates: readonly GpuBenchmarkEvidenceCandidateV2[];
}): Promise<GpuBenchmarkProjectionV2> {
  if (!Number.isSafeInteger(input.evaluationUtcMs)) return UNMEASURED;
  const pairs = await Promise.all(input.candidates.map((candidate) =>
    validateGpuBenchmarkPairV2(candidate, input.expectedContract),
  ));
  const valid = pairs.flatMap((pair) =>
    pair !== null && pair.profile.gpuId === input.gpuId && pair.profile.policyKey === input.policyKey
      ? [{ ...pair, hash: pair.rawEvidenceSha256 }]
      : [],
  );
  valid.sort((left, right) => {
    const time = Date.parse(right.profile.measuredAt) - Date.parse(left.profile.measuredAt);
    if (time !== 0) return time;
    return left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0;
  });
  const selected = valid[0];
  if (selected === undefined) return UNMEASURED;
  const measuredUtcMs = Date.parse(selected.profile.measuredAt);
  const ageMs = input.evaluationUtcMs - measuredUtcMs;
  if (!Number.isSafeInteger(ageMs) || ageMs < 0) return UNMEASURED;
  if (ageMs >= BENCHMARK_MAX_AGE_MS_V1) {
    return Object.freeze({
      benchmarkState: "stale",
      benchmarkAgeMs: ageMs,
      benchmarkMedianDurationUs: null,
      benchmarkP95DurationUs: null,
      benchmarkMeasuredAt: selected.profile.measuredAt,
      benchmarkEvidenceSha256: selected.hash,
      bootDurationMs: null,
    });
  }
  return Object.freeze({
    benchmarkState: "measured",
    benchmarkAgeMs: ageMs,
    benchmarkMedianDurationUs: selected.profile.medianDurationUs,
    benchmarkP95DurationUs: selected.profile.p95DurationUs,
    benchmarkMeasuredAt: selected.profile.measuredAt,
    benchmarkEvidenceSha256: selected.hash,
    bootDurationMs: selected.profile.bootDurationMs,
  });
}

export function jcsStringifyV1(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("JCS evidence permits safe integers only.");
    return value.toString();
  }
  if (Array.isArray(value)) return `[${value.map(jcsStringifyV1).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Unsupported JCS value.");
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${jcsStringifyV1(record[key])}`).join(",")}}`;
}

export function gpuBenchmarkRawBytesV2(raw: GpuBenchmarkRawV2): Uint8Array {
  return new TextEncoder().encode(`${jcsStringifyV1(raw)}\n`);
}

export async function sha256HexV1(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
