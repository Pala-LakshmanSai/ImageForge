import type { AspectRatio } from './aspectRatio';
import type {
  NativePowerState,
  NativeQueueDispatchPayloadV1,
  NativeQueueSnapshotV1,
  NativeRunnerLease,
  QueueUiState,
} from './queue';

export type ViewId = 'create' | 'progress' | 'library' | 'usage' | 'settings';

export type PodPhase =
  | 'offline'
  | 'selecting'
  | 'provisioning'
  | 'booting'
  | 'loading'
  | 'warming'
  | 'ready'
  | 'reconnecting'
  | 'stopping'
  | 'error';

export type BatchPhase =
  | 'draft'
  | 'validating'
  | 'running'
  | 'paused'
  | 'locked'
  | 'partial_failure'
  | 'complete'
  | 'cancelled'
  | 'interrupted'
  | 'error';

export type PromptStatus =
  | 'pending'
  | 'generating'
  | 'retrying'
  | 'ready'
  | 'downloading'
  | 'downloaded'
  | 'failed'
  | 'cancelled';

export type OperationalScenario =
  | 'offline'
  | 'provisioning'
  | 'loading'
  | 'warming'
  | 'ready'
  | 'running'
  | 'paused'
  | 'locked'
  | 'duplicate_pods'
  | 'reconnecting'
  | 'partial_failure'
  | 'complete'
  | 'error';

export type CredentialKind = 'runpodApiKey' | 'workerToken';

export interface CredentialMetadata {
  configured: boolean;
  suffix: string | null;
  provider: string;
}

export interface CredentialMetadataMap {
  runpodApiKey: CredentialMetadata;
  workerToken: CredentialMetadata;
}

export interface ValidationIssue {
  code: 'empty' | 'duplicate' | 'too_short' | 'invalid_csv';
  level: 'error' | 'warning';
  message: string;
  line?: number;
}

export interface DraftPrompt {
  id: string;
  index: number;
  sourceLine: number;
  text: string;
  seed: number;
  issues: ValidationIssue[];
}

export interface BatchPrompt extends DraftPrompt {
  status: PromptStatus;
  attempts: number;
  durationSeconds?: number;
  filename?: string;
  checksum?: string;
  failureReason?: string;
}

export type ReferenceMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

/** A local image reference held only for the pending batch request. Raw bytes
 * never enter manifests, receipts, or safe preferences. */
export interface BatchReference {
  id: string;
  name: string;
  mimeType: ReferenceMimeType;
  sizeBytes: number;
  bytes: number[];
}

export interface DraftState {
  name: string;
  rawText: string;
  sourceName: string | null;
  prompts: DraftPrompt[];
  issues: ValidationIssue[];
  destination: string | null;
  references: BatchReference[];
  aspectRatio: AspectRatio;
  queueReplacementId: string | null;
}

export interface PodState {
  phase: PodPhase;
  phaseProgress: number;
  statusDetail: string;
  gpu: string | null;
  vram: string | null;
  hourlyRate: number | null;
  health: 'offline' | 'checking' | 'healthy' | 'degraded';
  podId: string | null;
  matchingPodIds: string[];
  lastCheckedAt: string | null;
  errorMessage: string | null;
  lifecycleSequence: number;
  createRecovery: {
    attemptId: string;
    podName: string | null;
    gpuId: string | null;
    podId: string | null;
  } | null;
  stopTargetPodId: string | null;
}

/**
 * A Pod identity is the shared lifecycle authority.  Phase/health can be
 * degraded while that exact Pod remains billed and stoppable; UI controls
 * must not infer "offline" from a transient health phase.
 */
export function hasActivePodIdentity(pod: Pick<PodState, 'podId'>): boolean {
  return pod.podId !== null;
}

export type PodPowerAction = 'start' | 'stop';

/** Start/Stop presentation is an exact-Pod decision, never a phase decision. */
export function podPowerAction(pod: Pick<PodState, 'podId'>): PodPowerAction {
  return hasActivePodIdentity(pod) ? 'stop' : 'start';
}

export interface BatchState {
  id: string;
  name: string;
  owner: string;
  /** Authoritative worker permission. Production controls never infer this
   * from the editable display name. */
  canManage?: boolean;
  /** Exact underlying worker state for a foreign lease. The local phase stays
   * `locked` because this client cannot mutate it. */
  remoteState?: 'running' | 'paused' | 'interrupted';
  phase: BatchPhase;
  prompts: BatchPrompt[];
  destination: string;
  startedAt: string;
  elapsedSeconds: number;
  estimatedSecondsPerImage: number;
  estimatedCost: number;
  lockMessage: string | null;
  statusMessage: string;
  references?: BatchReference[];
  aspectRatio: AspectRatio;
  queueItemId?: string;
  clientSubmissionId?: string;
  admissionMode?: 'foreground' | 'queue';
  reportedProgress?: {
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    currentIndex: number | null;
  };
}

export interface LibraryAsset {
  id: string;
  batchId: string;
  batchName: string;
  index: number;
  prompt: string;
  seed: number;
  filename: string;
  checksum: string;
  createdAt: string;
  durationSeconds: number;
  destination: string;
  palette: number;
  /** True when the local receipt was restored before worker prompt/timing
   * metadata became reachable. */
  recovered?: boolean;
}

export interface UsageRun {
  id: string;
  name: string;
  date: string;
  gpu: string;
  completed: number;
  failed: number;
  seconds: number;
  cost: number;
}

export interface SettingsState {
  userName: string;
  defaultDestination: string;
  editorialSuffixEnabled: boolean;
  editorialSuffix: string;
  theme: 'midnight' | 'ink';
  density: 'comfortable' | 'compact';
  simulationSpeed: 1 | 4 | 12;
  gpuPreference: 'best_value' | 'fastest';
  slowEmergencyGpuEnabled: boolean;
}

export interface SetupState {
  completed: boolean;
  studioProfile: string;
  destinationValidated: boolean;
  credentials: CredentialMetadataMap;
}

export type DialogState =
  | { type: 'stop-pod'; podId: string }
  | { type: 'cancel-batch' }
  | { type: 'clear-library' }
  | { type: 'resolve-create' }
  | { type: 'reset-queue' }
  | null;

export interface ToastState {
  id: number;
  tone: 'success' | 'warning' | 'info' | 'error';
  title: string;
  message: string;
  action?: {
    label: string;
    view: ViewId;
  };
}

export interface LocalSyncIssue {
  batchId: string;
  code: string;
  message: string;
  retryable: boolean;
}

export interface StudioParticipant {
  sessionId: string;
  displayName: string;
}

export interface StudioSession extends StudioParticipant {
  availability: 'foreground' | 'background';
  expiresAt: string;
}

export type StudioStopPhase =
  | 'idle'
  | 'checking'
  | 'blocked'
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'cancelled'
  | 'finalizing'
  | 'stopped'
  | 'failed';

export interface StudioStopState {
  phase: StudioStopPhase;
  requestId: string | null;
  podId: string | null;
  gpuDisplayName: string | null;
  requester: StudioParticipant | null;
  isRequester: boolean;
  canRespond: boolean;
  waitingFor: StudioParticipant[];
  approvedBy: StudioParticipant[];
  deniedBy: StudioParticipant[];
  responseDeadline: string | null;
  finalizationExpiresAt: string | null;
  finalizationId: string | null;
  reason: string | null;
  message: string | null;
  retryable: boolean;
  blockedByBatch: {
    owner: string;
    completed: number;
    total: number;
  } | null;
}

export type StudioGpuSwitchPhase =
  | 'pending'
  | 'approved'
  | 'pausing'
  | 'ready_to_delete'
  | 'delete_intent'
  | 'replacement_ready'
  | 'needs_attention';

export interface StudioGpuSwitchState {
  switchId: string;
  oldPodId: string;
  oldGpuId: string;
  oldGpuDisplayName: string;
  initialTargetGpuId: string;
  initialTargetGpuDisplayName: string;
  requester: StudioParticipant;
  isRequester: boolean;
  canRespond: boolean;
  phase: StudioGpuSwitchPhase;
  reason: string | null;
  requestedAt: string;
  responseDeadline: string;
  readyToDeleteAt: string | null;
  waitingFor: StudioParticipant[];
  approvedBy: StudioParticipant[];
  deniedBy: StudioParticipant[];
  batchId: string | null;
  batchOwner: string | null;
  batchProgress: { completed: number; total: number } | null;
  batchStateAtFinalization: 'running' | 'paused' | 'interrupted' | null;
  replacementPodId: string | null;
  actualTargetGpuId: string | null;
}

export interface StudioSyncState {
  connected: boolean;
  serverInstanceId: string | null;
  coordinationRevision: number;
  currentSession: StudioSession | null;
  sessions: StudioSession[];
  stop: StudioStopState;
  gpuSwitch: StudioGpuSwitchState | null;
}

export interface AppState {
  activeView: ViewId;
  pod: PodState;
  draft: DraftState;
  batch: BatchState | null;
  library: LibraryAsset[];
  usage: UsageRun[];
  settings: SettingsState;
  setup: SetupState;
  dialog: DialogState;
  toast: ToastState | null;
  toastSequence: number;
  refreshedAt: string | null;
  localSyncIssue: LocalSyncIssue | null;
  studio: StudioSyncState;
  queue: QueueUiState;
}

export type AppAction =
  | { type: 'NAVIGATE'; view: ViewId }
  | { type: 'SET_PROMPT_TEXT'; text: string; sourceName?: string | null }
  | { type: 'SET_BATCH_NAME'; name: string }
  | { type: 'LOAD_SAMPLE' }
  | { type: 'NEW_BATCH' }
  | { type: 'SET_DESTINATION'; path: string }
  | { type: 'ADD_REFERENCE'; reference: BatchReference }
  | { type: 'REMOVE_REFERENCE'; id: string }
  | { type: 'SET_ASPECT_RATIO'; aspectRatio: AspectRatio }
  | { type: 'QUEUE_LOADED'; snapshot: NativeQueueSnapshotV1 }
  | { type: 'QUEUE_LOAD_FAILED'; code: string }
  | { type: 'QUEUE_COMMITTED'; snapshot: NativeQueueSnapshotV1 }
  | { type: 'QUEUE_LEASE_CHANGED'; lease: NativeRunnerLease | null }
  | { type: 'QUEUE_POWER_CHANGED'; power: NativePowerState | null }
  | { type: 'QUEUE_ALARM_TEST_STATE'; state: QueueUiState['alarmTest'] }
  | { type: 'QUEUE_NOTIFICATION_PERMISSION'; permission: QueueUiState['notificationPermission'] }
  | { type: 'SET_QUEUE_KEEP_AWAKE'; enabled: boolean }
  | { type: 'STAGE_DRAFT' }
  | { type: 'RUN_QUEUE' }
  | { type: 'RESUME_QUEUE' }
  | { type: 'PAUSE_QUEUE' }
  | { type: 'MOVE_QUEUE_ITEM'; queueItemId: string; direction: -1 | 1 }
  | { type: 'REMOVE_QUEUE_ITEM'; queueItemId: string }
  | { type: 'EDIT_QUEUE_ITEM'; queueItemId: string }
  | { type: 'TEST_QUEUE_ALARM' }
  | { type: 'CONFIRM_QUEUE_ALARM' }
  | { type: 'SNOOZE_QUEUE_ALARM' }
  | { type: 'DISMISS_QUEUE_ALARM' }
  | { type: 'RING_QUEUE_ALARM' }
  | { type: 'CLEAR_QUEUE_COMPLETED' }
  | { type: 'CLEAR_QUEUE_HISTORY' }
  | { type: 'REQUEST_RESET_QUEUE' }
  | { type: 'CONFIRM_RESET_QUEUE' }
  | { type: 'QUEUE_DISPATCH_ITEM'; payload: NativeQueueDispatchPayloadV1; startedAt: string }
  | { type: 'QUEUE_RELEASE_BATCH' }
  | { type: 'RESTORE_QUEUE_ITEM_TO_DRAFT'; payload: NativeQueueDispatchPayloadV1; styleSuffix: string | null }
  | { type: 'START_POD' }
  | { type: 'OPEN_GPU_SELECTOR' }
  | { type: 'SET_POD_PHASE'; phase: PodPhase; progress: number; detail: string; podId?: string; gpu?: string; vram?: string; hourlyRate?: number }
  | { type: 'SYNC_RUNTIME_POD'; pod: PodState }
  | { type: 'SYNC_CREATE_RECOVERY'; marker: PodState['createRecovery'] }
  | { type: 'REQUEST_STOP_POD' }
  | { type: 'CONFIRM_STOP_POD' }
  | { type: 'REQUEST_RESOLVE_CREATE' }
  | { type: 'CONFIRM_RESOLVE_CREATE' }
  | { type: 'POD_STOPPED' }
  | { type: 'REFRESH_STATUS'; checkedAt: string }
  | { type: 'START_BATCH'; startedAt: string }
  | { type: 'BATCH_VALIDATED' }
  | { type: 'BATCH_TICK' }
  | { type: 'SYNC_RUNTIME_BATCH'; batch: BatchState; assets: LibraryAsset[] }
  | { type: 'SYNC_RUNTIME_LIBRARY'; assets: LibraryAsset[] }
  | { type: 'SYNC_RUNTIME_BUSY'; batch: BatchState }
  | { type: 'RUNTIME_BATCH_IDLE' }
  | { type: 'RUNTIME_STOP_GUARD_ACTIVE'; podId: string | null; message: string }
  | { type: 'RUNTIME_LOCAL_ERROR'; batchId: string; code: string; message: string; retryable?: boolean }
  | { type: 'BEGIN_STUDIO_STOP'; podId: string; gpuDisplayName: string }
  | { type: 'SYNC_STUDIO_STATE'; studio: StudioSyncState }
  | { type: 'STUDIO_STOP_BLOCKED'; owner: string; completed: number; total: number; message: string }
  | { type: 'STUDIO_STOP_FAILED'; message: string; retryable?: boolean }
  | { type: 'STUDIO_STOPPED'; alreadyStopped: boolean }
  | { type: 'CLEAR_STUDIO_STOP' }
  | { type: 'RESPOND_STUDIO_STOP'; requestId: string; decision: 'approve' | 'deny' }
  | { type: 'CANCEL_STUDIO_STOP'; requestId: string }
  | { type: 'RESPOND_STUDIO_GPU_SWITCH'; switchId: string; decision: 'approve' | 'deny' }
  | { type: 'RUNTIME_ERROR'; scope: 'pod' | 'batch'; code?: string; message: string; retryable?: boolean }
  | { type: 'TOGGLE_BATCH_PAUSE' }
  | { type: 'REQUEST_CANCEL_BATCH' }
  | { type: 'CONFIRM_CANCEL_BATCH' }
  | { type: 'RETRY_FAILED' }
  | { type: 'RESUME_INTERRUPTED_BATCH' }
  | { type: 'DISMISS_DIALOG' }
  | { type: 'DISMISS_TOAST' }
  | { type: 'SET_SETTING'; key: keyof SettingsState; value: SettingsState[keyof SettingsState] }
  | { type: 'SET_STUDIO_PROFILE'; profile: string }
  | { type: 'SET_DESTINATION_VALIDATED'; validated: boolean }
  | { type: 'SET_CREDENTIAL_METADATA'; credentials: CredentialMetadataMap }
  | { type: 'COMPLETE_SETUP' }
  | { type: 'SAVE_SETTINGS' }
  | { type: 'PREVIEW_SCENARIO'; scenario: OperationalScenario }
  | { type: 'RESET_WORKSPACE' }
  | { type: 'REQUEST_CLEAR_LIBRARY' }
  | { type: 'CLEAR_LIBRARY' }
  | { type: 'SHOW_TOAST'; tone: ToastState['tone']; title: string; message: string; action?: ToastState['action'] };

export const TERMINAL_BATCH_PHASES: BatchPhase[] = [
  'complete',
  'partial_failure',
  'cancelled',
  'error',
];
