import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { EnergyData } from '../../app/api';
import { useDashboardQuery } from '../../app/useDashboardQuery';
import { EnergyCostBars } from '../../charts/EnergyCostBars';
import { TrendArea } from '../../charts/TrendArea';
import { GlassPanel } from '../../components/GlassPanel';
import { DashboardQueryState } from '../../components/DashboardQueryState';
import { type MotionNumberFormat, useDashboardEntrance } from '../../motion/useDashboardEntrance';
import { EnergyPeriodTabs } from './EnergyPeriodTabs';
import { buildEnergyPeriodView, type EnergyPeriod, type EnergyPeriodView } from './energy-periods';
import { formatNumber } from './energy-formatters';
import '../../styles/dashboard.css';

type EnergyCounter = {
  text: string;
  motionValue: number;
  motionFormat: MotionNumberFormat;
};

function energyCounter(value: number): EnergyCounter {
  const text = formatNumber(value);
  const decimalPlaces = text.split('.')[1]?.length ?? 0;
  const motionFormat = decimalPlaces === 0 ? 'integer' : decimalPlaces === 1 ? 'one-decimal' : 'two-decimal';
  return { text, motionValue: value, motionFormat };
}

function energyMoneyCounter(value: number): EnergyCounter & { unit: '元' | '万元' } {
  const unit = Math.abs(value) >= 10_000 ? '万元' : '元';
  return { ...energyCounter(unit === '万元' ? value / 10_000 : value), unit };
}

export function EnergyPage() {
  const query = useDashboardQuery<EnergyData>('energy');
  if (query.status !== 'success') return <DashboardQueryState status={query.status} loadingMessage="正在分析能效数据…" onRetry={query.retry} />;
  return <EnergyDashboard data={query.data} />;
}

function EnergyDashboard({ data }: { data: EnergyData }) {
  const [period, setPeriod] = useState<EnergyPeriod>('month');
  const view = useMemo(() => buildEnergyPeriodView(data, period), [data, period]);
  useEffect(() => {
    view.configIssues.forEach((issue) => console.error('ENERGY_COST_CONFIG_INVALID', issue));
  }, [view]);
  if (view.status === 'ready') return <EnergyReadyDashboard view={view} period={period} onPeriodChange={setPeriod} />;
  return <EnergyDashboardContent view={view} period={period} onPeriodChange={setPeriod} />;
}

function EnergyReadyDashboard({
  view,
  period,
  onPeriodChange,
}: {
  view: Extract<EnergyPeriodView, { status: 'ready' }>;
  period: EnergyPeriod;
  onPeriodChange: (period: EnergyPeriod) => void;
}) {
  const motionRoot = useRef<HTMLDivElement>(null);
  useDashboardEntrance(motionRoot, ['success', period]);
  return <EnergyDashboardContent view={view} period={period} onPeriodChange={onPeriodChange} motionRoot={motionRoot} />;
}

function EnergyDashboardContent({
  view,
  period,
  onPeriodChange,
  motionRoot,
}: {
  view: EnergyPeriodView;
  period: EnergyPeriod;
  onPeriodChange: (period: EnergyPeriod) => void;
  motionRoot?: RefObject<HTMLDivElement | null>;
}) {
  const motionEnabled = motionRoot !== undefined;
  const rangeText = `${view.range.start}—${view.range.end}`;
  const kpis = view.status === 'ready' ? [
    { key: 'saved-yuan', label: '累计节省费用', counter: energyMoneyCounter(view.kpis.savedYuan), unitStyle: 'strong', detail: '成本较基线下降 12.8%' },
    { key: 'saved-kwh', label: '累计节电量', counter: view.kpis.savedKwh === null ? null : { ...energyCounter(view.kpis.savedKwh / 1_000), unit: 'MWh' }, unitStyle: 'small', detail: view.kpis.savedKwh === null ? '节电率配置不可用' : '风机系统贡献最高' },
    { key: 'carbon-reduction', label: '累计碳减排', counter: { ...energyCounter(view.kpis.carbonReductionKg / 1_000), unit: 'tCO₂e' }, unitStyle: 'small', detail: '低碳策略持续优化' },
  ] : [
    { key: 'saved-yuan', label: '累计节省费用', counter: null, unitStyle: 'strong', detail: view.message },
    { key: 'saved-kwh', label: '累计节电量', counter: null, unitStyle: 'small', detail: view.message },
    { key: 'carbon-reduction', label: '累计碳减排', counter: null, unitStyle: 'small', detail: view.message },
  ];
  const savingsCounter = view.status === 'ready' ? energyMoneyCounter(view.kpis.savedYuan) : null;
  return <div className="dashboard-page energy-page" ref={motionRoot} data-dashboard-motion-root data-motion-complete={motionEnabled ? 'false' : 'true'}>
    <div className="dashboard-heading energy-page__heading">
      <div><p className="page-kicker">ENERGY EFFICIENCY MANAGEMENT</p><h1>节能降耗</h1><p>AI 协同控制 · 降耗、节费与低碳运行</p></div>
      <div className="energy-heading-controls"><span className="live-state">优化策略运行中</span><EnergyPeriodTabs value={period} onChange={onPeriodChange} /></div>
    </div>
    <section className="energy-kpis">
      {kpis.map((item, index) => <GlassPanel data-motion-card={motionEnabled ? true : undefined} key={item.key} className={`energy-kpi energy-kpi--${index}`}>
        <div className="energy-kpi__top"><span>{item.label}</span><b aria-hidden="true">↗</b></div>
        <strong data-testid={`${item.key}-value`}>{item.counter === null ? '--' : <><span data-motion-number data-motion-value={item.counter.motionValue} data-motion-format={item.counter.motionFormat}>{item.counter.text}</span>{item.unitStyle === 'small' ? <> <small>{item.counter.unit}</small></> : <> {item.counter.unit}</>}</>}</strong>
        <em>↗ {item.detail}</em>
        <p>{view.label} · {rangeText}</p>
      </GlassPanel>)}
    </section>
    <section className="energy-grid">
      <GlassPanel data-motion-card={motionEnabled ? true : undefined} accent className="energy-costs">
        <div className="panel-title-row"><div><p className="panel-label">ENERGY COST MATRIX</p><h2>能耗费用</h2></div><span data-testid="energy-date-range">{rangeText}</span></div>
        <div className="energy-legend" role="list" aria-label="能耗费用图例"><span role="listitem"><i className="energy-legend__consumption" />消耗量</span><span role="listitem"><i className="energy-legend__cost" />对应费用</span></div>
        <EnergyCostBars values={view.status === 'ready' ? view.costMetrics : []} />
      </GlassPanel>
      <GlassPanel data-motion-card={motionEnabled ? true : undefined} className="energy-growth">
        <div className="panel-title-row"><div><p className="panel-label">SAVINGS ACCUMULATION</p><h2>节省费用趋势</h2></div><span>{view.label} · 累计</span></div>
        <div className="energy-growth__value"><strong>{savingsCounter === null ? '--' : <><span data-motion-number data-motion-value={savingsCounter.motionValue} data-motion-format={savingsCounter.motionFormat}>{savingsCounter.text}</span> {savingsCounter.unit}</>}</strong><span>{rangeText}</span></div>
        {view.status === 'ready'
          ? <TrendArea layout="panel" ariaLabel="节省费用趋势图" points={view.savingsTrend} metric={{ label: '累计节省费用', unit: '元', value: (point) => point.savedYuan }} />
          : <div className="energy-growth__empty" role="status">{view.message}</div>}
      </GlassPanel>
    </section>
  </div>;
}
