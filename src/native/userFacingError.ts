import { asNativeError } from './tauriBridge';

/** Native commands reject with a serialized `{ code, message }` payload rather
 * than an `Error`, so a bare `instanceof Error` check drops the only useful
 * part of a native failure. Prefer the native reason whenever it is specific. */
export function userFacingErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  const native = asNativeError(error);
  return native.code === 'native_operation_failed' ? fallback : native.message;
}
