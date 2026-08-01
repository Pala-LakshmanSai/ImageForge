import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { ImageForgeAdapter } from './adapters/imageForgeAdapter';
import type { ProductionRuntimeFacade } from './adapters/productionImageForgeAdapter';
import { DEFAULT_STUDIO_PROFILE } from './adapters/imageForgeAdapter';
import { appReducer, createConfiguredInitialState, createDemoState, createInitialState } from './domain/reducer';
import type { CredentialMetadataMap } from './domain/types';

function immediateAdapter(configured = true): ImageForgeAdapter {
  let credentials: CredentialMetadataMap = {
    runpodApiKey: { configured, suffix: configured ? 'K7P9' : null, provider: 'Test vault' },
    workerToken: { configured, suffix: configured ? 'F2M4' : null, provider: 'Test vault' },
  };
  return {
    chooseDestination: async () => '/tmp/imageforge-output',
    validateDestination: async () => true,
    credentialMetadata: async () => credentials,
    async replaceCredential(kind, value) {
      const metadata = { configured: true, suffix: value.slice(-4), provider: 'Test vault' };
      credentials = { ...credentials, [kind]: metadata };
      return metadata;
    },
    validateStudioProfile: async (profile) => profile === DEFAULT_STUDIO_PROFILE,
    async testConnection(input) {
      const ok = input.credentials.runpodApiKey.configured && input.credentials.workerToken.configured && input.destinationValidated;
      return { ok, message: ok ? 'Validated without creating a Pod.' : 'Setup is incomplete.' };
    },
    runPodLifecycle(_policy, onUpdate) {
      onUpdate({ phase: 'ready', progress: 100, detail: 'Model warm', podId: 'pod-ui-test', gpu: 'RTX 4090', vram: '24 GB', hourlyRate: 0.54 });
      return () => undefined;
    },
    finishPodStop(onStopped) {
      onStopped();
      return () => undefined;
    },
    validateBatch(onValidated) {
      onValidated();
      return () => undefined;
    },
    runBatchClock() {
      return () => undefined;
    },
  };
}

function productionAdapter() {
  const listeners = new Set<Parameters<ProductionRuntimeFacade['subscribe']>[0]>();
  const runtime: ProductionRuntimeFacade = {
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    refresh: vi.fn(async () => undefined),
    startGpu: vi.fn(async () => undefined),
    stopGpu: vi.fn(async () => undefined),
    startBatch: vi.fn(async () => undefined),
    pollBatch: vi.fn(async () => undefined),
    controlBatch: vi.fn(async () => undefined),
    resolveAmbiguousStart: vi.fn(),
    dispose: vi.fn(),
  };
  const fake = immediateAdapter();
  const adapter: ImageForgeAdapter = {
    ...fake,
    mode: 'production',
    runtime,
    runPodLifecycle: vi.fn(() => () => undefined),
    finishPodStop: vi.fn(() => () => undefined),
    validateBatch: vi.fn(() => () => undefined),
    runBatchClock: vi.fn(() => () => undefined),
  };
  return { adapter, runtime, listeners };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ImageForge shell', () => {
  it('refreshes production read-only on launch and starts compute only after a foreground click', async () => {
    const user = userEvent.setup();
    const production = productionAdapter();
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);

    await waitFor(() => expect(production.runtime.refresh).toHaveBeenCalledOnce());
    expect(production.runtime.startGpu).not.toHaveBeenCalled();
    expect(production.adapter.runPodLifecycle).not.toHaveBeenCalled();

    await user.click(screen.getAllByRole('button', { name: 'Start GPU' })[0]);
    await waitFor(() => expect(production.runtime.startGpu).toHaveBeenCalledOnce());
    expect(production.adapter.runPodLifecycle).not.toHaveBeenCalled();
  });

  it('routes production batch controls to the authoritative runtime without optimistic fake state', async () => {
    const user = userEvent.setup();
    const production = productionAdapter();
    const state = createDemoState();
    render(<App initialState={state} adapter={production.adapter} />);

    await user.click(screen.getByRole('button', { name: 'Pause after frame' }));
    expect(production.runtime.controlBatch).toHaveBeenCalledWith('pause', expect.objectContaining({ batch: expect.objectContaining({ phase: 'running' }) }));
    expect(screen.getByRole('button', { name: 'Pause after frame' })).toBeVisible();
    expect(production.adapter.runBatchClock).not.toHaveBeenCalled();
  });

  it('navigates all five real destinations', async () => {
    const user = userEvent.setup();
    render(<App initialState={createConfiguredInitialState()} adapter={immediateAdapter()} />);

    for (const [label, heading] of [
      ['Progress', 'The desk is clear.'],
      ['Library', 'Your visual ledger.'],
      ['Usage', 'Know every frame’s cost.'],
      ['Settings', 'Make the desk yours.'],
      ['Create', 'Direct the frame.'],
    ] as const) {
      await user.click(screen.getByRole('button', { name: label }));
      expect(screen.getByRole('heading', { name: heading })).toBeVisible();
    }
  });

  it('runs the critical fake Create-to-Progress flow with no backend', async () => {
    const user = userEvent.setup();
    render(<App initialState={createConfiguredInitialState()} adapter={immediateAdapter()} />);

    await user.click(screen.getByRole('button', { name: 'Load sample brief' }));
    await user.click(screen.getByRole('button', { name: /Choose output folder/i }));
    await user.click(screen.getAllByRole('button', { name: 'Start GPU' })[0]);

    await waitFor(() => expect(screen.getByRole('button', { name: /Generate 24 ordered images/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /Generate 24 ordered images/i }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Atlas of Quiet Work' })).toBeVisible());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause after frame' })).toBeVisible());
    await user.click(screen.getByRole('button', { name: 'Pause after frame' }));
    expect(screen.getByRole('button', { name: 'Resume' })).toBeVisible();
  });

  it('completes every asynchronous phase with the production fake adapter', async () => {
    vi.useFakeTimers();
    const configured = createConfiguredInitialState();
    const fastest = {
      ...configured,
      settings: { ...configured.settings, gpuPreference: 'fastest' as const, slowEmergencyGpuEnabled: true },
    };
    render(<App initialState={fastest} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Start GPU' })[0]);
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(screen.getByText(/RTX 2000 Ada enabled as the final slow emergency fallback/)).toBeVisible();
    await act(async () => {
      vi.advanceTimersByTime(2_700);
      await Promise.resolve();
    });

    expect(screen.getAllByText('GPU ready').length).toBeGreaterThan(0);
    expect(screen.getAllByText('RTX 5090').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Stop GPU' }).length).toBeGreaterThan(0);
  });

  it('requires a genuine first-run setup and never reuses the name node as a password field', async () => {
    const user = userEvent.setup();
    render(<App initialState={createInitialState()} adapter={immediateAdapter(false)} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(document.querySelector('.app-shell')).toHaveAttribute('inert');

    await user.type(screen.getByRole('textbox', { name: 'Your name' }), 'Lakshman');
    const firstContinue = screen.getByRole('button', { name: 'Continue' });
    await waitFor(() => expect(firstContinue).toBeEnabled());
    await user.click(firstContinue);
    await screen.findByRole('heading', { name: 'Connect RunPod.' });
    const apiKey = screen.getByPlaceholderText('Paste restricted key') as HTMLInputElement;
    expect(apiKey.value).toBe('');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Paste a RunPod API key');

    const requiredApiKey = screen.getByPlaceholderText('Paste restricted key') as HTMLInputElement;
    await user.type(requiredApiKey, 'runpod-secret-1234');
    expect(requiredApiKey.value).toBe('runpod-secret-1234');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Bring in the studio profile.' });
    const workerToken = screen.getByPlaceholderText('Paste personal worker token') as HTMLInputElement;
    expect(workerToken.value).toBe('');
    await user.type(workerToken, 'worker-secret-5678');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await user.click(await screen.findByRole('button', { name: /Pictures\/ImageForge/i }));
    await user.click(await screen.findByRole('button', { name: 'Run connection test' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Direct the frame.' })).toBeVisible();
  });

  it('closes a portaled confirmation with Escape and restores trigger focus', async () => {
    const user = userEvent.setup();
    let state = createConfiguredInitialState();
    state = appReducer(state, { type: 'SET_POD_PHASE', phase: 'ready', progress: 100, detail: 'Ready', podId: 'pod-test' });
    render(<App initialState={state} adapter={immediateAdapter()} />);

    const trigger = screen.getByRole('button', { name: 'Stop GPU' });
    await user.click(trigger);
    expect(screen.getByRole('alertdialog')).toBeVisible();
    expect(document.querySelector('.app-shell')).toHaveAttribute('inert');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('exposes owner resume and cancel controls for a restarted interrupted batch', async () => {
    const user = userEvent.setup();
    let state = createDemoState();
    state = appReducer(state, { type: 'CONFIRM_STOP_POD' });
    state = appReducer(state, { type: 'POD_STOPPED' });
    state = appReducer(state, { type: 'SET_POD_PHASE', phase: 'ready', progress: 100, detail: 'Ready', podId: 'pod-next' });
    render(<App initialState={state} adapter={immediateAdapter()} />);

    expect(screen.getByRole('button', { name: 'Cancel interrupted batch' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Resume interrupted batch' }));
    expect(screen.getByRole('button', { name: 'Pause after frame' })).toBeVisible();
  });

  it('routes credential replacement into the relevant setup step', async () => {
    const user = userEvent.setup();
    render(<App initialState={{ ...createConfiguredInitialState(), activeView: 'settings' }} adapter={immediateAdapter()} />);

    const replaceButtons = screen.getAllByRole('button', { name: 'Replace' });
    await user.click(replaceButtons[0]);
    expect(screen.getByRole('heading', { name: 'Connect RunPod.' })).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
