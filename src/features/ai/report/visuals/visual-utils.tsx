import type { ReactNode } from 'react';

export type VisualTableRow = { label: string; value: string; unit?: string };

export function formatReportNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

export function VisualDataTable({ label, rows }: { label: string; rows: VisualTableRow[] }) {
  return (
    <div className="sr-only">
      <table aria-label={label}>
        <thead><tr><th>项目</th><th>数值</th><th>单位</th></tr></thead>
        <tbody>{rows.map((row, index) => (
          <tr key={`${row.label}-${index}`}><th>{row.label}</th><td>{row.value}</td><td>{row.unit ?? '—'}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export function VisualFrame({ ariaLabel, children, table }: { ariaLabel: string; children: ReactNode; table: ReactNode }) {
  return <figure className="report-visual"><div className="report-visual__graphic" role="img" aria-label={ariaLabel}>{children}</div>{table}</figure>;
}
