import { parsePromptText, SAMPLE_PROMPTS } from './prompts';
import { MAX_BATCH_REFERENCES } from './references';
import { DEFAULT_ASPECT_RATIO } from './aspectRatio';
import { createInitialQueueUiState, queueRunIsActive } from './queue';
import { DEFAULT_STUDIO_PROFILE, emptyCredentialMetadata } from '../adapters/imageForgeAdapter';
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
  StudioSyncState,
  ToastState,
  UsageRun,
} from './types';

const DEMO_STARTED_AT = '2026-08-01T08:30:00.000Z';

export function defaultDestinationForPlatform(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  if (/windows/i.test(userAgent)) return 'C:\\Users\\Editor\\Pictures\\ImageForge';
  if (/(macintosh|mac os)/i.test(userAgent)) return '/Users/Shared/Pictures/ImageForge';
  return '/home/editor/Pictures/ImageForge';
}

export const DEFAULT_SETTINGS: SettingsState = {
  userName: '',
  defaultDestination: defaultDestinationForPlatform(),
  editorialSuffixEnabled: false,
  editorialSuffix: 'Editorial realism, natural light, honest texture, restrained color, no text or logos.',
  theme: 'midnight',
  density: 'comfortable',
  simulationSpeed: 1,
  gpuPreference: 'best_value',
  slowEmergencyGpuEnabled: false,
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
    lifecycleSequence: 0,
    createRecovery: null,
    stopTargetPodId: null,
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
    lifecycleSequence: 0,
    createRecovery: null,
    stopTargetPodId: null,
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
    references: [],
    aspectRatio: DEFAULT_ASPECT_RATIO,
    queueReplacementId: null,
  };
}

function emptyStudio(): StudioSyncState {
  return {
    connected: false,
    serverInstanceId: null,
    coordinationRevision: 0,
    currentSession: null,
    sessions: [],
    stop: {
      phase: 'idle',
      requestId: null,
      podId: null,
      gpuDisplayName: null,
      requester: null,
      isRequester: false,
      canRespond: false,
      waitingFor: [],
      approvedBy: [],
      deniedBy: [],
      responseDeadline: null,
      finalizationExpiresAt: null,
      finalizationId: null,
      reason: null,
      message: null,
      retryable: false,
      blockedByBatch: null,
    },
    gpuSwitch: null,
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
    setup: {
      completed: false,
      studioProfile: DEFAULT_STUDIO_PROFILE,
      destinationValidated: false,
      credentials: emptyCredentialMetadata(),
    },
    dialog: null,
    toast: null,
    toastSequence: 0,
    refreshedAt: null,
    localSyncIssue: null,
    studio: emptyStudio(),
    queue: createInitialQueueUiState(),
  };
}

export function createConfiguredInitialState(): AppState {
  const state = createInitialState();
  const provider = state.setup.credentials.runpodApiKey.provider;
  return {
    ...state,
    settings: { ...state.settings, userName: 'Lakshman' },
    setup: {
      ...state.setup,
      completed: true,
      destinationValidated: true,
      credentials: {
        runpodApiKey: { configured: true, suffix: 'K7P9', provider },
        workerToken: { configured: true, suffix: 'F2M4', provider },
      },
    },
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
  let value = (seed ^ Math.imul(index, 0x9e3779b1)) >>> 0;
  return Array.from({ length: 8 }, (_, block) => {
    value = Math.imul(value ^ (block + 1) * 0x45d9f3b, 0x27d4eb2d) >>> 0;
    value = (value ^ (value >>> 15)) >>> 0;
    return value.toString(16).padStart(8, '0');
  }).join('');
}

function readyPrompt(prompt: BatchPrompt): BatchPrompt {
  const durationSeconds = 7.2 + ((prompt.index * 13) % 18) / 10;
  return {
    ...prompt,
    status: 'ready',
    filename: `${String(prompt.index).padStart(4, '0')}.jpg`,
    checksum: checksumFor(prompt.index, prompt.seed),
    durationSeconds,
  };
}

function completedPrompt(prompt: BatchPrompt): BatchPrompt {
  return { ...readyPrompt(prompt), status: 'downloaded' };
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

function mergeLibraryAssets(library: LibraryAsset[], assets: readonly LibraryAsset[]): LibraryAsset[] {
  if (assets.length === 0) return library;
  const byId = new Map(library.map((asset) => [asset.id, asset] as const));
  for (const asset of assets) byId.set(asset.id, asset);
  return [...byId.values()].sort((left, right) => {
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
    canManage: true,
    phase,
    prompts,
    destination: defaultDestinationForPlatform(),
    startedAt: DEMO_STARTED_AT,
    elapsedSeconds: 78,
    estimatedSecondsPerImage: 8.4,
    estimatedCost: 0.012,
    lockMessage: null,
    statusMessage: phase === 'paused' ? 'Paused after image 009' : 'Generating image 010 of 024',
    aspectRatio: DEFAULT_ASPECT_RATIO,
  };
}

export function createDemoState(): AppState {
  const batch = buildDemoBatch();
  const provider = emptyCredentialMetadata().runpodApiKey.provider;
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
      destination: defaultDestinationForPlatform(),
      references: [],
      aspectRatio: batch.aspectRatio,
      queueReplacementId: null,
    },
    settings: { ...DEFAULT_SETTINGS, userName: 'Lakshman' },
    setup: {
      completed: true,
      studioProfile: DEFAULT_STUDIO_PROFILE,
      destinationValidated: true,
      credentials: {
        runpodApiKey: { configured: true, suffix: 'K7P9', provider },
        workerToken: { configured: true, suffix: 'F2M4', provider },
      },
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
  action?: ToastState['action'],
): Pick<AppState, 'toast' | 'toastSequence'> {
  const id = state.toastSequence + 1;
  return { toastSequence: id, toast: { id, tone, title, message, ...(action ? { action } : {}) } };
}

function podDetails(
  phase: PodPhase,
  progress: number,
  detail: string,
  current: PodState,
  hardware?: { gpu?: string; vram?: string; hourlyRate?: number },
): PodState {
  const isReady = phase === 'ready';
  const isOffline = phase === 'offline';
  const isError = phase === 'error';
  return {
    ...current,
    phase,
    phaseProgress: progress,
    statusDetail: detail,
    gpu: isOffline ? null : hardware?.gpu ?? current.gpu ?? (isReady ? 'RTX 4090' : null),
    vram: isOffline ? null : hardware?.vram ?? current.vram ?? (isReady ? '24 GB' : null),
    hourlyRate: isOffline ? null : hardware?.hourlyRate ?? current.hourlyRate ?? (isReady ? 0.54 : null),
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
    state.setup.completed &&
    state.pod.phase === 'ready' &&
    state.batch === null &&
    state.draft.prompts.length > 0 &&
    state.draft.destination !== null &&
    state.studio.stop.phase !== 'finalizing' &&
    !queueRunIsActive(state.queue.document) &&
    !hasDraftErrors(state)
  );
}

export function batchCounts(batch: BatchState | null) {
  if (!batch) return { total: 0, completed: 0, failed: 0, pending: 0, progress: 0 };
  if (batch.reportedProgress && (batch.phase === 'locked' || batch.prompts.length === 0)) {
    const { total, completed, failed, cancelled } = batch.reportedProgress;
    const settled = completed + failed + cancelled;
    return {
      total,
      completed,
      failed,
      pending: Math.max(0, total - settled),
      progress: total === 0 ? 0 : Math.round((settled / total) * 100),
    };
  }
  const completed = batch.prompts.filter((prompt) => prompt.status === 'downloaded').length;
  const failed = batch.prompts.filter((prompt) => prompt.status === 'failed').length;
  const cancelled = batch.prompts.filter((prompt) => prompt.status === 'cancelled').length;
  const pending = batch.prompts.length - completed - failed - cancelled;
  const settled = completed + failed + cancelled;
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
  const activeIndex = prompts.findIndex((prompt) =>
    ['generating', 'retrying', 'ready', 'downloading'].includes(prompt.status),
  );
  const activeStatus = activeIndex >= 0 ? prompts[activeIndex].status : null;
  let newAsset: LibraryAsset | null = null;

  if (activeIndex >= 0) {
    const active = prompts[activeIndex];
    if (active.status === 'generating' || active.status === 'retrying') {
      const deterministicFailure = active.index % 19 === 0 && active.attempts <= 3;
      if (deterministicFailure && active.attempts < 3) {
        prompts[activeIndex] = {
          ...active,
          status: 'retrying',
          attempts: active.attempts + 1,
          failureReason: `Automatic generation retry ${active.attempts + 1} of 3`,
        };
      } else if (deterministicFailure) {
        prompts[activeIndex] = {
          ...active,
          status: 'failed',
          failureReason: 'Generation failed after the initial attempt and two automatic retries.',
          durationSeconds: 9.8,
        };
      } else {
        prompts[activeIndex] = readyPrompt(active);
      }
    } else if (active.status === 'ready') {
      prompts[activeIndex] = { ...active, status: 'downloading' };
    } else if (active.status === 'downloading') {
      prompts[activeIndex] = { ...active, status: 'downloaded' };
      newAsset = assetFromPrompt(batch, prompts[activeIndex]);
    }
  }

  const stillActive = prompts.some((prompt) =>
    ['generating', 'retrying', 'ready', 'downloading'].includes(prompt.status),
  );
  const nextIndex = stillActive ? -1 : prompts.findIndex((prompt) => prompt.status === 'pending');
  if (nextIndex >= 0) {
    prompts[nextIndex] = {
      ...prompts[nextIndex],
      status: 'generating',
      attempts: prompts[nextIndex].attempts || 1,
      failureReason: undefined,
    };
  }

  const elapsedSeconds = batch.elapsedSeconds + (
    activeStatus === 'generating' || activeStatus === 'retrying' ? batch.estimatedSecondsPerImage : activeStatus ? 0.2 : 0
  );
  const hourlyRate = state.pod.hourlyRate ?? 0.54;
  const activePrompt = nextIndex >= 0
    ? prompts[nextIndex]
    : prompts.find((prompt) => ['generating', 'retrying', 'ready', 'downloading'].includes(prompt.status));
  let nextBatch: BatchState = {
    ...batch,
    prompts,
    elapsedSeconds,
    estimatedCost: (elapsedSeconds / 3600) * hourlyRate,
    statusMessage: activePrompt
      ? `${activePrompt.status === 'ready' ? 'Verifying' : activePrompt.status === 'downloading' ? 'Downloading' : activePrompt.status === 'retrying' ? 'Retrying' : 'Generating'} image ${String(activePrompt.index).padStart(3, '0')} of ${String(prompts.length).padStart(3, '0')}`
      : 'Saving the last images',
  };

  if (!activePrompt && nextIndex < 0) {
    const counts = batchCounts(nextBatch);
    nextBatch = {
      ...nextBatch,
      phase: counts.failed > 0 ? 'partial_failure' : 'complete',
      statusMessage:
        counts.failed > 0
          ? `${counts.completed} downloaded · ${counts.failed} need attention`
          : `${counts.completed} images saved`,
    };
    const nextUsage = finishUsage(nextBatch, state.pod);
    return {
      ...state,
      batch: nextBatch,
      library: newAsset ? mergeLibraryAssets(state.library, [newAsset]) : state.library,
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
    library: newAsset ? mergeLibraryAssets(state.library, [newAsset]) : state.library,
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
      canManage: false,
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
    batch = { ...baseBatch, prompts: settled, statusMessage: '24 images saved' };
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
        ...toast(state, 'success', 'Output folder ready', `${action.path} is writable.`),
      };
    case 'ADD_REFERENCE':
      if (state.draft.references.length >= MAX_BATCH_REFERENCES || state.draft.references.some((reference) => reference.id === action.reference.id)) return state;
      return { ...state, draft: { ...state.draft, references: [...state.draft.references, action.reference] } };
    case 'REMOVE_REFERENCE':
      return {
        ...state,
        draft: { ...state.draft, references: state.draft.references.filter((reference) => reference.id !== action.id) },
      };
    case 'SET_ASPECT_RATIO':
      if (state.batch && ['running', 'paused', 'validating', 'locked'].includes(state.batch.phase)) return state;
      return { ...state, draft: { ...state.draft, aspectRatio: action.aspectRatio } };
    case 'QUEUE_LOADED':
    case 'QUEUE_COMMITTED':
      return {
        ...state,
        queue: {
          ...state.queue,
          ...action.snapshot,
          loadState: 'ready',
        },
      };
    case 'QUEUE_LOAD_FAILED':
      return {
        ...state,
        queue: {
          ...state.queue,
          loadState: 'error',
          issues: [{ code: action.code, queueItemId: null, retryable: false }],
        },
        ...toast(state, 'error', 'Local queue needs attention', 'ImageForge could not safely load the device queue. No queued work was started.'),
      };
    case 'QUEUE_LEASE_CHANGED':
      return { ...state, queue: { ...state.queue, lease: action.lease } };
    case 'QUEUE_POWER_CHANGED':
      return { ...state, queue: { ...state.queue, power: action.power } };
    case 'QUEUE_ALARM_TEST_STATE':
      return { ...state, queue: { ...state.queue, alarmTest: action.state } };
    case 'QUEUE_NOTIFICATION_PERMISSION':
      return { ...state, queue: { ...state.queue, notificationPermission: action.permission } };
    case 'SET_QUEUE_KEEP_AWAKE':
      return { ...state, queue: { ...state.queue, keepAwakePreference: action.enabled } };
    case 'QUEUE_DISPATCH_ITEM': {
      const payload = action.payload;
      const prompts: BatchPrompt[] = payload.prompts.map((text, index) => ({
        id: `queue-prompt-${payload.queueItemId}-${index + 1}`,
        index: index + 1,
        sourceLine: index + 1,
        text,
        seed: payload.baseSeed + index,
        issues: [],
        status: 'pending',
        attempts: 0,
      }));
      return {
        ...state,
        activeView: 'progress',
        batch: {
          // The deterministic fake uses the canonical submission UUID as its
          // stand-in remote batch UUID so queue state obeys the same wire
          // invariants as production.
          id: payload.clientSubmissionId,
          name: payload.name,
          owner: state.settings.userName,
          canManage: true,
          phase: 'validating',
          prompts,
          destination: payload.destination,
          startedAt: action.startedAt,
          elapsedSeconds: 0,
          estimatedSecondsPerImage: 8.4,
          estimatedCost: 0,
          lockMessage: null,
          statusMessage: `Checking queued batch ${payload.name}`,
          references: payload.references.map((reference) => ({
            id: reference.id,
            name: reference.name,
            mimeType: reference.mimeType,
            sizeBytes: reference.sizeBytes,
            bytes: reference.bytes,
          })),
          aspectRatio: payload.aspectRatio,
          queueItemId: payload.queueItemId,
          clientSubmissionId: payload.clientSubmissionId,
          admissionMode: 'queue',
        },
        toast: null,
      };
    }
    case 'QUEUE_RELEASE_BATCH':
      return state.batch?.queueItemId
        ? { ...state, batch: null, activeView: 'create', localSyncIssue: null }
        : state;
    case 'RESTORE_QUEUE_ITEM_TO_DRAFT': {
      const suffix = action.styleSuffix;
      const sourcePrompts = action.payload.prompts.map((prompt) => (
        suffix !== null && prompt.endsWith(` ${suffix}`)
          ? prompt.slice(0, -(suffix.length + 1))
          : prompt
      ));
      const rawText = sourcePrompts.join('\n');
      const parsed = parsePromptText(rawText);
      return {
        ...state,
        activeView: 'create',
        settings: {
          ...state.settings,
          editorialSuffixEnabled: suffix !== null,
          ...(suffix === null ? {} : { editorialSuffix: suffix }),
        },
        draft: {
          name: action.payload.name,
          rawText,
          sourceName: null,
          prompts: parsed.prompts,
          issues: parsed.issues,
          destination: action.payload.destination,
          references: action.payload.references.map((reference) => ({
            id: reference.id,
            name: reference.name,
            mimeType: reference.mimeType,
            sizeBytes: reference.sizeBytes,
            bytes: reference.bytes,
          })),
          aspectRatio: action.payload.aspectRatio,
          queueReplacementId: action.payload.queueItemId,
        },
        ...toast(state, 'info', 'Editing staged batch', 'Save it back to the queue to create fresh item and submission IDs.'),
      };
    }
    case 'STAGE_DRAFT':
    case 'RUN_QUEUE':
    case 'RESUME_QUEUE':
    case 'PAUSE_QUEUE':
    case 'MOVE_QUEUE_ITEM':
    case 'REMOVE_QUEUE_ITEM':
    case 'EDIT_QUEUE_ITEM':
    case 'TEST_QUEUE_ALARM':
    case 'CONFIRM_QUEUE_ALARM':
    case 'SNOOZE_QUEUE_ALARM':
    case 'DISMISS_QUEUE_ALARM':
    case 'RING_QUEUE_ALARM':
    case 'CLEAR_QUEUE_COMPLETED':
    case 'CLEAR_QUEUE_HISTORY':
    case 'CONFIRM_RESET_QUEUE':
      return state;
    case 'REQUEST_RESET_QUEUE':
      return state.queue.loadState === 'error'
        && state.queue.issues.some((issue) => issue.code === 'queue_store_unrecoverable')
        ? { ...state, dialog: { type: 'reset-queue' } }
        : state;
    case 'START_POD':
      if (state.pod.createRecovery) {
        return {
          ...state,
          ...toast(state, 'warning', 'Resolve the interrupted start first', 'ImageForge will not risk creating a duplicate billed Pod.'),
        };
      }
      if (!['offline', 'error'].includes(state.pod.phase)) return state;
      return {
        ...state,
        pod: {
          ...podDetails(
            'selecting',
            4,
            `Checking seven ordinary EU-RO-1 GPUs${state.settings.slowEmergencyGpuEnabled ? ' plus RTX 2000 Ada as a slow emergency fallback' : ''}`,
            state.pod,
          ),
          lifecycleSequence: state.pod.lifecycleSequence + 1,
        },
        ...toast(state, 'info', 'Finding the best available GPU', 'Live inventory and measured cost per image are being compared.'),
      };
    case 'SET_POD_PHASE':
      return {
        ...state,
        pod: {
          ...podDetails(action.phase, action.progress, action.detail, state.pod, action),
          ...(action.podId
            ? { podId: action.podId, matchingPodIds: [action.podId] }
            : {}),
        },
        ...(action.phase === 'ready'
          ? toast(state, 'success', 'GPU ready', 'FLUX.2 Klein 4B is warm and ready for one batch.')
          : {}),
      };
    case 'SYNC_RUNTIME_POD': {
      const settledStop = action.pod.phase === 'offline'
        && state.pod.podId !== null
        && state.studio.stop.podId === state.pod.podId
        && ['checking', 'pending', 'approved', 'finalizing'].includes(state.studio.stop.phase);
      return {
        ...state,
        pod: state.pod.phase === 'stopping' && state.pod.stopTargetPodId !== null && action.pod.podId === state.pod.stopTargetPodId
          ? {
              ...action.pod,
              phase: 'stopping',
              podId: state.pod.podId,
              stopTargetPodId: state.pod.stopTargetPodId,
              statusDetail: 'Terminating the confirmed ImageForge Pod',
              lifecycleSequence: state.pod.lifecycleSequence,
            }
          : { ...action.pod, stopTargetPodId: null, lifecycleSequence: state.pod.lifecycleSequence },
        ...(
          action.pod.phase === 'offline' &&
          state.batch &&
          ['running', 'paused', 'validating', 'locked'].includes(state.batch.phase)
            ? {
                batch: {
                  ...state.batch,
                  phase: 'interrupted' as const,
                  prompts: state.batch.prompts.map((prompt) =>
                    ['generating', 'retrying', 'ready', 'downloading'].includes(prompt.status)
                      ? { ...prompt, status: 'pending' as const, failureReason: undefined }
                      : prompt,
                  ),
                  statusMessage: state.batch.phase === 'locked'
                    ? `${state.batch.owner}’s batch is offline · only its owner can resume or cancel`
                    : 'Generation interrupted · restart a GPU to resume or cancel',
                  ...(state.batch.phase === 'locked'
                    ? {
                        canManage: false,
                        remoteState: 'interrupted' as const,
                        lockMessage: 'The shared GPU stopped while this remote batch was active.',
                      }
                    : {}),
                },
              }
            : {}
        ),
        ...(settledStop
          ? {
              studio: {
                ...state.studio,
                stop: {
                  ...state.studio.stop,
                  phase: 'stopped' as const,
                  finalizationExpiresAt: null,
                  finalizationId: null,
                  message: 'The exact coordinated GPU is now offline. No further stop action is pending.',
                  retryable: false,
                },
              },
            }
          : {}),
      };
    }
    case 'SYNC_CREATE_RECOVERY':
      return {
        ...state,
        pod: { ...state.pod, createRecovery: action.marker },
        ...(action.marker
          ? toast(
              state,
              'warning',
              'GPU start needs reconciliation',
              'No additional GPU can start until the interrupted RunPod create is resolved.',
            )
          : {}),
      };
    case 'REQUEST_STOP_POD':
      return state.pod.podId === null
        ? state
        : { ...state, dialog: { type: 'stop-pod', podId: state.pod.podId } };
    case 'REQUEST_RESOLVE_CREATE':
      return state.pod.createRecovery
        ? { ...state, dialog: { type: 'resolve-create' } }
        : state;
    case 'CONFIRM_RESOLVE_CREATE':
      return { ...state, dialog: null };
    case 'CONFIRM_STOP_POD':
      if (state.dialog?.type !== 'stop-pod' || state.dialog.podId !== state.pod.podId || state.pod.podId === null) {
        return {
          ...state,
          dialog: null,
          ...toast(state, 'error', 'Stop confirmation expired', 'The selected Pod changed. Refresh status and confirm the exact current Pod again.'),
        };
      }
      return {
        ...state,
        dialog: null,
        pod: {
          ...podDetails('stopping', 72, 'Terminating compute after your confirmation', state.pod),
          stopTargetPodId: state.dialog.podId,
        },
      };
    case 'POD_STOPPED': {
      const interrupted = state.batch && ['running', 'paused', 'validating'].includes(state.batch.phase);
      return {
        ...state,
        pod: emptyPod(),
        batch: interrupted
          ? {
              ...state.batch!,
              phase: 'interrupted',
              prompts: state.batch!.prompts.map((prompt) =>
                ['generating', 'retrying', 'ready', 'downloading'].includes(prompt.status)
                  ? { ...prompt, status: 'pending' as const, failureReason: undefined }
                  : prompt,
              ),
              statusMessage: 'Generation interrupted · restart a GPU to resume or cancel',
            }
          : state.batch,
        ...toast(state, 'success', 'GPU stopped', 'Compute was terminated explicitly. Local files are unchanged.'),
      };
    }
    case 'REFRESH_STATUS':
      return {
        ...state,
        refreshedAt: action.checkedAt,
        ...toast(state, 'info', 'Checking shared status', 'ImageForge is reading the current GPU and batch state.'),
      };
    case 'START_BATCH': {
      if (!canStartBatch(state)) {
        return {
          ...state,
          ...toast(state, 'warning', 'Batch is not ready', 'Resolve the highlighted requirements before starting.'),
        };
      }
      const suffix = state.settings.editorialSuffixEnabled ? state.settings.editorialSuffix.trim() : '';
      const baseSeed = state.draft.prompts[0]?.seed ?? 100_000;
      const prompts: BatchPrompt[] = state.draft.prompts.map((prompt, index) => ({
        ...prompt,
        text: suffix ? `${prompt.text} ${suffix}` : prompt.text,
        // The worker accepts one base seed and assigns contiguous ordered
        // seeds. Keep the renderer manifest byte-for-byte consistent.
        seed: baseSeed + index,
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
          canManage: true,
          phase: 'validating',
          prompts,
          destination: state.draft.destination!,
          startedAt: action.startedAt,
          elapsedSeconds: 0,
          estimatedSecondsPerImage: 8.4,
          estimatedCost: 0,
          lockMessage: null,
          statusMessage: `Checking ${prompts.length} prompts and output folder`,
          references: state.draft.references,
          aspectRatio: state.draft.aspectRatio,
        },
        toast: null,
      };
    }
    case 'BATCH_VALIDATED': {
      if (!state.batch || state.batch.phase !== 'validating') return state;
      const prompts = state.batch.prompts.map((prompt, index) => ({
        ...prompt,
        status: index === 0 ? ('generating' as const) : prompt.status,
        attempts: index === 0 ? 1 : prompt.attempts,
      }));
      return {
        ...state,
        batch: {
          ...state.batch,
          phase: 'running',
          prompts,
          statusMessage: `Generating image 001 of ${String(prompts.length).padStart(3, '0')}`,
        },
        ...toast(state, 'success', 'Batch started', 'Images will be generated and saved in prompt order.'),
      };
    }
    case 'BATCH_TICK':
      return reduceBatchTick(state);
    case 'SYNC_RUNTIME_BATCH': {
      const library = mergeLibraryAssets(state.library, action.assets);
      const terminal = ['complete', 'partial_failure', 'cancelled'].includes(action.batch.phase);
      const usageId = `usage-${action.batch.id}`;
      const usage = terminal && !state.usage.some((item) => item.id === usageId)
        ? [finishUsage(action.batch, state.pod), ...state.usage]
        : state.usage;
      return {
        ...state,
        pod: state.pod.phase === 'reconnecting'
          ? { ...state.pod, phase: 'ready', health: 'healthy', phaseProgress: 100, errorMessage: null, statusDetail: 'Model ready · batch status synchronized' }
          : state.pod,
        activeView: state.batch?.phase === 'validating' ? 'progress' : state.activeView,
        batch: action.batch,
        studio: state.studio.stop.reason === 'worker_finalization_guard'
          ? { ...state.studio, stop: emptyStudio().stop }
          : state.studio,
        library,
        usage,
        localSyncIssue: state.localSyncIssue?.batchId === action.batch.id ? null : state.localSyncIssue,
      };
    }
    case 'SYNC_RUNTIME_LIBRARY':
      return {
        ...state,
        library: mergeLibraryAssets(state.library, action.assets),
        localSyncIssue: action.assets.some((asset) => asset.batchId === state.localSyncIssue?.batchId)
          ? null
          : state.localSyncIssue,
      };
    case 'SYNC_RUNTIME_BUSY':
      return {
        ...state,
        activeView: 'progress',
        batch: action.batch,
        studio: state.studio.stop.reason === 'worker_finalization_guard'
          ? { ...state.studio, stop: emptyStudio().stop }
          : state.studio,
        ...toast(
          state,
          'warning',
          `${action.batch.owner} is using ImageForge`,
          'This batch is blocked immediately and was not queued.',
        ),
      };
    case 'RUNTIME_BATCH_IDLE': {
      const idleState = state.studio.stop.phase === 'finalizing'
        && state.studio.stop.reason === 'worker_finalization_guard'
        ? { ...state, studio: { ...state.studio, stop: emptyStudio().stop } }
        : state;
      return idleState.batch?.phase === 'locked'
        ? {
            ...idleState,
            pod: idleState.pod.phase === 'reconnecting'
              ? { ...idleState.pod, phase: 'ready', health: 'healthy', phaseProgress: 100, errorMessage: null, statusDetail: 'Model warm · accepting one batch' }
              : idleState.pod,
            activeView: 'create',
            batch: null,
            ...toast(idleState, 'success', 'ImageForge is available', 'The other batch released the shared worker lock.'),
          }
        : idleState.pod.phase === 'reconnecting'
          ? { ...idleState, pod: { ...idleState.pod, phase: 'ready', health: 'healthy', phaseProgress: 100, errorMessage: null, statusDetail: 'Model warm · accepting one batch' } }
          : idleState;
    }
    case 'RUNTIME_STOP_GUARD_ACTIVE':
      return {
        ...state,
        studio: {
          ...state.studio,
          stop: {
            ...emptyStudio().stop,
            phase: 'finalizing',
            podId: action.podId,
            reason: 'worker_finalization_guard',
            message: action.message,
          },
        },
      };
    case 'RUNTIME_LOCAL_ERROR':
      return {
        ...state,
        localSyncIssue: {
          batchId: action.batchId,
          code: action.code,
          message: action.message,
          retryable: action.retryable === true,
        },
        ...toast(
          state,
          'warning',
          'Local files need attention',
          action.message,
          { label: 'Open settings', view: 'settings' },
        ),
      };
    case 'BEGIN_STUDIO_STOP':
      return {
        ...state,
        dialog: null,
        studio: {
          ...state.studio,
          stop: {
            ...emptyStudio().stop,
            phase: 'checking',
            podId: action.podId,
            gpuDisplayName: action.gpuDisplayName,
            isRequester: true,
            message: 'Checking the active batch and other foreground editors.',
          },
        },
      };
    case 'SYNC_STUDIO_STATE': {
      // Worker presence is subordinate to authoritative RunPod lifecycle.
      // A response from the prior pinned worker session may settle after the
      // exact Pod is proven Offline; it cannot revive a stopped request.
      if (state.pod.phase === 'offline') return state;
      const previous = state.studio.stop;
      const next = action.studio.stop;
      const becameDenied = next.phase === 'denied' && previous.phase !== 'denied';
      const becameExpired = next.phase === 'expired' && previous.phase !== 'expired';
      const becameCancelledByGeneration = next.phase === 'cancelled'
        && next.reason === 'generation_started'
        && previous.phase !== 'cancelled';
      return {
        ...state,
        studio: action.studio,
        ...(becameDenied
          ? toast(
              state,
              'warning',
              'GPU stays online',
              `${next.deniedBy.map((peer) => peer.displayName).join(', ') || 'Another editor'} chose to keep the GPU running.`,
            )
          : becameExpired
            ? toast(state, 'warning', 'Stop request expired', 'Not every active editor approved before the response window closed. The GPU is still running.')
            : becameCancelledByGeneration
              ? toast(state, 'info', 'Stop request cancelled', 'Generation started before final authorization, so the GPU stays online.')
              : {}),
      };
    }
    case 'STUDIO_STOP_BLOCKED':
      return {
        ...state,
        dialog: null,
        studio: {
          ...state.studio,
          stop: {
            ...emptyStudio().stop,
            phase: 'blocked',
            isRequester: true,
            message: action.message,
            blockedByBatch: {
              owner: action.owner,
              completed: action.completed,
              total: action.total,
            },
          },
        },
        ...toast(
          state,
          'warning',
          'GPU is protecting an active batch',
          `${action.owner} is at ${action.completed} of ${action.total}. Stop is unavailable until the durable batch lease is released.`,
        ),
      };
    case 'STUDIO_STOP_FAILED':
      return {
        ...state,
        dialog: null,
        studio: {
          ...state.studio,
          stop: {
            ...state.studio.stop,
            phase: 'failed',
            message: action.message,
            retryable: action.retryable === true,
          },
        },
        ...toast(state, 'error', 'GPU stop was not authorized', action.message),
      };
    case 'STUDIO_STOPPED':
      return {
        ...state,
        studio: {
          ...state.studio,
          stop: {
            ...state.studio.stop,
            phase: 'stopped',
            message: action.alreadyStopped
              ? 'The exact confirmed GPU was already absent; no second termination was sent.'
              : 'The exact confirmed GPU was terminated after every required approval.',
            retryable: false,
          },
        },
        ...toast(
          state,
          action.alreadyStopped ? 'info' : 'success',
          action.alreadyStopped ? 'GPU already stopped' : 'GPU stopped',
          action.alreadyStopped
            ? 'Shared status is synchronized and no second termination was sent.'
            : 'Compute was terminated explicitly after coordinated approval. Local files are unchanged.',
        ),
      };
    case 'CLEAR_STUDIO_STOP':
      return {
        ...state,
        studio: { ...state.studio, stop: emptyStudio().stop },
      };
    case 'RESPOND_STUDIO_STOP':
    case 'CANCEL_STUDIO_STOP':
    case 'RESPOND_STUDIO_GPU_SWITCH':
      return state;
    case 'RUNTIME_ERROR':
      {
      const credentialAction = action.scope === 'batch' && action.code === 'authentication_required'
        ? { label: 'Replace worker credential', view: 'settings' as const }
        : undefined;
      return action.scope === 'batch' && action.code === 'gpu_stop_pending'
        ? {
            ...state,
            activeView: state.batch?.phase === 'validating' ? 'create' : state.activeView,
            batch: state.batch?.phase === 'validating' ? null : state.batch,
            ...toast(
              state,
              'warning',
              'GPU stop is finalizing',
              'A single-use deletion guard won the race. No batch was queued; wait for shared GPU status to settle.',
            ),
          }
        : action.scope === 'batch' && action.retryable
        ? {
            ...state,
            pod: {
              ...state.pod,
              phase: 'reconnecting',
              health: 'degraded',
              phaseProgress: 30,
              statusDetail: action.message,
              errorMessage: action.message,
            },
            ...toast(state, 'warning', 'Reconnecting to the GPU', 'Images already saved remain safe.'),
          }
        : action.scope === 'pod'
        ? {
            ...state,
            // A failed or ambiguous lifecycle operation is not completed work.
            // Keep progress empty so the UI cannot imply a successful start.
            pod: podDetails('error', 0, action.message, state.pod),
            ...toast(state, 'error', 'GPU operation needs attention', action.message),
          }
        : {
            ...state,
            batch: state.batch ? { ...state.batch, phase: 'error', statusMessage: action.message } : null,
            ...toast(
              state,
              'error',
              'Batch operation needs attention',
              action.code === 'authentication_required'
                ? 'The saved worker credential was rejected. Replace it with the token configured for this worker.'
                : action.message,
              credentialAction,
            ),
          };
      }
    case 'TOGGLE_BATCH_PAUSE': {
      if (!state.batch || !['running', 'paused'].includes(state.batch.phase)) return state;
      const isPausing = state.batch.phase === 'running';
      return {
        ...state,
        batch: {
          ...state.batch,
          phase: isPausing ? 'paused' : 'running',
          statusMessage: isPausing ? 'Paused safely · this batch remains active' : 'Resuming from the first incomplete prompt',
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
        batch: {
          ...state.batch,
          phase: 'cancelled',
          prompts: state.batch.prompts.map((prompt) =>
            ['generating', 'retrying', 'ready', 'downloading'].includes(prompt.status)
              ? { ...prompt, status: 'cancelled' as const, failureReason: undefined }
              : prompt,
          ),
          statusMessage: 'Cancelled · completed downloads were kept',
        },
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
    case 'RESUME_INTERRUPTED_BATCH': {
      if (
        !state.batch ||
        state.batch.phase !== 'interrupted' ||
        (state.batch.canManage === false || (state.batch.canManage === undefined && state.batch.owner !== state.settings.userName)) ||
        state.pod.phase !== 'ready'
      ) return state;
      let started = false;
      const prompts = state.batch.prompts.map((prompt) => {
        if (started || prompt.status !== 'pending') return prompt;
        started = true;
        return { ...prompt, status: 'generating' as const, attempts: prompt.attempts || 1 };
      });
      return {
        ...state,
        batch: {
          ...state.batch,
          phase: 'running',
          prompts,
          statusMessage: started ? 'Resumed from the first incomplete prompt' : 'Finishing resumed batch',
        },
        ...toast(state, 'success', 'Interrupted batch resumed', 'Saved images were kept; generation continues at the first incomplete prompt.'),
      };
    }
    case 'DISMISS_DIALOG':
      return { ...state, dialog: null };
    case 'DISMISS_TOAST':
      return { ...state, toast: null };
    case 'SET_SETTING':
      return { ...state, settings: { ...state.settings, [action.key]: action.value } as SettingsState };
    case 'SET_STUDIO_PROFILE':
      return { ...state, setup: { ...state.setup, studioProfile: action.profile } };
    case 'SET_DESTINATION_VALIDATED':
      return { ...state, setup: { ...state.setup, destinationValidated: action.validated } };
    case 'SET_CREDENTIAL_METADATA':
      return { ...state, setup: { ...state.setup, credentials: action.credentials } };
    case 'COMPLETE_SETUP':
      return {
        ...state,
        setup: { ...state.setup, completed: true },
        draft: { ...state.draft, destination: state.draft.destination ?? state.settings.defaultDestination },
      };
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
        setup: state.setup,
        queue: state.queue,
        ...toast(state, 'info', 'Workspace reset', 'You are back to an offline, empty workspace.'),
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
