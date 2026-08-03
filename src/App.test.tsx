import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { ImageForgeAdapter } from './adapters/imageForgeAdapter';
import type { ProductionRuntimeFacade } from './adapters/productionImageForgeAdapter';
import type { ProductionRuntimeEvent } from './adapters/productionImageForgeAdapter';
import { DEFAULT_STUDIO_PROFILE } from './adapters/imageForgeAdapter';
import { appReducer, createConfiguredInitialState, createDemoState, createInitialState } from './domain/reducer';
import type { CredentialMetadataMap, PodState } from './domain/types';

function immediateAdapter(configured = true): ImageForgeAdapter {
  let credentials: CredentialMetadataMap = {
    runpodApiKey: { configured, suffix: configured ? 'K7P9' : null, provider: 'Test vault' },
    workerToken: { configured, suffix: configured ? 'F2M4' : null, provider: 'Test vault' },
  };
  return {
    chooseDestination: async () => '/tmp/imageforge-output',
    validateDestination: async () => true,
    revealPath: async () => undefined,
    writeManifest: async (batchId) => `${batchId}/manifest.csv`,
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
  let authoritativePod: PodState | null | undefined;
  const runtime: ProductionRuntimeFacade = {
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    getAuthoritativePodState: vi.fn(() => authoritativePod ?? null),
    restoreLocalLibrary: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    observe: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
    startGpu: vi.fn(async () => undefined),
    requestGpuStop: vi.fn(async () => undefined),
    respondToGpuStop: vi.fn(async () => undefined),
    cancelGpuStop: vi.fn(async () => undefined),
    startBatch: vi.fn(async () => undefined),
    pollBatch: vi.fn(async () => undefined),
    beginNewBatch: vi.fn(),
    controlBatch: vi.fn(async () => undefined),
    resolveAmbiguousStart: vi.fn(async () => undefined),
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
  return {
    adapter,
    runtime,
    listeners,
    emit: (event: ProductionRuntimeEvent) => listeners.forEach((listener) => listener(event)),
    setAuthoritativePod: (pod: PodState | null | undefined) => { authoritativePod = pod; },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ImageForge shell', () => {
  it('refreshes production read-only on launch and starts compute only after a foreground click', async () => {
    const production = productionAdapter();
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);

    await waitFor(() => expect(production.runtime.refresh).toHaveBeenCalledOnce());
    await waitFor(() => expect(production.runtime.restoreLocalLibrary).toHaveBeenCalledOnce());
    expect(production.runtime.startGpu).not.toHaveBeenCalled();
    expect(production.adapter.runPodLifecycle).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: 'Start GPU' })[0]);
    await waitFor(() => expect(production.runtime.startGpu).toHaveBeenCalledOnce());
    expect(production.adapter.runPodLifecycle).not.toHaveBeenCalled();
  });

  it('uses a bounded, receipt-free cross-client heartbeat while Create is idle', async () => {
    vi.useFakeTimers();
    const production = productionAdapter();
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);

    await act(async () => { await Promise.resolve(); });
    expect(production.runtime.refresh).toHaveBeenCalledTimes(1);
    expect(production.runtime.heartbeat).toHaveBeenCalledWith(expect.any(Object), 'foreground');
    expect(production.runtime.heartbeat).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(3_999);
      await Promise.resolve();
    });
    expect(production.runtime.observe).not.toHaveBeenCalled();
    expect(production.runtime.heartbeat).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(production.runtime.observe).toHaveBeenCalledTimes(1);
    expect(production.runtime.heartbeat).toHaveBeenCalledTimes(2);
    expect(production.runtime.refresh).toHaveBeenCalledTimes(1);
  });

  it('waits for the strict startup refresh before publishing the first studio heartbeat', async () => {
    let releaseRefresh!: () => void;
    const production = productionAdapter();
    vi.mocked(production.runtime.refresh).mockImplementation(() => new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    }));
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);

    await waitFor(() => expect(production.runtime.refresh).toHaveBeenCalledOnce());
    expect(production.runtime.heartbeat).not.toHaveBeenCalled();

    releaseRefresh();
    await waitFor(() => expect(production.runtime.heartbeat).toHaveBeenCalledOnce());
    expect(vi.mocked(production.runtime.refresh).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(production.runtime.heartbeat).mock.invocationCallOrder[0]);
  });

  it('shows a direct synchronized notice when the confirmed GPU was already stopped elsewhere', async () => {
    const production = productionAdapter();
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);

    act(() => production.emit({
      type: 'notice',
      tone: 'info',
      title: 'GPU already stopped',
      message: 'No second termination was sent.',
    }));

    expect(await screen.findByText('GPU already stopped')).toBeVisible();
    expect(screen.getByText('No second termination was sent.')).toBeVisible();
  });

  it('waits for native RunPod credential metadata before startup refresh', async () => {
    let resolveMetadata!: (credentials: CredentialMetadataMap) => void;
    const metadata = new Promise<CredentialMetadataMap>((resolve) => { resolveMetadata = resolve; });
    const production = productionAdapter();
    const adapter = { ...production.adapter, credentialMetadata: vi.fn(() => metadata) };
    const state = createConfiguredInitialState();
    state.setup.credentials = {
      runpodApiKey: { configured: false, suffix: null, provider: 'macOS Keychain' },
      workerToken: { configured: false, suffix: null, provider: 'macOS Keychain' },
    };
    render(<App initialState={state} adapter={adapter} />);

    await waitFor(() => expect(adapter.credentialMetadata).toHaveBeenCalledOnce());
    expect(production.runtime.refresh).not.toHaveBeenCalled();

    resolveMetadata({
      runpodApiKey: { configured: true, suffix: 'K7P9', provider: 'macOS Keychain' },
      workerToken: { configured: false, suffix: null, provider: 'macOS Keychain' },
    });
    await waitFor(() => expect(production.runtime.refresh).toHaveBeenCalledOnce());
  });

  it('revalidates the shared GPU before production generation and blocks a stale ready card', async () => {
    const user = userEvent.setup();
    const production = productionAdapter();
    let state = createConfiguredInitialState();
    state = appReducer(state, {
      type: 'SET_POD_PHASE',
      phase: 'ready',
      progress: 100,
      detail: 'Model warm',
      podId: 'pod-stopped-by-sujal',
      gpu: 'RTX 4090',
      vram: '24 GB',
      hourlyRate: 0.54,
    });
    state = appReducer(state, { type: 'SET_PROMPT_TEXT', text: 'A sufficiently detailed editorial documentary frame at dawn' });
    state = appReducer(state, { type: 'SET_DESTINATION', path: '/tmp/imageforge-output' });
    production.setAuthoritativePod({
      ...state.pod,
      phase: 'offline',
      phaseProgress: 0,
      statusDetail: 'GPU is safely offline',
      gpu: null,
      vram: null,
      hourlyRate: null,
      health: 'offline',
      podId: null,
      matchingPodIds: [],
    });

    render(<App initialState={state} adapter={production.adapter} />);
    const generate = screen.getByRole('button', { name: /Generate 1 images/i });
    expect(generate).toBeEnabled();
    await user.click(generate);

    await waitFor(() => expect(screen.getByText('GPU is not ready')).toBeVisible());
    expect(production.runtime.startBatch).not.toHaveBeenCalled();
    expect(screen.getByText('Currently offline')).toBeVisible();
  });

  it('runs a strict Generate preflight even while an advisory observation is in flight', async () => {
    vi.useFakeTimers();
    const production = productionAdapter();
    let releaseObservation!: () => void;
    vi.mocked(production.runtime.observe).mockImplementation(() => new Promise<void>((resolve) => {
      releaseObservation = resolve;
    }));
    let state = createConfiguredInitialState();
    state = appReducer(state, {
      type: 'SET_POD_PHASE',
      phase: 'ready',
      progress: 100,
      detail: 'Model warm',
      podId: 'pod-stopped-remotely',
      gpu: 'RTX 4090',
      vram: '24 GB',
      hourlyRate: 0.54,
    });
    state = appReducer(state, { type: 'SET_PROMPT_TEXT', text: 'A sufficiently detailed editorial documentary frame at dawn' });
    state = appReducer(state, { type: 'SET_DESTINATION', path: '/tmp/imageforge-output' });
    production.setAuthoritativePod({
      ...state.pod,
      phase: 'offline',
      phaseProgress: 0,
      statusDetail: 'GPU is safely offline',
      gpu: null,
      vram: null,
      hourlyRate: null,
      health: 'offline',
      podId: null,
      matchingPodIds: [],
    });

    render(<App initialState={state} adapter={production.adapter} />);
    await act(async () => { await Promise.resolve(); });
    expect(production.runtime.refresh).toHaveBeenCalledOnce();
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(production.runtime.observe).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: /Generate 1 images/i }));
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });

    expect(production.runtime.refresh).toHaveBeenCalledTimes(2);
    expect(production.runtime.startBatch).not.toHaveBeenCalled();
    await act(async () => {
      releaseObservation();
      await Promise.resolve();
    });
  });

  it('labels a read-only inventory refresh without implying that a GPU is starting', () => {
    let state = createConfiguredInitialState();
    state = appReducer(state, {
      type: 'SET_POD_PHASE',
      phase: 'selecting',
      progress: 4,
      detail: 'Checking approved Secure GPUs in EU-RO-1',
    });
    render(<App initialState={state} adapter={immediateAdapter()} />);

    expect(screen.getByText('checking inventory')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refreshing' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Starting' })).not.toBeInTheDocument();
  });

  it('routes production batch controls to the authoritative runtime without optimistic fake state', async () => {
    const user = userEvent.setup();
    const production = productionAdapter();
    const state = createDemoState();
    state.batch!.canManage = true;
    state.batch!.owner = 'Server Display Name';
    render(<App initialState={state} adapter={production.adapter} />);

    await user.click(screen.getByRole('button', { name: 'Pause after frame' }));
    expect(production.runtime.controlBatch).toHaveBeenCalledWith('pause', expect.objectContaining({ batch: expect.objectContaining({ phase: 'running' }) }));
    expect(screen.getByRole('button', { name: 'Pause after frame' })).toBeVisible();
    expect(production.adapter.runBatchClock).not.toHaveBeenCalled();
  });

  it('forgets a completed recovered batch before starting a new production brief', async () => {
    const user = userEvent.setup();
    const production = productionAdapter();
    const state = createDemoState();
    state.activeView = 'create';
    state.batch = { ...state.batch!, phase: 'complete', statusMessage: '1 image verified in order' };
    render(<App initialState={state} adapter={production.adapter} />);

    expect(screen.getByText('Previous batch still open')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'New brief' }));
    expect(production.runtime.beginNewBatch).toHaveBeenCalledOnce();
    expect(screen.getByRole('heading', { name: 'Finish these items' })).toBeVisible();
  });

  it('keeps polling while a local terminal batch is visible so a remote lease can replace it', async () => {
    const production = productionAdapter();
    const state = createDemoState();
    state.batch = { ...state.batch!, phase: 'complete', statusMessage: '1 image verified in order' };
    render(<App initialState={state} adapter={production.adapter} />);

    await waitFor(() => expect(production.runtime.pollBatch).toHaveBeenCalled());
  });

  it('disables Generate and shows finalizing truth for an adopted worker guard', async () => {
    const production = productionAdapter();
    let state = createConfiguredInitialState();
    state = appReducer(state, { type: 'SET_POD_PHASE', phase: 'ready', progress: 100, detail: 'Ready', podId: 'pod-guarded' });
    state = appReducer(state, { type: 'SET_PROMPT_TEXT', text: 'A sufficiently detailed editorial documentary frame at dawn' });
    state = appReducer(state, { type: 'SET_DESTINATION', path: '/tmp/imageforge-output' });
    render(<App initialState={state} adapter={production.adapter} />);

    act(() => production.emit({
      type: 'stop-guard-active',
      podId: 'pod-guarded',
      message: 'GPU Stop is finalizing; new generation is temporarily blocked.',
    }));

    expect(screen.getByText('Exact GPU termination is being finalized')).toBeVisible();
    expect(screen.getByRole('button', { name: /Generate 1 images/i })).toBeDisabled();
  });

  it('distinguishes an owned active batch from a remote batch lock', () => {
    const owned = createDemoState();
    owned.activeView = 'create';
    owned.batch = { ...owned.batch!, phase: 'validating', canManage: true };
    const ownedProduction = productionAdapter();
    const { unmount } = render(<App initialState={owned} adapter={ownedProduction.adapter} />);

    expect(screen.getAllByText('Your batch is active')).toHaveLength(2);
    expect(screen.queryByText('Another batch is already running')).not.toBeInTheDocument();
    expect(screen.getByText('Your batch · validating')).toBeVisible();

    unmount();
    const remote = appReducer(createConfiguredInitialState(), { type: 'PREVIEW_SCENARIO', scenario: 'locked' });
    remote.activeView = 'create';
    render(<App initialState={remote} adapter={immediateAdapter()} />);

    expect(screen.getAllByText('Another batch is already running')).toHaveLength(1);
    expect(screen.getByText('Sujal · locked')).toBeVisible();
    expect(screen.queryByText('Your batch is active')).not.toBeInTheDocument();
  });

  it('renders the exact paused state for a foreign locked batch', () => {
    const remote = appReducer(createConfiguredInitialState(), { type: 'PREVIEW_SCENARIO', scenario: 'locked' });
    remote.activeView = 'progress';
    remote.batch = {
      ...remote.batch!,
      remoteState: 'paused',
      statusMessage: 'Sujal paused after 73 of 450',
      lockMessage: 'Paused after 73 of 450 images were processed.',
    };
    render(<App initialState={remote} adapter={immediateAdapter()} />);

    expect(screen.getByText('Sujal paused this batch')).toBeVisible();
    expect(screen.getAllByText('Another user paused this batch')).toHaveLength(2);
    expect(screen.queryByText('Sujal is running this batch')).not.toBeInTheDocument();
  });

  it('renders a remote paused batch as interrupted after authoritative Offline truth', () => {
    let remote = appReducer(createConfiguredInitialState(), { type: 'PREVIEW_SCENARIO', scenario: 'locked' });
    remote.batch = { ...remote.batch!, remoteState: 'paused' };
    remote = appReducer(remote, {
      type: 'SYNC_RUNTIME_POD',
      pod: {
        ...remote.pod,
        phase: 'offline',
        phaseProgress: 0,
        statusDetail: 'GPU is safely offline',
        health: 'offline',
        podId: null,
        matchingPodIds: [],
      },
    });
    remote.activeView = 'progress';
    render(<App initialState={remote} adapter={immediateAdapter()} />);

    expect(document.querySelector('.progress-heading .phase-badge')).toHaveTextContent('interrupted');
    expect(screen.queryByText('Another user paused this batch')).not.toBeInTheDocument();
    expect(screen.getByText(/Sujal must resume or cancel this batch/)).toBeVisible();
  });

  it('blocks duplicate starts and exposes explicit ambiguous-create recovery', async () => {
    const user = userEvent.setup();
    const production = productionAdapter();
    render(<App initialState={createConfiguredInitialState()} adapter={production.adapter} />);
    const listener = [...production.listeners][0];

    act(() => listener({
      type: 'create-recovery',
      marker: { attemptId: 'attempt-1', podName: 'imageforge-attempt-1', gpuId: 'gpu-1', podId: null },
    }));
    expect(screen.getByText('Interrupted RunPod start needs reconciliation')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Start GPU' })[0]).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Resolve start' }));
    expect(screen.getByRole('heading', { name: 'Confirm that no matching Pod exists' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'I confirmed no Pod exists' }));
    expect(production.runtime.resolveAmbiguousStart).toHaveBeenCalledOnce();
  });

  it('does not present an unresolved RunPod start as completed work', () => {
    const production = productionAdapter();
    const state = createConfiguredInitialState();
    state.pod = {
      ...state.pod,
      phase: 'error',
      phaseProgress: 100,
      statusDetail: 'RunPod may have created a Pod, but the result could not be confirmed.',
      errorMessage: 'RunPod may have created a Pod, but the result could not be confirmed.',
      createRecovery: {
        attemptId: 'attempt-1',
        podName: 'imageforge-attempt-1',
        gpuId: 'NVIDIA GeForce RTX 4090',
        podId: null,
      },
    };

    render(<App initialState={state} adapter={production.adapter} />);

    const track = screen.getByLabelText('Current status');
    expect(track).toHaveTextContent('RunPod start needs confirmation');
    expect(track).toHaveTextContent('—');
    expect(track).toHaveTextContent('eta action needed');
    expect(screen.getByRole('progressbar', { name: 'Current operation' })).toHaveAttribute('aria-valuenow', '0');
    expect(track).not.toHaveTextContent('100%');
  });

  it('navigates all five real destinations', async () => {
    const user = userEvent.setup();
    render(<App initialState={createConfiguredInitialState()} adapter={immediateAdapter()} />);

    for (const [label, heading] of [
      ['Progress', 'No batch running'],
      ['Library', 'Your images.'],
      ['Usage', 'Usage and cost'],
      ['Settings', 'Settings'],
      ['Create', 'New batch'],
    ] as const) {
      await user.click(screen.getByRole('button', { name: label }));
      expect(screen.getByRole('heading', { name: heading })).toBeVisible();
    }
  });

  it('shows plain batch availability and keeps the optional style instruction visible but off', () => {
    render(<App initialState={createConfiguredInitialState()} adapter={immediateAdapter()} />);

    expect(screen.getByText('Ready for a new batch')).toBeVisible();
    const styleToggle = screen.getByRole('checkbox', { name: /Optional style instruction/i });
    expect(styleToggle).not.toBeChecked();
    const styleEditor = screen.getByRole('textbox', { name: /Style instruction/i });
    expect(styleEditor).toBeVisible();
    fireEvent.change(styleEditor, { target: { value: 'soft daylight, documentary photography' } });
    expect(styleEditor).toHaveValue('soft daylight, documentary photography');
    expect(screen.getByText('Off — prompts are sent exactly as written.')).toBeVisible();
    expect(screen.queryByText('Shared batch lock available')).not.toBeInTheDocument();
  });

  it('keeps internal details out of Progress and reveals the actual named batch folder', async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const savedPrompt = state.batch!.prompts.find((prompt) => prompt.status === 'downloaded')!;
    savedPrompt.filename = 'batches/Atlas of Quiet Work/000001.jpg';
    const adapter = immediateAdapter();
    adapter.revealPath = vi.fn(async () => undefined);
    render(<App initialState={state} adapter={adapter} />);

    const progress = screen.getByRole('heading', { name: state.batch!.name }).closest('.progress-screen')!;
    expect(progress).not.toHaveTextContent(state.batch!.id);
    expect(progress).not.toHaveTextContent(/seed|checksum|receipt|sha-256|atomic rename|\.part/i);
    expect(progress).toHaveTextContent('saving images as they finish');
    await user.click(screen.getByRole('button', { name: 'Show in folder' }));
    expect(adapter.revealPath).toHaveBeenCalledWith(
      'batches/Atlas of Quiet Work/000001.jpg',
    );
    expect(state.batch!.prompts[0]).toMatchObject({ seed: expect.any(Number), checksum: expect.any(String) });
  });

  it('keeps a 450-image Progress queue incremental and seed-free', () => {
    const state = createDemoState();
    const template = state.batch!.prompts[0];
    state.batch!.prompts = Array.from({ length: 450 }, (_, index) => ({
      ...template,
      id: `prompt-${index + 1}`,
      index: index + 1,
      text: `Image prompt ${index + 1}`,
      seed: 200_000 + index,
      status: index === 0 ? ('generating' as const) : ('pending' as const),
      checksum: undefined,
      filename: undefined,
      durationSeconds: undefined,
    }));
    render(<App initialState={state} adapter={immediateAdapter()} />);

    const queue = screen.getByLabelText('450 prompts');
    expect(queue.querySelectorAll('.prompt-row').length).toBeLessThan(30);
    expect(queue).not.toHaveTextContent(/seed/i);
  });

  it('advances saved counts and live preview one image at a time from production events', () => {
    const production = productionAdapter();
    const state = createDemoState();
    state.activeView = 'progress';
    const source = state.batch!;
    const basePrompts = source.prompts.slice(0, 3).map((prompt, index) => ({
      ...prompt,
      index: index + 1,
      status: 'pending' as const,
      filename: undefined,
      checksum: undefined,
    }));
    render(<App initialState={{ ...state, batch: { ...source, prompts: basePrompts } }} adapter={production.adapter} />);
    const listener = [...production.listeners][0];
    const emitBatch = (statuses: readonly ('ready' | 'downloaded' | 'generating' | 'pending')[]) => {
      const prompts = basePrompts.map((prompt, index) => ({
        ...prompt,
        status: statuses[index],
        ...(statuses[index] === 'downloaded'
          ? { filename: `batches/Live progress/${String(index + 1).padStart(6, '0')}.jpg`, checksum: 'a'.repeat(64) }
          : {}),
      }));
      act(() => listener({
        type: 'batch',
        batch: { ...source, prompts, phase: 'running', statusMessage: 'Saving images as they finish' },
        assets: [],
      }));
    };

    emitBatch(['ready', 'generating', 'pending']);
    expect(screen.getByRole('heading', { name: 'Saving image 1 of 3' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Frame 001' })).toBeVisible();
    expect(screen.getByText('Preparing full image')).toBeVisible();
    expect(screen.getAllByText('0 saved').length).toBeGreaterThan(0);

    emitBatch(['downloaded', 'generating', 'pending']);
    expect(screen.getByRole('heading', { name: 'Creating image 2 of 3' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Frame 002' })).toBeVisible();
    expect(screen.getAllByText('1 saved').length).toBeGreaterThan(0);

    emitBatch(['downloaded', 'downloaded', 'generating']);
    expect(screen.getByRole('heading', { name: 'Creating image 3 of 3' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Frame 003' })).toBeVisible();
    expect(screen.getAllByText('2 saved').length).toBeGreaterThan(0);

    const firstPromptRow = screen.getAllByRole('button').find((button) =>
      button.textContent?.includes(basePrompts[0].text),
    );
    expect(firstPromptRow).toBeDefined();
    fireEvent.click(firstPromptRow!);
    expect(screen.getByRole('heading', { name: 'Frame 001' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Creating image 3 of 3' })).toBeVisible();

    emitBatch(['downloaded', 'downloaded', 'ready']);
    expect(screen.getByRole('heading', { name: 'Saving image 3 of 3' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Frame 001' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Pause after frame' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New brief' })).not.toBeInTheDocument();
  });

  it('runs the critical fake Create-to-Progress flow with no backend', async () => {
    const user = userEvent.setup();
    render(<App initialState={createConfiguredInitialState()} adapter={immediateAdapter()} />);

    await user.click(screen.getByRole('button', { name: 'Load sample brief' }));
    await user.click(screen.getByRole('button', { name: /Choose output folder/i }));
    await user.click(screen.getAllByRole('button', { name: 'Start GPU' })[0]);

    await waitFor(() => expect(screen.getByRole('button', { name: /Generate 24 images/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /Generate 24 images/i }));

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
    expect(screen.getByRole('heading', { name: 'New batch' })).toBeVisible();
  });

  it('moves keyboard focus to the first control on every setup step', async () => {
    const user = userEvent.setup();
    render(<App initialState={createInitialState()} adapter={immediateAdapter(false)} />);

    const name = screen.getByRole('textbox', { name: 'Your name' });
    expect(name).toHaveFocus();
    await user.type(name, 'Lakshman');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const apiKey = await screen.findByPlaceholderText('Paste restricted key');
    expect(apiKey).toHaveFocus();
    await user.type(apiKey, 'runpod-secret-1234');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const profile = await screen.findByRole('textbox', { name: 'Connection profile' });
    expect(profile).toHaveFocus();
    const workerToken = screen.getByPlaceholderText('Paste personal worker token');
    await user.type(workerToken, 'worker-secret-5678');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('button', { name: /Pictures\/ImageForge/i })).toHaveFocus();
  });

  it('clears prior destination validation when the native folder chooser is cancelled', async () => {
    const user = userEvent.setup();
    const configured = createConfiguredInitialState();
    const adapter = { ...immediateAdapter(), chooseDestination: async () => null };
    render(<App initialState={{ ...configured, setup: { ...configured.setup, completed: false } }} adapter={adapter} />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Connect RunPod.' });
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Bring in the studio profile.' });
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const chooser = await screen.findByRole('button', { name: /Pictures\/ImageForge/i });
    expect(screen.getByText('Folder ready')).toBeVisible();
    await user.click(chooser);
    await waitFor(() => expect(screen.queryByText('Folder ready')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Run connection test' })).toBeDisabled();
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

  it('routes production Stop through shared coordination before any stopping phase', async () => {
    const user = userEvent.setup();
    const production = productionAdapter();
    let state = createConfiguredInitialState();
    state = appReducer(state, { type: 'SET_POD_PHASE', phase: 'ready', progress: 100, detail: 'Ready', podId: 'pod-exact-1', gpu: 'RTX 4090' });
    render(<App initialState={state} adapter={production.adapter} />);

    await user.click(screen.getByRole('button', { name: 'Stop GPU' }));
    await user.click(screen.getByRole('button', { name: 'Request coordinated stop' }));

    expect(production.runtime.requestGpuStop).toHaveBeenCalledWith(
      expect.objectContaining({ pod: expect.objectContaining({ podId: 'pod-exact-1', phase: 'ready' }) }),
    );
    expect(screen.getByText('Checking the shared studio before stopping')).toBeVisible();
    expect(screen.queryByText('Terminating the confirmed ImageForge Pod')).not.toBeInTheDocument();
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

  it('offers worker credential replacement after an authentication failure', async () => {
    const user = userEvent.setup();
    const production = productionAdapter();
    const state = createDemoState();
    state.activeView = 'progress';
    render(<App initialState={state} adapter={production.adapter} />);
    const listener = [...production.listeners][0];

    act(() => listener({
      type: 'error',
      scope: 'batch',
      code: 'authentication_required',
      message: 'A valid worker bearer credential is required.',
      retryable: false,
    }));

    expect(screen.getByRole('button', { name: 'Replace worker credential' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Replace worker credential' }));
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  it('allows replacing the worker credential while an idle GPU remains attached', async () => {
    const user = userEvent.setup();
    const production = productionAdapter();
    let state = createConfiguredInitialState();
    state.activeView = 'settings';
    state = appReducer(state, {
      type: 'SET_POD_PHASE',
      phase: 'ready',
      progress: 100,
      detail: 'Model warm',
      podId: 'pod-ui-test',
      gpu: 'RTX 4090',
      vram: '24 GB',
      hourlyRate: 0.54,
    });
    render(<App initialState={state} adapter={production.adapter} />);

    const replaceButtons = screen.getAllByRole('button', { name: 'Replace' });
    expect(replaceButtons[1]).toBeEnabled();
    await user.click(replaceButtons[1]);
    const workerToken = screen.getByLabelText('Worker token');
    await user.type(workerToken, 'worker-secret-new');
    await user.click(screen.getByRole('button', { name: 'Save worker credential' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('Worker credential replaced')).toBeVisible();
  });

  it('allows replacing the RunPod API key while an idle GPU remains attached', async () => {
    const user = userEvent.setup();
    const production = productionAdapter();
    let state = createConfiguredInitialState();
    state.activeView = 'settings';
    state = appReducer(state, {
      type: 'SET_POD_PHASE',
      phase: 'ready',
      progress: 100,
      detail: 'Model warm',
      podId: 'pod-ui-test',
      gpu: 'RTX 4090',
      vram: '24 GB',
      hourlyRate: 0.54,
    });
    render(<App initialState={state} adapter={production.adapter} />);

    const replaceButtons = screen.getAllByRole('button', { name: 'Replace' });
    expect(replaceButtons[0]).toBeEnabled();
    await user.click(replaceButtons[0]);
    const apiKey = screen.getByLabelText('RunPod API key');
    await user.type(apiKey, 'runpod-secret-new');
    await user.click(screen.getByRole('button', { name: 'Save RunPod API key' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('RunPod API key replaced')).toBeVisible();
  });
});
