import { describe, expect, it } from 'vitest';
import { parseWorkerApiError, parseWorkerManifest, parseWorkerStatus } from './workerContracts';

const owner = { user_id: 'lakshman', display_name: 'Lakshman' };
const progress = {
  total: 1,
  completed: 1,
  downloaded: 0,
  failed: 0,
  cancelled: 0,
  processed: 1,
  current_index: null,
};

function manifest() {
  return {
    schema_version: 1,
    batch_id: '11111111-1111-4111-8111-111111111111',
    owner,
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
        prompt: 'A documentary photograph of a shipyard at dawn',
        seed: 100,
        status: 'ready',
        attempts: 1,
        retry_rounds: 0,
        filename: 'artifacts/000001.jpg',
        sha256: 'a'.repeat(64),
        size_bytes: 2048,
        generation_ms: 8300,
        error: null,
        receipt: null,
      },
    ],
    progress,
  };
}

describe('strict worker renderer contracts', () => {
  it('parses the native-projected owner status and blocking summary', () => {
    expect(
      parseWorkerStatus({
        schema_version: 1,
        ready: true,
        active_batch: {
          batch_id: '11111111-1111-4111-8111-111111111111',
          owner,
          state: 'running',
          progress: { ...progress, completed: 0, processed: 0, current_index: 1 },
          pause_requested: false,
          cancel_requested: false,
        },
        permissions: { can_create: false, can_manage_active: false, is_owner: false },
      }).activeBatch?.owner.displayName,
    ).toBe('Lakshman');
  });

  it('accepts an idle worker temporarily protected by a finalization guard', () => {
    expect(parseWorkerStatus({
      schema_version: 1,
      ready: true,
      active_batch: null,
      permissions: { can_create: false, can_manage_active: false, is_owner: false },
    })).toMatchObject({
      activeBatch: null,
      permissions: { canCreate: false, canManageActive: false, isOwner: false },
    });

    expect(() => parseWorkerStatus({
      schema_version: 1,
      ready: true,
      active_batch: {
        batch_id: '11111111-1111-4111-8111-111111111111',
        owner,
        state: 'running',
        progress: { ...progress, completed: 0, processed: 0, current_index: 1 },
        pause_requested: false,
        cancel_requested: false,
      },
      permissions: { can_create: true, can_manage_active: false, is_owner: false },
    })).toThrow('cannot allow creation');
  });

  it('parses an ordered manifest and rejects response expansion', () => {
    expect(parseWorkerManifest(manifest()).images[0].sha256).toBe('a'.repeat(64));
    expect(() => parseWorkerManifest({ ...manifest(), token: 'must-not-cross-ipc' })).toThrow(
      'unknown field',
    );
  });

  it('rejects counter, filename, checksum, and index inconsistencies', () => {
    expect(() => parseWorkerManifest({ ...manifest(), progress: { ...progress, downloaded: 2 } })).toThrow(
      'inconsistent',
    );
    const badFilename = manifest();
    badFilename.images[0].filename = 'artifacts/not-ordered.jpg';
    expect(() => parseWorkerManifest(badFilename)).toThrow('ordered path');
    const badChecksum = manifest();
    badChecksum.images[0].sha256 = 'bad';
    expect(() => parseWorkerManifest(badChecksum)).toThrow('invalid');
    const badIndex = manifest();
    badIndex.images[0].index = 2;
    expect(() => parseWorkerManifest(badIndex)).toThrow('contiguous');
  });

  it('rejects progress that does not reconcile with image states', () => {
    expect(() => parseWorkerManifest({
      ...manifest(),
      progress: { ...progress, failed: 1 },
    })).toThrow('inconsistent');

    const downloaded = manifest();
    downloaded.state = 'completed';
    downloaded.images[0].status = 'downloaded';
    downloaded.progress = { ...progress, downloaded: 1 };
    expect(() => parseWorkerManifest(downloaded)).toThrow('receipt');

    const generating = {
      ...manifest(),
      progress: { ...progress, completed: 0, processed: 0, current_index: 1 },
    };
    generating.state = 'running';
    generating.images[0].status = 'generating';
    expect(parseWorkerManifest(generating).progress.currentIndex).toBe(1);
  });

  it('rejects unsupported render sizes, unsafe references, and ownerless mutation access', () => {
    expect(() => parseWorkerManifest({
      ...manifest(),
      settings: { width: 1000, height: 1000 },
    })).toThrow('render size');
    expect(() => parseWorkerManifest({
      ...manifest(),
      references: [{
        name: '../secret.png',
        mime_type: 'image/png',
        size_bytes: 1024,
        sha256: 'a'.repeat(64),
        filename: 'references/000001.png',
      }],
    })).toThrow('name');
    expect(() => parseWorkerStatus({
      schema_version: 1,
      ready: true,
      active_batch: null,
      permissions: { can_create: true, can_manage_active: true, is_owner: false },
    })).toThrow('mutation access');
  });

  it('parses only the safe worker error envelope', () => {
    expect(
      parseWorkerApiError({
        error: {
          code: 'batch_busy',
          message: 'Another user is generating.',
          details: { owner: 'Sujal', completed: 17, total: 400 },
        },
      }).code,
    ).toBe('batch_busy');
    expect(() =>
      parseWorkerApiError({ error: { code: 'bad', message: 'bad', details: null, traceback: 'secret' } }),
    ).toThrow('unknown field');
  });

  it('parses a 450-image manifest within the desktop budget', () => {
    const base = manifest();
    const images = Array.from({ length: 450 }, (_, offset) => ({
      ...base.images[0],
      index: offset + 1,
      seed: 100 + offset,
      filename: `artifacts/${String(offset + 1).padStart(6, '0')}.jpg`,
    }));
    const started = performance.now();
    const parsed = parseWorkerManifest({
      ...base,
      images,
      progress: { ...progress, total: 450, completed: 450, processed: 450 },
    });
    expect(parsed.images).toHaveLength(450);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('projects safe batch reference metadata without accepting raw bytes', () => {
    const parsed = parseWorkerManifest({
      ...manifest(),
      references: [{
        name: 'anchor.png',
        mime_type: 'image/png',
        size_bytes: 1024,
        sha256: 'a'.repeat(64),
        filename: 'references/000001.png',
      }],
    });
    expect(parsed.references).toEqual([{
      name: 'anchor.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
      sha256: 'a'.repeat(64),
      filename: 'references/000001.png',
    }]);
  });
});
