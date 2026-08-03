import { ASPECT_RATIOS } from '../domain/aspectRatio';
import {
  MAX_BATCH_REFERENCES,
  MAX_REFERENCE_BYTES,
  MAX_REFERENCE_TOTAL_BYTES,
} from '../domain/references';

const BATCH_STATES = [
  'running',
  'paused',
  'completed',
  'cancelled',
  'failed',
  'interrupted',
] as const;
const ACTIVE_BATCH_STATES = ['running', 'paused', 'interrupted'] as const;

const IMAGE_STATES = [
  'pending',
  'generating',
  'retrying',
  'ready',
  'downloaded',
  'failed',
  'cancelled',
] as const;

export type WorkerBatchState = (typeof BATCH_STATES)[number];
export type WorkerActiveBatchState = (typeof ACTIVE_BATCH_STATES)[number];
export type WorkerImageState = (typeof IMAGE_STATES)[number];

export interface WorkerOwner {
  userId: string;
  displayName: string;
}

export interface WorkerProgress {
  total: number;
  completed: number;
  downloaded: number;
  failed: number;
  cancelled: number;
  processed: number;
  currentIndex: number | null;
}

export interface WorkerBatchSummary {
  batchId: string;
  owner: WorkerOwner;
  state: WorkerActiveBatchState;
  progress: WorkerProgress;
  pauseRequested: boolean;
  cancelRequested: boolean;
}

export interface WorkerStatus {
  schemaVersion: 1;
  ready: boolean;
  activeBatch: WorkerBatchSummary | null;
  permissions: {
    canCreate: boolean;
    canManageActive: boolean;
    isOwner: boolean;
  };
}

export interface WorkerImageRecord {
  index: number;
  prompt: string;
  seed: number;
  status: WorkerImageState;
  attempts: number;
  retryRounds: number;
  filename: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  generationMs: number | null;
  error: { code: string; message: string } | null;
  receipt: {
    sha256: string;
    sizeBytes: number;
    acknowledgedAt: string;
  } | null;
}

export interface WorkerManifest {
  schemaVersion: 1;
  batchId: string;
  owner: WorkerOwner;
  state: WorkerBatchState;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  interruptedAt: string | null;
  pauseRequested: boolean;
  cancelRequested: boolean;
  settings: WorkerRenderSettings;
  references: WorkerReferenceMetadata[];
  images: WorkerImageRecord[];
  progress: WorkerProgress;
}

export interface WorkerRenderSettings {
  width: number;
  height: number;
}

export interface WorkerReferenceMetadata {
  name: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  sizeBytes: number;
  sha256: string;
  filename: string;
}

export interface WorkerApiError {
  code: string;
  message: string;
  details: Readonly<Record<string, unknown>> | null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new Error(`${label} contained an unknown field.`);
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a string.`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be a safe integer.`);
  }
  return value as number;
}

function renderDimension(value: unknown, label: string): number {
  const parsed = integer(value, label, 64);
  if (parsed > 2048 || parsed % 8 !== 0) throw new Error(`${label} is not a supported render dimension.`);
  return parsed;
}

function renderSettings(value: unknown): WorkerRenderSettings {
  if (value === undefined) return { width: 1280, height: 720 };
  const item = record(value, 'settings');
  exactKeys(item, ['width', 'height'], 'settings');
  const width = renderDimension(item.width, 'settings.width');
  const height = renderDimension(item.height, 'settings.height');
  if (!ASPECT_RATIOS.some((option) => option.width === width && option.height === height)) {
    throw new Error('settings dimensions are not an ImageForge render size.');
  }
  return { width, height };
}

function finite(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

function nullable<T>(value: unknown, parse: (input: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function enumeration<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as T;
}

function owner(value: unknown): WorkerOwner {
  const item = record(value, 'owner');
  exactKeys(item, ['user_id', 'display_name'], 'owner');
  return {
    userId: string(item.user_id, 'owner.user_id'),
    displayName: string(item.display_name, 'owner.display_name'),
  };
}

function progress(value: unknown): WorkerProgress {
  const item = record(value, 'progress');
  exactKeys(
    item,
    ['total', 'completed', 'downloaded', 'failed', 'cancelled', 'processed', 'current_index'],
    'progress',
  );
  const parsed: WorkerProgress = {
    total: integer(item.total, 'progress.total', 1),
    completed: integer(item.completed, 'progress.completed'),
    downloaded: integer(item.downloaded, 'progress.downloaded'),
    failed: integer(item.failed, 'progress.failed'),
    cancelled: integer(item.cancelled, 'progress.cancelled'),
    processed: integer(item.processed, 'progress.processed'),
    currentIndex: nullable(item.current_index, (candidate) => integer(candidate, 'progress.current_index', 1)),
  };
  if (
    parsed.completed > parsed.total ||
    parsed.downloaded > parsed.completed ||
    parsed.failed > parsed.total ||
    parsed.cancelled > parsed.total ||
    parsed.processed > parsed.total ||
    parsed.completed + parsed.failed + parsed.cancelled !== parsed.processed ||
    (parsed.currentIndex !== null && parsed.currentIndex > parsed.total)
  ) {
    throw new Error('progress counters are inconsistent.');
  }
  return parsed;
}

function summary(value: unknown): WorkerBatchSummary {
  const item = record(value, 'active_batch');
  exactKeys(
    item,
    ['batch_id', 'owner', 'state', 'progress', 'pause_requested', 'cancel_requested'],
    'active_batch',
  );
  return {
    batchId: uuid(item.batch_id, 'active_batch.batch_id'),
    owner: owner(item.owner),
    state: enumeration(item.state, ACTIVE_BATCH_STATES, 'active_batch.state'),
    progress: progress(item.progress),
    pauseRequested: boolean(item.pause_requested, 'active_batch.pause_requested'),
    cancelRequested: boolean(item.cancel_requested, 'active_batch.cancel_requested'),
  };
}

/** Reuses the same strict projection for collaboration snapshots, whose
 * active_batch field is the worker status summary verbatim. */
export function parseWorkerBatchSummary(value: unknown): WorkerBatchSummary {
  return summary(value);
}

function safeError(value: unknown): WorkerImageRecord['error'] {
  if (value === null) return null;
  const item = record(value, 'image.error');
  exactKeys(item, ['code', 'message'], 'image.error');
  return { code: string(item.code, 'image.error.code'), message: string(item.message, 'image.error.message') };
}

function receipt(value: unknown): WorkerImageRecord['receipt'] {
  if (value === null) return null;
  const item = record(value, 'image.receipt');
  // The native projector intentionally omits the worker-side user identifier.
  exactKeys(item, ['sha256', 'size_bytes', 'acknowledged_at'], 'image.receipt');
  return {
    sha256: checksum(item.sha256, 'image.receipt.sha256'),
    sizeBytes: integer(item.size_bytes, 'image.receipt.size_bytes', 1),
    acknowledgedAt: string(item.acknowledged_at, 'image.receipt.acknowledged_at'),
  };
}

function checksum(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!/^[0-9a-f]{64}$/.test(parsed)) throw new Error(`${label} is invalid.`);
  return parsed;
}

function uuid(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) {
    throw new Error(`${label} is not a valid batch UUID.`);
  }
  return parsed;
}

function referenceMetadata(value: unknown): WorkerReferenceMetadata {
  const item = record(value, 'manifest reference');
  exactKeys(item, ['name', 'mime_type', 'size_bytes', 'sha256', 'filename'], 'manifest reference');
  const mimeType = enumeration(item.mime_type, ['image/jpeg', 'image/png', 'image/webp'] as const, 'manifest reference.mime_type');
  const name = string(item.name, 'manifest reference.name');
  if (name.trim().length === 0 || name.length > 255 || /[\\/\0]/.test(name)) {
    throw new Error('manifest reference name is invalid.');
  }
  const filename = string(item.filename, 'manifest reference.filename');
  if (!/^references\/\d{6}\.(?:jpg|png|webp)$/.test(filename)) throw new Error('manifest reference filename is invalid.');
  const sizeBytes = integer(item.size_bytes, 'manifest reference.size_bytes', 1);
  if (sizeBytes > MAX_REFERENCE_BYTES) throw new Error('manifest reference size is invalid.');
  return {
    name,
    mimeType,
    sizeBytes,
    sha256: checksum(item.sha256, 'manifest reference.sha256'),
    filename,
  };
}

function image(value: unknown, expectedIndex: number): WorkerImageRecord {
  const item = record(value, `images[${expectedIndex - 1}]`);
  // Attempts-in-cycle/history are intentionally removed by the native response
  // projector. Preview bytes are fetched separately through the authenticated
  // native preview command so they never travel through the renderer's JSON
  // manifest path.
  exactKeys(
    item,
    [
      'index',
      'prompt',
      'seed',
      'status',
      'attempts',
      'retry_rounds',
      'filename',
      'sha256',
      'size_bytes',
      'generation_ms',
      'error',
      'receipt',
    ],
    `images[${expectedIndex - 1}]`,
  );
  const index = integer(item.index, 'image.index', 1);
  if (index !== expectedIndex) throw new Error('manifest image indices must be contiguous and ordered.');
  const filename = nullable(item.filename, (candidate) => string(candidate, 'image.filename'));
  if (filename !== null && filename !== `artifacts/${String(index).padStart(6, '0')}.jpg`) {
    throw new Error('image filename is not the server-generated ordered path.');
  }
  const prompt = string(item.prompt, 'image.prompt');
  if (!prompt.trim() || prompt.includes('\0')) throw new Error('image.prompt must contain safe text.');
  const status = enumeration(item.status, IMAGE_STATES, 'image.status');
  const sha256 = nullable(item.sha256, (candidate) => checksum(candidate, 'image.sha256'));
  const sizeBytes = nullable(item.size_bytes, (candidate) => integer(candidate, 'image.size_bytes', 1));
  const imageReceipt = receipt(item.receipt);
  if (['ready', 'downloaded'].includes(status) && (filename === null || sha256 === null || sizeBytes === null)) {
    throw new Error('ready image is missing its durable artifact metadata.');
  }
  if (status === 'downloaded' && imageReceipt === null) {
    throw new Error('downloaded image is missing its receipt.');
  }
  if (imageReceipt !== null && (
    status !== 'downloaded' ||
    imageReceipt.sha256 !== sha256 ||
    imageReceipt.sizeBytes !== sizeBytes
  )) {
    throw new Error('image receipt does not match its artifact.');
  }
  return {
    index,
    prompt,
    seed: integer(item.seed, 'image.seed'),
    status,
    attempts: integer(item.attempts, 'image.attempts'),
    retryRounds: integer(item.retry_rounds, 'image.retry_rounds'),
    filename,
    sha256,
    sizeBytes,
    generationMs: nullable(item.generation_ms, (candidate) => finite(candidate, 'image.generation_ms')),
    error: safeError(item.error),
    receipt: imageReceipt,
  };
}

export function parseWorkerStatus(value: unknown): WorkerStatus {
  const item = record(value, 'worker status');
  exactKeys(item, ['schema_version', 'ready', 'active_batch', 'permissions'], 'worker status');
  if (item.schema_version !== 1) throw new Error('worker status schema version is unsupported.');
  const permissions = record(item.permissions, 'permissions');
  exactKeys(permissions, ['can_create', 'can_manage_active', 'is_owner'], 'permissions');
  const activeBatch = item.active_batch === null ? null : summary(item.active_batch);
  const parsed: WorkerStatus = {
    schemaVersion: 1,
    ready: boolean(item.ready, 'ready'),
    activeBatch,
    permissions: {
      canCreate: boolean(permissions.can_create, 'permissions.can_create'),
      canManageActive: boolean(permissions.can_manage_active, 'permissions.can_manage_active'),
      isOwner: boolean(permissions.is_owner, 'permissions.is_owner'),
    },
  };
  if (activeBatch !== null && parsed.permissions.canCreate) {
    throw new Error('worker status cannot allow creation while an active batch owns the lease.');
  }
  if (parsed.permissions.isOwner && activeBatch === null) {
    throw new Error('worker status cannot name an owner without an active batch.');
  }
  if (parsed.permissions.canManageActive && !parsed.permissions.isOwner) {
    throw new Error('worker status cannot grant mutation access to a non-owner.');
  }
  return parsed;
}

export function parseWorkerManifest(value: unknown): WorkerManifest {
  const item = record(value, 'worker manifest');
  // The native projector removes model internals and request-control fields the
  // renderer does not use, while retaining every recovery-critical field.
  exactKeys(
    item,
    [
      'schema_version',
      'batch_id',
      'owner',
      'state',
      'created_at',
      'updated_at',
      'completed_at',
      'interrupted_at',
      'pause_requested',
      'cancel_requested',
      'settings',
      'references',
      'images',
      'progress',
    ],
    'worker manifest',
  );
  if (item.schema_version !== 1) throw new Error('worker manifest schema version is unsupported.');
  if (!Array.isArray(item.images) || item.images.length < 1) {
    throw new Error('worker manifest image count is invalid.');
  }
  const images = item.images.map((candidate, index) => image(candidate, index + 1));
  const references = item.references === undefined
    ? []
    : (() => {
        if (!Array.isArray(item.references)) throw new Error('worker manifest references are invalid.');
        if (item.references.length > MAX_BATCH_REFERENCES) throw new Error('worker manifest references exceed the safe limit.');
        const parsedReferences = item.references.map(referenceMetadata);
        if (parsedReferences.reduce((total, reference) => total + reference.sizeBytes, 0) > MAX_REFERENCE_TOTAL_BYTES) {
          throw new Error('worker manifest references exceed the total safe size.');
        }
        return parsedReferences;
      })();
  const parsedProgress = progress(item.progress);
  if (parsedProgress.total !== images.length) throw new Error('worker manifest total does not match its images.');
  const completed = images.filter((image) => image.status === 'ready' || image.status === 'downloaded').length;
  const downloaded = images.filter((image) => image.status === 'downloaded').length;
  const failed = images.filter((image) => image.status === 'failed').length;
  const cancelled = images.filter((image) => image.status === 'cancelled').length;
  const generating = images.filter((image) => image.status === 'generating');
  if (
    parsedProgress.completed !== completed ||
    parsedProgress.downloaded !== downloaded ||
    parsedProgress.failed !== failed ||
    parsedProgress.cancelled !== cancelled ||
    parsedProgress.processed !== completed + failed + cancelled ||
    parsedProgress.currentIndex !== (generating.length === 1 ? generating[0].index : null) ||
    generating.length > 1
  ) {
    throw new Error('worker manifest progress does not match image states.');
  }
  return {
    schemaVersion: 1,
    batchId: uuid(item.batch_id, 'batch_id'),
    owner: owner(item.owner),
    state: enumeration(item.state, BATCH_STATES, 'state'),
    createdAt: string(item.created_at, 'created_at'),
    updatedAt: string(item.updated_at, 'updated_at'),
    completedAt: nullable(item.completed_at, (candidate) => string(candidate, 'completed_at')),
    interruptedAt: nullable(item.interrupted_at, (candidate) => string(candidate, 'interrupted_at')),
    pauseRequested: boolean(item.pause_requested, 'pause_requested'),
    cancelRequested: boolean(item.cancel_requested, 'cancel_requested'),
    settings: renderSettings(item.settings),
    references,
    images,
    progress: parsedProgress,
  };
}

export function parseWorkerApiError(value: unknown): WorkerApiError {
  const envelope = record(value, 'worker error');
  exactKeys(envelope, ['error'], 'worker error');
  const item = record(envelope.error, 'worker error.error');
  exactKeys(item, ['code', 'message', 'details'], 'worker error.error');
  const details = item.details === null ? null : record(item.details, 'worker error.details');
  return {
    code: string(item.code, 'worker error.code'),
    message: string(item.message, 'worker error.message'),
    details,
  };
}
