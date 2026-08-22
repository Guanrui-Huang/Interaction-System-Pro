import type { SlideOutline } from '../../../shared/report';
import type { ReportEvidenceBundle } from './report-evidence';
import {
  ReportContentValidationError,
  reportEvidenceCatalog,
} from './report-content-validation';

export type UnnumberedSlideOutline = Omit<SlideOutline, 'id' | 'order' | 'status'>;

export const LARGE_SCREEN_METRIC_COLUMNS = 4;
export const LARGE_SCREEN_METRIC_ROWS = 2;
export const LARGE_SCREEN_METRICS_PER_PAGE = LARGE_SCREEN_METRIC_COLUMNS * LARGE_SCREEN_METRIC_ROWS;
export const LARGE_SCREEN_ALERTS_PER_PAGE = 5;
export const LARGE_SCREEN_RADAR_AXES_PER_PAGE = 6;

function failOutline(): never {
  throw new ReportContentValidationError('REPORT_OUTLINE_INVALID');
}

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

function metricHostPriority(visualKind: UnnumberedSlideOutline['visualKind']): number {
  switch (visualKind) {
    case 'kpi-grid':
      return 0;
    case 'radar':
      return 1;
    case 'comparison-bars':
      return 2;
    case 'trend-line':
    case 'trend-area':
      return 3;
    default:
      return Number.POSITIVE_INFINITY;
  }
}

function directMetricKeysFor(
  outline: UnnumberedSlideOutline,
  directMetricKeys: ReadonlySet<string>,
): string[] {
  return outline.evidenceKeys.filter((key) => directMetricKeys.has(key));
}

function isScoreLikeMetric(key: string, unitByKey: ReadonlyMap<string, string | undefined>): boolean {
  const unit = unitByKey.get(key)?.trim();
  return unit === '分' || unit === '%' || /Score$/u.test(key);
}

function comparisonUnit(
  keys: readonly string[],
  unitByKey: ReadonlyMap<string, string | undefined>,
): string | undefined {
  const units = keys
    .map((key) => unitByKey.get(key)?.trim())
    .filter((unit): unit is string => Boolean(unit));
  if (units.length !== keys.length || !units.length) return undefined;
  return units.every((unit) => unit === units[0]) ? units[0] : undefined;
}

function canHostDirectMetric(input: {
  outline: UnnumberedSlideOutline;
  currentMetricKeys: readonly string[];
  candidateKey: string;
  pointCountByKey: ReadonlyMap<string, number>;
  unitByKey: ReadonlyMap<string, string | undefined>;
}): boolean {
  const candidatePointCount = input.pointCountByKey.get(input.candidateKey) ?? 0;
  switch (input.outline.visualKind) {
    case 'kpi-grid':
      return true;
    case 'trend-line':
    case 'trend-area':
      return candidatePointCount >= 2;
    case 'comparison-bars': {
      const currentUnit = comparisonUnit(input.currentMetricKeys, input.unitByKey);
      const candidateUnit = input.unitByKey.get(input.candidateKey)?.trim();
      return Boolean(currentUnit && candidateUnit && currentUnit === candidateUnit);
    }
    case 'radar':
      return input.currentMetricKeys.every((key) => isScoreLikeMetric(key, input.unitByKey))
        && isScoreLikeMetric(input.candidateKey, input.unitByKey);
    default:
      return false;
  }
}

function ensureMetricCoverage(
  outlines: readonly UnnumberedSlideOutline[],
  bundle: ReportEvidenceBundle,
): UnnumberedSlideOutline[] {
  const analysis = bundle.analysis;
  if (!analysis?.scope.metrics.length) return outlines.map((outline) => ({ ...outline, evidenceKeys: [...outline.evidenceKeys] }));

  const descriptors = new Map(reportEvidenceCatalog(bundle).map((item) => [item.key, item]));
  const requiredMetricKeys = analysis.scope.metrics.filter((key) => {
    const descriptor = descriptors.get(key);
    return descriptor?.source === 'excel' && descriptor.kind === 'metric';
  });
  if (requiredMetricKeys.length !== analysis.scope.metrics.length) failOutline();

  const directMetricKeySet = new Set<string>(requiredMetricKeys);
  const pointCountByKey = new Map(requiredMetricKeys.map((key) => [
    key,
    descriptors.get(key)?.seriesPoints ?? 0,
  ]));
  const unitByKey = new Map(requiredMetricKeys.map((key) => [key, descriptors.get(key)?.unit]));

  const coveredKeys = new Set(
    outlines.flatMap((outline) => directMetricKeysFor(outline, directMetricKeySet)),
  );
  const missingKeys = requiredMetricKeys.filter((key) => !coveredKeys.has(key));
  if (!missingKeys.length) return outlines.map((outline) => ({ ...outline, evidenceKeys: [...outline.evidenceKeys] }));

  const hostStates = outlines.map((outline, index) => ({
    outline,
    index,
    currentMetricKeys: directMetricKeysFor(outline, directMetricKeySet),
    additions: [] as string[],
  })).filter(({ outline, currentMetricKeys }) => (
    currentMetricKeys.length > 0 && Number.isFinite(metricHostPriority(outline.visualKind))
  ));

  for (const key of missingKeys) {
    const eligibleHosts = hostStates.filter(({ outline, currentMetricKeys, additions }) => (
      !currentMetricKeys.includes(key)
      && !additions.includes(key)
      && canHostDirectMetric({
        outline,
        currentMetricKeys: [...currentMetricKeys, ...additions],
        candidateKey: key,
        pointCountByKey,
        unitByKey,
      })
    ));
    if (!eligibleHosts.length) failOutline();
    eligibleHosts.sort((left, right) => (
      metricHostPriority(left.outline.visualKind) - metricHostPriority(right.outline.visualKind)
      || (left.currentMetricKeys.length + left.additions.length) - (right.currentMetricKeys.length + right.additions.length)
      || left.index - right.index
    ));
    eligibleHosts[0]!.additions.push(key);
  }

  const additionsByIndex = new Map(
    hostStates
      .filter(({ additions }) => additions.length)
      .map(({ index, additions }) => [index, additions]),
  );
  const coveredOutlines = outlines.map((outline, index) => {
    const additions = additionsByIndex.get(index);
    if (!additions?.length) return { ...outline, evidenceKeys: [...outline.evidenceKeys] };
    return {
      ...outline,
      evidenceKeys: [...outline.evidenceKeys, ...requiredMetricKeys.filter((key) => additions.includes(key))],
    };
  });

  const finalCoveredKeys = new Set(
    coveredOutlines.flatMap((outline) => directMetricKeysFor(outline, directMetricKeySet)),
  );
  if (requiredMetricKeys.some((key) => !finalCoveredKeys.has(key))) failOutline();
  return coveredOutlines;
}

export function paginateLargeScreenOutlines(
  outlines: readonly UnnumberedSlideOutline[],
  bundle: ReportEvidenceBundle,
): UnnumberedSlideOutline[] {
  const descriptors = new Map(reportEvidenceCatalog(bundle).map((item) => [item.key, item]));
  const directMetricKeys = new Set<string>(bundle.analysis?.scope.metrics ?? []);
  const coveredOutlines = ensureMetricCoverage(outlines, bundle);

  return coveredOutlines.flatMap((outline) => {
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
