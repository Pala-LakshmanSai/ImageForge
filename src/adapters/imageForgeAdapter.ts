import type {
  CredentialKind,
  CredentialMetadata,
  CredentialMetadataMap,
  PodPhase,
} from '../domain/types';
import type { ProductionRuntimeFacade } from './productionImageForgeAdapter';
import type { QueueHostPort } from '../domain/queue';
import { createMemoryQueueHost } from './queueStore';

export const EU_RO_ORDINARY_GPUS = [
  'RTX 4090',
  'RTX PRO 4500 Blackwell',
  'RTX 5090',
  'RTX PRO 4000 Blackwell',
  'L4',
  'RTX A4500',
  'RTX 4000 Ada',
  'A100 PCIe',
  'RTX PRO 6000 Blackwell Server Edition',
  'RTX PRO 6000 Blackwell Workstation Edition',
] as const;

// These are the production bindings validated by the paid EU-RO-1 smoke and
// shared-volume gates. Keep them immutable so a normal Start cannot silently
// fall back to an unpinned worker image or an outdated template.
export const IMAGEFORGE_TEMPLATE_ID = 'q8sfgixfy2';
export const IMAGEFORGE_NETWORK_VOLUME_ID = 'ukh207b26r';
export const IMAGEFORGE_WORKER_IMAGE =
  'ghcr.io/pala-lakshmansai/imageforge-worker@sha256:38ed950746e98a65ae13eee35583408dc367e268d91697b49538e5a623efa5a4';

export const DEFAULT_STUDIO_PROFILE = [
  'profile: imageforge-studio-v1',
  `template_id: ${IMAGEFORGE_TEMPLATE_ID}`,
  `network_volume_id: ${IMAGEFORGE_NETWORK_VOLUME_ID}`,
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

export interface ValidatedImageResponse {
  contentType: 'image/jpeg' | 'image/webp';
  sha256: string;
  sizeBytes: number;
  bytes: number[];
}

export interface DownloadAssetRequest {
  batchId: string;
  index: number;
  batchName: string;
  checksum: string;
}

export interface StudioProfile {
  profile: string;
  templateId: string;
  networkVolumeId: string;
  dataCenter: 'EU-RO-1';
  gpuPolicy: string;
  workerPort: 8000;
  modelPreset: 'flux2-klein-bf16';
}

export interface ImageForgeAdapter {
  readonly mode?: 'fake' | 'production';
  readonly runtime?: ProductionRuntimeFacade;
  readonly queue: QueueHostPort;
  chooseDestination(defaultPath: string): Promise<string | null>;
  validateDestination(path: string): Promise<boolean>;
  revealPath(relativePath?: string): Promise<void>;
  /**
   * Fetches one validated image through the native boundary. Production may
   * return the receipt-bound local JPEG or a bounded worker WebP preview.
   */
  fetchPreview?(batchId: string, index: number): Promise<ValidatedImageResponse>;
  /**
   * Saves one exact receipt-bound JPEG. Native code owns filename
   * sanitization, collision handling, and the save dialog.
   */
  downloadAsset?(request: DownloadAssetRequest): Promise<string | null>;
  writeManifest(batchId: string, content: string): Promise<string>;
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

export function parseStudioProfile(source: string): StudioProfile | null {
  const entries = new Map<string, string>();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) return null;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!value || entries.has(key)) return null;
    entries.set(key, value);
  }
  const allowed = new Set([
    'profile',
    'template_id',
    'network_volume_id',
    'data_center',
    'gpu_policy',
    'worker_port',
    'model_preset',
  ]);
  if (entries.size !== allowed.size || [...entries.keys()].some((key) => !allowed.has(key))) return null;
  const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;
  const profile = entries.get('profile')!;
  const templateId = entries.get('template_id')!;
  const networkVolumeId = entries.get('network_volume_id')!;
  const gpuPolicy = entries.get('gpu_policy')!;
  if (
    !safeId.test(profile) ||
    !safeId.test(templateId) ||
    !safeId.test(networkVolumeId) ||
    !safeId.test(gpuPolicy) ||
    entries.get('data_center') !== 'EU-RO-1' ||
    entries.get('worker_port') !== '8000' ||
    entries.get('model_preset') !== 'flux2-klein-bf16'
  ) return null;
  return {
    profile,
    templateId,
    networkVolumeId,
    dataCenter: 'EU-RO-1',
    gpuPolicy,
    workerPort: 8000,
    modelPreset: 'flux2-klein-bf16',
  };
}

function validateProfile(profile: string): boolean {
  return parseStudioProfile(profile) !== null;
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
    : ' · ten ordinary EU-RO-1 candidates';
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
      detail: 'Loading Mage-Flow Turbo from the volume · INT8',
      ...selected,
    },
    {
      at: 2_050,
      phase: 'warming',
      progress: 86,
      detail: 'Warming the four-step inference graph',
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
  const queue = createMemoryQueueHost();

  return {
    mode: 'fake',
    queue,
    async chooseDestination(defaultPath) {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      return defaultPath;
    },
    async validateDestination(path) {
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      return path.trim().length > 0;
    },
    async revealPath() {
      await Promise.resolve();
    },
    async downloadAsset(request) {
      await Promise.resolve();
      return request.batchName + ' - ' + String(request.index).padStart(3, '0') + '.jpg';
    },
    async writeManifest(batchId) {
      await Promise.resolve();
      return `${batchId}/manifest.csv`;
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
