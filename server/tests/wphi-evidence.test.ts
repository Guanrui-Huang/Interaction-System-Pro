import {it,expect} from 'vitest';
import {calculateWphi,DEFAULT_WPHI_CONFIG} from '../../shared/wphi';
import {ANALYSIS_METRICS} from '../src/domain/analysis-plan';
import type {DailyReading} from '../../shared/dashboard';
import { createWphiDataset } from '../src/domain/wphi-demo';
import { buildAnalysisEvidence } from '../src/domain/analysis-evidence';
import { createDefaultAnalysisPlan } from '../src/domain/analysis-plan';
import { refreshWphiDataset } from '../src/domain/wphi-dataset';
import { resolveReportEvidence } from '../src/domain/report-evidence-resolver';
import { composeEvidenceFallbackSlide } from '../src/services/report-evidence-fallback';
import { reportSlideSchema } from '../../shared/report-schema';
import type { SlideOutline } from '../../shared/report';
import { paginateLargeScreenOutlines } from '../src/domain/report-layout-budget';
it('uses included snapshot scores and preserves absent shock scores',()=>{
 const history=Array.from({length:30},(_,i)=>({date:`2026-07-${String(i+1).padStart(2,'0')}`,tnIn:50,tnOut:3,inflowM3:10000,blowerKwh:1000,carbonKg:500,systemNormal:true}));
 const wphi=calculateWphi(history,DEFAULT_WPHI_CONFIG);
 const row={wphi} as DailyReading;
 expect(ANALYSIS_METRICS.effluentSafetyScore.read(row)).toBe(100);
 expect(ANALYSIS_METRICS.shockResistanceScore.read(row)).toBeNaN();
 expect(ANALYSIS_METRICS.tnRemoval.read(row)).toBe(94);
 expect(ANALYSIS_METRICS).not.toHaveProperty('wphi');
 const paused={wphi:calculateWphi(history,{...DEFAULT_WPHI_CONFIG,maintenance:true})} as DailyReading;
 expect(ANALYSIS_METRICS.effluentSafetyScore.read(paused)).toBeNaN();
});

it('keeps compact WPHI evidence with directional targets and water compliance limits',()=>{
 const dataset=createWphiDataset(),plan=createDefaultAnalysisPlan(dataset);
 plan.dateRange.from=dataset.daily[0]!.date;
 const evidence=buildAnalysisEvidence({plan,dataset});
 expect(evidence.wphi!.snapshots).toHaveLength(1);
 expect(evidence.definitions.find(d=>d.key==='tnRemoval')).toMatchObject({limit:90,direction:'higher'});
 expect(evidence.definitions.find(d=>d.key==='tn')).toMatchObject({limit:3});
 expect(evidence.definitions.find(d=>d.key==='tnCv')).toMatchObject({limit:15});
 expect(evidence.thresholdBreaches.some(b=>b.metric==='tn')).toBe(true);
 const last=dataset.daily.at(-1)!.date;
 expect(evidence.thresholdBreaches.some(b=>b.metric==='tnRemoval'&&b.date===last)).toBe(false);
});

it('renders all seven score axes and narration with metric names from a real WPHI evidence bundle',()=>{
 const dataset=createWphiDataset();
 const plan=createDefaultAnalysisPlan(dataset);
 const keys=['effluentSafetyScore','removalEfficiencyScore','effluentStabilityScore','shockResistanceScore','systemStabilityScore','blowerEnergyScore','carbonConsumptionScore'] as const;
 plan.metrics=[...keys,'healthScore'];plan.modules=['health'];plan.includeAlerts=false;plan.includeHealthWeights=false;
 const evidence=resolveReportEvidence({dataset,modelId:'test-model',intent:{kind:'report',intents:[{kind:'comparison',questionPart:'七维评分比较',evidencePolicy:'data'}],knowledgeTopics:[],assistantProfile:false,analysisPlan:plan}});
 const outline:SlideOutline={id:'wphi-seven',order:1,title:'七维评分',purpose:'比较七项得分',role:'evidence',layout:'visual-focus',visualKind:'radar',evidenceKeys:[...keys],evidencePolicy:'data',status:'planned'};
 expect(paginateLargeScreenOutlines([outline],evidence)).toHaveLength(1);
 const slide=composeEvidenceFallbackSlide(outline,evidence);
 expect(reportSlideSchema.safeParse(slide).success).toBe(true);
 const visuals=slide.visual.kind==='data-dashboard'?[slide.visual.primary,...slide.visual.supporting]:[slide.visual];
 const radar=visuals.find(v=>v.kind==='radar');
 expect(radar?.kind).toBe('radar');
 if(radar?.kind==='radar') {
   expect(radar.axes.map(axis=>axis.key)).toEqual(keys);
   expect(radar.axes.find(axis=>axis.key==='blowerEnergyScore')?.value).toBeCloseTo(98.4444,3);
 }
 expect(slide.narration[0]!.text).toContain('出水安全得分');
 expect(slide.narration.some(segment=>segment.text.includes('本页查看'))).toBe(false);
 expect(slide.metrics).toHaveLength(7);
 const spoken=slide.narration.map(segment=>segment.text).join('');
 for(const key of keys) expect(spoken).toContain(ANALYSIS_METRICS[key].label);
 expect(slide.narration.length).toBeLessThanOrEqual(4);
 const withSummary=paginateLargeScreenOutlines([{...outline,evidenceKeys:[...keys,'healthScore']}],evidence);
 expect(withSummary).toHaveLength(1);
 const summarySlide=composeEvidenceFallbackSlide({...outline,evidenceKeys:withSummary[0]!.evidenceKeys},evidence);
 expect(reportSlideSchema.safeParse(summarySlide).success).toBe(true);
 const summaryVisuals=summarySlide.visual.kind==='data-dashboard'?[summarySlide.visual.primary,...summarySlide.visual.supporting]:[summarySlide.visual];
 const summaryRadar=summaryVisuals.find(v=>v.kind==='radar');
 if(summaryRadar?.kind==='radar') expect(summaryRadar.axes.map(axis=>axis.key)).toEqual(keys);
 expect(summarySlide.metrics).toHaveLength(8);
});

it('removes scores in maintenance and changes immutable identity after configuration updates',()=>{
 const dataset=createWphiDataset();
 const plan=createDefaultAnalysisPlan(dataset);
 const intent={kind:'report' as const,intents:[],knowledgeTopics:[],assistantProfile:false,analysisPlan:plan};
 const initial=resolveReportEvidence({dataset,modelId:'test',intent});
 dataset.wphi!.config.targets.tnOut=6;
 refreshWphiDataset(dataset);
 const changed=resolveReportEvidence({dataset,modelId:'test',intent});
 expect(changed.snapshotId).not.toBe(initial.snapshotId);
 expect(initial.analysis!.wphi!.snapshots[0]!.config.targets.tnOut).toBe(4);
 dataset.wphi!.config.maintenance=true;
 refreshWphiDataset(dataset);
 const paused=resolveReportEvidence({dataset,modelId:'test',intent});
 expect(paused.analysis!.definitions.every(d=>!d.key.endsWith('Score'))).toBe(true);
 expect(paused.analysis!.series.every(row=>Object.keys(row.values).every(key=>!key.endsWith('Score')))).toBe(true);
 expect(paused.analysis!.wphi!.snapshots[0]).toMatchObject({status:'maintenance',score:null});
});

it('publishes a single-day CV fallback with nonempty narration and its configured target',()=>{
 const dataset=createWphiDataset(),plan=createDefaultAnalysisPlan(dataset);
 plan.metrics=['tnCv'];plan.modules=['health'];plan.includeAlerts=false;plan.includeHealthWeights=false;
 plan.dateRange={from:dataset.daily.at(-1)!.date,to:dataset.daily.at(-1)!.date};
 const evidence=resolveReportEvidence({dataset,modelId:'test',intent:{kind:'report',intents:[],knowledgeTopics:[],assistantProfile:false,analysisPlan:plan}});
 const outline:SlideOutline={id:'cv',order:2,title:'7天CV',purpose:'解读CV',role:'evidence',layout:'split-insight',visualKind:'kpi-grid',evidenceKeys:['tnCv'],evidencePolicy:'data',status:'planned'};
 const slide=composeEvidenceFallbackSlide(outline,evidence);
 expect(()=>reportSlideSchema.parse(slide)).not.toThrow();
 expect(slide.narration.every(segment=>segment.text.trim().length>0)).toBe(true);
 expect(slide.narration.map(segment=>segment.text).join('')).toContain('15');
});
