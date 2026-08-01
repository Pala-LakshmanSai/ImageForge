import {
  parseWorkerApiError,
  parseWorkerManifest,
  parseWorkerStatus,
  type WorkerBatchSummary,
  type WorkerManifest,
} from './workerContracts';
import { MAX_BATCH_REFERENCES, MAX_REFERENCE_BYTES, MAX_REFERENCE_TOTAL_BYTES, isReferenceMimeType } from '../domain/references';
import type { BatchReference } from '../domain/types';

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
  createBatch(prompts: string[], baseSeed: number, references?: WorkerReferencePayload[]): Promise<WorkerHttpResult>;
  getBatch(batchId: string): Promise<WorkerHttpResult>;
  pauseBatch(batchId: string): Promise<WorkerHttpResult>;
  resumeBatch(batchId: string): Promise<WorkerHttpResult>;
  cancelBatch(batchId: string): Promise<WorkerHttpResult>;
  retryFailed(batchId: string): Promise<WorkerHttpResult>;
  readReceipts(batchId: string): Promise<LocalDownloadReceipt[]>;
  downloadArtifact(input: {
    batchId: string;
    index: number;
    expectedSha256: string;
    expectedSizeBytes: number;
  }): Promise<LocalDownloadReceipt>;
}

export interface WorkerReferencePayload {
  name: string;
  mimeType: BatchReference['mimeType'];
  bytes: number[];
}

export type WorkerBatchEvent =
  | { type: 'idle' }
  | { type: 'busy'; summary: WorkerBatchSummary }
  | { type: 'manifest'; manifest: WorkerManifest; receipts: readonly LocalDownloadReceipt[] }
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

type BatchControl = 'pause' | 'resume' | 'cancel' | 'retry_failed';

function validateReceipt(receipt: LocalDownloadReceipt, batchId: string): LocalDownloadReceipt {
  if (
    receipt.schemaVersion !== 1 ||
    receipt.batchId !== batchId ||
    !Number.isSafeInteger(receipt.index) ||
    receipt.index < 1 ||
    receipt.filename !== `batches/${batchId}/${String(receipt.index).padStart(6, '0')}.jpg` ||
    !/^[0-9a-f]{64}$/.test(receipt.sha256) ||
    !Number.isSafeInteger(receipt.sizeBytes) ||
    receipt.sizeBytes < 1 ||
    !Number.isSafeInteger(receipt.verifiedAtUnixMs) ||
    receipt.verifiedAtUnixMs < 0
  ) {
    throw new WorkerBatchError('local_receipt_invalid', 'A local download receipt is invalid.', 0);
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
  readonly #listeners = new Set<(event: WorkerBatchEvent) => void>();
  #ownedBatchId: string | null = null;
  #observedBusyBatchId: string | null = null;
  #pollPromise: Promise<WorkerBatchEvent> | null = null;
  #receiptCache = new Map<string, Map<number, LocalDownloadReceipt>>();

  constructor(port: WorkerBatchPort, recoveredBatchId: string | null = null) {
    this.#port = port;
    this.#ownedBatchId = recoveredBatchId;
  }

  subscribe(listener: (event: WorkerBatchEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get batchId(): string | null {
    return this.#ownedBatchId;
  }

  invalidateReceipts(batchId?: string): void {
    if (batchId === undefined) this.#receiptCache.clear();
    else this.#receiptCache.delete(batchId);
  }

  async create(prompts: readonly string[], baseSeed: number, references: readonly BatchReference[] = []): Promise<WorkerBatchEvent> {
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
    const result = await this.#port.createBatch(
      [...prompts],
      baseSeed,
      references.map(({ name, mimeType, bytes }) => ({ name, mimeType, bytes: [...bytes] })),
    );
    if (result.status === 423) {
      // The authoritative status contains owner/progress without exposing the
      // other user's prompt manifest. There is deliberately no local queue.
      return this.poll();
    }
    const manifest = parseWorkerManifest(requireSuccess(result, [201]));
    this.#ownedBatchId = manifest.batchId;
    this.#observedBusyBatchId = null;
    return this.#synchronizeOwnedManifest(manifest);
  }

  poll(): Promise<WorkerBatchEvent> {
    if (this.#pollPromise !== null) return this.#pollPromise;
    const operation = this.#pollOnce().finally(() => {
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
    const request = action === 'pause'
      ? this.#port.pauseBatch(batchId)
      : action === 'resume'
        ? this.#port.resumeBatch(batchId)
        : action === 'cancel'
          ? this.#port.cancelBatch(batchId)
          : this.#port.retryFailed(batchId);
    const manifest = parseWorkerManifest(requireSuccess(await request, [200]));
    return this.#synchronizeOwnedManifest(manifest);
  }

  async #pollOnce(): Promise<WorkerBatchEvent> {
    try {
      const status = parseWorkerStatus(requireSuccess(await this.#port.status(), [200]));
      if (status.activeBatch === null) {
        // The worker releases its shared lease as soon as generation reaches a
        // terminal state. Keep the known owner batch ID long enough to fetch
        // that terminal manifest and reconcile every ready artifact; otherwise
        // a final JPEG can become orphaned between two desktop polls.
        if (this.#ownedBatchId !== null) {
          const knownBatchId = this.#ownedBatchId;
          const result = await this.#port.getBatch(knownBatchId);
          if (result.status === 200) {
            const manifest = parseWorkerManifest(result.body);
            return this.#synchronizeOwnedManifest(manifest);
          }
          if (result.status !== 404) throw workerFailure(result);
        }
        this.#ownedBatchId = null;
        this.#observedBusyBatchId = null;
        return this.#emit({ type: 'idle' });
      }
      if (!status.permissions.isOwner) {
        this.#observedBusyBatchId = status.activeBatch.batchId;
        return this.#emit({ type: 'busy', summary: status.activeBatch });
      }
      this.#ownedBatchId = status.activeBatch.batchId;
      this.#observedBusyBatchId = null;
      const manifest = parseWorkerManifest(
        requireSuccess(await this.#port.getBatch(status.activeBatch.batchId), [200]),
      );
      return this.#synchronizeOwnedManifest(manifest);
    } catch (error) {
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
      this.#emit({ type: 'error', code: safe.code, message: safe.message, retryable: safe.retryable });
      throw safe;
    }
  }

  async #synchronizeOwnedManifest(initial: WorkerManifest): Promise<WorkerBatchEvent> {
    let manifest = initial;
    const cached = this.#receiptCache.get(manifest.batchId);
    const byIndex = cached ?? new Map<number, LocalDownloadReceipt>();
    if (cached === undefined) {
      const rawReceipts = await this.#port.readReceipts(manifest.batchId);
      for (const receipt of rawReceipts) {
        const valid = validateReceipt(receipt, manifest.batchId);
        byIndex.set(valid.index, valid);
      }
      this.#receiptCache.set(manifest.batchId, byIndex);
    }
    let receipts = [...byIndex.values()].sort((left, right) => left.index - right.index);
    let downloaded = false;

    for (const image of manifest.images) {
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
            await this.#port.downloadArtifact({
              batchId: manifest.batchId,
              index: image.index,
              expectedSha256: image.sha256,
              expectedSizeBytes: image.sizeBytes,
            }),
            manifest.batchId,
          );
          byIndex.set(receipt.index, receipt);
          this.#receiptCache.set(manifest.batchId, byIndex);
          receipts = [...byIndex.values()].sort((left, right) => left.index - right.index);
          downloaded = true;
          continue;
        }
        throw new WorkerBatchError(
          'local_receipt_conflict',
          `Local frame ${image.index} does not match the worker manifest.`,
          0,
        );
      }
      const receipt = validateReceipt(
        await this.#port.downloadArtifact({
          batchId: manifest.batchId,
          index: image.index,
          expectedSha256: image.sha256,
          expectedSizeBytes: image.sizeBytes,
        }),
        manifest.batchId,
      );
      byIndex.set(receipt.index, receipt);
      this.#receiptCache.set(manifest.batchId, byIndex);
      receipts = [...byIndex.values()].sort((left, right) => left.index - right.index);
      downloaded = true;
    }

    if (downloaded) {
      manifest = parseWorkerManifest(
        requireSuccess(await this.#port.getBatch(manifest.batchId), [200]),
      );
    }
    return this.#emit({ type: 'manifest', manifest, receipts });
  }

  #emit<T extends WorkerBatchEvent>(event: T): T {
    for (const listener of this.#listeners) listener(event);
    return event;
  }
}
