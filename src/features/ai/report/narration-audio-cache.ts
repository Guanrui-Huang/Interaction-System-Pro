import { loadSpeech, type LoadSpeechRequest, type SpeechAudio } from './report-speech-client';

export const NARRATION_CACHE_MAX_ENTRIES = 8;
export const NARRATION_CACHE_MAX_BYTES = 32 * 1024 * 1024;

export class NarrationAudioCacheCapacityError extends Error {
  readonly code = 'NARRATION_CACHE_CAPACITY';

  constructor() {
    super('Narration audio cache has no safely evictable entry');
    this.name = 'NarrationAudioCacheCapacityError';
  }
}

type Loader = (request: LoadSpeechRequest) => Promise<SpeechAudio>;

type CacheEntry = {
  reportId: string;
  speechId: string;
  controller: AbortController;
  promise: Promise<SpeechAudio>;
  audio?: SpeechAudio;
  consumers: number;
  playing: boolean;
  lastUsed: number;
};

type Options = {
  loader?: Loader;
  maxEntries?: number;
  maxBytes?: number;
};

export class NarrationAudioCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly loader: Loader;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private clock = 0;
  private storedBytes = 0;

  constructor(options: Options = {}) {
    this.loader = options.loader ?? loadSpeech;
    this.maxEntries = options.maxEntries ?? NARRATION_CACHE_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? NARRATION_CACHE_MAX_BYTES;
  }

  get entryCount(): number { return this.entries.size; }
  get byteLength(): number { return this.storedBytes; }

  load(reportId: string, speechId: string, signal: AbortSignal): Promise<SpeechAudio> {
    const key = this.key(reportId, speechId);
    const current = this.entries.get(key);
    if (current) {
      current.lastUsed = ++this.clock;
      return this.forConsumer(key, current, signal);
    }
    if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    if (!this.ensureCapacityForMiss()) {
      return Promise.reject(new NarrationAudioCacheCapacityError());
    }

    const controller = new AbortController();
    const entry: CacheEntry = {
      reportId,
      speechId,
      controller,
      promise: Promise.resolve(undefined as never),
      consumers: 0,
      playing: false,
      lastUsed: ++this.clock,
    };
    let loaded: Promise<SpeechAudio>;
    try {
      loaded = this.loader({ reportId, speechId, signal: controller.signal });
    } catch (error) {
      loaded = Promise.reject(error);
    }
    const promise = loaded
      .then((audio) => {
        if (this.entries.get(key) !== entry || controller.signal.aborted) return audio;
        entry.audio = audio;
        this.storedBytes += audio.byteLength;
        entry.lastUsed = ++this.clock;
        this.evictToBounds();
        return audio;
      }, (error: unknown) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      });
    entry.promise = promise;
    this.entries.set(key, entry);
    const consumer = this.forConsumer(key, entry, signal);
    this.evictToBounds();
    return consumer;
  }

  markPlaying(reportId: string, speechId: string, playing: boolean): void {
    const entry = this.entries.get(this.key(reportId, speechId));
    if (!entry) return;
    entry.playing = playing;
    entry.lastUsed = ++this.clock;
    if (!playing) this.evictToBounds();
  }

  clearReport(reportId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.reportId !== reportId) continue;
      this.deleteEntry(key, entry);
    }
  }

  clear(): void {
    for (const [key, entry] of this.entries) this.deleteEntry(key, entry);
  }

  private key(reportId: string, speechId: string): string {
    return `${reportId}:${speechId}`;
  }

  private forConsumer(key: string, entry: CacheEntry, signal: AbortSignal): Promise<SpeechAudio> {
    if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    entry.consumers += 1;
    return new Promise<SpeechAudio>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        entry.consumers = Math.max(0, entry.consumers - 1);
        callback();
        this.evictToBounds();
      };
      const abort = () => {
        finish(() => reject(new DOMException('Aborted', 'AbortError')));
        if (entry.consumers === 0 && entry.audio === undefined && this.entries.get(key) === entry) {
          this.deleteEntry(key, entry);
        }
      };
      signal.addEventListener('abort', abort, { once: true });
      entry.promise.then(
        (audio) => finish(() => resolve(audio)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  private evictToBounds(): void {
    while (this.entries.size > this.maxEntries || this.storedBytes > this.maxBytes) {
      const candidate = this.evictionCandidate();
      if (!candidate) return;
      this.deleteEntry(candidate[0], candidate[1]);
    }
  }

  private ensureCapacityForMiss(): boolean {
    while (this.entries.size >= this.maxEntries) {
      const candidate = this.evictionCandidate();
      if (!candidate) return false;
      this.deleteEntry(candidate[0], candidate[1]);
    }
    return true;
  }

  private evictionCandidate(): [string, CacheEntry] | undefined {
    return [...this.entries.entries()]
      .filter(([, entry]) => !entry.playing && entry.consumers === 0)
      .sort(([, left], [, right]) => left.lastUsed - right.lastUsed)[0];
  }

  private deleteEntry(key: string, entry: CacheEntry): void {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    entry.controller.abort();
    if (entry.audio) this.storedBytes = Math.max(0, this.storedBytes - entry.audio.byteLength);
  }
}
