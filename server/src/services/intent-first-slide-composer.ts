import type {
  ReportSlide,
  SlideOutline,
} from '../../../shared/report';
import { redactAnalysisText, type AnalysisEvidence } from '../domain/analysis-evidence';
import {
  PersistentSafeSlideOutputError,
  ReportContentValidationError,
  UnsafeReportContentError,
  assertSafeReportContent,
  bindReportVisual,
  boundMetricsForReport,
  deepFreezeReportValue,
  parseModelSlideDraftStructure,
  validateModelSlideDraft,
} from '../domain/report-content-validation';
import type { ReportEvidenceBundle } from '../domain/report-evidence';
import {
  DeepSeekServiceError,
  requestDeepSeekCompletion,
  type DeepSeekCompletionRequest,
  type DeepSeekSettings,
} from './deepseek-client';
import {
  StructuredModelOutputShapeError,
  parseStructuredModelOutput,
} from './structured-model-output';

export const SLIDE_COMPOSER_TIMEOUT_MS = 90_000;

export type SlideComposerInput = {
  outline: SlideOutline;
  evidence: ReportEvidenceBundle;
  previousTakeaway?: string;
  signal?: AbortSignal;
};

export type SlideComposerDependencies = {
  settings: DeepSeekSettings;
  fetchImpl?: typeof fetch;
  requestCompletion?: (input: DeepSeekCompletionRequest) => Promise<string>;
};

function alertIndex(key: string): number | undefined {
  const match = /^alert:(\d+)$/u.exec(key);
  return match ? Number(match[1]) : undefined;
}

function derivationOperands(key: string): string[] {
  const [kind, first, second, extra] = key.split(':');
  if (extra !== undefined) return [];
  if (kind === 'percent-change' && first && second === undefined) return [first];
  if ((kind === 'difference' || kind === 'share') && first && second) return [first, second];
  return [];
}

function analysisSubset(analysis: AnalysisEvidence, keys: readonly string[]) {
  const metricKeys = new Set([
    ...keys.filter((key) => analysis.scope.metrics.includes(key)),
    ...keys.flatMap(derivationOperands),
  ]);
  return {
    scope: { ...analysis.scope, metrics: analysis.scope.metrics.filter((key) => metricKeys.has(key)) },
    definitions: analysis.definitions.filter(({ key }) => metricKeys.has(key)),
    series: analysis.series.map(({ date, values }) => ({
      date,
      values: Object.fromEntries(Object.entries(values).filter(([key]) => metricKeys.has(key))),
    })),
    aggregates: Object.fromEntries(Object.entries(analysis.aggregates).filter(([key]) => metricKeys.has(key))),
    thresholdBreaches: analysis.thresholdBreaches.filter(({ metric }) => metricKeys.has(metric)),
    correlations: analysis.correlations.filter(({ left, right }) => metricKeys.has(left) && metricKeys.has(right)),
    alerts: keys.flatMap((key) => {
      const index = alertIndex(key);
      const alert = index === undefined ? undefined : analysis.alerts[index];
      return alert ? [{ key, ...alert }] : [];
    }),
    ...(analysis.healthWeights ? {
      healthWeights: Object.fromEntries(Object.entries(analysis.healthWeights).filter(([key]) => keys.includes(`health-weight:${key}`))),
    } : {}),
    ...(analysis.caveat ? { caveat: analysis.caveat } : {}),
  };
}

function referencedEvidence(input: SlideComposerInput) {
  return {
    snapshotId: input.evidence.snapshotId,
    ...(input.evidence.analysis ? { analysis: analysisSubset(input.evidence.analysis, input.outline.evidenceKeys) } : {}),
    knowledge: input.evidence.knowledge.filter(({ key }) => input.outline.evidenceKeys.includes(key)),
    userCorrections: (input.evidence.userCorrections ?? [])
      .filter(({ key }) => input.outline.evidenceKeys.includes(key)),
    ...(input.outline.evidenceKeys.includes('assistant-profile') && input.evidence.assistantProfile
      ? { assistantProfile: input.evidence.assistantProfile }
      : {}),
  };
}

function outputShape(input: SlideComposerInput): string {
  const evidenceKeys = JSON.stringify(input.outline.evidenceKeys);
  const claimEvidenceKeys = JSON.stringify(input.outline.evidenceKeys.slice(0, 1));
  const needsKnowledgeItems = [
    'process-flow', 'recommendation-path', 'concept-map', 'capability-map',
  ].includes(input.outline.visualKind);
  return `{"title":"...","takeaway":"...","takeawayClaimIds":["claim-1"],"visualKind":"${input.outline.visualKind}","evidenceKeys":${evidenceKeys},"claims":[{"id":"claim-1","text":"...","kind":"knowledge|onsite-fact|hypothesis|user-provided","evidenceKeys":${claimEvidenceKeys}}],"narration":[{"text":"...","claimIds":["claim-1"]},{"text":"...","claimIds":["claim-1"]}]${needsKnowledgeItems ? ',"knowledgeItems":[{"title":"...","detail":"..."}]' : ''}}`;
}

const CLAIM_EVIDENCE_RULES = [
  '证据类型硬约束：onsite-fact 的 evidenceKeys 必须全部是 Excel（metric 或 alert），不得混入 model-knowledge；knowledge 不得包含任何现场数字、单位、日期或状态，也不得引用 Excel。',
  '指标限值必须引用同一 Excel metric 的 definition.limit；不得为了写限值改引 model-knowledge。定义知识与现场判断必须拆成不同 claim，再由 takeawayClaimIds/narration.claimIds 同时引用。',
  'alert 只允许原样复述 reason、recommendation、date、metric、level；不得把同时出现或波动改写成“导致、主因、驱动”等因果结论。相关系数也只说明统计关联，不得推断因果。',
  '数字语义必须逐项对应：sampleCount 只能写样本数，thresholdBreaches.length 只能写超标次数，definition.limit 只能写限值，aggregate.latest/average/min/max 只能写相应统计角色。',
  'claim 文本点名或比较的每个指标，都必须逐一出现在该 claim.evidenceKeys 中；例如同时写“鼓风能耗与总电耗”，就必须同时引用 blowerKwh 与 totalKwh。',
  '只可使用 referencedEvidence 直接列出的 series 日值、aggregate、correlation、thresholdBreaches 和 alert；不得自行按周、按月或按季度重算派生数值。无法用直接证据纠正的 claim 必须删除，并同步移除 takeawayClaimIds、narration 文字与 claimIds 中的引用。',
] as const;

function narrationRules(order: number): readonly string[] {
  return order === 0
    ? [
        '这是整份汇报的第一页。仅 narration[0] 可以说明一次数据时间范围与样本数；若本页没有现场数据，不得编造开场。',
        '第一页后续 narration 段不得重复页面背景、时间范围、样本总数或证据来源套话，必须直接进入指标分析。',
        '同页各段必须互补，分别讲指标现状、变化、风险或建议。',
      ]
    : [
        '这是整份汇报的后续页。后续页所有 narration 段必须直接进入指标分析。',
        '不得使用“本页查看/本页展示/本页分析/本页覆盖……共 N 个样本”等页面介绍句，不得重复时间范围、样本总数或证据来源套话。',
        '同页各段必须互补，分别讲指标现状、变化、风险或建议。',
      ];
}

function buildPrompt(input: SlideComposerInput): string {
  return [
    '你是证据约束的单页报告撰稿器。只输出一个严格 JSON 对象，不输出解释或可执行代码。',
    `outline: ${JSON.stringify({
      title: input.outline.title,
      order: input.outline.order,
      purpose: input.outline.purpose,
      role: input.outline.role,
      layout: input.outline.layout,
      visualKind: input.outline.visualKind,
      evidenceKeys: input.outline.evidenceKeys,
    })}`,
    `referencedEvidence: ${JSON.stringify(referencedEvidence(input))}`,
    `previousTakeaway: ${JSON.stringify(input.previousTakeaway ?? '')}`,
    `输出必须严格匹配：${outputShape(input)}`,
    '页面 visualKind 必须与 outline.visualKind 完全一致；页面 evidenceKeys 必须按原顺序精确等于 outline.evidenceKeys。',
    '每条 claim.evidenceKeys 只能从 outline.evidenceKeys 选择直接支撑该 claim 的最小子集。narration 必须提供 2–4 段。',
    'takeawayClaimIds 与每段 narration.claimIds 必须覆盖文本中所有现场数字与事实对应的 claim。',
    '现场日期只能原样使用 referencedEvidence 中的 YYYY-MM-DD 起止日期；不得改写为中文日期。所有现场数字和单位必须与引用证据完全一致，数字不得使用千位分隔符。',
    '每条 onsite-fact 必须在自己的 evidenceKeys 中引用 Excel 证据；user-provided 只能引用 user-correction 并明确写明用户提供且未经现场数据核验；knowledge 不得声称现场数值；hypothesis 必须明确表达不确定性。',
    ...CLAIM_EVIDENCE_RULES,
    ...narrationRules(input.outline.order),
    '只返回文本、claim 引用和知识项；不得返回 id、order、evidencePolicy、图表数值对象、样式或额外字段。',
  ].join('\n');
}

function buildRepairPrompt(input: {
  content: string;
  issues: readonly string[];
  composerInput: SlideComposerInput;
  sensitiveValues: readonly string[];
}): string {
  return [
    '将下面内容修复为严格 JSON。只修复 JSON 语法、字段结构或语义约束；只可依据不可变证据纠正 claim、引用和结论，不得编造事实。',
    `allowedShape: ${outputShape(input.composerInput)}`,
    `outline: ${JSON.stringify({
      visualKind: input.composerInput.outline.visualKind,
      order: input.composerInput.outline.order,
      evidenceKeys: input.composerInput.outline.evidenceKeys,
    })}`,
    `referencedEvidence: ${JSON.stringify(referencedEvidence(input.composerInput))}`,
    ...CLAIM_EVIDENCE_RULES,
    ...narrationRules(input.composerInput.outline.order),
    `issues: ${JSON.stringify(input.issues.map((issue) => redactAnalysisText(issue, input.sensitiveValues)))}`,
    `originalOutput: ${redactAnalysisText(input.content, input.sensitiveValues)}`,
  ].join('\n');
}

function validOutline(outline: SlideOutline): boolean {
  return Boolean(
    outline.id.trim()
    && outline.title.trim()
    && outline.purpose.trim()
    && Number.isInteger(outline.order)
    && outline.order >= 0
  );
}

export async function composeSlide(
  input: SlideComposerInput,
  dependencies: SlideComposerDependencies,
): Promise<ReportSlide> {
  if (!validOutline(input.outline)) throw new ReportContentValidationError('REPORT_OUTLINE_INVALID');
  const requestCompletion = dependencies.requestCompletion ?? requestDeepSeekCompletion;
  const sensitiveValues = [
    dependencies.settings.apiKey,
    dependencies.settings.baseUrl,
    dependencies.settings.model,
  ];
  const request = (prompt: string, transportRetry: 'allowed' | 'disabled' = 'allowed') => requestCompletion({
    settings: dependencies.settings,
    prompt: redactAnalysisText(prompt, sensitiveValues),
    temperature: 0,
    timeoutMs: SLIDE_COMPOSER_TIMEOUT_MS,
    fetchImpl: dependencies.fetchImpl,
    signal: input.signal,
    responseFormat: { type: 'json_object' },
    transportRetry,
  });

  const content = await request(buildPrompt(input));
  const allowedPublicValues = input.outline.evidenceKeys.includes('assistant-profile')
    && input.evidence.assistantProfile?.publicModelName
    ? [input.evidence.assistantProfile.publicModelName]
    : [];
  let latestSafeFailureCode: 'REPORT_SLIDE_DRAFT_INVALID' | 'REPORT_EVIDENCE_INVALID' | undefined;
  const prepared = await (async () => {
    try {
      return await parseStructuredModelOutput({
        content,
        parse: (candidate) => {
          assertSafeReportContent(
            [candidate],
            sensitiveValues,
            'REPORT_SLIDE_DRAFT_INVALID',
            allowedPublicValues,
          );
          latestSafeFailureCode = 'REPORT_SLIDE_DRAFT_INVALID';
          const draft = parseModelSlideDraftStructure(candidate);
          try {
            const validated = validateModelSlideDraft({
              draft,
              outline: input.outline,
              bundle: input.evidence,
              sensitiveValues,
            });
            const visual = bindReportVisual(
              draft.visualKind,
              draft.evidenceKeys,
              input.evidence,
              draft.knowledgeItems,
              input.outline.id,
              validated.claims,
            );
            const metrics = boundMetricsForReport(draft.evidenceKeys, input.evidence, validated.claims);
            return { draft, validated, visual, metrics };
          } catch (error) {
            if (error instanceof UnsafeReportContentError) throw error;
            if (!(error instanceof ReportContentValidationError)) throw error;
            latestSafeFailureCode = error.code === 'REPORT_EVIDENCE_INVALID'
              ? 'REPORT_EVIDENCE_INVALID'
              : 'REPORT_SLIDE_DRAFT_INVALID';
            throw new StructuredModelOutputShapeError([
              '语义约束：visualKind 和顶层 evidenceKeys 必须等于 outline；现场数字、单位和 YYYY-MM-DD 日期必须来自 referencedEvidence 且不得使用千位分隔符；takeawayClaimIds 与 narration.claimIds 必须覆盖文本中所有事实',
            ]);
          }
        },
        repair: ({ content: malformed, issues }) => request(buildRepairPrompt({
          content: malformed,
          issues,
          composerInput: input,
          sensitiveValues,
        }), 'disabled'),
        invalidError: () => new PersistentSafeSlideOutputError(
          latestSafeFailureCode ?? 'REPORT_SLIDE_DRAFT_INVALID',
        ),
      });
    } catch (error) {
      const repairTransportFailed = error instanceof DeepSeekServiceError
        && (error.code === 'UPSTREAM_TIMEOUT'
          || error.code === 'UPSTREAM_HTTP'
          || error.code === 'MALFORMED_RESPONSE');
      if (latestSafeFailureCode && repairTransportFailed && !input.signal?.aborted) {
        throw new PersistentSafeSlideOutputError(latestSafeFailureCode);
      }
      throw error;
    }
  })();
  const { draft, validated, visual, metrics } = prepared;
  return deepFreezeReportValue({
    id: input.outline.id,
    order: input.outline.order,
    evidenceSnapshotId: input.evidence.snapshotId,
    role: input.outline.role,
    layout: input.outline.layout,
    evidencePolicy: validated.evidencePolicy,
    title: draft.title,
    takeaway: draft.takeaway,
    takeawayClaimIds: [...draft.takeawayClaimIds],
    claims: validated.claims,
    visual,
    metrics,
    evidenceRefs: validated.pageEvidenceRefs,
    narration: draft.narration.map((segment, index) => ({
      id: `${input.outline.id}-segment-${index + 1}`,
      text: segment.text,
      speechId: `${input.outline.id}-speech-${index + 1}`,
      claimIds: [...segment.claimIds],
    })),
  });
}
