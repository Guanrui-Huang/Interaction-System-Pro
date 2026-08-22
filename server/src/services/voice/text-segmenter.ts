import { VOICE_TEXT_SEGMENT_MAX_CHARS } from '../../../../shared/voice';

const strongBoundaries = new Set(['。', '！', '？', '；']);
const weakBoundaries = new Set(['，', '、', '\n']);

export function splitSpeechText(text: string, maxLength = VOICE_TEXT_SEGMENT_MAX_CHARS): string[] {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
    throw new RangeError('maxLength must be a positive integer');
  }
  if (text.trim().length === 0) return [];

  const characters = Array.from(text);
  const segments: string[] = [];
  let start = 0;

  while (start < characters.length) {
    const end = Math.min(start + maxLength, characters.length);
    if (end === characters.length) {
      segments.push(characters.slice(start).join(''));
      break;
    }

    let strongBoundary = -1;
    let weakBoundary = -1;
    for (let index = start; index < end; index += 1) {
      if (strongBoundaries.has(characters[index])) strongBoundary = index;
      else if (weakBoundaries.has(characters[index])) weakBoundary = index;
    }

    const splitAt = (strongBoundary >= 0 ? strongBoundary : weakBoundary) + 1 || end;
    segments.push(characters.slice(start, splitAt).join(''));
    start = splitAt;
  }

  if (segments.join('') !== text) throw new Error('SPEECH_TEXT_SEGMENTATION_MISMATCH');
  return segments;
}
