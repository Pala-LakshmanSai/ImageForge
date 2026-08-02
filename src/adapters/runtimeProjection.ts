import type { PodView, RunPodSnapshot } from '@imageforge/runpod-client';
import type {
  BatchPhase,
  BatchPrompt,
  BatchState,
  LibraryAsset,
  PodPhase,
  PodState,
  PromptStatus,
} from '../domain/types';
import { aspectRatioFromDimensions, DEFAULT_ASPECT_RATIO } from '../domain/aspectRatio';
import type { LocalDownloadReceipt } from './workerBatchCoordinator';
import type {
  WorkerBatchState,
  WorkerBatchSummary,
  WorkerImageRecord,
  WorkerManifest,
} from './workerContracts';

const ACTIVE_POD_STATUSES = new Set(['provisioning', 'starting', 'running', 'unknown', 'error']);

function podProgress(phase: PodPhase): number {
  switch (phase) {
    case 'offline': return 0;
    case 'selecting': return 4;
    case 'provisioning': return 23;
    case 'booting': return 39;
    case 'loading': return 64;
    case 'warming': return 86;
    case 'ready': return 100;
    case 'stopping': return 72;
    case 'reconnecting': return 30;
    // An error is an indeterminate/attention state, never completed work.
    // Keeping this at zero also prevents the top-level progress track from
    // presenting an ambiguous RunPod start as a successful 100% operation.
    case 'error': return 0;
  }
}

function podDetail(snapshot: RunPodSnapshot, selected: PodView | undefined): string {
  if (snapshot.error) return snapshot.error.message;
  switch (snapshot.phase) {
    case 'offline': return 'GPU is safely offline';
    case 'selecting': return 'Checking approved Secure GPUs in EU-RO-1';
    case 'provisioning': return `${selected?.gpuDisplayName ?? 'Approved GPU'} selected · provisioning compute`;
    case 'booting': return 'Attaching the persistent ImageForge network volume';
    case 'loading': return 'Loading FLUX.2 Klein 4B from the network volume · BF16';
    case 'warming': return 'Warming the four-step inference graph';
    case 'ready': return 'Model warm · accepting one batch';
    case 'stopping': return 'Terminating the explicitly confirmed compute Pod';
    case 'reconnecting': return 'Reconnecting to the verified worker manifest';
    case 'error': return 'The GPU lifecycle needs attention';
  }
}

export function projectPodSnapshot(snapshot: RunPodSnapshot, current: PodState): PodState {
  const selected = snapshot.selectedPodId === null
    ? undefined
    : snapshot.pods.find((pod) => pod.id === snapshot.selectedPodId);
  const offer = selected?.gpuId === null || selected?.gpuId === undefined
    ? undefined
    : snapshot.inventory.find((candidate) => candidate.gpuId === selected.gpuId);
  const activePodIds = snapshot.pods
    .filter((pod) => ACTIVE_POD_STATUSES.has(pod.status))
    .map((pod) => pod.id);
  const memory = offer?.memoryGb;
  return {
    ...current,
    phase: snapshot.phase,
    phaseProgress: podProgress(snapshot.phase),
    statusDetail: podDetail(snapshot, selected),
    gpu: selected?.gpuDisplayName ?? null,
    vram: memory === undefined ? null : `${memory} GB`,
    hourlyRate: selected?.hourlyPriceUsd ?? offer?.hourlyPriceUsd ?? null,
    health: snapshot.phase === 'ready'
      ? 'healthy'
      : snapshot.phase === 'offline'
        ? 'offline'
        : snapshot.phase === 'error'
          ? 'degraded'
          : 'checking',
    podId: snapshot.selectedPodId,
    matchingPodIds: activePodIds,
    lastCheckedAt: snapshot.refreshedAt,
    errorMessage: snapshot.error?.message ?? null,
  };
}

export interface BatchPresentationContext {
  name: string;
  destination: string;
  estimatedSecondsPerImage: number;
  hourlyRate: number | null;
}

export interface ProjectedOwnedBatch {
  batch: BatchState;
  assets: LibraryAsset[];
}

function imageStatus(image: WorkerImageRecord, local: LocalDownloadReceipt | undefined): PromptStatus {
  if (local?.sha256 === image.sha256 && local.sizeBytes === image.sizeBytes) return 'downloaded';
  if (image.status === 'downloaded') return 'ready';
  return image.status;
}

function batchPhase(state: WorkerBatchState, failed: number): BatchPhase {
  switch (state) {
    case 'running': return 'running';
    case 'paused': return 'paused';
    case 'cancelled': return 'cancelled';
    case 'interrupted': return 'interrupted';
    case 'failed': return failed > 0 ? 'partial_failure' : 'error';
    case 'completed': return failed > 0 ? 'partial_failure' : 'complete';
  }
}

function statusMessage(manifest: WorkerManifest, phase: BatchPhase): string {
  const { progress } = manifest;
  if (phase === 'running') {
    const current = progress.currentIndex ?? Math.min(progress.processed + 1, progress.total);
    return `Generating image ${String(current).padStart(3, '0')} of ${String(progress.total).padStart(3, '0')}`;
  }
  if (phase === 'paused') return `Paused safely after ${progress.processed} processed images`;
  if (phase === 'interrupted') return `Interrupted manifest saved · ${progress.processed} slots retained`;
  if (phase === 'partial_failure') return `${progress.downloaded} downloaded · ${progress.failed} need review`;
  if (phase === 'complete') return `${progress.downloaded} images verified in order`;
  if (phase === 'cancelled') return `Cancelled · ${progress.downloaded} completed downloads kept`;
  return 'Batch stopped safely · manifest retained';
}

export function projectOwnedManifest(
  manifest: WorkerManifest,
  receipts: readonly LocalDownloadReceipt[],
  context: BatchPresentationContext,
  nowUnixMs = Date.now(),
): ProjectedOwnedBatch {
  const receiptByIndex = new Map(receipts.map((receipt) => [receipt.index, receipt] as const));
  const prompts: BatchPrompt[] = manifest.images.map((image) => {
    const local = receiptByIndex.get(image.index);
    return {
      id: `${manifest.batchId}-${image.index}`,
      index: image.index,
      sourceLine: image.index,
      text: image.prompt,
      seed: image.seed,
      issues: [],
      status: imageStatus(image, local),
      attempts: image.attempts,
      ...(image.generationMs === null ? {} : { durationSeconds: image.generationMs / 1_000 }),
      ...(local === undefined ? {} : { filename: local.filename, checksum: local.sha256 }),
      ...(image.error === null ? {} : { failureReason: image.error.message }),
    };
  });
  const phase = batchPhase(manifest.state, manifest.progress.failed);
  const started = Date.parse(manifest.createdAt);
  const terminalAt = ['complete', 'partial_failure', 'cancelled', 'interrupted', 'error'].includes(phase)
    ? Date.parse(manifest.completedAt ?? manifest.updatedAt)
    : Number.NaN;
  const end = Number.isFinite(terminalAt) ? terminalAt : nowUnixMs;
  const elapsedSeconds = Number.isFinite(started)
    ? Math.max(0, Math.round((end - started) / 1_000))
    : 0;
  const measured = manifest.images
    .map((image) => image.generationMs)
    .filter((value): value is number => value !== null);
  const estimatedSecondsPerImage = measured.length === 0
    ? context.estimatedSecondsPerImage
    : measured.reduce((total, value) => total + value, 0) / measured.length / 1_000;
  const estimatedCost = context.hourlyRate === null ? 0 : (elapsedSeconds / 3_600) * context.hourlyRate;
  const batch: BatchState = {
    id: manifest.batchId,
    name: context.name,
    owner: manifest.owner.displayName,
    canManage: true,
    phase,
    prompts,
    destination: context.destination,
    startedAt: manifest.createdAt,
    elapsedSeconds,
    estimatedSecondsPerImage,
    estimatedCost,
    lockMessage: null,
    statusMessage: statusMessage(manifest, phase),
    aspectRatio: aspectRatioFromDimensions(manifest.settings.width, manifest.settings.height),
  };
  const assets = prompts.flatMap((prompt): LibraryAsset[] => {
    if (prompt.status !== 'downloaded' || !prompt.filename || !prompt.checksum) return [];
    return [{
      id: `${manifest.batchId}-${prompt.index}`,
      batchId: manifest.batchId,
      batchName: context.name,
      index: prompt.index,
      prompt: prompt.text,
      seed: prompt.seed,
      filename: prompt.filename,
      checksum: prompt.checksum,
      createdAt: manifest.updatedAt,
      durationSeconds: prompt.durationSeconds ?? estimatedSecondsPerImage,
      destination: context.destination,
      palette: prompt.seed % 6,
    }];
  });
  return { batch, assets };
}

export function projectBusyBatch(summary: WorkerBatchSummary): BatchState {
  return {
    id: summary.batchId,
    name: `${summary.owner.displayName}’s active batch`,
    owner: summary.owner.displayName,
    canManage: false,
    phase: 'locked',
    prompts: [],
    destination: 'Owner’s selected computer',
    startedAt: new Date().toISOString(),
    elapsedSeconds: 0,
    estimatedSecondsPerImage: 8.4,
    estimatedCost: 0,
    lockMessage: `${summary.progress.completed} of ${summary.progress.total} images are generated.`,
    statusMessage: `${summary.owner.displayName} is generating ${summary.progress.completed} of ${summary.progress.total}`,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    reportedProgress: {
      total: summary.progress.total,
      completed: summary.progress.completed,
      failed: summary.progress.failed,
      cancelled: summary.progress.cancelled,
      currentIndex: summary.progress.currentIndex,
    },
  };
}
