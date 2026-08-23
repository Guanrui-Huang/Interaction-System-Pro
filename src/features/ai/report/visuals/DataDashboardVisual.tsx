import type { CSSProperties } from 'react';
import type { DataDashboardVisualSpec } from '../../../../../shared/report';
import { AtomicVisualRenderer } from './AtomicVisualRenderer';
import { ReportVisualErrorBoundary } from './ReportVisualErrorBoundary';
import { ReportVisualIcon, reportVisualLabel } from './ReportVisualIcon';
import { formatReportNumber } from './visual-utils';
import type { VisualMode } from './VisualRenderer';

const MAX_SUMMARY_COLUMNS = 7;

export function DataDashboardVisual({ visual, mode }: { visual: DataDashboardVisualSpec; mode: VisualMode }) {
  if (mode === 'thumbnail') {
    return (
      <div className="report-data-dashboard__primary">
        <ReportVisualErrorBoundary label="主图">
          <AtomicVisualRenderer visual={visual.primary} mode={mode} />
        </ReportVisualErrorBoundary>
      </div>
    );
  }

  const summaryColumns = Math.min(Math.max(visual.summaryMetrics.length, 1), MAX_SUMMARY_COLUMNS);
  const summaryRows = Math.ceil(visual.summaryMetrics.length / MAX_SUMMARY_COLUMNS);
  const supporting = [...visual.supporting].sort((left, right) => (
    Number(right.kind === 'comparison-bars') - Number(left.kind === 'comparison-bars')
  ));
  const summaryStyle = {
    '--report-summary-columns': String(summaryColumns),
  } as CSSProperties & { '--report-summary-columns': string };

  return (
    <div className="report-data-dashboard" data-support-count={visual.supporting.length} data-summary-columns={summaryColumns} data-summary-rows={summaryRows}>
      {visual.summaryMetrics.length > 0 && (
        <dl className="report-data-dashboard__metrics" style={summaryStyle} aria-label="关键指标摘要">
          {visual.summaryMetrics.map((metric) => (
            <div className="report-data-dashboard__metric" key={`${metric.snapshotId}:${metric.key}`}>
              <dt>
                <ReportVisualIcon kind="metric" metricKey={metric.key} metricLabel={metric.label} />
                <span>{metric.label}</span>
              </dt>
              <dd>
                <strong data-motion-number data-final-value={metric.value}>{formatReportNumber(metric.value)}</strong>
                <span>{metric.unit}</span>
              </dd>
              {metric.status && <small>{metric.status}</small>}
            </div>
          ))}
        </dl>
      )}
      <section className="report-data-dashboard__primary" data-panel-kind={visual.primary.kind} aria-label="主图">
        <div className="report-data-dashboard__panel-label">
          <ReportVisualIcon kind={visual.primary.kind} />
          <span>{reportVisualLabel(visual.primary.kind)}</span>
        </div>
        <ReportVisualErrorBoundary label="主图">
          <AtomicVisualRenderer visual={visual.primary} mode={mode} />
        </ReportVisualErrorBoundary>
      </section>
      {supporting.length > 0 && (
        <div className="report-data-dashboard__support" aria-label="辅助图">
          {supporting.map((item, index) => (
            <section key={`${item.kind}-${index + 1}`} data-panel-kind={item.kind} aria-label={`辅助图 ${index + 1}`}>
              <div className="report-data-dashboard__panel-label">
                <ReportVisualIcon kind={item.kind} />
                <span>{reportVisualLabel(item.kind)}</span>
              </div>
              <ReportVisualErrorBoundary label={`辅助图 ${index + 1}`}>
                <AtomicVisualRenderer visual={item} mode={mode} />
              </ReportVisualErrorBoundary>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
