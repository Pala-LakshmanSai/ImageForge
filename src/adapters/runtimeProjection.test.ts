import { describe, expect, it } from 'vitest';
import type { RunPodSnapshot } from '@imageforge/runpod-client';
import { createInitialState } from '../domain/reducer';
import { parseWorkerManifest, parseWorkerStatus } from './workerContracts';
import { projectBusyBatch, projectOwnedManifest, projectPodSnapshot } from './runtimeProjection';

const batchId = '11111111-1111-4111-8111-111111111111';

function workerManifest() {
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
    images: [{
      index: 1,
      prompt: 'A handpicked documentary still',
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
    }],
    progress: { total: 1, completed: 1, downloaded: 1, failed: 0, cancelled: 0, processed: 1, current_index: null },
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
          interruptible: false, hourlyPriceUsd: 0.52, createdAt: '2026-08-01T10:00:00.000Z', startRequestId: 'one', proxyUrl: 'https://podone1-8000.proxy.runpod.net/',
          lifecyclePhase: 'ready', workerHealth: { schemaVersion: 1, phase: 'ready', phaseProgress: 1 }, healthError: null,
        },
        {
          id: 'podtwo2', name: 'imageforge-two', status: 'provisioning', gpuId: 'gpu-5090', gpuDisplayName: 'RTX 5090', gpuCount: 1,
          cloud: 'secure', dataCenterId: 'EU-RO-1', templateId: 'template', networkVolumeId: 'volume', networkVolumeMountPath: '/workspace',
          interruptible: false, hourlyPriceUsd: 0.8, createdAt: '2026-08-01T10:00:01.000Z', startRequestId: 'two', proxyUrl: 'https://podtwo2-8000.proxy.runpod.net/',
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

  it('uses only verified local receipts to publish library assets', () => {
    const manifest = workerManifest();
    const none = projectOwnedManifest(manifest, [], {
      name: 'History Brief', destination: '/safe/folder', estimatedSecondsPerImage: 8.4, hourlyRate: 0.5,
    }, Date.parse('2026-08-02T10:01:00.000Z'));
    expect(none.assets).toEqual([]);
    expect(none.batch.prompts[0].status).toBe('ready');

    const verified = projectOwnedManifest(manifest, [{
      schemaVersion: 1, batchId, index: 1, filename: `batches/${batchId}/000001.jpg`, sha256: 'a'.repeat(64), sizeBytes: 2_048, verifiedAtUnixMs: 1,
    }], {
      name: 'History Brief', destination: '/safe/folder', estimatedSecondsPerImage: 8.4, hourlyRate: 0.5,
    }, Date.parse('2026-08-02T10:01:00.000Z'));
    expect(verified.assets).toHaveLength(1);
    expect(verified.batch.estimatedCost).toBeCloseTo(0.5 / 60);
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
      permissions: { can_create: false, can_manage_active: false, is_owner: false },
    });
    const projected = projectBusyBatch(status.activeBatch!);
    expect(projected.prompts).toEqual([]);
    expect(projected.destination).toBe('Owner’s selected computer');
    expect(projected.reportedProgress).toMatchObject({ total: 400, completed: 17 });
  });
});
