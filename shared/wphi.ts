import { z } from 'zod';

export const WPHI_DIMENSIONS = {
  effluentSafety: '出水安全', removalEfficiency: '去除效率', effluentStability: '出水稳定',
  shockResistance: '抗冲击性', systemStability: '系统稳定', blowerEnergy: '风机能耗', carbonConsumption: '碳源消耗',
} as const;
export type WphiDimensionKey = keyof typeof WPHI_DIMENSIONS;
export type WphiGrade = '优秀' | '良好' | '中等' | '不足' | '异常';
export type WphiReading = { date: string; tnIn: number; tnOut: number; inflowM3: number; blowerKwh: number; carbonKg: number; systemNormal: boolean | null; abnormalReason?: string };
const positive = z.number().finite().positive();
export const wphiConfigSchema = z.object({
  targets: z.object({ tnIn: positive, tnOut: positive, tnRemoval: positive.max(100), tnCv: positive,
    blowerTotal: positive, blowerPerM3: positive, carbonTotal: positive, carbonPerM3: positive }).strict(),
  enabled: z.object({ effluentSafety: z.boolean(), removalEfficiency: z.boolean(), effluentStability: z.boolean(),
    shockResistance: z.boolean(), systemStability: z.boolean(), blowerEnergy: z.boolean(), carbonConsumption: z.boolean() }).strict(),
  maintenance: z.boolean(), cvExemptionRatio: z.number().min(0).max(1),
  lowBreakpoints: z.tuple([positive, positive, positive]).refine(([a,b,c])=>1<a && a<b && b<c),
  highBreakpoints: z.tuple([positive, positive, positive]).refine(([a,b,c])=>a<b && b<c && c<1),
}).strict();
export type WphiConfig = z.infer<typeof wphiConfigSchema>;
export const DEFAULT_WPHI_CONFIG: WphiConfig = {
  targets: { tnIn:50, tnOut:4, tnRemoval:90, tnCv:15, blowerTotal:1000, blowerPerM3:0.15, carbonTotal:500, carbonPerM3:0.08 },
  enabled: { effluentSafety:true, removalEfficiency:true, effluentStability:true, shockResistance:true, systemStability:true, blowerEnergy:true, carbonConsumption:true },
  maintenance:false, cvExemptionRatio:0.3, lowBreakpoints:[1.25,1.5,2], highBreakpoints:[0.5,0.67,0.8],
};
export type WphiDimension = { key: WphiDimensionKey; label: string; score: number | null; grade: WphiGrade | null; included: boolean;
  status: 'active' | 'disabled' | 'no-event' | 'insufficient' | 'maintenance'; explanation: string };
export type WphiMetrics = { tnIn:number|null; tnRemoval:number|null; tnCv:number|null; tnMean7:number|null;
  blowerKwhPerM3:number|null; carbonKgPerM3:number|null; abnormalDays:number|null; shockDays:number|null };
export type WphiSnapshot = { date:string; score:number|null; grade:WphiGrade|null; status:'active'|'maintenance'|'unavailable';
  dimensions:WphiDimension[]; metrics:WphiMetrics; config:WphiConfig };
export const roundWphi = (n:number) => Number(n.toFixed(2));
export const wphiGrade = (score:number):WphiGrade => score>=100?'优秀':score>=90?'良好':score>=80?'中等':score>=60?'不足':'异常';
const clamp = (n:number) => Math.max(0,Math.min(100,n));
function ratio(actual:number, target:number) {
  if(!Number.isFinite(actual)||actual<0||!Number.isFinite(target)||target<=0) throw new Error('WPHI_INVALID_VALUE');
  return actual/target;
}
export function scoreLow(actual:number, target:number, boundaries=DEFAULT_WPHI_CONFIG.lowBreakpoints):number {
  const r=ratio(actual,target); const [a,b,c]=boundaries;
  if(r<=1) return 100;
  if(r<=a) return 100-(r-1)/(a-1)*10;
  if(r<=b) return 89-(r-a)/(b-a)*9;
  if(r<=c) return 79-(r-b)/(c-b)*19;
  return clamp(60-60*(r-c));
}
export function scoreHigh(actual:number,target:number,boundaries=DEFAULT_WPHI_CONFIG.highBreakpoints):number {
  const r=ratio(actual,target); const [a,b,c]=boundaries;
  if(actual>100) throw new Error('WPHI_INVALID_REMOVAL');
  if(r>=1||actual>=99) return 100;
  if(r>=c) return 90+(r-c)/(1-c)*10;
  if(r>=b) return 80+(r-b)/(c-b)*9;
  if(r>=a) return 60+(r-a)/(b-a)*19;
  return clamp(r/a*60);
}
const valid = (n:unknown):n is number => typeof n==='number' && Number.isFinite(n) && n>=0;
function windowRows(rows:WphiReading[],asOf:string,days:number) {
  const end=Date.parse(`${asOf}T00:00:00Z`); const start=end-(days-1)*86400000;
  const values=rows.filter(r=>{const t=Date.parse(`${r.date}T00:00:00Z`);return t>=start&&t<=end;});
  const complete=values.length===days && new Set(values.map(r=>r.date)).size===days;
  return {values,complete};
}
export function calculateWphi(history:WphiReading[], configuration:WphiConfig, asOf?:string):WphiSnapshot {
  const config=wphiConfigSchema.parse(configuration);
  const date=asOf??history.map(r=>r.date).sort().at(-1);
  if(!date) throw new Error('WPHI_HISTORY_EMPTY');
  const current=history.find(r=>r.date===date);
  if(!current) throw new Error('WPHI_DATE_MISSING');
  const t=config.targets; const low=(a:number,target:number)=>scoreLow(a,target,config.lowBreakpoints);
  const seven=windowRows(history,date,7), thirty=windowRows(history,date,30);
  const sevenValid=seven.complete&&seven.values.every(r=>valid(r.tnOut));
  const mean=sevenValid?seven.values.reduce((sum,r)=>sum+r.tnOut,0)/7:null;
  const cv=mean!==null?(mean===0?0:Math.sqrt(seven.values.reduce((sum,r)=>sum+(r.tnOut-mean)**2,0)/7)/mean*100):null;
  const removal=valid(current.tnIn)&&current.tnIn>0&&valid(current.tnOut)?(current.tnIn-current.tnOut)/current.tnIn*100:null;
  const flowValid=valid(current.inflowM3)&&current.inflowM3>0;
  const blower=flowValid&&valid(current.blowerKwh)?current.blowerKwh/current.inflowM3:null;
  const carbon=flowValid&&valid(current.carbonKg)?current.carbonKg/current.inflowM3:null;
  const shocksValid=thirty.complete&&thirty.values.every(r=>valid(r.tnIn)&&valid(r.tnOut));
  const shocks=thirty.values.filter(r=>r.tnIn>t.tnIn*2);
  const normalValid=thirty.complete&&thirty.values.every(r=>typeof r.systemNormal==='boolean');
  const abnormal=normalValid?thirty.values.filter(r=>!r.systemNormal).length:null;
  const raw:Record<WphiDimensionKey,number|null>={
    effluentSafety:valid(current.tnOut)?low(current.tnOut,t.tnOut):null,
    removalEfficiency:removal!==null?scoreHigh(Math.max(0,removal),t.tnRemoval,config.highBreakpoints):null,
    effluentStability:cv!==null&&mean!==null?(mean<=t.tnOut*config.cvExemptionRatio?100:low(cv,t.tnCv)):null,
    shockResistance:shocksValid&&shocks.length?clamp(100-Math.max(0,Math.max(...shocks.map(r=>r.tnOut))/t.tnOut-1.1)*100):null,
    systemStability:abnormal!==null?100-abnormal/30*100:null,
    blowerEnergy:blower!==null?low(blower,t.blowerPerM3)*0.7+low(current.blowerKwh,t.blowerTotal)*0.3:null,
    carbonConsumption:carbon!==null?low(carbon,t.carbonPerM3)*0.7+low(current.carbonKg,t.carbonTotal)*0.3:null,
  };
  const explanations:Record<WphiDimensionKey,string>={
    effluentSafety:`出水总氮与目标 ${t.tnOut} mg/L 对比`,
    removalEfficiency:`进出水总氮计算去除率，目标 ${t.tnRemoval}%`,
    effluentStability:`近7天日均出水总氮总体CV，目标 ${t.tnCv}%${mean!==null&&mean<=t.tnOut*config.cvExemptionRatio?'；已触发低浓度豁免':''}`,
    shockResistance:'近30天高进水总氮日的最大出水总氮表现',
    systemStability:'100 − 近30天异常天数 ÷ 30 × 100',
    blowerEnergy:'吨水风机能耗得分70%＋总风机能耗得分30%',
    carbonConsumption:'吨水碳源用量得分70%＋总碳源用量得分30%',
  };
  const dimensions=(Object.keys(WPHI_DIMENSIONS) as WphiDimensionKey[]).map(key=>{
    const status:WphiDimension['status']=config.maintenance?'maintenance':!config.enabled[key]?'disabled':
      key==='shockResistance'&&shocksValid&&!shocks.length?'no-event':raw[key]===null?'insufficient':'active';
    const score=status==='active'?raw[key]:null;
    return {key,label:WPHI_DIMENSIONS[key],score,grade:score===null?null:wphiGrade(score),included:status==='active',status,
      explanation:status==='no-event'?'近30天无高进水冲击，不参与综合评分':status==='disabled'?'该维度已停用':explanations[key]};
  });
  const active=dimensions.filter(d=>d.included);
  const fullScore=active.length?active.reduce((sum,d)=>sum+d.score!,0)/active.length:null;
  return {date,score:fullScore,grade:fullScore===null?null:wphiGrade(fullScore),
    status:config.maintenance?'maintenance':fullScore===null?'unavailable':'active',dimensions,
    metrics:{tnIn:valid(current.tnIn)?current.tnIn:null,tnRemoval:removal,tnCv:cv,tnMean7:mean,blowerKwhPerM3:blower,carbonKgPerM3:carbon,
      abnormalDays:abnormal,shockDays:shocksValid?shocks.length:null}, config};
}
