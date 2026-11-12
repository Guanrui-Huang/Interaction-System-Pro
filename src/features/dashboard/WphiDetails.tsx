import type { WphiSnapshot } from '../../../shared/wphi';
import type { DashboardPoint } from '../../app/api';
import { GlassPanel } from '../../components/GlassPanel';
import { WphiControls } from './WphiControls';

export function WphiDetails({ snapshot, latest, onRefresh, onEditingChange }: {
  snapshot: WphiSnapshot;
  latest: DashboardPoint | undefined;
  onRefresh: () => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const { metrics, config: { targets } } = snapshot;
  const rows = [
    { label: '出水总氮', actual: latest?.tn, target: targets.tnOut, unit: 'mg/L' },
    { label: '进水总氮', actual: metrics.tnIn, target: targets.tnIn, unit: 'mg/L' },
    { label: '总氮去除率', actual: metrics.tnRemoval, target: targets.tnRemoval, unit: '%' },
    { label: '近7日出水总氮 CV', actual: metrics.tnCv, target: targets.tnCv, unit: '%' },
    { label: '吨水风机能耗', actual: metrics.blowerKwhPerM3, target: targets.blowerPerM3, unit: 'kWh/m³', digits: 4 },
    { label: '风机总能耗', actual: latest?.blowerKwh, target: targets.blowerTotal, unit: 'kWh/d' },
    { label: '吨水碳源用量', actual: metrics.carbonKgPerM3, target: targets.carbonPerM3, unit: 'kg/m³', digits: 4 },
    { label: '碳源总用量', actual: latest?.carbonSourceKg, target: targets.carbonTotal, unit: 'kg/d' },
  ];
  return <div className="dashboard-page wphi-details">
    <WphiControls config={snapshot.config} onRefresh={onRefresh} onEditingChange={onEditingChange} />
    <GlassPanel className="wphi-metrics">
      <h2>实际运行值与目标</h2>
      <table>
        <thead><tr><th scope="col">指标</th><th scope="col">实际值</th><th scope="col">目标值</th></tr></thead>
        <tbody>{rows.map(({ label, actual, target, unit, digits = 2 }) => <tr key={label}>
          <th scope="row">{label}<small>{unit}</small></th>
          <td>{actual == null ? '—' : actual.toFixed(digits)}</td><td>{target}</td>
        </tr>)}</tbody>
      </table>
      <p className="wphi-note">当日处理水量 {latest?.processedM3.toLocaleString('zh-CN') ?? '—'} m³ · 进水目标用于识别冲击工况</p>
    </GlassPanel>
  </div>;
}
