import type { SlideOutline } from '../../../shared/report';
import type { ReportEvidenceBundle } from './report-evidence';
import { reportEvidenceCatalog } from './report-content-validation';

export type UnnumberedSlideOutline = Omit<SlideOutline, 'id' | 'order' | 'status'>;

export const LARGE_SCREEN_METRIC_COLUMNS = 4;
export const LARGE_SCREEN_METRIC_ROWS = 2;
export const LARGE_SCREEN_METRICS_PER_PAGE = LARGE_SCREEN_METRIC_COLUMNS * LARGE_SCREEN_METRIC_ROWS;
export const LARGE_SCREEN_ALERTS_PER_PAGE = 5;
export const LARGE_SCREEN_RADAR_AXES_PER_PAGE = 6;

function balancedGroups(keys: readonly string[], maximum: number): string[][] {
  const groupCount = Math.ceil(keys.length / maximum);
  if (groupCount <= 1) return [[...keys]];

  const base = Math.floor(keys.length / groupCount);
  const remainder = keys.length % groupCount;
  const groups: string[][] = [];
  let offset = 0;

  for (let index = 0; index < groupCount; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    groups.push(keys.slice(offset, offset + size));
    offset += size;
  }

  return groups;
}

function numbered(value: string, index: number, count: number): string {
  return count === 1 ? value : `${value}（${index + 1}/${count}）`;
}

export function paginateLargeScreenOutlines(
  outlines: readonly UnnumberedSlideOutline[],
  bundle: ReportEvidenceBundle,
): UnnumberedSlideOutline[] {
  const descriptors = new Map(reportEvidenceCatalog(bundle).map((item) => [item.key, item]));
  const directMetricKeys = new Set<string>(bundle.analysis?.scope.metrics ?? []);

  return outlines.flatMap((outline) => {
    const candidates = outline.visualKind === 'alert-timeline'
      ? outline.evidenceKeys.filter((key) => descriptors.get(key)?.kind === 'alert')
      : outline.visualKind === 'trend-line' || outline.visualKind === 'trend-area'
        ? outline.evidenceKeys.filter((key) => directMetricKeys.has(key))
        : outline.evidenceKeys.filter((key) => {
            const descriptor = descriptors.get(key);
            return descriptor?.kind === 'metric' || descriptor?.kind === 'health-weight';
          });
    const maximum = outline.visualKind === 'alert-timeline'
      ? LARGE_SCREEN_ALERTS_PER_PAGE
      : outline.visualKind === 'radar'
        ? LARGE_SCREEN_RADAR_AXES_PER_PAGE
        : LARGE_SCREEN_METRICS_PER_PAGE;

    if (candidates.length <= maximum) {
      return [{ ...outline, evidenceKeys: [...outline.evidenceKeys] }];
    }

    const groups = balancedGroups(candidates, maximum);
    const candidateSet = new Set(candidates);
    const shared = outline.evidenceKeys.filter((key) => !candidateSet.has(key));

    return groups.map((group, index) => {
      const selected = new Set([...group, ...shared]);
      return {
        ...outline,
        title: numbered(outline.title, index, groups.length),
        purpose: numbered(outline.purpose, index, groups.length),
        evidenceKeys: outline.evidenceKeys.filter((key) => selected.has(key)),
      };
    });
  });
}
