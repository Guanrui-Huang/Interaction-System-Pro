import type { AnalysisEvidence } from './analysis-evidence';

/** Exact controlled statements, scoped to an included score and its configuration. */
export function wphiRuleEvidence(analysis: AnalysisEvidence | undefined, keys: readonly string[]): string[] {
  const snapshot = analysis?.wphi?.snapshots.at(-1);
  if (!snapshot || snapshot.status !== 'active') return [];
  const t = snapshot.config.targets;
  const rules: Record<string,string[]> = {
    blowerEnergyScore: [`风机能耗评分规则：吨水风机能耗得分权重70%，总风机能耗得分权重30%。`, `风机能耗评分目标：吨水${t.blowerPerM3} kWh/m³，总量${t.blowerTotal} kWh/d。`],
    carbonConsumptionScore: [`碳源消耗评分规则：吨水碳源用量得分权重70%，总碳源用量得分权重30%。`, `碳源消耗评分目标：吨水${t.carbonPerM3} kg/m³，总量${t.carbonTotal} kg/d。`],
    effluentStabilityScore: [`出水稳定评分规则：采用近7天出水总氮的总体标准差除以均值计算CV，目标${t.tnCv}%。`, `出水稳定豁免规则：近7天平均出水总氮不超过出水目标的${Number((snapshot.config.cvExemptionRatio * 100).toFixed(6))}%时，该维度得100分。`],
    systemStabilityScore: ['系统稳定评分规则：100减去近30天异常天数除以30再乘100。'],
    shockResistanceScore: [`抗冲击评分规则：进水总氮超过基线${t.tnIn} mg/L的2倍视为冲击；冲击日最大出水总氮超过目标${t.tnOut} mg/L的110%后扣分。`],
    effluentSafetyScore: [`出水安全评分目标：出水总氮${t.tnOut} mg/L。`],
    removalEfficiencyScore: [`去除效率评分目标：总氮去除率${t.tnRemoval}%，越高越好。`],
  };
  const overall = keys.includes('healthScore') && snapshot.score !== null
    ? [`综合健康评分规则：取${snapshot.dimensions.filter(d => d.included).length}个参与维度得分的算术平均，停用及无冲击维度不计入。`] : [];
  return [...overall, ...snapshot.dimensions.flatMap(d => d.included && keys.includes(`${d.key}Score`) ? rules[`${d.key}Score`] ?? [] : [])];
}

export function stripBoundWphiRules(text: string, analysis: AnalysisEvidence | undefined, keys: readonly string[]): string {
  // Only complete standalone sentences qualify; suffixes cannot turn a rule into a measurement.
  const allowed = new Set(wphiRuleEvidence(analysis, keys));
  return text.split(/(?<=[。！？])/u).filter(sentence => !allowed.has(sentence.trim())).join('');
}
