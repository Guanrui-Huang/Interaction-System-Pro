import { expect, it } from 'vitest';
import {
  VOICE_MAX_SYNTHESIS_SEGMENTS,
  VOICE_TEXT_SEGMENT_MAX_CHARS,
} from '../../shared/voice';
import { splitSpeechText } from '../src/services/voice/text-segmenter';

it('splits on Chinese sentence boundaries without changing text or exceeding 280 characters', () => {
  const text = `${'甲'.repeat(170)}。${'乙'.repeat(170)}！结论完整。`;
  const segments = splitSpeechText(text);

  expect(segments.every((segment) => Array.from(segment).length <= 280)).toBe(true);
  expect(segments.join('')).toBe(text);
});

it('uses Unicode code points when it must hard-split text', () => {
  const text = `${'😀'.repeat(280)}甲`;

  expect(splitSpeechText(text)).toEqual(['😀'.repeat(280), '甲']);
});

it('keeps whitespace attached to its surrounding text and ignores whitespace-only input', () => {
  const text = `开头， ${'中'.repeat(278)}。\n结尾`;

  expect(splitSpeechText(text).join('')).toBe(text);
  expect(splitSpeechText(' \n\t ')).toEqual([]);
});

it('uses the shared text limit and produces at most the shared segment cap at the answer boundary', () => {
  const answer = '甲'.repeat(VOICE_TEXT_SEGMENT_MAX_CHARS * VOICE_MAX_SYNTHESIS_SEGMENTS);
  const segments = splitSpeechText(answer);

  expect(segments).toHaveLength(VOICE_MAX_SYNTHESIS_SEGMENTS);
  expect(segments.every((segment) => Array.from(segment).length === VOICE_TEXT_SEGMENT_MAX_CHARS)).toBe(true);
});
