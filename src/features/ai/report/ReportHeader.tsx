import type { ReactNode } from 'react';
import type { ReportJobSnapshot } from '../../../../shared/report';
import type { ReportSessionPhase } from './useReportSession';

const phaseLabels: Record<ReportSessionPhase, string> = {
  idle: '等待任务',
  creating: '正在建立任务',
  restoring: '正在恢复任务',
  connecting: '正在连接任务流',
  connected: '任务流在线',
  reconnecting: '正在恢复任务流',
  ready: '汇报可用',
  error: '任务需要处理',
  exited: '任务已退出',
};

export function ReportHeader({
  snapshot,
  phase,
  actions,
  onExit,
}: {
  snapshot: ReportJobSnapshot | null;
  phase: ReportSessionPhase;
  actions?: ReactNode;
  onExit(): void;
}) {
  const complete = snapshot?.outline.filter((item) => item.status === 'ready').length ?? 0;
  const total = snapshot?.outline.length ?? 0;
  const placeholderRange = !snapshot || (
    snapshot.scope.sampleCount === 0
    && snapshot.scope.dateRange.from === '1970-01-01'
    && snapshot.scope.dateRange.to === '1970-01-01'
  );
  return (
    <header className="report-header">
      <div className="report-header__identity"><span aria-hidden="true">WT</span><div><p>WATER OPS · REPORT BUS</p><h1>{snapshot?.question ?? (phase === 'restoring' ? '正在恢复动态汇报' : '正在创建动态汇报')}</h1></div></div>
      <dl className="report-header__bus">
        <div><dt>任务状态</dt><dd><i aria-hidden="true" />{phaseLabels[phase]}</dd></div>
        <div><dt>页面就绪</dt><dd>{String(complete).padStart(2, '0')} / {String(total).padStart(2, '0')}</dd></div>
        <div><dt>数据范围</dt><dd>{placeholderRange ? '数据范围待确认' : `${snapshot.scope.dateRange.from}—${snapshot.scope.dateRange.to}`}</dd></div>
      </dl>
      {actions ? <div className="report-header__actions">{actions}</div> : null}
      <button className="report-header__exit" type="button" onClick={onExit}>退出汇报</button>
    </header>
  );
}
