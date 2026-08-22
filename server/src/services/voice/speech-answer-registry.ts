import { randomUUID } from 'node:crypto';
import {
  VOICE_MAX_SPEECH_ANSWER_CHARS,
  VOICE_MAX_SYNTHESIS_SEGMENTS,
  VOICE_OPAQUE_ID_MAX_CHARS,
} from '../../../../shared/voice';
import { splitSpeechText } from './text-segmenter';

export const SPEECH_ANSWER_TTL_MS = 2 * 60 * 60 * 1_000;
export const MAX_SPEECH_ANSWERS = 4_096;

type Entry = {
  reportId: string;
  createdAt: number;
  answer: string;
};

type Options = {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
  createId?: () => string;
};

export class SpeechAnswerLimitError extends Error {
  constructor() {
    super('SPEECH_ANSWER_LIMIT_EXCEEDED');
    this.name = 'SpeechAnswerLimitError';
  }
}

function validOpaqueId(value: string): boolean {
  return value === value.trim() && value.length > 0
    && Array.from(value).length <= VOICE_OPAQUE_ID_MAX_CHARS;
}

export function assertSpeechAnswerWithinLimit(answer: string): void {
  if (!answer.trim() || Array.from(answer).length > VOICE_MAX_SPEECH_ANSWER_CHARS) {
    throw new SpeechAnswerLimitError();
  }
  const segments = splitSpeechText(answer);
  if (segments.length < 1 || segments.length > VOICE_MAX_SYNTHESIS_SEGMENTS) {
    throw new SpeechAnswerLimitError();
  }
}

export class SpeechAnswerRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(options: Options = {}) {
    this.ttlMs = options.ttlMs ?? SPEECH_ANSWER_TTL_MS;
    this.maxEntries = options.maxEntries ?? MAX_SPEECH_ANSWERS;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  register(reportId: string, answer: string): string {
    if (!validOpaqueId(reportId)) throw new SpeechAnswerLimitError();
    assertSpeechAnswerWithinLimit(answer);
    const now = this.now();
    this.removeExpired(now);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.entries.delete(oldest);
    }
    const speechId = this.createId();
    if (!validOpaqueId(speechId) || this.entries.has(speechId)) {
      throw new SpeechAnswerLimitError();
    }
    this.entries.set(speechId, { reportId, createdAt: now, answer });
    return speechId;
  }

  get(reportId: string, speechId: string): string | undefined {
    if (!validOpaqueId(reportId) || !validOpaqueId(speechId)) return undefined;
    this.removeExpired(this.now());
    const entry = this.entries.get(speechId);
    return entry?.reportId === reportId ? entry.answer : undefined;
  }

  remove(reportId: string, speechId: string): boolean {
    const entry = this.entries.get(speechId);
    return entry?.reportId === reportId ? this.entries.delete(speechId) : false;
  }

  removeReport(reportId: string): void {
    for (const [speechId, entry] of this.entries) {
      if (entry.reportId === reportId) this.entries.delete(speechId);
    }
  }

  private removeExpired(now: number): void {
    for (const [speechId, entry] of this.entries) {
      if (now - entry.createdAt >= this.ttlMs) this.entries.delete(speechId);
    }
  }
}
