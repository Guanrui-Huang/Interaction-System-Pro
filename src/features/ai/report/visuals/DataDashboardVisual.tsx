import type { DataDashboardVisualSpec } from '../../../../../shared/report';
import { AtomicVisualRenderer } from './AtomicVisualRenderer';
import { ReportVisualErrorBoundary } from './ReportVisualErrorBoundary';
import { ReportVisualIcon, reportVisualLabel } from './ReportVisualIcon';
import { formatReportNumber } from './visual-utils';
import type { VisualMode } from './VisualRenderer';

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

  return (
    <div className="report-data-dashboard" data-support-count={visual.supporting.length}>
      {visual.summaryMetrics.length > 0 && (
        <dl className="report-data-dashboard__metrics" aria-label="关键指标摘要">
          {visual.summaryMetrics.map((metric) => (
            <div className="report-data-dashboard__metric" key={`${metric.snapshotId}:${metric.key}`}>
              <dt>
                <ReportVisualIcon kind="metric" />
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
      {visual.supporting.length > 0 && (
        <div className="report-data-dashboard__support" aria-label="辅助图">
          {visual.supporting.map((item, index) => (
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
