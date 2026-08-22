import { calculateReadingHealth } from '../../../shared/health';
import { useRef } from 'react';
import type { OverviewData } from '../../app/api';
import { useDashboardQuery } from '../../app/useDashboardQuery';
import { HealthRing } from '../../charts/HealthRing';
import { TrendArea } from '../../charts/TrendArea';
import { GlassPanel } from '../../components/GlassPanel';
import { DashboardQueryState } from '../../components/DashboardQueryState';
import { HealthDimensionMeter } from '../../components/HealthDimensionMeter';
import { useDashboardEntrance } from '../../motion/useDashboardEntrance';
import { useHealthDimensionMotion } from '../../motion/useHealthDimensionMotion';
import '../../styles/dashboard.css';

export function OverviewPage() {
  const query = useDashboardQuery<OverviewData>('overview');
  if (query.status !== 'success') return <DashboardQueryState status={query.status} loadingMessage="正在同步运行数据…" onRetry={query.retry} />;
  return <OverviewDashboard data={query.data} />;
}

function OverviewDashboard({ data }: { data: OverviewData }) {
  const motionRoot = useRef<HTMLDivElement>(null);
  const dimensionScores = [
    data.trend.at(-1)?.qualityScore ?? 0,
    data.trend.at(-1)?.flowScore ?? 0,
    data.trend.at(-1)?.energyScore ?? 0,
    data.trend.at(-1)?.carbonSourceScore ?? 0,
  ];
  useDashboardEntrance(motionRoot, ['success']);
  useHealthDimensionMotion(motionRoot, dimensionScores);
  const dimensions = [
    ['出水水质', data.health.weights.quality, data.trend.at(-1)?.qualityScore ?? 0, '◎'], ['水量波动', data.health.weights.flow, data.trend.at(-1)?.flowScore ?? 0, '≋'],
    ['电耗', data.health.weights.energy, data.trend.at(-1)?.energyScore ?? 0, 'ϟ'], ['碳源消耗', data.health.weights.carbonSource, data.trend.at(-1)?.carbonSourceScore ?? 0, '◈'],
  ];
  return <div className="dashboard-page overview-page" ref={motionRoot} data-dashboard-motion-root data-motion-complete="false">
    <div className="dashboard-heading"><div><p className="page-kicker">REAL-TIME OPERATIONS / PLANT COMMAND</p><h1>运行总览</h1><p>智慧污水处理厂 · AI 智能运营指挥中心</p></div><span className="live-state">系统在线</span></div>
    <div className="overview-grid">
      <aside className="overview-stat-stack">
        <GlassPanel data-motion-card className="metric-card"><div className="metric-card__top"><span>今日处理量</span><b aria-hidden="true">≋</b></div><strong><span data-motion-number data-motion-value={data.trend.at(-1)?.processedM3 ?? 0} data-motion-format="integer">{data.trend.at(-1)?.processedM3.toLocaleString()}</span><small>m³ / 日</small></strong><em>↗ 较昨日 +2.8% · 负荷平稳</em></GlassPanel>
        <GlassPanel data-motion-card className="metric-card"><div className="metric-card__top"><span>安全运行</span><b className="metric-status" aria-hidden="true">●</b></div><strong><span data-motion-number data-motion-value={data.metrics.operatingDays} data-motion-format="integer">{data.metrics.operatingDays}</span><small>天</small></strong><em>✓ 全链路设备在线运行</em></GlassPanel>
        <GlassPanel data-motion-card className="metric-card metric-card--mint"><div className="metric-card__top"><span>水质达标率</span><b aria-hidden="true">✓</b></div><strong><span data-motion-number data-motion-value={data.metrics.complianceRate} data-motion-format="one-decimal">{data.metrics.complianceRate.toFixed(1)}</span><small>%</small></strong><em><i className="pass-badge">达标</i> 高于目标 0.4%</em></GlassPanel>
      </aside>
      <GlassPanel data-motion-card accent aria-label="系统健康指数" className="overview-health"><div className="overview-health__summary"><div className="panel-title-row"><div><p className="panel-label">SYSTEM HEALTH INDEX</p><h2>系统健康指数</h2></div><span className="date-chip">实时评估</span></div><div className="overview-health__visual"><HealthRing score={data.health.score} size={218} /><div className="ring-status"><span>优 · 运行稳态</span><small>四项维度加权评估</small></div></div></div><div className="overview-dimensions"><div className="overview-dimensions__heading"><span>DIMENSIONAL ANALYSIS</span><small>权重评分</small></div>{dimensions.map(([label, weight, score, icon]) => <div className="dimension-row" key={String(label)}><b aria-hidden="true">{icon}</b><div><span>{label}</span><small>{Number(weight) * 100}%</small></div><HealthDimensionMeter score={Number(score)} /><strong data-dimension-score>{Number(score).toFixed(0)}</strong></div>)}</div></GlassPanel>
      <GlassPanel data-motion-card className="overview-trend"><div className="panel-title-row"><div><p className="panel-label">30-DAY HEALTH TRACE</p><h2>健康趋势</h2></div><div className="trend-toolbar"><span className="trend-legend"><i /> 综合健康评分</span><span className="date-chip">近30日</span></div></div><TrendArea layout="wide" ariaLabel="近30日健康趋势图" points={data.trend} metric={{ label: '健康指数', unit: '分', value: (point) => calculateReadingHealth(point).score }} /></GlassPanel>
    </div>
  </div>;
}
