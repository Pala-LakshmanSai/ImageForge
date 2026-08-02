import type { RunPodSnapshot } from '@imageforge/runpod-client';
import type {
  AppState,
  BatchState,
  CredentialKind,
  CredentialMetadata,
  CredentialMetadataMap,
  LibraryAsset,
  PodState,
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
  type LocalDownloadReceipt,
  type WorkerBatchEvent,
  type WorkerBatchPort,
} from './workerBatchCoordinator';
import {
  projectBusyBatch,
  projectOwnedManifest,
  projectPodSnapshot,
  type BatchPresentationContext,
} from './runtimeProjection';

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
}

export type ProductionRuntimeEvent =
  | { type: 'pod'; pod: PodState }
  | { type: 'batch'; batch: BatchState; assets: LibraryAsset[] }
  | { type: 'library'; assets: LibraryAsset[] }
  | { type: 'busy'; batch: BatchState }
  | { type: 'idle' }
  | { type: 'create-recovery'; marker: PodState['createRecovery'] }
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
  restoreLocalLibrary(state: AppState): Promise<void>;
  refresh(state: AppState): Promise<void>;
  startGpu(state: AppState): Promise<void>;
  stopGpu(state: AppState): Promise<void>;
  startBatch(batch: BatchState): Promise<void>;
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
  #presentation: BatchPresentationContext | null = null;
  #unsubscribeGpu: () => void;
  #unsubscribeWorker: () => void;
  #recoveredBatchId: string | null;
  #recoveredBatchName: string | null;
  #reconciledRecoveredBatch = false;
  #localLibraryRestored = false;
  #localLibraryRestore: Promise<void> | null = null;

  constructor(
    port: ProductionDesktopPort,
    recoveredBatchId: string | null = null,
    recoveredBatchName: string | null = null,
  ) {
    this.#port = port;
    this.#recoveredBatchId = recoveredBatchId;
    this.#recoveredBatchName = recoveredBatchName;
    this.#gpu = new GpuLifecycleCoordinator(port);
    this.#worker = new WorkerBatchCoordinator(port, recoveredBatchId);
    if (recoveredBatchName !== null) this.#worker.setBatchName(recoveredBatchName);
    this.#unsubscribeGpu = this.#gpu.subscribe((snapshot) => this.#onPodSnapshot(snapshot));
    this.#unsubscribeWorker = this.#worker.subscribe((event) => this.#onWorkerEvent(event));
  }

  subscribe(listener: (event: ProductionRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async restoreLocalLibrary(state: AppState): Promise<void> {
    if (this.#recoveredBatchId === null || this.#localLibraryRestored) return;
    if (this.#localLibraryRestore !== null) return this.#localLibraryRestore;
    this.#captureState(state);
    const operation = this.#restoreLocalLibrary(state);
    this.#localLibraryRestore = operation;
    try {
      await operation;
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
    if (snapshot.phase === 'ready') {
      if (!await this.#ensureRecoveredReceipts(state)) return;
      // A worker outage must not obscure the still-live billed Pod. The worker
      // coordinator emits a retryable batch event and the UI keeps Stop visible.
      await this.#worker.poll();
    }
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
    if (!await this.#ensureRecoveredReceipts(state)) return;
    await this.#worker.poll();
  }

  async stopGpu(state: AppState): Promise<void> {
    this.#captureState(state);
    const expectedPodId = state.pod.stopTargetPodId ?? state.pod.podId;
    if (expectedPodId === null) throw new Error('No verified ImageForge Pod is selected.');
    if (state.pod.podId !== expectedPodId) {
      throw new Error('The confirmed Pod changed before termination; refresh RunPod status and confirm again.');
    }
    try {
      await this.#gpu.stop(expectedPodId);
    } catch (error) {
      this.#emitError('pod', error, 'ImageForge could not confirm GPU termination.');
      throw error;
    }
  }

  async startBatch(batch: BatchState): Promise<void> {
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
      this.#emitError('batch', error, 'ImageForge could not create the batch.');
      throw error;
    }
  }

  async pollBatch(state: AppState): Promise<void> {
    this.#captureState(state);
    if (!await this.#ensureRecoveredReceipts(state)) return;
    try {
      await this.#worker.poll();
    } catch (error) {
      // WorkerBatchCoordinator already emitted one classified, redacted
      // failure event. Keep polling ownership single and avoid duplicate UI
      // errors for the same failed request.
      throw error;
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

  dispose(): void {
    this.#unsubscribeGpu();
    this.#unsubscribeWorker();
    this.#gpu.dispose();
    this.#listeners.clear();
  }

  #captureState(state: AppState): void {
    this.#pod = state.pod;
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

  async #ensureRecoveredReceipts(state: AppState): Promise<boolean> {
    if (this.#recoveredBatchId === null || this.#reconciledRecoveredBatch) return true;
    try {
      // Restore the native destination before asking it to hash/ack anything;
      // this closes the startup race between React folder validation and the
      // first worker poll.
      await this.#port.validateDestination(state.settings.defaultDestination);
      await this.#port.reconcileReceipts(this.#recoveredBatchId);
      this.#reconciledRecoveredBatch = true;
      return true;
    } catch (error) {
      this.#emit({
        type: 'error',
        scope: 'batch',
        message: error instanceof Error ? error.message : 'The recovered local receipts are not ready yet.',
        retryable: true,
      });
      return false;
    }
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
    this.#pod = projectPodSnapshot(snapshot, this.#pod);
    this.#emit({ type: 'pod', pod: this.#pod });
  }

  #onWorkerEvent(event: WorkerBatchEvent): void {
    if (event.type === 'idle') {
      this.#emit({ type: 'idle' });
      return;
    }
    if (event.type === 'busy') {
      this.#emit({ type: 'busy', batch: projectBusyBatch(event.summary) });
      return;
    }
    if (event.type === 'error') {
      this.#emit({
        type: 'error',
        scope: 'batch',
        message: event.message,
        retryable: event.retryable,
        ...(event.code ? { code: event.code } : {}),
      });
      return;
    }
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

  #emitError(scope: 'pod' | 'batch', error: unknown, fallback: string): void {
    const message = error instanceof Error && error.message ? error.message : fallback;
    const retryable = typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === true;
    this.#emit({ type: 'error', scope, message, retryable });
  }
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
