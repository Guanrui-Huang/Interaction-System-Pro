import { expect, it } from 'vitest';
import { VOICE_MAX_SPEECH_ANSWER_CHARS } from '../../shared/voice';
import {
  MAX_SPEECH_ANSWERS,
  SPEECH_ANSWER_TTL_MS,
  SpeechAnswerLimitError,
  SpeechAnswerRegistry,
} from '../src/services/voice/speech-answer-registry';
import { splitSpeechText } from '../src/services/voice/text-segmenter';

it('isolates speech by report, uses opaque IDs, and removes one report without touching another', () => {
  let id = 0;
  const registry = new SpeechAnswerRegistry({ createId: () => `opaque-${++id}` });
  const protectedText = '只属于 A 的讲解';
  const speechA = registry.register('report-a', protectedText);
  const speechB = registry.register('report-b', '只属于 B 的讲解');

  expect(registry.get('report-a', speechA)).toBe(protectedText);
  expect(registry.get('report-b', speechA)).toBeUndefined();
  expect(speechA).not.toContain('report-a');
  expect(speechA).not.toContain(protectedText);

  registry.removeReport('report-a');
  expect(registry.get('report-a', speechA)).toBeUndefined();
  expect(registry.get('report-b', speechB)).toBe('只属于 B 的讲解');
});

it('uses the report absolute lifetime as a hard TTL and evicts the oldest entry at capacity', () => {
  let now = 0;
  let id = 0;
  const registry = new SpeechAnswerRegistry({
    now: () => now,
    createId: () => `speech-${++id}`,
    maxEntries: 2,
  });
  expect(SPEECH_ANSWER_TTL_MS).toBe(2 * 60 * 60 * 1_000);
  expect(MAX_SPEECH_ANSWERS).toBe(4_096);
  expect(registry.register('report-a', '答案一')).toBe('speech-1');
  expect(registry.register('report-a', '答案二')).toBe('speech-2');
  expect(registry.register('report-b', '答案三')).toBe('speech-3');
  expect(registry.get('report-a', 'speech-1')).toBeUndefined();
  expect(registry.get('report-b', 'speech-3')).toBe('答案三');
  now = SPEECH_ANSWER_TTL_MS;
  expect(registry.get('report-b', 'speech-3')).toBeUndefined();
});

it('accepts the exact Unicode answer boundary and rejects invalid report IDs and extra text', () => {
  let id = 0;
  const registry = new SpeechAnswerRegistry({ createId: () => `speech-${++id}` });
  const exact = '😀'.repeat(VOICE_MAX_SPEECH_ANSWER_CHARS);

  const speechId = registry.register('report-a', exact);
  expect(registry.get('report-a', speechId)).toBe(exact);
  expect(() => registry.register('report-a', `${exact}甲`)).toThrow(SpeechAnswerLimitError);
  expect(() => registry.register('   ', '答案')).toThrow(SpeechAnswerLimitError);
  expect(id).toBe(1);
});

it('rejects an answer at the character cap when real sentence splitting produces 65 segments', () => {
  let id = 0;
  const registry = new SpeechAnswerRegistry({ createId: () => `speech-${++id}` });
  const segmentationOverflow = `。${'甲'.repeat(VOICE_MAX_SPEECH_ANSWER_CHARS - 1)}`;

  expect(Array.from(segmentationOverflow)).toHaveLength(VOICE_MAX_SPEECH_ANSWER_CHARS);
  expect(splitSpeechText(segmentationOverflow)).toHaveLength(65);
  expect(() => registry.register('report-a', segmentationOverflow)).toThrow(SpeechAnswerLimitError);
  expect(id).toBe(0);
});
