import { parsePromptText, SAMPLE_PROMPTS } from './prompts';
import type {
  AppAction,
  AppState,
  BatchPrompt,
  BatchState,
  DraftState,
  LibraryAsset,
  OperationalScenario,
  PodPhase,
  PodState,
  SettingsState,
  UsageRun,
} from './types';

const DEFAULT_DESTINATION = '/Users/lakshman/Pictures/ImageForge';
const DEMO_STARTED_AT = '2026-08-01T08:30:00.000Z';

export const DEFAULT_SETTINGS: SettingsState = {
  userName: 'Lakshman',
  defaultDestination: DEFAULT_DESTINATION,
  editorialSuffixEnabled: true,
  editorialSuffix: 'Editorial realism, natural light, honest texture, restrained color, no text or logos.',
  theme: 'midnight',
  density: 'comfortable',
  simulationSpeed: 1,
  soundsEnabled: false,
  gpuPreference: 'best_value',
  emergencyGpuTierEnabled: false,
};

function emptyPod(): PodState {
  return {
    phase: 'offline',
    phaseProgress: 0,
    statusDetail: 'GPU is safely offline',
    gpu: null,
    vram: null,
    hourlyRate: null,
    health: 'offline',
    podId: null,
    matchingPodIds: [],
    lastCheckedAt: null,
    errorMessage: null,
  };
}

function readyPod(): PodState {
  return {
    phase: 'ready',
    phaseProgress: 100,
    statusDetail: 'Model warm · accepting one batch',
    gpu: 'RTX 4090',
    vram: '24 GB',
    hourlyRate: 0.54,
    health: 'healthy',
    podId: 'pod-if-7K2M',
    matchingPodIds: ['pod-if-7K2M'],
    lastCheckedAt: '2026-08-01T08:34:12.000Z',
    errorMessage: null,
  };
}

function emptyDraft(): DraftState {
  return {
    name: 'Untitled batch',
    rawText: '',
    sourceName: null,
    prompts: [],
    issues: [],
    destination: null,
  };
}

export function createInitialState(): AppState {
  return {
    activeView: 'create',
    pod: emptyPod(),
    draft: emptyDraft(),
    batch: null,
    library: [],
    usage: [],
    settings: DEFAULT_SETTINGS,
    dialog: null,
    toast: null,
    toastSequence: 0,
    refreshedAt: null,
  };
}

function createPromptSet(count = 24): BatchPrompt[] {
  const parsed = parsePromptText(SAMPLE_PROMPTS).prompts.slice(0, count);
  return parsed.map((prompt) => ({
    ...prompt,
    status: 'pending',
    attempts: 0,
  }));
}

function checksumFor(index: number, seed: number): string {
  return `${(seed * 2654435761 + index).toString(16).padStart(8, '0').slice(-8)}…${(seed + index * 97)
    .toString(16)
    .padStart(6, '0')
    .slice(-6)}`;
}

function completedPrompt(prompt: BatchPrompt): BatchPrompt {
  const durationSeconds = 7.2 + ((prompt.index * 13) % 18) / 10;
  return {
    ...prompt,
    status: 'downloaded',
    filename: `${String(prompt.index).padStart(4, '0')}.jpg`,
    checksum: checksumFor(prompt.index, prompt.seed),
    durationSeconds,
  };
}

function assetFromPrompt(batch: BatchState, prompt: BatchPrompt): LibraryAsset {
  return {
    id: `${batch.id}-${prompt.index}`,
    batchId: batch.id,
    batchName: batch.name,
    index: prompt.index,
    prompt: prompt.text,
    seed: prompt.seed,
    filename: prompt.filename ?? `${String(prompt.index).padStart(4, '0')}.jpg`,
    checksum: prompt.checksum ?? checksumFor(prompt.index, prompt.seed),
    createdAt: batch.startedAt,
    durationSeconds: prompt.durationSeconds ?? 8.1,
    destination: batch.destination,
    palette: prompt.seed % 6,
  };
}

function upsertLibraryAsset(library: LibraryAsset[], asset: LibraryAsset): LibraryAsset[] {
  return [...library.filter((item) => item.id !== asset.id), asset].sort((left, right) => {
    if (left.batchId === right.batchId) return left.index - right.index;
    return right.createdAt.localeCompare(left.createdAt);
  });
}

function buildDemoBatch(phase: BatchState['phase'] = 'running'): BatchState {
  let prompts = createPromptSet();
  prompts = prompts.map((prompt, index) => {
    if (index < 9) return completedPrompt(prompt);
    if (index === 9) return { ...prompt, status: 'generating' };
    return prompt;
  });
  return {
    id: 'batch-20260801-01',
    name: 'Atlas of Quiet Work',
    owner: 'Lakshman',
    phase,
    prompts,
    destination: DEFAULT_DESTINATION,
    startedAt: DEMO_STARTED_AT,
    elapsedSeconds: 78,
    estimatedSecondsPerImage: 8.4,
    estimatedCost: 0.012,
    lockMessage: null,
    statusMessage: phase === 'paused' ? 'Paused after image 009' : 'Generating image 010 of 024',
  };
}

export function createDemoState(): AppState {
  const batch = buildDemoBatch();
  return {
    ...createInitialState(),
    activeView: 'progress',
    pod: readyPod(),
    draft: {
      name: batch.name,
      rawText: SAMPLE_PROMPTS,
      sourceName: 'atlas-prompts.txt',
      prompts: batch.prompts,
      issues: [],
      destination: DEFAULT_DESTINATION,
    },
    batch,
    library: batch.prompts
      .filter((prompt) => prompt.status === 'downloaded')
      .map((prompt) => assetFromPrompt(batch, prompt)),
    usage: [
      {
        id: 'usage-previous-1',
        name: 'Monsoon Architecture',
        date: '2026-07-29T11:10:00.000Z',
        gpu: 'RTX 4090',
        completed: 186,
        failed: 2,
        seconds: 1564,
        cost: 0.235,
      },
      {
        id: 'usage-previous-2',
        name: 'Coastal Field Notes',
        date: '2026-07-27T09:15:00.000Z',
        gpu: 'RTX 5090',
        completed: 320,
        failed: 0,
        seconds: 2180,
        cost: 0.412,
      },
    ],
  };
}

function toast(
  state: AppState,
  tone: AppState['toast'] extends infer _T ? 'success' | 'warning' | 'info' | 'error' : never,
  title: string,
  message: string,
): Pick<AppState, 'toast' | 'toastSequence'> {
  const id = state.toastSequence + 1;
  return { toastSequence: id, toast: { id, tone, title, message } };
}

function podDetails(phase: PodPhase, progress: number, detail: string, current: PodState): PodState {
  const isReady = phase === 'ready';
  const isOffline = phase === 'offline';
  const isError = phase === 'error';
  return {
    ...current,
    phase,
    phaseProgress: progress,
    statusDetail: detail,
    gpu: isReady || (!isOffline && current.gpu) ? current.gpu ?? 'RTX 4090' : null,
    vram: isReady || (!isOffline && current.vram) ? current.vram ?? '24 GB' : null,
    hourlyRate: isReady || (!isOffline && current.hourlyRate) ? current.hourlyRate ?? 0.54 : null,
    health: isReady ? 'healthy' : isOffline ? 'offline' : isError ? 'degraded' : 'checking',
    podId: isReady ? current.podId ?? 'pod-if-7K2M' : isOffline ? null : current.podId,
    matchingPodIds: isOffline ? [] : current.matchingPodIds,
    errorMessage: isError ? detail : null,
  };
}

function hasDraftErrors(state: AppState): boolean {
  return state.draft.issues.some((issue) => issue.level === 'error');
}

export function canStartBatch(state: AppState): boolean {
  return (
    state.pod.phase === 'ready' &&
    state.batch === null &&
    state.draft.prompts.length > 0 &&
    state.draft.destination !== null &&
    !hasDraftErrors(state)
  );
}

export function batchCounts(batch: BatchState | null) {
  if (!batch) return { total: 0, completed: 0, failed: 0, pending: 0, progress: 0 };
  const completed = batch.prompts.filter((prompt) => prompt.status === 'downloaded').length;
  const failed = batch.prompts.filter((prompt) => prompt.status === 'failed').length;
  const pending = batch.prompts.length - completed - failed;
  const settled = completed + failed;
  return {
    total: batch.prompts.length,
    completed,
    failed,
    pending,
    progress: batch.prompts.length === 0 ? 0 : Math.round((settled / batch.prompts.length) * 100),
  };
}

function finishUsage(batch: BatchState, pod: PodState): UsageRun {
  const counts = batchCounts(batch);
  return {
    id: `usage-${batch.id}`,
    name: batch.name,
    date: batch.startedAt,
    gpu: pod.gpu ?? 'RTX 4090',
    completed: counts.completed,
    failed: counts.failed,
    seconds: batch.elapsedSeconds,
    cost: batch.estimatedCost,
  };
}

function reduceBatchTick(state: AppState): AppState {
  const batch = state.batch;
  if (!batch || batch.phase !== 'running') return state;

  const prompts = batch.prompts.map((prompt) => ({ ...prompt }));
  const activeIndex = prompts.findIndex((prompt) => prompt.status === 'generating' || prompt.status === 'retrying');
  let newAsset: LibraryAsset | null = null;

  if (activeIndex >= 0) {
    const active = prompts[activeIndex];
    const deterministicFailure = active.index % 19 === 0 && active.attempts === 0;
    if (deterministicFailure) {
      prompts[activeIndex] = {
        ...active,
        status: 'failed',
        failureReason: 'Preview checksum did not match after two transfer attempts.',
        durationSeconds: 9.8,
      };
    } else {
      prompts[activeIndex] = completedPrompt(active);
    }
  }

  const nextIndex = prompts.findIndex((prompt) => prompt.status === 'pending');
  if (nextIndex >= 0) prompts[nextIndex] = { ...prompts[nextIndex], status: 'generating' };

  const elapsedSeconds = batch.elapsedSeconds + batch.estimatedSecondsPerImage;
  const hourlyRate = state.pod.hourlyRate ?? 0.54;
  let nextBatch: BatchState = {
    ...batch,
    prompts,
    elapsedSeconds,
    estimatedCost: (elapsedSeconds / 3600) * hourlyRate,
    statusMessage:
      nextIndex >= 0
        ? `Generating image ${String(prompts[nextIndex].index).padStart(3, '0')} of ${String(prompts.length).padStart(3, '0')}`
        : 'Finalizing manifest and verified downloads',
  };

  if (activeIndex >= 0 && prompts[activeIndex].status === 'downloaded') {
    newAsset = assetFromPrompt(nextBatch, prompts[activeIndex]);
  }

  if (nextIndex < 0) {
    const counts = batchCounts(nextBatch);
    nextBatch = {
      ...nextBatch,
      phase: counts.failed > 0 ? 'partial_failure' : 'complete',
      statusMessage:
        counts.failed > 0
          ? `${counts.completed} downloaded · ${counts.failed} need attention`
          : `${counts.completed} images verified in order`,
    };
    const nextUsage = finishUsage(nextBatch, state.pod);
    return {
      ...state,
      batch: nextBatch,
      library: newAsset ? upsertLibraryAsset(state.library, newAsset) : state.library,
      usage: [nextUsage, ...state.usage.filter((run) => run.id !== nextUsage.id)],
      ...toast(
        state,
        counts.failed > 0 ? 'warning' : 'success',
        counts.failed > 0 ? 'Batch needs a quick review' : 'Batch complete',
        nextBatch.statusMessage,
      ),
    };
  }

  return {
    ...state,
    batch: nextBatch,
    library: newAsset ? upsertLibraryAsset(state.library, newAsset) : state.library,
  };
}

function scenarioState(state: AppState, scenario: OperationalScenario): AppState {
  const baseBatch = buildDemoBatch(scenario === 'partial_failure' ? 'partial_failure' : scenario === 'complete' ? 'complete' : scenario === 'locked' ? 'locked' : scenario === 'paused' ? 'paused' : scenario === 'error' ? 'error' : 'running');
  let pod = readyPod();
  let batch: BatchState | null = baseBatch;

  if (scenario === 'offline') {
    pod = emptyPod();
    batch = null;
  } else if (scenario === 'provisioning') {
    pod = podDetails('provisioning', 28, 'Creating one RTX 4090 Pod', emptyPod());
    batch = null;
  } else if (scenario === 'loading') {
    pod = podDetails('loading', 66, 'Loading FLUX.2 Klein 4B · BF16', readyPod());
    batch = null;
  } else if (scenario === 'warming') {
    pod = podDetails('warming', 86, 'Warming inference graph · step 3 of 4', readyPod());
    batch = null;
  } else if (scenario === 'ready') {
    batch = null;
  } else if (scenario === 'reconnecting') {
    pod = podDetails('reconnecting', 44, 'Worker missed two health checks · reconnecting', readyPod());
  } else if (scenario === 'locked') {
    batch = {
      ...baseBatch,
      owner: 'Sujal',
      lockMessage: 'Sujal is generating 9 of 24 images. ImageForge never creates a hidden queue.',
      statusMessage: 'Locked by Sujal · 9 of 24 complete',
    };
  } else if (scenario === 'duplicate_pods') {
    pod = {
      ...readyPod(),
      matchingPodIds: ['pod-if-7K2M', 'pod-if-9Q8R'],
      statusDetail: 'Two matching ImageForge Pods found · manual review required',
    };
    batch = null;
  } else if (scenario === 'paused') {
    batch = { ...baseBatch, statusMessage: 'Paused safely after image 009' };
  } else if (scenario === 'partial_failure') {
    const settled = baseBatch.prompts.map((prompt, index) => {
      if (index === 5 || index === 18) {
        return { ...prompt, status: 'failed' as const, failureReason: 'Transfer checksum mismatch.', attempts: 2 };
      }
      return completedPrompt(prompt);
    });
    batch = {
      ...baseBatch,
      prompts: settled,
      statusMessage: '22 downloaded · 2 need attention',
    };
  } else if (scenario === 'complete') {
    const settled = baseBatch.prompts.map(completedPrompt);
    batch = { ...baseBatch, prompts: settled, statusMessage: '24 images verified in order' };
  } else if (scenario === 'error') {
    pod = podDetails('error', 0, 'Worker authentication failed. Check the worker secret.', readyPod());
    batch = { ...baseBatch, statusMessage: 'Generation stopped safely · no files lost' };
  }

  const library = batch
    ? batch.prompts.filter((prompt) => prompt.status === 'downloaded').map((prompt) => assetFromPrompt(batch as BatchState, prompt))
    : state.library;
  return {
    ...state,
    activeView: scenario === 'ready' || scenario === 'offline' ? 'create' : scenario === 'duplicate_pods' ? 'settings' : 'progress',
    pod,
    batch,
    library,
    dialog: null,
    ...toast(state, 'info', 'Simulation state loaded', `${scenario.replace('_', ' ')} is now visible across the shell.`),
  };
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'NAVIGATE':
      return { ...state, activeView: action.view };
    case 'SET_PROMPT_TEXT': {
      const parsed = parsePromptText(action.text, action.sourceName ?? state.draft.sourceName);
      return {
        ...state,
        draft: {
          ...state.draft,
          rawText: action.text,
          sourceName: action.sourceName === undefined ? state.draft.sourceName : action.sourceName,
          prompts: parsed.prompts,
          issues: parsed.issues,
        },
      };
    }
    case 'SET_BATCH_NAME':
      return { ...state, draft: { ...state.draft, name: action.name } };
    case 'LOAD_SAMPLE': {
      const parsed = parsePromptText(SAMPLE_PROMPTS);
      return {
        ...state,
        draft: {
          ...state.draft,
          name: 'Atlas of Quiet Work',
          rawText: SAMPLE_PROMPTS,
          sourceName: 'atlas-prompts.txt',
          prompts: parsed.prompts,
          issues: parsed.issues,
        },
        ...toast(state, 'success', 'Sample brief loaded', `${parsed.prompts.length} ordered prompts are ready to review.`),
      };
    }
    case 'NEW_BATCH':
      if (state.batch && ['running', 'paused', 'validating', 'locked'].includes(state.batch.phase)) return state;
      return {
        ...state,
        activeView: 'create',
        batch: null,
        draft: { ...emptyDraft(), destination: state.settings.defaultDestination },
        ...toast(state, 'info', 'New production brief', 'Previous downloads remain in Library.'),
      };
    case 'SET_DESTINATION':
      return {
        ...state,
        draft: { ...state.draft, destination: action.path },
        ...toast(state, 'success', 'Destination connected', `Verified write access to ${action.path}`),
      };
    case 'START_POD':
      if (!['offline', 'error'].includes(state.pod.phase)) return state;
      return {
        ...state,
        pod: podDetails('selecting', 4, 'Checking live RTX 4090 and RTX 5090 inventory', state.pod),
        ...toast(state, 'info', 'Finding the best available GPU', 'Live inventory and measured cost per image are being compared.'),
      };
    case 'SET_POD_PHASE':
      return {
        ...state,
        pod: {
          ...podDetails(action.phase, action.progress, action.detail, state.pod),
          ...(action.podId
            ? { podId: action.podId, matchingPodIds: [action.podId] }
            : {}),
        },
        ...(action.phase === 'ready'
          ? toast(state, 'success', 'GPU ready', 'FLUX.2 Klein 4B is warm and ready for one batch.')
          : {}),
      };
    case 'REQUEST_STOP_POD':
      return { ...state, dialog: { type: 'stop-pod' } };
    case 'CONFIRM_STOP_POD':
      return {
        ...state,
        dialog: null,
        pod: podDetails('stopping', 72, 'Terminating compute after your confirmation', state.pod),
      };
    case 'POD_STOPPED': {
      const interrupted = state.batch && ['running', 'paused', 'validating'].includes(state.batch.phase);
      return {
        ...state,
        pod: emptyPod(),
        batch: interrupted
          ? { ...state.batch!, phase: 'interrupted', statusMessage: 'Interrupted manifest saved · ready to resume' }
          : state.batch,
        ...toast(state, 'success', 'GPU stopped', 'Compute was terminated explicitly. Local files are unchanged.'),
      };
    }
    case 'REFRESH_STATUS':
      return {
        ...state,
        refreshedAt: action.checkedAt,
        pod: { ...state.pod, lastCheckedAt: action.checkedAt },
        ...toast(state, 'info', 'Status refreshed', 'Worker health and download receipts are up to date.'),
      };
    case 'START_BATCH': {
      if (!canStartBatch(state)) {
        return {
          ...state,
          ...toast(state, 'warning', 'Batch is not ready', 'Resolve the highlighted requirements before starting.'),
        };
      }
      const prompts: BatchPrompt[] = state.draft.prompts.map((prompt) => ({
        ...prompt,
        status: 'pending',
        attempts: 0,
      }));
      return {
        ...state,
        activeView: 'progress',
        batch: {
          id: `batch-${action.startedAt.slice(0, 10).replaceAll('-', '')}-${String(prompts.length).padStart(3, '0')}`,
          name: state.draft.name.trim() || 'Untitled batch',
          owner: state.settings.userName,
          phase: 'validating',
          prompts,
          destination: state.draft.destination!,
          startedAt: action.startedAt,
          elapsedSeconds: 0,
          estimatedSecondsPerImage: 8.4,
          estimatedCost: 0,
          lockMessage: null,
          statusMessage: `Validating ${prompts.length} prompts and destination receipts`,
        },
        toast: null,
      };
    }
    case 'BATCH_VALIDATED': {
      if (!state.batch || state.batch.phase !== 'validating') return state;
      const prompts = state.batch.prompts.map((prompt, index) => ({
        ...prompt,
        status: index === 0 ? ('generating' as const) : prompt.status,
      }));
      return {
        ...state,
        batch: {
          ...state.batch,
          phase: 'running',
          prompts,
          statusMessage: `Generating image 001 of ${String(prompts.length).padStart(3, '0')}`,
        },
        ...toast(state, 'success', 'Batch started', 'Images will be verified and downloaded in prompt order.'),
      };
    }
    case 'BATCH_TICK':
      return reduceBatchTick(state);
    case 'TOGGLE_BATCH_PAUSE': {
      if (!state.batch || !['running', 'paused'].includes(state.batch.phase)) return state;
      const isPausing = state.batch.phase === 'running';
      return {
        ...state,
        batch: {
          ...state.batch,
          phase: isPausing ? 'paused' : 'running',
          statusMessage: isPausing ? 'Paused safely · active manifest lock retained' : 'Resuming from the first incomplete prompt',
        },
        ...toast(
          state,
          'info',
          isPausing ? 'Batch paused' : 'Batch resumed',
          isPausing ? 'The batch lock remains yours.' : 'Ordered generation is continuing.',
        ),
      };
    }
    case 'REQUEST_CANCEL_BATCH':
      return { ...state, dialog: { type: 'cancel-batch' } };
    case 'CONFIRM_CANCEL_BATCH':
      if (!state.batch) return { ...state, dialog: null };
      return {
        ...state,
        dialog: null,
        batch: { ...state.batch, phase: 'cancelled', statusMessage: 'Cancelled · completed downloads were kept' },
        ...toast(state, 'warning', 'Batch cancelled', 'Completed images remain in the destination and library.'),
      };
    case 'RETRY_FAILED': {
      if (!state.batch || state.batch.phase !== 'partial_failure') return state;
      let found = false;
      const prompts = state.batch.prompts.map((prompt) => {
        if (prompt.status !== 'failed') return prompt;
        const status = found ? ('pending' as const) : ('generating' as const);
        found = true;
        return { ...prompt, status, attempts: prompt.attempts + 1, failureReason: undefined };
      });
      return {
        ...state,
        batch: { ...state.batch, phase: 'running', prompts, statusMessage: 'Retrying failed images in original order' },
        ...toast(state, 'info', 'Retry started', 'Only failed slots will regenerate; existing files stay untouched.'),
      };
    }
    case 'DISMISS_DIALOG':
      return { ...state, dialog: null };
    case 'DISMISS_TOAST':
      return { ...state, toast: null };
    case 'SET_SETTING':
      return { ...state, settings: { ...state.settings, [action.key]: action.value } as SettingsState };
    case 'SAVE_SETTINGS':
      return {
        ...state,
        draft: {
          ...state.draft,
          destination: state.draft.destination ?? state.settings.defaultDestination,
        },
        ...toast(state, 'success', 'Preferences saved', 'Defaults apply to the next batch on this device.'),
      };
    case 'PREVIEW_SCENARIO':
      return scenarioState(state, action.scenario);
    case 'RESET_WORKSPACE': {
      const reset = createInitialState();
      return {
        ...reset,
        settings: state.settings,
        ...toast(state, 'info', 'Workspace reset', 'You are back to an offline, empty production desk.'),
      };
    }
    case 'REQUEST_CLEAR_LIBRARY':
      return { ...state, dialog: { type: 'clear-library' } };
    case 'CLEAR_LIBRARY':
      return {
        ...state,
        library: [],
        dialog: null,
        ...toast(state, 'success', 'Library index cleared', 'Local source files were not deleted.'),
      };
    case 'SHOW_TOAST':
      return { ...state, ...toast(state, action.tone, action.title, action.message) };
    default:
      return state;
  }
}
