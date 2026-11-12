import { Router } from 'express';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { DashboardDataset } from '../../../shared/dashboard';
import { wphiConfigSchema, type WphiConfig } from '../../../shared/wphi';
import { isBusinessIsoDate } from '../domain/business-date';
import { refreshWphiDataset } from '../domain/wphi-dataset';

const reportSchema=z.object({date:z.string().refine(isBusinessIsoDate),systemNormal:z.boolean(),reason:z.string().trim().max(1000).optional()}).strict()
  .refine(r=>r.systemNormal||Boolean(r.reason),'异常时请填写原因');
const stateSchema=z.object({config:wphiConfigSchema,reports:z.array(reportSchema)}).strict();
type Report=z.infer<typeof reportSchema>;
export function wphiRouter(dataset:DashboardDataset,statePath?:string):Router {
  const router=Router(); const reports=new Map<string,Report>();
  const apply=(config:WphiConfig,updates:Map<string,Report>)=>{
    if(!dataset.wphi) return;
    dataset.wphi.config=config;
    dataset.wphi.history=dataset.wphi.history.map(row=>{
      const report=updates.get(row.date);
      return report?{...row,systemNormal:report.systemNormal,abnormalReason:report.reason}:row;
    });
    refreshWphiDataset(dataset);
  };
  if(statePath&&existsSync(statePath)&&dataset.wphi) {
    const saved=stateSchema.parse(JSON.parse(readFileSync(statePath,'utf8')));
    for(const report of saved.reports) reports.set(report.date,report);
    apply(saved.config,reports);
  }
  const persist=(config:WphiConfig,updates:Map<string,Report>)=>{
    if(statePath) {
      mkdirSync(dirname(statePath),{recursive:true});
      writeFileSync(`${statePath}.tmp`,JSON.stringify({config,reports:[...updates.values()]},null,2),'utf8');
      renameSync(`${statePath}.tmp`,statePath);
    }
  };
  const payload=()=>({config:dataset.wphi!.config,snapshot:dataset.daily.at(-1)!.wphi,
    reading:dataset.wphi!.history.find(r=>r.date===dataset.daily.at(-1)!.date)});
  router.use((_req,res,next)=>{ if(!dataset.wphi) {res.status(409).json({message:'当前数据未启用WPHI'});return;} next(); });
  router.get('/',(_req,res)=>res.json(payload()));
  router.put('/config',(req,res)=>{
    const parsed=wphiConfigSchema.safeParse(req.body);
    if(!parsed.success){res.status(400).json({message:'目标值须为正数，评分边界须按顺序设置。'});return;}
    persist(parsed.data,reports); apply(parsed.data,reports); res.json(payload());
  });
  router.put('/report',(req,res)=>{
    const parsed=reportSchema.safeParse(req.body);
    if(!parsed.success||!dataset.daily.some(r=>r.date===parsed.data.date)){res.status(400).json({message:'请选择已有日期，异常时需填写原因。'});return;}
    const next=new Map(reports); next.set(parsed.data.date,parsed.data);
    persist(dataset.wphi!.config,next); apply(dataset.wphi!.config,next);
    reports.set(parsed.data.date,parsed.data);res.json(payload());
  });
  return router;
}
