import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GpuSelectorPerfSmoke } from './gpuSelectorPerfSmoke';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  return {
    arm: vi.fn(),
    commit: vi.fn(),
    invoke: vi.fn(),
    listeners,
    listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
      listeners.set(name, callback);
      return () => listeners.delete(name);
    }),
    onResized: vi.fn(async () => () => undefined),
    setFocus: vi.fn(async () => undefined),
    setSize: vi.fn(async () => undefined),
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onResized: mocks.onResized,
    setFocus: mocks.setFocus,
    setSize: mocks.setSize,
  }),
}));
vi.mock('./tauriBridge', () => ({
  nativeGpuSelectorPerfArm: mocks.arm,
  nativeGpuSelectorPerfCommit: mocks.commit,
}));
vi.mock('../components/GpuSelector', () => ({
  GpuSelector: () => <div data-testid="selector-surface">Selector surface</div>,
}));

const originalWidth = window.innerWidth;
const originalHeight = window.innerHeight;

describe('GpuSelectorPerfSmoke warm-open inputs', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 720 });
    window.__IMAGEFORGE_GPU_SELECTOR_PERF_QA_CONFIG__ = {
      action: 'warm_open',
      initialOrdinal: 1,
      viewportWidth: 1280,
      viewportHeight: 720,
    };
    mocks.arm.mockImplementation(async (input: { fixtureSha256: string }) => {
      if (/^0+$/u.test(input.fixtureSha256)) throw new Error('forged fixture');
      return { schemaVersion: 1, armed: true, qaSessionId: 'qa-session' };
    });
  });

  afterEach(() => {
    delete window.__IMAGEFORGE_GPU_SELECTOR_PERF_QA_CONFIG__;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight });
    vi.clearAllMocks();
    mocks.listeners.clear();
  });

  it('consumes six authenticated native pointer events as three close-open warm-ups', async () => {
    render(<GpuSelectorPerfSmoke />);
    await waitFor(() => {
      expect(mocks.listeners.has('gpu-selector-perf-warmup-input-v1')).toBe(true);
    });
    const sendWarmupInput = () => {
      const listener = mocks.listeners.get('gpu-selector-perf-warmup-input-v1');
      expect(listener).toBeDefined();
      act(() => listener?.({
        payload: {
          schemaVersion: 1,
          event: 'gpu-selector-perf-warmup-input-v1',
          input: 'primary_mouse_up',
        },
      }));
    };

    sendWarmupInput();
    expect(screen.getByRole('button', { name: 'Open GPU selector' })).toBeVisible();

    sendWarmupInput();
    expect(screen.getByTestId('selector-surface')).toBeVisible();

    sendWarmupInput();
    sendWarmupInput();
    expect(screen.getByTestId('selector-surface')).toBeVisible();

    sendWarmupInput();
    sendWarmupInput();

    expect(screen.queryByTestId('selector-surface')).not.toBeInTheDocument();
    const measuredOpen = screen.getByRole('button', { name: 'Open GPU selector' });
    expect(measuredOpen).toHaveAttribute('aria-busy', 'true');

    // The native signal may reach React before WebKit dispatches the click
    // belonging to the same sixth mouse-up. That trailing unarmed click must
    // not reopen the measured sheet.
    fireEvent.click(measuredOpen, { button: 0, detail: 1 });
    expect(screen.queryByTestId('selector-surface')).not.toBeInTheDocument();
    expect(measuredOpen).toHaveAttribute('aria-busy', 'true');
  });
});
