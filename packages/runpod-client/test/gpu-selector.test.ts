import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GpuInventoryObservationErrorV1,
  GpuInventoryRefreshCoordinatorV1,
  parseNativeGpuInventoryEventV1,
  parseNativeGpuInventorySnapshotV1,
  projectAutoGpuSelectionV1,
  projectManualGpuSelectionV1,
  type GpuInventoryObservationSourceV1,
  type GpuSelectorLiveOfferInputV1,
} from "../src/index.js";

const EPOCH = "10000000-0000-4000-8000-000000000000";
const OTHER_EPOCH = "20000000-0000-4000-8000-000000000000";

function ids(): () => string {
  let next = 1;
  return () => `${String(next++).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

function liveOffer(overrides: Partial<GpuSelectorLiveOfferInputV1> = {}): GpuSelectorLiveOfferInputV1 {
  return Object.freeze({
    gpuId: "NVIDIA GeForce RTX 4090",
    policyKey: "rtx_4090",
    displayName: "RTX 4090",
    memoryGb: 24,
    emergency: false,
    availability: "high",
    hourlyPriceMicroUsd: 500_000,
    benchmarkState: "unmeasured",
    benchmarkAgeMs: null,
    benchmarkMedianDurationUs: null,
    benchmarkP95DurationUs: null,
    benchmarkMeasuredAt: null,
    benchmarkEvidenceSha256: null,
    bootDurationMs: null,
    remainingImages: 450,
    ...overrides,
  });
}

function source(offers: readonly GpuSelectorLiveOfferInputV1[] = [liveOffer()]): GpuInventoryObservationSourceV1 {
  return {
    async observe() {
      return Object.freeze({
        observedAt: "2026-08-04T00:00:00.000Z",
        catalogSha256: "a".repeat(64),
        offers,
      });
    },
  };
}

describe("strict GPU selector snapshots and receipts", () => {
  it("accepts one exact receipt-bound snapshot and rejects nested drift or forged disabled state", async () => {
    const coordinator = new GpuInventoryRefreshCoordinatorV1({
      processEpochId: EPOCH,
      source: source(),
      idFactory: ids(),
      currentPod: () => ({ pod: null, observedAt: null, stale: false }),
    });
    const loading = coordinator.beginRefresh(false);
    const event = await coordinator.settled(loading.observationId);
    const snapshot = event.snapshot;
    assert.notEqual(parseNativeGpuInventorySnapshotV1(snapshot, EPOCH), null);
    assert.notEqual(parseNativeGpuInventoryEventV1(event, {
      expectedProcessEpochId: EPOCH,
      previousEventSequence: null,
    }), null);
    assert.notEqual(parseNativeGpuInventoryEventV1({ ...event, eventSequence: 7 }, {
      expectedProcessEpochId: EPOCH,
      previousEventSequence: null,
    }), null);
    assert.notEqual(parseNativeGpuInventoryEventV1({ ...event, eventSequence: 8 }, {
      expectedProcessEpochId: EPOCH,
      previousEventSequence: 7,
    }), null);
    assert.equal(parseNativeGpuInventoryEventV1({ ...event, eventSequence: 9 }, {
      expectedProcessEpochId: EPOCH,
      previousEventSequence: 7,
    }), null);
    assert.notEqual(projectManualGpuSelectionV1(snapshot, snapshot.offers[0]?.gpuId ?? "", EPOCH), null);
    assert.deepEqual(projectAutoGpuSelectionV1(snapshot, EPOCH)?.orderedGpuIds, [
      "NVIDIA GeForce RTX 4090",
    ]);

    const nestedExtra = {
      ...snapshot,
      offers: [{ ...snapshot.offers[0], rendererTrusted: true }],
    };
    assert.equal(parseNativeGpuInventorySnapshotV1(nestedExtra, EPOCH), null);
    const forgedReason = {
      ...snapshot,
      offers: [{ ...snapshot.offers[0], selectable: false, disabledReason: "inventory_error" }],
    };
    assert.equal(parseNativeGpuInventorySnapshotV1(forgedReason, EPOCH), null);
    const forgedB200 = {
      ...snapshot,
      offers: [{
        ...snapshot.offers[0],
        gpuId: "NVIDIA B200",
        displayName: "B200",
        memoryGb: 180,
        policyKey: "rtx_4090",
      }],
    };
    assert.equal(parseNativeGpuInventorySnapshotV1(forgedB200, EPOCH), null);
    const forgedDynamicPolicy = {
      ...snapshot,
      offers: [{
        ...snapshot.offers[0],
        gpuId: "catalog-pro-4500-forged",
        displayName: "RTX PRO 4500 Blackwell",
        memoryGb: 32,
        policyKey: "rtx_4090",
      }],
    };
    assert.equal(parseNativeGpuInventorySnapshotV1(forgedDynamicPolicy, EPOCH), null);
    assert.equal(parseNativeGpuInventoryEventV1({
      ...event,
      observationId: "99999999-0000-4000-8000-000000000000",
    }, { expectedProcessEpochId: EPOCH, previousEventSequence: null }), null);
    assert.equal(parseNativeGpuInventoryEventV1(event, {
      expectedProcessEpochId: EPOCH,
      previousEventSequence: 1,
    }), null);

    const unapprovedCurrentPod = {
      podId: "legacy-pod-1",
      gpuId: "Legacy GPU ID",
      gpuDisplayName: "Legacy GPU",
      hourlyPriceMicroUsd: 500_000,
    };
    const unapprovedCurrent = {
      ...snapshot,
      offers: [{
        ...snapshot.offers[0],
        gpuId: unapprovedCurrentPod.gpuId,
        policyKey: "unapproved_current",
        displayName: unapprovedCurrentPod.gpuDisplayName,
        memoryGb: 1,
        availability: "unknown",
        hourlyPriceMicroUsd: unapprovedCurrentPod.hourlyPriceMicroUsd,
        source: "current",
        selectable: false,
        disabledReason: "unapproved_current",
      }, ...snapshot.offers],
      currentPod: unapprovedCurrentPod,
      currentPodObservedAt: "2026-08-04T00:00:00.000Z",
      currentPodStale: false,
    };
    assert.notEqual(parseNativeGpuInventorySnapshotV1(unapprovedCurrent, EPOCH), null);
    assert.equal(parseNativeGpuInventorySnapshotV1({
      ...unapprovedCurrent,
      currentPod: { ...unapprovedCurrent.currentPod, approvedTarget: false },
    }, EPOCH), null);
    assert.equal(parseNativeGpuInventorySnapshotV1({
      ...unapprovedCurrent,
      offers: unapprovedCurrent.offers.map((offer) =>
        offer.source === "current" ? { ...offer, gpuId: "Different GPU ID" } : offer),
    }, EPOCH), null);
  });

  it("enforces the exact 1-58 ASCII alphanumeric/hyphen Pod ID grammar", async () => {
    const coordinator = new GpuInventoryRefreshCoordinatorV1({
      processEpochId: EPOCH,
      source: source(),
      idFactory: ids(),
      currentPod: () => ({ pod: null, observedAt: null, stale: false }),
    });
    const loading = coordinator.beginRefresh(false);
    const base = (await coordinator.settled(loading.observationId)).snapshot;
    const withPodId = (podId: string) => ({
      ...base,
      currentPod: {
        podId,
        gpuId: "Legacy GPU ID",
        gpuDisplayName: "Legacy GPU",
        hourlyPriceMicroUsd: 500_000,
      },
      currentPodObservedAt: "2026-08-04T00:00:00.000Z",
      currentPodStale: false,
    });
    for (const accepted of ["A", `A${"b".repeat(56)}Z`]) {
      assert.notEqual(parseNativeGpuInventorySnapshotV1(withPodId(accepted), EPOCH), null, accepted);
    }
    for (const rejected of ["", "-pod", "pod-", "pod_id", "pod.id", `A${"b".repeat(57)}Z`]) {
      assert.equal(parseNativeGpuInventorySnapshotV1(withPodId(rejected), EPOCH), null, rejected);
    }
  });

  it("produces a strict receipt-bound snapshot when a static current Pod is present", async () => {
    const coordinator = new GpuInventoryRefreshCoordinatorV1({
      processEpochId: EPOCH,
      source: source([
        liveOffer(),
        liveOffer({
          gpuId: "NVIDIA GeForce RTX 5090",
          policyKey: "rtx_5090",
          displayName: "RTX 5090",
          memoryGb: 32,
        }),
      ]),
      idFactory: ids(),
      currentPod: () => ({
        pod: {
          podId: "pod-current-1",
          gpuId: "NVIDIA GeForce RTX 4090",
          gpuDisplayName: "RTX 4090",
          hourlyPriceMicroUsd: 500_000,
        },
        observedAt: "2026-08-04T00:00:00.000Z",
        stale: false,
      }),
    });
    const loading = coordinator.beginRefresh(false);
    const snapshot = (await coordinator.settled(loading.observationId)).snapshot;
    assert.notEqual(parseNativeGpuInventorySnapshotV1(snapshot, EPOCH), null);
    assert.equal(snapshot.currentPod?.gpuId, "NVIDIA GeForce RTX 4090");
    assert.equal(snapshot.offers.find((offer) => offer.gpuId === snapshot.currentPod?.gpuId)?.disabledReason,
      "same_as_current");
  });

  it("keeps a dynamic current Pod strict only alongside its fresh catalog identity", async () => {
    const coordinator = new GpuInventoryRefreshCoordinatorV1({
      processEpochId: EPOCH,
      source: source([liveOffer({
        gpuId: "catalog-pro-4500",
        policyKey: "rtx_pro_4500_blackwell",
        displayName: "RTX PRO 4500 Blackwell",
        memoryGb: 32,
      })]),
      idFactory: ids(),
      currentPod: () => ({
        pod: {
          podId: "pod-dynamic-1",
          gpuId: "catalog-pro-4500",
          gpuDisplayName: "RTX PRO 4500 Blackwell",
          hourlyPriceMicroUsd: 500_000,
        },
        observedAt: "2026-08-04T00:00:00.000Z",
        stale: false,
      }),
    });
    const loading = coordinator.beginRefresh(false);
    const snapshot = (await coordinator.settled(loading.observationId)).snapshot;
    assert.notEqual(parseNativeGpuInventorySnapshotV1(snapshot, EPOCH), null);
    assert.equal(snapshot.offers[0]?.policyKey, "rtx_pro_4500_blackwell");
    assert.equal(snapshot.offers[0]?.disabledReason, "same_as_current");
  });

  it("expires selection at exactly 60,000 monotonic ms and rejects a prior process epoch", async () => {
    let nowMs = 0;
    const coordinator = new GpuInventoryRefreshCoordinatorV1({
      processEpochId: EPOCH,
      source: source(),
      idFactory: ids(),
      monotonicNowMs: () => nowMs,
      currentPod: () => ({ pod: null, observedAt: null, stale: false }),
    });
    const loading = coordinator.beginRefresh(false);
    await coordinator.settled(loading.observationId);

    nowMs = 59_999;
    const fresh = coordinator.load();
    assert.equal(fresh.offers[0]?.stale, false);
    assert.notEqual(projectManualGpuSelectionV1(fresh, fresh.offers[0]?.gpuId ?? "", EPOCH), null);
    assert.equal(projectManualGpuSelectionV1(fresh, fresh.offers[0]?.gpuId ?? "", OTHER_EPOCH), null);

    nowMs = 60_000;
    const expired = coordinator.load();
    assert.equal(expired.offers[0]?.stale, true);
    assert.equal(expired.offers[0]?.disabledReason, "inventory_stale");
    assert.equal(projectManualGpuSelectionV1(expired, expired.offers[0]?.gpuId ?? "", EPOCH), null);
    assert.equal(projectAutoGpuSelectionV1(expired, EPOCH), null);
  });

  it("coalesces the same emergency flag and emits superseded terminal events in completion order", async () => {
    const resolvers = new Map<boolean, (value: Awaited<ReturnType<GpuInventoryObservationSourceV1["observe"]>>) => void>();
    let calls = 0;
    const deferredSource: GpuInventoryObservationSourceV1 = {
      observe(input) {
        calls += 1;
        return new Promise((resolve) => resolvers.set(input.includeEmergencyTier, resolve));
      },
    };
    const coordinator = new GpuInventoryRefreshCoordinatorV1({
      processEpochId: EPOCH,
      source: deferredSource,
      idFactory: ids(),
      currentPod: () => ({ pod: null, observedAt: null, stale: false }),
    });
    const first = coordinator.beginRefresh(false);
    const coalesced = coordinator.beginRefresh(false);
    const newer = coordinator.beginRefresh(true);
    assert.equal(coalesced.observationId, first.observationId);
    assert.notEqual(newer.observationId, first.observationId);
    assert.equal(calls, 2);

    resolvers.get(true)?.({
      observedAt: "2026-08-04T00:00:01.000Z",
      catalogSha256: "b".repeat(64),
      offers: [liveOffer()],
    });
    const newerEvent = await coordinator.settled(newer.observationId);
    resolvers.get(false)?.({
      observedAt: "2026-08-04T00:00:00.000Z",
      catalogSha256: "a".repeat(64),
      offers: [liveOffer()],
    });
    const olderEvent = await coordinator.settled(first.observationId);
    assert.equal(newerEvent.eventSequence, 1);
    assert.equal(newerEvent.superseded, false);
    assert.equal(olderEvent.eventSequence, 2);
    assert.equal(olderEvent.superseded, true);
    assert.equal(coordinator.load().observationId, newer.observationId);
  });

  it("renders retryable transport failure as receipt-free fallback with zero mutation projection", async () => {
    const coordinator = new GpuInventoryRefreshCoordinatorV1({
      processEpochId: EPOCH,
      source: {
        async observe() {
          throw new GpuInventoryObservationErrorV1({
            code: "gpu_inventory_gpus_unavailable",
            retryable: true,
          });
        },
      },
      idFactory: ids(),
      currentPod: () => ({ pod: null, observedAt: null, stale: false }),
    });
    const loading = coordinator.beginRefresh(false);
    const fallback = (await coordinator.settled(loading.observationId)).snapshot;
    assert.equal(fallback.state, "fallback");
    assert.equal(fallback.receipt, null);
    assert.ok(fallback.offers.every((offer) => offer.observedAt === null && !offer.selectable));
    assert.equal(projectAutoGpuSelectionV1(fallback, EPOCH), null);
    assert.notEqual(parseNativeGpuInventorySnapshotV1(fallback, EPOCH), null);
  });
});
