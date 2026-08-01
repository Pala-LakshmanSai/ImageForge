import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_STUDIO_PROFILE } from './imageForgeAdapter';
import {
  hydrateSafePreferences,
  persistSafePreferences,
  SAFE_PREFERENCES_STORAGE_KEY,
} from './safePreferences';
import { createConfiguredInitialState, createInitialState } from '../domain/reducer';

describe('safe preference persistence', () => {
  it('hydrates only non-secret preferences and forces setup revalidation', () => {
    const stored = {
      version: 1,
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
    expect(hydrated.setup.completed).toBe(false);
    expect(hydrated.setup.destinationValidated).toBe(false);
    expect(hydrated.setup.credentials.runpodApiKey.configured).toBe(true);
  });

  it('fails closed on malformed, expanded, or oversized storage', () => {
    const base = createInitialState();
    expect(hydrateSafePreferences(base, { getItem: () => '{bad' })).toBe(base);
    expect(
      hydrateSafePreferences(base, {
        getItem: () => JSON.stringify({
          version: 1,
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
});
