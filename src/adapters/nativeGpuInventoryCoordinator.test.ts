import { describe, expect, it, vi } from 'vitest';
import type {
  NativeGpuInventoryEventV1,
  NativeGpuInventorySnapshotV1,
} from '@imageforge/runpod-client';
import {
  NativeGpuInventoryCoordinator,
  type NativeGpuInventoryPort,
} from './nativeGpuInventoryCoordinator';

const EPOCH = '018f3d31-b082-4f61-81d2-4f6de88fd714';
const OBSERVATION = '028f3d31-b082-4f61-81d2-4f6de88fd714';
const RECEIPT = '038f3d31-b082-4f61-81d2-4f6de88fd714';
const NEXT_OBSERVATION = '048f3d31-b082-4f61-81d2-4f6de88fd714';

function snapshot(
  state: NativeGpuInventorySnapshotV1['state'],
): NativeGpuInventorySnapshotV1 {
  return {
    schemaVersion: 1,
    observationId: OBSERVATION,
    processEpochId: EPOCH,
    includeEmergencyTier: false,
    state,
    observedAt: state === 'ready' ? '2026-08-04T00:00:00.000Z' : null,
    receipt: state === 'ready' ? {
      schemaVersion: 1,
      receiptId: RECEIPT,
      processEpochId: EPOCH,
      receivedAt: '2026-08-04T00:00:00.000Z',
      validForMs: 60_000,
      catalogSha256: 'a'.repeat(64),
    } : null,
    offers: [],
    currentPod: null,
    currentPodObservedAt: null,
    currentPodStale: false,
    issue: null,
  };
}

function fakePort(initial = snapshot('loading')): NativeGpuInventoryPort & {
  emit(event: NativeGpuInventoryEventV1): void;
  invalid(): void;
} {
  let listener: Parameters<NativeGpuInventoryPort['listen']>[0] | null = null;
  return {
    load: vi.fn(async () => initial),
    beginRefresh: vi.fn(async () => snapshot('loading')),
    listen: vi.fn(async (input) => {
      listener = input;
      return () => { listener = null; };
    }),
    emit(event) { listener?.onEvent(event); },
    invalid() { listener?.onInvalidEvent(); },
  };
}

function terminalEvent(
  terminal = snapshot('ready'),
  superseded = false,
): NativeGpuInventoryEventV1 {
  return {
    schemaVersion: 1,
    event: 'gpu-inventory-v1',
    processEpochId: EPOCH,
    observationId: OBSERVATION,
    eventSequence: 1,
    superseded,
    snapshot: terminal,
  };
}

describe('NativeGpuInventoryCoordinator', () => {
  it('invalidates the cached projection and old listener when the native profile changes', async () => {
    let current = snapshot('loading');
    const listeners: Array<Parameters<NativeGpuInventoryPort['listen']>[0]> = [];
    const port: NativeGpuInventoryPort = {
      load: vi.fn(async () => current),
      beginRefresh: vi.fn(async () => current),
      listen: vi.fn(async (input) => {
        listeners.push(input);
        return () => undefined;
      }),
    };
    const coordinator = new NativeGpuInventoryCoordinator(port);
    await coordinator.load();
    const oldListener = listeners[0]!;
    current = { ...snapshot('loading'), observationId: NEXT_OBSERVATION };

    await expect(coordinator.resetForProfileChange()).resolves.toMatchObject({
      observationId: NEXT_OBSERVATION,
    });
    oldListener.onEvent(terminalEvent());

    expect(coordinator.getSnapshot()?.observationId).toBe(NEXT_OBSERVATION);
    expect(port.listen).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it('waits for the exact native terminal event before returning Auto authority', async () => {
    const port = fakePort();
    const coordinator = new NativeGpuInventoryCoordinator(port);
    const observed: NativeGpuInventorySnapshotV1[] = [];
    coordinator.subscribe((value) => observed.push(value));
    const controller = new AbortController();
    const pending = coordinator.refreshForAutoStart({
      expectedImageCount: 450,
      includeEmergencyTier: false,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(port.beginRefresh).toHaveBeenCalledTimes(1));
    port.emit(terminalEvent());

    await expect(pending).resolves.toMatchObject({ state: 'ready', receipt: { receiptId: RECEIPT } });
    expect(port.load).toHaveBeenCalledTimes(2);
    expect(observed.at(-1)?.state).toBe('ready');
    coordinator.dispose();
  });

  it('rejects a superseded observation and never turns it into mutation authority', async () => {
    const port = fakePort();
    const coordinator = new NativeGpuInventoryCoordinator(port);
    const pending = coordinator.refreshForAutoStart({
      expectedImageCount: 12,
      includeEmergencyTier: false,
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(port.beginRefresh).toHaveBeenCalledTimes(1));
    port.emit(terminalEvent(snapshot('ready'), true));
    await expect(pending).rejects.toThrow('superseded');
    expect(coordinator.getSnapshot()?.state).toBe('loading');
    coordinator.dispose();
  });

  it('does not miss a terminal event emitted before beginRefresh resolves', async () => {
    let listener: Parameters<NativeGpuInventoryPort['listen']>[0] | null = null;
    const loading = snapshot('loading');
    const port: NativeGpuInventoryPort = {
      load: vi.fn(async () => loading),
      beginRefresh: vi.fn(() => {
        listener?.onEvent(terminalEvent());
        return Promise.resolve(loading);
      }),
      listen: vi.fn(async (input) => {
        listener = input;
        return () => { listener = null; };
      }),
    };
    const coordinator = new NativeGpuInventoryCoordinator(port);

    await expect(coordinator.refreshForAutoStart({
      expectedImageCount: 450,
      includeEmergencyTier: false,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      state: 'ready',
      receipt: { receiptId: RECEIPT },
    });
    expect(coordinator.getSnapshot()?.state).toBe('ready');
    coordinator.dispose();
  });

  it('settles a waiter when the terminal event lands after loading is accepted but before pending registration', async () => {
    const port = fakePort();
    let beginCalled = false;
    let emitted = false;
    vi.mocked(port.beginRefresh).mockImplementation(async () => {
      beginCalled = true;
      return snapshot('loading');
    });
    const coordinator = new NativeGpuInventoryCoordinator(port);
    coordinator.subscribe((value) => {
      if (beginCalled && !emitted && value.state === 'loading') {
        emitted = true;
        port.emit(terminalEvent());
      }
    });

    await expect(coordinator.refreshForAutoStart({
      expectedImageCount: 450,
      includeEmergencyTier: false,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      state: 'ready',
      receipt: { receiptId: RECEIPT },
    });
    expect(emitted).toBe(true);
    coordinator.dispose();
  });

  it('cancels only the renderer wait while leaving native observation ownership intact', async () => {
    const port = fakePort();
    const coordinator = new NativeGpuInventoryCoordinator(port);
    const controller = new AbortController();
    const pending = coordinator.refreshForAutoStart({
      expectedImageCount: 1,
      includeEmergencyTier: false,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(port.beginRefresh).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(port.beginRefresh).toHaveBeenCalledTimes(1);
    coordinator.dispose();
  });

  it('reloads and re-subscribes after an event-sequence gap without hanging Auto Start', async () => {
    let recovered = false;
    const listener: {
      current: Parameters<NativeGpuInventoryPort['listen']>[0] | null;
    } = { current: null };
    const loading = snapshot('loading');
    const ready = snapshot('ready');
    const port: NativeGpuInventoryPort = {
      load: vi.fn(async () => recovered ? ready : loading),
      beginRefresh: vi.fn(async () => loading),
      listen: vi.fn(async (input) => {
        listener.current = input;
        return () => { listener.current = null; };
      }),
    };
    const coordinator = new NativeGpuInventoryCoordinator(port);
    const pending = coordinator.refreshForAutoStart({
      expectedImageCount: 450,
      includeEmergencyTier: false,
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(port.beginRefresh).toHaveBeenCalledTimes(1));

    recovered = true;
    listener.current?.onInvalidEvent();

    await expect(pending).resolves.toMatchObject({
      state: 'ready',
      observationId: OBSERVATION,
      receipt: { receiptId: RECEIPT },
    });
    await vi.waitFor(() => expect(port.listen).toHaveBeenCalledTimes(2));
    expect(port.load).toHaveBeenCalledTimes(4);
    coordinator.dispose();
  });
});
