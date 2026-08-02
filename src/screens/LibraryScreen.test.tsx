import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeImageForgeAdapter,
  type ImageForgeAdapter,
} from '../adapters/imageForgeAdapter';
import { createConfiguredInitialState } from '../domain/reducer';
import type { AppState, LibraryAsset } from '../domain/types';
import { LibraryScreen } from './LibraryScreen';

const BATCH_ID = '003d9b24-3b35-47bd-8475-77d75c2f973e';
const BATCH_NAME = 'Atlas of Quiet Work';
const SHA_A = 'a'.repeat(64);
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0x01, 0x02, 0xff, 0xd9];

function asset(index: number): LibraryAsset {
  const frame = String(index).padStart(6, '0');
  return {
    id: BATCH_ID + '-' + index,
    batchId: BATCH_ID,
    batchName: BATCH_NAME,
    index,
    prompt: 'Quiet editorial workspace frame ' + index,
    seed: 8_000 + index,
    filename: 'batches/' + BATCH_NAME + '/' + frame + '.jpg',
    checksum: index === 1 ? SHA_A : (index % 16).toString(16).repeat(64),
    createdAt: '2026-08-02T12:00:00.000Z',
    durationSeconds: 7.5 + index / 100,
    destination: '/Volumes/Output',
    palette: index % 6,
  };
}

function libraryState(count: number): AppState {
  const state = createConfiguredInitialState();
  state.library = Array.from({ length: count }, (_, offset) => asset(offset + 1));
  return state;
}

function adapter(overrides: Partial<ImageForgeAdapter> = {}): ImageForgeAdapter {
  return { ...createFakeImageForgeAdapter(), ...overrides };
}

describe('LibraryScreen', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:library-local-jpeg'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses friendly frame labels and keeps internal artifact jargon out of the Library', () => {
    const dispatch = vi.fn();
    const { container } = render(
      <LibraryScreen state={libraryState(2)} dispatch={dispatch} adapter={adapter()} />,
    );

    expect(screen.getByRole('heading', { name: 'Your images.' })).toBeVisible();
    expect(screen.getByText('Atlas of Quiet Work · 001')).toBeVisible();
    expect(screen.getByText('Atlas of Quiet Work · 002')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Download Atlas of Quiet Work · 001' })).toBeVisible();

    const visibleCopy = container.textContent?.toLocaleLowerCase() ?? '';
    expect(visibleCopy).not.toContain(BATCH_ID);
    expect(visibleCopy).not.toContain('000001.jpg');
    expect(visibleCopy).not.toContain('seed');
    expect(visibleCopy).not.toContain('checksum');
    expect(visibleCopy).not.toContain('receipt');
    expect(visibleCopy).not.toContain('sha-256');
    expect(visibleCopy).not.toContain('verified');
  });

  it('keeps card selection and Download as separate keyboard-operable targets', async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    const downloadAsset = vi.fn(async () => '/Downloads/Atlas of Quiet Work - 001.jpg');
    const revealPath = vi.fn(async () => undefined);
    render(
      <LibraryScreen
        state={libraryState(1)}
        dispatch={dispatch}
        adapter={adapter({ downloadAsset, revealPath })}
      />,
    );

    const label = 'Atlas of Quiet Work · 001';
    const openButton = screen.getByRole('button', { name: 'Open details for ' + label });
    const cardDownload = screen.getByRole('button', { name: 'Download ' + label });
    expect(openButton).not.toContainElement(cardDownload);

    cardDownload.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(downloadAsset).toHaveBeenCalledOnce());
    expect(downloadAsset).toHaveBeenCalledWith({
      batchId: BATCH_ID,
      index: 1,
      batchName: BATCH_NAME,
      checksum: SHA_A,
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    openButton.focus();
    await user.keyboard('{Enter}');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: label })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Download ' + label })).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Show ' + label + ' in folder' }));
    expect(revealPath).toHaveBeenCalledWith('batches/' + BATCH_NAME + '/000001.jpg');
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'SHOW_TOAST',
      tone: 'success',
      title: 'Image shown in folder',
    }));
  });

  it('reports a failed per-image download without claiming success', async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    const downloadAsset = vi.fn(async () => {
      throw new Error('The selected location is not writable.');
    });
    render(
      <LibraryScreen
        state={libraryState(1)}
        dispatch={dispatch}
        adapter={adapter({ downloadAsset })}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Download Atlas of Quiet Work · 001' }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({
      type: 'SHOW_TOAST',
      tone: 'error',
      title: 'Download failed',
      message: 'The selected location is not writable.',
    }));
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({
      tone: 'success',
      title: 'Image downloaded',
    }));
  });

  it('loads the checksum-bound local JPEG for a production Library card', async () => {
    const fetchPreview = vi.fn(async () => ({
      contentType: 'image/jpeg' as const,
      sha256: SHA_A,
      sizeBytes: JPEG_BYTES.length,
      bytes: JPEG_BYTES,
    }));
    const productionAdapter: ImageForgeAdapter = {
      ...adapter(),
      mode: 'production',
      fetchPreview,
    };

    render(
      <LibraryScreen
        state={libraryState(1)}
        dispatch={vi.fn()}
        adapter={productionAdapter}
      />,
    );

    await waitFor(() => expect(
      screen.getByRole('img', { name: 'Generated image for Atlas of Quiet Work · 001' }),
    ).toBeVisible());
    expect(fetchPreview).toHaveBeenCalledWith(BATCH_ID, 1);
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size).toBe(JPEG_BYTES.length);
  });

  it('keeps receipt-only restart recovery minimal until worker metadata returns', async () => {
    const user = userEvent.setup();
    const state = libraryState(1);
    state.library[0] = {
      ...state.library[0],
      prompt: 'Saved image 001',
      durationSeconds: 0,
      recovered: true,
    };
    render(<LibraryScreen state={state} dispatch={vi.fn()} adapter={adapter()} />);

    expect(screen.getByText('Saved locally')).toBeVisible();
    expect(screen.queryByText('0.0s render')).not.toBeInTheDocument();
    expect(screen.queryByText('Saved image 001')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', {
      name: 'Open details for Atlas of Quiet Work · 001',
    }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).not.toHaveAttribute('aria-describedby');
    expect(within(dialog).queryByText('Saved image 001')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Available after reconnect')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Render time')).not.toBeInTheDocument();
  });

  it('keeps a 450-image Library incremental at 36 cards per step', async () => {
    const user = userEvent.setup();
    render(
      <LibraryScreen state={libraryState(450)} dispatch={vi.fn()} adapter={adapter()} />,
    );

    expect(screen.getAllByRole('button', { name: /^Open details for / })).toHaveLength(36);
    expect(screen.getByText('36 of 450 shown')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Show 36 more' }));
    expect(screen.getAllByRole('button', { name: /^Open details for / })).toHaveLength(72);
    expect(screen.getByText('72 of 450 shown')).toBeVisible();
  });
});
