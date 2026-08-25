export type SubtitleCue = { text: string; start: number; end: number };

export const DEFAULT_SUBTITLE_UNITS = 36;

const SENTENCE_BOUNDARIES = new Set(['。', '！', '？', '；', '.', '!', '?', ';']);
const PHRASE_BOUNDARIES = new Set(['，', '、', '：', ',', ':', ' ']);

type TextRange = { start: number; end: number };

const MEASUREMENT_ATOM_PATTERN =
  /[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[ \t]*(?:个百分点|个样本|kWh\/m³|kWh\/d|mg\/L|kg\/d|m³|万元|亿元|kWh|kg|mg|元|分|吨|个|次|天|日|%|‰|℃))?/gu;

function codePointLength(text: string): number {
  return [...text].length;
}

function measurementAtomRanges(text: string): TextRange[] {
  return [...text.matchAll(MEASUREMENT_ATOM_PATTERN)].map((match) => {
    const utf16Start = match.index ?? 0;
    const start = codePointLength(text.slice(0, utf16Start));
    return { start, end: start + codePointLength(match[0]) };
  });
}

function atomContainingCut(ranges: readonly TextRange[], cut: number): TextRange | undefined {
  return ranges.find(({ start, end }) => start < cut && cut < end);
}

function displayUnits(text: string): number {
  return [...text].reduce((units, character) => units + (character.charCodeAt(0) <= 0x7f ? 0.5 : 1), 0);
}

function boundaryIndex(text: string, boundaries: Set<string>, maxUnits: number, first = false): number {
  let units = 0;
  let lastBoundary = -1;
  const atoms = measurementAtomRanges(text);

  for (const [index, character] of [...text].entries()) {
    units += displayUnits(character);
    const cut = index + 1;
    if (boundaries.has(character) && units <= maxUnits && !atomContainingCut(atoms, cut)) {
      if (first) return cut;
      lastBoundary = cut;
    }
    if (units > maxUnits) break;
  }

  return lastBoundary;
}

function hardCutIndex(text: string, maxUnits: number): number {
  let units = 0;
  let index = 0;

  for (const character of [...text]) {
    const nextUnits = units + displayUnits(character);
    if (index > 0 && nextUnits > maxUnits) break;
    units = nextUnits;
    index += 1;
  }

  const proposed = Math.max(1, index);
  const atom = atomContainingCut(measurementAtomRanges(text), proposed);
  if (!atom) return proposed;
  return atom.start > 0 ? atom.start : atom.end;
}
function splitAtPreferredBoundaries(text: string, maxUnits: number): string[] {
  const safeMaxUnits = Math.max(0.5, maxUnits);
  const chunks: string[] = [];
  let remaining = text;

  while (remaining) {
    const sentenceCut = boundaryIndex(remaining, SENTENCE_BOUNDARIES, safeMaxUnits, true);
    if (sentenceCut > 0) {
      chunks.push([...remaining].slice(0, sentenceCut).join(''));
      remaining = [...remaining].slice(sentenceCut).join('');
      continue;
    }

    if (displayUnits(remaining) <= safeMaxUnits) {
      chunks.push(remaining);
      break;
    }

    const phraseCut = boundaryIndex(remaining, PHRASE_BOUNDARIES, safeMaxUnits);
    const cut = phraseCut > 0 ? phraseCut : hardCutIndex(remaining, safeMaxUnits);
    chunks.push([...remaining].slice(0, cut).join(''));
    remaining = [...remaining].slice(cut).join('');
  }

  return chunks;
}

export function splitSubtitleCues(text: string, maxUnits = DEFAULT_SUBTITLE_UNITS): SubtitleCue[] {
  if (!text.trim()) return [];
  const source = text;
  const chunks = splitAtPreferredBoundaries(source, maxUnits);
  const totalUnits = Math.max(1, chunks.reduce((sum, chunk) => sum + displayUnits(chunk), 0));
  let consumed = 0;
  return chunks.map((chunk) => {
    const start = consumed / totalUnits;
    consumed += displayUnits(chunk);
    return { text: chunk, start, end: consumed / totalUnits };
  });
}

export function cueTextAtProgress(cues: readonly SubtitleCue[], progress: number): string {
  if (cues.length === 0) return '';
  const normalized = Math.max(0, Math.min(1, progress));
  return cues.find((cue, index) => normalized < cue.end || index === cues.length - 1)?.text ?? '';
}
