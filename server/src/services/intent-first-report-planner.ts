import { randomUUID } from 'node:crypto';
import type { BusinessPage } from '../../../shared/dashboard';
import {
  ATOMIC_VISUAL_KINDS,
  REPORT_MAX_SLIDES,
  type SlideOutline,
} from '../../../shared/report';
import { redactAnalysisText } from '../domain/analysis-evidence';
import {
  ReportContentValidationError,
  UnsafeReportContentError,
  assertSafeReportContent,
  parseModelReportPlanStructure,
  reportEvidenceCatalog,
  validateModelReportPlan,
} from '../domain/report-content-validation';
import type { ReportEvidenceBundle } from '../domain/report-evidence';
import { paginateLargeScreenOutlines } from '../domain/report-layout-budget';
import {
  requestDeepSeekCompletion,
  type DeepSeekCompletionRequest,
  type DeepSeekSettings,
} from './deepseek-client';
import {
  StructuredModelOutputShapeError,
  parseStructuredModelOutput,
} from './structured-model-output';

export const REPORT_PLANNER_TIMEOUT_MS = 30_000;

export type ReportPlanningInput = {
  question: string;
  originPage: BusinessPage;
  evidence: ReportEvidenceBundle;
  signal?: AbortSignal;
};

export type ReportPlanningDependencies = {
  settings: DeepSeekSettings;
  fetchImpl?: typeof fetch;
  requestCompletion?: (input: DeepSeekCompletionRequest) => Promise<string>;
  createSlideId?: (order: number) => string;
};

function outputShape(): string {
  return `{"slides":[{"title":"...","purpose":"...","role":"answer|evidence|cause|risk|knowledge|action","layout":"visual-focus|split-insight|dual-evidence|concept-center|action-path|diagnostic-overview","visualKind":"${ATOMIC_VISUAL_KINDS.join('|')}","evidenceKeys":["known-key"]}]}`;
}

const VISUAL_EVIDENCE_RULES = [
  '可视化证据硬约束：scatter 必须且只能绑定 2 个 Excel metric；health-ring 必须且只能绑定 1 个 metric；trend-line/trend-area 的 Excel metric 都必须至少有 2 个时间点；alert-timeline 的 Excel 证据只能是 alert；process-flow/recommendation-path/concept-map/capability-map 必须包含 model-knowledge（身份页除外）。',
  '同一页需要分析 3 个以上指标时，拆成多页或改用 kpi-grid、comparison-bars、radar，不得把 3 个以上指标放入 scatter。',
  '大屏容量硬约束：目标画布为 1920×1080，每行最多 4 个指标卡、单页最多 2 行指标卡；指标超过单页物理容量时规划连续页面，所有相关指标必须在某一页出现，不得只保留前 3 项或前 4 项。',
  '无滚动硬约束：一页只安排一个主图和最多两个辅助图；流程、建议、告警或知识项目较多时按完整语义组拆页，不得依赖页面滚动或缩小到不可读。',
  '现场数据页采用图表优先：有至少两个时间点时优先 trend-area/trend-line；有至少两个同单位可比值时优先 comparison-bars；得分或百分比可使用 health-ring/radar。',
  '只在证据无法形成趋势、比较、评分、关联或告警图时选择 kpi-grid。不要返回 data-dashboard；组合图表由服务端根据不可变证据生成。',
] as const;

function buildPrompt(input: ReportPlanningInput, sensitiveValues: readonly string[]): string {
  const safeQuestion = redactAnalysisText(input.question, sensitiveValues);
  const catalog = reportEvidenceCatalog(input.evidence);
  return [
    '你是意图优先的动态报告规划器。只输出一个严格 JSON 对象，不输出解释或可执行代码。',
    `question: ${safeQuestion}`,
    `originPage: ${input.originPage}`,
    `immutableSnapshotId: ${input.evidence.snapshotId}`,
    `availableEvidence: ${JSON.stringify(catalog)}`,
    `输出必须严格匹配：${outputShape()}`,
    '根据问题复杂度规划真实需要的 1–12 页；一页足以时只返回一页。',
    '每页 purpose 必须独立且不重复；evidenceKeys 只能使用 availableEvidence 中的 key。',
    ...VISUAL_EVIDENCE_RULES,
    '当 availableEvidence 包含 assistant-profile 且问题询问助手或模型身份时，身份页必须使用 capability-map，evidenceKeys 必须精确为 ["assistant-profile"]。',
    '模型不得返回 id、order、evidencePolicy、数值序列、样式、标记或其他字段。',
  ].join('\n');
}

function buildRepairPrompt(input: {
  content: string;
  issues: readonly string[];
  evidence: ReportEvidenceBundle;
  sensitiveValues: readonly string[];
}): string {
  return [
    '将下面内容修复为严格 JSON。只修复 JSON 语法、字段结构或语义约束，包括重复页、未知证据和可视化与证据不兼容；不得编造事实。',
    `allowedShape: ${outputShape()}`,
    `availableEvidence: ${JSON.stringify(reportEvidenceCatalog(input.evidence))}`,
    ...VISUAL_EVIDENCE_RULES,
    '当 availableEvidence 包含 assistant-profile 且问题询问助手或模型身份时，身份页必须使用 capability-map，evidenceKeys 必须精确为 ["assistant-profile"]。',
    `issues: ${JSON.stringify(input.issues.map((issue) => redactAnalysisText(issue, input.sensitiveValues)))}`,
    `originalOutput: ${redactAnalysisText(input.content, input.sensitiveValues)}`,
  ].join('\n');
}

export async function planReport(
  input: ReportPlanningInput,
  dependencies: ReportPlanningDependencies,
): Promise<SlideOutline[]> {
  const requestCompletion = dependencies.requestCompletion ?? requestDeepSeekCompletion;
  const sensitiveValues = [
    dependencies.settings.apiKey,
    dependencies.settings.baseUrl,
    dependencies.settings.model,
  ];
  const request = (prompt: string) => requestCompletion({
    settings: dependencies.settings,
    prompt: redactAnalysisText(prompt, sensitiveValues),
    temperature: 0,
    timeoutMs: REPORT_PLANNER_TIMEOUT_MS,
    fetchImpl: dependencies.fetchImpl,
    signal: input.signal,
    responseFormat: { type: 'json_object' },
  });

  const content = await request(buildPrompt(input, sensitiveValues));
  const validated = await parseStructuredModelOutput({
    content,
    parse: (candidate) => {
      assertSafeReportContent([candidate], sensitiveValues, 'REPORT_OUTLINE_INVALID');
      const plan = parseModelReportPlanStructure(candidate);
      try {
        return validateModelReportPlan(plan, input.evidence, sensitiveValues);
      } catch (error) {
        if (error instanceof UnsafeReportContentError) throw error;
        if (!(error instanceof ReportContentValidationError)) throw error;
        throw new StructuredModelOutputShapeError([
          '语义约束：标题和 purpose 不得重复，evidenceKeys 必须存在，visualKind 必须与证据类型兼容',
        ]);
      }
    },
    repair: ({ content: malformed, issues }) => request(buildRepairPrompt({
      content: malformed,
      issues,
      evidence: input.evidence,
      sensitiveValues,
    })),
    invalidError: () => new ReportContentValidationError('REPORT_OUTLINE_INVALID'),
  });
  const paginated = paginateLargeScreenOutlines(validated, input.evidence);
  if (paginated.length > REPORT_MAX_SLIDES) {
    throw new ReportContentValidationError('REPORT_OUTLINE_INVALID');
  }
  const createSlideId = dependencies.createSlideId ?? (() => randomUUID());
  return paginated.map((slide, order) => ({
    ...slide,
    id: createSlideId(order),
    order,
    status: 'planned',
  }));
}
