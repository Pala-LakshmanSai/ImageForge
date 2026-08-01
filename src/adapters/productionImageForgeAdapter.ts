import type { RunPodSnapshot } from '@imageforge/runpod-client';
import type {
  AppState,
  BatchState,
  CredentialKind,
  CredentialMetadata,
  CredentialMetadataMap,
  LibraryAsset,
  PodState,
} from '../domain/types';
import type { NativeDestinationMetadata } from '../native/tauriBridge';
import {
  GpuLifecycleCoordinator,
  type GpuLifecycleNativePort,
} from './gpuLifecycleCoordinator';
import {
  type ConnectionTestInput,
  type ImageForgeAdapter,
  parseStudioProfile,
} from './imageForgeAdapter';
import {
  WorkerBatchCoordinator,
  type WorkerBatchEvent,
  type WorkerBatchPort,
} from './workerBatchCoordinator';
import {
  projectBusyBatch,
  projectOwnedManifest,
  projectPodSnapshot,
  type BatchPresentationContext,
} from './runtimeProjection';

export interface ProductionDesktopPort extends GpuLifecycleNativePort, WorkerBatchPort {
  chooseDestination(defaultPath: string): Promise<NativeDestinationMetadata | null>;
  validateDestination(path: string): Promise<NativeDestinationMetadata>;
  credentialMetadata(): Promise<CredentialMetadataMap>;
  replaceCredential(kind: CredentialKind, value: string): Promise<CredentialMetadata>;
}

export type ProductionRuntimeEvent =
  | { type: 'pod'; pod: PodState }
  | { type: 'batch'; batch: BatchState; assets: LibraryAsset[] }
  | { type: 'busy'; batch: BatchState }
  | { type: 'idle' }
  | { type: 'error'; scope: 'pod' | 'batch'; message: string };

export interface ProductionRuntimeFacade {
  subscribe(listener: (event: ProductionRuntimeEvent) => void): () => void;
  refresh(state: AppState): Promise<void>;
  startGpu(state: AppState): Promise<void>;
  stopGpu(state: AppState): Promise<void>;
  startBatch(batch: BatchState): Promise<void>;
  pollBatch(state: AppState): Promise<void>;
  controlBatch(
    action: 'pause' | 'resume' | 'cancel' | 'retry_failed',
    state: AppState,
  ): Promise<void>;
  resolveAmbiguousStart(): void;
  dispose(): void;
}

class ProductionRuntime implements ProductionRuntimeFacade {
  readonly #gpu: GpuLifecycleCoordinator;
  readonly #worker: WorkerBatchCoordinator;
  readonly #listeners = new Set<(event: ProductionRuntimeEvent) => void>();
  #pod: PodState | null = null;
  #presentation: BatchPresentationContext | null = null;
  #unsubscribeGpu: () => void;
  #unsubscribeWorker: () => void;

  constructor(port: ProductionDesktopPort) {
    this.#gpu = new GpuLifecycleCoordinator(port);
    this.#worker = new WorkerBatchCoordinator(port);
    this.#unsubscribeGpu = this.#gpu.subscribe((snapshot) => this.#onPodSnapshot(snapshot));
    this.#unsubscribeWorker = this.#worker.subscribe((event) => this.#onWorkerEvent(event));
  }

  subscribe(listener: (event: ProductionRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async refresh(state: AppState): Promise<void> {
    this.#captureState(state);
    try {
      const count = state.batch?.prompts.length || state.draft.prompts.length || 450;
      const snapshot = await this.#gpu.refresh(
        state.setup.studioProfile,
        count,
        state.settings.slowEmergencyGpuEnabled,
      );
      if (snapshot.phase === 'ready') await this.#worker.poll();
    } catch (error) {
      this.#emitError('pod', error, 'ImageForge could not refresh RunPod safely.');
      throw error;
    }
  }

  async startGpu(state: AppState): Promise<void> {
    this.#captureState(state);
    try {
      const count = state.batch?.prompts.length || state.draft.prompts.length || 450;
      await this.#gpu.start(
        state.setup.studioProfile,
        count,
        state.settings.slowEmergencyGpuEnabled,
      );
      await this.#worker.poll();
    } catch (error) {
      this.#emitError('pod', error, 'ImageForge could not start a GPU safely.');
      throw error;
    }
  }

  async stopGpu(state: AppState): Promise<void> {
    this.#captureState(state);
    if (state.pod.podId === null) throw new Error('No verified ImageForge Pod is selected.');
    try {
      await this.#gpu.stop(state.pod.podId);
    } catch (error) {
      this.#emitError('pod', error, 'ImageForge could not confirm GPU termination.');
      throw error;
    }
  }

  async startBatch(batch: BatchState): Promise<void> {
    this.#presentation = {
      name: batch.name,
      destination: batch.destination,
      estimatedSecondsPerImage: batch.estimatedSecondsPerImage,
      hourlyRate: this.#pod?.hourlyRate ?? null,
    };
    try {
      await this.#worker.create(batch.prompts.map((prompt) => prompt.text), batch.prompts[0]?.seed ?? 0);
    } catch (error) {
      this.#emitError('batch', error, 'ImageForge could not create the batch.');
      throw error;
    }
  }

  async pollBatch(state: AppState): Promise<void> {
    this.#captureState(state);
    try {
      await this.#worker.poll();
    } catch (error) {
      this.#emitError('batch', error, 'ImageForge could not synchronize the worker manifest.');
      throw error;
    }
  }

  async controlBatch(
    action: 'pause' | 'resume' | 'cancel' | 'retry_failed',
    state: AppState,
  ): Promise<void> {
    this.#captureState(state);
    try {
      await this.#worker.control(action);
    } catch (error) {
      this.#emitError('batch', error, 'The batch control request could not be confirmed.');
      throw error;
    }
  }

  resolveAmbiguousStart(): void {
    this.#gpu.resolveAmbiguousStart();
  }

  dispose(): void {
    this.#unsubscribeGpu();
    this.#unsubscribeWorker();
    this.#gpu.dispose();
    this.#listeners.clear();
  }

  #captureState(state: AppState): void {
    this.#pod = state.pod;
    if (state.batch && state.batch.phase !== 'locked') {
      this.#presentation = {
        name: state.batch.name,
        destination: state.batch.destination,
        estimatedSecondsPerImage: state.batch.estimatedSecondsPerImage,
        hourlyRate: state.pod.hourlyRate,
      };
    } else if (this.#presentation === null) {
      this.#presentation = {
        name: 'Recovered ImageForge batch',
        destination: state.settings.defaultDestination,
        estimatedSecondsPerImage: 8.4,
        hourlyRate: state.pod.hourlyRate,
      };
    }
  }

  #onPodSnapshot(snapshot: RunPodSnapshot): void {
    if (this.#pod === null) return;
    this.#pod = projectPodSnapshot(snapshot, this.#pod);
    this.#emit({ type: 'pod', pod: this.#pod });
  }

  #onWorkerEvent(event: WorkerBatchEvent): void {
    if (event.type === 'idle') {
      this.#emit({ type: 'idle' });
      return;
    }
    if (event.type === 'busy') {
      this.#emit({ type: 'busy', batch: projectBusyBatch(event.summary) });
      return;
    }
    if (event.type === 'error') {
      this.#emit({ type: 'error', scope: 'batch', message: event.message });
      return;
    }
    const context = this.#presentation ?? {
      name: 'Recovered ImageForge batch',
      destination: 'Validated downloads folder',
      estimatedSecondsPerImage: 8.4,
      hourlyRate: this.#pod?.hourlyRate ?? null,
    };
    const projected = projectOwnedManifest(event.manifest, event.receipts, context);
    this.#emit({ type: 'batch', ...projected });
  }

  #emit(event: ProductionRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #emitError(scope: 'pod' | 'batch', error: unknown, fallback: string): void {
    const message = error instanceof Error && error.message ? error.message : fallback;
    this.#emit({ type: 'error', scope, message });
  }
}

export function createProductionImageForgeAdapter(port: ProductionDesktopPort): ImageForgeAdapter {
  const runtime = new ProductionRuntime(port);
  return {
    mode: 'production',
    runtime,
    async chooseDestination(defaultPath) {
      return (await port.chooseDestination(defaultPath))?.path ?? null;
    },
    async validateDestination(path) {
      return (await port.validateDestination(path)).writable;
    },
    credentialMetadata: () => port.credentialMetadata(),
    replaceCredential: (kind, value) => port.replaceCredential(kind, value),
    async validateStudioProfile(profile) {
      return parseStudioProfile(profile) !== null;
    },
    async testConnection(input: ConnectionTestInput) {
      const profile = parseStudioProfile(input.profile);
      if (profile === null) return { ok: false, message: 'The ImageForge studio profile is invalid.' };
      if (!input.credentials.runpodApiKey.configured || !input.credentials.workerToken.configured) {
        return { ok: false, message: 'Configure both credentials before continuing.' };
      }
      if (!input.destinationValidated || !input.destination.trim()) {
        return { ok: false, message: 'Choose and validate a writable downloads folder.' };
      }
      await port.bindProfile(profile.templateId, profile.networkVolumeId);
      const destination = await port.validateDestination(input.destination);
      if (!destination.writable) return { ok: false, message: 'The downloads folder is not writable.' };
      return {
        ok: true,
        message: 'Secure profile, vault metadata, and downloads folder are ready. No GPU was started.',
      };
    },
    runPodLifecycle() {
      throw new Error('Production GPU control must use the native runtime facade.');
    },
    finishPodStop() {
      throw new Error('Production GPU control must use the native runtime facade.');
    },
    validateBatch() {
      throw new Error('Production batch control must use the native runtime facade.');
    },
    runBatchClock() {
      throw new Error('Production batch control must use the native runtime facade.');
    },
  };
}
