import { describe, expect, it } from 'vitest';
import { advanceWarmOpen, isMeasuredInputReady } from './gpuSelectorPerfSmokeState';

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

  it('keeps a measured control disabled until native arm acceptance commits', () => {
    expect(isMeasuredInputReady(0, 'idle')).toBe(false);
    expect(isMeasuredInputReady(0, 'arming')).toBe(false);
    expect(isMeasuredInputReady(0, 'armed')).toBe(true);
  });

  it('does not expose the measured control during unrecorded warm-ups', () => {
    expect(isMeasuredInputReady(1, 'idle')).toBe(false);
    expect(isMeasuredInputReady(1, 'armed')).toBe(false);
  });
});
