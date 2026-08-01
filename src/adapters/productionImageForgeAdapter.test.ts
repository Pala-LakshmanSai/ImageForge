import { describe, expect, it, vi } from 'vitest';
import { createConfiguredInitialState } from '../domain/reducer';
import type { CredentialMetadataMap } from '../domain/types';
import { DEFAULT_STUDIO_PROFILE } from './imageForgeAdapter';
import {
  createProductionImageForgeAdapter,
  type ProductionDesktopPort,
  type ProductionRuntimeEvent,
} from './productionImageForgeAdapter';

const batchId = '11111111-1111-4111-8111-111111111111';

function manifest() {
  return {
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
      prompt: 'A documentary shipyard at dawn',
      seed: 700,
      status: 'downloaded',
      attempts: 1,
      retry_rounds: 0,
      filename: 'artifacts/000001.jpg',
      sha256: 'a'.repeat(64),
      size_bytes: 2_048,
      generation_ms: 8_100,
      error: null,
      receipt: { sha256: 'a'.repeat(64), size_bytes: 2_048, acknowledged_at: '2026-08-01T10:01:00.000Z' },
    }],
    progress: { total: 1, completed: 1, downloaded: 1, failed: 0, cancelled: 0, processed: 1, current_index: null },
  };
}

function credentials(): CredentialMetadataMap {
  return {
    runpodApiKey: { configured: true, suffix: 'K7P9', provider: 'macOS Keychain' },
    workerToken: { configured: true, suffix: 'F2M4', provider: 'macOS Keychain' },
  };
}

function port(overrides: Partial<ProductionDesktopPort> = {}): ProductionDesktopPort {
  const unusedFetch = vi.fn(async () => { throw new Error('unused'); }) as unknown as typeof fetch;
  return {
    runPodFetch: unusedFetch,
    workerHealthFetch: unusedFetch,
    bindProfile: vi.fn(async () => undefined),
    authorizeStart: vi.fn(async () => undefined),
    clearStartAuthorization: vi.fn(async () => undefined),
    createMarkerMetadata: vi.fn(async () => ({ pending: false, attemptId: null, podName: null, gpuId: null, podId: null })),
    resolveCreateMarker: vi.fn(async () => undefined),
    reconcileReceipts: vi.fn(async () => ({ schemaVersion: 1, batchId, receipts: [] })),
    revealDestination: vi.fn(async () => undefined),
    fetchPreview: vi.fn(async () => ({ contentType: 'image/webp' as const, sha256: 'a'.repeat(64), sizeBytes: 12, bytes: [] })),
    writeManifest: vi.fn(async (batchId) => `${batchId}/manifest.csv`),
    clearWorkerSession: vi.fn(async () => undefined),
    chooseDestination: vi.fn(async (path) => ({ path, writable: true })),
    validateDestination: vi.fn(async (path) => ({ path, writable: true })),
    credentialMetadata: vi.fn(async () => credentials()),
    replaceCredential: vi.fn(async (_kind, value) => ({ configured: true, suffix: value.slice(-4), provider: 'macOS Keychain' })),
    status: vi.fn(async () => ({ status: 200, body: { schema_version: 1, ready: true, active_batch: null, permissions: { can_create: true, can_manage_active: false, is_owner: false } } })),
    createBatch: vi.fn(async () => ({ status: 201, body: manifest() })),
    getBatch: vi.fn(async () => ({ status: 200, body: manifest() })),
    pauseBatch: vi.fn(async () => ({ status: 200, body: manifest() })),
    resumeBatch: vi.fn(async () => ({ status: 200, body: manifest() })),
    cancelBatch: vi.fn(async () => ({ status: 200, body: manifest() })),
    retryFailed: vi.fn(async () => ({ status: 200, body: manifest() })),
    readReceipts: vi.fn(async () => [{
      schemaVersion: 1 as const,
      batchId,
      index: 1,
      filename: `batches/${batchId}/000001.jpg`,
      sha256: 'a'.repeat(64),
      sizeBytes: 2_048,
      verifiedAtUnixMs: 1,
    }]),
    downloadArtifact: vi.fn(async () => { throw new Error('already reconciled'); }),
    ...overrides,
  };
}

describe('production ImageForge adapter', () => {
  it('validates setup without starting compute and returns only vault metadata', async () => {
    const native = port();
    const adapter = createProductionImageForgeAdapter(native);
    expect(adapter.mode).toBe('production');
    expect(await adapter.validateStudioProfile(DEFAULT_STUDIO_PROFILE)).toBe(true);
    expect(await adapter.credentialMetadata()).toEqual(credentials());
    const result = await adapter.testConnection({
      profile: DEFAULT_STUDIO_PROFILE,
      destination: '/safe/downloads',
      destinationValidated: true,
      credentials: credentials(),
    });
    expect(result).toMatchObject({ ok: true });
    expect(native.bindProfile).toHaveBeenCalledOnce();
    expect(native.authorizeStart).not.toHaveBeenCalled();
  });

  it('projects an owned native batch and verified local receipt into the UI', async () => {
    const native = port();
    const adapter = createProductionImageForgeAdapter(native);
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));
    const state = createConfiguredInitialState();
    const batch = {
      id: 'local-provisional',
      name: 'History Brief',
      owner: 'Lakshman',
      phase: 'validating' as const,
      prompts: [{
        id: 'prompt-1', index: 1, sourceLine: 1, text: 'A documentary shipyard at dawn', seed: 700, issues: [], status: 'pending' as const, attempts: 0,
      }],
      destination: '/safe/downloads',
      startedAt: '2026-08-01T10:00:00.000Z',
      elapsedSeconds: 0,
      estimatedSecondsPerImage: 8.4,
      estimatedCost: 0,
      lockMessage: null,
      statusMessage: 'Validating',
    };
    state.pod.hourlyRate = 0.5;
    await adapter.runtime!.startBatch(batch);

    const event = events.find((candidate) => candidate.type === 'batch');
    expect(event).toMatchObject({ type: 'batch', batch: { id: batchId, name: 'History Brief', phase: 'complete' } });
    if (event?.type === 'batch') expect(event.assets[0].filename).toBe(`batches/${batchId}/000001.jpg`);
    expect(native.downloadArtifact).not.toHaveBeenCalled();
  });

  it('keeps simulated lifecycle entry points unreachable in production mode', () => {
    const adapter = createProductionImageForgeAdapter(port());
    expect(() => adapter.runPodLifecycle({ preference: 'best_value', allowSlowEmergency: false }, () => undefined)).toThrow(
      'native runtime facade',
    );
    expect(() => adapter.validateBatch(() => undefined)).toThrow('native runtime facade');
  });

  it('emits one retryable redacted event for one failed worker poll', async () => {
    const native = port({
      status: vi.fn(async () => ({
        status: 503,
        body: { error: { code: 'worker_unavailable', message: 'Worker is warming.', details: null } },
      })),
    });
    const adapter = createProductionImageForgeAdapter(native);
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));

    await expect(adapter.runtime!.pollBatch(createConfiguredInitialState())).rejects.toThrow('Worker is warming.');
    expect(events).toEqual([{
      type: 'error',
      scope: 'batch',
      message: 'Worker is warming.',
      retryable: true,
    }]);
  });

  it('clears a restart-persistent create marker only through explicit resolution', async () => {
    const native = port({
      createMarkerMetadata: vi.fn(async () => ({
        pending: true,
        attemptId: 'attempt-1',
        podName: 'imageforge-attempt-1',
        gpuId: 'gpu-1',
        podId: null,
      })),
    });
    const adapter = createProductionImageForgeAdapter(native);
    const events: ProductionRuntimeEvent[] = [];
    adapter.runtime!.subscribe((event) => events.push(event));

    await adapter.runtime!.resolveAmbiguousStart();
    expect(native.resolveCreateMarker).toHaveBeenCalledWith('attempt-1', null);
    expect(events.at(-1)).toEqual({ type: 'create-recovery', marker: null });
    expect(native.authorizeStart).not.toHaveBeenCalled();
  });
});
