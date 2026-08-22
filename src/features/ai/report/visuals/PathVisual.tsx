import type { VisualSpec } from '../../../../../shared/report';
import { VisualDataTable, VisualFrame } from './visual-utils';

type PathSpec = Extract<VisualSpec, { kind: 'process-flow' | 'recommendation-path' }>;

export function PathVisual({ visual }: { visual: PathSpec }) {
  const label = visual.kind === 'process-flow' ? '处理流程' : '建议路径';
  return (
    <VisualFrame ariaLabel={`${label}：${visual.steps.map((step) => step.title).join('、')}`} table={<VisualDataTable label={`${label}数据表`} rows={visual.steps.map((step, index) => ({ label: `步骤 ${index + 1} ${step.title}`, value: step.detail }))} />}>
      <ol className="report-path">
        {visual.steps.map((step, index) => <li key={step.id}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{step.title}</strong><p>{step.detail}</p></div></li>)}
      </ol>
      <p className="report-path__provenance">非现场运行数据 · 模型知识说明</p>
    </VisualFrame>
  );
}
