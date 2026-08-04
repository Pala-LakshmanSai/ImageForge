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
