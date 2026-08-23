export type PlayableSpeech = { segments: ArrayBuffer[]; durationMs?: number };

export type AudioSegmentPlayer = {
  play(speech: PlayableSpeech, options?: { offsetMs?: number }): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  durationMs(): number;
  positionMs(): number;
  onEnded(listener: () => void): () => void;
  /** Compatibility for the existing one-answer VoiceInteraction stream. */
  enqueue(bytes: ArrayBuffer): Promise<void>;
  /** Compatibility for the existing one-answer VoiceInteraction progress. */
  onSegmentEnded(listener: () => void): () => void;
};

type AudioSegmentPlayerOptions = {
  createAudioContext?: () => AudioContext;
};

type QueueItem = {
  buffer: AudioBuffer;
  offsetSeconds: number;
  absoluteStartMs: number;
  speech: boolean;
};

function browserAudioContext(): AudioContext {
  const browser = globalThis as typeof globalThis & {
    webkitAudioContext?: new () => AudioContext;
  };
  const AudioContextConstructor = browser.AudioContext ?? browser.webkitAudioContext;
  if (!AudioContextConstructor) throw new Error('Web Audio is unavailable');
  return new AudioContextConstructor();
}

class WebAudioSegmentPlayer implements AudioSegmentPlayer {
  private readonly context: AudioContext;
  private readonly segmentListeners = new Set<() => void>();
  private readonly endedListeners = new Set<() => void>();
  private readonly queuedBuffers: QueueItem[] = [];
  private decodeQueue: Promise<void> = Promise.resolve();
  private activeSource: AudioBufferSourceNode | null = null;
  private activeItem: QueueItem | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopped = false;
  private userPaused = false;
  private speechDurationMs = 0;
  private positionBaseMs = 0;
  private positionStartedAt = 0;
  private speechEnded = false;
  private generation = 0;

  constructor(createAudioContext: () => AudioContext) {
    this.context = createAudioContext();
  }

  async play(speech: PlayableSpeech, options: { offsetMs?: number } = {}): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.clearCurrentSource();
    this.queuedBuffers.length = 0;
    this.speechEnded = false;
    const encoded = speech.segments.map((segment) => segment.slice(0));
    const buffers = await Promise.all(encoded.map((segment) => this.context.decodeAudioData(segment)));
    if (this.stopped || generation !== this.generation) return;
    if (this.context.state === 'suspended' && !this.userPaused) await this.context.resume();
    if (this.stopped || generation !== this.generation) return;

    const decodedDurationMs = buffers.reduce((total, buffer) => total + buffer.duration * 1_000, 0);
    this.speechDurationMs = decodedDurationMs;
    const rawOffset = Number.isFinite(options.offsetMs) ? Number(options.offsetMs) : 0;
    const offsetMs = Math.min(Math.max(0, rawOffset), decodedDurationMs);
    this.positionBaseMs = offsetMs;
    this.positionStartedAt = this.context.currentTime;
    if (buffers.length === 0 || offsetMs >= decodedDurationMs) {
      this.finishSpeech();
      return;
    }

    let elapsedMs = 0;
    let startIndex = 0;
    for (; startIndex < buffers.length; startIndex += 1) {
      const next = elapsedMs + buffers[startIndex]!.duration * 1_000;
      if (offsetMs < next) break;
      elapsedMs = next;
    }
    for (let index = startIndex; index < buffers.length; index += 1) {
      const buffer = buffers[index]!;
      const offsetSeconds = index === startIndex ? (offsetMs - elapsedMs) / 1_000 : 0;
      this.queuedBuffers.push({
        buffer,
        offsetSeconds,
        absoluteStartMs: index === startIndex ? offsetMs : elapsedMs,
        speech: true,
      });
      elapsedMs += buffer.duration * 1_000;
    }
    this.scheduleNext();
  }

  enqueue(bytes: ArrayBuffer): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const encodedAudio = bytes.slice(0);
    const decode = this.decodeQueue.then(async () => {
      if (this.stopped) return;
      const decodedAudio = await this.context.decodeAudioData(encodedAudio);
      if (this.stopped) return;
      if (this.context.state === 'suspended' && !this.userPaused) {
        await this.context.resume();
        if (this.userPaused && (this.context.state as AudioContextState) === 'running') {
          await this.context.suspend();
        }
      }
      if (this.stopped) return;
      this.queuedBuffers.push({ buffer: decodedAudio, offsetSeconds: 0, absoluteStartMs: 0, speech: false });
      this.scheduleNext();
    });
    this.decodeQueue = decode.catch(() => undefined);
    return decode;
  }

  async pause(): Promise<void> {
    this.userPaused = true;
    if (!this.stopped && this.context.state === 'running') await this.context.suspend();
  }

  async resume(): Promise<void> {
    this.userPaused = false;
    if (!this.stopped && this.context.state === 'suspended') await this.context.resume();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.generation += 1;
    this.queuedBuffers.length = 0;
    this.clearCurrentSource();
    this.segmentListeners.clear();
    this.endedListeners.clear();
    this.stopPromise = this.context.state === 'closed'
      ? Promise.resolve()
      : this.context.close().catch(() => undefined);
    return this.stopPromise;
  }

  positionMs(): number {
    if (!this.activeItem?.speech) return Math.max(0, this.positionBaseMs);
    const elapsed = Math.max(0, (this.context.currentTime - this.positionStartedAt) * 1_000);
    return Math.min(this.speechDurationMs, this.positionBaseMs + elapsed);
  }

  durationMs(): number {
    return this.speechDurationMs;
  }

  onEnded(listener: () => void): () => void {
    if (this.stopped) return () => undefined;
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  onSegmentEnded(listener: () => void): () => void {
    if (this.stopped) return () => undefined;
    this.segmentListeners.add(listener);
    return () => this.segmentListeners.delete(listener);
  }

  private clearCurrentSource(): void {
    const source = this.activeSource;
    this.activeSource = null;
    this.activeItem = null;
    if (!source) return;
    source.onended = null;
    try { source.stop(); } catch { /* already ended */ }
    source.disconnect();
  }

  private scheduleNext(): void {
    if (this.stopped || this.activeSource || this.queuedBuffers.length === 0) return;
    const item = this.queuedBuffers.shift()!;
    const source = this.context.createBufferSource();
    source.buffer = item.buffer;
    source.connect(this.context.destination);
    source.onended = () => {
      if (this.stopped || this.activeSource !== source) return;
      source.onended = null;
      source.disconnect();
      this.activeSource = null;
      this.activeItem = null;
      if (item.speech) {
        this.positionBaseMs = Math.min(
          this.speechDurationMs,
          item.absoluteStartMs + (item.buffer.duration - item.offsetSeconds) * 1_000,
        );
        this.positionStartedAt = this.context.currentTime;
      } else {
        for (const listener of [...this.segmentListeners]) listener();
      }
      if (this.queuedBuffers.length > 0) this.scheduleNext();
      else if (item.speech) this.finishSpeech();
    };
    this.activeSource = source;
    this.activeItem = item;
    if (item.speech) {
      this.positionBaseMs = item.absoluteStartMs;
      this.positionStartedAt = this.context.currentTime;
      source.start(0, item.offsetSeconds);
    } else {
      source.start();
    }
  }

  private finishSpeech(): void {
    if (this.speechEnded || this.stopped) return;
    this.speechEnded = true;
    this.positionBaseMs = this.speechDurationMs;
    for (const listener of [...this.endedListeners]) listener();
  }
}

export function createAudioSegmentPlayer(options: AudioSegmentPlayerOptions = {}): AudioSegmentPlayer {
  return new WebAudioSegmentPlayer(options.createAudioContext ?? browserAudioContext);
}
