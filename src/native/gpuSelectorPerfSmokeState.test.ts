import { describe, expect, it } from 'vitest';
import {
  advanceWarmInput,
  advanceWarmOpen,
  isMeasuredInputReady,
  isWarmArmCandidate,
} from './gpuSelectorPerfSmokeState';

describe('selector performance warm-up state', () => {
  it('keeps the sheet open while unmeasured warm-ups remain', () => {
    expect(advanceWarmOpen(3)).toEqual({ warmupsRemaining: 2, open: true });
    expect(advanceWarmOpen(2)).toEqual({ warmupsRemaining: 1, open: true });
  });

  it('leaves the sheet closed after the final warm-up so the first arm can run', () => {
    expect(advanceWarmOpen(1)).toEqual({ warmupsRemaining: 0, open: false });
  });

  it('does not produce a negative warm-up count', () => {
    expect(advanceWarmOpen(0)).toEqual({ warmupsRemaining: 0, open: false });
  });

  it('completes three close-open warm-ups from six inputs even when the rendered target is stale', () => {
    let state = { warmupsRemaining: 3, open: true };
    const states = Array.from({ length: 6 }, () => {
      state = advanceWarmInput(state.warmupsRemaining, state.open);
      return state;
    });

    expect(states).toEqual([
      { warmupsRemaining: 3, open: false },
      { warmupsRemaining: 2, open: true },
      { warmupsRemaining: 2, open: false },
      { warmupsRemaining: 1, open: true },
      { warmupsRemaining: 1, open: false },
      { warmupsRemaining: 0, open: false },
    ]);
  });

  it('keeps a measured control disabled until native arm acceptance commits', () => {
    expect(isMeasuredInputReady(0, 'idle')).toBe(false);
    expect(isMeasuredInputReady(0, 'arming')).toBe(false);
    expect(isMeasuredInputReady(0, 'armed')).toBe(true);
  });

  it('does not expose the measured control during unrecorded warm-ups', () => {
    expect(isMeasuredInputReady(1, 'idle')).toBe(false);
    expect(isMeasuredInputReady(1, 'armed')).toBe(false);
  });

  it('arms warm-open only from the final committed closed state', () => {
    expect(isWarmArmCandidate(1, false)).toBe(false);
    expect(isWarmArmCandidate(0, true)).toBe(false);
    expect(isWarmArmCandidate(0, false)).toBe(true);
  });
});
