import { useState } from 'react';
import type { ReportSlide } from '../../../../shared/report';
import { formatReportNumber } from './visuals/visual-utils';

type EvidenceRow = { id: string; label: string; value: string; source: string };

function evidenceRows(slide: ReportSlide): EvidenceRow[] {
  const rows: EvidenceRow[] = slide.metrics.map((item) => ({
    id: `metric-${item.key}`,
    label: item.label,
    value: `${formatReportNumber(item.value)} ${item.unit ?? ''}`.trim(),
    source: item.source === 'excel' ? '现场数据快照' : '模型知识',
  }));
  const metricKeys = new Set(slide.metrics.map((item) => item.key));
  for (const item of slide.evidenceRefs) {
    if (!metricKeys.has(item.key)) rows.push({
      id: `ref-${item.key}`,
      label: item.label,
      value: item.dateRange ? `${item.dateRange.from} — ${item.dateRange.to}` : item.unit ?? '已绑定',
      source: item.source === 'excel' ? '现场数据快照' : '模型知识',
    });
  }
  if ('series' in slide.visual) {
    for (const series of slide.visual.series) {
      for (const point of series.points) rows.push({ id: `point-${series.key}-${point.label}`, label: `${series.label} · ${point.label}`, value: `${formatReportNumber(point.value)} ${series.unit}`, source: '已绑定视觉点' });
    }
  } else if (slide.visual.kind === 'scatter') {
    for (const point of slide.visual.points) rows.push({ id: `scatter-${point.label}`, label: point.label, value: `${formatReportNumber(point.x)} / ${formatReportNumber(point.y)}`, source: '已绑定视觉点' });
  }
  return rows;
}

export function ReportEvidenceDrawer({ slide }: { slide: ReportSlide }) {
  const [open, setOpen] = useState(false);
  const rows = evidenceRows(slide);
  return (
    <section className="report-evidence-drawer" aria-label="页面证据">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? '收起证据明细' : '展开证据明细'}</button>
      {open && (
        <div className="report-evidence-drawer__table">
          <table aria-label="证据明细">
            <thead><tr><th>证据</th><th>绑定值</th><th>来源</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.id}><th>{row.label}</th><td>{row.value}</td><td>{row.source}</td></tr>)}</tbody>
          </table>
          {rows.length === 0 && <p>本页没有可核验的现场数据证据。</p>}
        </div>
      )}
    </section>
  );
}
