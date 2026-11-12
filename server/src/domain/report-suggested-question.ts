export const CARBON_OPTIMIZATION_TOPIC = '碳源投加优化的验证步骤与用量计算所需数据';

export function matchSuggestedReportQuestion(question: string): 'total-nitrogen-trend' | 'carbon-optimization' | undefined {
  const text = question.normalize('NFKC').replace(/\s+/gu, '').replace(/[。！？?！]+$/u, '');
  if (/^(?:请)?分析(?:最近|近|过去)(?:30|三十)[天日](?:出水)?总氮(?:变化)?(?:趋势|走势)$/u.test(text)) {
    return 'total-nitrogen-trend';
  }
  if (/^(?:请)?(?:计算|给出|提供)?当前碳源投加(?:的)?优化建议$/u.test(text)) {
    return 'carbon-optimization';
  }
  return undefined;
}
