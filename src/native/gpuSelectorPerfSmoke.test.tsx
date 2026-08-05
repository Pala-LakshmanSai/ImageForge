import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GpuSelectorPerfSmoke } from './gpuSelectorPerfSmoke';

const mocks = vi.hoisted(() => ({
  arm: vi.fn(),
  commit: vi.fn(),
  invoke: vi.fn(),
  listen: vi.fn(async () => () => undefined),
  onResized: vi.fn(async () => () => undefined),
  setFocus: vi.fn(async () => undefined),
  setSize: vi.fn(async () => undefined),
}));

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

function pointerActivation(target: HTMLElement) {
  fireEvent.mouseDown(target, { button: 0 });
  fireEvent.mouseUp(target, { button: 0 });
  fireEvent.click(target, { button: 0, detail: 1 });
}

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
  });

  it('consumes six trusted pointer activations as three close-open warm-ups', () => {
    render(<GpuSelectorPerfSmoke />);

    pointerActivation(screen.getByRole('button', { name: 'Close QA sheet' }));
    expect(screen.getByRole('button', { name: 'Open GPU selector' })).toBeVisible();

    pointerActivation(screen.getByRole('button', { name: 'Open GPU selector' }));
    expect(screen.getByTestId('selector-surface')).toBeVisible();

    pointerActivation(screen.getByRole('button', { name: 'Close QA sheet' }));
    pointerActivation(screen.getByRole('button', { name: 'Open GPU selector' }));
    expect(screen.getByTestId('selector-surface')).toBeVisible();

    pointerActivation(screen.getByRole('button', { name: 'Close QA sheet' }));
    pointerActivation(screen.getByRole('button', { name: 'Open GPU selector' }));

    expect(screen.queryByTestId('selector-surface')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open GPU selector' })).toHaveAttribute('aria-busy', 'true');
  });
});
