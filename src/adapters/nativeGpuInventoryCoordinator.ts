import {
  type GpuAutoSelectionSourceV1,
  type NativeGpuInventoryEventV1,
  type NativeGpuInventorySnapshotV1,
} from '@imageforge/runpod-client';

export interface NativeGpuInventoryPort {
  load(expectedProcessEpochId?: string): Promise<NativeGpuInventorySnapshotV1>;
  beginRefresh(
    includeEmergencyTier: boolean,
    expectedProcessEpochId?: string,
  ): Promise<NativeGpuInventorySnapshotV1>;
  listen(input: {
    readonly processEpochId: string;
    readonly previousEventSequence: number | null;
    readonly onEvent: (event: NativeGpuInventoryEventV1) => void;
    readonly onInvalidEvent: () => void;
  }): Promise<() => void>;
}

type SnapshotListener = (snapshot: NativeGpuInventorySnapshotV1) => void;

interface PendingObservation {
  readonly observationId: string;
  readonly includeEmergencyTier: boolean;
  readonly resolve: (snapshot: NativeGpuInventorySnapshotV1) => void;
  readonly reject: (reason: unknown) => void;
  readonly cleanup: () => void;
}

const TERMINAL_RECONCILIATION_INTERVAL_MS = 250;
const TERMINAL_RECONCILIATION_TIMEOUT_MS = 30_000;

function aborted(): DOMException {
  return new DOMException('The GPU inventory refresh was cancelled.', 'AbortError');
}

/**
 * Renderer coordinator for the native-owned inventory journal. It never calls
 * RunPod itself, never creates receipt time, and never turns fallback rows
 * into mutation authority.
 */
export class NativeGpuInventoryCoordinator implements GpuAutoSelectionSourceV1 {
  readonly #port: NativeGpuInventoryPort;
  readonly #listeners = new Set<SnapshotListener>();
  readonly #pending = new Map<string, PendingObservation>();
  #snapshot: NativeGpuInventorySnapshotV1 | null = null;
  #unlisten: (() => void) | null = null;
  #initializing: Promise<NativeGpuInventorySnapshotV1> | null = null;
  #recovering: Promise<void> | null = null;
  #bindingGeneration = 0;
  #observationOrder = new Map<string, number>();
  #nextObservationOrder = 0;
  #disposed = false;

  constructor(port: NativeGpuInventoryPort) {
    this.#port = port;
  }

  getSnapshot(): NativeGpuInventorySnapshotV1 | null {
    return this.#snapshot;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.#listeners.add(listener);
    if (this.#snapshot !== null) listener(this.#snapshot);
    return () => this.#listeners.delete(listener);
  }

  async load(): Promise<NativeGpuInventorySnapshotV1> {
    return this.#ensureInitialized();
  }

  async resetForProfileChange(): Promise<NativeGpuInventorySnapshotV1> {
    if (this.#disposed) throw new Error('GPU inventory coordinator is disposed.');
    this.#bindingGeneration += 1;
    this.#unlisten?.();
    this.#unlisten = null;
    this.#snapshot = null;
    this.#observationOrder.clear();
    this.#nextObservationOrder = 0;
    this.#initializing = null;
    this.#recovering = null;
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(new Error('The GPU profile changed before inventory selection completed.'));
    }
    this.#pending.clear();
    return this.#ensureInitialized();
  }

  async beginVisibleRefresh(includeEmergencyTier: boolean): Promise<NativeGpuInventorySnapshotV1> {
    const current = await this.#ensureInitialized();
    const immediate = await this.#port.beginRefresh(
      includeEmergencyTier,
      current.processEpochId,
    );
    const acceptedDuringInvoke = this.#snapshot;
    if (
      acceptedDuringInvoke !== null &&
      acceptedDuringInvoke.observationId === immediate.observationId &&
      acceptedDuringInvoke.state !== 'loading'
    ) {
      return acceptedDuringInvoke;
    }
    this.#markObservation(immediate.observationId);
    if (!this.#accept(immediate)) {
      throw new Error('The requested GPU inventory observation was superseded.');
    }
    return this.#snapshot ?? immediate;
  }

  /**
   * Begin the explicit selector refresh and wait for its matching terminal
   * receipt. The loading projection is still accepted/published immediately,
   * so the UI can render progress, but the caller is never left dependent on
   * receiving the app event in order to obtain the live rows.
   */
  async refreshForVisibleSelector(
    includeEmergencyTier: boolean,
  ): Promise<NativeGpuInventorySnapshotV1> {
    const immediate = await this.beginVisibleRefresh(includeEmergencyTier);
    if (immediate.state !== 'loading') return immediate;
    return this.#waitForTerminalObservation(immediate, includeEmergencyTier);
  }

  async refreshForAutoStart(input: {
    readonly expectedImageCount: number;
    readonly includeEmergencyTier: boolean;
    readonly signal: AbortSignal;
  }): Promise<NativeGpuInventorySnapshotV1> {
    if (!Number.isSafeInteger(input.expectedImageCount) || input.expectedImageCount < 1) {
      throw new TypeError('expectedImageCount must be a positive safe integer.');
    }
    if (input.signal.aborted) throw aborted();
    const immediate = await this.beginVisibleRefresh(input.includeEmergencyTier);
    if (immediate.state !== 'loading') return immediate;
    return this.#waitForTerminalObservation(immediate, input.includeEmergencyTier, input.signal);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unlisten?.();
    this.#unlisten = null;
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(aborted());
    }
    this.#pending.clear();
    this.#listeners.clear();
  }

  async #ensureInitialized(): Promise<NativeGpuInventorySnapshotV1> {
    if (this.#disposed) throw new Error('GPU inventory coordinator is disposed.');
    if (this.#snapshot !== null && this.#unlisten !== null) return this.#snapshot;
    if (this.#recovering !== null) {
      await this.#recovering;
      if (this.#snapshot !== null && this.#unlisten !== null) return this.#snapshot;
    }
    if (this.#initializing !== null) return this.#initializing;
    const operation = this.#initialize().finally(() => {
      if (this.#initializing === operation) this.#initializing = null;
    });
    this.#initializing = operation;
    return operation;
  }

  async #initialize(): Promise<NativeGpuInventorySnapshotV1> {
    const bindingGeneration = this.#bindingGeneration;
    const initial = await this.#port.load();
    if (this.#disposed || bindingGeneration !== this.#bindingGeneration) {
      throw new Error('GPU inventory profile changed during initialization.');
    }
    await this.#installListener(initial.processEpochId, bindingGeneration);
    this.#markObservation(initial.observationId);
    this.#accept(initial);
    // Close the listener-registration race: an event emitted after the first
    // load but before listen attached is recovered from the native journal.
    const current = await this.#port.load(initial.processEpochId);
    if (bindingGeneration !== this.#bindingGeneration) {
      throw new Error('GPU inventory profile changed during initialization.');
    }
    if (this.#accept(current)) this.#settlePendingFromSnapshot(current);
    return this.#snapshot ?? current;
  }

  async #installListener(processEpochId: string, bindingGeneration: number): Promise<void> {
    const unlisten = await this.#port.listen({
      processEpochId,
      // Events are process-scoped but are not replayed. A newly mounted window
      // therefore accepts its first observed positive sequence as the baseline;
      // the bridge enforces exact +1 ordering after that event.
      previousEventSequence: null,
      onEvent: (event) => {
        if (bindingGeneration === this.#bindingGeneration) this.#onEvent(event);
      },
      onInvalidEvent: () => {
        if (bindingGeneration === this.#bindingGeneration) {
          void this.#recoverListener(processEpochId, bindingGeneration);
        }
      },
    });
    if (this.#disposed || bindingGeneration !== this.#bindingGeneration) {
      unlisten();
      throw new Error('GPU inventory profile changed during listener registration.');
    }
    this.#unlisten?.();
    this.#unlisten = unlisten;
  }

  #recoverListener(processEpochId: string, bindingGeneration: number): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (bindingGeneration !== this.#bindingGeneration) return Promise.resolve();
    if (this.#recovering !== null) return this.#recovering;
    const operation = this.#recoverListenerOperation(processEpochId, bindingGeneration).finally(() => {
      if (this.#recovering === operation) this.#recovering = null;
    });
    this.#recovering = operation;
    return operation;
  }

  async #recoverListenerOperation(processEpochId: string, bindingGeneration: number): Promise<void> {
    this.#unlisten?.();
    this.#unlisten = null;
    try {
      const recovered = await this.#port.load(processEpochId);
      if (bindingGeneration !== this.#bindingGeneration) return;
      if (this.#accept(recovered)) this.#settlePendingFromSnapshot(recovered);
      await this.#installListener(processEpochId, bindingGeneration);
      // Close the same load/listen race as initial mount. If the missing event
      // completed the pending observation, the durable terminal snapshot is
      // sufficient; renderer waits never depend on a replayed event.
      const current = await this.#port.load(processEpochId);
      if (bindingGeneration !== this.#bindingGeneration) return;
      if (this.#accept(current)) this.#settlePendingFromSnapshot(current);
    } catch {
      // Preserve the last strict snapshot. Explicit refresh or a later mount
      // can recover; malformed native data never replaces renderer state.
    }
  }

  #waitForTerminalObservation(
    immediate: NativeGpuInventorySnapshotV1,
    includeEmergencyTier: boolean,
    signal?: AbortSignal,
  ): Promise<NativeGpuInventorySnapshotV1> {
    if (signal?.aborted) return Promise.reject(aborted());
    return new Promise<NativeGpuInventorySnapshotV1>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
      let reconciliationInFlight = false;
      const startedAt = Date.now();
      const observationId = immediate.observationId;
      const onAbort = () => {
        const pending = this.#pending.get(observationId);
        if (pending !== undefined) {
          this.#pending.delete(observationId);
          pending.cleanup();
        }
        reject(aborted());
      };
      if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (deadlineTimer !== null) {
          clearTimeout(deadlineTimer);
          deadlineTimer = null;
        }
        signal?.removeEventListener('abort', onAbort);
      };
      const pending: PendingObservation = {
        observationId,
        includeEmergencyTier,
        resolve,
        reject,
        cleanup,
      };
      this.#pending.set(observationId, pending);
      const expire = () => {
        if (this.#pending.get(observationId) !== pending) return;
        this.#pending.delete(observationId);
        pending.cleanup();
        reject(new Error('The native GPU inventory observation did not reach a terminal state in time.'));
      };
      deadlineTimer = setTimeout(expire, TERMINAL_RECONCILIATION_TIMEOUT_MS);
      // Native may emit the terminal event between resolving beginRefresh and
      // installing this renderer waiter. Reconcile immediately from the strict
      // projection so a non-replayed event can never strand a selector or Auto
      // Start request.
      if (this.#snapshot !== null) this.#settlePendingFromSnapshot(this.#snapshot);

      // The event channel is an optimization, not the only delivery path.
      // A native event can be lost while a Tauri listener is being replaced;
      // the native journal remains the authoritative, read-only recovery path.
      // Polling `load` never starts another provider observation or creates
      // mutation authority, and stops as soon as the exact waiter settles.
      const reconcile = async () => {
        if (this.#pending.get(observationId) !== pending || reconciliationInFlight) return;
        reconciliationInFlight = true;
        try {
          const loaded = await this.#port.load(immediate.processEpochId);
          if (this.#pending.get(observationId) !== pending) return;
          if (this.#accept(loaded)) this.#settlePendingFromSnapshot(loaded);
        } catch {
          // Keep listening. A transient native read failure must not replace a
          // strict terminal snapshot or turn an unavailable read into rows.
          if (
            this.#pending.get(observationId) === pending
            && Date.now() - startedAt >= TERMINAL_RECONCILIATION_TIMEOUT_MS
          ) {
            expire();
          }
        } finally {
          reconciliationInFlight = false;
          if (this.#pending.get(observationId) === pending) {
            timer = setTimeout(() => { void reconcile(); }, TERMINAL_RECONCILIATION_INTERVAL_MS);
          }
        }
      };
      void reconcile();
    });
  }

  #onEvent(event: NativeGpuInventoryEventV1): void {
    const pending = this.#pending.get(event.observationId);
    const accepted = !event.superseded && this.#accept(event.snapshot);
    if (pending === undefined) {
      if (accepted) this.#settlePendingFromSnapshot(event.snapshot);
      return;
    }
    if (accepted && event.snapshot.state !== 'loading') {
      this.#settlePendingFromSnapshot(event.snapshot);
      return;
    }
    if (
      accepted
      && event.snapshot.state === 'loading'
      && event.snapshot.includeEmergencyTier === pending.includeEmergencyTier
    ) {
      // Loading is progress, not selector authority. Keep the waiter alive
      // until the matching terminal journal snapshot carries live rows.
      return;
    }
    this.#pending.delete(event.observationId);
    pending.cleanup();
    if (
      event.superseded
      || !accepted
      || event.snapshot.includeEmergencyTier !== pending.includeEmergencyTier
    ) {
      pending.reject(new Error('The requested GPU inventory observation was superseded.'));
      return;
    }
    pending.resolve(event.snapshot);
  }

  #settlePendingFromSnapshot(snapshot: NativeGpuInventorySnapshotV1): void {
    if (snapshot.state === 'loading') return;
    for (const [observationId, pending] of this.#pending) {
      this.#pending.delete(observationId);
      pending.cleanup();
      if (
        observationId !== snapshot.observationId ||
        snapshot.includeEmergencyTier !== pending.includeEmergencyTier
      ) {
        pending.reject(new Error('The requested GPU inventory observation was superseded.'));
      } else {
        pending.resolve(snapshot);
      }
    }
  }

  #markObservation(observationId: string): void {
    if (!this.#observationOrder.has(observationId)) {
      this.#nextObservationOrder += 1;
      this.#observationOrder.set(observationId, this.#nextObservationOrder);
    }
  }

  #accept(snapshot: NativeGpuInventorySnapshotV1): boolean {
    this.#markObservation(snapshot.observationId);
    const current = this.#snapshot;
    if (current !== null && current.processEpochId === snapshot.processEpochId) {
      const currentOrder = this.#observationOrder.get(current.observationId);
      const candidateOrder = this.#observationOrder.get(snapshot.observationId);
      if (
        currentOrder !== undefined
        && candidateOrder !== undefined
        && candidateOrder < currentOrder
      ) {
        return false;
      }
    }
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener(snapshot);
    return true;
  }
}
