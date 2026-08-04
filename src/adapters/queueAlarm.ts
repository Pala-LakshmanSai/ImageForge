export interface QueueAlarmPort {
  test(): Promise<void>;
  ring(): Promise<void>;
  stop(): void;
  dispose(): void;
}

type AudioContextConstructor = new () => AudioContext;

export class WebAudioQueueAlarm implements QueueAlarmPort {
  #context: AudioContext | null = null;
  #timer: number | null = null;
  #nodes = new Set<OscillatorNode>();

  async test(): Promise<void> {
    await this.#ensureContext();
    this.#beep(0.32);
  }

  async ring(): Promise<void> {
    const context = await this.#ensureContext();
    if (context.state !== 'running') throw new Error('Audio is blocked until the user interacts with ImageForge.');
    this.stop();
    this.#beep(0.48);
    this.#timer = window.setInterval(() => this.#beep(0.48), 1_250);
  }

  stop(): void {
    if (this.#timer !== null) window.clearInterval(this.#timer);
    this.#timer = null;
    for (const node of this.#nodes) {
      try { node.stop(); } catch { /* already stopped */ }
      node.disconnect();
    }
    this.#nodes.clear();
  }

  dispose(): void {
    this.stop();
    const context = this.#context;
    this.#context = null;
    if (context !== null) void context.close().catch(() => undefined);
  }

  async #ensureContext(): Promise<AudioContext> {
    const constructor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext);
    if (constructor === undefined) throw new Error('This system cannot play the ImageForge alarm.');
    this.#context ??= new constructor();
    if (this.#context.state !== 'running') await this.#context.resume();
    if (this.#context.state !== 'running') throw new Error('Audio is blocked until the user interacts with ImageForge.');
    return this.#context;
  }

  #beep(duration: number): void {
    const context = this.#context;
    if (context === null || context.state !== 'running') return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(740, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(520, context.currentTime + duration);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    this.#nodes.add(oscillator);
    oscillator.addEventListener('ended', () => {
      oscillator.disconnect();
      gain.disconnect();
      this.#nodes.delete(oscillator);
    }, { once: true });
    oscillator.start();
    oscillator.stop(context.currentTime + duration);
  }
}
