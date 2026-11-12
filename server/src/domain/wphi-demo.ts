import { createDailyReadings } from '../../../scripts/generate-demo-workbook';
import type { DashboardDataset } from '../../../shared/dashboard';
import { DEFAULT_WPHI_CONFIG, type WphiReading } from '../../../shared/wphi';
import { isBusinessIsoDate } from './business-date';
import { refreshWphiDataset } from './wphi-dataset';

/** Keep the original manufacturer example and extend its simulated history on request. */
export function createWphiDataset(through?: string):DashboardDataset {
  const original = createDailyReadings();
  const exampleDate = original.at(-1)!.date;
  const endDate = through ?? exampleDate;
  if (!isBusinessIsoDate(endDate) || endDate < exampleDate) {
    throw new RangeError(`WPHI end date must be a valid date on or after ${exampleDate}`);
  }
  const addedDays = (Date.parse(endDate) - Date.parse(exampleDate)) / 86_400_000;
  const daily = addedDays ? createDailyReadings(original.length - 1 + addedDays) : original;
  const first=Date.parse(`${daily[0]!.date}T00:00:00Z`);
  const history:WphiReading[]=Array.from({length:daily.length+30},(_,i)=>{
    const phase=i/14;
    return {date:new Date(first+(i-30)*86400000).toISOString().slice(0,10),
      tnIn:i%61===0?120:Number((55+5*Math.sin(phase)).toFixed(3)),
      tnOut:Number((4.4+0.9*Math.sin(phase)+0.5*Math.cos(i/3)).toFixed(3)),
      inflowM3:Math.round(6000+450*Math.sin(phase/2)),
      blowerKwh:Math.round(960+120*Math.sin(phase/3)),carbonKg:Number((470+50*Math.cos(phase/2)).toFixed(2)),
      systemNormal:i%93!==0};
  });
  const end=original.length+30-1;
  for(let i=end-29;i<=end;i++) { history[i]!.systemNormal=true; history[i]!.tnIn=55; }
  history[end-12]!.tnIn=120; history[end-12]!.tnOut=4.2;
  for(let i=0;i<7;i++) history[end-6+i]!.tnOut=i===6?5:5+(i%2?1:-1)*Math.sqrt(7/6);
  Object.assign(history[end]!,{tnIn:55,tnOut:5,inflowM3:6000,blowerKwh:950,carbonKg:480});
  daily.forEach((row,i)=>{
    const raw=history[i+30]!;
    Object.assign(row,{processedM3:raw.inflowM3,tn:raw.tnOut,blowerKwh:raw.blowerKwh,carbonSourceKg:raw.carbonKg,
      totalKwh:Math.round(raw.blowerKwh/0.4),complianceRate:raw.tnOut<=3?100:80});
    row.kwhPerM3=row.totalKwh/row.processedM3;
    row.carbonEmissionKg=Number((row.totalKwh*0.581).toFixed(2));
    row.carbonReductionKg=Number((row.carbonEmissionKg*0.128).toFixed(2));
    row.savedYuan=Number((row.totalKwh*0.128*0.86).toFixed(2));
  });
  const dataset:DashboardDataset={plantName:'智慧污水处理厂',daily,alerts:[{
    date:history[end-12]!.date,metric:'进水总氮',level:'关注',reason:'进水总氮120 mg/L，超过50 mg/L目标的2倍。',recommendation:'关注对应日期的出水总氮与抗冲击性评分。',
  }],health:{weights:{quality:.4,flow:.2,energy:.25,carbonSource:.15},score:0,grade:'关注'},
    wphi:{config:structuredClone(DEFAULT_WPHI_CONFIG),history}};
  refreshWphiDataset(dataset);
  return dataset;
}
