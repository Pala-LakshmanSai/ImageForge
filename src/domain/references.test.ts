import { describe, expect, it } from 'vitest';
import { normalizeReferenceName, validateReferenceBytes } from './references';

describe('batch reference validation', () => {
  it('accepts supported image containers and rejects malformed bytes', () => {
    expect(validateReferenceBytes('image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).toBeNull();
    expect(validateReferenceBytes('image/jpeg', [0xff, 0xd8, 0xff])).toBeNull();
    expect(validateReferenceBytes('image/webp', [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])).toBeNull();
    expect(validateReferenceBytes('image/png', [1, 2, 3])).toContain('header');
    expect(validateReferenceBytes('image/gif', [0x47, 0x49, 0x46])).toContain('JPEG');
  });

  it('normalizes paths and control characters from local file names', () => {
    expect(normalizeReferenceName('../anchors/quiet\nroom.png')).toBe('quietroom.png');
    expect(normalizeReferenceName('')).toBe('reference-image');
  });
});
