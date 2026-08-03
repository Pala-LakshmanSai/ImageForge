import type { RunPodSnapshot, StopGuardDecision } from '@imageforge/runpod-client';
import type {
  AppState,
  BatchState,
  CredentialKind,
  CredentialMetadata,
  CredentialMetadataMap,
  LibraryAsset,
  PodState,
  StudioSyncState,
} from '../domain/types';
import type { NativeDestinationMetadata } from '../native/tauriBridge';
import {
  GpuLifecycleCoordinator,
  type GpuLifecycleNativePort,
} from './gpuLifecycleCoordinator';
import {
  type ConnectionTestInput,
  type DownloadAssetRequest,
  type ImageForgeAdapter,
  type ValidatedImageResponse,
  parseStudioProfile,
} from './imageForgeAdapter';
import {
  WorkerBatchCoordinator,
  isWorkerLocalSyncError,
  type LocalDownloadReceipt,
  type WorkerBatchEvent,
  type WorkerBatchPort,
  type WorkerHttpResult,
} from './workerBatchCoordinator';
import {
  projectBusyBatch,
  projectOwnedManifest,
  projectPodSnapshot,
  type BatchPresentationContext,
} from './runtimeProjection';
import {
  StudioContractError,
  projectStudioState,
  requireStudioState,
  validateFinalizationGrant,
  type StudioState,
} from './studioContracts';

export interface ProductionDesktopPort extends GpuLifecycleNativePort, WorkerBatchPort {
  chooseDestination(defaultPath: string): Promise<NativeDestinationMetadata | null>;
  validateDestination(path: string): Promise<NativeDestinationMetadata>;
  credentialMetadata(): Promise<CredentialMetadataMap>;
  replaceCredential(kind: CredentialKind, value: string): Promise<CredentialMetadata>;
  createMarkerMetadata(): Promise<{
    pending: boolean;
    attemptId: string | null;
    podName: string | null;
    gpuId: string | null;
    podId: string | null;
  }>;
  resolveCreateMarker(attemptId: string, reconciledPodId: string | null): Promise<void>;
  reconcileReceipts(batchId: string): Promise<unknown>;
  revealDestination(relativePath?: string): Promise<void>;
  writeManifest(batchId: string, content: string): Promise<string>;
  fetchPreview(batchId: string, index: number): Promise<ValidatedImageResponse>;
  downloadAsset(request: DownloadAssetRequest): Promise<string | null>;
  studioHeartbeat(sessionId: string, availability: 'foreground' | 'background'): Promise<WorkerHttpResult>;
  studioStatus(sessionId: string): Promise<WorkerHttpResult>;
  studioCreateStopRequest(requestId: string, sessionId: string, podId: string, gpuDisplayName: string): Promise<WorkerHttpResult>;
  studioRespondToStopRequest(requestId: string, sessionId: string, decision: 'approve' | 'deny'): Promise<WorkerHttpResult>;
  studioFinalizeStopRequest(requestId: string, sessionId: string, podId: string, finalizationId: string): Promise<WorkerHttpResult>;
  studioCancelStopRequest(requestId: string, sessionId: string, podId: string, finalizationId: string | null): Promise<WorkerHttpResult>;
}

export type ProductionRuntimeEvent =
  | { type: 'pod'; pod: PodState }
  | { type: 'batch'; batch: BatchState; assets: LibraryAsset[] }
  | { type: 'library'; assets: LibraryAsset[] }
  | { type: 'busy'; batch: BatchState }
  | { type: 'idle' }
  | { type: 'create-recovery'; marker: PodState['createRecovery'] }
  | { type: 'studio'; studio: StudioSyncState }
  | { type: 'stop-blocked'; owner: string; completed: number; total: number; message: string }
  | { type: 'stop-guard-active'; podId: string | null; message: string }
  | { type: 'stop-failed'; message: string; retryable: boolean }
  | { type: 'stop-complete'; alreadyStopped: boolean }
  | { type: 'local-error'; batchId: string; code: string; message: string; retryable: boolean }
  | { type: 'notice'; tone: 'info' | 'success' | 'warning'; title: string; message: string }
  | { type: 'error'; scope: 'pod' | 'batch'; code?: string; message: string; retryable: boolean };

function recoveredBatchName(
  batchId: string,
  receipts: readonly { filename: string }[],
): string | null {
  if (receipts.length === 0) return null;
  const folders = new Set(receipts.map((receipt) => receipt.filename.split('/')[1]));
  if (folders.size !== 1) return null;
  const [folder] = folders;
  return folder && folder !== batchId ? folder : null;
}

function projectRecoveredLibrary(
  batchId: string,
  batchName: string,
  destination: string,
  receipts: readonly LocalDownloadReceipt[],
): LibraryAsset[] {
  return receipts.map((receipt) => {
    const createdAt = new Date(receipt.verifiedAtUnixMs);
    if (
      receipt.batchId !== batchId
      || !Number.isSafeInteger(receipt.index)
      || receipt.index < 1
      || !Number.isSafeInteger(receipt.verifiedAtUnixMs)
      || receipt.verifiedAtUnixMs < 0
      || !/^[0-9a-f]{64}$/i.test(receipt.sha256)
      || Number.isNaN(createdAt.valueOf())
    ) {
      throw new Error('A restored local receipt is invalid.');
    }
    return {
      id: `${batchId}-${receipt.index}`,
      batchId,
      batchName,
      index: receipt.index,
      prompt: `Saved image ${String(receipt.index).padStart(3, '0')}`,
      seed: receipt.index,
      filename: receipt.filename,
      checksum: receipt.sha256,
      createdAt: createdAt.toISOString(),
      durationSeconds: 0,
      destination,
      palette: receipt.index % 6,
      recovered: true,
    };
  });
}

export interface ProductionRuntimeFacade {
  subscribe(listener: (event: ProductionRuntimeEvent) => void): () => void;
  /** Returns the last Pod state observed by the authoritative RunPod refresh. */
  getAuthoritativePodState?(): PodState | null;
  restoreLocalLibrary(state: AppState): Promise<void>;
  refresh(state: AppState): Promise<void>;
  observe(state: AppState): Promise<void>;
  heartbeat(state: AppState, availability: 'foreground' | 'background'): Promise<void>;
  startGpu(state: AppState): Promise<void>;
  requestGpuStop(state: AppState): Promise<void>;
  respondToGpuStop(requestId: string, decision: 'approve' | 'deny'): Promise<void>;
  cancelGpuStop(requestId: string): Promise<void>;
  startBatch(state: AppState): Promise<void>;
  pollBatch(state: AppState): Promise<void>;
  beginNewBatch(): void;
  controlBatch(
    action: 'pause' | 'resume' | 'cancel' | 'retry_failed',
    state: AppState,
  ): Promise<void>;
  resolveAmbiguousStart(): Promise<void>;
  dispose(): void;
}

class ProductionRuntime implements ProductionRuntimeFacade {
  readonly #port: ProductionDesktopPort;
  readonly #gpu: GpuLifecycleCoordinator;
  readonly #worker: WorkerBatchCoordinator;
  readonly #listeners = new Set<(event: ProductionRuntimeEvent) => void>();
  #pod: PodState | null = null;
  #podAuthorityEstablished = false;
  #presentation: BatchPresentationContext | null = null;
  #unsubscribeGpu: () => void;
  #unsubscribeWorker: () => void;
  #recoveredBatchId: string | null;
  #recoveredBatchName: string | null;
  #reconciledRecoveredBatch = false;
  #localLibraryRestored = false;
  #localLibraryRestore: Promise<void> | null = null;
  #pollBatchInFlight: Promise<void> | null = null;
  #deferWorkerError = false;
  #deferredWorkerError: Extract<WorkerBatchEvent, { type: 'error' }> | null = null;
  #recoveryDestination: string | null = null;
  readonly #sessionId: string;
  #studio: StudioState | null = null;
  #studioSequence = 0;
  #acceptedStudioSequence = 0;
  #heartbeatInFlight: Promise<void> | null = null;
  #pendingHeartbeatAvailability: 'foreground' | 'background' | null = null;
  #workerStopGuardActive = false;
  #stopFinalization: Promise<void> | null = null;
  #pendingFinalization: {
    serverInstanceId: string;
    approvedCoordinationRevision: number;
    requestId: string;
    podId: string;
    finalizationId: string;
  } | null = null;
  #stopGuardAttempted = false;
  #stopGuardConsumed = false;
  #stopGuardDefinitivelyInvalid = false;

  constructor(
    port: ProductionDesktopPort,
    recoveredBatchId: string | null = null,
    recoveredBatchName: string | null = null,
  ) {
    this.#port = port;
    this.#sessionId = crypto.randomUUID();
    this.#recoveredBatchId = recoveredBatchId;
    this.#recoveredBatchName = recoveredBatchName;
    this.#gpu = new GpuLifecycleCoordinator(
      port,
      undefined,
      ({ podId }) => this.#consumeStopGuard(podId),
    );
    this.#worker = new WorkerBatchCoordinator(
      port,
      recoveredBatchId,
      (batchId) => this.#prepareRecoveredLocalBatch(batchId),
    );
    if (recoveredBatchName !== null) this.#worker.setBatchName(recoveredBatchName);
    this.#unsubscribeGpu = this.#gpu.subscribe((snapshot) => this.#onPodSnapshot(snapshot));
    this.#unsubscribeWorker = this.#worker.subscribe((event) => this.#onWorkerEvent(event));
  }

  subscribe(listener: (event: ProductionRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getAuthoritativePodState(): PodState | null {
    return this.#pod;
  }

  async restoreLocalLibrary(state: AppState): Promise<void> {
    if (this.#recoveredBatchId === null || this.#localLibraryRestored) return;
    if (this.#localLibraryRestore !== null) return this.#localLibraryRestore;
    this.#captureState(state);
    // This is a read-only device-local Library projection and remains
    // available offline. Worker acknowledgement/reconciliation is separate
    // and stays behind status-confirmed ownership in #prepareRecoveredLocalBatch.
    const operation = this.#restoreLocalLibrary(state);
    this.#localLibraryRestore = operation;
    try {
      await operation;
    } catch (error) {
      const safe = runtimeError(
        error,
        'local_library_unavailable',
        'The previous local ImageForge library could not be restored yet.',
      );
      this.#emit({
        type: 'local-error',
        batchId: this.#recoveredBatchId,
        code: safe.code ?? 'local_library_unavailable',
        message: safe.message,
        retryable: safe.retryable,
      });
      throw error;
    } finally {
      if (this.#localLibraryRestore === operation) this.#localLibraryRestore = null;
    }
  }

  async refresh(state: AppState): Promise<void> {
    this.#captureState(state);
    this.#worker.invalidateReceipts();
    let snapshot: RunPodSnapshot;
    try {
      const count = state.batch?.prompts.length || state.draft.prompts.length || 450;
      snapshot = await this.#gpu.refresh(
        state.setup.studioProfile,
        count,
        state.settings.slowEmergencyGpuEnabled,
      );
    } catch (error) {
      await this.#clearControllerLatchIfNoDurableMarker();
      await this.#emitCurrentCreateMarker();
      this.#emitError('pod', error, 'ImageForge could not refresh RunPod safely.');
      throw error;
    }
    await this.#reconcileCreateMarker(snapshot);
    if (snapshot.phase === 'offline') {
      // A successful authoritative Pod discovery can prove that another
      // client stopped compute. Drop the native proxy/session binding too;
      // otherwise a later worker poll could keep using the old Pod identity.
      await this.#port.clearWorkerSession();
    }
    if (snapshot.phase === 'ready') {
      // A worker outage must not obscure the still-live billed Pod. The worker
      // coordinator emits a retryable batch event and the UI keeps Stop visible.
      // Reuse the routine poll path so a Pod that disappears after RunPod's
      // first Ready response is immediately reconciled instead of surfacing as
      // a misleading worker/schema failure during Generate preflight.
      await this.pollBatch(state);
    }
  }

  async observe(state: AppState): Promise<void> {
    this.#captureState(state);
    const count = state.batch?.prompts.length || state.draft.prompts.length || 450;
    const snapshot = await this.#gpu.observe(
      state.setup.studioProfile,
      count,
      state.settings.slowEmergencyGpuEnabled,
    );
    if (snapshot.phase === 'offline') await this.#port.clearWorkerSession();
  }

  heartbeat(state: AppState, availability: 'foreground' | 'background'): Promise<void> {
    this.#captureState(state);
    // Coalesce transport work without dropping the newest visibility state. A
    // foreground event arriving behind an in-flight background heartbeat (or
    // vice versa) is flushed immediately after the current request settles.
    this.#pendingHeartbeatAvailability = availability;
    if (this.#heartbeatInFlight !== null) return this.#heartbeatInFlight;
    const operation = this.#flushPendingHeartbeats().finally(() => {
      if (this.#heartbeatInFlight === operation) this.#heartbeatInFlight = null;
    });
    this.#heartbeatInFlight = operation;
    return operation;
  }

  async #flushPendingHeartbeats(): Promise<void> {
    while (this.#pendingHeartbeatAvailability !== null) {
      const availability = this.#pendingHeartbeatAvailability;
      this.#pendingHeartbeatAvailability = null;
      await this.#heartbeat(availability);
    }
  }

  async #heartbeat(availability: 'foreground' | 'background'): Promise<void> {
    const sequence = this.#nextStudioSequence();
    const studio = requireStudioState(
      await this.#port.studioHeartbeat(this.#sessionId, availability),
      [200],
    );
    if (!this.#acceptStudio(studio, sequence)) return;
    await this.#maybeFinalizeApprovedStop();
  }

  async startGpu(state: AppState): Promise<void> {
    this.#captureState(state);
    try {
      const count = state.batch?.prompts.length || state.draft.prompts.length || 450;
      const marker = await this.#portMarker();
      if (marker !== null) {
        this.#emit({ type: 'create-recovery', marker });
        throw new Error('Resolve the interrupted RunPod create before starting another GPU.');
      }
      const snapshot = await this.#gpu.start(
        state.setup.studioProfile,
        count,
        state.settings.slowEmergencyGpuEnabled,
      );
      await this.#reconcileCreateMarker(snapshot);
    } catch (error) {
      await this.#clearControllerLatchIfNoDurableMarker();
      await this.#emitCurrentCreateMarker();
      this.#emitError('pod', error, 'ImageForge could not start a GPU safely.');
      throw error;
    }
    try {
      await this.#worker.poll();
    } catch (error) {
      if (!isWorkerLocalSyncError(error)) throw error;
    }
  }

  async requestGpuStop(state: AppState): Promise<void> {
    this.#captureState(state);
    const expectedPodId = state.pod.podId;
    if (expectedPodId === null) throw new Error('No verified ImageForge Pod is selected.');
    const gpuDisplayName = state.pod.gpu ?? 'ImageForge GPU';
    try {
      // A heartbeat establishes this ephemeral session and obtains the latest
      // worker epoch before the explicit stop request is created.
      await this.heartbeat(state, 'foreground');
      const requestId = crypto.randomUUID();
      const sequence = this.#nextStudioSequence();
      const studio = requireStudioState(
        await this.#port.studioCreateStopRequest(
          requestId,
          this.#sessionId,
          expectedPodId,
          gpuDisplayName,
        ),
        [201],
      );
      if (this.#acceptStudio(studio, sequence)) await this.#maybeFinalizeApprovedStop();
    } catch (error) {
      if (error instanceof StudioContractError && error.code === 'stop_blocked_by_active_batch') {
        const owner = safeDetailString(error.details?.owner) ?? 'Another editor';
        const completed = safeDetailInteger(error.details?.completed);
        const total = safeDetailInteger(error.details?.total);
        this.#emit({
          type: 'stop-blocked',
          owner,
          completed,
          total,
          message: error.message,
        });
        return;
      }
      if (error instanceof StudioContractError && error.code === 'stop_request_in_progress') {
        try {
          const sequence = this.#nextStudioSequence();
          const studio = requireStudioState(await this.#port.studioStatus(this.#sessionId), [200]);
          if (this.#acceptStudio(studio, sequence)) await this.#maybeFinalizeApprovedStop();
          return;
        } catch (statusError) {
          this.#emitStopFailure(statusError, 'The existing GPU stop request could not be synchronized.');
          return;
        }
      }
      this.#emitStopFailure(error, 'ImageForge could not coordinate GPU termination. The GPU remains running.');
    }
  }

  async respondToGpuStop(requestId: string, decision: 'approve' | 'deny'): Promise<void> {
    try {
      const sequence = this.#nextStudioSequence();
      const studio = requireStudioState(
        await this.#port.studioRespondToStopRequest(requestId, this.#sessionId, decision),
        [200],
      );
      this.#acceptStudio(studio, sequence);
    } catch (error) {
      this.#emitStopFailure(error, 'Your GPU stop response could not be confirmed. The GPU remains running.');
    }
  }

  async cancelGpuStop(requestId: string): Promise<void> {
    try {
      const request = this.#studio?.stopRequest;
      const currentPodId = this.#pod?.podId ?? null;
      if (request === null || request === undefined || request.requestId !== requestId) {
        throw {
          code: 'stop_request_mismatch',
          message: 'The synchronized GPU stop request changed before cancellation. Refresh shared status.',
          retryable: false,
        };
      }
      if (currentPodId === null || request.podId !== currentPodId) {
        throw {
          code: 'termination_target_mismatch',
          message: 'The synchronized GPU stop request belongs to another Pod. No cancellation was sent.',
          retryable: false,
        };
      }
      const sequence = this.#nextStudioSequence();
      const studio = requireStudioState(
        await this.#port.studioCancelStopRequest(
          requestId,
          this.#sessionId,
          request.podId,
          request.finalizationId,
        ),
        [200],
      );
      this.#acceptStudio(studio, sequence);
    } catch (error) {
      this.#emitStopFailure(error, 'The GPU stop request could not be cancelled. Refresh shared status before trying again.');
    }
  }

  async startBatch(state: AppState): Promise<void> {
    this.#captureState(state);
    const batch = state.batch;
    if (batch === null || batch.phase !== 'validating') {
      throw new Error('A validated local batch is required before worker submission.');
    }
    this.#presentation = {
      name: batch.name,
      destination: batch.destination,
      estimatedSecondsPerImage: batch.estimatedSecondsPerImage,
      hourlyRate: this.#pod?.hourlyRate ?? null,
    };
    try {
      await this.#worker.create(
        batch.prompts.map((prompt) => prompt.text),
        batch.prompts[0]?.seed ?? 0,
        batch.references ?? [],
        batch.aspectRatio,
        batch.name,
      );
    } catch (error) {
      if (isWorkerLocalSyncError(error)) return;
      // A remote Stop can land after the strict Generate preflight but before
      // the worker POST settles. Reconcile the authoritative lifecycle once
      // more so the Pod's offline event interrupts the provisional batch and
      // supersedes the secondary proxy/schema error only when absence is
      // actually proven by RunPod.
      if (await this.#workerFailureWasRemoteStop(state)) return;
      this.#emitError('batch', error, 'ImageForge could not create the batch.');
      throw error;
    }
  }

  pollBatch(state: AppState): Promise<void> {
    this.#captureState(state);
    if (this.#pollBatchInFlight !== null) return this.#pollBatchInFlight;
    const operation = this.#pollBatch(state).finally(() => {
      if (this.#pollBatchInFlight === operation) this.#pollBatchInFlight = null;
    });
    this.#pollBatchInFlight = operation;
    return operation;
  }

  async #pollBatch(state: AppState): Promise<void> {
    this.#deferWorkerError = true;
    this.#deferredWorkerError = null;
    try {
      await this.#worker.poll();
    } catch (error) {
      if (isWorkerLocalSyncError(error)) return;
      if (await this.#workerFailureWasRemoteStop(state)) {
        // The worker failure was only a symptom of another client stopping the
        // shared Pod. The authoritative Pod event already moved the UI offline;
        // do not overwrite it with a stale schema/proxy error.
        this.#deferredWorkerError = null;
        return;
      }
      this.#flushDeferredWorkerError();
      throw error;
    } finally {
      this.#deferWorkerError = false;
      this.#deferredWorkerError = null;
    }
  }

  beginNewBatch(): void {
    this.#worker.forgetBatch();
    this.#recoveredBatchId = null;
    this.#recoveredBatchName = null;
    this.#reconciledRecoveredBatch = true;
    this.#localLibraryRestored = true;
    this.#localLibraryRestore = null;
    this.#presentation = null;
  }

  async controlBatch(
    action: 'pause' | 'resume' | 'cancel' | 'retry_failed',
    state: AppState,
  ): Promise<void> {
    this.#captureState(state);
    try {
      await this.#worker.control(action);
    } catch (error) {
      this.#emitError('batch', error, 'The batch control request could not be confirmed.');
      throw error;
    }
  }

  async resolveAmbiguousStart(): Promise<void> {
    const marker = await this.#portMarker();
    if (marker === null) throw new Error('There is no interrupted RunPod create to resolve.');
    try {
      this.#gpu.resolveAmbiguousStart();
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('no unresolved GPU start')) throw error;
    }
    await this.#port.resolveCreateMarker(marker.attemptId, null);
    this.#emit({ type: 'create-recovery', marker: null });
  }

  #nextStudioSequence(): number {
    this.#studioSequence += 1;
    return this.#studioSequence;
  }

  #acceptStudio(studio: StudioState, sequence: number): boolean {
    // RunPod is the lifecycle authority. A worker response issued before an
    // authoritative Offline observation can arrive after the native session
    // clear because the pinned request is allowed to finish first. Never let
    // that old epoch revive presence or a finalization request.
    if (this.#pod === null || this.#pod.phase === 'offline') return false;
    if (sequence < this.#acceptedStudioSequence) return false;
    if (
      this.#studio !== null
      && studio.serverInstanceId === this.#studio.serverInstanceId
      && studio.coordinationRevision < this.#studio.coordinationRevision
    ) {
      return false;
    }
    if (this.#studio !== null && studio.serverInstanceId !== this.#studio.serverInstanceId) {
      // A worker restart is a new coordination epoch. Never carry a deletion
      // grant across it, even if a prior request completes later.
      this.#pendingFinalization = null;
      this.#stopGuardAttempted = false;
      this.#stopGuardConsumed = false;
      this.#stopGuardDefinitivelyInvalid = false;
    }
    this.#acceptedStudioSequence = sequence;
    this.#studio = studio;
    this.#emit({ type: 'studio', studio: projectStudioState(studio) });
    // A shared finalization marker can survive a worker restart even though
    // the ephemeral studio request does not. Preserve the independently
    // observed worker admission veto across an otherwise idle heartbeat.
    if (this.#workerStopGuardActive && studio.stopRequest === null) {
      this.#emit({
        type: 'stop-guard-active',
        podId: this.#pod?.podId ?? null,
        message: 'GPU Stop is finalizing; new generation is temporarily blocked.',
      });
    }
    return true;
  }

  async #maybeFinalizeApprovedStop(): Promise<void> {
    const studio = this.#studio;
    if (studio === null) return;
    const request = studio.stopRequest;
    if (
      request === null
      || request.state !== 'approved'
      || request.requester.sessionId !== studio.currentSession.sessionId
    ) {
      return;
    }
    if (this.#stopFinalization !== null) return this.#stopFinalization;
    if (this.#pod?.podId !== request.podId) {
      this.#emitStopFailure(
        { code: 'termination_target_mismatch', message: 'The confirmed Pod changed before final authorization.', retryable: false },
        'The confirmed Pod changed before final authorization.',
      );
      return;
    }
    const finalizationId = crypto.randomUUID();
    this.#pendingFinalization = {
      serverInstanceId: studio.serverInstanceId,
      approvedCoordinationRevision: studio.coordinationRevision,
      requestId: request.requestId,
      podId: request.podId,
      finalizationId,
    };
    this.#stopGuardAttempted = false;
    this.#stopGuardConsumed = false;
    this.#stopGuardDefinitivelyInvalid = false;
    const operation = this.#finalizeApprovedStop(request.requestId, request.podId, finalizationId)
      .finally(() => {
        if (this.#stopFinalization === operation) this.#stopFinalization = null;
      });
    this.#stopFinalization = operation;
    return operation;
  }

  async #finalizeApprovedStop(requestId: string, podId: string, finalizationId: string): Promise<void> {
    try {
      const result = await this.#gpu.stop(podId);
      this.#pendingFinalization = null;
      this.#stopGuardAttempted = false;
      this.#stopGuardConsumed = false;
      this.#stopGuardDefinitivelyInvalid = false;
      this.#emit({ type: 'stop-complete', alreadyStopped: result.alreadyStopped });
    } catch (error) {
      const ambiguous = typeof error === 'object'
        && error !== null
        && (error as { mayHaveSucceeded?: unknown }).mayHaveSucceeded === true;
      const guardAttempted = this.#stopGuardAttempted;
      const guardConsumed = this.#stopGuardConsumed;
      const guardDefinitivelyInvalid = this.#stopGuardDefinitivelyInvalid;
      if (!ambiguous && (!guardAttempted || guardConsumed || guardDefinitivelyInvalid)) {
        try {
          const sequence = this.#nextStudioSequence();
          const studio = requireStudioState(
            await this.#port.studioCancelStopRequest(
              requestId,
              this.#sessionId,
              podId,
              guardConsumed || guardDefinitivelyInvalid ? finalizationId : null,
            ),
            [200],
          );
          this.#acceptStudio(studio, sequence);
        } catch {
          // The original stop failure remains authoritative. A worker-side
          // finalization grant also expires on its own bounded TTL.
        }
      }
      this.#pendingFinalization = null;
      this.#stopGuardAttempted = false;
      this.#stopGuardConsumed = false;
      this.#stopGuardDefinitivelyInvalid = false;
      if (guardAttempted && !guardConsumed && !guardDefinitivelyInvalid) {
        const synchronized = await this.#synchronizeStudioStatus();
        if (
          synchronized?.stopRequest !== null
          && synchronized?.stopRequest !== undefined
          && ['pending', 'denied', 'expired', 'cancelled'].includes(synchronized.stopRequest.state)
        ) {
          return;
        }
      }
      this.#emitStopFailure(
        error,
        ambiguous
          ? 'RunPod did not confirm whether termination completed. ImageForge will not claim the GPU stopped; refresh shared status.'
          : 'The exact GPU was not terminated. The approval guard was cancelled or will expire safely.',
      );
    }
  }

  async #consumeStopGuard(podId: string): Promise<StopGuardDecision> {
    const pending = this.#pendingFinalization;
    if (pending === null || pending.podId !== podId) {
      return {
        allow: false,
        code: 'stop_guard_failed',
        message: 'The GPU stop approval is missing or belongs to another Pod.',
        retryable: false,
      };
    }
    this.#stopGuardAttempted = true;
    const finalizeStartedAt = Date.now();
    try {
      const sequence = this.#nextStudioSequence();
      const studio = requireStudioState(
        await this.#port.studioFinalizeStopRequest(
          pending.requestId,
          this.#sessionId,
          pending.podId,
          pending.finalizationId,
        ),
        [200],
      );
      const validation = validateFinalizationGrant(
        studio,
        {
          serverInstanceId: pending.serverInstanceId,
          approvedCoordinationRevision: pending.approvedCoordinationRevision,
          sessionId: this.#sessionId,
          requestId: pending.requestId,
          podId,
          finalizationId: pending.finalizationId,
        },
        Date.now() - finalizeStartedAt,
      );
      if (!validation.valid) {
        this.#stopGuardDefinitivelyInvalid = true;
        return {
          allow: false,
          code: 'stop_guard_failed',
          message: `The worker returned an invalid GPU deletion guard (${validation.reason}).`,
          retryable: false,
        };
      }
      if (!this.#acceptStudio(studio, sequence)) {
        // A newer heartbeat or mutation won the race. Only that accepted
        // state may authorize DELETE, and it must expose the same exact grant.
        const acceptedValidation = this.#studio === null
          ? { valid: false as const, reason: 'revision_stale' as const }
          : validateFinalizationGrant(
              this.#studio,
              {
                serverInstanceId: pending.serverInstanceId,
                approvedCoordinationRevision: pending.approvedCoordinationRevision,
                sessionId: this.#sessionId,
                requestId: pending.requestId,
                podId,
                finalizationId: pending.finalizationId,
              },
              Date.now() - finalizeStartedAt,
            );
        if (!acceptedValidation.valid) {
          this.#stopGuardDefinitivelyInvalid = true;
          return {
            allow: false,
            code: 'stop_guard_failed',
            message: `A newer shared state invalidated the GPU deletion guard (${acceptedValidation.reason}).`,
            retryable: false,
          };
        }
      }
      this.#stopGuardConsumed = true;
      return { allow: true };
    } catch (error) {
      if (error instanceof StudioContractError && error.status === 200) {
        this.#stopGuardDefinitivelyInvalid = true;
      }
      const safe = runtimeError(error, 'stop_guard_failed', 'GPU stop authorization failed; the GPU remains running.');
      const code = error instanceof StudioContractError
        ? stopGuardCode(error.code, this.#studio?.stopRequest?.state ?? null)
        : 'stop_guard_failed';
      return {
        allow: false,
        code,
        message: safe.message,
        retryable: safe.retryable,
        ...(error instanceof StudioContractError
          ? { details: safePrimitiveDetails(error.details) }
          : {}),
      };
    }
  }

  #emitStopFailure(error: unknown, fallback: string): void {
    const safe = runtimeError(error, 'stop_guard_failed', fallback);
    this.#emit({ type: 'stop-failed', message: safe.message, retryable: safe.retryable });
  }

  async #synchronizeStudioStatus(): Promise<StudioState | null> {
    try {
      const sequence = this.#nextStudioSequence();
      const studio = requireStudioState(await this.#port.studioStatus(this.#sessionId), [200]);
      this.#acceptStudio(studio, sequence);
      return studio;
    } catch {
      return null;
    }
  }

  dispose(): void {
    this.#unsubscribeGpu();
    this.#unsubscribeWorker();
    this.#gpu.dispose();
    this.#listeners.clear();
  }

  #captureState(state: AppState): void {
    // AppState is a presentation snapshot and can lag an authoritative
    // RunPod observation by a render. Seed from it only until this runtime has
    // observed RunPod itself; otherwise a later call carrying stale Ready data
    // could revive the worker epoch after Offline was already proven.
    if (!this.#podAuthorityEstablished) this.#pod = state.pod;
    this.#recoveryDestination = state.settings.defaultDestination;
    if (state.batch && state.batch.phase !== 'locked') {
      this.#worker.setBatchName(state.batch.name);
      this.#presentation = {
        name: state.batch.name,
        destination: state.batch.destination,
        estimatedSecondsPerImage: state.batch.estimatedSecondsPerImage,
        hourlyRate: state.pod.hourlyRate,
      };
    } else if (this.#presentation === null) {
      this.#presentation = {
        name: this.#recoveredBatchName ?? 'Recovered ImageForge batch',
        destination: state.settings.defaultDestination,
        estimatedSecondsPerImage: 8.4,
        hourlyRate: state.pod.hourlyRate,
      };
    }
  }

  async #workerFailureWasRemoteStop(state: AppState): Promise<boolean> {
    let snapshot: RunPodSnapshot;
    try {
      const count = state.batch?.prompts.length || state.draft.prompts.length || 450;
      snapshot = await this.#gpu.observe(
        state.setup.studioProfile,
        count,
        state.settings.slowEmergencyGpuEnabled,
      );
    } catch {
      return false;
    }
    if (snapshot.phase !== 'offline') return false;
    await this.#port.clearWorkerSession();
    return true;
  }

  async #portMarker(): Promise<NonNullable<PodState['createRecovery']> | null> {
    const metadata = await this.#port.createMarkerMetadata();
    if (!metadata.pending) return null;
    if (metadata.attemptId === null) {
      throw new Error('The native RunPod create marker is incomplete.');
    }
    return {
      attemptId: metadata.attemptId,
      podName: metadata.podName,
      gpuId: metadata.gpuId,
      podId: metadata.podId,
    };
  }

  async #prepareRecoveredLocalBatch(batchId: string): Promise<void> {
    if (batchId !== this.#recoveredBatchId || this.#reconciledRecoveredBatch) return;
    const destination = this.#recoveryDestination;
    if (destination === null) {
      throw {
        code: 'destination_unavailable',
        message: 'Choose and verify a writable ImageForge downloads folder.',
        retryable: true,
      };
    }
    // This hook runs only after /v1/status and an owned manifest have been
    // confirmed by WorkerBatchCoordinator. Device-local recovery therefore
    // cannot hide shared Ready/busy truth on another computer.
    await this.#port.validateDestination(destination);
    await this.#port.reconcileReceipts(batchId);
    this.#reconciledRecoveredBatch = true;
  }

  async #restoreLocalLibrary(state: AppState): Promise<void> {
    const batchId = this.#recoveredBatchId;
    if (batchId === null) return;
    await this.#port.validateDestination(state.settings.defaultDestination);
    const receipts = await this.#port.readReceipts(
      batchId,
      this.#recoveredBatchName ?? undefined,
    );
    if (receipts.length === 0) {
      this.#localLibraryRestored = true;
      return;
    }
    const batchName = this.#recoveredBatchName ?? recoveredBatchName(batchId, receipts);
    if (batchName === null) return;
    this.#recoveredBatchName = batchName;
    this.#worker.setBatchName(batchName);
    if (this.#presentation === null || this.#presentation.name === 'Recovered ImageForge batch') {
      this.#presentation = {
        name: batchName,
        destination: state.settings.defaultDestination,
        estimatedSecondsPerImage: 8.4,
        hourlyRate: state.pod.hourlyRate,
      };
    }
    this.#localLibraryRestored = true;
    this.#emit({
      type: 'library',
      assets: projectRecoveredLibrary(
        batchId,
        batchName,
        state.settings.defaultDestination,
        receipts,
      ),
    });
  }

  async #emitCurrentCreateMarker(): Promise<void> {
    try {
      this.#emit({ type: 'create-recovery', marker: await this.#portMarker() });
    } catch {
      // The original lifecycle failure remains the authoritative error.
    }
  }

  async #clearControllerLatchIfNoDurableMarker(): Promise<void> {
    try {
      if (await this.#portMarker() !== null) return;
      this.#gpu.resolveAmbiguousStart();
    } catch (error) {
      // No in-memory latch is the normal path. Any durable marker remains
      // authoritative and is surfaced by #emitCurrentCreateMarker.
      if (!(error instanceof Error) || !error.message.includes('no unresolved GPU start')) return;
    }
  }

  async #reconcileCreateMarker(snapshot: RunPodSnapshot): Promise<void> {
    const marker = await this.#portMarker();
    if (marker === null) {
      this.#emit({ type: 'create-recovery', marker: null });
      return;
    }
    const exactMatches = snapshot.pods.filter((pod) =>
      (marker.podId !== null && pod.id === marker.podId) ||
      (marker.podId === null && marker.podName !== null && pod.name === marker.podName),
    );
    if (exactMatches.length === 1) {
      await this.#port.resolveCreateMarker(marker.attemptId, exactMatches[0].id);
      this.#emit({ type: 'create-recovery', marker: null });
      return;
    }
    this.#emit({ type: 'create-recovery', marker });
  }

  #onPodSnapshot(snapshot: RunPodSnapshot): void {
    if (this.#pod === null) return;
    this.#podAuthorityEstablished = true;
    this.#pod = projectPodSnapshot(snapshot, this.#pod);
    if (this.#pod.phase === 'offline') {
      // Advance past every studio request already issued for the old worker
      // session. This remains effective if a replacement Pod becomes Ready
      // before a late response settles.
      this.#acceptedStudioSequence = this.#nextStudioSequence();
      this.#studio = null;
      this.#pendingHeartbeatAvailability = null;
      this.#pendingFinalization = null;
      this.#stopGuardAttempted = false;
      this.#stopGuardConsumed = false;
      this.#stopGuardDefinitivelyInvalid = false;
      this.#workerStopGuardActive = false;
    }
    this.#emit({ type: 'pod', pod: this.#pod });
  }

  #onWorkerEvent(event: WorkerBatchEvent): void {
    if (event.type === 'idle') {
      this.#workerStopGuardActive = false;
      this.#emit({ type: 'idle' });
      return;
    }
    if (event.type === 'stop-pending') {
      this.#workerStopGuardActive = true;
      this.#emit({
        type: 'stop-guard-active',
        podId: this.#pod?.podId ?? null,
        message: event.message,
      });
      return;
    }
    if (event.type === 'busy') {
      this.#workerStopGuardActive = false;
      this.#emit({ type: 'busy', batch: projectBusyBatch(event.summary) });
      return;
    }
    if (event.type === 'error') {
      if (this.#deferWorkerError) {
        this.#deferredWorkerError = event;
        return;
      }
      this.#emitWorkerError(event);
      return;
    }
    if (event.type === 'local-error') {
      this.#emit({
        type: 'local-error',
        batchId: event.batchId,
        code: event.code,
        message: event.message,
        retryable: event.retryable,
      });
      return;
    }
    this.#workerStopGuardActive = false;
    const restoredName = recoveredBatchName(event.manifest.batchId, event.receipts);
    if (
      restoredName !== null
      && (this.#presentation === null || this.#presentation.name === 'Recovered ImageForge batch')
    ) {
      this.#worker.setBatchName(restoredName);
      this.#recoveredBatchName = restoredName;
      this.#presentation = {
        name: restoredName,
        destination: this.#presentation?.destination ?? 'Validated downloads folder',
        estimatedSecondsPerImage: this.#presentation?.estimatedSecondsPerImage ?? 8.4,
        hourlyRate: this.#presentation?.hourlyRate ?? this.#pod?.hourlyRate ?? null,
      };
    }
    const context = this.#presentation ?? {
      name: 'Recovered ImageForge batch',
      destination: 'Validated downloads folder',
      estimatedSecondsPerImage: 8.4,
      hourlyRate: this.#pod?.hourlyRate ?? null,
    };
    const projected = projectOwnedManifest(event.manifest, event.receipts, context);
    this.#emit({ type: 'batch', ...projected });
  }

  #emit(event: ProductionRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #flushDeferredWorkerError(): void {
    const event = this.#deferredWorkerError;
    this.#deferredWorkerError = null;
    if (event !== null) this.#emitWorkerError(event);
  }

  #emitWorkerError(event: Extract<WorkerBatchEvent, { type: 'error' }>): void {
    this.#emit({
      type: 'error',
      scope: 'batch',
      message: event.message,
      retryable: event.retryable,
      ...(event.code ? { code: event.code } : {}),
    });
  }

  #emitError(scope: 'pod' | 'batch', error: unknown, fallback: string): void {
    this.#emit({ type: 'error', scope, ...runtimeError(error, undefined, fallback) });
  }
}

function runtimeError(
  error: unknown,
  fallbackCode: string | undefined,
  fallbackMessage: string,
): { code?: string; message: string; retryable: boolean } {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
    const code = typeof candidate.code === 'string' ? candidate.code : fallbackCode;
    const message = typeof candidate.message === 'string' && candidate.message
      ? candidate.message
      : fallbackMessage;
    return {
      ...(code === undefined ? {} : { code }),
      message,
      retryable: candidate.retryable === true,
    };
  }
  return {
    ...(fallbackCode === undefined ? {} : { code: fallbackCode }),
    message: error instanceof Error && error.message ? error.message : fallbackMessage,
    retryable: false,
  };
}

function safeDetailString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 120
    ? value
    : null;
}

function safeDetailInteger(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function safePrimitiveDetails(
  details: Readonly<Record<string, unknown>> | null,
): Readonly<Record<string, string | number | boolean | null>> {
  if (details === null) return {};
  return Object.fromEntries(
    Object.entries(details)
      .filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value))
      .slice(0, 8),
  ) as Readonly<Record<string, string | number | boolean | null>>;
}

function stopGuardCode(
  code: string,
  state: StudioState['stopRequest'] extends infer _Request
    ? 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'finalizing' | null
    : never,
): NonNullable<StopGuardDecision['code']> {
  if (code === 'stop_blocked_by_active_batch') return 'stop_blocked_by_active_batch';
  if (code === 'gpu_stop_pending') return 'gpu_stop_pending';
  if (code === 'stop_approval_pending') return 'stop_consent_pending';
  if (code === 'stop_consent_denied' || state === 'denied') return 'stop_consent_denied';
  if (code === 'stop_consent_expired' || state === 'expired' || state === 'cancelled') return 'stop_consent_expired';
  if (code === 'stop_request_not_approved' && state === 'pending') return 'stop_consent_pending';
  return 'stop_guard_failed';
}

export function createProductionImageForgeAdapter(
  port: ProductionDesktopPort,
  recoveredBatchId: string | null = null,
  recoveredBatchName: string | null = null,
): ImageForgeAdapter {
  const runtime = new ProductionRuntime(port, recoveredBatchId, recoveredBatchName);
  return {
    mode: 'production',
    runtime,
    async chooseDestination(defaultPath) {
      return (await port.chooseDestination(defaultPath))?.path ?? null;
    },
    async validateDestination(path) {
      return (await port.validateDestination(path)).writable;
    },
    revealPath: (relativePath) => port.revealDestination(relativePath),
    fetchPreview: (batchId, index) => port.fetchPreview(batchId, index),
    downloadAsset: (request) => port.downloadAsset(request),
    writeManifest: (batchId, content) => port.writeManifest(batchId, content),
    credentialMetadata: () => port.credentialMetadata(),
    replaceCredential: (kind, value) => port.replaceCredential(kind, value),
    async validateStudioProfile(profile) {
      return parseStudioProfile(profile) !== null;
    },
    async testConnection(input: ConnectionTestInput) {
      const profile = parseStudioProfile(input.profile);
      if (profile === null) return { ok: false, message: 'The ImageForge studio profile is invalid.' };
      if (!input.credentials.runpodApiKey.configured || !input.credentials.workerToken.configured) {
        return { ok: false, message: 'Configure both credentials before continuing.' };
      }
      if (!input.destinationValidated || !input.destination.trim()) {
        return { ok: false, message: 'Choose and validate a writable downloads folder.' };
      }
      await port.bindProfile(profile.templateId, profile.networkVolumeId);
      const destination = await port.validateDestination(input.destination);
      if (!destination.writable) return { ok: false, message: 'The downloads folder is not writable.' };
      return {
        ok: true,
        message: 'Secure profile, vault metadata, and downloads folder are ready. No GPU was started.',
      };
    },
    runPodLifecycle() {
      throw new Error('Production GPU control must use the native runtime facade.');
    },
    finishPodStop() {
      throw new Error('Production GPU control must use the native runtime facade.');
    },
    validateBatch() {
      throw new Error('Production batch control must use the native runtime facade.');
    },
    runBatchClock() {
      throw new Error('Production batch control must use the native runtime facade.');
    },
  };
}
