import {
  GPU_POLICY,
  approveCatalogGpu,
  isGpuIdentityV1,
  staticGpuPolicy,
} from "./gpu-policy.js";
import { BENCHMARK_MAX_AGE_MS_V1 } from "./benchmark-v2.js";
import {
  parseCanonicalU128DecimalV1,
  gpuEstimatedCostMicroUsdV1,
  gpuSpeedScoreV1,
  rankGpuAutoValueCandidatesV1,
  type CanonicalU128DecimalV1,
} from "./wide-arithmetic.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_V1 = /^[0-9a-f]{64}$/;
const UTC_MILLISECONDS_V1 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const POLICY_KEY_V1 = /^[a-z0-9][a-z0-9_]{0,63}$/;
const POD_ID_V1 = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,56}[A-Za-z0-9])?$/;

export type NativeGpuInventoryStateV1 = "loading" | "ready" | "empty" | "fallback" | "error";
export type GpuSelectorAvailabilityV1 = "unknown" | "none" | "low" | "medium" | "high";
export type GpuSelectorDisabledReasonV1 =
  | "current_gpu" | "unapproved_current" | "inventory_loading"
  | "inventory_error" | "fallback_only" | "inventory_stale"
  | "unavailable" | "price_unavailable" | "same_as_current";

export interface NativeGpuSwitchPodV1 {
  readonly podId: string;
  readonly gpuId: string;
  readonly gpuDisplayName: string;
  readonly hourlyPriceMicroUsd: number | null;
}

export interface NativeGpuInventoryReceiptV1 {
  readonly schemaVersion: 1;
  readonly receiptId: string;
  readonly processEpochId: string;
  readonly receivedAt: string;
  readonly validForMs: 60000;
  readonly catalogSha256: string;
}

export type NativeGpuInventoryIssueV1 =
  | { readonly code: "gpu_inventory_datacenters_unavailable"; readonly retryable: true }
  | { readonly code: "gpu_inventory_gpus_unavailable"; readonly retryable: true }
  | { readonly code: "gpu_inventory_response_invalid"; readonly retryable: false }
  | { readonly code: "gpu_inventory_region_unsupported"; readonly retryable: false };

export interface GpuSelectorOfferV1 {
  readonly schemaVersion: 1;
  readonly observationId: string;
  readonly receiptId: string | null;
  readonly gpuId: string;
  readonly policyKey: string;
  readonly displayName: string;
  readonly memoryGb: number;
  readonly emergency: boolean;
  readonly availability: GpuSelectorAvailabilityV1;
  readonly hourlyPriceMicroUsd: number | null;
  readonly dataCenterId: "EU-RO-1";
  readonly source: "live" | "fallback" | "current";
  readonly observedAt: string | null;
  readonly stale: boolean;
  readonly selectable: boolean;
  readonly disabledReason: GpuSelectorDisabledReasonV1 | null;
  readonly benchmarkState: "measured" | "stale" | "unmeasured";
  readonly benchmarkAgeMs: number | null;
  readonly speedScore: number | null;
  readonly benchmarkMedianDurationUs: number | null;
  readonly benchmarkP95DurationUs: number | null;
  readonly benchmarkMeasuredAt: string | null;
  readonly benchmarkEvidenceSha256: string | null;
  readonly estimatedSwitchRemainingCostMicroUsd: CanonicalU128DecimalV1 | null;
}

export interface NativeGpuInventorySnapshotV1 {
  readonly schemaVersion: 1;
  readonly observationId: string;
  readonly processEpochId: string;
  readonly includeEmergencyTier: boolean;
  readonly state: NativeGpuInventoryStateV1;
  readonly observedAt: string | null;
  readonly receipt: NativeGpuInventoryReceiptV1 | null;
  readonly offers: readonly GpuSelectorOfferV1[];
  readonly currentPod: NativeGpuSwitchPodV1 | null;
  readonly currentPodObservedAt: string | null;
  readonly currentPodStale: boolean;
  readonly issue: NativeGpuInventoryIssueV1 | null;
}

export interface NativeGpuInventoryEventV1 {
  readonly schemaVersion: 1;
  readonly event: "gpu-inventory-v1";
  readonly processEpochId: string;
  readonly observationId: string;
  readonly eventSequence: number;
  readonly superseded: boolean;
  readonly snapshot: NativeGpuInventorySnapshotV1;
}

export interface GpuSelectorLiveOfferInputV1 {
  readonly gpuId: string;
  readonly policyKey: string;
  readonly displayName: string;
  readonly memoryGb: number;
  readonly emergency: boolean;
  readonly availability: Exclude<GpuSelectorAvailabilityV1, "unknown">;
  readonly hourlyPriceMicroUsd: number | null;
  readonly benchmarkState: "measured" | "stale" | "unmeasured";
  readonly benchmarkAgeMs: number | null;
  readonly benchmarkMedianDurationUs: number | null;
  readonly benchmarkP95DurationUs: number | null;
  readonly benchmarkMeasuredAt: string | null;
  readonly benchmarkEvidenceSha256: string | null;
  readonly bootDurationMs: number | null;
  readonly remainingImages: number | null;
}

export interface GpuAutoSelectionProjectionV1 {
  readonly schemaVersion: 1;
  readonly observationId: string;
  readonly receiptId: string;
  readonly mode: "measured_best_value" | "fixed_policy";
  readonly benchmarkQuorum: boolean;
  readonly orderedGpuIds: readonly string[];
}

export interface GpuManualSelectionProjectionV1 {
  readonly schemaVersion: 1;
  readonly observationId: string;
  readonly receiptId: string;
  readonly targetGpuId: string;
  readonly confirmedHourlyPriceMicroUsd: number;
}

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && UTC_MILLISECONDS_V1.test(value) &&
    new Date(Date.parse(value)).toISOString() === value;
}

function safeInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function currentPodRelations(input: {
  readonly currentPod: NativeGpuSwitchPodV1 | null;
  readonly currentPodObservedAt: string | null;
  readonly currentPodStale: boolean;
}): boolean {
  return input.currentPod === null
    ? input.currentPodObservedAt === null && !input.currentPodStale
    : canonicalTimestamp(input.currentPodObservedAt);
}

export function gpuSelectorDisabledReasonV1(input: {
  readonly source: GpuSelectorOfferV1["source"];
  readonly approvedCurrent: boolean;
  readonly inventoryState: NativeGpuInventoryStateV1;
  readonly stale: boolean;
  readonly availability: GpuSelectorAvailabilityV1;
  readonly hourlyPriceMicroUsd: number | null;
  readonly sameAsCurrent: boolean;
}): GpuSelectorDisabledReasonV1 | null {
  if (input.source === "current") return input.approvedCurrent ? "current_gpu" : "unapproved_current";
  if (input.inventoryState === "loading") return "inventory_loading";
  if (input.inventoryState === "error" || input.inventoryState === "empty") return "inventory_error";
  if (input.inventoryState === "fallback") return "fallback_only";
  if (input.stale) return "inventory_stale";
  if (input.availability === "none" || input.availability === "unknown") return "unavailable";
  if (input.hourlyPriceMicroUsd === null) return "price_unavailable";
  if (input.sameAsCurrent) return "same_as_current";
  return null;
}

function policyPriority(policyKey: string): number {
  return GPU_POLICY.find((entry) => entry.key === policyKey)?.coldPriority ?? Number.MAX_SAFE_INTEGER;
}

function sortOffers(offers: readonly GpuSelectorOfferV1[]): readonly GpuSelectorOfferV1[] {
  return Object.freeze([...offers].sort((left, right) => {
    if (left.source === "current" || right.source === "current") {
      return left.source === right.source ? 0 : left.source === "current" ? -1 : 1;
    }
    if (left.emergency !== right.emergency) return left.emergency ? 1 : -1;
    const priority = policyPriority(left.policyKey) - policyPriority(right.policyKey);
    if (priority !== 0) return priority;
    return left.gpuId < right.gpuId ? -1 : left.gpuId > right.gpuId ? 1 : 0;
  }));
}

export function projectLiveGpuSelectorOffersV1(input: {
  readonly observationId: string;
  readonly receiptId: string;
  readonly observedAt: string;
  readonly currentGpuId: string | null;
  readonly offers: readonly GpuSelectorLiveOfferInputV1[];
}): readonly GpuSelectorOfferV1[] {
  const measuredOrdinary = input.offers.filter((offer) => !offer.emergency && offer.benchmarkState === "measured");
  const fastestMedianUs = measuredOrdinary.reduce<number | null>((fastest, offer) => {
    const median = offer.benchmarkMedianDurationUs;
    return median === null ? fastest : fastest === null || median < fastest ? median : fastest;
  }, null);
  const projected = input.offers.flatMap((offer) => {
    if (
      !isGpuIdentityV1(offer.gpuId) || !isGpuIdentityV1(offer.displayName) ||
      !safeInteger(offer.memoryGb, 1, 1024) || !safeInteger(offer.hourlyPriceMicroUsd ?? 0)
    ) return [];
    const disabledReason = gpuSelectorDisabledReasonV1({
      source: "live",
      approvedCurrent: true,
      inventoryState: "ready",
      stale: false,
      availability: offer.availability,
      hourlyPriceMicroUsd: offer.hourlyPriceMicroUsd,
      sameAsCurrent: input.currentGpuId === offer.gpuId,
    });
    const measured = offer.benchmarkState === "measured" &&
      offer.benchmarkMedianDurationUs !== null && offer.bootDurationMs !== null;
    const estimated = measured && offer.hourlyPriceMicroUsd !== null && offer.remainingImages !== null
      ? gpuEstimatedCostMicroUsdV1({
          hourlyPriceMicroUsd: offer.hourlyPriceMicroUsd,
          bootDurationMs: offer.bootDurationMs,
          medianDurationUs: offer.benchmarkMedianDurationUs as number,
          remainingImages: offer.remainingImages,
        })
      : null;
    return [Object.freeze({
      schemaVersion: 1 as const,
      observationId: input.observationId,
      receiptId: input.receiptId,
      gpuId: offer.gpuId,
      policyKey: offer.policyKey,
      displayName: offer.displayName,
      memoryGb: offer.memoryGb,
      emergency: offer.emergency,
      availability: offer.availability,
      hourlyPriceMicroUsd: offer.hourlyPriceMicroUsd,
      dataCenterId: "EU-RO-1" as const,
      source: "live" as const,
      observedAt: input.observedAt,
      stale: false,
      selectable: disabledReason === null,
      disabledReason,
      benchmarkState: offer.benchmarkState,
      benchmarkAgeMs: offer.benchmarkAgeMs,
      speedScore: measured && fastestMedianUs !== null
        ? gpuSpeedScoreV1(fastestMedianUs, offer.benchmarkMedianDurationUs as number)
        : null,
      benchmarkMedianDurationUs: measured ? offer.benchmarkMedianDurationUs : null,
      benchmarkP95DurationUs: measured ? offer.benchmarkP95DurationUs : null,
      benchmarkMeasuredAt: offer.benchmarkState === "unmeasured" ? null : offer.benchmarkMeasuredAt,
      benchmarkEvidenceSha256: offer.benchmarkState === "unmeasured" ? null : offer.benchmarkEvidenceSha256,
      estimatedSwitchRemainingCostMicroUsd: offer.benchmarkState === "measured" ? estimated : null,
    })];
  });
  return sortOffers(projected);
}

export function projectManualGpuSelectionV1(
  snapshot: NativeGpuInventorySnapshotV1,
  gpuId: string,
  expectedProcessEpochId = snapshot.processEpochId,
): GpuManualSelectionProjectionV1 | null {
  if (
    snapshot.state !== "ready" || snapshot.receipt === null ||
    snapshot.processEpochId !== expectedProcessEpochId ||
    !validateInventorySnapshotRelationsV1(snapshot, expectedProcessEpochId)
  ) return null;
  const offer = snapshot.offers.find((candidate) => candidate.gpuId === gpuId);
  if (!offer?.selectable || offer.receiptId !== snapshot.receipt.receiptId || offer.hourlyPriceMicroUsd === null) return null;
  return Object.freeze({
    schemaVersion: 1,
    observationId: snapshot.observationId,
    receiptId: snapshot.receipt.receiptId,
    targetGpuId: offer.gpuId,
    confirmedHourlyPriceMicroUsd: offer.hourlyPriceMicroUsd,
  });
}

export function projectAutoGpuSelectionV1(
  snapshot: NativeGpuInventorySnapshotV1,
  expectedProcessEpochId = snapshot.processEpochId,
): GpuAutoSelectionProjectionV1 | null {
  if (
    snapshot.state !== "ready" || snapshot.receipt === null || snapshot.currentPod !== null ||
    snapshot.processEpochId !== expectedProcessEpochId ||
    !validateInventorySnapshotRelationsV1(snapshot, expectedProcessEpochId)
  ) return null;
  const ordinary = snapshot.offers.filter((offer) =>
    offer.source === "live" && !offer.emergency && offer.selectable &&
    offer.availability !== "none" && offer.availability !== "unknown" &&
    offer.hourlyPriceMicroUsd !== null,
  );
  if (ordinary.length === 0 || ordinary.some((offer) => offer.receiptId !== snapshot.receipt?.receiptId)) return null;
  const quorum = ordinary.length >= 2 && ordinary.every((offer) =>
    offer.benchmarkState === "measured" && offer.benchmarkMedianDurationUs !== null,
  );
  const ranked = quorum
    ? rankGpuAutoValueCandidatesV1(ordinary.map((offer) => ({
        ...offer,
        policyPriority: policyPriority(offer.policyKey),
        hourlyPriceMicroUsd: offer.hourlyPriceMicroUsd as number,
        medianDurationUs: offer.benchmarkMedianDurationUs as number,
      })))
    : [...ordinary].sort((left, right) => {
        const priority = policyPriority(left.policyKey) - policyPriority(right.policyKey);
        if (priority !== 0) return priority;
        return left.gpuId < right.gpuId ? -1 : left.gpuId > right.gpuId ? 1 : 0;
      });
  if (ranked === null) return null;
  return Object.freeze({
    schemaVersion: 1,
    observationId: snapshot.observationId,
    receiptId: snapshot.receipt.receiptId,
    mode: quorum ? "measured_best_value" : "fixed_policy",
    benchmarkQuorum: quorum,
    orderedGpuIds: Object.freeze(ranked.map((offer) => offer.gpuId)),
  });
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]) ? record : null;
}

function nullableSafeInteger(value: unknown): value is number | null {
  return value === null || safeInteger(value);
}

function parseCurrentPodV1(value: unknown): NativeGpuSwitchPodV1 | null {
  const record = exactRecord(value, [
    "podId", "gpuId", "gpuDisplayName", "hourlyPriceMicroUsd",
  ]);
  if (
    record === null || typeof record.podId !== "string" || !POD_ID_V1.test(record.podId) ||
    typeof record.gpuId !== "string" || !isGpuIdentityV1(record.gpuId) ||
    typeof record.gpuDisplayName !== "string" || !isGpuIdentityV1(record.gpuDisplayName) ||
    !nullableSafeInteger(record.hourlyPriceMicroUsd)
  ) return null;
  return Object.freeze(record as unknown as NativeGpuSwitchPodV1);
}

function parseReceiptV1(value: unknown): NativeGpuInventoryReceiptV1 | null {
  const record = exactRecord(value, [
    "schemaVersion", "receiptId", "processEpochId", "receivedAt", "validForMs", "catalogSha256",
  ]);
  if (
    record === null || record.schemaVersion !== 1 || !isCanonicalUuidV4(record.receiptId) ||
    !isCanonicalUuidV4(record.processEpochId) || !canonicalTimestamp(record.receivedAt) ||
    record.validForMs !== 60000 || typeof record.catalogSha256 !== "string" ||
    !HASH_V1.test(record.catalogSha256)
  ) return null;
  return Object.freeze(record as unknown as NativeGpuInventoryReceiptV1);
}

function parseIssueV1(value: unknown): NativeGpuInventoryIssueV1 | null {
  const record = exactRecord(value, ["code", "retryable"]);
  if (record === null) return null;
  if (
    (record.code === "gpu_inventory_datacenters_unavailable" ||
      record.code === "gpu_inventory_gpus_unavailable") && record.retryable === true
  ) return Object.freeze(record as unknown as NativeGpuInventoryIssueV1);
  if (
    (record.code === "gpu_inventory_response_invalid" ||
      record.code === "gpu_inventory_region_unsupported") && record.retryable === false
  ) return Object.freeze(record as unknown as NativeGpuInventoryIssueV1);
  return null;
}

function benchmarkRelationsV1(record: Readonly<Record<string, unknown>>): boolean {
  if (record.benchmarkState === "measured") {
    return safeInteger(record.benchmarkAgeMs) &&
      safeInteger(record.benchmarkMedianDurationUs, 1, 3_600_000_000) &&
      safeInteger(record.benchmarkP95DurationUs, 1, 3_600_000_000) &&
      (record.speedScore === null || safeInteger(record.speedScore, 1, 100)) &&
      canonicalTimestamp(record.benchmarkMeasuredAt) &&
      typeof record.benchmarkEvidenceSha256 === "string" && HASH_V1.test(record.benchmarkEvidenceSha256) &&
      (record.estimatedSwitchRemainingCostMicroUsd === null ||
        (typeof record.estimatedSwitchRemainingCostMicroUsd === "string" &&
          parseCanonicalU128DecimalV1(record.estimatedSwitchRemainingCostMicroUsd) !== null));
  }
  if (record.benchmarkState === "stale") {
    return safeInteger(record.benchmarkAgeMs, BENCHMARK_MAX_AGE_MS_V1) &&
      record.speedScore === null && record.benchmarkMedianDurationUs === null &&
      record.benchmarkP95DurationUs === null && canonicalTimestamp(record.benchmarkMeasuredAt) &&
      typeof record.benchmarkEvidenceSha256 === "string" && HASH_V1.test(record.benchmarkEvidenceSha256) &&
      record.estimatedSwitchRemainingCostMicroUsd === null;
  }
  return record.benchmarkState === "unmeasured" && record.benchmarkAgeMs === null &&
    record.speedScore === null && record.benchmarkMedianDurationUs === null &&
    record.benchmarkP95DurationUs === null && record.benchmarkMeasuredAt === null &&
    record.benchmarkEvidenceSha256 === null && record.estimatedSwitchRemainingCostMicroUsd === null;
}

function parseOfferV1(value: unknown): GpuSelectorOfferV1 | null {
  const record = exactRecord(value, [
    "schemaVersion", "observationId", "receiptId", "gpuId", "policyKey", "displayName",
    "memoryGb", "emergency", "availability", "hourlyPriceMicroUsd", "dataCenterId",
    "source", "observedAt", "stale", "selectable", "disabledReason", "benchmarkState",
    "benchmarkAgeMs", "speedScore", "benchmarkMedianDurationUs", "benchmarkP95DurationUs",
    "benchmarkMeasuredAt", "benchmarkEvidenceSha256", "estimatedSwitchRemainingCostMicroUsd",
  ]);
  const disabledReasons: readonly GpuSelectorDisabledReasonV1[] = [
    "current_gpu", "unapproved_current", "inventory_loading", "inventory_error", "fallback_only",
    "inventory_stale", "unavailable", "price_unavailable", "same_as_current",
  ];
  if (
    record === null || record.schemaVersion !== 1 || !isCanonicalUuidV4(record.observationId) ||
    !(record.receiptId === null || isCanonicalUuidV4(record.receiptId)) ||
    typeof record.gpuId !== "string" || !isGpuIdentityV1(record.gpuId) ||
    typeof record.policyKey !== "string" || !POLICY_KEY_V1.test(record.policyKey) ||
    typeof record.displayName !== "string" || !isGpuIdentityV1(record.displayName) ||
    !safeInteger(record.memoryGb, 1, 1024) || typeof record.emergency !== "boolean" ||
    !(["unknown", "none", "low", "medium", "high"] as const).includes(record.availability as never) ||
    !nullableSafeInteger(record.hourlyPriceMicroUsd) || record.dataCenterId !== "EU-RO-1" ||
    !(["live", "fallback", "current"] as const).includes(record.source as never) ||
    !(record.observedAt === null || canonicalTimestamp(record.observedAt)) ||
    typeof record.stale !== "boolean" || typeof record.selectable !== "boolean" ||
    !(record.disabledReason === null || disabledReasons.includes(record.disabledReason as GpuSelectorDisabledReasonV1)) ||
    !benchmarkRelationsV1(record)
  ) return null;
  return Object.freeze(record as unknown as GpuSelectorOfferV1);
}

function validateOfferRelationsV1(
  offer: GpuSelectorOfferV1,
  snapshot: NativeGpuInventorySnapshotV1,
): boolean {
  if (offer.observationId !== snapshot.observationId) return false;
  const approved = approveCatalogGpu({
    id: offer.gpuId,
    name: offer.displayName,
    manufacturer: "NVIDIA",
    memoryGb: offer.memoryGb,
  }, snapshot.includeEmergencyTier);
  const policyMatches = approved !== null &&
    approved.policyKey === offer.policyKey && approved.emergency === offer.emergency;
  if (offer.source === "current" && offer.disabledReason === "unapproved_current") {
    if (approved !== null) return false;
  } else if (!policyMatches) {
    return false;
  }
  if (snapshot.state === "fallback") {
    return offer.source === "fallback" && offer.receiptId === null && offer.observedAt === null &&
      !offer.stale && offer.availability === "unknown" && offer.hourlyPriceMicroUsd === null &&
      !offer.selectable && offer.disabledReason === "fallback_only" && !offer.emergency;
  }
  if (snapshot.state !== "ready" || snapshot.receipt === null || snapshot.observedAt === null) return false;
  if (
    offer.source === "fallback" || offer.receiptId !== snapshot.receipt.receiptId ||
    offer.observedAt !== snapshot.observedAt || (!snapshot.includeEmergencyTier && offer.emergency)
  ) return false;
  const approvedCurrent = offer.disabledReason !== "unapproved_current";
  const expectedDisabledReason = gpuSelectorDisabledReasonV1({
    source: offer.source,
    approvedCurrent,
    inventoryState: snapshot.state,
    stale: offer.stale,
    availability: offer.availability,
    hourlyPriceMicroUsd: offer.hourlyPriceMicroUsd,
    sameAsCurrent: snapshot.currentPod?.gpuId === offer.gpuId,
  });
  return offer.disabledReason === expectedDisabledReason && offer.selectable === (expectedDisabledReason === null);
}

function validateCurrentOfferRelationsV1(snapshot: NativeGpuInventorySnapshotV1): boolean {
  const currentOffers = snapshot.offers.filter((offer) => offer.source === "current");
  if (currentOffers.length === 0) return true;
  if (snapshot.currentPod === null || snapshot.state !== "ready" || currentOffers.length !== 1) return false;
  const current = currentOffers[0];
  return current !== undefined &&
    current.gpuId === snapshot.currentPod.gpuId &&
    current.displayName === snapshot.currentPod.gpuDisplayName &&
    current.hourlyPriceMicroUsd === snapshot.currentPod.hourlyPriceMicroUsd &&
    (current.disabledReason === "current_gpu" || current.disabledReason === "unapproved_current") &&
    !current.selectable;
}

export function parseNativeGpuInventorySnapshotV1(
  value: unknown,
  expectedProcessEpochId?: string,
): NativeGpuInventorySnapshotV1 | null {
  const record = exactRecord(value, [
    "schemaVersion", "observationId", "processEpochId", "includeEmergencyTier", "state",
    "observedAt", "receipt", "offers", "currentPod", "currentPodObservedAt", "currentPodStale", "issue",
  ]);
  if (
    record === null || record.schemaVersion !== 1 || !isCanonicalUuidV4(record.observationId) ||
    !isCanonicalUuidV4(record.processEpochId) ||
    (expectedProcessEpochId !== undefined && record.processEpochId !== expectedProcessEpochId) ||
    typeof record.includeEmergencyTier !== "boolean" ||
    !(["loading", "ready", "empty", "fallback", "error"] as const).includes(record.state as never) ||
    !(record.observedAt === null || canonicalTimestamp(record.observedAt)) || !Array.isArray(record.offers) ||
    typeof record.currentPodStale !== "boolean" ||
    !(record.currentPodObservedAt === null || canonicalTimestamp(record.currentPodObservedAt))
  ) return null;
  const receipt = record.receipt === null ? null : parseReceiptV1(record.receipt);
  const currentPod = record.currentPod === null ? null : parseCurrentPodV1(record.currentPod);
  const issue = record.issue === null ? null : parseIssueV1(record.issue);
  if (
    (record.receipt !== null && receipt === null) || (record.currentPod !== null && currentPod === null) ||
    (record.issue !== null && issue === null)
  ) return null;
  const offers = record.offers.map(parseOfferV1);
  if (offers.some((offer) => offer === null)) return null;
  const snapshot = Object.freeze({
    ...record,
    receipt,
    currentPod,
    issue,
    offers: Object.freeze(offers as GpuSelectorOfferV1[]),
  }) as unknown as NativeGpuInventorySnapshotV1;
  if (!currentPodRelations(snapshot)) return null;
  if (receipt !== null && (
    receipt.processEpochId !== snapshot.processEpochId || receipt.receivedAt !== snapshot.observedAt
  )) return null;
  const stateRelations = snapshot.state === "loading"
    ? snapshot.offers.length === 0 && snapshot.observedAt === null && receipt === null && issue === null
    : snapshot.state === "ready"
      ? snapshot.offers.length > 0 && snapshot.observedAt !== null && receipt !== null && issue === null
      : snapshot.state === "empty"
        ? snapshot.offers.length === 0 && snapshot.observedAt !== null && receipt !== null && issue === null
        : snapshot.state === "fallback"
          ? snapshot.offers.length > 0 && snapshot.observedAt === null && receipt === null && issue?.retryable === true
          : snapshot.offers.length === 0 && snapshot.observedAt === null && receipt === null && issue !== null;
  if (!stateRelations) return null;
  const uniqueGpuIds = new Set(snapshot.offers.map((offer) => offer.gpuId));
  if (uniqueGpuIds.size !== snapshot.offers.length ||
    snapshot.offers.some((offer) => !validateOfferRelationsV1(offer, snapshot)) ||
    !validateCurrentOfferRelationsV1(snapshot)) return null;
  return snapshot;
}

export function parseNativeGpuInventoryEventV1(
  value: unknown,
  input: { readonly expectedProcessEpochId: string; readonly previousEventSequence: number | null },
): NativeGpuInventoryEventV1 | null {
  const record = exactRecord(value, [
    "schemaVersion", "event", "processEpochId", "observationId", "eventSequence", "superseded", "snapshot",
  ]);
  if (
    record === null || record.schemaVersion !== 1 || record.event !== "gpu-inventory-v1" ||
    record.processEpochId !== input.expectedProcessEpochId || !isCanonicalUuidV4(record.processEpochId) ||
    !isCanonicalUuidV4(record.observationId) || !safeInteger(record.eventSequence, 1) ||
    typeof record.superseded !== "boolean"
  ) return null;
  if (input.previousEventSequence !== null) {
    const expectedSequence = input.previousEventSequence + 1;
    if (!Number.isSafeInteger(expectedSequence) || record.eventSequence !== expectedSequence) return null;
  }
  const snapshot = parseNativeGpuInventorySnapshotV1(record.snapshot, input.expectedProcessEpochId);
  if (
    snapshot === null || snapshot.state === "loading" ||
    snapshot.observationId !== record.observationId || snapshot.processEpochId !== record.processEpochId
  ) return null;
  return Object.freeze({ ...record, snapshot }) as unknown as NativeGpuInventoryEventV1;
}

export function projectGpuInventoryFreshnessV1(
  snapshot: NativeGpuInventorySnapshotV1,
  currentProcessEpochId: string,
  receiptAgeMs: number,
): NativeGpuInventorySnapshotV1 {
  const expired = snapshot.processEpochId !== currentProcessEpochId ||
    !Number.isSafeInteger(receiptAgeMs) || receiptAgeMs < 0 || receiptAgeMs >= 60_000;
  if (!expired || snapshot.state !== "ready") return snapshot;
  const offers = snapshot.offers.map((offer) => {
    if (offer.source === "current") return offer;
    const disabledReason = gpuSelectorDisabledReasonV1({
      source: offer.source,
      approvedCurrent: true,
      inventoryState: snapshot.state,
      stale: true,
      availability: offer.availability,
      hourlyPriceMicroUsd: offer.hourlyPriceMicroUsd,
      sameAsCurrent: snapshot.currentPod?.gpuId === offer.gpuId,
    });
    return Object.freeze({ ...offer, stale: true, selectable: false, disabledReason });
  });
  return Object.freeze({ ...snapshot, offers: Object.freeze(offers) });
}

export class GpuInventoryObservationErrorV1 extends Error {
  constructor(readonly issue: NativeGpuInventoryIssueV1) {
    super(issue.code);
    this.name = "GpuInventoryObservationErrorV1";
  }
}

export interface GpuInventoryObservationSourceV1 {
  /** One call represents the exact co-started datacenter+GPU two-GET read. */
  observe(input: {
    readonly observationId: string;
    readonly includeEmergencyTier: boolean;
  }): Promise<{
    readonly observedAt: string;
    readonly catalogSha256: string;
    readonly offers: readonly GpuSelectorLiveOfferInputV1[];
  }>;
}

export interface GpuInventoryCoordinatorOptionsV1 {
  readonly processEpochId: string;
  readonly source: GpuInventoryObservationSourceV1;
  readonly idFactory: () => string;
  /** Native uses std::time::Instant; performance.now is the browser test analogue. */
  readonly monotonicNowMs?: () => number;
  readonly currentPod: () => {
    readonly pod: NativeGpuSwitchPodV1 | null;
    readonly observedAt: string | null;
    readonly stale: boolean;
  };
}

function fallbackOffers(observationId: string): readonly GpuSelectorOfferV1[] {
  return Object.freeze(staticGpuPolicy(false).map((entry) => Object.freeze({
    schemaVersion: 1 as const,
    observationId,
    receiptId: null,
    gpuId: entry.gpuId,
    policyKey: entry.key,
    displayName: entry.catalogNames[0] ?? entry.gpuId,
    memoryGb: entry.expectedMemoryGb,
    emergency: false,
    availability: "unknown" as const,
    hourlyPriceMicroUsd: null,
    dataCenterId: "EU-RO-1" as const,
    source: "fallback" as const,
    observedAt: null,
    stale: false,
    selectable: false,
    disabledReason: "fallback_only" as const,
    benchmarkState: "unmeasured" as const,
    benchmarkAgeMs: null,
    speedScore: null,
    benchmarkMedianDurationUs: null,
    benchmarkP95DurationUs: null,
    benchmarkMeasuredAt: null,
    benchmarkEvidenceSha256: null,
    estimatedSwitchRemainingCostMicroUsd: null,
  })));
}

export class GpuInventoryRefreshCoordinatorV1 {
  readonly #options: GpuInventoryCoordinatorOptionsV1;
  readonly #listeners = new Set<(event: NativeGpuInventoryEventV1) => void>();
  readonly #settled = new Map<string, Promise<NativeGpuInventoryEventV1>>();
  readonly #receiptReceivedAtMs = new Map<string, number>();
  readonly #monotonicNowMs: () => number;
  #current: NativeGpuInventorySnapshotV1;
  #loading: { readonly observationId: string; readonly includeEmergencyTier: boolean } | null = null;
  #eventSequence = 0;

  constructor(options: GpuInventoryCoordinatorOptionsV1) {
    if (!UUID_V4.test(options.processEpochId)) throw new TypeError("Invalid process epoch ID.");
    this.#options = options;
    this.#monotonicNowMs = options.monotonicNowMs ?? (() => performance.now());
    this.#current = this.#loadingSnapshot(options.idFactory(), false);
  }

  load(): NativeGpuInventorySnapshotV1 {
    const receiptId = this.#current.receipt?.receiptId;
    const receivedAtMs = receiptId === undefined ? undefined : this.#receiptReceivedAtMs.get(receiptId);
    if (receiptId !== undefined && receivedAtMs !== undefined) {
      const ageMs = this.#monotonicNowMs() - receivedAtMs;
      this.#current = projectGpuInventoryFreshnessV1(
        this.#current,
        this.#options.processEpochId,
        ageMs,
      );
    }
    return this.#current;
  }

  subscribe(listener: (event: NativeGpuInventoryEventV1) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  beginRefresh(includeEmergencyTier: boolean): NativeGpuInventorySnapshotV1 {
    if (this.#loading?.includeEmergencyTier === includeEmergencyTier) return this.#current;
    const observationId = this.#options.idFactory();
    if (!UUID_V4.test(observationId)) throw new TypeError("Invalid observation ID.");
    const loading = this.#loadingSnapshot(observationId, includeEmergencyTier);
    this.#loading = Object.freeze({ observationId, includeEmergencyTier });
    this.#current = loading;
    const promise = this.#finish(observationId, includeEmergencyTier);
    this.#settled.set(observationId, promise);
    return loading;
  }

  settled(observationId: string): Promise<NativeGpuInventoryEventV1> {
    const pending = this.#settled.get(observationId);
    if (pending === undefined) return Promise.reject(new TypeError("Unknown observation ID."));
    return pending;
  }

  #loadingSnapshot(observationId: string, includeEmergencyTier: boolean): NativeGpuInventorySnapshotV1 {
    const current = this.#options.currentPod();
    return Object.freeze({
      schemaVersion: 1,
      observationId,
      processEpochId: this.#options.processEpochId,
      includeEmergencyTier,
      state: "loading",
      observedAt: null,
      receipt: null,
      offers: Object.freeze([]),
      currentPod: current.pod,
      currentPodObservedAt: current.observedAt,
      currentPodStale: current.stale,
      issue: null,
    });
  }

  async #finish(observationId: string, includeEmergencyTier: boolean): Promise<NativeGpuInventoryEventV1> {
    let snapshot: NativeGpuInventorySnapshotV1;
    const current = this.#options.currentPod();
    try {
      const observed = await this.#options.source.observe({ observationId, includeEmergencyTier });
      if (!canonicalTimestamp(observed.observedAt) || !HASH_V1.test(observed.catalogSha256)) {
        throw new GpuInventoryObservationErrorV1({ code: "gpu_inventory_response_invalid", retryable: false });
      }
      const receiptId = this.#options.idFactory();
      if (!UUID_V4.test(receiptId)) throw new TypeError("Invalid receipt ID.");
      const receipt = Object.freeze({
        schemaVersion: 1 as const,
        receiptId,
        processEpochId: this.#options.processEpochId,
        receivedAt: observed.observedAt,
        validForMs: 60000 as const,
        catalogSha256: observed.catalogSha256,
      });
      this.#receiptReceivedAtMs.set(receiptId, this.#monotonicNowMs());
      const offers = projectLiveGpuSelectorOffersV1({
        observationId,
        receiptId,
        observedAt: observed.observedAt,
        currentGpuId: current.pod?.gpuId ?? null,
        offers: observed.offers.filter((offer) => includeEmergencyTier || !offer.emergency),
      });
      snapshot = Object.freeze({
        schemaVersion: 1,
        observationId,
        processEpochId: this.#options.processEpochId,
        includeEmergencyTier,
        state: offers.length === 0 ? "empty" : "ready",
        observedAt: observed.observedAt,
        receipt,
        offers,
        currentPod: current.pod,
        currentPodObservedAt: current.observedAt,
        currentPodStale: current.stale,
        issue: null,
      });
    } catch (error) {
      const issue: NativeGpuInventoryIssueV1 = error instanceof GpuInventoryObservationErrorV1
        ? error.issue
        : { code: "gpu_inventory_response_invalid", retryable: false };
      const fallback = issue.retryable;
      snapshot = Object.freeze({
        schemaVersion: 1,
        observationId,
        processEpochId: this.#options.processEpochId,
        includeEmergencyTier,
        state: fallback ? "fallback" : "error",
        observedAt: null,
        receipt: null,
        offers: fallback ? fallbackOffers(observationId) : Object.freeze([]),
        currentPod: current.pod,
        currentPodObservedAt: current.observedAt,
        currentPodStale: current.stale,
        issue,
      });
    }
    const superseded = this.#loading?.observationId !== observationId;
    if (this.#eventSequence === Number.MAX_SAFE_INTEGER) throw new RangeError("Inventory event revision exhausted.");
    this.#eventSequence += 1;
    const event = Object.freeze({
      schemaVersion: 1 as const,
      event: "gpu-inventory-v1" as const,
      processEpochId: this.#options.processEpochId,
      observationId,
      eventSequence: this.#eventSequence,
      superseded,
      snapshot,
    });
    if (!superseded) {
      this.#current = snapshot;
      this.#loading = null;
    }
    this.#listeners.forEach((listener) => listener(event));
    return event;
  }
}

export function isCanonicalUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

export function validateInventorySnapshotRelationsV1(
  snapshot: NativeGpuInventorySnapshotV1,
  expectedProcessEpochId = snapshot.processEpochId,
): boolean {
  return parseNativeGpuInventorySnapshotV1(snapshot, expectedProcessEpochId) !== null;
}
