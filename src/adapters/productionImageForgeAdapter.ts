import type {
  NativeGpuInventorySnapshotV1,
  RunPodSnapshot,
} from '@imageforge/runpod-client';
import {
  projectAutoGpuSelectionV1,
  projectManualGpuSelectionV1,
} from '@imageforge/runpod-client';
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
import type { NativeGpuStartResultV1 } from '../native/gpuStartBridge';
import type {
  NativeGpuSwitchPort,
  NativeGpuSwitchRecordV1,
  NativeGpuSwitchSnapshotV1,
} from '../native/gpuSwitchBridge';
import type { GpuSelectorConfirmationV1 } from '../domain/gpuSelector';
import { isQueuePlaceholder, type QueueHostPort } from '../domain/queue';
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
  type StudioState,
} from './studioContracts';

export interface ProductionDesktopPort extends GpuLifecycleNativePort, WorkerBatchPort, QueueHostPort {
  readonly gpuSwitch: NativeGpuSwitchPort;
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
  studioRespondToGpuSwitch(switchId: string, sessionId: string, decision: 'approve' | 'deny'): Promise<WorkerHttpResult>;
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
  getGpuInventory(): NativeGpuInventorySnapshotV1 | null;
  subscribeGpuInventory(listener: (snapshot: NativeGpuInventorySnapshotV1) => void): () => void;
  loadGpuInventory(): Promise<NativeGpuInventorySnapshotV1>;
  loadGpuStart(): Promise<NativeGpuStartResultV1 | null>;
  loadGpuSwitch(): Promise<NativeGpuSwitchSnapshotV1>;
  recoverGpuStop(): Promise<void>;
  beginGpuSwitch(
    state: AppState,
    confirmation: Extract<GpuSelectorConfirmationV1, { kind: 'switch' }>,
  ): Promise<NativeGpuSwitchSnapshotV1>;
  resumeGpuSwitch(snapshot: NativeGpuSwitchSnapshotV1): Promise<NativeGpuSwitchSnapshotV1>;
  syncGpuSwitch(snapshot: NativeGpuSwitchSnapshotV1): Promise<NativeGpuSwitchSnapshotV1>;
  confirmGpuSwitchTarget(
    state: AppState,
    snapshot: NativeGpuSwitchSnapshotV1,
  ): Promise<NativeGpuSwitchSnapshotV1>;
  finalizeGpuSwitch(
    state: AppState,
    snapshot: NativeGpuSwitchSnapshotV1,
  ): Promise<NativeGpuSwitchSnapshotV1>;
  deleteOldGpuSwitch(
    state: AppState,
    snapshot: NativeGpuSwitchSnapshotV1,
  ): Promise<NativeGpuSwitchSnapshotV1>;
  prepareGpuSwitchAttempt(
    state: AppState,
    snapshot: NativeGpuSwitchSnapshotV1,
  ): Promise<NativeGpuSwitchSnapshotV1>;
  confirmGpuSwitchAttempt(snapshot: NativeGpuSwitchSnapshotV1): Promise<NativeGpuSwitchSnapshotV1>;
  createGpuSwitchReplacement(
    state: AppState,
    snapshot: NativeGpuSwitchSnapshotV1,
  ): Promise<NativeGpuSwitchSnapshotV1>;
  confirmGpuSwitchActualPrice(snapshot: NativeGpuSwitchSnapshotV1): Promise<NativeGpuSwitchSnapshotV1>;
  deleteGpuSwitchReplacement(
    snapshot: NativeGpuSwitchSnapshotV1,
    reason: 'replacement_failed' | 'actual_price_rejected',
  ): Promise<NativeGpuSwitchSnapshotV1>;
  reconcileGpuSwitchProvider(
    snapshot: NativeGpuSwitchSnapshotV1,
    reason: 'resume' | 'after_delete' | 'after_create' | 'provisioning' | 'zero_match_proof' | 'after_replacement_delete',
  ): Promise<NativeGpuSwitchSnapshotV1>;
  verifyGpuSwitchReplacement(snapshot: NativeGpuSwitchSnapshotV1): Promise<NativeGpuSwitchSnapshotV1>;
  completeGpuSwitch(snapshot: NativeGpuSwitchSnapshotV1): Promise<NativeGpuSwitchSnapshotV1>;
  cancelGpuSwitch(snapshot: NativeGpuSwitchSnapshotV1): Promise<NativeGpuSwitchSnapshotV1>;
  refreshGpuInventory(includeEmergencyTier: boolean): Promise<NativeGpuInventorySnapshotV1>;
  prepareGpuInventory(state: AppState): Promise<NativeGpuInventorySnapshotV1>;
  startGpuChoice(
    state: AppState,
    confirmation: Exclude<GpuSelectorConfirmationV1, { kind: 'switch' }>,
  ): Promise<NativeGpuStartResultV1>;
  confirmGpuActualPrice(
    state: AppState,
    operationId: string,
    confirmedActualHourlyPriceMicroUsd: number,
  ): Promise<NativeGpuStartResultV1>;
  restoreLocalLibrary(state: AppState): Promise<void>;
  refresh(state: AppState): Promise<void>;
  observe(state: AppState): Promise<void>;
  heartbeat(state: AppState, availability: 'foreground' | 'background'): Promise<void>;
  startGpu(state: AppState): Promise<void>;
  requestGpuStop(state: AppState): Promise<void>;
  respondToGpuStop(requestId: string, decision: 'approve' | 'deny'): Promise<void>;
  respondToGpuSwitch(switchId: string, decision: 'approve' | 'deny'): Promise<void>;
  cancelGpuStop(requestId: string): Promise<void>;
  startBatch(state: AppState): Promise<void>;
  reconcileQueueSubmission(identity: QueueSubmissionIdentity): Promise<string | null>;
  pollBatch(state: AppState): Promise<void>;
  beginNewBatch(): void;
  controlBatch(
    action: 'pause' | 'resume' | 'cancel' | 'retry_failed',
    state: AppState,
  ): Promise<void>;
  resolveAmbiguousStart(): Promise<void>;
  dispose(): void;
}

export interface QueueSubmissionIdentity {
  queueItemId: string;
  clientSubmissionId: string;
  name: string;
  destination: string;
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
  #queueAttachment: { queueItemId: string; clientSubmissionId: string } | null = null;
  #stopFinalization: Promise<void> | null = null;
  #normalStopRecoveryChecked = false;
  #pendingFinalization: {
    serverInstanceId: string;
    approvedCoordinationRevision: number;
    requestId: string;
    podId: string;
  } | null = null;

  constructor(
    port: ProductionDesktopPort,
    recoveredBatchId: string | null = null,
    recoveredBatchName: string | null = null,
  ) {
    this.#port = port;
    this.#sessionId = crypto.randomUUID();
    this.#recoveredBatchId = recoveredBatchId;
    this.#recoveredBatchName = recoveredBatchName;
    this.#gpu = new GpuLifecycleCoordinator(port);
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

  getGpuInventory(): NativeGpuInventorySnapshotV1 | null {
    return this.#gpu.getInventorySnapshot();
  }

  subscribeGpuInventory(
    listener: (snapshot: NativeGpuInventorySnapshotV1) => void,
  ): () => void {
    return this.#gpu.subscribeInventory(listener);
  }

  loadGpuInventory(): Promise<NativeGpuInventorySnapshotV1> {
    return this.#gpu.loadInventory();
  }

  loadGpuStart(): Promise<NativeGpuStartResultV1 | null> {
    return this.#gpu.loadStart();
  }

  loadGpuSwitch(): Promise<NativeGpuSwitchSnapshotV1> {
    return this.#port.gpuSwitch.load();
  }

  async recoverGpuStop(): Promise<void> {
    if (this.#normalStopRecoveryChecked) return;
    this.#normalStopRecoveryChecked = true;
    try {
      const input = await this.#port.gpuPod.loadNormalStop();
      if (input === null) return;
      const result = await this.#gpu.recoverStop(input);
      this.#emit({ type: 'stop-complete', alreadyStopped: result.alreadyStopped });
    } catch (error) {
      const ambiguous = typeof error === 'object'
        && error !== null
        && (error as { mayHaveSucceeded?: unknown }).mayHaveSucceeded === true;
      this.#emitStopFailure(
        error,
        ambiguous
          ? 'ImageForge recovered an unresolved GPU Stop. The old Pod remains visible; check the RunPod dashboard before another action.'
          : 'ImageForge could not load the interrupted GPU Stop safely. Refresh shared status before continuing.',
      );
    }
  }

  async beginGpuSwitch(
    state: AppState,
    confirmation: Extract<GpuSelectorConfirmationV1, { kind: 'switch' }>,
  ): Promise<NativeGpuSwitchSnapshotV1> {
    this.#captureState(state);
    const grant = await this.#port.gpuSwitch.authorizeForeground({
      action: 'begin',
      switchId: null,
      observationId: confirmation.projection.observationId,
      targetGpuId: confirmation.projection.targetGpuId,
    });
    const current = await this.#port.gpuSwitch.load();
    if (current.record !== null) {
      throw new Error('A durable GPU Switch already exists. Reload its exact recovery state.');
    }
    return this.#port.gpuSwitch.begin({
      observationId: confirmation.projection.observationId,
      receiptId: confirmation.projection.receiptId,
      targetGpuId: confirmation.projection.targetGpuId,
      confirmedHourlyPriceMicroUsd: confirmation.projection.confirmedHourlyPriceMicroUsd,
      expectedStoreRevision: current.storeRevision,
      sessionId: this.#sessionId,
      queueExpectedStoreRevision: state.queue.storeRevision,
      queueRunRevision: state.queue.document.run?.runRevision ?? null,
      foregroundGrantId: grant.grantId,
    });
  }

  async resumeGpuSwitch(
    snapshot: NativeGpuSwitchSnapshotV1,
  ): Promise<NativeGpuSwitchSnapshotV1> {
    const record = snapshot.record;
    if (record === null) {
      throw new Error('The GPU Switch record is no longer available.');
    }
    const grant = await this.#port.gpuSwitch.authorizeForeground({
      action: 'resume',
      switchId: record.switchId,
      observationId: null,
      targetGpuId: null,
    });
    const lease = await this.#port.gpuSwitch.acquire({
      switchId: record.switchId,
      foregroundGrantId: grant.grantId,
    });
    const current = await this.#port.gpuSwitch.load();
    if (lease.switchId !== record.switchId) {
      throw new Error('The native GPU Switch lease was not acquired. No switch action ran.');
    }
    if (!lease.held) {
      const currentRecord = current.record;
      if (currentRecord !== null
        && currentRecord.switchId === record.switchId
        && currentRecord.authorizationRequired) {
        return current;
      }
      throw new Error('The native GPU Switch lease was not acquired. No switch action ran.');
    }
    return current;
  }

  async syncGpuSwitch(
    snapshot: NativeGpuSwitchSnapshotV1,
  ): Promise<NativeGpuSwitchSnapshotV1> {
    const record = await this.#requireCurrentGpuSwitch(snapshot);
    return this.#port.gpuSwitch.syncWorker({
      switchId: record.switchId,
      expectedRecordRevision: record.recordRevision,
      sessionId: this.#sessionId,
    });
  }

  async confirmGpuSwitchTarget(
    state: AppState,
    snapshot: NativeGpuSwitchSnapshotV1,
  ): Promise<NativeGpuSwitchSnapshotV1> {
    this.#captureState(state);
    const record = await this.#requireCurrentGpuSwitch(snapshot);
    if (record.targetConfirmation !== 'required') {
      throw new Error('The GPU switch target is already confirmed. Finalize the switch instead.');
    }
    const target = await this.#freshGpuSwitchTarget(state, record);
    return this.#port.gpuSwitch.confirmTarget({
      switchId: record.switchId,
      expectedRecordRevision: record.recordRevision,
      ...target,
    });
  }

  async finalizeGpuSwitch(
    state: AppState,
    snapshot: NativeGpuSwitchSnapshotV1,
  ): Promise<NativeGpuSwitchSnapshotV1> {
    this.#captureState(state);
    const record = await this.#requireCurrentGpuSwitch(snapshot);
    if (record.targetConfirmation !== 'confirmed') {
      throw new Error('Confirm the current GPU target before finalizing this switch.');
    }
    const target = await this.#freshGpuSwitchTarget(state, record);
    return this.#port.gpuSwitch.finalize({
      switchId: record.switchId,
      expectedRecordRevision: record.recordRevision,
      sessionId: this.#sessionId,
      ...target,
    });
  }

  async deleteOldGpuSwitch(
    state: AppState,
    snapshot: NativeGpuSwitchSnapshotV1,
  ): Promise<NativeGpuSwitchSnapshotV1> {
    this.#captureState(state);
    const record = await this.#requireCurrentGpuSwitch(snapshot);
    const target = await this.#freshGpuSwitchTarget(state, record);
    return this.#port.gpuSwitch.deleteOld({
      switchId: record.switchId,
      expectedRecordRevision: record.recordRevision,
      sessionId: this.#sessionId,
      ...target,
    });
  }

  async prepareGpuSwitchAttempt(
    state: AppState,
    snapshot: NativeGpuSwitchSnapshotV1,
  ): Promise<NativeGpuSwitchSnapshotV1> {
    this.#captureState(state);
    const record = await this.#requireCurrentGpuSwitch(snapshot);
    const target = await this.#freshGpuSwitchTarget(state, record);
    return this.#port.gpuSwitch.prepareAttempt({
      switchId: record.switchId,
      expectedRecordRevision: record.recordRevision,
      ...target,
    });
  }

  async confirmGpuSwitchAttempt(
    snapshot: NativeGpuSwitchSnapshotV1,
  ): Promise<NativeGpuSwitchSnapshotV1> {
    const record = await this.#requireCurrentGpuSwitch(snapshot);
    const prepared = record.preparedTarget;
    if (prepared === null) {
      throw new Error('Prepare an exact replacement target before confirming another attempt.');
    }
    return this.#port.gpuSwitch.confirmAttempt({
      switchId: record.switchId,
      expectedRecordRevision: record.recordRevision,
      observationId: prepared.observationId,
      receiptId: prepared.receiptId,
      targetGpuId: prepared.gpuId,
      confirmedHourlyPriceMicroUsd: prepared.hourlyPriceMicroUsd,
      quoteId: prepared.quoteId,
    });
  }

  async createGpuSwitchReplacement(
    state: AppState,
    snapshot: NativeGpuSwitchSnapshotV1,
  ): Promise<NativeGpuSwitchSnapshotV1> {
    this.#captureState(state);
    const record = await this.#requireCurrentGpuSwitch(snapshot);
    const target = await this.#freshGpuSwitchTarget(state, record);
    return this.#port.gpuSwitch.createReplacement({
      switchId: record.switchId,
      expectedRecordRevision: record.recordRevision,
      sessionId: this.#sessionId,
      ...target,
    });
  }

  async confirmGpuSwitchActualPrice(
    snapshot: NativeGpuSwitchSnapshotV1,
  ): Promise<NativeGpuSwitchSnapshotV1> {
    const record = await this.#requireCurrentGpuSwitch(snapshot);
    if (record.actualHourlyPriceMicroUsd === null) {
      throw new Error('RunPod did not return an exact actual replacement price to confirm.');
    }
    return this.#port.gpuSwitch.confirmActualPrice({
      switchId: record.switchId,
      expectedRecordRevision: record.recordRevision,
      confirmedActualHourlyPriceMicroUsd: record.actualHourlyPriceMicroUsd,
    });
  }

  async deleteGpuSwitchReplacement(
    snapshot: NativeGpuSwitchSnapshotV1,
    reason: 'replacement_failed' | 'actual_price_rejected',
  ): Promise<NativeGpuSwitchSnapshotV1> {
    const record = await this.#requireCurrentGpuSwitch(snapshot);
    if (record.replacementPodId === null) {
      throw new Error('The exact replacement Pod is unavailable. No delete action ran.');
    }
    return this.#port.gpuSwitch.deleteReplacement({
      switchId: record.switchId,
      expectedRecordRevision: record.recordRevision,
      replacementPodId: record.replacementPodId,
      reason,
      confirmation: reason === 'replacement_failed'
        ? 'TERMINATE FAILED REPLACEMENT'
        : 'TERMINATE UNACCEPTED REPLACEMENT',
    });
  }

  async reconcileGpuSwitchProvider(
    snapshot: NativeGpuSwitchSnapshotV1,
    reason: 'resume' | 'after_delete' | 'after_create' | 'provisioning' | 'zero_match_proof' | 'after_replacement_delete',
  ): Promise<NativeGpuSwitchSnapshotV1> {
    const record = await this.#requireCurrentGpuSwitch(snapshot);
    return this.#port.gpuSwitch.reconcileProvider({
      switchId: record.switchId,
      expectedRecordRevision: record.recordRevision,
      reason,
    });
  }

  async verifyGpuSwitchReplacement(
    snapshot: NativeGpuSwitchSnapshotV1,
  ): Promise<NativeGpuSwitchSnapshotV1> {
    const record = await this.#requireCurrentGpuSwitch(snapshot);
    return this.#port.gpuSwitch.verifyReplacement({
      switchId: record.switchId,
      expectedRecordRevision: record.recordRevision,
      sessionId: this.#sessionId,
    });
  }

  async completeGpuSwitch(
    snapshot: NativeGpuSwitchSnapshotV1,
  ): Promise<NativeGpuSwitchSnapshotV1> {
    const record = await this.#requireCurrentGpuSwitch(snapshot);
    return this.#port.gpuSwitch.complete({
      switchId: record.switchId,
      expectedRecordRevision: record.recordRevision,
      sessionId: this.#sessionId,
    });
  }

  async cancelGpuSwitch(
    snapshot: NativeGpuSwitchSnapshotV1,
  ): Promise<NativeGpuSwitchSnapshotV1> {
    const record = await this.#requireCurrentGpuSwitch(snapshot);
    return this.#port.gpuSwitch.cancel({
      switchId: record.switchId,
      expectedRecordRevision: record.recordRevision,
      sessionId: this.#sessionId,
    });
  }

  async #requireCurrentGpuSwitch(
    expected: NativeGpuSwitchSnapshotV1,
  ): Promise<NativeGpuSwitchRecordV1> {
    const expectedRecord = expected.record;
    if (expectedRecord === null) {
      throw new Error('The GPU Switch record is no longer available.');
    }
    const current = await this.#port.gpuSwitch.load();
    if (
      current.record === null
      || current.record.switchId !== expectedRecord.switchId
      || current.record.recordRevision !== expectedRecord.recordRevision
    ) {
      throw new Error('GPU Switch state changed. Reload its exact recovery state before continuing.');
    }
    return current.record;
  }

  async #freshGpuSwitchTarget(
    state: AppState,
    record: NativeGpuSwitchRecordV1,
  ) {
    const inventory = await this.#gpu.prepareInventory(
      state.setup.studioProfile,
      state.settings.slowEmergencyGpuEnabled,
    );
    const projection = projectManualGpuSelectionV1(
      inventory,
      record.currentTarget.gpuId,
      inventory.processEpochId,
    );
    if (
      projection === null
      || projection.confirmedHourlyPriceMicroUsd !== record.currentTarget.hourlyPriceMicroUsd
    ) {
      throw new Error('The selected GPU target or exact price changed. No switch action ran.');
    }
    return projection;
  }

  refreshGpuInventory(includeEmergencyTier: boolean): Promise<NativeGpuInventorySnapshotV1> {
    return this.#gpu.beginInventoryRefresh(includeEmergencyTier);
  }

  prepareGpuInventory(state: AppState): Promise<NativeGpuInventorySnapshotV1> {
    this.#captureState(state);
    return this.#gpu.prepareInventory(
      state.setup.studioProfile,
      state.settings.slowEmergencyGpuEnabled,
    );
  }

  async startGpuChoice(
    state: AppState,
    confirmation: Exclude<GpuSelectorConfirmationV1, { kind: 'switch' }>,
  ): Promise<NativeGpuStartResultV1> {
    this.#captureState(state);
    const current = await this.#gpu.loadStart();
    const expectedLifecycleRevision = current?.lifecycleRevision ?? 0;
    let result: NativeGpuStartResultV1;
    try {
      result = confirmation.kind === 'auto_start'
        ? await this.#gpu.startAuto(
          state.setup.studioProfile,
          state.settings.slowEmergencyGpuEnabled,
          {
            observationId: confirmation.projection.observationId,
            receiptId: confirmation.projection.receiptId,
            sessionId: this.#sessionId,
            expectedLifecycleRevision,
          },
        )
        : await this.#gpu.startSelected(
          state.setup.studioProfile,
          state.settings.slowEmergencyGpuEnabled,
          {
            observationId: confirmation.projection.observationId,
            receiptId: confirmation.projection.receiptId,
            targetGpuId: confirmation.projection.targetGpuId,
            confirmedHourlyPriceMicroUsd:
              confirmation.projection.confirmedHourlyPriceMicroUsd,
            sessionId: this.#sessionId,
            expectedLifecycleRevision,
          },
        );
    } catch (error) {
      // A Start refused because a prior create attempt is still unreconciled
      // must surface that attempt, not fail silently. The marker is otherwise
      // published only by `refresh`, so a Start blocked by it left
      // `createRecovery` null: the app showed no recovery panel, no reason, and
      // the button simply did nothing.
      await this.#emitCurrentCreateMarker();
      this.#emitError('pod', error, 'ImageForge could not start the selected GPU safely.');
      throw error;
    }
    await this.#projectNativeStartResult(state, result);
    return result;
  }

  async confirmGpuActualPrice(
    state: AppState,
    operationId: string,
    confirmedActualHourlyPriceMicroUsd: number,
  ): Promise<NativeGpuStartResultV1> {
    this.#captureState(state);
    const current = await this.#gpu.loadStart();
    if (current === null || current.operationId !== operationId) {
      throw new Error('The GPU Start recovery operation changed. Reload before confirming price.');
    }
    const result = await this.#gpu.confirmActualPrice({
      operationId,
      expectedLifecycleRevision: current.lifecycleRevision,
      confirmedActualHourlyPriceMicroUsd,
    });
    await this.#projectNativeStartResult(state, result);
    return result;
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
    // The native profile/controller is now bound. Recover only an already
    // mutation-bound Stop using its byte-identical journal input; this path is
    // observation-only and must never be synthesized from the new renderer
    // session or lifecycle revision.
    await this.recoverGpuStop();
    snapshot = this.#gpu.getSnapshot() ?? snapshot;
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
    const inventory = await this.prepareGpuInventory(state);
    const projection = projectAutoGpuSelectionV1(inventory, inventory.processEpochId);
    if (projection === null) {
      const error = new Error('No fresh receipt-bearing Auto GPU choice is available.');
      this.#emitError('pod', error, error.message);
      throw error;
    }
    await this.startGpuChoice(state, { kind: 'auto_start', projection });
  }

  async respondToGpuSwitch(switchId: string, decision: 'approve' | 'deny'): Promise<void> {
    const sequence = this.#nextStudioSequence();
    const studio = requireStudioState(
      await this.#port.studioRespondToGpuSwitch(switchId, this.#sessionId, decision),
      [200],
    );
    this.#acceptStudio(studio, sequence);
  }

  async #projectNativeStartResult(
    state: AppState,
    result: NativeGpuStartResultV1,
  ): Promise<void> {
    if (result.state === 'create_uncertain') {
      this.#emitError(
        'pod',
        new Error('RunPod may have created the GPU. Resolve this Start before trying again.'),
        'RunPod may have created the GPU. Resolve this Start before trying again.',
      );
      return;
    }
    if (result.state === 'create_intent') {
      this.#emit({
        type: 'notice',
        tone: 'info',
        title: 'GPU Start recorded',
        message: 'ImageForge durably recorded the exact provider request before sending it.',
      });
      return;
    }

    const count = state.batch?.prompts.length || state.draft.prompts.length || 450;
    await this.#gpu.refresh(
      state.setup.studioProfile,
      count,
      state.settings.slowEmergencyGpuEnabled,
    );
    if (result.state === 'price_attention') {
      const message = result.issue?.code === 'gpu_actual_price_unavailable'
        ? 'The created GPU price is unavailable. Generation stays disabled until the exact price is confirmed.'
        : 'The created GPU price changed. Review and accept the exact actual price before generation.';
      this.#emitError('pod', new Error(message), message);
      return;
    }
    if (result.state === 'ready') {
      try {
        await this.#worker.poll();
      } catch (error) {
        if (!isWorkerLocalSyncError(error)) throw error;
      }
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
    if (batch.admissionMode === 'queue') {
      const run = state.queue.document.run;
      const row = batch.queueItemId === undefined
        ? undefined
        : state.queue.document.items.find((item) => item.queueItemId === batch.queueItemId);
      if (
        batch.queueItemId === undefined
        || batch.clientSubmissionId === undefined
        || run === null
        || run.runnerState !== 'running'
        || run.authorizationRequired
        || state.queue.lease?.held !== true
        || state.queue.lease.runRevision !== run.runRevision
        || row === undefined
        || isQueuePlaceholder(row)
        || row.state !== 'dispatching'
        || row.runRevision !== run.runRevision
        || row.clientSubmissionId !== batch.clientSubmissionId
      ) {
        throw Object.assign(new Error('The device queue was paused before worker admission.'), {
          code: 'queue_dispatch_cancelled',
          retryable: false,
        });
      }
    }
    this.#presentation = {
      name: batch.name,
      destination: batch.destination,
      estimatedSecondsPerImage: batch.estimatedSecondsPerImage,
      hourlyRate: this.#pod?.hourlyRate ?? null,
    };
    this.#queueAttachment = batch.queueItemId && batch.clientSubmissionId
      ? { queueItemId: batch.queueItemId, clientSubmissionId: batch.clientSubmissionId }
      : null;
    try {
      await this.#worker.create(
        batch.prompts.map((prompt) => prompt.text),
        batch.prompts[0]?.seed ?? 0,
        batch.references ?? [],
        batch.aspectRatio,
        batch.name,
        batch.clientSubmissionId,
        batch.admissionMode ?? 'foreground',
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

  async reconcileQueueSubmission(payload: QueueSubmissionIdentity): Promise<string | null> {
    this.#presentation = {
      name: payload.name,
      destination: payload.destination,
      estimatedSecondsPerImage: 8.4,
      hourlyRate: this.#pod?.hourlyRate ?? null,
    };
    this.#worker.setBatchName(payload.name);
    this.#queueAttachment = {
      queueItemId: payload.queueItemId,
      clientSubmissionId: payload.clientSubmissionId,
    };
    return this.#worker.lookupSubmission(payload.clientSubmissionId);
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
      // Some authoritative status guards (notably corrupt submission history)
      // are complete typed poll events rather than transport exceptions. They
      // still must cross the production boundary instead of being discarded
      // by the remote-Stop disambiguation window.
      this.#flushDeferredWorkerError();
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
    this.#queueAttachment = null;
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
      this.#pendingFinalization !== null
      && (
        request === null
        || request.requestId !== this.#pendingFinalization.requestId
        || ['denied', 'expired', 'cancelled'].includes(request.state)
      )
    ) {
      this.#pendingFinalization = null;
    }
    if (
      request === null
      || request.state !== 'approved'
      || request.requester.sessionId !== studio.currentSession.sessionId
    ) {
      return;
    }
    if (this.#stopFinalization !== null) return this.#stopFinalization;
    // Native owns the finalization marker and idempotent operation journal.
    // A heartbeat must never turn a failed explicit Stop into an automatic
    // retry, so retain the attempted request until it completes or changes.
    if (this.#pendingFinalization?.requestId === request.requestId) return;
    if (this.#pod?.podId !== request.podId) {
      this.#emitStopFailure(
        { code: 'termination_target_mismatch', message: 'The confirmed Pod changed before final authorization.', retryable: false },
        'The confirmed Pod changed before final authorization.',
      );
      return;
    }
    const pending = {
      serverInstanceId: studio.serverInstanceId,
      approvedCoordinationRevision: studio.coordinationRevision,
      requestId: request.requestId,
      podId: request.podId,
    };
    this.#pendingFinalization = pending;
    const operation = this.#finalizeApprovedStop(pending)
      .finally(() => {
        if (this.#stopFinalization === operation) this.#stopFinalization = null;
      });
    this.#stopFinalization = operation;
    return operation;
  }

  async #finalizeApprovedStop(
    pending: {
      serverInstanceId: string;
      approvedCoordinationRevision: number;
      requestId: string;
      podId: string;
    },
  ): Promise<void> {
    try {
      const result = await this.#gpu.stop({
        podId: pending.podId,
        stopRequestId: pending.requestId,
        sessionId: this.#sessionId,
        expectedServerInstanceId: pending.serverInstanceId,
        expectedCoordinationRevision: pending.approvedCoordinationRevision,
      });
      this.#pendingFinalization = null;
      this.#emit({ type: 'stop-complete', alreadyStopped: result.alreadyStopped });
    } catch (error) {
      const ambiguous = typeof error === 'object'
        && error !== null
        && (error as { mayHaveSucceeded?: unknown }).mayHaveSucceeded === true;
      // Native alone owns the worker finalization ID, its TTL, and durable
      // provider ambiguity. Retain this attempted request so a later heartbeat
      // cannot issue a second mutation; explicit Cancel/status reconciliation
      // remains available to the user.
      this.#emitStopFailure(
        error,
        ambiguous
          ? 'RunPod did not confirm whether termination completed. ImageForge will not claim the GPU stopped; refresh shared status.'
          : 'The exact GPU was not terminated. The approval guard was cancelled or will expire safely.',
      );
    }
  }

  #emitStopFailure(error: unknown, fallback: string): void {
    const safe = runtimeError(error, 'stop_guard_failed', fallback);
    this.#emit({ type: 'stop-failed', message: safe.message, retryable: safe.retryable });
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
    // A marker whose recorded Pod is gone or terminal is retired natively,
    // against the provider list itself, because only native can prove that
    // absence. Anything still pending here needs the explicit human control.
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
    if (this.#queueAttachment !== null) {
      projected.batch = {
        ...projected.batch,
        queueItemId: this.#queueAttachment.queueItemId,
        clientSubmissionId: this.#queueAttachment.clientSubmissionId,
        admissionMode: 'queue',
      };
    }
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

export function createProductionImageForgeAdapter(
  port: ProductionDesktopPort,
  recoveredBatchId: string | null = null,
  recoveredBatchName: string | null = null,
): ImageForgeAdapter {
  const runtime = new ProductionRuntime(port, recoveredBatchId, recoveredBatchName);
  return {
    mode: 'production',
    runtime,
    queue: port,
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
