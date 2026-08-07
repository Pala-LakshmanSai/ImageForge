import { describe, expect, it } from 'vitest';
import type { RunPodSnapshot } from '@imageforge/runpod-client';
import { createInitialState } from '../domain/reducer';
import { parseWorkerManifest, parseWorkerStatus } from './workerContracts';
import { projectBusyBatch, projectOwnedManifest, projectPodSnapshot } from './runtimeProjection';

const batchId = '11111111-1111-4111-8111-111111111111';

function workerManifest(
  imageStatus: 'ready' | 'downloaded' = 'downloaded',
  state: 'completed' | 'cancelled' = 'completed',
) {
  const acknowledged = imageStatus === 'downloaded';
  return parseWorkerManifest({
    schema_version: 1,
    batch_id: batchId,
    owner: { user_id: 'lakshman', display_name: 'Lakshman' },
    state,
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T10:01:00.000Z',
    completed_at: '2026-08-01T10:01:00.000Z',
    interrupted_at: null,
    pause_requested: false,
    cancel_requested: state === 'cancelled',
    settings: { width: 720, height: 1280 },
    images: [{
      index: 1,
      prompt: 'A handpicked documentary still',
      seed: 700,
      status: imageStatus,
      attempts: 1,
      retry_rounds: 0,
      filename: 'artifacts/000001.jpg',
      sha256: 'a'.repeat(64),
      size_bytes: 2_048,
      generation_ms: 8_000,
      error: null,
      receipt: acknowledged
        ? { sha256: 'a'.repeat(64), size_bytes: 2_048, acknowledged_at: '2026-08-01T10:01:00.000Z' }
        : null,
    }],
    progress: { total: 1, completed: 1, downloaded: acknowledged ? 1 : 0, failed: 0, cancelled: 0, processed: 1, current_index: null },
  });
}

function partialFailureManifest() {
  return parseWorkerManifest({
    schema_version: 1,
    batch_id: batchId,
    owner: { user_id: 'lakshman', display_name: 'Lakshman' },
    state: 'completed',
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T10:01:00.000Z',
    completed_at: '2026-08-01T10:01:00.000Z',
    interrupted_at: null,
    pause_requested: false,
    cancel_requested: false,
    settings: { width: 1280, height: 720 },
    images: [
      {
        index: 1,
        prompt: 'A completed documentary still',
        seed: 700,
        status: 'downloaded',
        attempts: 1,
        retry_rounds: 0,
        filename: 'artifacts/000001.jpg',
        sha256: 'a'.repeat(64),
        size_bytes: 2_048,
        generation_ms: 8_000,
        error: null,
        receipt: { sha256: 'a'.repeat(64), size_bytes: 2_048, acknowledged_at: '2026-08-01T10:01:00.000Z' },
      },
      {
        index: 2,
        prompt: 'A failed documentary still',
        seed: 701,
        status: 'failed',
        attempts: 3,
        retry_rounds: 2,
        filename: null,
        sha256: null,
        size_bytes: null,
        generation_ms: null,
        error: { code: 'generation_failed', message: 'Generation failed safely.' },
        receipt: null,
      },
    ],
    progress: { total: 2, completed: 1, downloaded: 1, failed: 1, cancelled: 0, processed: 2, current_index: null },
  });
}

describe('production runtime projection', () => {
  it('keeps lifecycle errors indeterminate instead of reporting completed progress', () => {
    const base = createInitialState().pod;
    const snapshot: RunPodSnapshot = {
      revision: 2,
      phase: 'error',
      inventory: [],
      rankedCandidates: [],
      pods: [],
      selectedPodId: null,
      proxyUrl: null,
      expectedImageCount: 1,
      refreshedAt: '2026-08-01T10:00:02.000Z',
      warnings: [{ code: 'ambiguous_create_unresolved', message: 'Create result unknown', podIds: [] }],
      error: { code: 'pod_create_ambiguous', message: 'RunPod may have created a Pod, but the result could not be confirmed.', retryable: false },
    };
    const projected = projectPodSnapshot(snapshot, base);
    expect(projected.phase).toBe('error');
    expect(projected.phaseProgress).toBe(0);
    expect(projected.statusDetail).toContain('result could not be confirmed');
  });

  it('projects exact live Pod identity, duplicate warning inputs, and price', () => {
    const base = createInitialState().pod;
    const snapshot: RunPodSnapshot = {
      revision: 1,
      phase: 'ready',
      inventory: [],
      rankedCandidates: [],
      pods: [
        {
          id: 'podone1', name: 'imageforge-one', status: 'running', gpuId: 'gpu-4090', gpuDisplayName: 'RTX 4090', gpuCount: 1,
          cloud: 'secure', dataCenterId: 'EU-RO-1', templateId: 'template', networkVolumeId: 'volume', networkVolumeMountPath: '/workspace',
          interruptible: false, hourlyPriceMicroUsd: 520_000, createdAt: '2026-08-01T10:00:00.000Z', startRequestId: 'one', proxyUrl: 'https://podone1-8000.proxy.runpod.net/',
          lifecyclePhase: 'ready', workerHealth: { schemaVersion: 1, phase: 'ready', phaseProgress: 1 }, healthError: null,
        },
        {
          id: 'podtwo2', name: 'imageforge-two', status: 'provisioning', gpuId: 'gpu-5090', gpuDisplayName: 'RTX 5090', gpuCount: 1,
          cloud: 'secure', dataCenterId: 'EU-RO-1', templateId: 'template', networkVolumeId: 'volume', networkVolumeMountPath: '/workspace',
          interruptible: false, hourlyPriceMicroUsd: 800_000, createdAt: '2026-08-01T10:00:01.000Z', startRequestId: 'two', proxyUrl: 'https://podtwo2-8000.proxy.runpod.net/',
          lifecyclePhase: 'provisioning', workerHealth: null, healthError: null,
        },
      ],
      selectedPodId: 'podone1',
      proxyUrl: 'https://podone1-8000.proxy.runpod.net/',
      expectedImageCount: 450,
      refreshedAt: '2026-08-01T10:00:02.000Z',
      warnings: [{ code: 'duplicate_pods', message: 'two Pods', podIds: ['podone1', 'podtwo2'] }],
      error: null,
    };
    const projected = projectPodSnapshot(snapshot, base);
    expect(projected).toMatchObject({ phase: 'ready', gpu: 'RTX 4090', hourlyRate: 0.52, podId: 'podone1' });
    expect(projected.matchingPodIds).toEqual(['podone1', 'podtwo2']);
  });

  it('requires both a verified local receipt and worker acknowledgement before completion', () => {
    const manifest = workerManifest('ready');
    const none = projectOwnedManifest(manifest, [], {
      name: 'History Brief', destination: '/safe/folder', estimatedSecondsPerImage: 8.4, hourlyRate: 0.5,
    }, Date.parse('2026-08-02T10:01:00.000Z'));
    expect(none.assets).toEqual([]);
    expect(none.batch.phase).toBe('running');
    expect(none.batch.prompts[0].status).toBe('ready');
    expect(none.batch.statusMessage).toBe('Saving completed images · 0 of 1 verified locally');
    expect(none.batch.aspectRatio).toBe('9:16');

    const localReceipt = {
      schemaVersion: 1, batchId, index: 1, filename: `batches/${batchId}/000001.jpg`, sha256: 'a'.repeat(64), sizeBytes: 2_048, verifiedAtUnixMs: 1,
    } as const;
    const awaitingAcknowledgement = projectOwnedManifest(manifest, [localReceipt], {
      name: 'History Brief', destination: '/safe/folder', estimatedSecondsPerImage: 8.4, hourlyRate: 0.5,
    }, Date.parse('2026-08-02T10:01:00.000Z'));
    expect(awaitingAcknowledgement.assets).toHaveLength(1);
    expect(awaitingAcknowledgement.batch.phase).toBe('running');
    expect(awaitingAcknowledgement.batch.statusMessage).toBe('Saving completed images · 1 of 1 verified locally');

    const verified = projectOwnedManifest(workerManifest('downloaded'), [localReceipt], {
      name: 'History Brief', destination: '/safe/folder', estimatedSecondsPerImage: 8.4, hourlyRate: 0.5,
    }, Date.parse('2026-08-02T10:01:00.000Z'));
    expect(verified.assets).toHaveLength(1);
    expect(verified.batch.phase).toBe('complete');
    expect(verified.batch.prompts.filter((prompt) => prompt.status === 'downloaded')).toHaveLength(1);
    expect(verified.batch.estimatedCost).toBeCloseTo(0.5 / 60);
  });

  it('settles a terminal batch once local saving has stalled', () => {
    // "Not written yet" and "gone for good" look identical in one snapshot, so
    // the difference has to be time. While saving is alive, receipts keep
    // appearing. When nothing has landed for the stall window against a
    // terminal manifest, waiting cannot help: the worker has acknowledged the
    // download and is free to have deleted its own copy.
    //
    // Holding forever is what trapped a completed batch as permanently
    // running: Cancel was refused as already completed, Stop was refused for
    // an active batch, and no new batch could start.
    const manifest = workerManifest('downloaded');
    const context = {
      name: 'History Brief', destination: '/safe/folder', estimatedSecondsPerImage: 8.4, hourlyRate: 0.5,
    };

    const stillSaving = projectOwnedManifest(
      manifest, [], context, Date.parse('2026-08-01T10:01:30.000Z'),
    );
    expect(stillSaving.batch.phase).toBe('running');

    const stalled = projectOwnedManifest(
      manifest, [], context, Date.parse('2026-08-01T10:05:00.000Z'),
    );
    expect(stalled.batch.phase).toBe('complete');
    // The artifact is missing, not silently invented: it never becomes an asset.
    expect(stalled.assets).toEqual([]);
  });

  it('delays partial failure until every successful artifact has a matching local receipt', () => {
    const manifest = partialFailureManifest();
    const context = {
      name: 'Mixed result brief', destination: '/safe/folder', estimatedSecondsPerImage: 8.4, hourlyRate: 0.5,
    };

    // Saving is only truthful while it can still finish, so this asserts the
    // window shortly after the worker's last update rather than the wall clock.
    const saving = projectOwnedManifest(manifest, [], context, Date.parse('2026-08-01T10:01:30.000Z'));
    expect(saving.batch.phase).toBe('running');
    expect(saving.batch.statusMessage).toBe('Saving completed images · 0 of 1 verified locally');
    expect(saving.batch.prompts.map((prompt) => prompt.status)).toEqual(['ready', 'failed']);
    expect(saving.assets).toEqual([]);

    const settled = projectOwnedManifest(manifest, [{
      schemaVersion: 1,
      batchId,
      index: 1,
      filename: `batches/${batchId}/000001.jpg`,
      sha256: 'a'.repeat(64),
      sizeBytes: 2_048,
      verifiedAtUnixMs: 1,
    }], context);
    expect(settled.batch.phase).toBe('partial_failure');
    expect(settled.batch.prompts.map((prompt) => prompt.status)).toEqual(['downloaded', 'failed']);
    expect(settled.assets).toHaveLength(1);
  });

  it('keeps a cancelled batch in saving state until ready artifacts are locally verified and acknowledged', () => {
    const context = {
      name: 'Cancelled brief', destination: '/safe/folder', estimatedSecondsPerImage: 8.4, hourlyRate: 0.5,
    };
    const receipt = {
      schemaVersion: 1 as const,
      batchId,
      index: 1,
      filename: `batches/${batchId}/000001.jpg`,
      sha256: 'a'.repeat(64),
      sizeBytes: 2_048,
      verifiedAtUnixMs: 1,
    };

    const saving = projectOwnedManifest(workerManifest('ready', 'cancelled'), [], context);
    expect(saving.batch.phase).toBe('running');
    expect(saving.batch.statusMessage).toBe('Saving completed images · 0 of 1 verified locally');

    const awaitingAcknowledgement = projectOwnedManifest(
      workerManifest('ready', 'cancelled'),
      [receipt],
      context,
    );
    expect(awaitingAcknowledgement.batch.phase).toBe('running');

    const settled = projectOwnedManifest(workerManifest('downloaded', 'cancelled'), [receipt], context);
    expect(settled.batch.phase).toBe('cancelled');
    expect(settled.assets).toHaveLength(1);
  });

  it('projects a foreign batch as progress-only with no prompts or destination disclosure', () => {
    const status = parseWorkerStatus({
      schema_version: 1,
      ready: true,
      active_batch: {
        batch_id: batchId,
        owner: { user_id: 'sujal', display_name: 'Sujal' },
        state: 'running',
        progress: { total: 400, completed: 17, downloaded: 17, failed: 0, cancelled: 0, processed: 17, current_index: 18 },
        pause_requested: false,
        cancel_requested: false,
      },
      permissions: { can_create: false, can_manage_active: false, is_owner: false, create_block_reason: null },
    });
    const projected = projectBusyBatch(status.activeBatch!);
    expect(projected.prompts).toEqual([]);
    expect(projected.destination).toBe('Owner’s selected computer');
    expect(projected.reportedProgress).toMatchObject({ total: 400, completed: 17 });
    expect(projected).toMatchObject({
      phase: 'locked',
      remoteState: 'running',
      statusMessage: 'Sujal is generating 17 of 400',
    });

    const paused = projectBusyBatch({ ...status.activeBatch!, state: 'paused' });
    expect(paused).toMatchObject({
      phase: 'locked',
      remoteState: 'paused',
      statusMessage: 'Sujal paused after 17 of 400',
    });
    expect(paused.lockMessage).toContain('Paused after 17');

    const interrupted = projectBusyBatch({ ...status.activeBatch!, state: 'interrupted' });
    expect(interrupted).toMatchObject({
      phase: 'locked',
      remoteState: 'interrupted',
      statusMessage: 'Sujal has a resumable interrupted batch',
    });
    expect(interrupted.lockMessage).toContain('owner can resume');
  });
});
