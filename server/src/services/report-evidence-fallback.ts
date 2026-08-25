import type {
  BoundClaim,
  ReportEvidenceRef,
  ReportSlide,
  SlideOutline,
} from '../../../shared/report';
import type { AnalysisMetricKey } from '../domain/analysis-plan';
import {
  bindReportVisual,
  boundMetricsForReport,
  deepFreezeReportValue,
  reportEvidenceRefsFor,
} from '../domain/report-content-validation';
import type { ReportEvidenceBundle } from '../domain/report-evidence';

const KNOWLEDGE_VISUALS = new Set([
  'process-flow',
  'recommendation-path',
  'concept-map',
  'capability-map',
]);

type DirectMetricSummary = {
  claimText: string;
  headline: string;
  narration: {
    context: string;
    central: string;
    range: string;
  };
};

function naturalDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return value;
  return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`;
}

function displayNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function changeCopy(changeRate: number | null): string {
  if (changeRate === null) return '';
  const percentage = displayNumber(Math.abs(changeRate) * 100);
  if (changeRate > 0) return `与首个样本相比上升${percentage}%。`;
  if (changeRate < 0) return `与首个样本相比下降${percentage}%。`;
  return '与首个样本相比没有变化。';
}

function directMetricSummary(
  ref: ReportEvidenceRef,
  evidence: ReportEvidenceBundle,
): DirectMetricSummary | undefined {
  if (ref.source !== 'excel' || !evidence.analysis) return undefined;
  const definition = evidence.analysis.definitions.find(({ key }) => key === ref.key);
  if (!definition) return undefined;
  const metricKey = definition.key as AnalysisMetricKey;
  const aggregate = evidence.analysis.aggregates[metricKey];
  if (!aggregate) return undefined;
  const points = evidence.analysis.series.flatMap(({ date, values }) => {
    const value = values[metricKey];
    return Number.isFinite(value) ? [{ date, value: value as number }] : [];
  });
  if (!points.length) return undefined;

  const { from, to } = evidence.analysis.scope.dateRange;
  const sampleCount = ref.sampleCount ?? evidence.analysis.scope.sampleCount;
  const unit = definition.unit;
  const peak = points.find(({ value }) => value === aggregate.max);
  const context = `本页查看${naturalDate(from)}至${naturalDate(to)}的${definition.label}，共${sampleCount}个样本。`;
  const central = `最新值为${displayNumber(aggregate.latest)} ${unit}，平均值为${displayNumber(aggregate.average)} ${unit}。`;
  const range = `期间最低值为${displayNumber(aggregate.min)} ${unit}，峰值为${displayNumber(aggregate.max)} ${unit}${peak ? `，峰值出现在${naturalDate(peak.date)}` : ''}。${changeCopy(aggregate.changeRate)}`;

  return {
    claimText: `${context}${central}${range}`,
    headline: `${definition.label}最新值为${displayNumber(aggregate.latest)} ${unit}；期间峰值为${displayNumber(aggregate.max)} ${unit}${peak ? `，出现在${naturalDate(peak.date)}` : ''}。`,
    narration: { context, central, range },
  };
}

function narrationContext(
  outline: SlideOutline,
  summaryIndex: number,
  summary: DirectMetricSummary,
): string {
  return outline.order === 0 && summaryIndex === 0 ? summary.narration.context : '';
}

function assistantIdentityCopy(evidence: ReportEvidenceBundle): string | undefined {
  const profile = evidence.assistantProfile;
  if (!profile) return undefined;
  return profile.publicModelName
    ? `我是${profile.assistantName}，公开模型名称是${profile.publicModelName}。`
    : `我是${profile.assistantName}，${profile.capabilities[0] ?? '可提供受限证据范围内的分析'}。`;
}

function trustedFallbackTitle(
  refs: ReturnType<typeof reportEvidenceRefsFor>,
  evidence: ReportEvidenceBundle,
): string {
  if (refs.some(({ source }) => source === 'assistant-profile')) return '助手身份与能力';
  const excelLabels = [...new Set(refs
    .filter(({ source }) => source === 'excel')
    .map(({ label }) => label))].slice(0, 2);
  if (excelLabels.length) return `${excelLabels.join('与')}证据概览`;
  if (refs.some(({ source }) => source === 'user-correction')) return '用户修正信息';
  if (evidence.knowledge.length) return '知识要点分析';
  return '可用证据概览';
}

export function composeEvidenceFallbackSlide(
  outline: SlideOutline,
  evidence: ReportEvidenceBundle,
): ReportSlide {
  const refs = reportEvidenceRefsFor(outline.evidenceKeys, evidence);
  const identityCopy = assistantIdentityCopy(evidence);
  const directSummaries = refs.map((ref) => directMetricSummary(ref, evidence));
  const claims: BoundClaim[] = refs.map((ref, index) => ({
    id: `${outline.id}-fallback-claim-${index + 1}`,
    text: directSummaries[index]?.claimText ?? (ref.source === 'excel'
      ? '本项现场证据已完成绑定。'
      : ref.source === 'user-correction'
        ? '用户提供的修正已记录，未经现场数据核验。'
        : ref.source === 'assistant-profile' && identityCopy
          ? identityCopy
          : '本项知识内容来自本页绑定的模型知识。'),
    kind: ref.source === 'excel'
      ? 'onsite-fact'
      : ref.source === 'user-correction'
        ? 'user-provided'
        : 'knowledge',
    evidenceRefs: [ref],
  }));
  const claimIds = claims.map(({ id }) => id);
  const knowledgeItems = KNOWLEDGE_VISUALS.has(outline.visualKind)
    ? refs.filter(({ source }) => source !== 'excel' && source !== 'user-correction').map((_ref, index) => ({
        title: `知识要点 ${index + 1}`,
        detail: '该要点仅使用本页已绑定的可信知识证据。',
      }))
    : undefined;
  const visual = bindReportVisual(
    outline.visualKind,
    outline.evidenceKeys,
    evidence,
    knowledgeItems,
    outline.id,
    claims,
  );
  const metrics = boundMetricsForReport(outline.evidenceKeys, evidence, claims);
  const richSummaries = directSummaries.flatMap((summary, index) => summary
    ? [{ summary, claimId: claims[index]!.id }]
    : []);
  const takeaway = richSummaries.length
    ? richSummaries.slice(0, 2).map(({ summary }) => summary.headline).join(' ')
    : outline.evidenceKeys.includes('assistant-profile') && identityCopy
    ? identityCopy
    : outline.evidencePolicy === 'knowledge'
      ? '本页已按可信知识证据生成，关键内容见可视化。'
      : outline.evidencePolicy === 'mixed'
        ? '本页已按现场证据与知识证据生成，详细内容见可视化。'
        : '本页已按已验证的现场证据生成，详细数值见可视化。';
  const metricNarration: ReportSlide['narration'] = richSummaries.length === 1
    ? [
        {
          id: `${outline.id}-fallback-segment-1`,
          text: `${narrationContext(outline, 0, richSummaries[0]!.summary)}${richSummaries[0]!.summary.narration.central}`,
          speechId: `${outline.id}-fallback-speech-1`,
          claimIds: [richSummaries[0]!.claimId],
        },
        {
          id: `${outline.id}-fallback-segment-2`,
          text: richSummaries[0]!.summary.narration.range,
          speechId: `${outline.id}-fallback-speech-2`,
          claimIds: [richSummaries[0]!.claimId],
        },
      ]
    : richSummaries.slice(0, 3).map(({ summary, claimId }, index) => ({
        id: `${outline.id}-fallback-segment-${index + 1}`,
        text: `${narrationContext(outline, index, summary)}${summary.narration.central}${summary.narration.range}`,
        speechId: `${outline.id}-fallback-speech-${index + 1}`,
        claimIds: [claimId],
      }));

  const narration: ReportSlide['narration'] = richSummaries.length
    ? [
        ...metricNarration,
        {
          id: `${outline.id}-fallback-segment-${richSummaries.length === 1 ? 3 : Math.min(richSummaries.length, 3) + 1}`,
          text: '本页可以确认已绑定序列中的数值和时间，但不能仅凭这组数据判断波动原因。',
          speechId: `${outline.id}-fallback-speech-${richSummaries.length === 1 ? 3 : Math.min(richSummaries.length, 3) + 1}`,
          claimIds: richSummaries.slice(0, 3).map(({ claimId }) => claimId),
        },
      ]
    : [
        {
          id: `${outline.id}-fallback-segment-1`,
          text: takeaway,
          speechId: `${outline.id}-fallback-speech-1`,
          claimIds,
        },
        {
          id: `${outline.id}-fallback-segment-2`,
          text: '可视化仅展示本页已绑定的证据，不添加未经验证的现场结论。',
          speechId: `${outline.id}-fallback-speech-2`,
          claimIds,
        },
      ];

  return deepFreezeReportValue({
    id: outline.id,
    order: outline.order,
    evidenceSnapshotId: evidence.snapshotId,
    role: outline.role,
    layout: outline.layout,
    evidencePolicy: outline.evidencePolicy,
    title: trustedFallbackTitle(refs, evidence),
    takeaway,
    takeawayClaimIds: claimIds,
    claims,
    visual,
    metrics,
    evidenceRefs: refs,
    narration,
  });
}
