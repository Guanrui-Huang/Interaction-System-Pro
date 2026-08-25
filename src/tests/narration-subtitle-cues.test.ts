import { expect, it } from 'vitest';
import { cueTextAtProgress, splitSubtitleCues } from '../features/ai/report/narration-subtitle-cues';

const displayUnits = (text: string) => [...text].reduce(
  (units, character) => units + (character.charCodeAt(0) <= 0x7f ? 0.5 : 1),
  0,
);

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
  expect(cues.every(({ text: cue }) => displayUnits(cue) <= 18)).toBe(true);
});

it('uses display units rather than character count for ASCII hard cuts', () => {
  const text = 'abcdefgh';
  const cues = splitSubtitleCues(text, 2.5);

  expect(cues.map(({ text: cue }) => cue)).toEqual(['abcde', 'fgh']);
  expect(cues.map(({ text: cue }) => cue).join('')).toBe(text);
});

it('keeps a punctuation boundary when it fits the display-unit budget', () => {
  const text = 'abcd。下一句';
  const cues = splitSubtitleCues(text, 3);

  expect(cues[0]?.text).toBe('abcd。');
  expect(cues.map(({ text: cue }) => cue).join('')).toBe(text);
});

it('preserves leading and trailing whitespace in non-empty source text', () => {
  const text = '  第一句。第二句。  ';
  const cues = splitSubtitleCues(text, 36);

  expect(cues.map(({ text: cue }) => cue).join('')).toBe(text);
});

it('maps normalized playback progress to exactly one visible cue', () => {
  const cues = splitSubtitleCues('第一句。第二句。第三句。', 36);

  expect(cueTextAtProgress(cues, 0)).toBe('第一句。');
  expect(cueTextAtProgress(cues, 0.5)).toBe('第二句。');
  expect(cueTextAtProgress(cues, 1)).toBe('第三句。');
});

it.each([
  ['decimal measurement', '2.68 mg/L'],
  ['percentage', '99.80%'],
  ['percentage-point change', '0.42 个百分点'],
  ['negative energy value', '-0.125 kWh/m³'],
  ['thousands-separated amount', '1,300.50 万元'],
])('keeps a complete %s in one subtitle cue', (_label, measurement) => {
  const text = `前文说明，${measurement}，后文继续。`;
  const cues = splitSubtitleCues(text, 4);

  expect(cues.some(({ text: cue }) => cue.includes(measurement))).toBe(true);
  expect(cues.map(({ text: cue }) => cue).join('')).toBe(text);
});

it('moves a measurement atom to the next cue instead of hard-cutting it', () => {
  const text = '前文说明，1,300.50 万元，后文。';
  const cues = splitSubtitleCues(text, 4);

  expect(cues.map(({ text: cue }) => cue)).toContain('1,300.50 万元');
  expect(displayUnits('1,300.50 万元')).toBeGreaterThan(4);
  expect(cues.map(({ text: cue }) => cue).join('')).toBe(text);
});

it.each([
  ['daily flow', '123.45 m³/d'],
  ['compliance rate', '123.45%'],
  ['score', '123.45 分'],
  ['water quality', '123.45 mg/L'],
  ['daily electricity', '123.45 kWh/d'],
  ['electricity intensity', '123.45 kWh/m³'],
  ['daily savings', '123.45 元/d'],
  ['daily carbon source', '123.45 kg/d'],
  ['daily carbon dioxide equivalent', '123.45 kgCO₂e/d'],
])('keeps the complete production unit for %s in one subtitle cue', (_label, measurement) => {
  const text = `前文说明，${measurement}，后文继续。`;
  const cues = splitSubtitleCues(text, 4);

  expect(cues.some(({ text: cue }) => cue.includes(measurement))).toBe(true);
  expect(cues.map(({ text: cue }) => cue).join('')).toBe(text);
});
it('still treats a real ASCII full stop as a sentence boundary', () => {
  const cues = splitSubtitleCues('结论完整.下一句继续.', 36);

  expect(cues.map(({ text }) => text)).toEqual(['结论完整.', '下一句继续.']);
});
