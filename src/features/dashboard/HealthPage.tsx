import { HEALTH_GRADE_THRESHOLDS } from '../../../shared/dashboard';
import { useRef } from 'react';
import type { HealthData } from '../../app/api';
import { useDashboardQuery } from '../../app/useDashboardQuery';
import { BarTrend } from '../../charts/BarTrend';
import { HealthRing } from '../../charts/HealthRing';
import { GlassPanel } from '../../components/GlassPanel';
import { DashboardQueryState } from '../../components/DashboardQueryState';
import { HealthDimensionMeter } from '../../components/HealthDimensionMeter';
import { useDashboardEntrance } from '../../motion/useDashboardEntrance';
import { useHealthDimensionMotion } from '../../motion/useHealthDimensionMotion';
import '../../styles/dashboard.css';

export function HealthPage() {
  const query = useDashboardQuery<HealthData>('health');
  if (query.status !== 'success') return <DashboardQueryState status={query.status} loadingMessage="正在计算健康指数…" onRetry={query.retry} />;
  return <HealthDashboard data={query.data} />;
}

function HealthDashboard({ data }: { data: HealthData }) {
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
    { icon: '水', label: '出水水质', weight: data.health.weights.quality, score: data.trend.at(-1)?.qualityScore ?? 0, description: '稳定达标，关键指标处于安全区间' },
    { icon: '量', label: '水量波动', weight: data.health.weights.flow, score: data.trend.at(-1)?.flowScore ?? 0, description: '处理量紧贴滚动基线，波动受控' },
    { icon: '电', label: '电耗', weight: data.health.weights.energy, score: data.trend.at(-1)?.energyScore ?? 0, description: '单位处理能耗保持在优化区间' },
    { icon: '碳', label: '碳源消耗', weight: data.health.weights.carbonSource, score: data.trend.at(-1)?.carbonSourceScore ?? 0, description: '碳源消耗与当前工况匹配良好' },
  ];
  const latestDate = data.trend.at(-1)?.date ?? '数据同步中';
  return <div className="dashboard-page health-page" ref={motionRoot} data-dashboard-motion-root data-motion-complete="false"><div className="dashboard-heading health-page__heading"><div><p className="page-kicker">PLANT HEALTH SCORE / 实时韧性评估</p><h1>健康指数得分</h1><p>以出水水质、水量波动、电耗与碳源消耗为核心的综合运行评估</p></div><div className="health-page__meta"><span className="live-state">系统在线</span><span className="date-chip">更新至 {latestDate}</span></div></div>
    <div className="health-stitch-grid"><GlassPanel data-motion-card accent className="health-score-card"><div className="health-score-card__header"><p className="panel-label">总体系统健康</p><span className="health-score-card__telemetry" aria-hidden="true">◌ ◌ ◌</span></div><HealthRing score={data.health.score} size={300} /><div className="health-score-card__summary"><strong>{data.health.grade} · 运行稳态</strong><span>综合得分高于优良阈值 {HEALTH_GRADE_THRESHOLDS.excellent} 分</span></div><div className="health-score-card__chips"><span><i>↗</i> 近 7 日 +2.4%</span><span><i>●</i> 运行风险低</span><span>阈值 ≥ {HEALTH_GRADE_THRESHOLDS.excellent}</span></div></GlassPanel>
      <GlassPanel data-motion-card className="health-dimension-card"><div className="panel-title-row"><div><p className="panel-label">DIMENSIONAL ANALYSIS</p><h2>四维健康评估</h2></div><span>实时评分 / 权重</span></div>{dimensions.map((dimension) => { const risk = dimension.score < 86; return <article className={`health-dimension ${risk ? 'health-dimension--risk' : ''}`} key={dimension.label}><div className="dimension-icon" aria-hidden="true">{dimension.icon}</div><div className="health-dimension__main"><div><strong>{dimension.label}</strong><span className={`health-dimension__badge ${risk ? 'health-dimension__badge--risk' : ''}`}>{risk ? '关注' : '优良'}</span></div><p>{dimension.description}</p><HealthDimensionMeter score={dimension.score} /></div><aside><b data-dimension-score>{Math.round(dimension.score)}</b><small>权重 <em>{dimension.weight * 100}%</em></small></aside></article>; })}</GlassPanel></div>
    <GlassPanel data-motion-card className="health-bars-card"><div className="health-bars-card__header"><div><p className="panel-label">HEALTH TREND / 30 DAYS</p><h2>近 30 日健康指数趋势</h2><span className="health-bars-card__legend"><i /> 综合得分　<span>优良线 {HEALTH_GRADE_THRESHOLDS.excellent}</span></span></div><div className="period-switch" role="group" aria-label="健康趋势周期" aria-describedby="health-period-note"><button type="button" aria-pressed="true">30日</button><button type="button" aria-pressed="false" disabled>90日</button><button type="button" aria-pressed="false" disabled>180日</button><small id="health-period-note">当前接口提供近 30 日数据</small></div></div><BarTrend points={data.trend} /></GlassPanel>
  </div>;
}
