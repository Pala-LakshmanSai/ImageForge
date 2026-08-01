import { describe, expect, it } from 'vitest';
import {
  NATIVE_RUNPOD_API_KEY_SENTINEL,
  asNativeError,
  isNativeDesktop,
} from './tauriBridge';

describe('native bridge safety boundary', () => {
  it('does not treat a normal browser test runtime as native', () => {
    expect(isNativeDesktop()).toBe(false);
  });

  it('normalizes unknown failures without reflecting raw values', () => {
    const secret = 'rp_secret_should_not_escape';
    const normalized = asNativeError(new Error(secret));
    expect(normalized.message).not.toContain(secret);
    expect(JSON.stringify(normalized)).not.toContain(secret);
  });

  it('uses a non-credential sentinel for the JS RunPod transport', () => {
    expect(NATIVE_RUNPOD_API_KEY_SENTINEL).toBe('__IMAGEFORGE_NATIVE_VAULT__');
    expect(NATIVE_RUNPOD_API_KEY_SENTINEL).not.toMatch(/^rp_/);
  });
});
