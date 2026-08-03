import { describe, expect, it, vi } from 'vitest';
import {
  WorkerBatchCoordinator,
  WorkerBatchError,
  type WorkerBatchEvent,
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

type TerminalFixtureStatus = 'pending' | 'ready' | 'downloaded';

function terminalSha256(index: number): string {
  return index.toString(16).padStart(64, '0');
}

function terminalSizeBytes(index: number): number {
  return 2_048 + index;
}

function terminalReceipt(index: number): LocalDownloadReceipt {
  return {
    schemaVersion: 1,
    batchId,
    index,
    filename: `batches/${batchId}/${String(index).padStart(6, '0')}.jpg`,
    sha256: terminalSha256(index),
    sizeBytes: terminalSizeBytes(index),
    verifiedAtUnixMs: 1_785_579_600_000 + index,
  };
}

function terminalManifest(statuses: readonly TerminalFixtureStatus[]) {
  const images = statuses.map((imageStatus, offset) => {
    const index = offset + 1;
    const generated = imageStatus !== 'pending';
    const downloaded = imageStatus === 'downloaded';
    return {
      index,
      prompt: `Ordered frame ${index}`,
      seed: 699 + index,
      status: imageStatus,
      attempts: generated ? 1 : 0,
      retry_rounds: 0,
      filename: generated ? `artifacts/${String(index).padStart(6, '0')}.jpg` : null,
      sha256: generated ? terminalSha256(index) : null,
      size_bytes: generated ? terminalSizeBytes(index) : null,
      generation_ms: generated ? 8_000 + index : null,
      error: null,
      receipt: downloaded
        ? {
            sha256: terminalSha256(index),
            size_bytes: terminalSizeBytes(index),
            acknowledged_at: '2026-08-01T10:01:00.000Z',
          }
        : null,
    };
  });
  const completed = statuses.filter((imageStatus) => imageStatus !== 'pending').length;
  const downloaded = statuses.filter((imageStatus) => imageStatus === 'downloaded').length;
  return {
    ...manifest('downloaded'),
    images,
    progress: {
      total: statuses.length,
      completed,
      downloaded,
      failed: 0,
      cancelled: 0,
      processed: completed,
      current_index: null,
    },
  };
}

function releasedStatus() {
  return {
    schema_version: 1,
    ready: true,
    active_batch: null,
    permissions: { can_create: true, can_manage_active: false, is_owner: false },
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('WorkerBatchCoordinator', () => {
  it('creates immediately, downloads a ready JPEG, then refetches the acknowledged manifest', async () => {
    const port = fakePort();
    const coordinator = new WorkerBatchCoordinator(port);
    const event = await coordinator.create(
      ['A documentary shipyard at dawn'],
      700,
      [],
      '16:9',
      'Atlas of Quiet Work',
    );

    expect(event.type).toBe('manifest');
    expect(port.createBatch).toHaveBeenCalledOnce();
    expect(port.downloadArtifact).toHaveBeenCalledWith({
      batchId,
      batchName: 'Atlas of Quiet Work',
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
      batchName: undefined,
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

  it('starts a fresh authoritative poll after forgetting an in-flight poll', async () => {
    const staleStatus = deferred<WorkerHttpResult>();
    const statusCall = vi.fn()
      .mockImplementationOnce(() => staleStatus.promise)
      .mockResolvedValueOnce({ status: 200, body: status(false) });
    const port = fakePort({
      status: statusCall,
      createBatch: vi.fn(async (): Promise<WorkerHttpResult> => ({
        status: 423,
        body: { error: { code: 'batch_busy', message: 'Lakshman is generating.', details: null } },
      })),
    });
    const coordinator = new WorkerBatchCoordinator(port, batchId);

    const stalePoll = coordinator.poll();
    await vi.waitFor(() => expect(statusCall).toHaveBeenCalledOnce());
    coordinator.forgetBatch();
    await expect(coordinator.create(['A second brief'], 900)).resolves.toMatchObject({ type: 'busy' });
    staleStatus.resolve({
      status: 200,
      body: { schema_version: 1, ready: true, active_batch: null, permissions: { can_create: true, can_manage_active: false, is_owner: false } },
    });

    await expect(stalePoll).resolves.toEqual({ type: 'idle' });
    expect(statusCall).toHaveBeenCalledTimes(2);
  });

  it('starts status after a 423 instead of reusing an older same-generation poll', async () => {
    const staleStatus = deferred<WorkerHttpResult>();
    const statusCall = vi.fn()
      .mockImplementationOnce(() => staleStatus.promise)
      .mockResolvedValueOnce({ status: 200, body: status(false) });
    const port = fakePort({
      status: statusCall,
      createBatch: vi.fn(async (): Promise<WorkerHttpResult> => ({
        status: 423,
        body: { error: { code: 'batch_busy', message: 'Lakshman is generating.', details: null } },
      })),
    });
    const coordinator = new WorkerBatchCoordinator(port);

    const earlierPoll = coordinator.poll();
    await vi.waitFor(() => expect(statusCall).toHaveBeenCalledOnce());
    const create = coordinator.create(['A second brief'], 900);
    staleStatus.resolve({
      status: 200,
      body: { schema_version: 1, ready: true, active_batch: null, permissions: { can_create: true, can_manage_active: false, is_owner: false } },
    });

    await expect(earlierPoll).resolves.toEqual({ type: 'idle' });
    await expect(create).resolves.toMatchObject({ type: 'busy' });
    expect(statusCall).toHaveBeenCalledTimes(2);
  });

  it('does not restore a forgotten batch from late create or control responses', async () => {
    const createResult = deferred<WorkerHttpResult>();
    const createPort = fakePort({ createBatch: vi.fn(() => createResult.promise) });
    const creating = new WorkerBatchCoordinator(createPort);
    const createEvents: unknown[] = [];
    creating.subscribe((event) => createEvents.push(event));
    const create = creating.create(['A delayed brief'], 700);
    await vi.waitFor(() => expect(createPort.createBatch).toHaveBeenCalledOnce());
    creating.forgetBatch();
    createResult.resolve({ status: 201, body: manifest('ready') });

    await expect(create).resolves.toEqual({ type: 'idle' });
    expect(creating.batchId).toBeNull();
    expect(createPort.readReceipts).not.toHaveBeenCalled();
    expect(createPort.downloadArtifact).not.toHaveBeenCalled();
    expect(createEvents).toEqual([]);

    const controlResult = deferred<WorkerHttpResult>();
    const controlPort = fakePort({ retryFailed: vi.fn(() => controlResult.promise) });
    const controlling = new WorkerBatchCoordinator(controlPort, batchId);
    const controlEvents: unknown[] = [];
    controlling.subscribe((event) => controlEvents.push(event));
    const control = controlling.control('retry_failed');
    await vi.waitFor(() => expect(controlPort.retryFailed).toHaveBeenCalledOnce());
    controlling.forgetBatch();
    controlResult.resolve({ status: 200, body: manifest('generating') });

    await expect(control).resolves.toEqual({ type: 'idle' });
    expect(controlling.batchId).toBeNull();
    expect(controlPort.readReceipts).not.toHaveBeenCalled();
    expect(controlEvents).toEqual([]);
  });

  it('makes failures from forgotten create, control, and receipt work inert', async () => {
    const createResult = deferred<WorkerHttpResult>();
    const createPort = fakePort({ createBatch: vi.fn(() => createResult.promise) });
    const creating = new WorkerBatchCoordinator(createPort);
    const create = creating.create(['A delayed brief'], 700);
    await vi.waitFor(() => expect(createPort.createBatch).toHaveBeenCalledOnce());
    creating.forgetBatch();
    createResult.reject(new Error('stale create failure'));
    await expect(create).resolves.toEqual({ type: 'idle' });

    const controlResult = deferred<WorkerHttpResult>();
    const controlPort = fakePort({ retryFailed: vi.fn(() => controlResult.promise) });
    const controlling = new WorkerBatchCoordinator(controlPort, batchId);
    const control = controlling.control('retry_failed');
    await vi.waitFor(() => expect(controlPort.retryFailed).toHaveBeenCalledOnce());
    controlling.forgetBatch();
    controlResult.reject(new Error('stale control failure'));
    await expect(control).resolves.toEqual({ type: 'idle' });

    const receiptResult = deferred<LocalDownloadReceipt[]>();
    const receiptPort = fakePort({ readReceipts: vi.fn(() => receiptResult.promise) });
    const synchronizing = new WorkerBatchCoordinator(receiptPort);
    const events: unknown[] = [];
    synchronizing.subscribe((event) => events.push(event));
    const sync = synchronizing.create(['A delayed receipt read'], 700);
    await vi.waitFor(() => expect(receiptPort.readReceipts).toHaveBeenCalledOnce());
    synchronizing.forgetBatch();
    receiptResult.reject(new Error('stale receipt failure'));
    await expect(sync).resolves.toEqual({ type: 'idle' });
    expect(events).toEqual([]);
  });

  it('sends pause before a stalled polling download is released', async () => {
    const stalledDownload = deferred<LocalDownloadReceipt>();
    const pauseBatch = vi.fn(async () => ({ status: 200, body: manifest('generating') }));
    const port = fakePort({
      pauseBatch,
      downloadArtifact: vi.fn(() => stalledDownload.promise),
    });
    const coordinator = new WorkerBatchCoordinator(port, batchId);
    const events: unknown[] = [];
    coordinator.subscribe((event) => events.push(event));

    const stalePoll = coordinator.poll();
    await vi.waitFor(() => expect(port.downloadArtifact).toHaveBeenCalledOnce());
    const pause = coordinator.control('pause');

    await vi.waitFor(() => expect(pauseBatch).toHaveBeenCalledOnce());
    await expect(pause).resolves.toMatchObject({
      type: 'manifest',
      manifest: { images: [{ status: 'generating' }] },
    });
    await vi.waitFor(() => expect(port.getBatch).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(port.downloadArtifact).toHaveBeenCalledOnce();
    const reconciliation = coordinator.poll();

    stalledDownload.resolve(receipt());
    await expect(stalePoll).resolves.toEqual({ type: 'idle' });
    await expect(reconciliation).resolves.toMatchObject({ type: 'manifest' });
    expect(port.downloadArtifact).toHaveBeenCalledOnce();
    expect(events).toHaveLength(5);
    expect(events.map((event) => (
      (event as Extract<WorkerBatchEvent, { type: 'manifest' }>).manifest.images[0].status
    ))).toEqual(['downloaded', 'generating', 'downloaded', 'downloaded', 'downloaded']);
    expect(events.map((event) => (
      (event as Extract<WorkerBatchEvent, { type: 'manifest' }>).receipts.length
    ))).toEqual([0, 0, 0, 1, 1]);
  });

  it('serializes create and owner-poll synchronization without losing newer ready state', async () => {
    const receiptRead = deferred<LocalDownloadReceipt[]>();
    let manifestRead = 0;
    const port = fakePort({
      readReceipts: vi.fn(() => receiptRead.promise),
      getBatch: vi.fn(async () => ({
        status: 200,
        body: manifest(manifestRead++ === 0 ? 'ready' : 'downloaded'),
      })),
    });
    const coordinator = new WorkerBatchCoordinator(port);
    const events: unknown[] = [];
    coordinator.subscribe((event) => events.push(event));

    const create = coordinator.create(['A documentary shipyard at dawn'], 700);
    await vi.waitFor(() => expect(port.readReceipts).toHaveBeenCalledOnce());
    const poll = coordinator.poll();
    receiptRead.resolve([]);

    await expect(Promise.all([create, poll])).resolves.toEqual([
      expect.objectContaining({ type: 'manifest' }),
      expect.objectContaining({ type: 'manifest' }),
    ]);
    expect(port.downloadArtifact).toHaveBeenCalledOnce();
    expect(port.getBatch).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(4);
    expect(events.map((event) => (
      (event as Extract<WorkerBatchEvent, { type: 'manifest' }>).receipts.length
    ))).toEqual([0, 1, 1, 1]);
    expect(events.at(-1)).toMatchObject({
      type: 'manifest',
      manifest: { images: [{ status: 'downloaded' }] },
    });
  });

  it('commits an accepted create before a later idle poll', async () => {
    const createResult = deferred<WorkerHttpResult>();
    const port = fakePort({
      createBatch: vi.fn(() => createResult.promise),
      status: vi.fn(async () => ({
        status: 200,
        body: { schema_version: 1, ready: true, active_batch: null, permissions: { can_create: true, can_manage_active: false, is_owner: false } },
      })),
      getBatch: vi.fn(async () => ({ status: 404, body: { error: { code: 'batch_not_found', message: 'Missing.', details: null } } })),
    });
    const coordinator = new WorkerBatchCoordinator(port);
    const eventTypes: string[] = [];
    coordinator.subscribe((event) => eventTypes.push(event.type));

    const create = coordinator.create(['An accepted brief'], 700);
    await vi.waitFor(() => expect(port.createBatch).toHaveBeenCalledOnce());
    const poll = coordinator.poll();
    createResult.resolve({ status: 201, body: manifest('generating') });

    await expect(create).resolves.toMatchObject({ type: 'manifest' });
    await expect(poll).resolves.toEqual({ type: 'idle' });
    expect(eventTypes).toEqual(['manifest', 'idle']);
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
      batchName: 'Untitled batch',
      index: 1,
      expectedSha256: 'a'.repeat(64),
      expectedSizeBytes: 2_048,
      expectedWidth: 1280,
      expectedHeight: 720,
    });
  });

  it('downloads newly-ready artifacts exposed by terminal refetches before committing completion', async () => {
    const firstTerminal = terminalManifest([
      ...Array.from({ length: 21 }, () => 'downloaded' as const),
      'ready',
      'pending',
      'pending',
    ]);
    const secondTerminal = terminalManifest([
      ...Array.from({ length: 22 }, () => 'downloaded' as const),
      'ready',
      'ready',
    ]);
    const completedTerminal = terminalManifest(
      Array.from({ length: 24 }, () => 'downloaded' as const),
    );
    const getBatch = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: firstTerminal })
      .mockResolvedValueOnce({ status: 200, body: secondTerminal })
      .mockResolvedValue({ status: 200, body: completedTerminal });
    const downloadArtifact = vi.fn(async (
      input: Parameters<WorkerBatchPort['downloadArtifact']>[0],
    ) => terminalReceipt(input.index));
    const port = fakePort({
      status: vi.fn(async () => ({ status: 200, body: releasedStatus() })),
      getBatch,
      readReceipts: vi.fn(async () => (
        Array.from({ length: 21 }, (_, offset) => terminalReceipt(offset + 1))
      )),
      downloadArtifact,
    });
    const coordinator = new WorkerBatchCoordinator(port, batchId);
    coordinator.setBatchName('Atlas of Quiet Work');
    const events: unknown[] = [];
    coordinator.subscribe((event) => events.push(event));

    const event = await coordinator.poll();

    expect(event).toMatchObject({
      type: 'manifest',
      manifest: { state: 'completed', progress: { downloaded: 24, total: 24 } },
    });
    if (event.type === 'manifest') expect(event.receipts).toHaveLength(24);
    expect(downloadArtifact.mock.calls.map(([input]) => input.index)).toEqual([22, 23, 24]);
    expect(downloadArtifact.mock.calls.every(([input]) => input.batchName === 'Atlas of Quiet Work')).toBe(true);
    expect(getBatch).toHaveBeenCalledTimes(3);
    expect(events).toHaveLength(6);
    expect(events.map((candidate) => (
      (candidate as Extract<WorkerBatchEvent, { type: 'manifest' }>).receipts.length
    ))).toEqual([21, 22, 22, 23, 24, 24]);
    expect(events[2]).toMatchObject({
      type: 'manifest',
      manifest: { images: expect.arrayContaining([expect.objectContaining({ index: 23, status: 'ready' })]) },
      receipts: expect.arrayContaining([expect.objectContaining({ index: 22 })]),
    });

    await expect(coordinator.poll()).resolves.toMatchObject({
      type: 'manifest',
      manifest: { progress: { downloaded: 24, total: 24 } },
    });
    expect(downloadArtifact).toHaveBeenCalledTimes(3);
    expect(port.readReceipts).toHaveBeenCalledOnce();
    expect(getBatch).toHaveBeenCalledTimes(4);
  });

  it('emits ready state and each deferred durable receipt in order before terminal completion', async () => {
    const firstDownload = deferred<LocalDownloadReceipt>();
    const secondDownload = deferred<LocalDownloadReceipt>();
    const readyTerminal = terminalManifest(['ready', 'ready']);
    const downloadedTerminal = terminalManifest(['downloaded', 'downloaded']);
    const getBatch = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: readyTerminal })
      .mockResolvedValue({ status: 200, body: downloadedTerminal });
    const downloadArtifact = vi.fn((input: Parameters<WorkerBatchPort['downloadArtifact']>[0]) => (
      input.index === 1 ? firstDownload.promise : secondDownload.promise
    ));
    const port = fakePort({
      status: vi.fn(async () => ({ status: 200, body: releasedStatus() })),
      getBatch,
      downloadArtifact,
    });
    const coordinator = new WorkerBatchCoordinator(port, batchId);
    const events: WorkerBatchEvent[] = [];
    coordinator.subscribe((event) => events.push(event));

    const polling = coordinator.poll();
    await vi.waitFor(() => expect(downloadArtifact).toHaveBeenCalledTimes(1));
    expect(events).toEqual([
      expect.objectContaining({
        type: 'manifest',
        manifest: expect.objectContaining({ images: expect.arrayContaining([expect.objectContaining({ index: 1, status: 'ready' })]) }),
        receipts: [],
      }),
    ]);

    firstDownload.resolve(terminalReceipt(1));
    await vi.waitFor(() => expect(downloadArtifact).toHaveBeenCalledTimes(2));
    expect(events).toEqual([
      expect.objectContaining({ type: 'manifest', receipts: [] }),
      expect.objectContaining({ type: 'manifest', receipts: [expect.objectContaining({ index: 1 })] }),
    ]);

    secondDownload.resolve(terminalReceipt(2));
    await expect(polling).resolves.toMatchObject({
      type: 'manifest',
      manifest: { state: 'completed', progress: { downloaded: 2, total: 2 } },
      receipts: [expect.objectContaining({ index: 1 }), expect.objectContaining({ index: 2 })],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: 'manifest', receipts: [] }),
      expect.objectContaining({ type: 'manifest', receipts: [expect.objectContaining({ index: 1 })] }),
      expect.objectContaining({
        type: 'manifest',
        receipts: [expect.objectContaining({ index: 1 }), expect.objectContaining({ index: 2 })],
      }),
      expect.objectContaining({
        type: 'manifest',
        manifest: expect.objectContaining({ state: 'completed' }),
        receipts: [expect.objectContaining({ index: 1 }), expect.objectContaining({ index: 2 })],
      }),
    ]);
    expect(downloadArtifact.mock.calls.map(([input]) => input.index)).toEqual([1, 2]);
    expect(getBatch).toHaveBeenCalledTimes(2);
  });

  it('publishes every ordered saved count from 1 through 24', async () => {
    const readyTerminal = terminalManifest(
      Array.from({ length: 24 }, () => 'ready' as const),
    );
    const downloadedTerminal = terminalManifest(
      Array.from({ length: 24 }, () => 'downloaded' as const),
    );
    const getBatch = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: readyTerminal })
      .mockResolvedValue({ status: 200, body: downloadedTerminal });
    const downloadArtifact = vi.fn(async (
      input: Parameters<WorkerBatchPort['downloadArtifact']>[0],
    ) => terminalReceipt(input.index));
    const port = fakePort({
      status: vi.fn(async () => ({ status: 200, body: releasedStatus() })),
      getBatch,
      downloadArtifact,
    });
    const coordinator = new WorkerBatchCoordinator(port, batchId);
    const savedCounts: number[] = [];
    coordinator.subscribe((event) => {
      if (event.type !== 'manifest') return;
      const saved = event.receipts.length;
      if (saved > (savedCounts.at(-1) ?? 0)) savedCounts.push(saved);
    });

    await expect(coordinator.poll()).resolves.toMatchObject({
      type: 'manifest',
      manifest: { state: 'completed', progress: { downloaded: 24, total: 24 } },
    });

    expect(savedCounts).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
    expect(downloadArtifact.mock.calls.map(([input]) => input.index)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    expect(getBatch).toHaveBeenCalledTimes(2);
  });

  it('bounds an unreflected terminal acknowledgement and completes on a later retry', async () => {
    const readyTerminal = terminalManifest(['ready']);
    const downloadedTerminal = terminalManifest(['downloaded']);
    const getBatch = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: readyTerminal })
      .mockResolvedValueOnce({ status: 200, body: readyTerminal })
      .mockResolvedValueOnce({ status: 200, body: readyTerminal })
      .mockResolvedValue({ status: 200, body: downloadedTerminal });
    const downloadArtifact = vi.fn(async (
      input: Parameters<WorkerBatchPort['downloadArtifact']>[0],
    ) => terminalReceipt(input.index));
    const port = fakePort({
      status: vi.fn(async () => ({ status: 200, body: releasedStatus() })),
      getBatch,
      downloadArtifact,
    });
    const coordinator = new WorkerBatchCoordinator(port, batchId);
    coordinator.setBatchName('Retryable terminal batch');
    const events: unknown[] = [];
    coordinator.subscribe((event) => events.push(event));

    await expect(coordinator.poll()).rejects.toMatchObject({
      code: 'terminal_reconciliation_pending',
      retryable: true,
    });
    expect(getBatch).toHaveBeenCalledTimes(2);
    expect(downloadArtifact).toHaveBeenCalledOnce();
    expect(events).toEqual([
      expect.objectContaining({ type: 'manifest', receipts: [] }),
      expect.objectContaining({ type: 'manifest', receipts: [expect.objectContaining({ index: 1 })] }),
      expect.objectContaining({
        type: 'error',
        code: 'terminal_reconciliation_pending',
        retryable: true,
      }),
    ]);

    await expect(coordinator.poll()).resolves.toMatchObject({
      type: 'manifest',
      manifest: { state: 'completed', progress: { downloaded: 1, total: 1 } },
    });
    expect(getBatch).toHaveBeenCalledTimes(4);
    expect(downloadArtifact).toHaveBeenCalledTimes(2);
    expect(downloadArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ batchName: 'Retryable terminal batch', index: 1 }),
    );
    expect(events).toHaveLength(5);
    expect(events.at(-1)).toMatchObject({ type: 'manifest' });
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

  it('forgets a completed recovered batch before a new brief so polling cannot replay it', async () => {
    const port = fakePort({
      status: vi.fn(async () => ({
        status: 200,
        body: { schema_version: 1, ready: true, active_batch: null, permissions: { can_create: true, can_manage_active: false, is_owner: false } },
      })),
    });
    const restarted = new WorkerBatchCoordinator(port, batchId);

    restarted.forgetBatch();
    await expect(restarted.poll()).resolves.toEqual({ type: 'idle' });
    expect(port.getBatch).not.toHaveBeenCalled();
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

  it('accepts a safe named-folder receipt and rejects path-shaped receipt names', async () => {
    const namedReceipt = {
      ...receipt(),
      filename: 'batches/Atlas of Quiet Work/000001.jpg',
    };
    const namedPort = fakePort({
      createBatch: vi.fn(async () => ({ status: 201, body: manifest('downloaded') })),
      readReceipts: vi.fn(async () => [namedReceipt]),
    });

    await expect(new WorkerBatchCoordinator(namedPort).create(
      ['A documentary shipyard at dawn'],
      700,
      [],
      '16:9',
      'Atlas of Quiet Work',
    )).resolves.toMatchObject({
      type: 'manifest',
      receipts: [expect.objectContaining({ filename: namedReceipt.filename })],
    });
    expect(namedPort.readReceipts).toHaveBeenCalledWith(batchId, 'Atlas of Quiet Work');
    expect(namedPort.downloadArtifact).not.toHaveBeenCalled();

    const invalidPort = fakePort({
      createBatch: vi.fn(async () => ({ status: 201, body: manifest('downloaded') })),
      readReceipts: vi.fn(async () => [{ ...receipt(), filename: 'batches/../000001.jpg' }]),
    });
    await expect(new WorkerBatchCoordinator(invalidPort).create(
      ['A documentary shipyard at dawn'],
      700,
    )).rejects.toMatchObject({ code: 'local_receipt_invalid' });
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
