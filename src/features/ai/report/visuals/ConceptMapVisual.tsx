import type { VisualSpec } from '../../../../../shared/report';
import type { VisualMode } from './VisualRenderer';
import { VisualDataTable, VisualFrame } from './visual-utils';

type ConceptMapSpec = Extract<VisualSpec, { kind: 'concept-map' }>;

export function ConceptMapVisual({ visual, mode }: { visual: ConceptMapSpec; mode: VisualMode }) {
  const titles = new Map(visual.nodes.map((node) => [node.id, node.title]));
  const relations = visual.edges.map((edge) => {
    const source = titles.get(edge.from) ?? '未命名概念';
    const target = titles.get(edge.to) ?? '未命名概念';
    const label = edge.label ?? '关联';
    return { source, target, label, description: `${source} → ${target}（${label}）` };
  });
  const ariaLabel = `概念关系图：${visual.nodes.map((node) => node.title).join('、')}${relations.length > 0 ? `。关系：${relations.map(({ description }) => description).join('；')}` : ''}`;
  const rows = [
    ...visual.nodes.map((node) => ({ label: node.title, value: node.detail ?? '概念节点' })),
    ...relations.map((relation) => ({ label: `关系：${relation.source} → ${relation.target}`, value: relation.label })),
  ];
  return (
    <VisualFrame ariaLabel={ariaLabel} table={<VisualDataTable label="概念关系数据表" rows={rows} />}>
      <div className={`report-concept-map report-concept-map--${mode}`}>
        <div className="report-concept-map__nodes">
          {visual.nodes.map((node) => <article className="report-concept-map__node" key={node.id}><strong>{node.title}</strong>{node.detail && <span>{node.detail}</span>}</article>)}
        </div>
        {relations.length > 0 && (
          <ol className="report-concept-map__relations" aria-label="概念关系">
            {relations.map((relation, index) => (
              <li className="report-concept-map__relation" key={`${visual.edges[index]!.from}-${visual.edges[index]!.to}-${index}`}>
                <span className="report-concept-map__source">{relation.source}</span>
                <span className="report-concept-map__arrow" aria-hidden="true">→</span>
                <span className="report-concept-map__target">{relation.target}</span>
                <em>{relation.label}</em>
              </li>
            ))}
          </ol>
        )}
      </div>
    </VisualFrame>
  );
}
