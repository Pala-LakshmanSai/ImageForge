import { describe, expect, it, vi } from 'vitest';
import {
  getLosslessJsonNumberToken,
  parseLosslessJson,
} from '@imageforge/runpod-client';
import vectorsJson from '../../contracts/gpu-start-auto-v1.vectors.json';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  nativeGpuStartAuto,
  parseNativeAutoGpuStartV1,
  parseNativeGpuStartResultV1,
} from './gpuStartBridge';

interface AutoVectors {
  acceptedInputs: Array<{ id: string; value: unknown }>;
  acceptedResults: Array<{ id: string; value: unknown }>;
  schemaRejections: Array<{ id: string; surface: 'input' | 'result'; value: unknown }>;
  relationRejections: Array<{ id: string; value: unknown }>;
  rawByteRejections: Array<{ id: string; surface: 'input' | 'result'; utf8: string }>;
  semanticFixturePatchAlgorithm: string;
  semanticFixtureBase: Record<string, unknown>;
  semanticRejections: Array<{
    id: string;
    fixturePatch: Record<string, unknown>;
    inventoryGetCount?: number;
    profilePodsGetCount?: number;
    providerPostCount?: number;
    journalReadCount?: number;
    journalWriteCount?: number;
  }>;
}

const vectors = vectorsJson as AutoVectors;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function imageForgeDeepOverrideV1(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return structuredClone(patch);
  const result: Record<string, unknown> = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    result[key] = imageForgeDeepOverrideV1(base[key], value);
  }
  return result;
}

describe('native GPU Start bridge', () => {
  it('consumes the shared accepted and rejected strict vectors', () => {
    for (const vector of vectors.acceptedInputs) {
      expect(parseNativeAutoGpuStartV1(vector.value), vector.id).not.toBeNull();
    }
    for (const vector of vectors.acceptedResults) {
      expect(parseNativeGpuStartResultV1(vector.value), vector.id).not.toBeNull();
    }
    for (const vector of vectors.schemaRejections) {
      const parsed = vector.surface === 'input'
        ? parseNativeAutoGpuStartV1(vector.value)
        : parseNativeGpuStartResultV1(vector.value);
      expect(parsed, vector.id).toBeNull();
    }
    for (const vector of vectors.relationRejections) {
      expect(parseNativeGpuStartResultV1(vector.value), vector.id).toBeNull();
    }
  });

  it('consumes the shared raw numeric-token rejection vectors', () => {
    const integerToken = /^(0|[1-9][0-9]*)$/;
    for (const vector of vectors.rawByteRejections) {
      let rejected = false;
      try {
        if (vector.utf8 !== vector.utf8.trim()) rejected = true;
        const parsed = parseLosslessJson(vector.utf8);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          rejected = true;
        } else {
          const record = parsed as Record<string, unknown>;
          const keys = vector.surface === 'input'
            ? ['expectedLifecycleRevision']
            : ['schemaVersion', 'lifecycleRevision', 'confirmedHourlyPriceMicroUsd', 'actualHourlyPriceMicroUsd'];
          rejected ||= keys.some((key) => {
            if (!(key in record) || record[key] === null) return false;
            const token = getLosslessJsonNumberToken(record, key);
            return token === null || !integerToken.test(token);
          });
          rejected ||= vector.surface === 'input'
            ? parseNativeAutoGpuStartV1(parsed) === null
            : parseNativeGpuStartResultV1(parsed) === null;
        }
      } catch {
        rejected = true;
      }
      expect(rejected, vector.id).toBe(true);
    }
  });

  it('uses literal-null deep overrides and proves foreground/pre-refresh rejection has zero I/O', () => {
    expect(vectors.semanticFixturePatchAlgorithm).toBe('IMAGEFORGE_DEEP_OVERRIDE_V1');
    const zeroIoIds = [
      'ready_price_mismatch',
      'skipped_revision',
      'revision_exhausted',
      'wrong_process_receipt',
      'expired_receipt_60000ms',
      'profile_lock_changed',
      'exact_replay_after_intent',
      'request_body_hash_mismatch',
      'wide_integer_overflow',
      'native_dialog_cancelled',
      'native_dialog_closed',
      'foreground_wrong_window',
      'foreground_background_window',
      'foreground_hidden_window',
      'foreground_minimized_window',
      'private_authority_replayed',
      'private_authority_expired',
    ];
    for (const id of zeroIoIds) {
      const vector = vectors.semanticRejections.find((candidate) => candidate.id === id);
      expect(vector, id).toBeDefined();
      const fixture = imageForgeDeepOverrideV1(
        vectors.semanticFixtureBase,
        vector!.fixturePatch,
      ) as Record<string, unknown>;
      expect(fixture.providerScript, `${id}: providerScript`).toBeNull();
      expect(fixture.finalObservation, `${id}: finalObservation`).toBeNull();
      expect(fixture.expectedEffects, `${id}: expectedEffects`).toEqual({
        finalInventoryStored: false,
        finalInventoryEventEmitted: false,
        finalInventoryEventBeforeProviderPost: false,
        promotedReceiptId: null,
      });
      expect(vector!.inventoryGetCount, `${id}: inventory GETs`).toBe(0);
      expect(vector!.profilePodsGetCount, `${id}: profile GETs`).toBe(0);
      expect(vector!.providerPostCount, `${id}: provider POSTs`).toBe(0);
    }
    const literalNull = imageForgeDeepOverrideV1(
      { object: { retained: 1, replaced: 'value' }, array: [1, 2] },
      { object: { replaced: null }, array: [3] },
    );
    expect(literalNull).toEqual({ object: { retained: 1, replaced: null }, array: [3] });
  });

  it('rejects a ready result whose confirmed, actual, and Pod prices differ', () => {
    const ready = structuredClone(
      vectors.acceptedResults.find((vector) => vector.id === 'ready')!.value,
    ) as Record<string, unknown>;
    ready.actualHourlyPriceMicroUsd = 700000;
    expect(parseNativeGpuStartResultV1(ready)).toBeNull();
  });

  it('invokes Auto Start with only the exact four-field input', async () => {
    const input = parseNativeAutoGpuStartV1(
      vectors.acceptedInputs.find((vector) => vector.id === 'initial_auto_start')!.value,
    )!;
    const result = vectors.acceptedResults.find((vector) => vector.id === 'create_intent')!.value;
    invoke.mockResolvedValueOnce(result);
    await expect(nativeGpuStartAuto(input)).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledWith('gpu_start_auto', { input });
  });

  it('rejects a crafted Auto input before native IPC', async () => {
    invoke.mockClear();
    await expect(nativeGpuStartAuto({
      observationId: '00000000-0000-4000-8000-000000000001',
      receiptId: '00000000-0000-4000-8000-000000000002',
      sessionId: '00000000-0000-4000-8000-000000000003',
      expectedLifecycleRevision: Number.MAX_SAFE_INTEGER + 1,
    })).rejects.toThrow('input is invalid');
    expect(invoke).not.toHaveBeenCalled();
  });
});
