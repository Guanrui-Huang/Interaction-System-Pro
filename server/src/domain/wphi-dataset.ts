import type { DashboardDataset } from '../../../shared/dashboard';
import { calculateWphi } from '../../../shared/wphi';
import { calculateHealth } from './health';

/** Recompute from full history before any date filtering or report aggregation. */
export function refreshWphiDataset(dataset:DashboardDataset):void {
  if(!dataset.wphi) return;
  const {history,config}=dataset.wphi;
  dataset.daily=dataset.daily.map(row=>({ ...row,wphi:calculateWphi(history,config,row.date) }));
  dataset.health=calculateHealth(dataset.daily);
}
