import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewImage, type PreviewResponse } from './PreviewImage';

const validPreview: PreviewResponse = {
  contentType: 'image/webp',
  sha256: 'a'.repeat(64),
  sizeBytes: 12,
  bytes: Array.from(new TextEncoder().encode('RIFF0000WEBP')),
};

describe('PreviewImage', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:imageforge-preview'),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads a verified preview and reuses the session-local object URL', async () => {
    const loader = vi.fn(async () => validPreview);
    const fallback = <span>preview fallback</span>;
    const { rerender } = render(
      <PreviewImage cacheKey="preview-cache-test" alt="Generated frame" loader={loader} fallback={fallback} />,
    );

    await waitFor(() => expect(screen.getByRole('img', { name: 'Generated frame' })).toBeVisible());
    expect(loader).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).toHaveBeenCalledOnce();

    const secondLoader = vi.fn(async () => validPreview);
    rerender(
      <PreviewImage cacheKey="preview-cache-test" alt="Generated frame" loader={secondLoader} fallback={fallback} />,
    );
    expect(screen.getByRole('img', { name: 'Generated frame' })).toHaveAttribute(
      'src',
      'blob:imageforge-preview',
    );
    expect(secondLoader).not.toHaveBeenCalled();
  });

  it('falls back when the worker response violates the size contract', async () => {
    const loader = vi.fn(async () => ({ ...validPreview, sizeBytes: 13 }));
    render(
      <PreviewImage
        cacheKey="preview-invalid-size-test"
        alt="Generated frame"
        loader={loader}
        fallback={<span>preview fallback</span>}
      />,
    );

    await waitFor(() => expect(screen.getByText('preview fallback')).toBeVisible());
    expect(screen.queryByRole('img', { name: 'Generated frame' })).not.toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
