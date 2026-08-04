import { describe, expect, it } from 'vitest';
import type {
  GpuSelectorOfferV1,
  NativeGpuInventorySnapshotV1,
  NativeGpuSwitchPodV1,
} from '@imageforge/runpod-client';
import {
  buildGpuSelectorRowsV1,
  INITIAL_GPU_SELECTOR_UI_STATE_V1,
  moveGpuSelectorFocusV1,
  reconcileGpuSelectorUiV1,
  requestGpuSelectorConfirmationV1,
  selectGpuChoiceV1,
} from './gpuSelector';

const OBSERVATION_ID = '11111111-1111-4111-8111-111111111111';
const RECEIPT_ID = '22222222-2222-4222-8222-222222222222';
const EPOCH_ID = '33333333-3333-4333-8333-333333333333';
const OBSERVED_AT = '2026-08-04T00:00:00.000Z';

function offer(overrides: Partial<GpuSelectorOfferV1> = {}): GpuSelectorOfferV1 {
  return {
    schemaVersion: 1,
    observationId: OBSERVATION_ID,
    receiptId: RECEIPT_ID,
    gpuId: 'NVIDIA GeForce RTX 4090',
    policyKey: 'rtx_4090',
    displayName: 'RTX 4090',
    memoryGb: 24,
    emergency: false,
    availability: 'high',
    hourlyPriceMicroUsd: 500_000,
    dataCenterId: 'EU-RO-1',
    source: 'live',
    observedAt: OBSERVED_AT,
    stale: false,
    selectable: true,
    disabledReason: null,
    benchmarkState: 'unmeasured',
    benchmarkAgeMs: null,
    speedScore: null,
    benchmarkMedianDurationUs: null,
    benchmarkP95DurationUs: null,
    benchmarkMeasuredAt: null,
    benchmarkEvidenceSha256: null,
    estimatedSwitchRemainingCostMicroUsd: null,
    ...overrides,
  };
}

function snapshot(input: {
  offers?: readonly GpuSelectorOfferV1[];
  currentPod?: NativeGpuSwitchPodV1 | null;
  includeEmergencyTier?: boolean;
  state?: NativeGpuInventorySnapshotV1['state'];
  currentPodStale?: boolean;
  observationId?: string;
  receiptId?: string;
} = {}): NativeGpuInventorySnapshotV1 {
  const state = input.state ?? 'ready';
  const currentPod = input.currentPod ?? null;
  const terminalInventory = state === 'ready' || state === 'empty';
  const observationId = input.observationId ?? OBSERVATION_ID;
  const receiptId = input.receiptId ?? RECEIPT_ID;
  return {
    schemaVersion: 1,
    observationId,
    processEpochId: EPOCH_ID,
    includeEmergencyTier: input.includeEmergencyTier ?? false,
    state,
    observedAt: terminalInventory ? OBSERVED_AT : null,
    receipt: terminalInventory ? {
      schemaVersion: 1,
      receiptId,
      processEpochId: EPOCH_ID,
      receivedAt: OBSERVED_AT,
      validForMs: 60000,
      catalogSha256: 'a'.repeat(64),
    } : null,
    offers: input.offers ?? (state === 'ready' ? [offer()] : []),
    currentPod,
    currentPodObservedAt: currentPod === null ? null : OBSERVED_AT,
    currentPodStale: currentPod === null ? false : input.currentPodStale ?? false,
    issue: state === 'fallback'
      ? { code: 'gpu_inventory_gpus_unavailable', retryable: true }
      : state === 'error'
        ? { code: 'gpu_inventory_response_invalid', retryable: false }
        : null,
  };
}

describe('GPU selector domain', () => {
  it('builds only Auto plus exact live rows offline and pins current without Auto during switch', () => {
    const offline = buildGpuSelectorRowsV1(snapshot(), 'offline_start');
    expect(offline.map((row) => row.rowId)).toEqual(['auto', 'ordinary:rtx-4090']);

    const currentPod: NativeGpuSwitchPodV1 = {
      podId: 'pod-current-1',
      gpuId: 'NVIDIA GeForce RTX 4090',
      gpuDisplayName: 'RTX 4090',
      hourlyPriceMicroUsd: 500_000,
    };
    const target = offer({
      gpuId: 'NVIDIA GeForce RTX 5090',
      policyKey: 'rtx_5090',
      displayName: 'RTX 5090',
      memoryGb: 32,
    });
    const switching = buildGpuSelectorRowsV1(snapshot({ offers: [target], currentPod }), 'switch');
    expect(switching.map((row) => row.rowId)).toEqual(['current', 'ordinary:rtx-5090']);
    expect(switching[0]?.selectable).toBe(false);
  });

  it('pins an unapproved current Pod as Stop-only instead of presenting it as a valid target', () => {
    const currentPod: NativeGpuSwitchPodV1 = {
      podId: 'pod-legacy-1',
      gpuId: 'Legacy GPU ID',
      gpuDisplayName: 'Legacy GPU',
      hourlyPriceMicroUsd: 500_000,
    };
    const rows = buildGpuSelectorRowsV1(snapshot({ currentPod }), 'switch');
    expect(rows[0]).toMatchObject({
      rowId: 'current',
      selectable: false,
      disabledReason: 'unapproved_current',
    });
  });

  it('proves a dynamic current GPU only from its fresh live policy row', () => {
    const currentPod: NativeGpuSwitchPodV1 = {
      podId: 'pod-dynamic-1',
      gpuId: 'catalog-pro-4500',
      gpuDisplayName: 'RTX PRO 4500 Blackwell',
      hourlyPriceMicroUsd: 600_000,
    };
    const matchingLive = offer({
      gpuId: currentPod.gpuId,
      policyKey: 'rtx_pro_4500_blackwell',
      displayName: currentPod.gpuDisplayName,
      memoryGb: 32,
      hourlyPriceMicroUsd: currentPod.hourlyPriceMicroUsd,
      selectable: false,
      disabledReason: 'same_as_current',
    });
    const rows = buildGpuSelectorRowsV1(snapshot({ offers: [matchingLive, offer()], currentPod }), 'switch');
    expect(rows[0]).toMatchObject({ rowId: 'current', disabledReason: 'current_gpu' });
    expect(rows.some((row) => row.gpuId === currentPod.gpuId && row.rowId !== 'current')).toBe(false);
  });

  it('retains a stale static current Pod through loading, fallback, and error without trusting fallback rows', () => {
    const currentPod: NativeGpuSwitchPodV1 = {
      podId: 'pod-current-1',
      gpuId: 'NVIDIA GeForce RTX 4090',
      gpuDisplayName: 'RTX 4090',
      hourlyPriceMicroUsd: 500_000,
    };
    const fallback = offer({
      receiptId: null,
      source: 'fallback',
      observedAt: null,
      availability: 'unknown',
      hourlyPriceMicroUsd: null,
      selectable: false,
      disabledReason: 'fallback_only',
    });
    const fallbackRows = buildGpuSelectorRowsV1(snapshot({
      state: 'fallback',
      offers: [fallback],
      currentPod,
      currentPodStale: true,
    }), 'switch');
    const errorRows = buildGpuSelectorRowsV1(snapshot({
      state: 'error',
      currentPod,
      currentPodStale: true,
    }), 'switch');
    const loadingRows = buildGpuSelectorRowsV1(snapshot({
      state: 'loading',
      currentPod,
      currentPodStale: true,
    }), 'switch');
    expect(loadingRows[0]).toMatchObject({ rowId: 'current', disabledReason: 'current_gpu' });
    expect(fallbackRows[0]).toMatchObject({ rowId: 'current', disabledReason: 'current_gpu' });
    expect(errorRows[0]).toMatchObject({ rowId: 'current', disabledReason: 'current_gpu' });
  });

  it('preserves exact selection, clears a lost target once, and keeps focus on the nearest stable row', () => {
    const firstRows = buildGpuSelectorRowsV1(snapshot({ offers: [
      offer(),
      offer({ gpuId: 'NVIDIA GeForce RTX 5090', policyKey: 'rtx_5090', displayName: 'RTX 5090', memoryGb: 32 }),
    ] }), 'offline_start');
    let state = selectGpuChoiceV1(INITIAL_GPU_SELECTOR_UI_STATE_V1, firstRows, 'NVIDIA GeForce RTX 5090');
    state = reconcileGpuSelectorUiV1({ state, previousRows: [], nextRows: firstRows, snapshot: snapshot() });
    expect(state.selectedChoice).toBe('NVIDIA GeForce RTX 5090');

    const nextSnapshot = snapshot({ offers: [offer()] });
    const nextRows = buildGpuSelectorRowsV1(nextSnapshot, 'offline_start');
    const lost = reconcileGpuSelectorUiV1({ state, previousRows: firstRows, nextRows, snapshot: nextSnapshot });
    expect(lost.selectedChoice).toBeNull();
    expect(lost.focusedChoice).toBe('NVIDIA GeForce RTX 4090');
    expect(lost.announcement).toMatch(/no longer available/i);
    const deduped = reconcileGpuSelectorUiV1({ state: lost, previousRows: nextRows, nextRows, snapshot: nextSnapshot });
    expect(deduped.announcement).toBe('');
  });

  it('retains the same selected GPU but invalidates confirmation after a one-micro-USD refresh', () => {
    const initialSnapshot = snapshot();
    const initialRows = buildGpuSelectorRowsV1(initialSnapshot, 'offline_start');
    let state = selectGpuChoiceV1(
      INITIAL_GPU_SELECTOR_UI_STATE_V1,
      initialRows,
      'NVIDIA GeForce RTX 4090',
    );
    state = requestGpuSelectorConfirmationV1({
      state,
      rows: initialRows,
      snapshot: initialSnapshot,
      mode: 'offline_start',
    });
    expect(state.confirmation?.kind).toBe('manual_start');

    const nextObservationId = '44444444-4444-4444-8444-444444444444';
    const nextReceiptId = '55555555-5555-4555-8555-555555555555';
    const nextSnapshot = snapshot({
      observationId: nextObservationId,
      receiptId: nextReceiptId,
      offers: [offer({
        observationId: nextObservationId,
        receiptId: nextReceiptId,
        hourlyPriceMicroUsd: 500_001,
      })],
    });
    const nextRows = buildGpuSelectorRowsV1(nextSnapshot, 'offline_start');
    const reconciled = reconcileGpuSelectorUiV1({
      state,
      previousRows: initialRows,
      nextRows,
      snapshot: nextSnapshot,
    });
    expect(reconciled.selectedChoice).toBe('NVIDIA GeForce RTX 4090');
    expect(reconciled.confirmation).toBeNull();
    expect(reconciled.announcement).toMatch(/price changed/i);
  });

  it('wraps keyboard focus, toggles Space-style selection, and produces no mutation until confirmation', () => {
    const currentSnapshot = snapshot();
    const rows = buildGpuSelectorRowsV1(currentSnapshot, 'offline_start');
    let state = reconcileGpuSelectorUiV1({
      state: INITIAL_GPU_SELECTOR_UI_STATE_V1,
      previousRows: [],
      nextRows: rows,
      snapshot: currentSnapshot,
    });
    state = moveGpuSelectorFocusV1(state, rows, -1);
    expect(state.focusedChoice).toBe('NVIDIA GeForce RTX 4090');
    state = selectGpuChoiceV1(state, rows, state.focusedChoice!);
    expect(state.selectedChoice).toBe('NVIDIA GeForce RTX 4090');
    expect(state.confirmation).toBeNull();
    state = requestGpuSelectorConfirmationV1({ state, rows, snapshot: currentSnapshot, mode: 'offline_start' });
    expect(state.confirmation?.kind).toBe('manual_start');
  });

  it('fails closed instead of mounting more than 20 GPU rows', () => {
    const offers = Array.from({ length: 21 }, (_, index) => offer({
      gpuId: `GPU:${String(index).padStart(2, '0')}`,
      policyKey: `policy_${index}`,
      displayName: `GPU ${index}`,
    }));
    expect(() => buildGpuSelectorRowsV1(snapshot({ offers }), 'switch')).toThrow(/20-row/);
  });
});
