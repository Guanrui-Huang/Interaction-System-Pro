import { describe, expect, it } from 'vitest';
import type { ConversationTurn, ReportSlide } from '../../shared/report';
import type { ReportEvidenceBundle } from '../src/domain/report-evidence';
import {
  appendConversationTurn,
  applyUserCorrection,
  buildFollowUpContext,
  compactConversation,
  createConversationMemory,
  type ConfirmedFact,
} from '../src/domain/conversation-memory';

const fact: ConfirmedFact = {
  evidenceSnapshotId: 'dataset-2026-08-12',
  evidenceKey: 'blowerKwh',
  value: 128.4,
  unit: 'kWh',
  dateRange: { from: '2026-08-01', to: '2026-08-12' },
  sampleCount: 12,
  formula: 'percent-change',
};

function turn(index: number): ConversationTurn {
  return {
    id: `turn-${index}`,
    question: `第 ${index} 轮问题`,
    answer: `第 ${index} 轮回答`,
    citedEvidence: [],
    needsClarification: false,
    createdAt: `2026-08-${String(Math.min(index, 12)).padStart(2, '0')}T00:00:00.000Z`,
  };
}

function slide(snapshotId = 'dataset-2026-08-12'): ReportSlide {
  const claimId = 'slide-energy-claim';
  const ref = {
    key: 'blowerKwh',
    kind: 'metric' as const,
    source: 'excel' as const,
    snapshotId,
    module: 'energy' as const,
    label: '鼓风能耗',
    unit: 'kWh',
    dateRange: { from: '2026-08-01', to: '2026-08-12' },
    sampleCount: 12,
  };
  const metric = { ...ref, value: 128.4, claimIds: [claimId] };
  return {
    id: 'slide-energy',
    order: 2,
    evidenceSnapshotId: snapshotId,
    role: 'answer',
    layout: 'split-insight',
    evidencePolicy: 'data',
    title: '鼓风能耗趋势',
    takeaway: '鼓风能耗保持稳定',
    takeawayClaimIds: [claimId],
    claims: [{ id: claimId, text: '鼓风能耗保持稳定', kind: 'onsite-fact', evidenceRefs: [ref] }],
    visual: { kind: 'kpi-grid', metrics: [metric] },
    metrics: [metric],
    evidenceRefs: [ref],
    narration: [
      { id: 'segment-1', text: '先看鼓风能耗。', speechId: 'speech-1', claimIds: [claimId] },
      { id: 'segment-2', text: '再看变化原因。', speechId: 'speech-2', claimIds: [claimId] },
    ],
  };
}

const evidenceBundle: ReportEvidenceBundle = {
  snapshotId: 'dataset-2026-08-12',
  knowledge: [],
  analysis: {
    scope: {
      modules: ['energy'],
      metrics: ['blowerKwh'],
      dateRange: { from: '2026-08-01', to: '2026-08-12' },
      sampleCount: 12,
      granularity: 'daily',
    },
    definitions: [{ key: 'blowerKwh', label: '鼓风能耗', unit: 'kWh' }],
    series: [{ date: '2026-08-12', values: { blowerKwh: 128.4 } }],
    aggregates: {
      blowerKwh: { min: 128.4, max: 128.4, average: 128.4, latest: 128.4, changeRate: 0 },
    },
    thresholdBreaches: [],
    correlations: [],
    alerts: [],
  },
};

describe('report-scoped conversation memory', () => {
  it('keeps six recent turns and compacts older text without dropping ledger, corrections or unresolved intents', () => {
    let memory = createConversationMemory({
      originalQuestion: '分析鼓风能耗',
      evidenceSnapshotId: evidenceBundle.snapshotId,
    });
    memory = { ...memory, factLedger: [fact], unresolvedIntents: ['比较上月'] };
    memory = applyUserCorrection(memory, {
      evidenceSnapshotId: fact.evidenceSnapshotId,
      evidenceKey: 'blowerKwh',
      value: 126.8,
      unit: 'kWh',
      statement: '我说的是鼓风机，修正为 126.8 kWh',
      createdAt: '2026-08-12T08:00:00.000Z',
    });
    for (let index = 1; index <= 13; index += 1) {
      memory = appendConversationTurn(memory, turn(index));
    }

    const compacted = compactConversation(memory);

    expect(compacted.turns.map(({ id }) => id)).toEqual([
      'turn-8', 'turn-9', 'turn-10', 'turn-11', 'turn-12', 'turn-13',
    ]);
    expect(compacted.compactSummary).toContain('第 7 轮回答');
    expect(compacted.factLedger).toEqual(memory.factLedger);
    expect(compacted.userCorrections).toEqual(memory.userCorrections);
    expect(compacted.unresolvedIntents).toEqual(['比较上月']);
    expect(memory.turns).toHaveLength(13);
  });

  it('retains unit, date range, sample count and formula in immutable confirmed facts', () => {
    const original = createConversationMemory({
      originalQuestion: '分析鼓风能耗',
      evidenceSnapshotId: evidenceBundle.snapshotId,
      factLedger: [fact],
    });

    const next = appendConversationTurn(original, turn(1));

    expect(next.factLedger[0]).toEqual(fact);
    expect(next.factLedger[0]).not.toBe(fact);
    expect(() => { (next.factLedger[0] as { value: number }).value = 0; }).toThrow();
    expect(original.turns).toHaveLength(0);
  });

  it('gives an explicit user correction precedence over the prior ledger fact', () => {
    const original = createConversationMemory({
      originalQuestion: '分析鼓风能耗',
      evidenceSnapshotId: evidenceBundle.snapshotId,
      factLedger: [fact],
    });

    const corrected = applyUserCorrection(original, {
      evidenceSnapshotId: fact.evidenceSnapshotId,
      evidenceKey: 'blowerKwh',
      value: 126.8,
      unit: 'kWh',
      statement: '我说的是鼓风机，修正为 126.8 kWh',
      createdAt: '2026-08-12T08:00:00.000Z',
    });

    expect(corrected.factLedger).toEqual([{ ...fact, value: 126.8 }]);
    expect(corrected.userCorrections).toHaveLength(1);
    expect(original.factLedger).toEqual([fact]);
  });

  it('keeps a legacy unscoped correction lazy without rewriting old facts, new facts, or current-page context', () => {
    const legacyCorrection = {
      evidenceKey: 'blowerKwh', value: 126.8, unit: 'kWh', statement: '旧版未绑定修正',
      createdAt: '2026-08-12T08:00:00.000Z',
    };
    const newerFact = { ...fact, evidenceSnapshotId: 'dataset-newer', value: 130.2 };
    const original = createConversationMemory({
      originalQuestion: '比较两个快照',
      factLedger: [fact],
      userCorrections: [legacyCorrection],
    });

    const next = appendConversationTurn(original, turn(1), { facts: [newerFact] });
    const context = buildFollowUpContext(next, slide(fact.evidenceSnapshotId), evidenceBundle);

    expect(next.factLedger.map(({ evidenceSnapshotId, value }) => ({ evidenceSnapshotId, value }))).toEqual([
      { evidenceSnapshotId: fact.evidenceSnapshotId, value: fact.value },
      { evidenceSnapshotId: newerFact.evidenceSnapshotId, value: newerFact.value },
    ]);
    expect(next.userCorrections).toEqual([legacyCorrection]);
    expect(context.userCorrections).toEqual([]);
  });

  it('keeps same-key facts and corrections isolated by evidence snapshot', () => {
    const newerFact = { ...fact, evidenceSnapshotId: 'dataset-newer', value: 130.2 };
    const original = createConversationMemory({
      originalQuestion: '比较两个快照',
      factLedger: [fact, newerFact],
    });
    const oldCorrected = applyUserCorrection(original, {
      evidenceSnapshotId: fact.evidenceSnapshotId,
      evidenceKey: fact.evidenceKey,
      value: 126.8,
      unit: 'kWh',
      statement: '旧快照修正为 126.8 kWh',
      createdAt: '2026-08-12T08:00:00.000Z',
    });
    const bothCorrected = applyUserCorrection(oldCorrected, {
      evidenceSnapshotId: newerFact.evidenceSnapshotId,
      evidenceKey: newerFact.evidenceKey,
      value: 129.5,
      unit: 'kWh',
      statement: '新快照修正为 129.5 kWh',
      createdAt: '2026-08-13T08:00:00.000Z',
    });

    expect(bothCorrected.factLedger.map(({ evidenceSnapshotId, value }) => ({ evidenceSnapshotId, value })))
      .toEqual([
        { evidenceSnapshotId: fact.evidenceSnapshotId, value: 126.8 },
        { evidenceSnapshotId: newerFact.evidenceSnapshotId, value: 129.5 },
      ]);
    expect(bothCorrected.userCorrections).toHaveLength(2);
  });

  it('merges facts from different turns by evidence key instead of replacing older facts', () => {
    const original = createConversationMemory({
      originalQuestion: '分析能耗和水质',
      evidenceSnapshotId: evidenceBundle.snapshotId,
      factLedger: [fact],
    });
    const tnFact: ConfirmedFact = {
      evidenceSnapshotId: evidenceBundle.snapshotId, evidenceKey: 'tn', value: 2.7, unit: 'mg/L',
      dateRange: { from: '2026-08-01', to: '2026-08-12' }, sampleCount: 12,
    };

    const next = appendConversationTurn(original, turn(1), { facts: [tnFact] });

    expect(next.factLedger).toEqual([fact, tnFact]);
  });

  it('builds pronoun context from current page, prior turn and compact summary', () => {
    const base = createConversationMemory({
      originalQuestion: '分析鼓风能耗',
      evidenceSnapshotId: evidenceBundle.snapshotId,
      activeSlideId: 'slide-energy',
      narrationCursor: { slideId: 'slide-energy', segmentId: 'segment-2', offsetMs: 1260 },
      compactSummary: '更早对话确认了鼓风能耗对象。',
      factLedger: [fact],
    });
    const memory = appendConversationTurn(base, {
      ...turn(1),
      question: '它为什么升高？',
      answer: '这里的“它”指鼓风能耗。',
    });

    const context = buildFollowUpContext(memory, slide(), evidenceBundle);

    expect(context).toMatchObject({
      activeSlideId: 'slide-energy',
      currentEvidenceSnapshotId: 'dataset-2026-08-12',
      interruptedSegmentId: 'segment-2',
      compactSummary: '更早对话确认了鼓风能耗对象。',
      previousTurn: { question: '它为什么升高？' },
    });
    expect(JSON.stringify(context)).toContain('鼓风能耗');
  });

  it('binds follow-up context to the selected old or new slide snapshot', () => {
    const oldBundle = { ...evidenceBundle, snapshotId: 'snapshot-old' };
    const newBundle = { ...evidenceBundle, snapshotId: 'snapshot-new' };
    const memory = createConversationMemory({ originalQuestion: '比较两个页面' });

    const oldContext = buildFollowUpContext(memory, slide('snapshot-old'), oldBundle);
    const newContext = buildFollowUpContext(memory, slide('snapshot-new'), newBundle);

    expect(oldContext).toMatchObject({ currentEvidenceSnapshotId: 'snapshot-old' });
    expect(newContext).toMatchObject({ currentEvidenceSnapshotId: 'snapshot-new' });
    expect(oldContext.factLedger).not.toBe(newContext.factLedger);
  });

  it('keeps a validated object correction through compaction and gives it to later context', () => {
    let memory = appendConversationTurn(createConversationMemory({
      originalQuestion: '分析能耗',
      evidenceSnapshotId: evidenceBundle.snapshotId,
    }), turn(0), {
      intentCorrection: {
        from: { kind: 'evidence', key: 'totalKwh' },
        to: { kind: 'evidence', key: 'blowerKwh' },
        statement: '我问的是鼓风机，不是总电耗',
        createdAt: '2026-08-13T00:00:00.000Z',
      },
    });
    for (let index = 1; index <= 13; index += 1) memory = appendConversationTurn(memory, turn(index));

    const compacted = compactConversation(memory);
    const context = buildFollowUpContext(compacted, slide(), evidenceBundle);

    expect(compacted.turns).toHaveLength(6);
    expect(compacted.intentCorrections).toEqual([expect.objectContaining({
      statement: '我问的是鼓风机，不是总电耗',
      to: { kind: 'evidence', key: 'blowerKwh' },
    })]);
    expect(context.intentCorrections).toEqual(compacted.intentCorrections);
  });

  it('keeps task memory isolated, carries the selected snapshot, and excludes credentials and local paths', () => {
    const first = createConversationMemory({
      originalQuestion: '任务一',
      evidenceSnapshotId: 'C:\\private\\workbook.xlsx',
      compactSummary: 'DEEPSEEK_API_KEY=secret-value',
    });
    const second = createConversationMemory({
      originalQuestion: '任务二',
      evidenceSnapshotId: 'dataset-two',
    });

    const firstContext = JSON.stringify(buildFollowUpContext(first, slide(), evidenceBundle));
    const secondContext = JSON.stringify(buildFollowUpContext(second, slide(), evidenceBundle));

    expect(firstContext).toContain('"currentEvidenceSnapshotId":"dataset-2026-08-12"');
    expect(firstContext).not.toMatch(/secret-value|DEEPSEEK_API_KEY|private\\workbook/u);
    expect(secondContext).not.toContain('任务一');
    expect(second.turns).toHaveLength(0);
  });
});
