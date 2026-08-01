import type { PodPhase } from '../domain/types';

export interface PodLifecycleUpdate {
  phase: PodPhase;
  progress: number;
  detail: string;
  podId?: string;
}

export interface ImageForgeAdapter {
  chooseDestination(defaultPath: string): Promise<string>;
  runPodLifecycle(onUpdate: (update: PodLifecycleUpdate) => void): () => void;
  finishPodStop(onStopped: () => void): () => void;
  validateBatch(onValidated: () => void): () => void;
  runBatchClock(speed: 1 | 4 | 12, onTick: () => void): () => void;
}

const POD_STEPS: Array<Omit<PodLifecycleUpdate, 'podId'> & { at: number }> = [
  {
    at: 260,
    phase: 'provisioning',
    progress: 23,
    detail: 'RTX 4090 selected from current inventory · creating one Pod',
  },
  {
    at: 820,
    phase: 'booting',
    progress: 39,
    detail: 'Attaching the persistent ImageForge network volume',
  },
  {
    at: 1_420,
    phase: 'loading',
    progress: 64,
    detail: 'Loading FLUX.2 Klein 4B from the volume · BF16',
  },
  {
    at: 2_050,
    phase: 'warming',
    progress: 86,
    detail: 'Warming four-step inference graph at 1280 × 720',
  },
  {
    at: 2_720,
    phase: 'ready',
    progress: 100,
    detail: 'Model warm · accepting one batch',
  },
];

export function createFakeImageForgeAdapter(): ImageForgeAdapter {
  let podSequence = 0;

  return {
    async chooseDestination(defaultPath) {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      return defaultPath || '/Users/lakshman/Pictures/ImageForge';
    },
    runPodLifecycle(onUpdate) {
      podSequence += 1;
      const podId = `pod-if-${String(7_200 + podSequence * 137).padStart(4, '0')}`;
      const timers = POD_STEPS.map((step) =>
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
      const timer = window.setInterval(onTick, Math.max(110, 1_150 / speed));
      return () => window.clearInterval(timer);
    },
  };
}
