import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  GpuSelectorOfferV1,
  NativeGpuInventorySnapshotV1,
  NativeGpuSwitchPodV1,
} from '@imageforge/runpod-client';
import perfFixture from '../../contracts/gpu-selector-perf-10-v1.json';
import { GpuSelector } from './GpuSelector';

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

function renderSelector(
  value: NativeGpuInventorySnapshotV1,
  mode: 'offline_start' | 'switch' = 'offline_start',
) {
  const onCommit = vi.fn();
  const onClose = vi.fn();
  const onRefresh = vi.fn();
  const view = render(
    <div className="app-shell">
      <GpuSelector
        snapshot={value}
        mode={mode}
        onCommit={onCommit}
        onClose={onClose}
        onRefresh={onRefresh}
        nowUtcMs={Date.parse(OBSERVED_AT) + 4_000}
      />
    </div>,
  );
  return {
    onCommit,
    onClose,
    onRefresh,
    rerenderSelector(next: NativeGpuInventorySnapshotV1) {
      view.rerender(
        <div className="app-shell">
          <GpuSelector
            snapshot={next}
            mode={mode}
            onCommit={onCommit}
            onClose={onClose}
            onRefresh={onRefresh}
            nowUtcMs={Date.parse(OBSERVED_AT) + 4_000}
          />
        </div>,
      );
    },
  };
}

describe('GpuSelector', () => {
  it('requires selection and a non-destructive modal confirmation before emitting manual Start', async () => {
    const target = offer();
    const { onCommit } = renderSelector(snapshot({ offers: [target] }));
    const row = screen.getByRole('radio', { name: /RTX 4090/i });
    fireEvent.click(row);
    const review = screen.getByRole('button', { name: 'Start selected GPU at $0.5/hr' });
    fireEvent.click(review);

    expect(screen.getByRole('dialog', { name: 'Start RTX 4090?' })).toBeVisible();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(cancel).toHaveFocus());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Start RTX 4090?' })).not.toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();
    await waitFor(() => expect(row).toHaveFocus());

    fireEvent.click(review);
    fireEvent.click(screen.getByRole('button', { name: 'Start RTX 4090' }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0]).toMatchObject({
      kind: 'manual_start',
      projection: { targetGpuId: 'NVIDIA GeForce RTX 4090', confirmedHourlyPriceMicroUsd: 500_000 },
    });
  });

  it('supports roving arrow focus and Space selection without committing a provider action', async () => {
    const { onCommit } = renderSelector(snapshot());
    const auto = screen.getByRole('radio', { name: /Auto best value/i });
    const group = screen.getByRole('radiogroup', { name: 'Approved GPU choices' });
    await waitFor(() => expect(auto).toHaveFocus());
    expect(group).toHaveAttribute('aria-activedescendant', auto.id);
    fireEvent.keyDown(auto, { key: 'ArrowDown' });
    const target = screen.getByRole('radio', { name: /RTX 4090/i });
    await waitFor(() => expect(target).toHaveFocus());
    expect(target.id).toBe('gpu-selector-row-ordinary_3Artx-4090');
    expect(group).toHaveAttribute('aria-activedescendant', target.id);
    fireEvent.keyDown(target, { key: ' ' });
    expect(target).toHaveAttribute('aria-checked', 'true');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('authors the destructive switch facts and defaults focus to Keep current GPU', async () => {
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
      hourlyPriceMicroUsd: 700_000,
    });
    const { onCommit } = renderSelector(snapshot({ offers: [target], currentPod }), 'switch');
    fireEvent.click(screen.getByRole('radio', { name: /RTX 5090/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Review switch to RTX 5090' }));

    expect(screen.getByRole('dialog', { name: 'Switch RTX 4090 to RTX 5090?' })).toBeVisible();
    expect(screen.getByText(/current image will finish/i)).toBeVisible();
    expect(screen.getByText(/same network volume/i)).toBeVisible();
    expect(screen.getByText(/keeps billing/i)).toBeVisible();
    expect(screen.getByText(/Resume and Stop remain explicit/i)).toBeVisible();
    expect(screen.getByText('Current: RTX 4090 · $0.5/hr')).toBeVisible();
    expect(screen.getByText('Target: RTX 5090 · $0.7/hr')).toBeVisible();
    const keep = screen.getByRole('button', { name: 'Keep current GPU' });
    await waitFor(() => expect(keep).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'Switch to RTX 5090' }));
    expect(onCommit.mock.calls[0]?.[0]).toMatchObject({ kind: 'switch' });
  });

  it('closes a stale confirmation and requires a new click after a one-micro-USD refresh', () => {
    const initial = snapshot();
    const { onCommit, rerenderSelector } = renderSelector(initial);
    fireEvent.click(screen.getByRole('radio', { name: /RTX 4090/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Start selected GPU at $0.5/hr' }));
    expect(screen.getByRole('dialog', { name: 'Start RTX 4090?' })).toBeVisible();

    const observationId = '44444444-4444-4444-8444-444444444444';
    const receiptId = '55555555-5555-4555-8555-555555555555';
    rerenderSelector(snapshot({
      observationId,
      receiptId,
      offers: [offer({ observationId, receiptId, hourlyPriceMicroUsd: 500_001 })],
    }));
    expect(screen.queryByRole('dialog', { name: 'Start RTX 4090?' })).not.toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Start selected GPU at $0.500001/hr' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start RTX 4090' }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0]).toMatchObject({
      projection: {
        observationId,
        receiptId,
        confirmedHourlyPriceMicroUsd: 500_001,
      },
    });
  });

  it('shows an unavailable current price before a destructive switch', () => {
    const currentPod: NativeGpuSwitchPodV1 = {
      podId: 'pod-current-1',
      gpuId: 'NVIDIA GeForce RTX 4090',
      gpuDisplayName: 'RTX 4090',
      hourlyPriceMicroUsd: null,
    };
    const target = offer({
      gpuId: 'NVIDIA GeForce RTX 5090',
      policyKey: 'rtx_5090',
      displayName: 'RTX 5090',
      memoryGb: 32,
      hourlyPriceMicroUsd: 700_000,
    });
    renderSelector(snapshot({ offers: [target], currentPod }), 'switch');
    fireEvent.click(screen.getByRole('radio', { name: /RTX 5090/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Review switch to RTX 5090' }));
    expect(screen.getByText('Current: RTX 4090 · Price unavailable')).toBeVisible();
  });

  it('labels an invalid current Pod as an unapproved Stop-only row', () => {
    const currentPod: NativeGpuSwitchPodV1 = {
      podId: 'pod-legacy-1',
      gpuId: 'Legacy GPU ID',
      gpuDisplayName: 'Legacy GPU',
      hourlyPriceMicroUsd: 500_000,
    };
    renderSelector(snapshot({ offers: [offer()], currentPod }), 'switch');
    const current = screen.getByRole('radio', { name: /Current — not an approved target/i });
    expect(current).toBeDisabled();
  });

  it.each(['loading', 'fallback', 'error'] as const)(
    'keeps the stale current Pod pinned in the %s inventory state',
    (state) => {
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
      renderSelector(snapshot({
        state,
        offers: state === 'fallback' ? [fallback] : [],
        currentPod,
        currentPodStale: true,
      }), 'switch');
      expect(screen.getByRole('radio', { name: /Current GPU/i })).toBeDisabled();
      expect(screen.getByText('RTX 4090')).toBeVisible();
    },
  );

  it('renders authored loading/error states with no selectable or dead mutation control', () => {
    const { onRefresh } = renderSelector(snapshot({ state: 'loading', offers: [] }));
    expect(screen.getByText(/Loading live Secure Cloud inventory/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh GPUs' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Choose a GPU' })).toBeDisabled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('renders the newly approved exact A100 and RTX PRO 6000 offers', () => {
    renderSelector(snapshot({
      offers: [
        offer({
          gpuId: 'NVIDIA A100 80GB PCIe',
          policyKey: 'a100_pcie',
          displayName: 'A100 PCIe',
          memoryGb: 80,
          hourlyPriceMicroUsd: 1_390_000,
        }),
        offer({
          gpuId: 'NVIDIA RTX PRO 6000 Blackwell Server Edition',
          policyKey: 'rtx_pro_6000_blackwell_server',
          displayName: 'RTX PRO 6000 Blackwell Server Edition',
          memoryGb: 96,
          hourlyPriceMicroUsd: 2_090_000,
        }),
        offer({
          gpuId: 'NVIDIA RTX PRO 6000 Blackwell Workstation Edition',
          policyKey: 'rtx_pro_6000_blackwell_workstation',
          displayName: 'RTX PRO 6000 Blackwell Workstation Edition',
          memoryGb: 96,
          hourlyPriceMicroUsd: 1_890_000,
        }),
      ],
    }));
    expect(screen.getByRole('radio', { name: /A100 PCIe/i })).toBeVisible();
    expect(screen.getByRole('radio', { name: /RTX PRO 6000 Blackwell Server Edition/i })).toBeVisible();
    expect(screen.getByRole('radio', { name: /RTX PRO 6000 Blackwell Workstation Edition/i })).toBeVisible();
    expect(screen.queryByRole('radio', { name: /B200/i })).not.toBeInTheDocument();
  });

  it('mounts the exact deterministic 10-row fixture and stays below the 20-row cap', () => {
    const policies = [
      ['rtx_4090', 'NVIDIA GeForce RTX 4090', 'RTX 4090', 24],
      ['rtx_pro_4500_blackwell', 'catalog-pro-4500', 'RTX PRO 4500 Blackwell', 32],
      ['rtx_5090', 'NVIDIA GeForce RTX 5090', 'RTX 5090', 32],
      ['rtx_pro_4000_blackwell', 'catalog-pro-4000', 'RTX PRO 4000 Blackwell', 24],
      ['l4', 'NVIDIA L4', 'L4', 24],
      ['rtx_a4500', 'NVIDIA RTX A4500', 'RTX A4500', 20],
      ['rtx_4000_ada', 'NVIDIA RTX 4000 Ada Generation', 'RTX 4000 Ada', 20],
      ['rtx_2000_ada', 'NVIDIA RTX 2000 Ada Generation', 'RTX 2000 Ada', 16],
    ] as const;
    const offers = policies.map(([policyKey, gpuId, displayName, memoryGb], index) => offer({
      policyKey,
      gpuId,
      displayName,
      memoryGb,
      emergency: index === policies.length - 1,
    }));
    const currentPod: NativeGpuSwitchPodV1 = {
      podId: 'pod-current-1',
      gpuId: 'Current GPU ID',
      gpuDisplayName: 'Current GPU',
      hourlyPriceMicroUsd: 500_000,
    };
    renderSelector(snapshot({ offers, currentPod, includeEmergencyTier: true }));
    const mounted = screen.getAllByRole('radio').map((row) => row.getAttribute('data-gpu-row-id'));
    expect(mounted).toEqual(perfFixture.rowIds);
    expect(mounted).toHaveLength(10);
    expect(mounted.length).toBeLessThanOrEqual(20);
  });
});
