import type { EvidenceRef } from '../../../shared/report';
import { ANALYSIS_METRICS, type AnalysisMetricKey } from './analysis-plan';
import type { AnalysisEvidence } from './analysis-evidence';
import type { UserCorrectionEvidence } from './report-evidence';

export type FollowUpEvidenceBundle =
  | {
      snapshotId: string;
      mode: 'data';
      analysis: AnalysisEvidence;
      userCorrections?: UserCorrectionEvidence[];
    }
  | { snapshotId: string; mode: 'knowledge'; topic: string; limitation: '非现场运行数据' };

export class ReportFollowUpValidationError extends Error {
  constructor(readonly code: 'REPORT_EVIDENCE_INVALID' | 'REPORT_NUMERIC_CLAIM_INVALID') {
    super(code);
    this.name = 'ReportFollowUpValidationError';
  }
}

const DERIVATIONS = {
  difference: (left: number, right: number) => left - right,
  'percent-change': (first: number, latest: number) => (
    first === 0 ? null : ((latest - first) / Math.abs(first)) * 100
  ),
  share: (part: number, total: number) => total === 0 ? null : (part / total) * 100,
} as const;

function fail(code: ReportFollowUpValidationError['code']): never {
  throw new ReportFollowUpValidationError(code);
}

function metricDefinition(evidence: AnalysisEvidence, key: string) {
  return evidence.definitions.find((definition) => definition.key === key);
}

function metricAggregate(evidence: AnalysisEvidence, key: string) {
  return evidence.aggregates[key as AnalysisMetricKey];
}

function isMetricKey(evidence: AnalysisEvidence, key: string): key is AnalysisMetricKey {
  return Boolean(metricDefinition(evidence, key) && metricAggregate(evidence, key));
}

function alertIndex(key: string): number | undefined {
  const match = /^alert:(\d+)$/u.exec(key);
  return match ? Number(match[1]) : undefined;
}

function healthWeightName(key: string): string | undefined {
  return /^health-weight:(.+)$/u.exec(key)?.[1];
}

type ParsedDerivation = {
  kind: keyof typeof DERIVATIONS;
  operands: string[];
};

function parsedDerivation(key: string): ParsedDerivation | undefined {
  const [prefix, first, second] = key.split(':');
  if (prefix === 'percent-change' && first && second === undefined) {
    return { kind: prefix, operands: [first] };
  }
  if ((prefix === 'difference' || prefix === 'share') && first && second) {
    return { kind: prefix, operands: [first, second] };
  }
  return undefined;
}

function expectedDisplayUnits(evidenceKeys: readonly string[], bundle: FollowUpEvidenceBundle): string[] {
  if (bundle.mode !== 'data') return [];
  if (evidenceKeys.length === 0) return [...new Set(bundle.analysis.definitions.map(({ unit }) => unit))];
  const units = evidenceKeys.flatMap((key): string[] => {
    const correction = bundle.userCorrections?.find((candidate) => candidate.key === key);
    if (correction) return [correction.unit];
    const definition = metricDefinition(bundle.analysis, key);
    if (definition) return [definition.unit];
    if (healthWeightName(key) !== undefined) return ['%'];
    const derivation = parsedDerivation(key);
    if (!derivation) return [];
    if (derivation.kind === 'percent-change' || derivation.kind === 'share') return ['%'];
    const operandDefinition = metricDefinition(bundle.analysis, derivation.operands[0]!);
    return operandDefinition ? [operandDefinition.unit] : [];
  });
  return [...new Set(units)];
}

export function isKnownEvidenceKey(key: string, bundle: FollowUpEvidenceBundle): boolean {
  if (bundle.mode === 'knowledge') return key === `knowledge:${bundle.topic}`;
  if (bundle.userCorrections?.some((correction) => correction.key === key)) return true;
  if (isMetricKey(bundle.analysis, key)) return true;
  const alert = alertIndex(key);
  if (alert !== undefined) return Boolean(bundle.analysis.alerts[alert]);
  const weight = healthWeightName(key);
  if (weight !== undefined) {
    return typeof bundle.analysis.healthWeights?.[weight as keyof NonNullable<AnalysisEvidence['healthWeights']>] === 'number';
  }
  const derivation = parsedDerivation(key);
  return Boolean(derivation && derivation.operands.every((operand) => isMetricKey(bundle.analysis, operand)));
}

export function evidenceBundleForKeys(
  bundle: Extract<FollowUpEvidenceBundle, { mode: 'data' }>,
  evidenceKeys: readonly string[],
): Extract<FollowUpEvidenceBundle, { mode: 'data' }> {
  const directKeys = new Set<string>();
  for (const key of evidenceKeys) {
    const correction = bundle.userCorrections?.find((candidate) => candidate.key === key);
    if (correction) continue;
    if (isMetricKey(bundle.analysis, key)) directKeys.add(key);
    for (const operand of parsedDerivation(key)?.operands ?? []) directKeys.add(operand);
  }
  const analysis = bundle.analysis;
  const filtered: AnalysisEvidence = {
    scope: { ...analysis.scope, metrics: analysis.scope.metrics.filter((key) => directKeys.has(key)) },
    definitions: analysis.definitions.filter(({ key }) => directKeys.has(key)),
    series: analysis.series.map(({ date, values }) => ({
      date,
      values: Object.fromEntries(Object.entries(values).filter(([key]) => directKeys.has(key))),
    })),
    aggregates: Object.fromEntries(Object.entries(analysis.aggregates).filter(([key]) => directKeys.has(key))),
    thresholdBreaches: analysis.thresholdBreaches.filter(({ metric }) => directKeys.has(metric)),
    correlations: analysis.correlations.filter(({ left, right }) => directKeys.has(left) && directKeys.has(right)),
    alerts: evidenceKeys.flatMap((key) => {
      const index = alertIndex(key);
      const alert = index === undefined ? undefined : analysis.alerts[index];
      return alert ? [alert] : [];
    }),
    ...(analysis.healthWeights ? {
      healthWeights: Object.fromEntries(Object.entries(analysis.healthWeights).filter(([key]) => (
        evidenceKeys.includes(`health-weight:${key}`)
      ))) as AnalysisEvidence['healthWeights'],
    } : {}),
    ...(analysis.caveat ? { caveat: analysis.caveat } : {}),
  };
  const userCorrections = bundle.userCorrections?.filter(({ key }) => evidenceKeys.includes(key));
  const { userCorrections: _allCorrections, ...withoutCorrections } = bundle;
  return {
    ...withoutCorrections,
    analysis: filtered,
    ...(userCorrections?.length ? { userCorrections } : {}),
  };
}

function addFinite(target: number[], value: unknown): void {
  if (typeof value === 'number' && Number.isFinite(value)) target.push(value);
}

function analysisNumbers(evidence: AnalysisEvidence, declaredEvidenceKeys: readonly string[]): number[] {
  const values: number[] = [evidence.scope.sampleCount];
  for (const definition of evidence.definitions) addFinite(values, definition.limit);
  for (const row of evidence.series) {
    for (const value of Object.values(row.values)) addFinite(values, value);
  }
  for (const aggregate of Object.values(evidence.aggregates)) {
    if (!aggregate) continue;
    addFinite(values, aggregate.min);
    addFinite(values, aggregate.max);
    addFinite(values, aggregate.average);
    addFinite(values, aggregate.latest);
    addFinite(values, aggregate.changeRate);
    if (aggregate.changeRate !== null) addFinite(values, aggregate.changeRate * 100);
  }
  for (const breach of evidence.thresholdBreaches) {
    addFinite(values, breach.value);
    addFinite(values, breach.limit);
  }
  for (const correlation of evidence.correlations) {
    addFinite(values, correlation.coefficient);
    addFinite(values, correlation.samples);
  }
  if (evidence.healthWeights) {
    for (const weight of Object.values(evidence.healthWeights)) {
      addFinite(values, weight);
      addFinite(values, weight * 100);
    }
  }
  for (const key of declaredEvidenceKeys) {
    const derivation = parsedDerivation(key);
    if (!derivation || !derivation.operands.every((operand) => isMetricKey(evidence, operand))) continue;
    if (derivation.kind === 'percent-change') {
      const metricKey = derivation.operands[0]! as AnalysisMetricKey;
      const samples = evidence.series.map(({ values }) => values[metricKey])
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      const first = samples.at(0);
      const latest = samples.at(-1);
      if (first !== undefined && latest !== undefined) addFinite(values, DERIVATIONS['percent-change'](first, latest));
      continue;
    }
    const [left, right] = derivation.operands.map((operand) => metricAggregate(evidence, operand)?.latest);
    if (left === undefined || right === undefined) continue;
    addFinite(values, DERIVATIONS[derivation.kind](left, right));
  }
  return values;
}

function percentageNumbers(evidence: AnalysisEvidence, declaredEvidenceKeys: readonly string[]): number[] {
  const values: number[] = [];
  const percentKeys = new Set(evidence.definitions
    .filter(({ key, unit }) => unit === '%' && declaredEvidenceKeys.includes(key))
    .map(({ key }) => key));
  for (const definition of evidence.definitions) {
    if (percentKeys.has(definition.key)) addFinite(values, definition.limit);
  }
  for (const row of evidence.series) {
    for (const [key, value] of Object.entries(row.values)) {
      if (percentKeys.has(key as AnalysisMetricKey)) addFinite(values, value);
    }
  }
  for (const [key, aggregate] of Object.entries(evidence.aggregates)) {
    if (!aggregate || !percentKeys.has(key as AnalysisMetricKey)) continue;
    addFinite(values, aggregate.min);
    addFinite(values, aggregate.max);
    addFinite(values, aggregate.average);
    addFinite(values, aggregate.latest);
  }
  if (evidence.healthWeights) {
    for (const key of declaredEvidenceKeys) {
      const name = healthWeightName(key);
      if (name === undefined) continue;
      const weight = evidence.healthWeights[name as keyof NonNullable<AnalysisEvidence['healthWeights']>];
      if (weight !== undefined) addFinite(values, weight * 100);
    }
  }
  for (const key of declaredEvidenceKeys) {
    const derivation = parsedDerivation(key);
    if (!derivation || !['percent-change', 'share'].includes(derivation.kind)) continue;
    if (!derivation.operands.every((operand) => isMetricKey(evidence, operand))) continue;
    if (derivation.kind === 'percent-change') {
      const metricKey = derivation.operands[0]! as AnalysisMetricKey;
      const samples = evidence.series.map(({ values }) => values[metricKey])
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      const first = samples.at(0);
      const latest = samples.at(-1);
      if (first !== undefined && latest !== undefined) addFinite(values, DERIVATIONS['percent-change'](first, latest));
    } else {
      const [part, total] = derivation.operands.map((operand) => metricAggregate(evidence, operand)?.latest);
      if (part !== undefined && total !== undefined) addFinite(values, DERIVATIONS.share(part, total));
    }
  }
  return values;
}

const NUMERIC_TOKEN_PATTERN = /[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?%?/gu;
const PERCENT_CLAIM_PATTERN = /([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*%/gu;
const DECIMAL_DIGIT_PATTERN = /\p{Decimal_Number}/u;

function hasNonAsciiDecimalDigit(value: string): boolean {
  return [...value].some((character) => (
    DECIMAL_DIGIT_PATTERN.test(character) && !/[0-9]/u.test(character)
  ));
}

function numericTokensIn(value: string): string[] {
  return value.match(NUMERIC_TOKEN_PATTERN) ?? [];
}

function decimalPlaces(token: string): number {
  const mantissa = token.replace(/%$/u, '').split(/[eE]/u)[0]!;
  return mantissa.split('.')[1]?.length ?? 0;
}

function sameDisplayedNumber(token: string, evidenceValue: number): boolean {
  const numeric = Number(token.replace(/%$/u, ''));
  if (!Number.isFinite(numeric) || !Number.isFinite(evidenceValue)) return false;
  const precision = Math.min(decimalPlaces(token), 4);
  return Object.is(Number(numeric.toFixed(precision)), Number(evidenceValue.toFixed(precision)));
}

export function assertNumericClaims(
  textValue: string,
  bundle: FollowUpEvidenceBundle,
  declaredEvidenceKeys: readonly string[] = [],
): void {
  if (hasNonAsciiDecimalDigit(textValue)) return fail('REPORT_NUMERIC_CLAIM_INVALID');
  if (bundle.mode === 'data') {
    const hasServerEvidence = declaredEvidenceKeys.length === 0
      || declaredEvidenceKeys.some((key) => !bundle.userCorrections?.some((correction) => correction.key === key));
    const allowedDates = new Set(hasServerEvidence ? [
      bundle.analysis.scope.dateRange.from,
      bundle.analysis.scope.dateRange.to,
      ...bundle.analysis.series.map(({ date }) => date),
      ...bundle.analysis.thresholdBreaches.map(({ date }) => date),
      ...bundle.analysis.alerts.map(({ date }) => date),
    ] : []);
    const dates = textValue.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? [];
    if (dates.some((date) => !allowedDates.has(date))) return fail('REPORT_NUMERIC_CLAIM_INVALID');

    const allowedUnits = new Set(expectedDisplayUnits(declaredEvidenceKeys, bundle));
    const measurementUnits = textValue.match(/(?:mg\/L|kg\/L|g\/L|ppm|ppb|kWh(?:\/[\p{L}µμ³]+)?|kgCO₂e(?:\/[\p{L}µμ³]+)?|m³(?:\/d)?|kg(?:\/d)?|元\/d|条\/d|%|吨)/gu) ?? [];
    if (measurementUnits.some((unit) => !allowedUnits.has(unit))) return fail('REPORT_NUMERIC_CLAIM_INVALID');
  }
  const protectedText = textValue
    .replace(/\b\d{4}-\d{2}-\d{2}\b/gu, '')
    .replace(/第\s*\d+\s*(?:步|页|项|点)/gu, '');
  const tokens = numericTokensIn(protectedText);
  if (tokens.length === 0) return;
  if (bundle.mode !== 'data') return fail('REPORT_NUMERIC_CLAIM_INVALID');
  const corrections = bundle.userCorrections?.filter(({ key }) => declaredEvidenceKeys.includes(key)) ?? [];
  const hasServerEvidence = declaredEvidenceKeys.length === 0
    || declaredEvidenceKeys.some((key) => !bundle.userCorrections?.some((correction) => correction.key === key));
  const allowed = [
    ...(hasServerEvidence ? analysisNumbers(bundle.analysis, declaredEvidenceKeys) : []),
    ...corrections.map(({ value }) => value),
  ];
  const allowedPercentages = [
    ...(hasServerEvidence ? percentageNumbers(bundle.analysis, declaredEvidenceKeys) : []),
    ...corrections.filter(({ unit }) => unit === '%').map(({ value }) => value),
  ];
  const percentTokens = Array.from(protectedText.matchAll(PERCENT_CLAIM_PATTERN), (match) => match[1]!);
  if (percentTokens.some((token) => !allowedPercentages.some((value) => sameDisplayedNumber(token, value)))) {
    return fail('REPORT_NUMERIC_CLAIM_INVALID');
  }
  if (tokens.some((token) => !allowed.some((value) => sameDisplayedNumber(token, value)))) {
    return fail('REPORT_NUMERIC_CLAIM_INVALID');
  }
}

function evidenceRef(evidence: AnalysisEvidence, key: AnalysisMetricKey): EvidenceRef {
  const definition = metricDefinition(evidence, key)!;
  return {
    key,
    kind: 'metric',
    source: 'excel',
    module: ANALYSIS_METRICS[key].module,
    label: definition.label,
    unit: definition.unit,
    dateRange: { ...evidence.scope.dateRange },
    sampleCount: evidence.scope.sampleCount,
  };
}

export function evidenceRefsFor(evidenceKeys: readonly string[], bundle: FollowUpEvidenceBundle): EvidenceRef[] {
  if (bundle.mode === 'knowledge') {
    return [{ key: `knowledge:${bundle.topic}`, kind: 'knowledge', source: 'model-knowledge', label: bundle.topic }];
  }
  const refs: EvidenceRef[] = [];
  for (const key of evidenceKeys) {
    const correction = bundle.userCorrections?.find((candidate) => candidate.key === key);
    if (correction) {
      const definition = metricDefinition(bundle.analysis, correction.evidenceKey);
      refs.push({
        key: correction.key,
        kind: 'user-provided',
        source: 'user-correction',
        label: `${definition?.label ?? correction.evidenceKey}（用户提供·未核验）`,
        unit: correction.unit,
      });
      continue;
    }
    if (isMetricKey(bundle.analysis, key)) {
      refs.push(evidenceRef(bundle.analysis, key));
      continue;
    }
    const weightName = healthWeightName(key);
    if (weightName !== undefined && bundle.analysis.healthWeights?.[weightName as keyof NonNullable<AnalysisEvidence['healthWeights']>] !== undefined) {
      refs.push({
        key,
        kind: 'health-weight',
        source: 'excel',
        module: 'health',
        label: `${weightName}权重`,
        unit: '%',
        dateRange: { ...bundle.analysis.scope.dateRange },
        sampleCount: bundle.analysis.scope.sampleCount,
      });
      continue;
    }
    const index = alertIndex(key);
    const alert = index === undefined ? undefined : bundle.analysis.alerts[index];
    if (alert) {
      refs.push({
        key,
        kind: 'alert',
        source: 'excel',
        module: 'alerts',
        label: alert.metric,
        dateRange: { from: alert.date, to: alert.date },
        sampleCount: 1,
      });
    }
  }
  return refs;
}
