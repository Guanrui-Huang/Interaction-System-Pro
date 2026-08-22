import { useRef } from 'react';
import type { WaterQualityData } from '../../app/api';
import { useDashboardQuery } from '../../app/useDashboardQuery';
import { TrendArea } from '../../charts/TrendArea';
import { GlassPanel } from '../../components/GlassPanel';
import { DashboardQueryState } from '../../components/DashboardQueryState';
import { WarningCarousel } from '../../components/WarningCarousel';
import { useDashboardEntrance } from '../../motion/useDashboardEntrance';
import '../../styles/dashboard.css';

export function WaterQualityPage() {
  const query = useDashboardQuery<WaterQualityData>('water-quality');
  if (query.status !== 'success') return <DashboardQueryState status={query.status} loadingMessage="正在加载出水水质…" onRetry={query.retry} />;
  return <WaterQualityDashboard data={query.data} />;
}

function WaterQualityDashboard({ data }: { data: WaterQualityData }) {
  const motionRoot = useRef<HTMLDivElement>(null);
  useDashboardEntrance(motionRoot, ['success']);
  const tnMetric = data.metrics.tn;
  const averages = [
    [data.metrics.ammonia.label, data.latest.ammonia, data.metrics.ammonia.unit, data.metrics.ammonia.threshold],
    [data.metrics.tp.label, data.latest.tp, data.metrics.tp.unit, data.metrics.tp.threshold],
    [data.metrics.cod.label, data.latest.cod, data.metrics.cod.unit, data.metrics.cod.threshold],
    [data.metrics.ss.label, data.latest.ss, data.metrics.ss.unit, data.metrics.ss.threshold],
  ];
  const collaborative = [
    { metric: data.metrics.ammonia, value: data.latest.ammonia },
    { metric: data.metrics.tp, value: data.latest.tp },
    { metric: data.metrics.cod, value: data.latest.cod },
    { metric: data.metrics.ss, value: data.latest.ss },
  ];

  return <div className="dashboard-page water-page" ref={motionRoot} data-dashboard-motion-root data-motion-complete="false">
    <div className="dashboard-heading water-page__heading"><div><p className="page-kicker">EFFLUENT QUALITY CONTROL</p><h1>出水水质</h1><p>一级 A 排放标准 · 关键指标连续监测</p></div><span className="live-state">实时监测中</span></div>
    <div className="water-main-grid">
      <GlassPanel data-motion-card accent className="water-primary">
        <div className="panel-title-row"><div><p className="panel-label">核心控制指标</p><h2>{tnMetric.label}</h2></div><div className="quality-reading"><strong><span data-motion-number data-motion-value={data.latest.tn} data-motion-format="two-decimal">{data.latest.tn.toFixed(2)}</span></strong><span>{tnMetric.unit}</span></div></div>
        <div className="quality-subline"><span className="pass-badge">当前稳定达标</span><span>达标阈值 {tnMetric.threshold} {tnMetric.unit}</span><span className="quality-delta">↓ 较 24h 均值 2.1%</span></div>
        <TrendArea points={data.trend} metric={{ label: tnMetric.label, unit: tnMetric.unit, threshold: tnMetric.threshold, value: (point) => point.tn }} />
        <div className="water-collaborative" aria-label="协同指标">{collaborative.map(({ metric, value }) => <span key={metric.label}><b>{metric.label}</b><span data-motion-number data-motion-value={value} data-motion-format="two-decimal">{value.toFixed(2)}</span> <small>{metric.unit}</small></span>)}</div>
      </GlassPanel>
      <aside className="water-side-stack">
        <GlassPanel data-motion-card className="quality-metrics"><div className="panel-title-row"><div><p className="panel-label">24 小时均值</p><h2>关键指标</h2></div><span>平均负荷</span></div><div className="quality-metric-grid">{averages.map(([label, value, unit, target]) => <div key={String(label)}><span>{label}</span><strong><span data-motion-number data-motion-value={Number(value)} data-motion-format="two-decimal">{Number(value).toFixed(2)}</span></strong><small>{unit} · 限值 {target}</small><i style={{ width: `${Math.min(100, Number(value) / Number(target) * 100)}%` }} /></div>)}</div></GlassPanel>
        <GlassPanel data-motion-card className="warning-log"><div className="panel-title-row"><div><p className="panel-label">风险追踪</p><h2>预警日志</h2></div><span className="warning-count" aria-label="新增预警数量"><span data-motion-number data-motion-value={data.alerts.length} data-motion-format="integer">{data.alerts.length}</span></span></div><WarningCarousel alerts={data.alerts} /></GlassPanel>
      </aside>
    </div>
  </div>;
}
