import type { ReportPhase } from '../../../../shared/report';

const generationLabels: Record<ReportPhase, string> = {
  understanding: '正在理解问题',
  'retrieving-evidence': '正在检索相关数据',
  planning: '正在组织分析',
  'generating-first-slide': '正在生成首个页面',
  'generating-slides': '正在生成后续页面',
  completed: '页面生成完成',
};

export function ReportGenerationStatus({ phase }: { phase: ReportPhase | null }) {
  return (
    <section className="report-generation-status" role="status" aria-live="polite">
      <i aria-hidden="true" />
      <p>{phase ? generationLabels[phase] : '正在建立汇报任务'}</p>
      <span>将仅显示已完成的真实页面。</span>
    </section>
  );
}
