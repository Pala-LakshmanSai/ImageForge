import type { ReferenceMimeType } from './types';

export const MAX_BATCH_REFERENCES = 8;
export const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
export const MAX_REFERENCE_TOTAL_BYTES = 32 * 1024 * 1024;

export function isReferenceMimeType(value: string): value is ReferenceMimeType {
  return value === 'image/jpeg' || value === 'image/png' || value === 'image/webp';
}

/** Lightweight browser-side gate. The native boundary performs the
 * authoritative validation again immediately before upload. */
export function validateReferenceBytes(
  mimeType: string,
  bytes: readonly number[],
): string | null {
  if (!isReferenceMimeType(mimeType)) return 'Use a JPEG, PNG, or WebP image reference.';
  if (bytes.length < 1 || bytes.length > MAX_REFERENCE_BYTES) {
    return `Each reference must be between 1 byte and ${MAX_REFERENCE_BYTES / (1024 * 1024)} MB.`;
  }
  const startsWith = (...expected: number[]) => expected.every((value, index) => bytes[index] === value);
  if (mimeType === 'image/jpeg' && !startsWith(0xff, 0xd8, 0xff)) return 'The JPEG header is invalid.';
  if (mimeType === 'image/png' && !startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'The PNG header is invalid.';
  if (
    mimeType === 'image/webp' &&
    (!startsWith(0x52, 0x49, 0x46, 0x46) ||
      ![0x57, 0x45, 0x42, 0x50].every((value, index) => bytes[index + 8] === value))
  ) return 'The WebP container header is invalid.';
  return null;
}

export function normalizeReferenceName(name: string): string {
  const basename = name.replace(/^.*[\\/]/, '').replace(/[\u0000\r\n]/g, '').trim();
  return basename.slice(0, 255) || 'reference-image';
}
