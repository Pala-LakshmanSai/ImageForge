export type SelectorPerfArmState = 'idle' | 'arming' | 'armed';

export function isMeasuredInputReady(
  warmupsRemaining: number,
  armState: SelectorPerfArmState,
): boolean {
  return warmupsRemaining === 0 && armState === 'armed';
}

export function advanceWarmOpen(warmupsRemaining: number): {
  readonly warmupsRemaining: number;
  readonly open: boolean;
} {
  const remaining = Math.max(0, warmupsRemaining - 1);
  return {
    warmupsRemaining: remaining,
    open: remaining !== 0,
  };
}

export function advanceWarmInput(
  warmupsRemaining: number,
  open: boolean,
): {
  readonly warmupsRemaining: number;
  readonly open: boolean;
} {
  if (warmupsRemaining <= 0) {
    return { warmupsRemaining: 0, open };
  }
  if (open) {
    return { warmupsRemaining, open: false };
  }
  return advanceWarmOpen(warmupsRemaining);
}

export function isWarmArmCandidate(
  warmupsRemaining: number,
  open: boolean,
): boolean {
  return warmupsRemaining === 0 && !open;
}
