import {
  approveManagedPodGpu,
  projectAutoGpuSelectionV1,
  projectManualGpuSelectionV1,
  type GpuAutoSelectionProjectionV1,
  type GpuManualSelectionProjectionV1,
  type GpuSelectorDisabledReasonV1,
  type GpuSelectorOfferV1,
  type NativeGpuInventorySnapshotV1,
} from '@imageforge/runpod-client';

export type GpuSelectorModeV1 = 'offline_start' | 'switch';
export type GpuSelectorChoiceV1 = 'auto' | string;

export interface GpuSelectorRowV1 {
  readonly rowId: string;
  readonly choice: GpuSelectorChoiceV1;
  readonly kind: 'current' | 'auto' | 'ordinary' | 'emergency';
  readonly gpuId: string | null;
  readonly label: string;
  readonly memoryGb: number | null;
  readonly selectable: boolean;
  readonly disabledReason: GpuSelectorDisabledReasonV1 | null;
  readonly offer: GpuSelectorOfferV1 | null;
}

export type GpuSelectorConfirmationV1 =
  | { readonly kind: 'auto_start'; readonly projection: GpuAutoSelectionProjectionV1 }
  | {
      readonly kind: 'manual_start';
      readonly projection: GpuManualSelectionProjectionV1;
      readonly offer: GpuSelectorOfferV1;
    }
  | {
      readonly kind: 'switch';
      readonly projection: GpuManualSelectionProjectionV1;
      readonly offer: GpuSelectorOfferV1;
    };

export interface GpuSelectorUiStateV1 {
  readonly focusedChoice: GpuSelectorChoiceV1 | null;
  readonly selectedChoice: GpuSelectorChoiceV1 | null;
  readonly confirmation: GpuSelectorConfirmationV1 | null;
  readonly announcementKey: string | null;
  readonly announcement: string;
}

export const INITIAL_GPU_SELECTOR_UI_STATE_V1: GpuSelectorUiStateV1 = Object.freeze({
  focusedChoice: null,
  selectedChoice: null,
  confirmation: null,
  announcementKey: null,
  announcement: '',
});

function policyRowId(offer: GpuSelectorOfferV1, duplicatePolicy: boolean): string {
  const prefix = offer.emergency ? 'emergency' : 'ordinary';
  const policy = offer.policyKey.replaceAll('_', '-');
  return duplicatePolicy ? `${prefix}:${policy}:${offer.gpuId}` : `${prefix}:${policy}`;
}

export function buildGpuSelectorRowsV1(
  snapshot: NativeGpuInventorySnapshotV1,
  mode: GpuSelectorModeV1,
): readonly GpuSelectorRowV1[] {
  const rows: GpuSelectorRowV1[] = [];
  const currentPod = snapshot.currentPod;
  if (currentPod !== null) {
    const livePolicyByGpuId = new Map(snapshot.offers.flatMap((offer) =>
      offer.source === 'live' || (offer.source === 'current' && offer.disabledReason === 'current_gpu')
        ? [[offer.gpuId, offer.policyKey] as const]
        : []));
    const approved = approveManagedPodGpu(
      currentPod.gpuId,
      currentPod.gpuDisplayName,
      livePolicyByGpuId,
      snapshot.includeEmergencyTier,
    ) !== null;
    rows.push(Object.freeze({
      rowId: 'current',
      choice: currentPod.gpuId,
      kind: 'current',
      gpuId: currentPod.gpuId,
      label: currentPod.gpuDisplayName,
      memoryGb: null,
      selectable: false,
      disabledReason: approved ? 'current_gpu' : 'unapproved_current',
      offer: null,
    }));
  }
  const auto = mode === 'offline_start'
    ? projectAutoGpuSelectionV1(snapshot, snapshot.processEpochId)
    : null;
  if (mode === 'offline_start') {
    rows.push(Object.freeze({
      rowId: 'auto',
      choice: 'auto',
      kind: 'auto',
      gpuId: null,
      label: 'Auto best value',
      memoryGb: null,
      selectable: auto !== null,
      disabledReason: auto === null
        ? snapshot.state === 'loading' ? 'inventory_loading'
          : snapshot.state === 'fallback' ? 'fallback_only'
            : snapshot.state === 'ready' && snapshot.offers.some((offer) => offer.stale)
              ? 'inventory_stale'
              : 'inventory_error'
        : null,
      offer: null,
    }));
  }
  const policyCounts = new Map<string, number>();
  const targetOffers = snapshot.offers.filter((offer) =>
    offer.source !== 'current' && offer.gpuId !== currentPod?.gpuId);
  targetOffers.forEach((offer) => {
    policyCounts.set(offer.policyKey, (policyCounts.get(offer.policyKey) ?? 0) + 1);
  });
  targetOffers.forEach((offer) => {
    rows.push(Object.freeze({
      rowId: policyRowId(offer, (policyCounts.get(offer.policyKey) ?? 0) > 1),
      choice: offer.gpuId,
      kind: offer.emergency ? 'emergency' : 'ordinary',
      gpuId: offer.gpuId,
      label: offer.displayName,
      memoryGb: offer.memoryGb,
      selectable: offer.selectable,
      disabledReason: offer.disabledReason,
      offer,
    }));
  });
  if (rows.length > 20) {
    throw new RangeError('GPU selector policy exceeded the 20-row mounted limit.');
  }
  return Object.freeze(rows);
}

function selectableChoices(rows: readonly GpuSelectorRowV1[]): readonly GpuSelectorChoiceV1[] {
  return rows.filter((row) => row.selectable).map((row) => row.choice);
}

function nearestSelectableChoice(
  previousChoice: GpuSelectorChoiceV1 | null,
  previousRows: readonly GpuSelectorRowV1[],
  nextRows: readonly GpuSelectorRowV1[],
): GpuSelectorChoiceV1 | null {
  const selectable = selectableChoices(nextRows);
  if (selectable.length === 0) return null;
  if (previousChoice !== null && selectable.includes(previousChoice)) return previousChoice;
  const previousIndex = previousRows.findIndex((row) => row.choice === previousChoice);
  const clamped = Math.max(0, Math.min(previousIndex < 0 ? 0 : previousIndex, nextRows.length - 1));
  for (let distance = 0; distance < nextRows.length; distance += 1) {
    const after = nextRows[clamped + distance];
    if (after?.selectable) return after.choice;
    const before = nextRows[clamped - distance];
    if (before?.selectable) return before.choice;
  }
  return selectable[0] ?? null;
}

export function reconcileGpuSelectorUiV1(input: {
  readonly state: GpuSelectorUiStateV1;
  readonly previousRows: readonly GpuSelectorRowV1[];
  readonly nextRows: readonly GpuSelectorRowV1[];
  readonly snapshot: NativeGpuInventorySnapshotV1;
}): GpuSelectorUiStateV1 {
  const selectionStillValid = input.state.selectedChoice !== null &&
    input.nextRows.some((row) => row.choice === input.state.selectedChoice && row.selectable);
  const selectedChoice = selectionStillValid ? input.state.selectedChoice : null;
  const focusedChoice = nearestSelectableChoice(
    input.state.focusedChoice,
    input.previousRows,
    input.nextRows,
  );
  const selectionLost = input.state.selectedChoice !== null && selectedChoice === null;
  const confirmationInvalidated = input.state.confirmation !== null &&
    !isGpuSelectorConfirmationCurrentV1(
      input.state.confirmation,
      input.nextRows,
      input.snapshot,
    );
  const announcementKey = `${input.snapshot.observationId}:${input.snapshot.state}:${selectedChoice ?? 'none'}`;
  const announcement = selectionLost
    ? 'The selected GPU is no longer available. Choose another GPU.'
    : confirmationInvalidated
      ? 'GPU inventory or price changed. Review and confirm the updated selection.'
    : input.snapshot.state === 'loading' ? 'Refreshing live GPU inventory.'
      : input.snapshot.state === 'empty' ? 'No approved GPUs are currently available.'
        : input.snapshot.state === 'fallback' ? 'Live inventory is unavailable. Fallback policy is read only.'
          : input.snapshot.state === 'error' ? 'GPU inventory needs attention.'
            : `${input.nextRows.filter((row) => row.selectable).length} GPU choices available.`;
  return Object.freeze({
    ...input.state,
    selectedChoice,
    focusedChoice,
    confirmation: selectionLost || confirmationInvalidated ? null : input.state.confirmation,
    announcementKey,
    announcement: announcementKey === input.state.announcementKey ? '' : announcement,
  });
}

function sameAutoProjection(
  left: GpuAutoSelectionProjectionV1,
  right: GpuAutoSelectionProjectionV1,
): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.observationId === right.observationId && left.receiptId === right.receiptId &&
    left.mode === right.mode && left.benchmarkQuorum === right.benchmarkQuorum &&
    left.orderedGpuIds.length === right.orderedGpuIds.length &&
    left.orderedGpuIds.every((gpuId, index) => gpuId === right.orderedGpuIds[index]);
}

function sameManualProjection(
  left: GpuManualSelectionProjectionV1,
  right: GpuManualSelectionProjectionV1,
): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.observationId === right.observationId && left.receiptId === right.receiptId &&
    left.targetGpuId === right.targetGpuId &&
    left.confirmedHourlyPriceMicroUsd === right.confirmedHourlyPriceMicroUsd;
}

export function isGpuSelectorConfirmationCurrentV1(
  confirmation: GpuSelectorConfirmationV1,
  rows: readonly GpuSelectorRowV1[],
  snapshot: NativeGpuInventorySnapshotV1,
): boolean {
  if (confirmation.kind === 'auto_start') {
    const row = rows.find((candidate) => candidate.kind === 'auto');
    const projection = projectAutoGpuSelectionV1(snapshot, snapshot.processEpochId);
    return row?.selectable === true && projection !== null &&
      sameAutoProjection(confirmation.projection, projection);
  }
  const row = rows.find((candidate) =>
    candidate.gpuId === confirmation.projection.targetGpuId && candidate.offer !== null);
  const projection = projectManualGpuSelectionV1(
    snapshot,
    confirmation.projection.targetGpuId,
    snapshot.processEpochId,
  );
  return row?.selectable === true && row.offer !== null && projection !== null &&
    confirmation.offer.observationId === row.offer.observationId &&
    confirmation.offer.receiptId === row.offer.receiptId &&
    confirmation.offer.gpuId === row.offer.gpuId &&
    confirmation.offer.hourlyPriceMicroUsd === row.offer.hourlyPriceMicroUsd &&
    sameManualProjection(confirmation.projection, projection);
}

export function moveGpuSelectorFocusV1(
  state: GpuSelectorUiStateV1,
  rows: readonly GpuSelectorRowV1[],
  direction: -1 | 1 | 'first' | 'last',
): GpuSelectorUiStateV1 {
  const choices = selectableChoices(rows);
  if (choices.length === 0) return state;
  const currentIndex = Math.max(0, choices.indexOf(state.focusedChoice ?? choices[0] ?? 'auto'));
  const nextIndex = direction === 'first' ? 0
    : direction === 'last' ? choices.length - 1
      : (currentIndex + direction + choices.length) % choices.length;
  return Object.freeze({ ...state, focusedChoice: choices[nextIndex] ?? null });
}

export function selectGpuChoiceV1(
  state: GpuSelectorUiStateV1,
  rows: readonly GpuSelectorRowV1[],
  choice: GpuSelectorChoiceV1,
): GpuSelectorUiStateV1 {
  const row = rows.find((candidate) => candidate.choice === choice);
  if (!row?.selectable) return state;
  const selectedChoice = state.selectedChoice === choice ? null : choice;
  return Object.freeze({
    ...state,
    selectedChoice,
    focusedChoice: choice,
    confirmation: null,
  });
}

export function requestGpuSelectorConfirmationV1(input: {
  readonly state: GpuSelectorUiStateV1;
  readonly rows: readonly GpuSelectorRowV1[];
  readonly snapshot: NativeGpuInventorySnapshotV1;
  readonly mode: GpuSelectorModeV1;
}): GpuSelectorUiStateV1 {
  const row = input.rows.find((candidate) => candidate.choice === input.state.selectedChoice);
  if (!row?.selectable) return input.state;
  if (row.kind === 'auto') {
    const projection = projectAutoGpuSelectionV1(input.snapshot, input.snapshot.processEpochId);
    return projection === null ? input.state : Object.freeze({
      ...input.state,
      confirmation: Object.freeze({ kind: 'auto_start', projection }),
    });
  }
  if (row.offer === null) return input.state;
  const projection = projectManualGpuSelectionV1(
    input.snapshot,
    row.offer.gpuId,
    input.snapshot.processEpochId,
  );
  return projection === null ? input.state : Object.freeze({
    ...input.state,
    confirmation: Object.freeze({
      kind: input.mode === 'switch' ? 'switch' : 'manual_start',
      projection,
      offer: row.offer,
    }),
  });
}
