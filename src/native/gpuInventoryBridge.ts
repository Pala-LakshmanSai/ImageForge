import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  parseNativeGpuInventoryEventV1,
  parseNativeGpuInventorySnapshotV1,
  type NativeGpuInventoryEventV1,
  type NativeGpuInventorySnapshotV1,
} from '@imageforge/runpod-client';

const GPU_INVENTORY_EVENT = 'gpu-inventory-v1';

function requireSnapshot(
  value: unknown,
  expectedProcessEpochId?: string,
): NativeGpuInventorySnapshotV1 {
  const snapshot = parseNativeGpuInventorySnapshotV1(value, expectedProcessEpochId);
  if (snapshot === null) {
    throw new Error('Native GPU inventory returned an invalid snapshot.');
  }
  return snapshot;
}
/** Read the last native-owned inventory projection. This command never starts
 * a provider request and never manufactures renderer-side freshness. */
export async function nativeGpuInventoryLoad(
  expectedProcessEpochId?: string,
): Promise<NativeGpuInventorySnapshotV1> {
  return requireSnapshot(await invoke('gpu_inventory_load'), expectedProcessEpochId);
}

/** Begin one native-coalesced two-GET observation. The immediate result is
 * normally `loading`; its receipt-bearing terminal state arrives via the
 * app-scoped gpu-inventory-v1 event. */
export async function nativeGpuInventoryBeginRefresh(
  includeEmergencyTier: boolean,
  expectedProcessEpochId?: string,
): Promise<NativeGpuInventorySnapshotV1> {
  if (typeof includeEmergencyTier !== 'boolean') {
    throw new TypeError('includeEmergencyTier must be a boolean.');
  }
  return requireSnapshot(
    await invoke('gpu_inventory_begin_refresh', { includeEmergencyTier }),
    expectedProcessEpochId,
  );
}

export interface NativeGpuInventoryListener {
  readonly processEpochId: string;
  readonly previousEventSequence: number | null;
  readonly onEvent: (event: NativeGpuInventoryEventV1) => void;
  readonly onInvalidEvent: () => void;
}

/** Register one strict app-window listener. Sequence or epoch drift is not
 * passed through: the caller reloads the native snapshot instead. */
export function listenNativeGpuInventory(
  input: NativeGpuInventoryListener,
): Promise<UnlistenFn> {
  let previousEventSequence = input.previousEventSequence;
  return listen<unknown>(GPU_INVENTORY_EVENT, (event) => {
    const parsed = parseNativeGpuInventoryEventV1(event.payload, {
      expectedProcessEpochId: input.processEpochId,
      previousEventSequence,
    });
    if (parsed === null) {
      input.onInvalidEvent();
      return;
    }
    previousEventSequence = parsed.eventSequence;
    input.onEvent(parsed);
  });
}
