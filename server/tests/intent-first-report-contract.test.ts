import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_POLICIES,
  REPORT_PHASES,
  REPORT_STATUSES,
  SLIDE_LAYOUTS,
  SLIDE_ROLES,
  VISUAL_KINDS,
} from '../../shared/report';
import {
  createReportResponseSchema,
  reportEventSchema,
  reportJobSnapshotSchema,
  reportOutlineSchema,
  reportSlideSchema,
} from '../../shared/report-schema';

const profileRef = {
  key: 'assistant-profile',
  kind: 'knowledge',
  source: 'assistant-profile',
  snapshotId: 'evidence:identity',
  label: '智慧水务 AI 助手',
} as const;

const tnRef = {
  key: 'tn',
  kind: 'metric',
  source: 'excel',
  snapshotId: 'evidence:data',
  module: 'water-quality',
  label: '总氮（TN）',
  unit: 'mg/L',
  dateRange: { from: '2026-08-01', to: '2026-08-31' },
  sampleCount: 31,
} as const;

const ammoniaRef = {
  ...tnRef,
  key: 'ammonia',
  label: '氨氮',
} as const;

const knowledgeRef = {
  key: 'knowledge:0',
  kind: 'knowledge',
  source: 'model-knowledge',
  snapshotId: 'evidence:data',
  label: '脱氮机理',
} as const;

const tnMetric = {
  ...tnRef,
  value: 2.4,
  limit: 3,
  status: '达标',
  claimIds: ['claim-tn'],
} as const;

const ammoniaMetric = {
  ...ammoniaRef,
  value: 0.5,
  limit: 1.5,
  status: '达标',
  claimIds: ['claim-ammonia'],
} as const;

const identitySlide = {
  id: 'slide-identity',
  order: 0,
  evidenceSnapshotId: 'evidence:identity',
  role: 'answer',
  layout: 'concept-center',
  evidencePolicy: 'knowledge',
  title: '我是谁',
  takeaway: '我是由 DeepSeek v4-flash 支持的智慧水务 AI 助手。',
  takeawayClaimIds: ['claim-1'],
  claims: [{
    id: 'claim-1',
    text: '公开模型显示名称为 DeepSeek v4-flash。',
    kind: 'knowledge',
    evidenceRefs: [profileRef],
  }],
  visual: {
    kind: 'capability-map',
    items: [{ id: 'capability-1', title: '现场分析', detail: '只基于受限证据包。', claimIds: ['claim-1'] }],
  },
  metrics: [],
  evidenceRefs: [profileRef],
  narration: [
    { id: 'segment-1', text: '身份说明。', speechId: 'speech-1', claimIds: ['claim-1'] },
    { id: 'segment-2', text: '能力边界。', speechId: 'speech-2', claimIds: ['claim-1'] },
  ],
} as const;

function identitySlideAt(id: string, order: number) {
  return {
    ...identitySlide,
    id,
    order,
    visual: {
      ...identitySlide.visual,
      items: [{ ...identitySlide.visual.items[0], id: `${id}-capability-1` }],
    },
  };
}

function dataSlide(visual: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: 'slide-data',
    order: 0,
    evidenceSnapshotId: 'evidence:data',
    role: 'evidence',
    layout: 'visual-focus',
    evidencePolicy: 'data',
    title: '水质证据',
    takeaway: '总氮与氨氮均来自本页证据。',
    takeawayClaimIds: ['claim-tn', 'claim-ammonia'],
    claims: [
      { id: 'claim-tn', text: '总氮最新值为 2.4 mg/L。', kind: 'onsite-fact', evidenceRefs: [tnRef] },
      { id: 'claim-ammonia', text: '氨氮最新值为 0.5 mg/L。', kind: 'onsite-fact', evidenceRefs: [ammoniaRef] },
    ],
    visual,
    metrics: [tnMetric, ammoniaMetric],
    evidenceRefs: [tnRef, ammoniaRef],
    narration: [
      { id: 'segment-tn', text: '先看总氮。', speechId: 'speech-tn', claimIds: ['claim-tn'] },
      { id: 'segment-ammonia', text: '再看氨氮。', speechId: 'speech-ammonia', claimIds: ['claim-ammonia'] },
    ],
    ...overrides,
  };
}

function outline(overrides: Record<string, unknown> = {}) {
  return {
    id: 'slide-identity',
    order: 0,
    title: '我是谁',
    purpose: '直接回答模型身份',
    role: 'answer',
    layout: 'concept-center',
    evidencePolicy: 'knowledge',
    visualKind: 'capability-map',
    evidenceKeys: ['assistant-profile'],
    status: 'ready',
    ...overrides,
  };
}

const baseSnapshot = {
  reportId: 'report-1',
  question: '你是什么模型？',
  originPage: 'overview',
  scope: {
    modules: [],
    metrics: [],
    dateRange: { from: '2026-08-14', to: '2026-08-14' },
    sampleCount: 0,
    granularity: 'daily',
  },
  conversation: {
    originalQuestion: '你是什么模型？',
    turns: [],
    compactSummary: '',
  },
  createdAt: '2026-08-14T00:00:00.000Z',
  expiresAt: '2026-08-14T01:00:00.000Z',
  lastSequence: 0,
} as const;

describe('canonical intent-first report contract', () => {
  it('publishes the controlled roles, layouts, policies, phases, statuses and visual kinds as the only public contract', () => {
    expect(SLIDE_ROLES).toEqual(['answer', 'evidence', 'cause', 'risk', 'knowledge', 'action']);
    expect(SLIDE_LAYOUTS).toEqual([
      'visual-focus', 'split-insight', 'dual-evidence', 'concept-center', 'action-path', 'diagnostic-overview',
    ]);
    expect(EVIDENCE_POLICIES).toEqual(['knowledge', 'data', 'mixed']);
    expect(REPORT_PHASES).toEqual([
      'understanding', 'retrieving-evidence', 'planning', 'generating-first-slide', 'generating-slides', 'completed',
    ]);
    expect(REPORT_STATUSES).toEqual([
      'generating', 'awaiting-clarification', 'ready', 'partial', 'failed', 'cancelled',
    ]);
    expect(VISUAL_KINDS).toContain('concept-map');
    expect(VISUAL_KINDS).toContain('capability-map');
  });

  it('accepts a claim-bound identity page with immutable assistant-profile provenance', () => {
    expect(reportSlideSchema.parse(identitySlide)).toMatchObject({
      order: 0,
      evidenceSnapshotId: 'evidence:identity',
      role: 'answer',
      layout: 'concept-center',
      evidencePolicy: 'knowledge',
      visual: { kind: 'capability-map' },
      claims: [{ evidenceRefs: [{ source: 'assistant-profile', snapshotId: 'evidence:identity' }] }],
    });
  });

  it('accepts the controlled concept-map shape', () => {
    const conceptSlide = {
      ...identitySlide,
      visual: {
        kind: 'concept-map',
        nodes: [
          { id: 'node-1', title: '总氮', claimIds: ['claim-1'] },
          { id: 'node-2', title: '脱氮', claimIds: ['claim-1'] },
        ],
        edges: [{ from: 'node-1', to: 'node-2', label: '通过', claimIds: ['claim-1'] }],
      },
    };
    expect(reportSlideSchema.parse(conceptSlide).visual.kind).toBe('concept-map');
  });

  it('accepts server-derived claim bindings on every evidence-bearing visual shape', () => {
    const visuals = [
      { kind: 'kpi-grid', metrics: [tnMetric] },
      { kind: 'comparison-bars', items: [tnMetric, ammoniaMetric] },
      { kind: 'health-ring', metric: tnMetric, target: 3 },
      {
        kind: 'trend-line',
        series: [{
          key: 'tn', label: '总氮（TN）', unit: 'mg/L', snapshotId: 'evidence:data',
          claimIds: ['claim-tn'], points: [
            { label: '2026-08-30', value: 2.3 },
            { label: '2026-08-31', value: 2.4 },
          ],
        }],
      },
      {
        kind: 'radar',
        axes: [
          {
            key: 'tn', label: '总氮（TN）', value: 2.4, maximum: 3, unit: 'mg/L',
            snapshotId: 'evidence:data', claimIds: ['claim-tn'],
          },
          {
            key: 'ammonia', label: '氨氮', value: 0.5, maximum: 1.5, unit: 'mg/L',
            snapshotId: 'evidence:data', claimIds: ['claim-ammonia'],
          },
          {
            key: 'tn', label: '总氮波动', value: 0.1, maximum: 1, unit: 'mg/L',
            snapshotId: 'evidence:data', claimIds: ['claim-tn'],
          },
        ],
      },
      {
        kind: 'scatter',
        x: { ...tnRef, claimIds: ['claim-tn'] },
        y: { ...ammoniaRef, claimIds: ['claim-ammonia'] },
        points: [{ label: '2026-08-31', x: 2.4, y: 0.5, claimIds: ['claim-tn', 'claim-ammonia'] }],
        caveat: '统计关联不等于因果关系',
      },
    ];

    for (const visual of visuals) {
      expect(reportSlideSchema.parse(dataSlide(visual)).visual.kind).toBe(visual.kind);
    }
  });

  it('recursively rejects embedded visual refs outside the claim/page/snapshot ledger', () => {
    const invalidVisuals = [
      { kind: 'kpi-grid', metrics: [{ ...tnMetric, snapshotId: 'evidence:replacement' }] },
      { kind: 'comparison-bars', items: [{ ...tnMetric, key: 'tp' }] },
      { kind: 'health-ring', metric: { ...tnMetric, claimIds: ['claim-ammonia'] } },
      {
        kind: 'trend-area',
        series: [{
          key: 'tn', label: '总氮（TN）', unit: 'mg/L', snapshotId: 'evidence:data',
          claimIds: ['claim-ammonia'], points: [{ label: '2026-08-31', value: 2.4 }],
        }],
      },
      {
        kind: 'radar',
        axes: [{
          key: 'tn', label: '总氮（TN）', value: 2.4, maximum: 3, unit: 'mg/L',
          snapshotId: 'evidence:replacement', claimIds: ['claim-tn'],
        }],
      },
      {
        kind: 'scatter',
        x: { ...tnRef, claimIds: ['claim-ammonia'] },
        y: { ...ammoniaRef, claimIds: ['claim-ammonia'] },
        points: [{ label: '2026-08-31', x: 2.4, y: 0.5, claimIds: ['claim-tn', 'missing-claim'] }],
        caveat: '统计关联不等于因果关系',
      },
    ];

    for (const visual of invalidVisuals) {
      expect(() => reportSlideSchema.parse(dataSlide(visual))).toThrow();
    }
  });

  it('requires every knowledge visual element to reference a non-Excel-backed claim', () => {
    const knowledgeClaim = {
      id: 'claim-k',
      text: '脱氮机理解释氮素转化过程。',
      kind: 'knowledge',
      evidenceRefs: [knowledgeRef],
    } as const;
    const mixedSlide = (visual: Record<string, unknown>) => dataSlide(visual, {
      evidencePolicy: 'mixed',
      claims: [
        { id: 'claim-tn', text: '总氮最新值为 2.4 mg/L。', kind: 'onsite-fact', evidenceRefs: [tnRef] },
        knowledgeClaim,
      ],
      takeawayClaimIds: ['claim-tn', 'claim-k'],
      metrics: [tnMetric],
      evidenceRefs: [tnRef, knowledgeRef],
      narration: [
        { id: 'segment-tn', text: '先看总氮。', speechId: 'speech-tn', claimIds: ['claim-tn'] },
        { id: 'segment-k', text: '再解释机理。', speechId: 'speech-k', claimIds: ['claim-k'] },
      ],
    });
    const validVisuals = [
      {
        kind: 'process-flow',
        provenance: 'model-knowledge',
        steps: [{ id: 'step-1', title: '硝化', detail: '通用过程。', claimIds: ['claim-k'] }],
      },
      {
        kind: 'recommendation-path',
        provenance: 'model-knowledge',
        steps: [{ id: 'step-1', title: '复核', detail: '通用建议。', claimIds: ['claim-k'] }],
      },
      {
        kind: 'concept-map',
        nodes: [
          { id: 'node-1', title: '硝化', claimIds: ['claim-k'] },
          { id: 'node-2', title: '反硝化', claimIds: ['claim-k'] },
        ],
        edges: [{ from: 'node-1', to: 'node-2', claimIds: ['claim-k'] }],
      },
      {
        kind: 'capability-map',
        items: [{ id: 'capability-1', title: '机理解释', detail: '通用知识。', claimIds: ['claim-k'] }],
      },
    ];
    for (const visual of validVisuals) {
      expect(reportSlideSchema.parse(mixedSlide(visual)).visual.kind).toBe(visual.kind);
    }

    const onsiteOnlyConcept = dataSlide({
      kind: 'concept-map',
      nodes: [{ id: 'node-1', title: '现场总氮', claimIds: ['claim-tn'] }],
      edges: [],
    }, {
      evidencePolicy: 'mixed',
      claims: [{ id: 'claim-tn', text: '总氮最新值为 2.4 mg/L。', kind: 'onsite-fact', evidenceRefs: [tnRef] }],
      takeawayClaimIds: ['claim-tn'],
      metrics: [tnMetric],
      evidenceRefs: [tnRef, knowledgeRef],
      narration: [
        { id: 'segment-1', text: '现场总氮。', speechId: 'speech-1', claimIds: ['claim-tn'] },
        { id: 'segment-2', text: '仍是现场结论。', speechId: 'speech-2', claimIds: ['claim-tn'] },
      ],
    });
    expect(() => reportSlideSchema.parse(onsiteOnlyConcept)).toThrow();
  });

  it('rejects missing claim references from takeaway and narration', () => {
    expect(reportSlideSchema).toBeDefined();
    expect(() => reportSlideSchema.parse({
      ...identitySlide,
      takeawayClaimIds: ['missing-claim'],
    })).toThrow();
    expect(() => reportSlideSchema.parse({
      ...identitySlide,
      narration: [
        { id: 'segment-1', text: '身份说明', speechId: 'speech-1', claimIds: ['missing-claim'] },
        { id: 'segment-2', text: '能力边界', speechId: 'speech-2', claimIds: ['claim-1'] },
      ],
    })).toThrow();
  });

  it('rejects claim evidence outside the page ledger or from another snapshot', () => {
    expect(reportSlideSchema).toBeDefined();
    expect(() => reportSlideSchema.parse({
      ...identitySlide,
      claims: [{
        ...identitySlide.claims[0],
        evidenceRefs: [{ ...profileRef, key: 'knowledge:0' }],
      }],
    })).toThrow();
    expect(() => reportSlideSchema.parse({
      ...identitySlide,
      evidenceRefs: [{ ...profileRef, snapshotId: 'evidence:replacement' }],
    })).toThrow();
  });

  it('keeps user corrections structurally distinct from Excel facts and metadata', () => {
    const sourceRef = { ...tnRef, snapshotId: 'evidence:correction' };
    const correctionRef = {
      key: 'user-correction:tn', kind: 'metric' as const, source: 'user-correction' as const,
      snapshotId: 'evidence:correction', label: '总氮（用户提供·未核验）', unit: 'mg/L',
    };
    const sourceMetric = { ...sourceRef, value: 2.4, claimIds: ['claim-tn'] };
    const correctionMetric = { ...correctionRef, value: 2.1, claimIds: ['claim-user'] };
    const correctionSlide = dataSlide({ kind: 'comparison-bars', items: [sourceMetric, correctionMetric] }, {
      evidenceSnapshotId: 'evidence:correction',
      evidencePolicy: 'mixed',
      takeawayClaimIds: ['claim-tn', 'claim-user'],
      claims: [
        { id: 'claim-tn', text: 'Excel 总氮最新值为 2.4 mg/L。', kind: 'onsite-fact', evidenceRefs: [sourceRef] },
        { id: 'claim-user', text: '用户提供总氮 2.1 mg/L，未经现场数据核验。', kind: 'user-provided', evidenceRefs: [correctionRef] },
      ],
      metrics: [sourceMetric, correctionMetric],
      evidenceRefs: [sourceRef, correctionRef],
      narration: [
        { id: 'segment-tn', text: '先看 Excel 值。', speechId: 'speech-tn', claimIds: ['claim-tn'] },
        { id: 'segment-user', text: '再看用户提供的未核验值。', speechId: 'speech-user', claimIds: ['claim-user'] },
      ],
    });

    expect(reportSlideSchema.parse(correctionSlide).claims[1]?.kind).toBe('user-provided');
    expect(() => reportSlideSchema.parse({
      ...correctionSlide,
      evidenceRefs: [sourceRef, {
        ...correctionRef,
        dateRange: { from: '2026-08-01', to: '2026-08-31' },
        sampleCount: 31,
      }],
    })).toThrow();
    expect(() => reportSlideSchema.parse({
      ...correctionSlide,
      claims: correctionSlide.claims.map((claim) => claim.id === 'claim-user' ? { ...claim, kind: 'onsite-fact' } : claim),
    })).toThrow();
  });

  it('requires unique claim IDs and unique referenced claim IDs', () => {
    expect(reportSlideSchema).toBeDefined();
    expect(() => reportSlideSchema.parse({
      ...identitySlide,
      claims: [...identitySlide.claims, { ...identitySlide.claims[0] }],
    })).toThrow();
    expect(() => reportSlideSchema.parse({
      ...identitySlide,
      takeawayClaimIds: ['claim-1', 'claim-1'],
    })).toThrow();
  });

  it('requires outline order to be exactly its zero-based array index', () => {
    expect(reportOutlineSchema.parse([
      outline({ id: 'slide-0', order: 0 }),
      outline({ id: 'slide-1', order: 1 }),
    ])).toHaveLength(2);
    expect(() => reportOutlineSchema.parse([
      outline({ id: 'slide-0', order: 0 }),
      outline({ id: 'slide-2', order: 2 }),
    ])).toThrow();
  });

  it('accepts initial generating and clarification snapshots with no formal pages', () => {
    const initial = {
      ...baseSnapshot,
      status: 'generating',
      phase: 'understanding',
      clarification: null,
      outline: [],
      slides: [],
    };
    expect(reportJobSnapshotSchema.parse(initial)).toMatchObject({
      status: 'generating', phase: 'understanding', clarification: null, outline: [], slides: [],
    });

    expect(reportJobSnapshotSchema.parse({
      ...initial,
      status: 'awaiting-clarification',
      phase: null,
      clarification: {
        clarificationId: 'clarification-1',
        prompt: '请说明要分析的指标。',
        reason: 'ambiguous-subject',
        suggestions: ['总氮', '能耗'],
      },
    })).toMatchObject({ status: 'awaiting-clarification', phase: null, outline: [], slides: [] });
  });

  it('keeps failed snapshots empty while cancelled snapshots may preserve committed pages', () => {
    for (const status of ['failed', 'cancelled'] as const) {
      expect(reportJobSnapshotSchema.parse({
        ...baseSnapshot,
        status,
        phase: null,
        clarification: null,
        outline: [],
        slides: [],
      })).toMatchObject({ status, phase: null, outline: [], slides: [] });
    }

    expect(reportJobSnapshotSchema.parse({
      ...baseSnapshot,
      status: 'cancelled',
      phase: null,
      clarification: null,
      outline: [outline({ status: 'planned' })],
      slides: [],
    })).toMatchObject({ status: 'cancelled', phase: null, slides: [] });

    expect(reportJobSnapshotSchema.parse({
      ...baseSnapshot,
      status: 'cancelled',
      phase: null,
      clarification: null,
      outline: [outline()],
      slides: [identitySlide],
    })).toMatchObject({ status: 'cancelled', phase: null, slides: [{ order: 0 }] });
  });

  it('requires published slides to start at zero and ascend while allowing coherent gaps', () => {
    expect(() => reportJobSnapshotSchema.parse({
      ...baseSnapshot,
      status: 'generating',
      phase: 'generating-slides',
      clarification: null,
      outline: [
        outline({ id: 'slide-0', order: 0, status: 'ready' }),
        outline({ id: 'slide-1', order: 1, status: 'ready' }),
      ],
      slides: [identitySlideAt('slide-1', 1)],
    })).toThrow();

    expect(reportJobSnapshotSchema.parse({
      ...baseSnapshot,
      status: 'generating',
      phase: 'generating-slides',
      clarification: null,
      outline: [
        outline({ id: 'slide-0', order: 0, status: 'ready' }),
        outline({ id: 'slide-1', order: 1, status: 'planned' }),
        outline({ id: 'slide-2', order: 2, status: 'ready' }),
      ],
      slides: [identitySlideAt('slide-0', 0), identitySlideAt('slide-2', 2)],
    }).slides.map(({ order }) => order)).toEqual([0, 2]);

    expect(() => reportJobSnapshotSchema.parse({
      ...baseSnapshot,
      status: 'generating',
      phase: 'generating-slides',
      clarification: null,
      outline: [
        outline({ id: 'slide-0', order: 0, status: 'ready' }),
        outline({ id: 'slide-1', order: 1, status: 'ready' }),
        outline({ id: 'slide-2', order: 2, status: 'ready' }),
      ],
      slides: [
        identitySlideAt('slide-0', 0),
        identitySlideAt('slide-2', 2),
        identitySlideAt('slide-1', 1),
      ],
    })).toThrow();
  });

  it('requires failed, ready and partial snapshots to obey settled outline semantics', () => {
    expect(() => reportJobSnapshotSchema.parse({
      ...baseSnapshot,
      status: 'failed',
      phase: null,
      clarification: null,
      outline: [outline()],
      slides: [identitySlide],
    })).toThrow();

    expect(reportJobSnapshotSchema.parse({
      ...baseSnapshot,
      status: 'ready',
      phase: 'completed',
      clarification: null,
      outline: [
        outline({ id: 'slide-0', order: 0, status: 'ready' }),
        outline({ id: 'slide-1', order: 1, status: 'ready' }),
      ],
      slides: [identitySlideAt('slide-0', 0), identitySlideAt('slide-1', 1)],
    }).status).toBe('ready');
    expect(() => reportJobSnapshotSchema.parse({
      ...baseSnapshot,
      status: 'ready',
      phase: 'completed',
      clarification: null,
      outline: [outline(), outline({ id: 'slide-1', order: 1, status: 'failed' })],
      slides: [identitySlide],
    })).toThrow();

    const partial = {
      ...baseSnapshot,
      status: 'partial',
      phase: 'completed',
      clarification: null,
      outline: [outline(), outline({ id: 'slide-1', order: 1, status: 'failed' })],
      slides: [identitySlide],
    } as const;
    expect(reportJobSnapshotSchema.parse(partial).status).toBe('partial');
    expect(reportJobSnapshotSchema.parse({
      ...partial,
      outline: [
        outline({ id: 'slide-0', order: 0, status: 'ready' }),
        outline({ id: 'slide-1', order: 1, status: 'failed' }),
        outline({ id: 'slide-2', order: 2, status: 'ready' }),
      ],
      slides: [identitySlideAt('slide-0', 0), identitySlideAt('slide-2', 2)],
    }).slides.map(({ order }) => order)).toEqual([0, 2]);
    expect(() => reportJobSnapshotSchema.parse({
      ...partial,
      outline: [outline()],
    })).toThrow();
    expect(() => reportJobSnapshotSchema.parse({
      ...partial,
      outline: [outline(), outline({ id: 'slide-1', order: 1, status: 'planned' })],
    })).toThrow();
  });

  it('requires supersession targets to exist later in an acyclic chain and keeps one playable page', () => {
    const readySnapshot = {
      ...baseSnapshot,
      status: 'ready' as const,
      phase: 'completed' as const,
      clarification: null,
      outline: [
        outline({ id: 'slide-a', order: 0, status: 'ready' }),
        outline({ id: 'slide-b', order: 1, status: 'ready' }),
        outline({ id: 'slide-c', order: 2, status: 'ready' }),
      ],
      slides: [
        { ...identitySlideAt('slide-a', 0), supersededBySlideId: 'slide-b' },
        { ...identitySlideAt('slide-b', 1), supersededBySlideId: 'slide-c' },
        identitySlideAt('slide-c', 2),
      ],
    };
    expect(reportJobSnapshotSchema.parse(readySnapshot).slides).toHaveLength(3);
    expect(() => reportJobSnapshotSchema.parse({
      ...readySnapshot,
      slides: [
        identitySlideAt('slide-a', 0),
        { ...identitySlideAt('slide-b', 1), supersededBySlideId: 'slide-a' },
        identitySlideAt('slide-c', 2),
      ],
    })).toThrow();
    expect(() => reportJobSnapshotSchema.parse({
      ...readySnapshot,
      slides: readySnapshot.slides.map((item, index, all) => ({
        ...item,
        supersededBySlideId: all[(index + 1) % all.length]!.id,
      })),
    })).toThrow();
  });

  it('defines strict state, clarification and cancellation events plus a bootstrap-free create response', () => {
    expect(reportEventSchema.parse({
      type: 'report.state-changed',
      sequence: 1,
      status: 'generating',
      phase: 'planning',
      clarification: null,
    })).toMatchObject({ type: 'report.state-changed', phase: 'planning' });
    expect(reportEventSchema.parse({
      type: 'report.clarification-required',
      sequence: 2,
      clarification: {
        clarificationId: 'clarification-1',
        prompt: '请说明范围。',
        reason: 'missing-evidence-scope',
        suggestions: [],
      },
    }).type).toBe('report.clarification-required');
    expect(reportEventSchema.parse({ type: 'report.cancelled', sequence: 3 }).type)
      .toBe('report.cancelled');
    expect(() => reportEventSchema.parse({
      type: 'report.state-changed',
      sequence: 4,
      status: 'awaiting-clarification',
      phase: null,
      clarification: null,
    })).toThrow();
    expect(() => reportEventSchema.parse({
      type: 'report.state-changed',
      sequence: 5,
      status: 'generating',
      phase: null,
      clarification: null,
    })).toThrow();

    const response = {
      reportId: 'report-1',
      snapshot: {
        ...baseSnapshot,
        status: 'generating',
        phase: 'understanding',
        clarification: null,
        outline: [],
        slides: [],
      },
    };
    expect(createReportResponseSchema.parse(response)).toEqual(response);
    expect(() => createReportResponseSchema.parse({ ...response, bootstrapSlide: identitySlide })).toThrow();
  });
});
