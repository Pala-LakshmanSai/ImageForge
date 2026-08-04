import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebAudioQueueAlarm } from './queueAlarm';

const originalAudioContext = window.AudioContext;

class FakeOscillator {
  type = 'sine';
  frequency = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
  addEventListener = vi.fn();
}

class FakeGain {
  gain = {
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = 'suspended';
  currentTime = 10;
  destination = {} as AudioDestinationNode;
  oscillators: FakeOscillator[] = [];
  close = vi.fn(async () => { this.state = 'closed'; });
  resume = vi.fn(async () => { this.state = 'running'; });

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createOscillator() {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator as unknown as OscillatorNode;
  }

  createGain() {
    return new FakeGain() as unknown as GainNode;
  }
}

afterEach(() => {
  vi.useRealTimers();
  FakeAudioContext.instances = [];
  Object.defineProperty(window, 'AudioContext', { configurable: true, value: originalAudioContext });
});

describe('WebAudioQueueAlarm', () => {
  it('unlocks audio from the explicit test gesture', async () => {
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
    const alarm = new WebAudioQueueAlarm();
    await alarm.test();
    const context = FakeAudioContext.instances[0];
    expect(context.resume).toHaveBeenCalledOnce();
    expect(context.oscillators).toHaveLength(1);
    expect(context.oscillators[0].start).toHaveBeenCalledOnce();
  });

  it('rings on a bounded interval and cleans timers/nodes on stop and dispose', async () => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
    const alarm = new WebAudioQueueAlarm();
    await alarm.ring();
    const context = FakeAudioContext.instances[0];
    expect(vi.getTimerCount()).toBe(1);
    expect(context.oscillators).toHaveLength(1);
    vi.advanceTimersByTime(1_250);
    expect(context.oscillators).toHaveLength(2);
    alarm.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(context.oscillators.every((node) => node.stop.mock.calls.length >= 1)).toBe(true);
    alarm.dispose();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('keeps a visible error path when audio is unavailable', async () => {
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
    const alarm = new WebAudioQueueAlarm();
    await expect(alarm.test()).rejects.toThrow(/cannot play/i);
  });
});
