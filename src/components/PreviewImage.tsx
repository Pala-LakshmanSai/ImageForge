import { useEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode } from 'react';
import type { ValidatedImageResponse } from '../adapters/imageForgeAdapter';

export type PreviewResponse = ValidatedImageResponse;

const MAX_WEBP_PREVIEW_BYTES = 4 * 1024 * 1024;
const MAX_LOCAL_JPEG_BYTES = 32 * 1024 * 1024;
const MAX_SESSION_OBJECT_URLS = 72;
const MAX_SESSION_OBJECT_URL_BYTES = 96 * 1024 * 1024;

type PreviewLoader = () => Promise<ValidatedImageResponse>;

interface CachedImage {
  url: string;
  sizeBytes: number;
}

// This cache is intentionally session-local and bounded. Object URLs never
// enter browser storage, and older URLs are revoked as newer frames arrive.
const imageUrls = new Map<string, CachedImage>();
const pendingImages = new Map<string, Promise<string>>();
let cachedImageBytes = 0;

function revokeObjectUrl(url: string): void {
  if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
}

function cachedUrl(key: string): string | null {
  const cached = imageUrls.get(key);
  if (!cached) return null;
  imageUrls.delete(key);
  imageUrls.set(key, cached);
  return cached.url;
}

function rememberUrl(key: string, url: string, sizeBytes: number): void {
  const previous = imageUrls.get(key);
  if (previous) {
    cachedImageBytes -= previous.sizeBytes;
    if (previous.url !== url) revokeObjectUrl(previous.url);
  }
  imageUrls.delete(key);
  imageUrls.set(key, { url, sizeBytes });
  cachedImageBytes += sizeBytes;

  while (
    imageUrls.size > MAX_SESSION_OBJECT_URLS
    || cachedImageBytes > MAX_SESSION_OBJECT_URL_BYTES
  ) {
    const oldestKey = imageUrls.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    const oldest = imageUrls.get(oldestKey);
    imageUrls.delete(oldestKey);
    if (oldest) {
      cachedImageBytes -= oldest.sizeBytes;
      revokeObjectUrl(oldest.url);
    }
  }
}

function forgetUrl(key: string, url: string): void {
  const cached = imageUrls.get(key);
  if (!cached || cached.url !== url) return;
  imageUrls.delete(key);
  cachedImageBytes -= cached.sizeBytes;
  revokeObjectUrl(url);
}

function isByteArray(value: unknown, expectedLength: number): value is number[] {
  return Array.isArray(value)
    && value.length === expectedLength
    && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
}

function isJpeg(bytes: number[]): boolean {
  return bytes.length >= 5
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
    && bytes[bytes.length - 2] === 0xff
    && bytes[bytes.length - 1] === 0xd9;
}

function isWebp(bytes: number[]): boolean {
  return bytes.length >= 12
    && bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50;
}

function validatedBlob(response: unknown, expectedSha256?: string): Blob {
  if (typeof response !== 'object' || response === null) {
    throw new Error('The image response is invalid.');
  }

  const candidate = response as Partial<ValidatedImageResponse>;
  if (candidate.contentType !== 'image/jpeg' && candidate.contentType !== 'image/webp') {
    throw new Error('The image content type is invalid.');
  }
  if (
    !Number.isSafeInteger(candidate.sizeBytes)
    || candidate.sizeBytes === undefined
    || candidate.sizeBytes < 1
  ) {
    throw new Error('The image size is invalid.');
  }

  const byteLimit = candidate.contentType === 'image/jpeg'
    ? MAX_LOCAL_JPEG_BYTES
    : MAX_WEBP_PREVIEW_BYTES;
  if (candidate.sizeBytes > byteLimit) {
    throw new Error('The image is too large.');
  }
  if (!isByteArray(candidate.bytes, candidate.sizeBytes)) {
    throw new Error('The image byte count is invalid.');
  }
  if (typeof candidate.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(candidate.sha256)) {
    throw new Error('The image checksum is invalid.');
  }

  if (expectedSha256 !== undefined) {
    if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) {
      throw new Error('The expected image checksum is invalid.');
    }
    if (
      candidate.contentType !== 'image/jpeg'
      || candidate.sha256.toLocaleLowerCase() !== expectedSha256.toLocaleLowerCase()
    ) {
      throw new Error('The local JPEG does not match the expected artifact.');
    }
  }

  if (
    (candidate.contentType === 'image/jpeg' && !isJpeg(candidate.bytes))
    || (candidate.contentType === 'image/webp' && !isWebp(candidate.bytes))
  ) {
    throw new Error('The image container is invalid.');
  }

  return new Blob([new Uint8Array(candidate.bytes)], { type: candidate.contentType });
}

async function loadImage(
  sourceKey: string,
  loader: PreviewLoader,
  expectedSha256?: string,
): Promise<string> {
  const cached = cachedUrl(sourceKey);
  if (cached !== null) return cached;
  const pending = pendingImages.get(sourceKey);
  if (pending !== undefined) return pending;

  const request = loader()
    .then((response) => {
      const blob = validatedBlob(response, expectedSha256);
      const url = URL.createObjectURL(blob);
      rememberUrl(sourceKey, url, blob.size);
      return url;
    })
    .finally(() => {
      pendingImages.delete(sourceKey);
    });
  pendingImages.set(sourceKey, request);
  return request;
}

export function PreviewImage({
  cacheKey,
  expectedSha256,
  alt,
  loader,
  fallback,
  errorFallback,
  className,
  loading = 'lazy',
}: {
  cacheKey: string;
  expectedSha256?: string;
  alt: string;
  loader?: PreviewLoader;
  fallback: ReactNode;
  errorFallback?: ReactNode;
  className?: string;
  loading?: ImgHTMLAttributes<HTMLImageElement>['loading'];
}) {
  const sourceKey = 'image:' + cacheKey + ':' + (expectedSha256 ?? 'preview');
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const [resolved, setResolved] = useState<{ key: string; url: string } | null>(() => {
    const url = cachedUrl(sourceKey);
    return url === null ? null : { key: sourceKey, url };
  });
  const [failedKey, setFailedKey] = useState<string | null>(null);

  useEffect(() => {
    const cached = cachedUrl(sourceKey);
    if (cached !== null) {
      setResolved({ key: sourceKey, url: cached });
      setFailedKey(null);
      return;
    }

    setResolved(null);
    setFailedKey(null);
    const currentLoader = loaderRef.current;
    if (!currentLoader) return;

    let active = true;
    void loadImage(sourceKey, currentLoader, expectedSha256)
      .then((url) => {
        if (active) setResolved({ key: sourceKey, url });
      })
      .catch(() => {
        if (active) setFailedKey(sourceKey);
      });
    return () => {
      active = false;
    };
  }, [expectedSha256, sourceKey]);

  const url = resolved?.key === sourceKey ? resolved.url : null;
  const failed = failedKey === sourceKey;
  if (url !== null && !failed) {
    return (
      <img
        className={className}
        src={url}
        alt={alt}
        loading={loading}
        decoding="async"
        onError={() => {
          forgetUrl(sourceKey, url);
          setResolved(null);
          setFailedKey(sourceKey);
        }}
      />
    );
  }
  return <>{failed ? (errorFallback ?? fallback) : fallback}</>;
}
