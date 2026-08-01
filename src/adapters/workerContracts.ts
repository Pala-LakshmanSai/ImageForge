const BATCH_STATES = [
  'running',
  'paused',
  'completed',
  'cancelled',
  'failed',
  'interrupted',
] as const;

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
  state: WorkerBatchState;
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
  images: WorkerImageRecord[];
  progress: WorkerProgress;
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
    batchId: string(item.batch_id, 'active_batch.batch_id'),
    owner: owner(item.owner),
    state: enumeration(item.state, BATCH_STATES, 'active_batch.state'),
    progress: progress(item.progress),
    pauseRequested: boolean(item.pause_requested, 'active_batch.pause_requested'),
    cancelRequested: boolean(item.cancel_requested, 'active_batch.cancel_requested'),
  };
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

function image(value: unknown, expectedIndex: number): WorkerImageRecord {
  const item = record(value, `images[${expectedIndex - 1}]`);
  // Attempts-in-cycle/history and preview details are intentionally removed by
  // the native response projector because the desktop never consumes them.
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
  return {
    index,
    prompt: string(item.prompt, 'image.prompt'),
    seed: integer(item.seed, 'image.seed'),
    status: enumeration(item.status, IMAGE_STATES, 'image.status'),
    attempts: integer(item.attempts, 'image.attempts'),
    retryRounds: integer(item.retry_rounds, 'image.retry_rounds'),
    filename,
    sha256: nullable(item.sha256, (candidate) => checksum(candidate, 'image.sha256')),
    sizeBytes: nullable(item.size_bytes, (candidate) => integer(candidate, 'image.size_bytes', 1)),
    generationMs: nullable(item.generation_ms, (candidate) => finite(candidate, 'image.generation_ms')),
    error: safeError(item.error),
    receipt: receipt(item.receipt),
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
  if ((activeBatch === null) !== parsed.permissions.canCreate) {
    throw new Error('worker status permissions are inconsistent with its active batch.');
  }
  if (parsed.permissions.isOwner && activeBatch === null) {
    throw new Error('worker status cannot name an owner without an active batch.');
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
      'images',
      'progress',
    ],
    'worker manifest',
  );
  if (item.schema_version !== 1) throw new Error('worker manifest schema version is unsupported.');
  if (!Array.isArray(item.images) || item.images.length < 1 || item.images.length > 500) {
    throw new Error('worker manifest image count is invalid.');
  }
  const images = item.images.map((candidate, index) => image(candidate, index + 1));
  const parsedProgress = progress(item.progress);
  if (parsedProgress.total !== images.length) throw new Error('worker manifest total does not match its images.');
  return {
    schemaVersion: 1,
    batchId: string(item.batch_id, 'batch_id'),
    owner: owner(item.owner),
    state: enumeration(item.state, BATCH_STATES, 'state'),
    createdAt: string(item.created_at, 'created_at'),
    updatedAt: string(item.updated_at, 'updated_at'),
    completedAt: nullable(item.completed_at, (candidate) => string(candidate, 'completed_at')),
    interruptedAt: nullable(item.interrupted_at, (candidate) => string(candidate, 'interrupted_at')),
    pauseRequested: boolean(item.pause_requested, 'pause_requested'),
    cancelRequested: boolean(item.cancel_requested, 'cancel_requested'),
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
