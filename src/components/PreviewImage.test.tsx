import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewImage, type PreviewResponse } from './PreviewImage';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const WEBP_BYTES = Array.from(new TextEncoder().encode('RIFF0000WEBP'));
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0x01, 0x02, 0xff, 0xd9];

function webpResponse(sha256 = SHA_A): PreviewResponse {
  return {
    contentType: 'image/webp',
    sha256,
    sizeBytes: WEBP_BYTES.length,
    bytes: WEBP_BYTES,
  };
}

function jpegResponse(sha256 = SHA_A): PreviewResponse {
  return {
    contentType: 'image/jpeg',
    sha256,
    sizeBytes: JPEG_BYTES.length,
    bytes: JPEG_BYTES,
  };
}

describe('PreviewImage', () => {
  let objectUrlSequence = 0;

  beforeEach(() => {
    objectUrlSequence = 0;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => {
        objectUrlSequence += 1;
        return 'blob:imageforge-' + objectUrlSequence;
      }),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps bounded remote WebP previews workable without an expected artifact checksum', async () => {
    const loader = vi.fn(async () => webpResponse());
    const fallback = <span>preview loading</span>;
    const { rerender } = render(
      <PreviewImage
        cacheKey="remote-preview-cache"
        alt="Generated frame"
        loader={loader}
        fallback={fallback}
      />,
    );

    await waitFor(() => expect(screen.getByRole('img', { name: 'Generated frame' })).toBeVisible());
    expect(loader).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).toHaveBeenCalledOnce();

    const secondLoader = vi.fn(async () => webpResponse());
    rerender(
      <PreviewImage
        cacheKey="remote-preview-cache"
        alt="Generated frame"
        loader={secondLoader}
        fallback={fallback}
      />,
    );

    expect(screen.getByRole('img', { name: 'Generated frame' })).toHaveAttribute(
      'src',
      'blob:imageforge-1',
    );
    expect(secondLoader).not.toHaveBeenCalled();
  });

  it('accepts a local JPEG only when its returned sha256 matches expectedSha256', async () => {
    const loader = vi.fn(async () => jpegResponse(SHA_A));
    render(
      <PreviewImage
        cacheKey="matching-local-jpeg"
        expectedSha256={SHA_A}
        alt="Full-quality frame"
        loader={loader}
        fallback={<span>image loading</span>}
        errorFallback={<span>image unavailable</span>}
      />,
    );

    await waitFor(() => expect(screen.getByRole('img', { name: 'Full-quality frame' })).toBeVisible());
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size).toBe(JPEG_BYTES.length);
  });

  it('rejects a WebP when Library supplies an expected full-artifact checksum', async () => {
    render(
      <PreviewImage
        cacheKey="wrong-library-content-type"
        expectedSha256={SHA_A}
        alt="Full-quality frame"
        loader={async () => webpResponse(SHA_A)}
        fallback={<span>image loading</span>}
        errorFallback={<span>image unavailable</span>}
      />,
    );

    await waitFor(() => expect(screen.getByText('image unavailable')).toBeVisible());
    expect(screen.queryByRole('img', { name: 'Full-quality frame' })).not.toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('rejects a returned sha256 that differs from expectedSha256', async () => {
    render(
      <PreviewImage
        cacheKey="wrong-library-checksum"
        expectedSha256={SHA_A}
        alt="Full-quality frame"
        loader={async () => jpegResponse(SHA_B)}
        fallback={<span>image loading</span>}
        errorFallback={<span>checksum mismatch</span>}
      />,
    );

    await waitFor(() => expect(screen.getByText('checksum mismatch')).toBeVisible());
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('rejects a size mismatch before creating an object URL', async () => {
    const invalid = { ...jpegResponse(), sizeBytes: JPEG_BYTES.length + 1 };
    render(
      <PreviewImage
        cacheKey="local-size-mismatch"
        expectedSha256={SHA_A}
        alt="Full-quality frame"
        loader={async () => invalid}
        fallback={<span>image loading</span>}
        errorFallback={<span>invalid image size</span>}
      />,
    );

    await waitFor(() => expect(screen.getByText('invalid image size')).toBeVisible());
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('rejects a JPEG larger than the native 32 MiB artifact limit', async () => {
    const invalid = { ...jpegResponse(), sizeBytes: 32 * 1024 * 1024 + 1 };
    render(
      <PreviewImage
        cacheKey="oversized-local-jpeg"
        expectedSha256={SHA_A}
        alt="Full-quality frame"
        loader={async () => invalid}
        fallback={<span>image loading</span>}
        errorFallback={<span>image too large</span>}
      />,
    );

    await waitFor(() => expect(screen.getByText('image too large')).toBeVisible());
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('does not reuse a stale object URL when the expected artifact checksum changes', async () => {
    const firstLoader = vi.fn(async () => jpegResponse(SHA_A));
    const { rerender } = render(
      <PreviewImage
        cacheKey="changing-local-image"
        expectedSha256={SHA_A}
        alt="Full-quality frame"
        loader={firstLoader}
        fallback={<span>image loading</span>}
      />,
    );
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:imageforge-1'));

    const secondLoader = vi.fn(async () => jpegResponse(SHA_B));
    rerender(
      <PreviewImage
        cacheKey="changing-local-image"
        expectedSha256={SHA_B}
        alt="Full-quality frame"
        loader={secondLoader}
        fallback={<span>image loading</span>}
      />,
    );

    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:imageforge-2'));
    expect(firstLoader).toHaveBeenCalledOnce();
    expect(secondLoader).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  });
});
