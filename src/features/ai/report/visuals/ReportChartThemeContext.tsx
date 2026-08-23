import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { AtomicVisualSpec } from '../../../../../shared/report';
import { barThemeForMetric, chartThemesForMetrics, type BarTheme, type ChartMetricIdentity } from '../../../../charts/chart-theme';

const ReportChartThemeContext = createContext<Map<string, BarTheme> | null>(null);

export function metricIdentitiesForAtomicVisual(visual: AtomicVisualSpec): ChartMetricIdentity[] {
  switch (visual.kind) {
    case 'trend-line':
    case 'trend-area':
      return visual.series.map(({ key, label }) => ({ key, label }));
    case 'comparison-bars':
      return visual.items.map(({ key, label }) => ({ key, label }));
    case 'health-ring':
      return [{ key: visual.metric.key, label: visual.metric.label }];
    case 'radar':
      return visual.axes.map(({ key, label }) => ({ key, label }));
    case 'scatter':
      return [
        { key: visual.x.key, label: visual.x.label },
        { key: visual.y.key, label: visual.y.label },
      ];
    case 'kpi-grid':
      return visual.metrics.map(({ key, label }) => ({ key, label }));
    default:
      return [];
  }
}

export function ReportChartThemeProvider({
  metrics,
  children,
}: {
  metrics: readonly ChartMetricIdentity[];
  children: ReactNode;
}) {
  const themes = useMemo(() => chartThemesForMetrics(metrics), [metrics]);
  return <ReportChartThemeContext.Provider value={themes}>{children}</ReportChartThemeContext.Provider>;
}

export function useReportChartThemes(metrics: readonly ChartMetricIdentity[]) {
  const sharedThemes = useContext(ReportChartThemeContext);
  const localThemes = useMemo(() => {
    if (sharedThemes || metrics.length <= 1) return null;
    return chartThemesForMetrics(metrics);
  }, [sharedThemes, metrics]);

  return metrics.map((metric) => (
    sharedThemes?.get(metric.key)
    ?? localThemes?.get(metric.key)
    ?? barThemeForMetric(metric.key, metric.label)
  ));
}
