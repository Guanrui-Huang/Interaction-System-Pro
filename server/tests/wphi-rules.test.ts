import {expect,it} from 'vitest';
import {calculateWphi,DEFAULT_WPHI_CONFIG} from '../../shared/wphi';
import type {AnalysisEvidence} from '../src/domain/analysis-evidence';
import {wphiRuleEvidence,stripBoundWphiRules} from '../src/domain/wphi-rule-evidence';
const history=Array.from({length:30},(_,i)=>({date:`2026-07-${String(i+1).padStart(2,'0')}`,tnIn:i===29?120:50,tnOut:3,inflowM3:10000,blowerKwh:1000,carbonKg:500,systemNormal:true}));
const snapshot=calculateWphi(history,DEFAULT_WPHI_CONFIG);
const analysis={wphi:{snapshots:[snapshot]}} as AnalysisEvidence;
it.each(['blowerEnergyScore','effluentStabilityScore','systemStabilityScore','shockResistanceScore','effluentSafetyScore','removalEfficiencyScore'])('binds exact algorithm sentences only to %s',key=>{
 const rules=wphiRuleEvidence(analysis,[key]); expect(rules.length).toBeGreaterThan(0);
 for(const rule of rules){expect(stripBoundWphiRules(rule,analysis,[key])).toBe('');expect(stripBoundWphiRules(rule,analysis,[])).toBe(rule);}
});
it('rejects altered rules and rule numbers used as measurements',()=>{
 const rule=wphiRuleEvidence(analysis,['blowerEnergyScore'])[0];
 expect(stripBoundWphiRules(rule.replace('70%','80%'),analysis,['blowerEnergyScore'])).toContain('80%');
 expect(stripBoundWphiRules('实测去除率70%。',analysis,['blowerEnergyScore'])).toBe('实测去除率70%。');
});
it('exposes no maintenance algorithm numbers',()=>{
 const paused={wphi:{snapshots:[calculateWphi(history,{...DEFAULT_WPHI_CONFIG,maintenance:true})]}} as AnalysisEvidence;
 expect(wphiRuleEvidence(paused,['blowerEnergyScore','shockResistanceScore'])).toEqual([]);
});
import {validateModelSlideDraft,type ModelSlideDraft} from '../src/domain/report-content-validation';
import {buildAnalysisEvidence} from '../src/domain/analysis-evidence';
import type {DashboardDataset,DailyReading} from '../../shared/dashboard';
import type {AnalysisMetricKey} from '../src/domain/analysis-plan';
import type {SlideOutline} from '../../shared/report';
function validateRule(text:string,key:AnalysisMetricKey,maintenance=false){
 const current={date:snapshot.date,wphi:maintenance?calculateWphi(history,{...DEFAULT_WPHI_CONFIG,maintenance:true}):snapshot} as DailyReading;
 const dataset={daily:[current],alerts:[],wphi:{config:current.wphi!.config,history}} as unknown as DashboardDataset;
 const evidence=buildAnalysisEvidence({dataset,plan:{modules:['health'],metrics:[key],dateRange:{from:snapshot.date,to:snapshot.date},methods:['summary'],includeAlerts:false,includeHealthWeights:false}});
 const outline:SlideOutline={id:'slide-0',order:0,title:'算法说明',purpose:'解释评分',role:'answer',layout:'split-insight',evidencePolicy:'data',visualKind:'kpi-grid',evidenceKeys:[key],status:'planned'};
 const draft:ModelSlideDraft={title:'算法说明',takeaway:text,takeawayClaimIds:['rule'],visualKind:'kpi-grid',evidenceKeys:[key],claims:[{id:'rule',text,kind:'onsite-fact',evidenceKeys:[key]}],narration:[{text,claimIds:['rule']},{text,claimIds:['rule']}]};
 return validateModelSlideDraft({draft,outline,bundle:{snapshotId:'single-day',analysis:evidence,knowledge:[]},sensitiveValues:[]});
}
it.each(['blowerEnergyScore','carbonConsumptionScore','effluentStabilityScore','systemStabilityScore','shockResistanceScore','effluentSafetyScore','removalEfficiencyScore'] as AnalysisMetricKey[])('validates full single-day draft including claims/takeaway/narration: %s',key=>{
 const rules=wphiRuleEvidence(analysis,[key]);
 expect(()=>validateRule(rules.join(''),key)).not.toThrow();
});
it.each([
 ['风机能耗评分规则：吨水风机能耗得分权重80%，总风机能耗得分权重20%。','blowerEnergyScore'],
 ['实测总氮去除率70%。','blowerEnergyScore'],
 ['水质达标率70%。','blowerEnergyScore'],
 ['系统稳定评分规则：100减去近7天异常天数除以7再乘100。','systemStabilityScore'],
 ['风机能耗评分目标：吨水0.25 kWh/m³，总量1000 kWh/d。','blowerEnergyScore'],
 [wphiRuleEvidence(analysis,['blowerEnergyScore'])[0],'effluentStabilityScore'],
] as [string,AnalysisMetricKey][])('rejects invalid or unbound rule in full draft: %s',(text,key)=>expect(()=>validateRule(text,key)).toThrow());
it('rejects rule numeric content for maintenance in full validator',()=>expect(()=>validateRule(wphiRuleEvidence(analysis,['blowerEnergyScore'])[0],'blowerEnergyScore',true)).toThrow());
import {composeEvidenceFallbackSlide} from '../src/services/report-evidence-fallback';
import {composeSlide} from '../src/services/intent-first-slide-composer';
it('production composeSlide accepts controlled scoring rules from provider',async()=>{
 const key='blowerEnergyScore'; const text=wphiRuleEvidence(analysis,[key]).join('');
 const score=snapshot.dimensions.find(d=>d.key==='blowerEnergy')!.score!;
 const a={...analysis,scope:{modules:['health'],metrics:[key],dateRange:{from:snapshot.date,to:snapshot.date},sampleCount:1,granularity:'daily'},definitions:[{key,label:'风机能耗得分',unit:'分'}],series:[{date:snapshot.date,values:{[key]:score}}],aggregates:{[key]:{min:score,max:score,latest:score,average:score,changeRate:0}},thresholdBreaches:[],correlations:[],alerts:[]} as AnalysisEvidence;
 const outline:SlideOutline={id:'slide-0',order:0,title:'评分说明',purpose:'解释评分',role:'answer',layout:'split-insight',evidencePolicy:'data',visualKind:'kpi-grid',evidenceKeys:[key],status:'planned'};
 const evidence={snapshotId:'single-day',analysis:a,knowledge:[]};
 const draft={title:'评分说明',takeaway:text,takeawayClaimIds:['rule'],visualKind:'kpi-grid',evidenceKeys:[key],claims:[{id:'rule',text,kind:'onsite-fact',evidenceKeys:[key]}],narration:[{text,claimIds:['rule']},{text,claimIds:['rule']}]};
 const result=await composeSlide({outline,evidence},{settings:{apiKey:'test',baseUrl:'https://test.invalid',model:'test'},requestCompletion:async()=>JSON.stringify(draft)});
 expect(result.narration.map(n=>n.text).join('')).toContain('权重70%');
 const fallback=composeEvidenceFallbackSlide(outline,evidence);
 expect(fallback.narration.map(n=>n.text).join('')).toContain('权重70%');
 expect(fallback.narration.map(n=>n.text).join('')).toContain('总量1000');
 expect(fallback.takeaway).not.toContain('期间峰值');
});
