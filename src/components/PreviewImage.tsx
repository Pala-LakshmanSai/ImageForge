import { useEffect, useState, type ReactNode } from 'react';

export interface PreviewResponse {
  contentType: 'image/webp';
  sha256: string;
  sizeBytes: number;
  bytes: number[];
}

type PreviewLoader = () => Promise<PreviewResponse>;

// A session-local cache keeps the pipeline and Library views from refetching
// the same tiny preview while never persisting generated pixels to browser
// storage. The native command remains the only authenticated transport.
const previewUrls = new Map<string, string>();
const pendingPreviews = new Map<string, Promise<string>>();

async function loadPreview(cacheKey: string, loader: PreviewLoader): Promise<string> {
  const cached = previewUrls.get(cacheKey);
  if (cached !== undefined) return cached;
  const pending = pendingPreviews.get(cacheKey);
  if (pending !== undefined) return pending;

  const request = loader().then((response) => {
    if (
      response.contentType !== 'image/webp' ||
      !Number.isSafeInteger(response.sizeBytes) ||
      response.sizeBytes < 1 ||
      response.sizeBytes > 4 * 1024 * 1024 ||
      response.bytes.length !== response.sizeBytes
    ) {
      throw new Error('The worker preview failed the desktop image contract.');
    }
    const url = URL.createObjectURL(new Blob([new Uint8Array(response.bytes)], { type: response.contentType }));
    previewUrls.set(cacheKey, url);
    return url;
  }).finally(() => {
    pendingPreviews.delete(cacheKey);
  });
  pendingPreviews.set(cacheKey, request);
  return request;
}

export function PreviewImage({
  cacheKey,
  alt,
  loader,
  fallback,
  className,
}: {
  cacheKey: string;
  alt: string;
  loader?: PreviewLoader;
  fallback: ReactNode;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(() => previewUrls.get(cacheKey) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setUrl(previewUrls.get(cacheKey) ?? null);
    setFailed(false);
    if (!loader || previewUrls.has(cacheKey)) return;
    let active = true;
    void loadPreview(cacheKey, loader)
      .then((nextUrl) => {
        if (active) setUrl(nextUrl);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [cacheKey, loader]);

  if (url && !failed) {
    return <img
      className={className}
      src={url}
      alt={alt}
      onError={() => {
        // A valid container/checksum is not enough to guarantee that the
        // platform decoder accepts the image. Remove a broken URL from the
        // session cache so a later retry can request a fresh preview.
        previewUrls.delete(cacheKey);
        URL.revokeObjectURL(url);
        setFailed(true);
      }}
    />;
  }
  return <>{fallback}</>;
}
