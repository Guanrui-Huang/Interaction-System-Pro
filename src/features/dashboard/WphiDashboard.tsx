import { useRef } from 'react';
import type { WphiDimension, WphiDimensionKey, WphiSnapshot } from '../../../shared/wphi';
import type { DashboardPoint, HealthData, OverviewData } from '../../app/api';
import { BarTrend } from '../../charts/BarTrend';
import { HealthRing } from '../../charts/HealthRing';
import { TrendArea } from '../../charts/TrendArea';
import { GlassPanel } from '../../components/GlassPanel';
import { HealthDimensionMeter } from '../../components/HealthDimensionMeter';
import { useHealthDimensionMotion } from '../../motion/useHealthDimensionMotion';
import { WphiDetails } from './WphiDetails';
import '../../styles/wphi.css';

const overviewIcons: Record<WphiDimensionKey, string> = {
  effluentSafety: '◎', removalEfficiency: '↘', effluentStability: '≋',
  shockResistance: '◇', systemStability: '⊙', blowerEnergy: 'ϟ', carbonConsumption: '◈',
};
const healthIcons: Record<WphiDimensionKey, string> = {
  effluentSafety: '水', removalEfficiency: '净', effluentStability: '稳',
  shockResistance: '抗', systemStability: '系', blowerEnergy: '电', carbonConsumption: '碳',
};

type ViewProps = { snapshot: WphiSnapshot; trend: DashboardPoint[] };
const scoreText = (score: number | null) => score === null ? '—' : score.toFixed(2);
const measurement = (value: number | null | undefined, unit: string, digits = 2) => value == null ? '—' : `${value.toFixed(digits)}${unit}`;
const isStable = (snapshot: WphiSnapshot) => snapshot.grade === '优秀' || snapshot.grade === '良好';
const assessment = (snapshot: WphiSnapshot) => `${snapshot.grade} · ${isStable(snapshot) ? '运行稳态' : '运行关注'}`;

function change(current: number | null | undefined, previous: number | null | undefined) {
  if (current == null || previous == null || previous === 0) return null;
  return (current - previous) / previous * 100;
}

function changeText(value: number | null) {
  return value == null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function ScoreStatus({ snapshot }: { snapshot: WphiSnapshot }) {
  return <p className="wphi-notice" role="status">{snapshot.status === 'maintenance'
    ? '当前水厂处于【检修模式】，健康评分已主动暂停'
    : '暂无参与评分的维度，请检查维度开关与运行数据。'}</p>;
}

function DimensionMeter({ score }: { score: number | null }) {
  return score === null ? <div className="health-dimension-meter" aria-hidden="true" /> : <HealthDimensionMeter score={score} />;
}

function Overview({ snapshot, trend, metrics }: ViewProps & { metrics: OverviewData['metrics'] }) {
  const latest = trend.at(-1);
  const flowChange = change(latest?.processedM3, trend.at(-2)?.processedM3);
  return <>
    <div className="dashboard-heading">
      <div><p className="page-kicker">REAL-TIME OPERATIONS / PLANT COMMAND</p><h1>运行总览</h1><p>智慧污水处理厂 · AI 智能运营指挥中心</p></div>
      <span className="live-state">系统在线</span>
    </div>
    <div className="overview-grid">
      <aside className="overview-stat-stack">
        <GlassPanel className="metric-card">
          <div className="metric-card__top"><span>今日处理量</span><b aria-hidden="true">≋</b></div>
          <strong>{latest?.processedM3.toLocaleString('zh-CN') ?? '—'}<small>m³ / 日</small></strong>
          <em>{flowChange !== null && <span aria-hidden="true">{flowChange < 0 ? '↘' : '↗'}</span>}较昨日 {changeText(flowChange)}</em>
        </GlassPanel>
        <GlassPanel className="metric-card">
          <div className="metric-card__top"><span>安全运行</span><b className="metric-status" aria-hidden="true">●</b></div>
          <strong>{metrics.operatingDays}<small>天</small></strong>
          <em>近 30 日异常 {snapshot.metrics.abnormalDays ?? '—'} 天</em>
        </GlassPanel>
        <GlassPanel className="metric-card metric-card--mint">
          <div className="metric-card__top"><span>水质达标率</span><b aria-hidden="true">✓</b></div>
          <strong>{metrics.complianceRate.toFixed(1)}<small>%</small></strong>
          <em><i className="pass-badge">当日</i> 出水总氮 {measurement(latest?.tn, ' mg/L')}</em>
        </GlassPanel>
      </aside>
      <GlassPanel accent aria-label="系统健康指数" className={`overview-health${snapshot.status === 'maintenance' ? ' wphi-overview-paused' : ''}`}>
        <div className="overview-health__summary">
          <div className="panel-title-row">
            <div><p className="panel-label">SYSTEM HEALTH INDEX</p><h2>系统健康指数</h2></div>
            <span className="date-chip">实时评估</span>
          </div>
          {snapshot.score === null ? <ScoreStatus snapshot={snapshot} /> : <div className="overview-health__visual">
            <HealthRing score={snapshot.score} size={300} digits={2} />
            <div className="ring-status"><span>{assessment(snapshot)}</span></div>
          </div>}
        </div>
        {snapshot.status !== 'maintenance' && <div className="overview-dimensions">
          <div className="overview-dimensions__heading"><span>DIMENSIONAL ANALYSIS</span><small>七维评分</small></div>
          {snapshot.dimensions.map(dimension => <div className="dimension-row" key={dimension.key}>
            <b aria-hidden="true">{overviewIcons[dimension.key]}</b>
            <span className="dimension-row__label">{dimension.label}</span>
            <DimensionMeter score={dimension.score} />
            <strong data-dimension-score={dimension.score === null ? undefined : ''} title={dimension.score === null ? dimension.explanation : undefined}>
              {dimension.score === null ? '不计分' : scoreText(dimension.score)}
            </strong>
          </div>)}
        </div>}
      </GlassPanel>
      {snapshot.score !== null && <GlassPanel className="overview-trend">
        <div className="panel-title-row">
          <div><p className="panel-label">30-DAY HEALTH TRACE</p><h2>健康趋势</h2></div>
          <div className="trend-toolbar"><span className="trend-legend"><i /> 综合健康评分</span><span className="date-chip">近30日</span></div>
        </div>
        <TrendArea layout="wide" ariaLabel="近30日健康趋势图" points={trend} metric={{ label: '健康指数', unit: '分', value: point => point.wphi?.score ?? NaN }} />
      </GlassPanel>}
    </div>
  </>;
}

function dimensionDescription(dimension: WphiDimension, snapshot: WphiSnapshot, latest: DashboardPoint | undefined) {
  if (!dimension.included) return dimension.explanation;
  const { metrics, config: { targets } } = snapshot;
  switch (dimension.key) {
    case 'effluentSafety': return `出水总氮 ${measurement(latest?.tn, ' mg/L')} · 目标 ${targets.tnOut} mg/L`;
    case 'removalEfficiency': return `总氮去除率 ${measurement(metrics.tnRemoval, '%')} · 目标 ${targets.tnRemoval}%`;
    case 'effluentStability': return `近 7 天出水总氮 CV ${measurement(metrics.tnCv, '%')} · 目标 ${targets.tnCv}%`;
    case 'shockResistance': return `近 30 天进水冲击 ${metrics.shockDays ?? '—'} 天 · 按对应出水总氮评分`;
    case 'systemStability': return `近 30 天异常 ${metrics.abnormalDays ?? '—'} 天 · 按异常天数评分`;
    case 'blowerEnergy': return `吨水风机能耗 ${measurement(metrics.blowerKwhPerM3, ' kWh/m³', 4)} · 当日 ${latest?.blowerKwh ?? '—'} kWh`;
    case 'carbonConsumption': return `吨水碳源用量 ${measurement(metrics.carbonKgPerM3, ' kg/m³', 4)} · 当日 ${latest?.carbonSourceKg ?? '—'} kg`;
  }
}

function Health({ snapshot, trend }: ViewProps) {
  const latest = trend.at(-1);
  const weekAgo = new Date(Date.parse(snapshot.date) - 7 * 86_400_000).toISOString().slice(0, 10);
  const weekChange = change(snapshot.score, trend.find(point => point.date === weekAgo)?.wphi?.score);
  const paused = snapshot.status === 'maintenance';
  return <>
    <div className="dashboard-heading health-page__heading">
      <div><p className="page-kicker">PLANT HEALTH SCORE / 实时韧性评估</p><h1>健康指数得分</h1><p>污水处理厂综合健康指数（WPHI） · 七维运行评估</p></div>
      <div className="health-page__meta"><span className="live-state">系统在线</span><span className="date-chip">更新至 {snapshot.date}</span></div>
    </div>
    {paused ? <GlassPanel className="wphi-paused-panel"><ScoreStatus snapshot={snapshot} /></GlassPanel> : <div className="health-stitch-grid">
      <GlassPanel accent className="health-score-card">
        <div className="health-score-card__header"><p className="panel-label">总体系统健康</p><span className="health-score-card__telemetry" aria-hidden="true">◌ ◌ ◌</span></div>
        {snapshot.score === null ? <ScoreStatus snapshot={snapshot} /> : <>
          <HealthRing score={snapshot.score} size={420} digits={2} />
          <div className="health-score-card__summary">
            <strong>{assessment(snapshot)}</strong>
            <span>{snapshot.dimensions.every(dimension => dimension.included) ? '七维度算术平均' : '参与维度算术平均'}</span>
          </div>
          <div className="health-score-card__chips">
            <span>{weekChange !== null && <i aria-hidden="true">{weekChange < 0 ? '↘' : '↗'} </i>}近 7 日 {changeText(weekChange)}</span>
            <span><i aria-hidden="true">●</i> {isStable(snapshot) ? '运行风险低' : '运行风险需关注'}</span>
            <span>良好线 ≥ 90</span>
          </div>
        </>}
      </GlassPanel>
      <GlassPanel className="health-dimension-card" aria-label="各维度得分">
        <div className="panel-title-row"><div><p className="panel-label">DIMENSIONAL ANALYSIS</p><h2>七维健康评估</h2></div><span>实时评分</span></div>
        {snapshot.dimensions.map(dimension => {
          const attention = dimension.score !== null && dimension.score < 90;
          return <article className={`health-dimension${attention ? ' health-dimension--risk' : ''}`} key={dimension.key}>
            <div className="dimension-icon" aria-hidden="true">{healthIcons[dimension.key]}</div>
            <div className="health-dimension__main">
              <div className="health-dimension__title">
                <strong>{dimension.label}</strong>
                <span className={`health-dimension__badge${attention ? ' health-dimension__badge--risk' : ''}`}>{dimension.grade ?? '不计分'}</span>
              </div>
              <DimensionMeter score={dimension.score} />
              <p data-testid={dimension.key === 'effluentStability' ? 'wphi-cv' : undefined}>{dimensionDescription(dimension, snapshot, latest)}</p>
            </div>
            <aside><b data-dimension-score={dimension.score === null ? undefined : ''}>{scoreText(dimension.score)}</b></aside>
          </article>;
        })}
      </GlassPanel>
    </div>}
    {snapshot.score !== null && <GlassPanel className="health-bars-card">
      <div className="health-bars-card__header">
        <div><p className="panel-label">HEALTH TREND / 30 DAYS</p><h2>近 30 日健康指数趋势</h2><span className="health-bars-card__legend"><i /> 综合得分　<span>良好线 90</span></span></div>
        <div className="period-switch" role="group" aria-label="健康趋势周期" aria-describedby="health-period-note">
          <button type="button" aria-pressed="true">30日</button><button type="button" disabled>90日</button><button type="button" disabled>180日</button><small id="health-period-note">当前展示近 30 日数据</small>
        </div>
      </div>
      <BarTrend points={trend} thresholdLabel="良好线" />
    </GlassPanel>}
  </>;
}

export function WphiDashboard({ data, overviewMetrics, onRefresh, onEditingChange }: {
  data: HealthData;
  overviewMetrics?: OverviewData['metrics'];
  onRefresh: () => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const snapshot = data.health.wphi!;
  const root = useRef<HTMLDivElement>(null);
  const scores = snapshot.status === 'maintenance' ? [] : snapshot.dimensions.flatMap(({ score }) => score === null ? [] : [score]);
  useHealthDimensionMotion(root, scores, 2);
  return <>
    <div className={`dashboard-page wphi-dashboard ${overviewMetrics ? 'overview-page' : 'health-page'}${snapshot.score === null ? ' wphi-dashboard--unscored' : ''}`} ref={root}>
      {overviewMetrics ? <Overview snapshot={snapshot} trend={data.trend} metrics={overviewMetrics} /> : <Health snapshot={snapshot} trend={data.trend} />}
    </div>
    <WphiDetails snapshot={snapshot} latest={data.trend.at(-1)} onRefresh={onRefresh} onEditingChange={onEditingChange} />
  </>;
}
