import type {
  CredentialKind,
  CredentialMetadata,
  CredentialMetadataMap,
  PodPhase,
} from '../domain/types';

export const EU_RO_ORDINARY_GPUS = [
  'RTX 4090',
  'RTX PRO 4500 Blackwell',
  'RTX 5090',
  'RTX PRO 4000 Blackwell',
  'L4',
  'RTX A4500',
  'RTX 4000 Ada',
] as const;

export const DEFAULT_STUDIO_PROFILE = [
  'profile: imageforge-studio-v1',
  'template_id: imageforge-worker-v1',
  'network_volume_id: if-models-production',
  'data_center: EU-RO-1',
  'gpu_policy: eu-ro-1-approved-v1',
  'worker_port: 8000',
  'model_preset: flux2-klein-bf16',
].join('\n');

export interface PodLifecycleUpdate {
  phase: PodPhase;
  progress: number;
  detail: string;
  podId?: string;
  gpu?: string;
  vram?: string;
  hourlyRate?: number;
}

export interface GpuSelectionPolicy {
  preference: 'best_value' | 'fastest';
  allowSlowEmergency: boolean;
}

export interface ConnectionTestInput {
  profile: string;
  destination: string;
  destinationValidated: boolean;
  credentials: CredentialMetadataMap;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

export interface ImageForgeAdapter {
  chooseDestination(defaultPath: string): Promise<string>;
  validateDestination(path: string): Promise<boolean>;
  credentialMetadata(): Promise<CredentialMetadataMap>;
  replaceCredential(kind: CredentialKind, value: string): Promise<CredentialMetadata>;
  validateStudioProfile(profile: string): Promise<boolean>;
  testConnection(input: ConnectionTestInput): Promise<ConnectionTestResult>;
  runPodLifecycle(policy: GpuSelectionPolicy, onUpdate: (update: PodLifecycleUpdate) => void): () => void;
  finishPodStop(onStopped: () => void): () => void;
  validateBatch(onValidated: () => void): () => void;
  runBatchClock(speed: 1 | 4 | 12, onTick: () => void): () => void;
}

function platformProvider(): string {
  if (typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent)) return 'Windows Credential Manager';
  if (typeof navigator !== 'undefined' && /(macintosh|mac os)/i.test(navigator.userAgent)) return 'macOS Keychain';
  return 'OS credential vault';
}

export function emptyCredentialMetadata(provider = platformProvider()): CredentialMetadataMap {
  return {
    runpodApiKey: { configured: false, suffix: null, provider },
    workerToken: { configured: false, suffix: null, provider },
  };
}

function cloneCredentialMetadata(credentials: CredentialMetadataMap): CredentialMetadataMap {
  return {
    runpodApiKey: { ...credentials.runpodApiKey },
    workerToken: { ...credentials.workerToken },
  };
}

function validateProfile(profile: string): boolean {
  const required = [
    /template_id\s*:/i,
    /network_volume_id\s*:/i,
    /data_center\s*:\s*EU-RO-1/i,
    /gpu_policy\s*:/i,
    /worker_port\s*:\s*8000/i,
    /model_preset\s*:/i,
  ];
  return required.every((pattern) => pattern.test(profile));
}

function selectionFor(policy: GpuSelectionPolicy) {
  if (policy.preference === 'fastest') {
    return { gpu: 'RTX 5090', vram: '32 GB', hourlyRate: 0.74 };
  }
  return { gpu: 'RTX 4090', vram: '24 GB', hourlyRate: 0.54 };
}

function podSteps(policy: GpuSelectionPolicy): Array<Omit<PodLifecycleUpdate, 'podId'> & { at: number }> {
  const selected = selectionFor(policy);
  const fallbackDetail = policy.allowSlowEmergency
    ? ' · RTX 2000 Ada enabled as the final slow emergency fallback'
    : ' · seven ordinary EU-RO-1 candidates';
  return [
    {
      at: 260,
      phase: 'provisioning',
      progress: 23,
      detail: `${selected.gpu} selected from current inventory${fallbackDetail}`,
      ...selected,
    },
    {
      at: 820,
      phase: 'booting',
      progress: 39,
      detail: 'Attaching the persistent ImageForge network volume',
      ...selected,
    },
    {
      at: 1_420,
      phase: 'loading',
      progress: 64,
      detail: 'Loading FLUX.2 Klein 4B from the volume · BF16',
      ...selected,
    },
    {
      at: 2_050,
      phase: 'warming',
      progress: 86,
      detail: 'Warming four-step inference graph at 1280 × 720',
      ...selected,
    },
    {
      at: 2_720,
      phase: 'ready',
      progress: 100,
      detail: 'Model warm · accepting one batch',
      ...selected,
    },
  ];
}

export function createFakeImageForgeAdapter(initialCredentials?: CredentialMetadataMap): ImageForgeAdapter {
  let podSequence = 0;
  let credentials = cloneCredentialMetadata(initialCredentials ?? emptyCredentialMetadata());

  return {
    async chooseDestination(defaultPath) {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      return defaultPath;
    },
    async validateDestination(path) {
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      return path.trim().length > 0;
    },
    async credentialMetadata() {
      await Promise.resolve();
      return cloneCredentialMetadata(credentials);
    },
    async replaceCredential(kind, value) {
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      const normalized = value.trim();
      if (normalized.length < 8) throw new Error('Enter at least eight characters.');
      const metadata: CredentialMetadata = {
        configured: true,
        suffix: normalized.slice(-4),
        provider: platformProvider(),
      };
      credentials = { ...credentials, [kind]: metadata };
      return { ...metadata };
    },
    async validateStudioProfile(profile) {
      await Promise.resolve();
      return validateProfile(profile);
    },
    async testConnection(input) {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      if (!input.credentials.runpodApiKey.configured || !input.credentials.workerToken.configured) {
        return { ok: false, message: 'Configure both credentials before testing the connection.' };
      }
      if (!validateProfile(input.profile)) {
        return { ok: false, message: 'The profile is missing the EU-RO-1 template, volume, GPU policy, port, or model preset.' };
      }
      if (!input.destinationValidated || !input.destination.trim()) {
        return { ok: false, message: 'Choose and validate a writable downloads folder.' };
      }
      return { ok: true, message: 'Profile, credential metadata, and folder permissions are valid. No Pod was created.' };
    },
    runPodLifecycle(policy, onUpdate) {
      podSequence += 1;
      const podId = `pod-if-${String(7_200 + podSequence * 137).padStart(4, '0')}`;
      const timers = podSteps(policy).map((step) =>
        window.setTimeout(
          () => onUpdate({ ...step, podId: step.phase === 'ready' ? podId : undefined }),
          step.at,
        ),
      );
      return () => timers.forEach((timer) => window.clearTimeout(timer));
    },
    finishPodStop(onStopped) {
      const timer = window.setTimeout(onStopped, 820);
      return () => window.clearTimeout(timer);
    },
    validateBatch(onValidated) {
      const timer = window.setTimeout(onValidated, 520);
      return () => window.clearTimeout(timer);
    },
    runBatchClock(speed, onTick) {
      const timer = window.setInterval(onTick, Math.max(90, 1_150 / speed));
      return () => window.clearInterval(timer);
    },
  };
}
