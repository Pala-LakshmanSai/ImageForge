import { describe, expect, it, vi } from 'vitest';
import {
  WorkerBatchCoordinator,
  WorkerBatchError,
  type LocalDownloadReceipt,
  type WorkerBatchPort,
  type WorkerHttpResult,
} from './workerBatchCoordinator';

const batchId = '11111111-1111-4111-8111-111111111111';
const owner = { user_id: 'lakshman', display_name: 'Lakshman' };

function manifest(
  status: 'ready' | 'downloaded' | 'generating' = 'ready',
  settings: { width: number; height: number } = { width: 1280, height: 720 },
) {
  const downloaded = status === 'downloaded';
  return {
    schema_version: 1,
    batch_id: batchId,
    owner,
    state: downloaded ? 'completed' : 'running',
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T10:01:00.000Z',
    completed_at: downloaded ? '2026-08-01T10:01:00.000Z' : null,
    interrupted_at: null,
    pause_requested: false,
    cancel_requested: false,
    settings,
    images: [{
      index: 1,
      prompt: 'A documentary shipyard at dawn',
      seed: 700,
      status,
      attempts: 1,
      retry_rounds: 0,
      filename: status === 'generating' ? null : 'artifacts/000001.jpg',
      sha256: status === 'generating' ? null : 'a'.repeat(64),
      size_bytes: status === 'generating' ? null : 2_048,
      generation_ms: status === 'generating' ? null : 8_100,
      error: null,
      receipt: downloaded
        ? { sha256: 'a'.repeat(64), size_bytes: 2_048, acknowledged_at: '2026-08-01T10:01:00.000Z' }
        : null,
    }],
    progress: {
      total: 1,
      completed: status === 'generating' ? 0 : 1,
      downloaded: downloaded ? 1 : 0,
      failed: 0,
      cancelled: 0,
      processed: status === 'generating' ? 0 : 1,
      current_index: status === 'generating' ? 1 : null,
    },
  };
}

function status(isOwner = true) {
  return {
    schema_version: 1,
    ready: true,
    active_batch: {
      batch_id: batchId,
      owner,
      state: 'running',
      progress: manifest('generating').progress,
      pause_requested: false,
      cancel_requested: false,
    },
    permissions: { can_create: false, can_manage_active: isOwner, is_owner: isOwner },
  };
}

function receipt(): LocalDownloadReceipt {
  return {
    schemaVersion: 1,
    batchId,
    index: 1,
    filename: `batches/${batchId}/000001.jpg`,
    sha256: 'a'.repeat(64),
    sizeBytes: 2_048,
    verifiedAtUnixMs: 1_785_579_600_000,
  };
}

function fakePort(overrides: Partial<WorkerBatchPort> = {}): WorkerBatchPort {
  return {
    status: vi.fn(async () => ({ status: 200, body: status() })),
    createBatch: vi.fn(async () => ({ status: 201, body: manifest('ready') })),
    getBatch: vi.fn(async () => ({ status: 200, body: manifest('downloaded') })),
    pauseBatch: vi.fn(async () => ({ status: 200, body: manifest('generating') })),
    resumeBatch: vi.fn(async () => ({ status: 200, body: manifest('generating') })),
    cancelBatch: vi.fn(async () => ({ status: 200, body: manifest('downloaded') })),
    retryFailed: vi.fn(async () => ({ status: 200, body: manifest('generating') })),
    readReceipts: vi.fn(async () => []),
    downloadArtifact: vi.fn(async () => receipt()),
    ...overrides,
  };
}

describe('WorkerBatchCoordinator', () => {
  it('creates immediately, downloads a ready JPEG, then refetches the acknowledged manifest', async () => {
    const port = fakePort();
    const coordinator = new WorkerBatchCoordinator(port);
    const event = await coordinator.create(['A documentary shipyard at dawn'], 700);

    expect(event.type).toBe('manifest');
    expect(port.createBatch).toHaveBeenCalledOnce();
    expect(port.downloadArtifact).toHaveBeenCalledWith({
      batchId,
      index: 1,
      expectedSha256: 'a'.repeat(64),
      expectedSizeBytes: 2_048,
      expectedWidth: 1280,
      expectedHeight: 720,
    });
    expect(port.getBatch).toHaveBeenCalledOnce();
  });

  it('forwards the worker manifest dimensions to native download verification', async () => {
    const port = fakePort({
      createBatch: vi.fn(async () => ({ status: 201, body: manifest('ready', { width: 720, height: 1280 }) })),
    });
    await new WorkerBatchCoordinator(port).create(['A portrait frame'], 700);

    expect(port.downloadArtifact).toHaveBeenCalledWith(expect.objectContaining({
      expectedWidth: 720,
      expectedHeight: 1280,
    }));
  });

  it('forwards batch-level image references without mutating their bytes', async () => {
    const port = fakePort();
    const references = [{
      id: 'reference-1',
      name: 'anchor.png',
      mimeType: 'image/png' as const,
      sizeBytes: 4,
      bytes: [0x89, 0x50, 0x4e, 0x47],
    }];
    await new WorkerBatchCoordinator(port).create(['A documentary shipyard at dawn'], 700, references);
    expect(port.createBatch).toHaveBeenCalledWith(
      ['A documentary shipyard at dawn'],
      700,
      [{ name: 'anchor.png', mimeType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] }],
      '16:9',
    );
  });

  it('rejects malformed or oversized image references before transport', async () => {
    const port = fakePort();
    await expect(new WorkerBatchCoordinator(port).create(['A documentary shipyard at dawn'], 700, [{
      id: 'reference-1', name: 'bad.gif', mimeType: 'image/gif' as never, sizeBytes: 3, bytes: [1, 2, 3],
    }])).rejects.toMatchObject({ code: 'batch_reference_invalid' });
    expect(port.createBatch).not.toHaveBeenCalled();
  });

  it('turns 423 into the authoritative foreign-owner lock and never queues or fetches prompts', async () => {
    const port = fakePort({
      createBatch: vi.fn(async (): Promise<WorkerHttpResult> => ({
        status: 423,
        body: { error: { code: 'batch_busy', message: 'Lakshman is generating.', details: null } },
      })),
      status: vi.fn(async () => ({ status: 200, body: status(false) })),
    });
    const coordinator = new WorkerBatchCoordinator(port);
    const event = await coordinator.create(['Another brief'], 900);

    expect(event.type).toBe('busy');
    if (event.type === 'busy') expect(event.summary.owner.displayName).toBe('Lakshman');
    expect(port.createBatch).toHaveBeenCalledOnce();
    expect(port.getBatch).not.toHaveBeenCalled();
    expect(port.downloadArtifact).not.toHaveBeenCalled();
  });

  it('reconciles a matching local receipt without downloading again', async () => {
    const port = fakePort({
      createBatch: vi.fn(async () => ({ status: 201, body: manifest('downloaded') })),
      getBatch: vi.fn(async () => ({ status: 200, body: manifest('downloaded') })),
      readReceipts: vi.fn(async () => [receipt()]),
    });
    const coordinator = new WorkerBatchCoordinator(port);
    const event = await coordinator.create(['A documentary shipyard at dawn'], 700);

    expect(event.type).toBe('manifest');
    expect(port.downloadArtifact).not.toHaveBeenCalled();
    expect(port.getBatch).not.toHaveBeenCalled();
  });

  it('re-acknowledges a durable local receipt when the worker still reports ready', async () => {
    let localReceipts: LocalDownloadReceipt[] = [];
    const downloadArtifact = vi.fn(async () => {
      localReceipts = [receipt()];
      throw new WorkerBatchError(
        'receipt_acknowledgement_failed',
        'The worker did not confirm the receipt.',
        503,
      );
    });
    const firstPort = fakePort({
      readReceipts: vi.fn(async () => localReceipts),
      downloadArtifact,
    });
    const firstCoordinator = new WorkerBatchCoordinator(firstPort);
    await expect(firstCoordinator.create(['A documentary shipyard at dawn'], 700)).rejects.toMatchObject({
      code: 'receipt_acknowledgement_failed',
    });

    const secondDownload = vi.fn(async () => receipt());
    let manifestReads = 0;
    const secondPort = fakePort({
      createBatch: vi.fn(async () => ({ status: 201, body: manifest('ready') })),
      getBatch: vi.fn(async () => ({
        status: 200,
        body: manifest(manifestReads++ === 0 ? 'ready' : 'downloaded'),
      })),
      readReceipts: vi.fn(async () => localReceipts),
      downloadArtifact: secondDownload,
    });
    const restarted = new WorkerBatchCoordinator(secondPort, batchId);
    const event = await restarted.poll();

    expect(event.type).toBe('manifest');
    expect(secondDownload).toHaveBeenCalledOnce();
    expect(secondDownload).toHaveBeenCalledWith({
      batchId,
      index: 1,
      expectedSha256: 'a'.repeat(64),
      expectedSizeBytes: 2_048,
      expectedWidth: 1280,
      expectedHeight: 720,
    });
    expect(secondPort.getBatch).toHaveBeenCalledTimes(2);
  });

  it('verifies the local ledger once per connected session, then reuses cached receipts', async () => {
    const port = fakePort();
    const coordinator = new WorkerBatchCoordinator(port);
    await coordinator.create(['A documentary shipyard at dawn'], 700);
    await coordinator.poll();
    await coordinator.poll();
    expect(port.readReceipts).toHaveBeenCalledOnce();
    coordinator.invalidateReceipts();
    await coordinator.poll();
    expect(port.readReceipts).toHaveBeenCalledTimes(2);
  });

  it('coalesces overlapping status polls', async () => {
    let resolve!: (result: WorkerHttpResult) => void;
    const statusPromise = new Promise<WorkerHttpResult>((done) => { resolve = done; });
    const port = fakePort({ status: vi.fn(() => statusPromise) });
    const coordinator = new WorkerBatchCoordinator(port);
    const first = coordinator.poll();
    const second = coordinator.poll();
    expect(first).toBe(second);
    resolve({ status: 200, body: status(false) });
    await expect(first).resolves.toMatchObject({ type: 'busy' });
    expect(port.status).toHaveBeenCalledOnce();
  });

  it('reconciles a terminal manifest after the worker releases its active lease', async () => {
    const port = fakePort({
      createBatch: vi.fn(async () => ({ status: 201, body: manifest('generating') })),
      status: vi.fn(async () => ({
        status: 200,
        body: { ...status(), active_batch: null, permissions: { can_create: true, can_manage_active: false, is_owner: false } },
      })),
      getBatch: vi.fn(async () => ({ status: 200, body: manifest('downloaded') })),
      readReceipts: vi.fn(async () => []),
    });
    const coordinator = new WorkerBatchCoordinator(port);
    await coordinator.create(['A documentary shipyard at dawn'], 700);
    vi.mocked(port.downloadArtifact).mockClear();
    const event = await coordinator.poll();

    expect(event.type).toBe('manifest');
    expect(port.getBatch).toHaveBeenCalled();
    expect(port.downloadArtifact).toHaveBeenCalledWith({
      batchId,
      index: 1,
      expectedSha256: 'a'.repeat(64),
      expectedSizeBytes: 2_048,
      expectedWidth: 1280,
      expectedHeight: 720,
    });
  });

  it('reconnects a persisted owned batch ID after renderer restart', async () => {
    const port = fakePort({
      status: vi.fn(async () => ({
        status: 200,
        body: { ...status(), active_batch: null, permissions: { can_create: true, can_manage_active: false, is_owner: false } },
      })),
      readReceipts: vi.fn(async () => [receipt()]),
    });
    const restarted = new WorkerBatchCoordinator(port, batchId);
    const event = await restarted.poll();
    expect(event.type).toBe('manifest');
    expect(port.getBatch).toHaveBeenCalledWith(batchId);
    expect(port.downloadArtifact).not.toHaveBeenCalled();
  });

  it('does not fetch a foreign owner manifest after that owner releases the lock', async () => {
    let active = true;
    const port = fakePort({
      status: vi.fn(async () => ({
        status: 200,
        body: active
          ? status(false)
          : { schema_version: 1, ready: true, active_batch: null, permissions: { can_create: true, can_manage_active: false, is_owner: false } },
      })),
      getBatch: vi.fn(async () => ({ status: 200, body: manifest('downloaded') })),
    });
    const observer = new WorkerBatchCoordinator(port);
    await expect(observer.poll()).resolves.toMatchObject({ type: 'busy' });
    active = false;
    await expect(observer.poll()).resolves.toMatchObject({ type: 'idle' });
    expect(port.getBatch).not.toHaveBeenCalled();
  });

  it('preserves retryable native transport errors for reconnect polling', async () => {
    const nativeError = Object.assign(new Error('worker session temporarily unavailable'), {
      code: 'worker_session_unavailable',
      retryable: true,
    });
    const port = fakePort({ status: vi.fn(async () => { throw nativeError; }) });
    const coordinator = new WorkerBatchCoordinator(port);
    const events: unknown[] = [];
    coordinator.subscribe((event) => events.push(event));
    await expect(coordinator.poll()).rejects.toMatchObject({ code: 'worker_session_unavailable', retryable: true });
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'worker_session_unavailable', retryable: true })]);
  });

  it('fails closed on conflicting receipts and malformed errors', async () => {
    const conflict = { ...receipt(), sha256: 'b'.repeat(64) };
    const port = fakePort({ readReceipts: vi.fn(async () => [conflict]) });
    const coordinator = new WorkerBatchCoordinator(port);
    await expect(coordinator.create(['A documentary shipyard at dawn'], 700)).rejects.toMatchObject({
      code: 'local_receipt_conflict',
    });

    const malformed = new WorkerBatchCoordinator(fakePort({
      createBatch: vi.fn(async () => ({ status: 500, body: { traceback: 'unsafe' } })),
    }));
    await expect(malformed.create(['A documentary shipyard at dawn'], 700)).rejects.toEqual(
      expect.objectContaining<Partial<WorkerBatchError>>({ code: 'worker_response_invalid' }),
    );
  });
});
