import {
  formatCanonicalMicroUsdV1,
  formatHourlyMicroUsdV1,
  projectGpuInventoryFreshnessV1,
  type GpuSelectorAvailabilityV1,
  type GpuSelectorDisabledReasonV1,
  type NativeGpuInventorySnapshotV1,
} from '@imageforge/runpod-client';
import { AlertTriangle, Check, Gauge, RefreshCw, Sparkles, X, Zap } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  buildGpuSelectorRowsV1,
  INITIAL_GPU_SELECTOR_UI_STATE_V1,
  isGpuSelectorConfirmationCurrentV1,
  moveGpuSelectorFocusV1,
  reconcileGpuSelectorUiV1,
  requestGpuSelectorConfirmationV1,
  selectGpuChoiceV1,
  type GpuSelectorChoiceV1,
  type GpuSelectorConfirmationV1,
  type GpuSelectorModeV1,
  type GpuSelectorRowV1,
  type GpuSelectorUiStateV1,
} from '../domain/gpuSelector';
import { DialogPortal } from './DialogPortal';
import { Button } from './primitives';
import './GpuSelector.css';

const DISABLED_COPY: Record<GpuSelectorDisabledReasonV1, string> = {
  current_gpu: 'Current GPU',
  unapproved_current: 'Current — not an approved target',
  inventory_loading: 'Refreshing inventory',
  inventory_error: 'Inventory unavailable',
  fallback_only: 'Policy preview only',
  inventory_stale: 'Inventory expired',
  unavailable: 'Unavailable in EU-RO-1',
  price_unavailable: 'Price unavailable',
  same_as_current: 'Already in use',
};

export interface GpuSelectorProps {
  readonly snapshot: NativeGpuInventorySnapshotV1;
  readonly mode: GpuSelectorModeV1;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
  readonly onCommit: (confirmation: GpuSelectorConfirmationV1) => void;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  readonly nowUtcMs?: number;
  readonly busy?: boolean;
  /**
   * Raised while the paid-action confirmation is mounted. The owner suspends
   * its receipt-freshness refresh for that window so a background observation
   * cannot dismiss a confirmation the user is reading.
   */
  readonly onConfirmationOpenChange?: (open: boolean) => void;
}

function availabilityCopy(value: GpuSelectorAvailabilityV1): string {
  if (value === 'high') return 'High availability';
  if (value === 'medium') return 'Medium availability';
  if (value === 'low') return 'Low availability';
  if (value === 'none') return 'No capacity';
  return 'Availability unknown';
}

function benchmarkCopy(row: GpuSelectorRowV1): string {
  if (row.kind === 'auto') return 'Best live value · fixed policy when benchmark quorum is unavailable';
  if (row.kind === 'current') return 'Pinned current Pod';
  if (row.offer?.benchmarkState === 'stale') return 'Benchmark expired';
  if (row.offer?.benchmarkState === 'unmeasured') return 'Unmeasured';
  return row.offer?.speedScore === null || row.offer?.speedScore === undefined
    ? 'Speed score —'
    : `Speed score ${row.offer.speedScore}`;
}

function observationAge(observedAt: string | null | undefined, nowUtcMs: number): string {
  if (observedAt === null || observedAt === undefined) return 'No live observation';
  const ageMs = nowUtcMs - Date.parse(observedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'Observation time unavailable';
  if (ageMs < 1_000) return 'Observed just now';
  return `Observed ${Math.floor(ageMs / 1_000)}s ago`;
}

function primaryCopy(
  mode: GpuSelectorModeV1,
  selected: GpuSelectorRowV1 | undefined,
): string {
  if (selected?.kind === 'auto') return 'Review Auto start';
  if (selected?.offer === null || selected?.offer === undefined) return 'Choose a GPU';
  const price = formatHourlyMicroUsdV1(selected.offer.hourlyPriceMicroUsd);
  return mode === 'switch' ? `Review switch to ${selected.label}` : `Start selected GPU at ${price}`;
}

function statusCopy(snapshot: NativeGpuInventorySnapshotV1, receiptExpired: boolean): string {
  if (snapshot.state === 'loading') return 'Loading live Secure Cloud inventory…';
  if (receiptExpired && snapshot.state === 'ready') {
    return 'These live prices expired. ImageForge is refreshing them; choose again once the new list lands.';
  }
  if (snapshot.state === 'empty') return 'No approved GPU has capacity in EU-RO-1.';
  if (snapshot.state === 'fallback') {
    return snapshot.issue?.code === 'gpu_inventory_datacenters_unavailable'
      ? 'RunPod region inventory could not be reached. The policy order below is read only; retry Refresh GPUs.'
      : 'RunPod GPU inventory could not be reached. The policy order below is read only; retry Refresh GPUs.';
  }
  if (snapshot.state === 'error') {
    return snapshot.issue?.code === 'gpu_inventory_region_unsupported'
      ? 'RunPod did not confirm network-volume support in EU-RO-1. Starting is blocked.'
      : 'RunPod returned inventory data ImageForge could not validate. Starting is blocked.';
  }
  return `${snapshot.offers.length} approved live ${snapshot.offers.length === 1 ? 'offer' : 'offers'}`;
}

function ConfirmationDialog({
  confirmation,
  snapshot,
  onCancel,
  onCommit,
}: {
  readonly confirmation: GpuSelectorConfirmationV1;
  readonly snapshot: NativeGpuInventorySnapshotV1;
  readonly onCancel: () => void;
  readonly onCommit: () => void;
}) {
  const switching = confirmation.kind === 'switch';
  const target = confirmation.kind === 'auto_start' ? 'Auto best value' : confirmation.offer.displayName;
  const targetPrice = confirmation.kind === 'auto_start'
    ? 'the fresh live order'
    : formatHourlyMicroUsdV1(confirmation.offer.hourlyPriceMicroUsd);
  const current = snapshot.currentPod?.gpuDisplayName ?? 'the current GPU';
  const currentPrice = formatHourlyMicroUsdV1(snapshot.currentPod?.hourlyPriceMicroUsd ?? null);
  const currentPriceCopy = currentPrice === '—' ? 'Price unavailable' : currentPrice;
  const targetPriceCopy = targetPrice === '—' ? 'Price unavailable' : targetPrice;
  return (
    <DialogPortal
      backdropClassName="gpu-selector-confirmation-backdrop"
      surfaceClassName="gpu-selector-confirmation"
      labelledBy="gpu-selector-confirmation-title"
      describedBy="gpu-selector-confirmation-copy"
      onRequestClose={onCancel}
    >
      <div className="gpu-selector-confirmation__symbol" aria-hidden="true">
        {switching ? <AlertTriangle size={22} /> : <Zap size={22} />}
      </div>
      <p className="gpu-selector__eyebrow">{switching ? 'Permanent Pod replacement' : 'Explicit GPU start'}</p>
      <h2 id="gpu-selector-confirmation-title">
        {switching ? `Switch ${current} to ${target}?` : `Start ${target}?`}
      </h2>
      <p id="gpu-selector-confirmation-copy">
        {switching
          ? `The current image will finish, then ImageForge will pause the batch and local queue before permanently terminating ${current}. ${target} may become unavailable during the handoff.`
          : `${target} will be started from ${targetPrice}. ImageForge will recheck live inventory and the exact price before creating one Pod.`}
      </p>
      {switching ? (
        <ul className="gpu-selector-confirmation__facts">
          <li>Current: {current} · {currentPriceCopy}</li>
          <li>Target: {target} · {targetPriceCopy}</li>
          <li>The same network volume and finished images stay in place.</li>
          <li>There may be downtime while the replacement loads and warms.</li>
          <li>The new GPU keeps billing after it becomes ready.</li>
          <li>Resume and Stop remain explicit actions.</li>
        </ul>
      ) : null}
      <div className="gpu-selector-confirmation__actions">
        <Button tone="secondary" data-autofocus onClick={onCancel}>
          {switching ? 'Keep current GPU' : 'Cancel'}
        </Button>
        <Button tone={switching ? 'danger' : 'primary'} onClick={onCommit}>
          {switching ? `Switch to ${target}` : `Start ${target}`}
        </Button>
      </div>
    </DialogPortal>
  );
}

function gpuSelectorRowDomId(rowId: string): string {
  return `gpu-selector-row-${encodeURIComponent(rowId).replaceAll('%', '_')}`;
}

export function GpuSelector({
  snapshot,
  mode,
  onClose,
  onRefresh,
  onCommit,
  returnFocusRef,
  nowUtcMs,
  busy = false,
  onConfirmationOpenChange,
}: GpuSelectorProps) {
  const [tickUtcMs, setTickUtcMs] = useState(() => Date.now());
  // A mounted sheet has to keep its own time. The native receipt authorizes a
  // paid Start for `validForMs` only, so an unattended selector must notice
  // that deadline itself instead of presenting an expired receipt as startable
  // until the click fails with `gpu_start_inventory_stale`.
  useEffect(() => {
    if (nowUtcMs !== undefined) return;
    const timer = window.setInterval(() => setTickUtcMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [nowUtcMs]);
  const now = nowUtcMs ?? tickUtcMs;
  const receiptExpired = useMemo(() => {
    const receipt = snapshot.receipt;
    if (receipt === null) return false;
    const receivedAtMs = Date.parse(receipt.receivedAt);
    if (!Number.isFinite(receivedAtMs)) return true;
    return now - receivedAtMs >= receipt.validForMs;
  }, [snapshot, now]);
  // Keep the projected snapshot referentially stable across ticks; only the
  // expiry edge may rebuild rows.
  const activeSnapshot = useMemo(
    () => (receiptExpired
      ? projectGpuInventoryFreshnessV1(snapshot, snapshot.processEpochId, 60_000)
      : snapshot),
    [receiptExpired, snapshot],
  );
  const rows = useMemo(() => buildGpuSelectorRowsV1(activeSnapshot, mode), [activeSnapshot, mode]);
  const rowsRef = useRef<readonly GpuSelectorRowV1[]>([]);
  const [ui, setUi] = useState<GpuSelectorUiStateV1>(INITIAL_GPU_SELECTOR_UI_STATE_V1);
  const rowRefs = useRef(new Map<GpuSelectorChoiceV1, HTMLButtonElement>());

  useEffect(() => {
    setUi((state) => reconcileGpuSelectorUiV1({
      state,
      previousRows: rowsRef.current,
      nextRows: rows,
      snapshot: activeSnapshot,
    }));
    rowsRef.current = rows;
  }, [rows, activeSnapshot]);

  const confirmationOpen = ui.confirmation !== null;
  useEffect(() => {
    onConfirmationOpenChange?.(confirmationOpen);
    return () => onConfirmationOpenChange?.(false);
  }, [confirmationOpen, onConfirmationOpenChange]);

  useEffect(() => {
    if (ui.focusedChoice !== null) rowRefs.current.get(ui.focusedChoice)?.focus();
  }, [ui.focusedChoice]);

  useEffect(() => () => returnFocusRef?.current?.focus(), [returnFocusRef]);

  const selected = rows.find((row) => row.choice === ui.selectedChoice);
  const activeRow = rows.find((row) => row.choice === ui.focusedChoice && row.selectable);
  const choose = (choice: GpuSelectorChoiceV1) => setUi((state) =>
    selectGpuChoiceV1(state, rows, choice));
  const requestConfirmation = () => setUi((state) =>
    requestGpuSelectorConfirmationV1({ state, rows, snapshot: activeSnapshot, mode }));

  function handleRowKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      setUi((state) => moveGpuSelectorFocusV1(state, rows, 1));
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      setUi((state) => moveGpuSelectorFocusV1(state, rows, -1));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setUi((state) => moveGpuSelectorFocusV1(state, rows, event.key === 'Home' ? 'first' : 'last'));
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      const choice = (event.currentTarget.dataset.choice ?? '') as GpuSelectorChoiceV1;
      choose(choice);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <>
      <section
        className="gpu-selector"
        role="dialog"
        aria-modal="false"
        aria-labelledby="gpu-selector-title"
        data-gpu-selector-state={activeSnapshot.state}
      >
        <header className="gpu-selector__header">
          <div>
            <p className="gpu-selector__eyebrow">Secure Cloud · EU-RO-1 · one GPU</p>
            <h2 id="gpu-selector-title">{mode === 'switch' ? 'Current GPU / Switch GPU' : 'Choose a GPU'}</h2>
            <p>{statusCopy(activeSnapshot, receiptExpired)}</p>
          </div>
          <div className="gpu-selector__header-actions">
            <button type="button" className="gpu-selector__icon-button" onClick={onRefresh} disabled={activeSnapshot.state === 'loading'} aria-label="Refresh GPUs">
              <RefreshCw className={activeSnapshot.state === 'loading' ? 'gpu-selector__refresh-icon--loading' : undefined} size={17} aria-hidden="true" />
            </button>
            <button type="button" className="gpu-selector__icon-button" onClick={onClose} aria-label="Close GPU selector">
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="gpu-selector__announcer" aria-live="polite" aria-atomic="true">{ui.announcement}</div>
        <div
          className="gpu-selector__rows"
          role="radiogroup"
          aria-label="Approved GPU choices"
          aria-activedescendant={activeRow === undefined ? undefined : gpuSelectorRowDomId(activeRow.rowId)}
        >
          {rows.map((row) => {
            const selectedRow = ui.selectedChoice === row.choice;
            const offer = row.offer;
            const price = row.kind === 'auto' ? 'Live order' : formatHourlyMicroUsdV1(
              row.kind === 'current'
                ? activeSnapshot.currentPod?.hourlyPriceMicroUsd ?? null
                : offer?.hourlyPriceMicroUsd ?? null,
            );
            const disabled = row.disabledReason === null ? null : DISABLED_COPY[row.disabledReason];
            return (
              <button
                key={row.rowId}
                id={gpuSelectorRowDomId(row.rowId)}
                ref={(element) => {
                  if (element === null) rowRefs.current.delete(row.choice);
                  else rowRefs.current.set(row.choice, element);
                }}
                type="button"
                role="radio"
                aria-checked={selectedRow}
                aria-disabled={!row.selectable}
                disabled={!row.selectable}
                tabIndex={row.selectable && ui.focusedChoice === row.choice ? 0 : -1}
                data-choice={row.choice}
                data-gpu-row-id={row.rowId}
                className={`gpu-selector-row gpu-selector-row--${row.kind}${selectedRow ? ' gpu-selector-row--selected' : ''}`}
                onClick={() => choose(row.choice)}
                onKeyDown={handleRowKeyDown}
              >
                <span className="gpu-selector-row__mark" aria-hidden="true">
                  {selectedRow ? <Check size={14} /> : row.kind === 'auto' ? <Sparkles size={14} /> : <Gauge size={14} />}
                </span>
                <span className="gpu-selector-row__identity">
                  <strong>{row.label}</strong>
                  <small>
                    {row.kind === 'auto' ? 'Ordinary approved GPUs only'
                      : row.kind === 'current' ? row.gpuId
                        : `${row.memoryGb} GB · ${availabilityCopy(offer?.availability ?? 'unknown')}`}
                  </small>
                </span>
                <span className="gpu-selector-row__evidence">
                  <strong>{price}</strong>
                  <small>{benchmarkCopy(row)}</small>
                </span>
                <span className="gpu-selector-row__estimate">
                  <strong>{offer === null ? '—' : formatCanonicalMicroUsdV1(offer.estimatedSwitchRemainingCostMicroUsd)}</strong>
                  <small>{disabled ?? observationAge(offer?.observedAt ?? activeSnapshot.currentPodObservedAt, now)}</small>
                </span>
              </button>
            );
          })}
        </div>

        <footer className="gpu-selector__footer">
          <span>
            {selected
              ? `${selected.label} selected. Nothing changes until confirmation.`
              : receiptExpired && activeSnapshot.state === 'ready'
                ? 'The live price receipt expired. Wait for the refreshed list, or use Refresh GPUs.'
                : 'Select one exact choice to continue.'}
          </span>
          <Button tone="primary" disabled={selected === undefined || busy} pending={busy} onClick={requestConfirmation}>
            {primaryCopy(mode, selected)}
          </Button>
        </footer>
      </section>

      {ui.confirmation !== null ? (
        <ConfirmationDialog
          confirmation={ui.confirmation}
          snapshot={activeSnapshot}
          onCancel={() => setUi((state) => Object.freeze({ ...state, confirmation: null }))}
          onCommit={() => {
            const confirmation = ui.confirmation;
            if (confirmation === null) return;
            if (!isGpuSelectorConfirmationCurrentV1(confirmation, rows, activeSnapshot)) {
              setUi((state) => Object.freeze({ ...state, confirmation: null }));
              return;
            }
            onCommit(confirmation);
            setUi((state) => Object.freeze({ ...state, confirmation: null }));
          }}
        />
      ) : null}
    </>
  );
}
