import type { CSSProperties } from 'react';
import type { DataDashboardVisualSpec } from '../../../../../shared/report';
import type { ReportRevealModule } from '../useReportModuleReveal';
import { AtomicVisualRenderer } from './AtomicVisualRenderer';
import { metricIdentitiesForAtomicVisual, ReportChartThemeProvider } from './ReportChartThemeContext';
import { ReportVisualErrorBoundary } from './ReportVisualErrorBoundary';
import { ReportVisualIcon, reportVisualLabel } from './ReportVisualIcon';
import { formatReportNumber } from './visual-utils';
import type { VisualMode } from './VisualRenderer';

const MAX_SUMMARY_COLUMNS = 8;

type RevealProps = {
  'data-reveal-module': ReportRevealModule;
  'data-reveal-visible': 'true' | 'false';
  'aria-hidden'?: true;
  inert?: true;
};

function revealProps(modules: ReadonlySet<ReportRevealModule> | undefined, module: ReportRevealModule): RevealProps {
  const visible = modules === undefined || modules.has(module);
  return {
    'data-reveal-module': module,
    'data-reveal-visible': String(visible) as 'true' | 'false',
    ...(!visible ? { 'aria-hidden': true, inert: true } : {}),
  };
}

export function summaryGridForMetricCount(metricCount: number) {
  const count = Math.max(0, Math.floor(metricCount));
  if (count <= 8) return { columns: Math.max(count, 1), rows: count === 0 ? 0 : 1 };

  for (let columns = MAX_SUMMARY_COLUMNS; columns >= 1; columns -= 1) {
    const secondRow = count - columns;
    if (secondRow <= columns && secondRow > columns / 2) return { columns, rows: 2 };
  }

  return { columns: MAX_SUMMARY_COLUMNS, rows: Math.ceil(count / MAX_SUMMARY_COLUMNS) };
}

export function DataDashboardVisual({
  visual,
  mode,
  revealedModules,
}: {
  visual: DataDashboardVisualSpec;
  mode: VisualMode;
  revealedModules?: ReadonlySet<ReportRevealModule>;
}) {
  if (mode === 'thumbnail') {
    return (
      <div className="report-data-dashboard__primary">
        <ReportVisualErrorBoundary label="主图">
          <AtomicVisualRenderer visual={visual.primary} mode={mode} />
        </ReportVisualErrorBoundary>
      </div>
    );
  }

  const { columns: summaryColumns, rows: summaryRows } = summaryGridForMetricCount(visual.summaryMetrics.length);
  const supporting = [...visual.supporting].sort((left, right) => (
    Number(right.kind === 'comparison-bars') - Number(left.kind === 'comparison-bars')
  ));
  const paletteMetrics = [
    ...visual.summaryMetrics,
    ...metricIdentitiesForAtomicVisual(visual.primary),
    ...supporting.flatMap(metricIdentitiesForAtomicVisual),
  ];
  const summaryStyle = {
    '--report-summary-columns': String(summaryColumns),
  } as CSSProperties & { '--report-summary-columns': string };
  const supportSlots = [supporting[0], supporting[1]] as const;

  return (
    <ReportChartThemeProvider metrics={paletteMetrics}>
      <div
        className="report-data-dashboard"
        data-support-count={visual.supporting.length}
        data-support-slots={supportSlots.length}
        data-summary-columns={summaryColumns}
        data-summary-rows={summaryRows}
      >
        <dl
          className="report-data-dashboard__metrics"
          style={summaryStyle}
          data-dashboard-slot="metrics"
          aria-label={visual.summaryMetrics.length > 0 ? '关键指标摘要' : undefined}
          {...(visual.summaryMetrics.length > 0
            ? revealProps(revealedModules, 'metrics')
            : { 'aria-hidden': true })}
        >
            {visual.summaryMetrics.map((metric, index) => (
              <div
                className="report-data-dashboard__metric"
                key={`${metric.snapshotId}:${metric.key}`}
                data-reveal-index={index}
                style={{ '--report-reveal-index': index } as CSSProperties}
              >
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
        <section
          className="report-data-dashboard__primary"
          data-dashboard-slot="primary"
          data-panel-kind={visual.primary.kind}
          aria-label="主图"
          {...revealProps(revealedModules, 'primary')}
        >
          <div className="report-data-dashboard__panel-label">
            <ReportVisualIcon kind={visual.primary.kind} />
            <span>{reportVisualLabel(visual.primary.kind)}</span>
          </div>
          <ReportVisualErrorBoundary label="主图">
            <AtomicVisualRenderer visual={visual.primary} mode={mode} />
          </ReportVisualErrorBoundary>
        </section>
        <div
          className="report-data-dashboard__support"
          data-dashboard-slot="support"
          aria-label={supporting.length > 0 ? '辅助图' : undefined}
          aria-hidden={supporting.length === 0 || undefined}
        >
          {supportSlots.map((item, index) => item ? (
            <section
              key={`${item.kind}-${index + 1}`}
              data-dashboard-support-slot={index}
              data-panel-kind={item.kind}
              data-reveal-index={index}
              aria-label={`辅助图 ${index + 1}`}
              {...revealProps(revealedModules, `support-${index}`)}
            >
              <div className="report-data-dashboard__panel-label">
                <ReportVisualIcon kind={item.kind} />
                <span>{reportVisualLabel(item.kind)}</span>
              </div>
              <ReportVisualErrorBoundary label={`辅助图 ${index + 1}`}>
                <AtomicVisualRenderer visual={item} mode={mode} />
              </ReportVisualErrorBoundary>
            </section>
          ) : (
            <div
              className="report-data-dashboard__support-empty"
              data-dashboard-support-slot={index}
              data-dashboard-support-empty
              aria-hidden="true"
              key={`empty-support-${index}`}
            />
          ))}
        </div>
      </div>
    </ReportChartThemeProvider>
  );
}
