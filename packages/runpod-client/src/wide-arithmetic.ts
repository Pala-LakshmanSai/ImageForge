export const U128_MAX_V1 = 340282366920938463463374607431768211455n;
export const CANONICAL_U128_DECIMAL_V1 = /^(0|[1-9][0-9]{0,38})$/;
const COST_DENOMINATOR_US = 3_600_000_000n;

export type CanonicalU128DecimalV1 = string & {
  readonly __canonicalUnsignedU128Decimal: unique symbol;
};

function checked(value: bigint): bigint | null {
  return value >= 0n && value <= U128_MAX_V1 ? value : null;
}

export function parseCanonicalU128DecimalV1(value: string): bigint | null {
  if (!CANONICAL_U128_DECIMAL_V1.test(value)) return null;
  try {
    return checked(BigInt(value));
  } catch {
    return null;
  }
}

export function canonicalU128DecimalV1(value: bigint): CanonicalU128DecimalV1 | null {
  const valid = checked(value);
  return valid === null ? null : (valid.toString() as CanonicalU128DecimalV1);
}

export function safeIntegerToU128V1(value: number): bigint | null {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return checked(BigInt(value.toString()));
}

export function checkedU128MultiplyV1(left: bigint, right: bigint): bigint | null {
  if (checked(left) === null || checked(right) === null) return null;
  if (left !== 0n && right > U128_MAX_V1 / left) return null;
  return checked(left * right);
}

export function checkedU128AddV1(left: bigint, right: bigint): bigint | null {
  if (checked(left) === null || checked(right) === null || right > U128_MAX_V1 - left) return null;
  return left + right;
}

export function divideU128HalfUpV1(
  numerator: bigint,
  denominator: bigint,
): CanonicalU128DecimalV1 | null {
  if (checked(numerator) === null || checked(denominator) === null || denominator === 0n) return null;
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const doubledRemainder = checkedU128MultiplyV1(remainder, 2n);
  if (doubledRemainder === null) return null;
  const rounded = checkedU128AddV1(
    quotient,
    doubledRemainder >= denominator ? 1n : 0n,
  );
  return rounded === null ? null : canonicalU128DecimalV1(rounded);
}

export function gpuAutoValueProductV1(
  hourlyPriceMicroUsd: number,
  medianDurationUs: number,
): bigint | null {
  const price = safeIntegerToU128V1(hourlyPriceMicroUsd);
  const duration = safeIntegerToU128V1(medianDurationUs);
  return price === null || duration === null ? null : checkedU128MultiplyV1(price, duration);
}

export function gpuSpeedScoreV1(fastestMedianUs: number, medianDurationUs: number): number | null {
  const fastest = safeIntegerToU128V1(fastestMedianUs);
  const median = safeIntegerToU128V1(medianDurationUs);
  if (fastest === null || median === null || fastest === 0n || median === 0n) return null;
  const numerator = checkedU128MultiplyV1(100n, fastest);
  if (numerator === null) return null;
  const quotient = numerator / median;
  const remainder = numerator % median;
  const rounded = quotient + (2n * remainder >= median ? 1n : 0n);
  return Number(rounded < 1n ? 1n : rounded > 100n ? 100n : rounded);
}

export interface GpuEstimatedCostInputV1 {
  readonly hourlyPriceMicroUsd: number;
  readonly bootDurationMs: number;
  readonly medianDurationUs: number;
  readonly remainingImages: number;
}

export interface GpuEstimatedCostTraceV1 {
  readonly runtimeUs: bigint;
  readonly numerator: bigint;
  readonly quotient: bigint;
  readonly remainder: bigint;
  readonly roundedMicroUsd: CanonicalU128DecimalV1;
}

export function gpuEstimatedCostTraceV1(input: GpuEstimatedCostInputV1): GpuEstimatedCostTraceV1 | null {
  if (
    input.remainingImages < 0 ||
    input.remainingImages > 450 ||
    input.bootDurationMs < 0 ||
    input.bootDurationMs > 1_200_000 ||
    input.medianDurationUs < 1 ||
    input.medianDurationUs > 3_600_000_000
  ) return null;
  const price = safeIntegerToU128V1(input.hourlyPriceMicroUsd);
  const boot = safeIntegerToU128V1(input.bootDurationMs);
  const median = safeIntegerToU128V1(input.medianDurationUs);
  const remaining = safeIntegerToU128V1(input.remainingImages);
  if (price === null || boot === null || median === null || remaining === null) return null;
  const bootUs = checkedU128MultiplyV1(boot, 1_000n);
  const generationUs = checkedU128MultiplyV1(median, remaining);
  if (bootUs === null || generationUs === null) return null;
  const runtimeUs = checkedU128AddV1(bootUs, generationUs);
  if (runtimeUs === null) return null;
  const numerator = checkedU128MultiplyV1(price, runtimeUs);
  if (numerator === null) return null;
  const quotient = numerator / COST_DENOMINATOR_US;
  const remainder = numerator % COST_DENOMINATOR_US;
  const roundedMicroUsd = divideU128HalfUpV1(numerator, COST_DENOMINATOR_US);
  if (roundedMicroUsd === null) return null;
  return Object.freeze({ runtimeUs, numerator, quotient, remainder, roundedMicroUsd });
}

export function gpuEstimatedCostMicroUsdV1(
  input: GpuEstimatedCostInputV1,
): CanonicalU128DecimalV1 | null {
  return gpuEstimatedCostTraceV1(input)?.roundedMicroUsd ?? null;
}

export function formatCanonicalMicroUsdV1(value: string | null): string {
  if (value === null) return "—";
  const parsed = parseCanonicalU128DecimalV1(value);
  if (parsed === null) return "—";
  const whole = (parsed / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (parsed % 1_000_000n).toString().padStart(6, "0");
  return `$${whole}.${fraction}`;
}

export interface GpuAutoValueCandidateV1 {
  readonly gpuId: string;
  readonly policyPriority: number;
  readonly hourlyPriceMicroUsd: number;
  readonly medianDurationUs: number;
}

export function rankGpuAutoValueCandidatesV1<T extends GpuAutoValueCandidateV1>(
  candidates: readonly T[],
): readonly T[] | null {
  const products = candidates.map((candidate) => ({
    candidate,
    product: gpuAutoValueProductV1(candidate.hourlyPriceMicroUsd, candidate.medianDurationUs),
  }));
  if (products.some(({ product }) => product === null)) return null;
  products.sort((left, right) => {
    const leftProduct = left.product as bigint;
    const rightProduct = right.product as bigint;
    if (leftProduct !== rightProduct) return leftProduct < rightProduct ? -1 : 1;
    if (left.candidate.policyPriority !== right.candidate.policyPriority) {
      return left.candidate.policyPriority - right.candidate.policyPriority;
    }
    return left.candidate.gpuId < right.candidate.gpuId
      ? -1
      : left.candidate.gpuId > right.candidate.gpuId ? 1 : 0;
  });
  return Object.freeze(products.map(({ candidate }) => candidate));
}
