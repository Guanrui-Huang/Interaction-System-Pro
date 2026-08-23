import { expect, it } from 'vitest';
import { cueTextAtProgress, splitSubtitleCues } from '../features/ai/report/narration-subtitle-cues';

it('splits narration at Chinese sentence punctuation before applying the one-line budget', () => {
  const text = '出水水质得分最新值为96分，期间峰值为96分，出现在2025-08。电耗得分最新值为90分。';
  const cues = splitSubtitleCues(text, 36);

  expect(cues.map(({ text: cue }) => cue)).toEqual([
    '出水水质得分最新值为96分，期间峰值为96分，出现在2025-08。',
    '电耗得分最新值为90分。',
  ]);
  expect(cues.every(({ text: cue }) => cue.length > 0)).toBe(true);
  expect(cues.map(({ text: cue }) => cue).join('')).toBe(text);
});

it('splits an overlong phrase without dropping text or punctuation', () => {
  const text = '本页查看2025年8月9日至2026年8月9日的出水水质得分，共366个样本。';
  const cues = splitSubtitleCues(text, 18);

  expect(cues.map(({ text: cue }) => cue).join('')).toBe(text);
  expect(cues.every(({ text: cue }) => cue.length <= 18)).toBe(true);
});

it('maps normalized playback progress to exactly one visible cue', () => {
  const cues = splitSubtitleCues('第一句。第二句。第三句。', 36);

  expect(cueTextAtProgress(cues, 0)).toBe('第一句。');
  expect(cueTextAtProgress(cues, 0.5)).toBe('第二句。');
  expect(cueTextAtProgress(cues, 1)).toBe('第三句。');
});
