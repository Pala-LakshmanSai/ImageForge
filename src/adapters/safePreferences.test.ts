import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_STUDIO_PROFILE } from './imageForgeAdapter';
import {
  hydrateSafePreferences,
  persistSafePreferences,
  readPersistedBatchId,
  readPersistedBatchRecovery,
  SAFE_PREFERENCES_STORAGE_KEY,
} from './safePreferences';
import { createConfiguredInitialState, createInitialState } from '../domain/reducer';

describe('safe preference persistence', () => {
  it('hydrates only non-secret preferences without repeating first-run setup', () => {
    const stored = {
      version: 1,
      setupCompleted: true,
      lastOwnedBatchId: null,
      userName: 'Sujal',
      defaultDestination: 'D:\\ImageForge',
      editorialSuffixEnabled: false,
      editorialSuffix: 'natural documentary still',
      theme: 'ink',
      density: 'compact',
      gpuPreference: 'fastest',
      studioProfile: DEFAULT_STUDIO_PROFILE,
    };
    const hydrated = hydrateSafePreferences(createConfiguredInitialState(), {
      getItem: () => JSON.stringify(stored),
    });
    expect(hydrated.settings.userName).toBe('Sujal');
    expect(hydrated.settings.slowEmergencyGpuEnabled).toBe(false);
    expect(hydrated.setup.completed).toBe(true);
    expect(hydrated.setup.destinationValidated).toBe(false);
    expect(hydrated.setup.credentials.runpodApiKey.configured).toBe(true);
  });

  it('migrates an older valid v1 preference record without a recovery pointer', () => {
    const stored = {
      version: 1,
      setupCompleted: true,
      userName: 'Lakshman',
      defaultDestination: '/safe',
      editorialSuffixEnabled: true,
      editorialSuffix: 'documentary realism',
      theme: 'midnight',
      density: 'comfortable',
      gpuPreference: 'best_value',
      studioProfile: DEFAULT_STUDIO_PROFILE,
    };
    const hydrated = hydrateSafePreferences(createInitialState(), { getItem: () => JSON.stringify(stored) });
    expect(hydrated.setup.completed).toBe(true);
    expect(readPersistedBatchId({ getItem: () => JSON.stringify(stored) })).toBeNull();
  });

  it('fails closed on malformed, expanded, or oversized storage', () => {
    const base = createInitialState();
    expect(hydrateSafePreferences(base, { getItem: () => '{bad' })).toBe(base);
    expect(
      hydrateSafePreferences(base, {
        getItem: () => JSON.stringify({
          version: 1,
          setupCompleted: true,
          lastOwnedBatchId: null,
          userName: '',
          defaultDestination: '',
          editorialSuffixEnabled: true,
          editorialSuffix: '',
          theme: 'midnight',
          density: 'comfortable',
          gpuPreference: 'best_value',
          studioProfile: DEFAULT_STUDIO_PROFILE,
          runpodApiKey: 'secret',
        }),
      }),
    ).toBe(base);
    expect(hydrateSafePreferences(base, { getItem: () => 'x'.repeat(32_769) })).toBe(base);
  });

  it('never serializes secrets, prompt text, Pod IDs, or credential metadata', () => {
    const state = createConfiguredInitialState();
    state.draft.rawText = 'private prompt';
    state.pod.podId = 'private-pod';
    state.setup.credentials.runpodApiKey.suffix = 'K7P9';
    const setItem = vi.fn();
    persistSafePreferences(state, { setItem });
    expect(setItem).toHaveBeenCalledWith(SAFE_PREFERENCES_STORAGE_KEY, expect.any(String));
    const serialized = setItem.mock.calls[0][1] as string;
    expect(serialized).not.toContain('private prompt');
    expect(serialized).not.toContain('private-pod');
    expect(serialized).not.toContain('K7P9');
    expect(serialized).not.toContain('credential');
  });

  it('round-trips long user-authored suffix text without a product length cap', () => {
    const state = createConfiguredInitialState();
    const suffix = `Editorial direction ${'with layered texture '.repeat(160)}`;
    expect(suffix.length).toBeGreaterThan(2_000);
    state.settings.editorialSuffix = suffix;
    const setItem = vi.fn();

    persistSafePreferences(state, { setItem });

    const hydrated = hydrateSafePreferences(createConfiguredInitialState(), {
      getItem: () => setItem.mock.calls[0][1] as string,
    });
    expect(hydrated.settings.editorialSuffix).toBe(suffix);
  });

  it('persists the recovery UUID and exact user batch name while a batch is active', () => {
    const state = createConfiguredInitialState();
    state.batch = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Private title',
      owner: 'Lakshman',
      phase: 'running',
      prompts: [],
      destination: '/safe',
      startedAt: '2026-08-01T10:00:00.000Z',
      elapsedSeconds: 0,
      estimatedSecondsPerImage: 8.4,
      estimatedCost: 0,
      aspectRatio: '16:9',
      lockMessage: null,
      statusMessage: 'running',
      canManage: true,
    };
    const setItem = vi.fn();
    persistSafePreferences(state, { setItem });
    const serialized = setItem.mock.calls[0][1] as string;
    expect(serialized).toContain('11111111-1111-4111-8111-111111111111');
    expect(serialized).toContain('Private title');
    expect(readPersistedBatchRecovery({ getItem: () => serialized })).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Private title',
    });
  });

  it('reads a v1 recovery UUID with no invented batch name', () => {
    const stored = {
      version: 1,
      setupCompleted: true,
      lastOwnedBatchId: '11111111-1111-4111-8111-111111111111',
      userName: 'Lakshman',
      defaultDestination: '/safe',
      editorialSuffixEnabled: false,
      editorialSuffix: '',
      theme: 'midnight',
      density: 'comfortable',
      gpuPreference: 'best_value',
      studioProfile: DEFAULT_STUDIO_PROFILE,
    };
    expect(readPersistedBatchRecovery({ getItem: () => JSON.stringify(stored) })).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      name: null,
    });
  });
});
