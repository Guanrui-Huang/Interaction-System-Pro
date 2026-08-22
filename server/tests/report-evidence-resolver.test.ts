import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkbook } from '../src/data/workbook';
import { publicAssistantProfile } from '../src/domain/public-assistant-profile';
import { resolveReportEvidence } from '../src/domain/report-evidence-resolver';
import type { AnalysisPlan } from '../src/domain/analysis-plan';
import type { ReportIntentPlan } from '../src/domain/report-intent';

const dataset = loadWorkbook(resolve('data/智慧污水处理厂_演示数据.xlsx'));
const dates = dataset.daily.map(({ date }) => date).sort((left, right) => left.localeCompare(right));

const analysisPlan: AnalysisPlan = {
  modules: ['water-quality', 'energy'],
  metrics: ['tn', 'kwhPerM3'],
  dateRange: { from: dates[0]!, to: dates.at(-1)! },
  methods: ['trend', 'summary'],
  includeAlerts: true,
  includeHealthWeights: true,
};

function reportPlan(overrides: Partial<Extract<ReportIntentPlan, { kind: 'report' }>> = {}): Extract<ReportIntentPlan, { kind: 'report' }> {
  return {
    kind: 'report',
    intents: [{ kind: 'knowledge', questionPart: '测试问题', evidencePolicy: 'knowledge' }],
    knowledgeTopics: [],
    assistantProfile: false,
    ...overrides,
  };
}

describe('resolveReportEvidence', () => {
  it('resolves knowledge contexts by array order without building analysis evidence', () => {
    const evidence = resolveReportEvidence({
      intent: reportPlan({ knowledgeTopics: ['污水脱氮', '总氮'] }),
      dataset,
      modelId: 'private-experimental-id',
    });

    expect(evidence).toMatchObject({
      analysis: undefined,
      knowledge: [
        { key: 'knowledge:0', topic: '污水脱氮', provenance: 'model-knowledge' },
        { key: 'knowledge:1', topic: '总氮', provenance: 'model-knowledge' },
      ],
    });
  });

  it('resolves analysis evidence only for a supplied analysis plan', () => {
    const evidence = resolveReportEvidence({
      intent: reportPlan({ analysisPlan }),
      dataset,
      modelId: 'deepseek-chat',
    });

    expect(evidence).toMatchObject({
      analysis: { scope: { metrics: ['tn', 'kwhPerM3'] } },
      knowledge: [],
    });
  });

  it('adds the trusted assistant profile only when requested', () => {
    const requested = resolveReportEvidence({
      intent: reportPlan({ assistantProfile: true }),
      dataset,
      modelId: 'deepseek-v4-flash',
    });
    const omitted = resolveReportEvidence({
      intent: reportPlan(),
      dataset,
      modelId: 'deepseek-v4-flash',
    });

    expect(requested.assistantProfile).toMatchObject({
      key: 'assistant-profile',
      publicModelName: 'DeepSeek v4-flash',
    });
    expect(omitted.assistantProfile).toBeUndefined();
  });

  it('resolves analysis, knowledge, and assistant profile in one mixed bundle', () => {
    const evidence = resolveReportEvidence({
      intent: reportPlan({
        analysisPlan,
        knowledgeTopics: ['总氮'],
        assistantProfile: true,
      }),
      dataset,
      modelId: 'deepseek-v4-flash',
    });

    expect(evidence).toMatchObject({
      analysis: { scope: { metrics: ['tn', 'kwhPerM3'] } },
      knowledge: [{ key: 'knowledge:0', topic: '总氮', provenance: 'model-knowledge' }],
      assistantProfile: {
        key: 'assistant-profile',
        publicModelName: 'DeepSeek v4-flash',
      },
    });
  });

  it('creates the same snapshot for reordered equivalent exposed data', () => {
    const ordered = resolveReportEvidence({
      intent: reportPlan({ analysisPlan }),
      dataset,
      modelId: 'deepseek-chat',
    });
    const reordered = resolveReportEvidence({
      intent: reportPlan({
        analysisPlan: { ...analysisPlan, metrics: ['kwhPerM3', 'tn'], modules: ['energy', 'water-quality'] },
      }),
      dataset: { ...dataset, daily: [...dataset.daily].reverse(), alerts: [...dataset.alerts].reverse() },
      modelId: 'deepseek-chat',
    });

    expect(reordered.snapshotId).toBe(ordered.snapshotId);
  });

  it('changes the snapshot for an unrelated knowledge question', () => {
    const first = resolveReportEvidence({
      intent: reportPlan({ knowledgeTopics: ['污水脱氮'] }),
      dataset,
      modelId: 'deepseek-chat',
    });
    const second = resolveReportEvidence({
      intent: reportPlan({ knowledgeTopics: ['污水除磷'] }),
      dataset,
      modelId: 'deepseek-chat',
    });

    expect(second.snapshotId).not.toBe(first.snapshotId);
  });

  it('keeps the snapshot stable when equivalent knowledge topics are reordered', () => {
    const ordered = resolveReportEvidence({
      intent: reportPlan({ knowledgeTopics: ['污水脱氮', '污水除磷'] }),
      dataset,
      modelId: 'deepseek-chat',
    });
    const reordered = resolveReportEvidence({
      intent: reportPlan({ knowledgeTopics: ['污水除磷', '污水脱氮'] }),
      dataset,
      modelId: 'deepseek-chat',
    });

    expect(reordered.snapshotId).toBe(ordered.snapshotId);
  });

  it('changes the snapshot when a selected alert identity changes', () => {
    const original = resolveReportEvidence({
      intent: reportPlan({ analysisPlan }),
      dataset,
      modelId: 'deepseek-chat',
    });
    const selectedAlert = original.analysis!.alerts[0]!;
    const selectedIndex = dataset.alerts.findIndex((alert) => (
      alert.date === selectedAlert.date
      && alert.metric === selectedAlert.metric
      && alert.level === selectedAlert.level
      && alert.reason === selectedAlert.reason
      && alert.recommendation === selectedAlert.recommendation
    ));
    expect(selectedIndex).toBeGreaterThanOrEqual(0);
    const changedAlerts = dataset.alerts.map((alert, index) => (
      index === selectedIndex ? { ...alert, reason: `${alert.reason}（身份已变更）` } : alert
    ));
    const changed = resolveReportEvidence({
      intent: reportPlan({ analysisPlan }),
      dataset: { ...dataset, alerts: changedAlerts },
      modelId: 'deepseek-chat',
    });

    expect(changed.snapshotId).not.toBe(original.snapshotId);
  });

  it('changes the snapshot when the exposed public assistant identity changes', () => {
    const chat = resolveReportEvidence({
      intent: reportPlan({ assistantProfile: true }),
      dataset,
      modelId: 'deepseek-chat',
    });
    const reasoner = resolveReportEvidence({
      intent: reportPlan({ assistantProfile: true }),
      dataset,
      modelId: 'deepseek-reasoner',
    });

    expect(reasoner.snapshotId).not.toBe(chat.snapshotId);
  });

  it('does not hash raw unknown model IDs into the snapshot', () => {
    const first = resolveReportEvidence({
      intent: reportPlan({ assistantProfile: true }),
      dataset,
      modelId: 'private-model-alpha',
    });
    const second = resolveReportEvidence({
      intent: reportPlan({ assistantProfile: true }),
      dataset,
      modelId: 'private-model-beta',
    });

    expect(second.snapshotId).toBe(first.snapshotId);
    expect(JSON.stringify(first)).not.toContain('private-model-alpha');
    expect(JSON.stringify(second)).not.toContain('private-model-beta');
  });

  it('returns a frozen bundle with no raw model ID or mutable input references', () => {
    const evidence = resolveReportEvidence({
      intent: reportPlan({ knowledgeTopics: ['污水脱氮'], assistantProfile: true }),
      dataset,
      modelId: 'private-experimental-id',
    });
    const serialized = JSON.stringify(evidence);

    expect(evidence).not.toHaveProperty('modelId');
    expect(serialized).not.toContain('private-experimental-id');
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.knowledge)).toBe(true);
    expect(Object.isFrozen(evidence.assistantProfile)).toBe(true);
    expect(() => {
      evidence.knowledge[0]!.topic = '调用方修改';
    }).toThrow(TypeError);
    expect(JSON.stringify(evidence)).toBe(serialized);
  });

  it('deeply freezes nested analysis and assistant profile arrays', () => {
    const evidence = resolveReportEvidence({
      intent: reportPlan({ analysisPlan, assistantProfile: true }),
      dataset,
      modelId: 'deepseek-chat',
    });
    const serialized = JSON.stringify(evidence);

    expect(Object.isFrozen(evidence.analysis!.scope.metrics)).toBe(true);
    expect(Object.isFrozen(evidence.analysis!.series)).toBe(true);
    expect(Object.isFrozen(evidence.assistantProfile!.capabilities)).toBe(true);
    expect(Object.isFrozen(evidence.assistantProfile!.limitations)).toBe(true);
    expect(() => evidence.analysis!.scope.metrics.push('ammonia')).toThrow(TypeError);
    expect(() => evidence.assistantProfile!.capabilities.push('调用方新增能力')).toThrow(TypeError);
    expect(JSON.stringify(evidence)).toBe(serialized);
  });

  it('does not expose credential-shaped knowledge topics or workbook paths', () => {
    const credential = 'unit-test-secret';
    const workbookPath = '/private/operator/plant.xlsx';
    const evidence = resolveReportEvidence({
      intent: reportPlan({ knowledgeTopics: [`DEEPSEEK_API_KEY=${credential}`, workbookPath] }),
      dataset,
      modelId: 'deepseek-chat',
    });

    expect(JSON.stringify(evidence)).not.toContain(credential);
    expect(JSON.stringify(evidence)).not.toContain(workbookPath);
  });

  it('redacts a private model ID when a knowledge topic equals or contains it', () => {
    const privateModelId = 'private-experimental-model-2026';
    const evidence = resolveReportEvidence({
      intent: reportPlan({
        knowledgeTopics: [privateModelId, `请解释 ${privateModelId} 的能力`],
      }),
      dataset,
      modelId: privateModelId,
    });

    expect(JSON.stringify(evidence)).not.toContain(privateModelId);
  });
});

describe('publicAssistantProfile', () => {
  it.each([
    ['deepseek-v4-flash', 'DeepSeek v4-flash'],
    ['deepseek-chat', 'DeepSeek Chat'],
    ['deepseek-reasoner', 'DeepSeek Reasoner'],
  ])('maps the public model ID %s through the closed public map', (modelId, publicModelName) => {
    expect(publicAssistantProfile(modelId)).toMatchObject({
      key: 'assistant-profile',
      publicModelName,
    });
  });

  it('does not expose an unknown private model ID', () => {
    const profile = publicAssistantProfile('private-experimental-id');

    expect(profile.publicModelName).toBeUndefined();
    expect(JSON.stringify(profile)).not.toContain('private-experimental-id');
  });

  it('treats inherited object property names as unknown model IDs', () => {
    expect(publicAssistantProfile('toString').publicModelName).toBeUndefined();
  });
});
