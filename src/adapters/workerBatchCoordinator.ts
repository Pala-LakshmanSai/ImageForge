import {
  parseWorkerApiError,
  parseWorkerManifest,
  parseWorkerStatus,
  type WorkerBatchSummary,
  type WorkerManifest,
} from './workerContracts';
import { MAX_BATCH_REFERENCES, MAX_REFERENCE_BYTES, MAX_REFERENCE_TOTAL_BYTES, isReferenceMimeType } from '../domain/references';
import type { BatchReference } from '../domain/types';
import type { AspectRatio } from '../domain/aspectRatio';

export interface WorkerHttpResult {
  status: number;
  body: unknown;
}

export interface LocalDownloadReceipt {
  schemaVersion: 1;
  batchId: string;
  index: number;
  filename: string;
  sha256: string;
  sizeBytes: number;
  verifiedAtUnixMs: number;
}

export interface WorkerBatchPort {
  status(): Promise<WorkerHttpResult>;
  createBatch(prompts: string[], baseSeed: number, references?: WorkerReferencePayload[], aspectRatio?: AspectRatio): Promise<WorkerHttpResult>;
  getBatch(batchId: string): Promise<WorkerHttpResult>;
  pauseBatch(batchId: string): Promise<WorkerHttpResult>;
  resumeBatch(batchId: string): Promise<WorkerHttpResult>;
  cancelBatch(batchId: string): Promise<WorkerHttpResult>;
  retryFailed(batchId: string): Promise<WorkerHttpResult>;
  readReceipts(batchId: string, batchName?: string): Promise<LocalDownloadReceipt[]>;
  downloadArtifact(input: {
    batchId: string;
    batchName?: string;
    index: number;
    expectedSha256: string;
    expectedSizeBytes: number;
    expectedWidth: number;
    expectedHeight: number;
  }): Promise<LocalDownloadReceipt>;
}

export interface WorkerReferencePayload {
  name: string;
  mimeType: BatchReference['mimeType'];
  bytes: number[];
}

export type WorkerBatchEvent =
  | { type: 'idle' }
  | { type: 'stop-pending'; message: string }
  | { type: 'busy'; summary: WorkerBatchSummary }
  | { type: 'manifest'; manifest: WorkerManifest; receipts: readonly LocalDownloadReceipt[] }
  | { type: 'local-error'; batchId: string; code: string; message: string; retryable: boolean }
  | { type: 'error'; code: string; message: string; retryable: boolean };

export class WorkerBatchError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: string, message: string, status: number, retryableOverride?: boolean) {
    super(message);
    this.name = 'WorkerBatchError';
    this.code = code;
    this.status = status;
    this.retryable = retryableOverride ?? (status === 408 || status === 409 || status === 423 || status === 429 || status >= 500);
  }
}

class WorkerLocalSyncError extends WorkerBatchError {
  constructor(code: string, message: string, retryable = true) {
    super(code, message, 0, retryable);
    this.name = 'WorkerLocalSyncError';
  }
}

export function isWorkerLocalSyncError(error: unknown): boolean {
  return error instanceof WorkerLocalSyncError;
}

function localSyncError(error: unknown, fallbackCode: string, fallbackMessage: string): WorkerLocalSyncError {
  if (error instanceof WorkerLocalSyncError) return error;
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
      return new WorkerLocalSyncError(candidate.code, candidate.message, candidate.retryable !== false);
    }
  }
  if (error instanceof Error && error.message) {
    return new WorkerLocalSyncError(fallbackCode, error.message);
  }
  return new WorkerLocalSyncError(fallbackCode, fallbackMessage);
}

type BatchControl = 'pause' | 'resume' | 'cancel' | 'retry_failed';
const DEFAULT_BATCH_NAME = 'Untitled batch';

function isTerminalManifest(manifest: WorkerManifest): boolean {
  return ['completed', 'cancelled', 'failed', 'interrupted'].includes(manifest.state);
}

function isSafeReceiptFilename(filename: string, _batchId: string, index: number): boolean {
  const expectedLeaf = `${String(index).padStart(6, '0')}.jpg`;
  const parts = filename.split('/');
  if (parts.length !== 3 || parts[0] !== 'batches' || parts[2] !== expectedLeaf) return false;
  const folder = parts[1];
  if (
    !folder ||
    folder === '.' ||
    folder === '..' ||
    folder !== folder.trim() ||
    /[.\s]$/u.test(folder) ||
    /[<>:"\\|?*\u0000-\u001f]/u.test(folder) ||
    new TextEncoder().encode(folder).length > 120 ||
    folder.length > 120
  ) return false;
  const stem = folder.split('.')[0].toUpperCase();
  if (/^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])$/u.test(stem)) return false;
  return true;
}

function validateReceipt(receipt: LocalDownloadReceipt, batchId: string): LocalDownloadReceipt {
  if (
    receipt.schemaVersion !== 1 ||
    receipt.batchId !== batchId ||
    !Number.isSafeInteger(receipt.index) ||
    receipt.index < 1 ||
    !isSafeReceiptFilename(receipt.filename, batchId, receipt.index) ||
    !/^[0-9a-f]{64}$/.test(receipt.sha256) ||
    !Number.isSafeInteger(receipt.sizeBytes) ||
    receipt.sizeBytes < 1 ||
    !Number.isSafeInteger(receipt.verifiedAtUnixMs) ||
    receipt.verifiedAtUnixMs < 0
  ) {
    throw new WorkerLocalSyncError('local_receipt_invalid', 'A local download receipt is invalid.', false);
  }
  return { ...receipt };
}

function workerFailure(result: WorkerHttpResult): WorkerBatchError {
  try {
    const error = parseWorkerApiError(result.body);
    return new WorkerBatchError(error.code, error.message, result.status);
  } catch (error) {
    if (error instanceof WorkerBatchError) return error;
    return new WorkerBatchError(
      'worker_response_invalid',
      'The ImageForge worker returned an invalid error response.',
      result.status,
    );
  }
}

function requireSuccess(result: WorkerHttpResult, expected: readonly number[]): unknown {
  if (!expected.includes(result.status)) throw workerFailure(result);
  return result.body;
}

export class WorkerBatchCoordinator {
  readonly #port: WorkerBatchPort;
  readonly #prepareOwnedBatch: ((batchId: string) => Promise<void>) | null;
  readonly #listeners = new Set<(event: WorkerBatchEvent) => void>();
  #ownedBatchId: string | null = null;
  #batchName: string | null = null;
  #observedBusyBatchId: string | null = null;
  #pollPromise: Promise<WorkerBatchEvent> | null = null;
  #receiptCache = new Map<string, Map<number, LocalDownloadReceipt>>();
  #artifactDownloads = new Map<string, { fingerprint: string; promise: Promise<LocalDownloadReceipt> }>();
  #connectionGeneration = 0;
  #stateGeneration = 0;
  #operationTail: Promise<void> = Promise.resolve();
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(
    port: WorkerBatchPort,
    recoveredBatchId: string | null = null,
    prepareOwnedBatch: ((batchId: string) => Promise<void>) | null = null,
  ) {
    this.#port = port;
    this.#ownedBatchId = recoveredBatchId;
    this.#prepareOwnedBatch = prepareOwnedBatch;
  }

  subscribe(listener: (event: WorkerBatchEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get batchId(): string | null {
    return this.#ownedBatchId;
  }

  get batchName(): string | null {
    return this.#batchName;
  }

  invalidateReceipts(batchId?: string): void {
    if (batchId === undefined) this.#receiptCache.clear();
    else this.#receiptCache.delete(batchId);
  }

  setBatchName(batchName: string): void {
    this.#batchName = batchName;
  }

  /**
   * Drops a terminal/recovered batch attachment before the user starts a new
   * brief. The worker retains the durable manifest and local receipts remain
   * indexed in Library; only this coordinator stops replaying it into Create.
   */
  forgetBatch(): void {
    this.#connectionGeneration += 1;
    this.#stateGeneration += 1;
    this.#ownedBatchId = null;
    this.#batchName = null;
    this.#observedBusyBatchId = null;
    // Let the next brief proceed without waiting for stale network I/O. Every
    // old-generation completion is guarded, including its error path.
    this.#operationTail = Promise.resolve();
    this.#mutationTail = Promise.resolve();
    this.#pollPromise = null;
  }

  async create(
    prompts: readonly string[],
    baseSeed: number,
    references: readonly BatchReference[] = [],
    aspectRatio: AspectRatio = '16:9',
    batchName = DEFAULT_BATCH_NAME,
  ): Promise<WorkerBatchEvent> {
    if (
      prompts.length < 1 ||
      prompts.some((prompt) => !prompt.trim()) ||
      !Number.isSafeInteger(baseSeed) ||
      baseSeed < 0 ||
      baseSeed + prompts.length - 1 > Number.MAX_SAFE_INTEGER
    ) {
      throw new WorkerBatchError('batch_request_invalid', 'The batch request is invalid.', 0);
    }
    if (
      references.length > MAX_BATCH_REFERENCES ||
      references.reduce((total, reference) => total + reference.bytes.length, 0) > MAX_REFERENCE_TOTAL_BYTES ||
      references.some((reference) =>
        !reference.name ||
        !isReferenceMimeType(reference.mimeType) ||
        reference.sizeBytes !== reference.bytes.length ||
        reference.bytes.length < 1 ||
        reference.bytes.length > MAX_REFERENCE_BYTES,
      )
    ) {
      throw new WorkerBatchError('batch_reference_invalid', 'One or more image references are invalid.', 0);
    }
    const requestPrompts = [...prompts];
    const requestReferences = references.map(({ name, mimeType, bytes }) => ({
      name,
      mimeType,
      bytes: [...bytes],
    }));
    const connectionGeneration = this.#connectionGeneration;
    const stateGeneration = this.#beginMutation();
    return this.#runExclusive(connectionGeneration, stateGeneration, async () => {
      const result = await this.#runMutationRequest(
        connectionGeneration,
        stateGeneration,
        () => this.#port.createBatch(
          requestPrompts,
          baseSeed,
          requestReferences,
          aspectRatio,
        ),
      );
      if (result === null) return { type: 'idle' };
      if (result.status === 423) {
        const failure = workerFailure(result);
        if (['batch_busy', 'worker_volume_locked', 'worker_standby'].includes(failure.code)) {
          // Always read status after a generation-busy rejection. Reusing a
          // poll that began before the 423 can hide the durable worker lease.
          return this.#pollOnce(connectionGeneration, stateGeneration);
        }
        // `gpu_stop_pending` is not batch busy: the short finalization guard is
        // the only other generation veto and must remain typed/actionable.
        throw failure;
      }
      const manifest = parseWorkerManifest(requireSuccess(result, [201]));
      this.#ownedBatchId = manifest.batchId;
      this.#batchName = batchName;
      this.#observedBusyBatchId = null;
      return this.#synchronizeOwnedManifest(manifest, connectionGeneration, stateGeneration);
    });
  }

  poll(): Promise<WorkerBatchEvent> {
    if (this.#pollPromise !== null) return this.#pollPromise;
    const connectionGeneration = this.#connectionGeneration;
    const stateGeneration = this.#stateGeneration;
    const operation = this.#runExclusive(
      connectionGeneration,
      stateGeneration,
      () => this.#pollOnce(connectionGeneration, stateGeneration),
    ).finally(() => {
      if (this.#pollPromise === operation) this.#pollPromise = null;
    });
    this.#pollPromise = operation;
    return operation;
  }

  async control(action: BatchControl): Promise<WorkerBatchEvent> {
    const batchId = this.#ownedBatchId;
    if (batchId === null) {
      throw new WorkerBatchError('batch_not_connected', 'No owned batch is connected.', 0);
    }
    const connectionGeneration = this.#connectionGeneration;
    const stateGeneration = this.#beginMutation();
    const request = this.#runMutationRequest(connectionGeneration, stateGeneration, () => (
      action === 'pause'
        ? this.#port.pauseBatch(batchId)
        : action === 'resume'
          ? this.#port.resumeBatch(batchId)
          : action === 'cancel'
            ? this.#port.cancelBatch(batchId)
            : this.#port.retryFailed(batchId)
    ));
    // Polling after this control waits for the worker mutation, but never for
    // an older or newly scheduled artifact download.
    this.#operationTail = request.then(
      () => undefined,
      () => undefined,
    );
    const result = await request;
    if (result === null || !this.#isCurrent(connectionGeneration, stateGeneration) || this.#ownedBatchId !== batchId) {
      return { type: 'idle' };
    }
    const manifest = parseWorkerManifest(requireSuccess(result, [200]));
    const event = this.#commitManifestWithoutDownloads(
      manifest,
      connectionGeneration,
      stateGeneration,
    );
    if (event.type !== 'idle') {
      // Reconcile ready artifacts even when cancel makes the UI terminal and
      // stops its interval. Errors remain classified/emitted by poll().
      void this.poll().catch(() => undefined);
    }
    return event;
  }

  async #pollOnce(
    connectionGeneration: number,
    stateGeneration: number,
  ): Promise<WorkerBatchEvent> {
    try {
      const status = parseWorkerStatus(requireSuccess(await this.#port.status(), [200]));
      if (!this.#isCurrent(connectionGeneration, stateGeneration)) return { type: 'idle' };
      if (status.activeBatch === null) {
        const releasedEvent: WorkerBatchEvent = status.ready && !status.permissions.canCreate
          ? {
              type: 'stop-pending',
              message: 'GPU Stop is finalizing; new generation is temporarily blocked.',
            }
          : { type: 'idle' };
        // The worker releases its shared lease as soon as generation reaches a
        // terminal state. Keep the known owner batch ID long enough to fetch
        // that terminal manifest and reconcile every ready artifact; otherwise
        // a final JPEG can become orphaned between two desktop polls.
        if (this.#ownedBatchId !== null) {
          const knownBatchId = this.#ownedBatchId;
          const result = await this.#port.getBatch(knownBatchId);
          if (!this.#isCurrent(connectionGeneration, stateGeneration)) return { type: 'idle' };
          if (result.status === 200) {
            const manifest = parseWorkerManifest(result.body);
            return await this.#synchronizeOwnedManifest(manifest, connectionGeneration, stateGeneration);
          }
          if (result.status !== 404) throw workerFailure(result);
        }
        this.#ownedBatchId = null;
        this.#observedBusyBatchId = null;
        return this.#commit(releasedEvent, connectionGeneration, stateGeneration);
      }
      if (!status.permissions.isOwner) {
        this.#observedBusyBatchId = status.activeBatch.batchId;
        return this.#commit(
          { type: 'busy', summary: status.activeBatch },
          connectionGeneration,
          stateGeneration,
        );
      }
      this.#ownedBatchId = status.activeBatch.batchId;
      this.#observedBusyBatchId = null;
      const manifest = parseWorkerManifest(
        requireSuccess(await this.#port.getBatch(status.activeBatch.batchId), [200]),
      );
      if (!this.#isCurrent(connectionGeneration, stateGeneration)) return { type: 'idle' };
      return await this.#synchronizeOwnedManifest(manifest, connectionGeneration, stateGeneration);
    } catch (error) {
      if (!this.#isCurrent(connectionGeneration, stateGeneration)) return { type: 'idle' };
      if (error instanceof WorkerLocalSyncError) throw error;
      const safe = error instanceof WorkerBatchError
        ? error
        : typeof error === 'object' && error !== null &&
            typeof (error as { code?: unknown }).code === 'string' &&
            typeof (error as { message?: unknown }).message === 'string'
          ? new WorkerBatchError(
              (error as { code: string }).code,
              (error as { message: string }).message,
              0,
              (error as { retryable?: unknown }).retryable === true,
            )
          : new WorkerBatchError('worker_sync_failed', 'Worker status could not be synchronized.', 0);
      this.#commit(
        { type: 'error', code: safe.code, message: safe.message, retryable: safe.retryable },
        connectionGeneration,
        stateGeneration,
      );
      throw safe;
    }
  }

  async #synchronizeOwnedManifest(
    initial: WorkerManifest,
    connectionGeneration: number,
    stateGeneration: number,
  ): Promise<WorkerBatchEvent> {
    if (!this.#isCurrent(connectionGeneration, stateGeneration)) return { type: 'idle' };
    let manifest = initial;
    const cached = this.#receiptCache.get(manifest.batchId);
    const initiallyKnownReceipts = [...(cached?.values() ?? [])]
      .sort((left, right) => left.index - right.index);
    // The worker manifest is shared truth. Keep a receipt-free projection so
    // any later device-local failure can be published before its actionable
    // local error instead of hiding Ready or the worker-confirmed batch.
    const sharedEvent = { type: 'manifest', manifest, receipts: initiallyKnownReceipts } as const;
    const visibleSharedState = this.#commit(
      sharedEvent,
      connectionGeneration,
      stateGeneration,
    );
    if (visibleSharedState.type === 'idle') return visibleSharedState;

    try {
      if (this.#prepareOwnedBatch !== null) {
        try {
          await this.#prepareOwnedBatch(manifest.batchId);
        } catch (error) {
          throw localSyncError(
            error,
            'local_recovery_unavailable',
            'The local download recovery state is not available yet.',
          );
        }
      }
    const byIndex = cached ?? new Map<number, LocalDownloadReceipt>();
    if (cached === undefined) {
      let rawReceipts: LocalDownloadReceipt[];
      try {
        rawReceipts = await this.#port.readReceipts(
          manifest.batchId,
          this.#batchName ?? undefined,
        );
      } catch (error) {
        throw localSyncError(
          error,
          'local_receipts_unavailable',
          'The local download receipts are not available yet.',
        );
      }
      if (!this.#isCurrent(connectionGeneration, stateGeneration)) return { type: 'idle' };
      for (const receipt of rawReceipts) {
        const valid = validateReceipt(receipt, manifest.batchId);
        byIndex.set(valid.index, valid);
      }
      if (this.#batchName === null && rawReceipts.length > 0) {
        const folderNames = new Set(rawReceipts.map((receipt) => receipt.filename.split('/')[1]));
        const [folderName] = folderNames;
        if (folderNames.size === 1 && folderName !== manifest.batchId) {
          this.#batchName = folderName;
        }
      }
      this.#receiptCache.set(manifest.batchId, byIndex);
    }
    let receipts = cached === undefined && byIndex.size > 0
      ? [...byIndex.values()].sort((left, right) => left.index - right.index)
      : initiallyKnownReceipts;
    const reconciledArtifactIndexes = new Set<number>();
    // At most one successful native download/acknowledgement is attempted for
    // each artifact in this synchronization. The extra pass either commits a
    // stable manifest or reports a retryable terminal acknowledgement gap.
    const maxReconciliationPasses = manifest.images.length + 1;

    for (let pass = 0; pass < maxReconciliationPasses; pass += 1) {
      let reconciledThisPass = false;
      let hasUnreconciledArtifact = false;

      // Publish the freshly observed worker state before waiting on any native
      // writes. This lets ready rows and previews advance immediately while
      // preserving sequential, checksum-verified artifact reconciliation.
      for (const image of manifest.images) {
        if (!this.#isCurrent(connectionGeneration, stateGeneration)) return { type: 'idle' };
        if (!['ready', 'downloaded'].includes(image.status)) continue;
        if (image.sha256 === null || image.sizeBytes === null) {
          throw new WorkerBatchError(
            'worker_manifest_invalid',
            'A ready image is missing its checksum or byte count.',
            0,
          );
        }
        const local = byIndex.get(image.index);
        const localMatches = local?.sha256 === image.sha256 && local.sizeBytes === image.sizeBytes;
        if (local !== undefined && !localMatches) {
          throw new WorkerLocalSyncError(
            'local_receipt_conflict',
            `Local frame ${image.index} does not match the worker manifest.`,
            false,
          );
        }
        if (
          !reconciledArtifactIndexes.has(image.index) &&
          !(localMatches && image.status === 'downloaded')
        ) {
          hasUnreconciledArtifact = true;
        }
      }
      if (hasUnreconciledArtifact) {
        const staged = manifest === initial && receipts === initiallyKnownReceipts
          ? sharedEvent
          : this.#commit(
              { type: 'manifest', manifest, receipts },
              connectionGeneration,
              stateGeneration,
            );
        if (staged.type === 'idle' || !this.#isCurrent(connectionGeneration, stateGeneration)) {
          return { type: 'idle' };
        }
      }

      for (const image of manifest.images) {
        if (!this.#isCurrent(connectionGeneration, stateGeneration)) return { type: 'idle' };
        if (!['ready', 'downloaded'].includes(image.status)) continue;
        if (image.sha256 === null || image.sizeBytes === null) {
          throw new WorkerBatchError(
            'worker_manifest_invalid',
            'A ready image is missing its checksum or byte count.',
            0,
          );
        }
        const local = byIndex.get(image.index);
        const localMatches = local?.sha256 === image.sha256 && local.sizeBytes === image.sizeBytes;
        if (localMatches && image.status === 'downloaded') continue;
        if (reconciledArtifactIndexes.has(image.index)) continue;
        // A local receipt is durable before the native layer sends the worker
        // acknowledgement. If that acknowledgement fails (or the process dies
        // in between), the worker can still report this image as `ready` while
        // the local ledger already contains the verified JPEG. Re-run the
        // idempotent native download/ack path in that state; it sees the final
        // file, verifies it, and retries only the missing worker mutation.
        // Never treat a matching local receipt as proof of acknowledgement until
        // the worker manifest itself reports `downloaded`.
        if (local !== undefined) {
          if (localMatches && image.status === 'ready') {
            const receipt = validateReceipt(
              await this.#downloadArtifactOnce({
                batchId: manifest.batchId,
                batchName: this.#batchName ?? undefined,
                index: image.index,
                expectedSha256: image.sha256,
                expectedSizeBytes: image.sizeBytes,
                expectedWidth: manifest.settings.width,
                expectedHeight: manifest.settings.height,
              }),
              manifest.batchId,
            );
            if (!this.#isCurrent(connectionGeneration, stateGeneration)) return { type: 'idle' };
            byIndex.set(receipt.index, receipt);
            this.#receiptCache.set(manifest.batchId, byIndex);
            receipts = [...byIndex.values()].sort((left, right) => left.index - right.index);
            reconciledArtifactIndexes.add(image.index);
            reconciledThisPass = true;
            continue;
          }
          throw new WorkerLocalSyncError(
            'local_receipt_conflict',
            `Local frame ${image.index} does not match the worker manifest.`,
            false,
          );
        }
        const receipt = validateReceipt(
          await this.#downloadArtifactOnce({
            batchId: manifest.batchId,
            batchName: this.#batchName ?? undefined,
            index: image.index,
            expectedSha256: image.sha256,
            expectedSizeBytes: image.sizeBytes,
            expectedWidth: manifest.settings.width,
            expectedHeight: manifest.settings.height,
          }),
          manifest.batchId,
        );
        if (!this.#isCurrent(connectionGeneration, stateGeneration)) return { type: 'idle' };
        byIndex.set(receipt.index, receipt);
        this.#receiptCache.set(manifest.batchId, byIndex);
        receipts = [...byIndex.values()].sort((left, right) => left.index - right.index);
        const receiptEvent = this.#commit(
          { type: 'manifest', manifest, receipts },
          connectionGeneration,
          stateGeneration,
        );
        if (receiptEvent.type === 'idle' || !this.#isCurrent(connectionGeneration, stateGeneration)) {
          return { type: 'idle' };
        }
        reconciledArtifactIndexes.add(image.index);
        reconciledThisPass = true;
      }

      if (!reconciledThisPass) {
        if (isTerminalManifest(manifest) && manifest.images.some((image) => image.status === 'ready')) {
          throw new WorkerLocalSyncError(
            'terminal_reconciliation_pending',
            'A verified image is still awaiting worker acknowledgement.',
          );
        }
        if (!this.#isCurrent(connectionGeneration, stateGeneration)) return { type: 'idle' };
        if (manifest === initial && receipts === initiallyKnownReceipts) return sharedEvent;
        return this.#commit(
          { type: 'manifest', manifest, receipts },
          connectionGeneration,
          stateGeneration,
        );
      }

      manifest = parseWorkerManifest(
        requireSuccess(await this.#port.getBatch(manifest.batchId), [200]),
      );
      if (!this.#isCurrent(connectionGeneration, stateGeneration)) return { type: 'idle' };
    }

    throw new WorkerLocalSyncError(
      'worker_reconciliation_limit',
      'Artifact reconciliation did not reach a stable worker manifest.',
    );
    } catch (error) {
      if (!(error instanceof WorkerLocalSyncError)) throw error;
      this.#commit(
        {
          type: 'local-error',
          batchId: manifest.batchId,
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        },
        connectionGeneration,
        stateGeneration,
      );
      throw error;
    }
  }

  #downloadArtifactOnce(input: {
    batchId: string;
    batchName?: string;
    index: number;
    expectedSha256: string;
    expectedSizeBytes: number;
    expectedWidth: number;
    expectedHeight: number;
  }): Promise<LocalDownloadReceipt> {
    const key = `${input.batchId}:${input.index}`;
    const fingerprint = [
      input.batchName ?? 'legacy-folder',
      input.expectedSha256,
      input.expectedSizeBytes,
      input.expectedWidth,
      input.expectedHeight,
    ].join(':');
    const active = this.#artifactDownloads.get(key);
    if (active !== undefined) {
      if (active.fingerprint !== fingerprint) {
        throw new WorkerBatchError(
          'worker_manifest_invalid',
          `Worker frame ${input.index} changed while its artifact was downloading.`,
          0,
        );
      }
      return active.promise;
    }
    const operation = this.#port.downloadArtifact(input).catch((error: unknown) => {
      throw localSyncError(
        error,
        'local_download_unavailable',
        `Frame ${input.index} could not be saved to this device yet.`,
      );
    }).finally(() => {
      if (this.#artifactDownloads.get(key)?.promise === operation) {
        this.#artifactDownloads.delete(key);
      }
    });
    this.#artifactDownloads.set(key, { fingerprint, promise: operation });
    return operation;
  }

  #commitManifestWithoutDownloads(
    manifest: WorkerManifest,
    connectionGeneration: number,
    stateGeneration: number,
  ): WorkerBatchEvent {
    const receipts = [...(this.#receiptCache.get(manifest.batchId)?.values() ?? [])]
      .sort((left, right) => left.index - right.index);
    return this.#commit(
      { type: 'manifest', manifest, receipts },
      connectionGeneration,
      stateGeneration,
    );
  }

  #commit<T extends WorkerBatchEvent>(
    event: T,
    connectionGeneration: number,
    stateGeneration: number,
  ): T | { type: 'idle' } {
    if (!this.#isCurrent(connectionGeneration, stateGeneration)) return { type: 'idle' };
    return this.#emit(event);
  }

  #runExclusive(
    connectionGeneration: number,
    stateGeneration: number,
    operation: () => Promise<WorkerBatchEvent>,
  ): Promise<WorkerBatchEvent> {
    const predecessor = this.#operationTail;
    const result = predecessor.then(async () => {
      if (!this.#isCurrent(connectionGeneration, stateGeneration)) return { type: 'idle' } as const;
      try {
        return await operation();
      } catch (error) {
        // New brief is a hard epoch boundary: old requests, parsing failures,
        // and download errors must all become inert after it is crossed.
        if (!this.#isCurrent(connectionGeneration, stateGeneration)) return { type: 'idle' } as const;
        throw error;
      }
    });
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #runMutationRequest<T>(
    connectionGeneration: number,
    stateGeneration: number,
    request: () => Promise<T>,
  ): Promise<T | null> {
    const predecessor = this.#mutationTail;
    const result = predecessor.then(async () => {
      if (!this.#isCurrent(connectionGeneration, stateGeneration)) return null;
      try {
        const value = await request();
        return this.#isCurrent(connectionGeneration, stateGeneration) ? value : null;
      } catch (error) {
        if (!this.#isCurrent(connectionGeneration, stateGeneration)) return null;
        throw error;
      }
    });
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #beginMutation(): number {
    this.#stateGeneration += 1;
    this.#operationTail = Promise.resolve();
    this.#pollPromise = null;
    return this.#stateGeneration;
  }

  #isCurrent(connectionGeneration: number, stateGeneration: number): boolean {
    return connectionGeneration === this.#connectionGeneration && stateGeneration === this.#stateGeneration;
  }

  #emit<T extends WorkerBatchEvent>(event: T): T {
    for (const listener of this.#listeners) listener(event);
    return event;
  }
}
