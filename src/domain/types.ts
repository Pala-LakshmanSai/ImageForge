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
  | 'failed';

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
  code: 'empty' | 'too_many' | 'too_long' | 'duplicate' | 'too_short' | 'invalid_csv';
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

export interface DraftState {
  name: string;
  rawText: string;
  sourceName: string | null;
  prompts: DraftPrompt[];
  issues: ValidationIssue[];
  destination: string | null;
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
}

export interface BatchState {
  id: string;
  name: string;
  owner: string;
  phase: BatchPhase;
  prompts: BatchPrompt[];
  destination: string;
  startedAt: string;
  elapsedSeconds: number;
  estimatedSecondsPerImage: number;
  estimatedCost: number;
  lockMessage: string | null;
  statusMessage: string;
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
  | { type: 'stop-pod' }
  | { type: 'cancel-batch' }
  | { type: 'clear-library' }
  | null;

export interface ToastState {
  id: number;
  tone: 'success' | 'warning' | 'info' | 'error';
  title: string;
  message: string;
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
}

export type AppAction =
  | { type: 'NAVIGATE'; view: ViewId }
  | { type: 'SET_PROMPT_TEXT'; text: string; sourceName?: string | null }
  | { type: 'SET_BATCH_NAME'; name: string }
  | { type: 'LOAD_SAMPLE' }
  | { type: 'NEW_BATCH' }
  | { type: 'SET_DESTINATION'; path: string }
  | { type: 'START_POD' }
  | { type: 'SET_POD_PHASE'; phase: PodPhase; progress: number; detail: string; podId?: string; gpu?: string; vram?: string; hourlyRate?: number }
  | { type: 'REQUEST_STOP_POD' }
  | { type: 'CONFIRM_STOP_POD' }
  | { type: 'POD_STOPPED' }
  | { type: 'REFRESH_STATUS'; checkedAt: string }
  | { type: 'START_BATCH'; startedAt: string }
  | { type: 'BATCH_VALIDATED' }
  | { type: 'BATCH_TICK' }
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
  | { type: 'SHOW_TOAST'; tone: ToastState['tone']; title: string; message: string };

export const TERMINAL_BATCH_PHASES: BatchPhase[] = [
  'complete',
  'partial_failure',
  'cancelled',
  'error',
];
