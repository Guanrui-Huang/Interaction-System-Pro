# Report Narration Opening and Subtitle Measurement Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让整份动态汇报最多只在第一页第一段说明一次时间范围与样本数，同时保证字幕不会拆开完整数值及其单位。

**Architecture:** 服务端在模型提示、模型输出校验和确定性证据兜底三个生成入口统一执行单次开场策略，页序号始终取动态 `outline.order`，不依赖固定页数。客户端字幕切分器在选择句末、短语边界或硬切位置前识别测量原子，使数值与单位成为不可拆分区间；TTS、字幕 CSS、播放控制器和自动翻页保持不变。

**Tech Stack:** TypeScript 5.9、Node.js、React 19、Vitest 3、Playwright、Zod

## Global Constraints

- 数据背景模板开场最多出现一次，且只能位于 `outline.order === 0` 的 `narration[0]`。
- 第一页其余分段和所有后续页直接讲指标、趋势、异常、风险或建议，不重复时间范围、样本总数或证据来源套话。
- “本次判断基于 31 个样本，样本量有限”等具有统计解释意义的表述必须继续允许。
- 确定性兜底的 claim 与证据审计信息继续保留完整日期范围和样本数；只精简 narration。
- 数值支持正负号、小数和千位分隔符；数值与相邻单位、百分号或百分点表达必须位于同一条字幕 cue。
- 测量原子自身超过 36 个显示单位时，完整性优先于单行预算。
- 这里的“超预算”指调用方传入的 `maxUnits`；默认值为 36，但低预算单元测试也必须遵守完整性优先。
- 所有字幕 cue 拼接后必须与原始讲解文本逐字符一致。
- 不新增依赖，不修改页面数量、自动翻页、暂停/恢复、追问、TTS、字幕 CSS、语音识别、唤醒词或 SSE 恢复逻辑。
- 当前工作区包含用户未提交的语音、唤醒词与 SSE 改动；每次只用精确路径暂存本任务文件，严禁 `git add .`。

## File Map

- Modify: `server/src/services/intent-first-slide-composer.ts` — 根据 `outline.order`生成初次与修复提示中的口播规则，并把页序号纳入安全结构化上下文。
- Modify: `server/src/domain/report-content-validation.ts` — 拒绝出现在错误页或错误分段中的模板化页面开场。
- Modify: `server/tests/intent-first-slide-composer.test.ts` — 覆盖第一页允许一次、重复触发修复、后续页禁止以及统计样本量语义放行。
- Modify: `server/src/services/report-evidence-fallback.ts` — 让可信兜底只在第一页第一条 narration 前拼接一次 context。
- Modify: `server/tests/report-generator.test.ts` — 覆盖多指标第一页一次开场、后续页零开场以及 claim 审计上下文保留。
- Modify: `src/features/ai/report/narration-subtitle-cues.ts` — 识别测量原子并将所有候选切点调整到原子外部。
- Modify: `src/tests/narration-subtitle-cues.test.ts` — 覆盖小数、百分比、负数、千位数、复合单位、超预算原子和正常句号。
- Modify: `e2e/server.ts` — 让确定性模型模拟器按页序号生成一次开场，并移除后续页证据来源套话。
- Modify: `e2e/integration.spec.ts` — 从最终报告快照直接断言第一页一次开场、后续页零开场。

---

### Task 1: Enforce the model narration opening policy

**Files:**
- Modify: `server/src/services/intent-first-slide-composer.ts:97-156`
- Modify: `server/src/domain/report-content-validation.ts:138-150,1607-1687`
- Test: `server/tests/intent-first-slide-composer.test.ts:152-200,1756-1859`

**Interfaces:**
- Consumes: `SlideComposerInput.outline.order: number` and `ModelSlideDraft.narration: Array<{ text: string; claimIds: string[] }>`.
- Produces: private `narrationRules(order: number): readonly string[]` and private validation `assertNarrationOpeningPolicy(narration, order): void`.
- Failure contract: misplaced or repeated template openings become `REPORT_SLIDE_DRAFT_INVALID`, enter the existing one-repair flow, and never become an evidence error.

- [ ] **Step 1: Add failing policy and prompt tests**

Add these cases inside `describe('composeSlide')`:

```ts
const pageContext = '本页查看2026-08-01至2026-08-31的总氮（TN），共31个样本。';

it('allows one page-context opening only in the first segment of page zero', async () => {
  const draft = onsiteDraft({
    narration: [
      { text: `${pageContext}总氮最新值为 2.4 mg/L。`, claimIds: ['claim-tn'] },
      { text: '总氮仍低于 3 mg/L 限值。', claimIds: ['claim-tn'] },
    ],
  });
  const dependency = provider(draft);

  await expect(composeSlide({ outline: outline(), evidence: dataEvidence }, dependency))
    .resolves.toMatchObject({
      narration: [
        { text: expect.stringContaining(pageContext) },
        { text: expect.not.stringContaining('本页查看') },
      ],
    });

  const prompt = dependency.requestCompletion.mock.calls[0]![0].prompt;
  expect(prompt).toContain('"order":0');
  expect(prompt).toContain('仅 narration[0] 可以说明一次数据时间范围与样本数');
});

it('repairs a repeated page-context opening on page zero', async () => {
  const repeated = onsiteDraft({
    narration: [
      { text: `${pageContext}总氮最新值为 2.4 mg/L。`, claimIds: ['claim-tn'] },
      { text: `${pageContext}总氮平均值为 2.3 mg/L。`, claimIds: ['claim-tn'] },
    ],
  });
  const dependency = providerSequence(repeated, onsiteDraft());

  await expect(composeSlide({ outline: outline(), evidence: dataEvidence }, dependency))
    .resolves.toMatchObject({ id: 'slide-0' });
  expect(dependency.requestCompletion).toHaveBeenCalledTimes(2);
  expect(dependency.requestCompletion.mock.calls[1]![0].prompt)
    .toContain('第一页后续 narration 段不得重复页面背景');
});

it('repairs any template page-context opening on a later page', async () => {
  const misplaced = onsiteDraft({
    narration: [
      { text: `${pageContext}总氮最新值为 2.4 mg/L。`, claimIds: ['claim-tn'] },
      { text: '总氮平均值为 2.3 mg/L。', claimIds: ['claim-tn'] },
    ],
  });
  const dependency = providerSequence(misplaced, onsiteDraft());

  await expect(composeSlide({
    outline: outline({ id: 'slide-1', order: 1 }),
    evidence: dataEvidence,
  }, dependency)).resolves.toMatchObject({ id: 'slide-1', order: 1 });

  expect(dependency.requestCompletion).toHaveBeenCalledTimes(2);
  expect(dependency.requestCompletion.mock.calls[0]![0].prompt).toContain('"order":1');
  expect(dependency.requestCompletion.mock.calls[1]![0].prompt)
    .toContain('后续页所有 narration 段必须直接进入指标分析');
});

it('allows an analytically meaningful sample-size caveat on a later page', async () => {
  const caveat = onsiteDraft({
    narration: [
      { text: '总氮最新值为 2.4 mg/L。', claimIds: ['claim-tn'] },
      { text: '本次判断基于31个样本，样本量有限，结论需谨慎。', claimIds: ['claim-tn'] },
    ],
  });

  await expect(composeSlide({
    outline: outline({ id: 'slide-1', order: 1 }),
    evidence: dataEvidence,
  }, provider(caveat))).resolves.toMatchObject({
    narration: [{ text: '总氮最新值为 2.4 mg/L。' }, { text: expect.stringContaining('31个样本') }],
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest server/tests/intent-first-slide-composer.test.ts --run
```

Expected: the new prompt assertions fail, and repeated/misplaced openings are accepted without the expected repair call. Existing evidence tests must remain green.

- [ ] **Step 3: Add order-aware narration rules to both model prompts**

In `intent-first-slide-composer.ts`, add:

```ts
function narrationRules(order: number): readonly string[] {
  return order === 0
    ? [
        '这是整份汇报的第一页。仅 narration[0] 可以说明一次数据时间范围与样本数；若本页没有现场数据，不得编造开场。',
        '第一页后续 narration 段不得重复页面背景、时间范围、样本总数或证据来源套话，必须直接进入指标分析。',
        '同页各段必须互补，分别讲指标现状、变化、风险或建议。',
      ]
    : [
        '这是整份汇报的后续页。后续页所有 narration 段必须直接进入指标分析。',
        '不得使用“本页查看/本页展示/本页分析/本页覆盖……共 N 个样本”等页面介绍句，不得重复时间范围、样本总数或证据来源套话。',
        '同页各段必须互补，分别讲指标现状、变化、风险或建议。',
      ];
}
```

Add `order: input.outline.order` to the `outline` JSON in `buildPrompt`. Add `order: input.composerInput.outline.order` to the repair prompt outline. Spread `...narrationRules(...)` into both `buildPrompt` and `buildRepairPrompt` immediately before the final output-only rule.


Apply the prompt fields and rule spreads exactly as follows:

```ts
// buildPrompt outline object
order: input.outline.order,
// buildPrompt rule list, after CLAIM_EVIDENCE_RULES
...narrationRules(input.outline.order),

// buildRepairPrompt outline object
order: input.composerInput.outline.order,
// buildRepairPrompt rule list, after CLAIM_EVIDENCE_RULES
...narrationRules(input.composerInput.outline.order),
```

Keep the final output-only instruction after the narration rules.

- [ ] **Step 4: Reject template openings outside the only allowed position**

In `report-content-validation.ts`, add:

```ts
const TEMPLATE_NARRATION_OPENING_PATTERN =
  /本页(?:查看|展示|分析|覆盖)[^。！？；]*(?:共|合计)\s*\d+\s*个样本/gu;

function assertNarrationOpeningPolicy(
  narration: ModelSlideDraft['narration'],
  order: number,
): void {
  for (const [index, segment] of narration.entries()) {
    const count = segment.text.match(TEMPLATE_NARRATION_OPENING_PATTERN)?.length ?? 0;
    if (count === 0) continue;
    if (order !== 0 || index !== 0 || count > 1) fail('REPORT_SLIDE_DRAFT_INVALID');
  }
}
```

Call `assertNarrationOpeningPolicy(draft.narration, outline.order)` immediately after the outline shape check and before visual/evidence binding. Do not inspect generic occurrences of “样本”; the rule must remain limited to the template pattern.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
pnpm exec vitest server/tests/intent-first-slide-composer.test.ts --run
```

Expected: PASS, including the meaningful `31个样本` caveat and all existing evidence/security cases.

- [ ] **Step 6: Commit only Task 1 files**

```bash
git add server/src/services/intent-first-slide-composer.ts server/src/domain/report-content-validation.ts server/tests/intent-first-slide-composer.test.ts
git commit -m "fix: limit report narration context to the opening"
```

### Task 2: Make trusted fallback narration use one report opening

**Files:**
- Modify: `server/src/services/report-evidence-fallback.ts:19-78,103-189`
- Test: `server/tests/report-generator.test.ts:152-170,490-541`

**Interfaces:**
- Consumes: `SlideOutline.order`, bound Excel refs and `DirectMetricSummary`.
- Produces: `DirectMetricSummary.narration: { context: string; central: string; range: string }` and frozen fallback slides whose claims retain full context while narration applies the order rule.

- [ ] **Step 1: Add a two-metric fallback fixture and failing test**

Add this helper near `correctionSourceEvidence`:

```ts
function multiMetricFallbackEvidence(snapshotId: string): ReportEvidenceBundle {
  return {
    snapshotId,
    knowledge: [],
    analysis: {
      scope: {
        modules: ['energy'],
        metrics: ['totalKwh', 'kwhPerM3'],
        dateRange: { from: '2026-08-01', to: '2026-08-12' },
        sampleCount: 2,
        granularity: 'daily',
      },
      definitions: [
        { key: 'totalKwh', label: '总电耗', unit: 'kWh/d' },
        { key: 'kwhPerM3', label: '吨水电耗', unit: 'kWh/m³' },
      ],
      series: [
        { date: '2026-08-01', values: { totalKwh: 480, kwhPerM3: 0.45 } },
        { date: '2026-08-12', values: { totalKwh: 500, kwhPerM3: 0.43 } },
      ],
      aggregates: {
        totalKwh: { min: 480, max: 500, average: 490, latest: 500, changeRate: 0.0417 },
        kwhPerM3: { min: 0.43, max: 0.45, average: 0.44, latest: 0.43, changeRate: -0.0444 },
      },
      thresholdBreaches: [],
      correlations: [],
      alerts: [],
    },
  };
}
```

Add this test after the existing substantive fallback test:

```ts
it('uses the data context once on page zero and never on later fallback pages', () => {
  const metricEvidence = multiMetricFallbackEvidence('evidence:multi-fallback');
  const base: SlideOutline = {
    ...outline('metric-page', 0),
    evidencePolicy: 'data',
    visualKind: 'kpi-grid',
    evidenceKeys: ['totalKwh', 'kwhPerM3'],
  };

  const firstPage = composeEvidenceFallbackSlide(base, metricEvidence);
  const laterPage = composeEvidenceFallbackSlide(
    { ...base, id: 'metric-page-2', order: 1 },
    metricEvidence,
  );
  const firstNarration = firstPage.narration.map(({ text }) => text).join('');
  const laterNarration = laterPage.narration.map(({ text }) => text).join('');

  expect(firstNarration.match(/本页查看/gu)).toHaveLength(1);
  expect(firstNarration.match(/共2个样本/gu)).toHaveLength(1);
  expect(firstPage.narration[0]!.text).toContain('本页查看');
  expect(firstPage.narration.slice(1).map(({ text }) => text).join('')).not.toContain('本页查看');
  expect(laterNarration).not.toContain('本页查看');
  expect(laterNarration).not.toContain('共2个样本');
  expect(firstPage.claims).toHaveLength(2);
  expect(firstPage.claims.every(({ text }) => text.includes('共2个样本'))).toBe(true);
});
```

- [ ] **Step 2: Run the fallback test and verify RED**

Run:

```bash
pnpm exec vitest server/tests/report-generator.test.ts --run -t "fallback"
```

Expected: FAIL because page zero repeats `本页查看` and `共2个样本` once per metric, while the later page still contains both.

- [ ] **Step 3: Separate audit context from narration components**

Change `DirectMetricSummary` to:

```ts
type DirectMetricSummary = {
  claimText: string;
  headline: string;
  narration: {
    context: string;
    central: string;
    range: string;
  };
};
```

Return the same full `claimText: `${context}${central}${range}``, but replace the tuple with:

```ts
narration: { context, central, range },
```

Add a helper:

```ts
function narrationContext(
  outline: SlideOutline,
  summaryIndex: number,
  summary: DirectMetricSummary,
): string {
  return outline.order === 0 && summaryIndex === 0 ? summary.narration.context : '';
}
```

For the single-metric branch, create segment one from `${narrationContext(outline, 0, summary)}${summary.narration.central}` and segment two from `summary.narration.range`. For the multi-metric branch, create each segment from `${narrationContext(outline, index, summary)}${summary.narration.central}${summary.narration.range}`. Leave `claimText`, takeaway, evidence refs and the non-causal final segment unchanged.


Use this complete replacement for the current `const narration` block:

```ts
const metricNarration: ReportSlide['narration'] = richSummaries.length === 1
  ? [
      {
        id: `${outline.id}-fallback-segment-1`,
        text: `${narrationContext(outline, 0, richSummaries[0]!.summary)}${richSummaries[0]!.summary.narration.central}`,
        speechId: `${outline.id}-fallback-speech-1`,
        claimIds: [richSummaries[0]!.claimId],
      },
      {
        id: `${outline.id}-fallback-segment-2`,
        text: richSummaries[0]!.summary.narration.range,
        speechId: `${outline.id}-fallback-speech-2`,
        claimIds: [richSummaries[0]!.claimId],
      },
    ]
  : richSummaries.slice(0, 3).map(({ summary, claimId }, index) => ({
      id: `${outline.id}-fallback-segment-${index + 1}`,
      text: `${narrationContext(outline, index, summary)}${summary.narration.central}${summary.narration.range}`,
      speechId: `${outline.id}-fallback-speech-${index + 1}`,
      claimIds: [claimId],
    }));

const narration: ReportSlide['narration'] = richSummaries.length
  ? [
      ...metricNarration,
      {
        id: `${outline.id}-fallback-segment-${richSummaries.length === 1 ? 3 : Math.min(richSummaries.length, 3) + 1}`,
        text: '本页可以确认已绑定序列中的数值和时间，但不能仅凭这组数据判断波动原因。',
        speechId: `${outline.id}-fallback-speech-${richSummaries.length === 1 ? 3 : Math.min(richSummaries.length, 3) + 1}`,
        claimIds: richSummaries.slice(0, 3).map(({ claimId }) => claimId),
      },
    ]
  : [
      {
        id: `${outline.id}-fallback-segment-1`,
        text: takeaway,
        speechId: `${outline.id}-fallback-speech-1`,
        claimIds,
      },
      {
        id: `${outline.id}-fallback-segment-2`,
        text: '可视化仅展示本页已绑定的证据，不添加未经验证的现场结论。',
        speechId: `${outline.id}-fallback-speech-2`,
        claimIds,
      },
    ];
```

- [ ] **Step 4: Run fallback and generator tests and verify GREEN**

Run:

```bash
pnpm exec vitest server/tests/report-generator.test.ts --run
```

Expected: PASS. The original single-metric test still sees the date range and sample count on page zero, while the new multi-page test proves exactly one/zero narration openings.

- [ ] **Step 5: Commit only Task 2 files**

```bash
git add server/src/services/report-evidence-fallback.ts server/tests/report-generator.test.ts
git commit -m "fix: deduplicate trusted fallback narration context"
```

### Task 3: Keep subtitle measurement atoms intact

**Files:**
- Modify: `src/features/ai/report/narration-subtitle-cues.ts:1-86`
- Test: `src/tests/narration-subtitle-cues.test.ts:1-58`

**Interfaces:**
- Consumes: narration text and `maxUnits` passed to `splitSubtitleCues(text, maxUnits)`.
- Produces: private `measurementAtomRanges(text): TextRange[]`; public `splitSubtitleCues` signature and `SubtitleCue` shape remain unchanged.
- Invariant: a cut index may equal an atom start or end, but may never satisfy `atom.start < cut < atom.end`.

- [ ] **Step 1: Add failing measurement-atom tests**

Append these tests:

```ts
it.each([
  ['decimal measurement', '2.68 mg/L'],
  ['percentage', '99.80%'],
  ['percentage-point change', '0.42 个百分点'],
  ['negative energy value', '-0.125 kWh/m³'],
  ['thousands-separated amount', '1,300.50 万元'],
])('keeps a complete %s in one subtitle cue', (_label, measurement) => {
  const text = `前文说明，${measurement}，后文继续。`;
  const cues = splitSubtitleCues(text, 4);

  expect(cues.some(({ text: cue }) => cue.includes(measurement))).toBe(true);
  expect(cues.map(({ text: cue }) => cue).join('')).toBe(text);
});

it('moves a measurement atom to the next cue instead of hard-cutting it', () => {
  const text = '前文说明，1,300.50 万元，后文。';
  const cues = splitSubtitleCues(text, 4);

  expect(cues.map(({ text: cue }) => cue)).toContain('1,300.50 万元');
  expect(displayUnits('1,300.50 万元')).toBeGreaterThan(4);
  expect(cues.map(({ text: cue }) => cue).join('')).toBe(text);
});

it('still treats a real ASCII full stop as a sentence boundary', () => {
  const cues = splitSubtitleCues('结论完整.下一句继续.', 36);

  expect(cues.map(({ text }) => text)).toEqual(['结论完整.', '下一句继续.']);
});
```

- [ ] **Step 2: Run the subtitle test and verify RED**

Run:

```bash
pnpm exec vitest src/tests/narration-subtitle-cues.test.ts --run
```

Expected: decimal and percentage cases fail because `.` is treated as a sentence boundary; low-budget measurement cases fail because hard cuts split the atom.

- [ ] **Step 3: Identify measurement ranges without changing source text**

In `narration-subtitle-cues.ts`, add:

```ts
type TextRange = { start: number; end: number };

const MEASUREMENT_ATOM_PATTERN =
  /[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[ \t]*(?:个百分点|个样本|kWh\/m³|kWh\/d|mg\/L|kg\/d|m³|万元|亿元|kWh|kg|mg|元|分|吨|个|次|天|日|%|‰|℃))?/gu;

function codePointLength(text: string): number {
  return [...text].length;
}

function measurementAtomRanges(text: string): TextRange[] {
  return [...text.matchAll(MEASUREMENT_ATOM_PATTERN)].map((match) => {
    const utf16Start = match.index ?? 0;
    const start = codePointLength(text.slice(0, utf16Start));
    return { start, end: start + codePointLength(match[0]) };
  });
}

function atomContainingCut(ranges: readonly TextRange[], cut: number): TextRange | undefined {
  return ranges.find(({ start, end }) => start < cut && cut < end);
}
```

This allowlist intentionally covers current report units without consuming arbitrary Chinese words after a bare number.

- [ ] **Step 4: Make sentence, phrase and hard cuts atom-aware**

Update `boundaryIndex`:

```ts
function boundaryIndex(text: string, boundaries: Set<string>, maxUnits: number, first = false): number {
  let units = 0;
  let lastBoundary = -1;
  const atoms = measurementAtomRanges(text);

  for (const [index, character] of [...text].entries()) {
    units += displayUnits(character);
    const cut = index + 1;
    if (
      boundaries.has(character)
      && units <= maxUnits
      && !atomContainingCut(atoms, cut)
    ) {
      if (first) return cut;
      lastBoundary = cut;
    }
    if (units > maxUnits) break;
  }

  return lastBoundary;
}
```

Update `hardCutIndex`:

```ts
function hardCutIndex(text: string, maxUnits: number): number {
  let units = 0;
  let index = 0;

  for (const character of [...text]) {
    const nextUnits = units + displayUnits(character);
    if (index > 0 && nextUnits > maxUnits) break;
    units = nextUnits;
    index += 1;
  }

  const proposed = Math.max(1, index);
  const atom = atomContainingCut(measurementAtomRanges(text), proposed);
  if (!atom) return proposed;
  return atom.start > 0 ? atom.start : atom.end;
}
```

Do not alter cue progress calculation, trimming behavior or `ReportSubtitleBar`.

- [ ] **Step 5: Run subtitle and controller regression tests and verify GREEN**

Run:

```bash
pnpm exec vitest src/tests/narration-subtitle-cues.test.ts src/tests/narration-controller.test.tsx --run
```

Expected: PASS. Existing display-unit, whitespace, progress mapping, pause/resume and autoplay behavior remain green.

- [ ] **Step 6: Commit only Task 3 files**

```bash
git add src/features/ai/report/narration-subtitle-cues.ts src/tests/narration-subtitle-cues.test.ts
git commit -m "fix: keep subtitle measurements intact"
```

### Task 4: Align the deterministic E2E model and run the full regression gate

**Files:**
- Modify: `e2e/server.ts:310-313,401-510`
- Test: `e2e/integration.spec.ts:288-373`

**Interfaces:**
- Consumes: the composer prompt lines `outline: ...` and `referencedEvidence: ...`.
- Produces: E2E `ModelOutline` including `order`, parsed evidence scope, and model narration that contains one page-zero opening only when page zero has onsite evidence.

- [ ] **Step 1: Add a failing integration assertion for report-wide opening count**

After the mixed report is ready in `e2e/integration.spec.ts`, add:

```ts
const mixedNarration = mixed.slides.flatMap(({ narration }) => narration.map(({ text }) => text));
const templateOpenings = mixedNarration.filter((text) => /本页查看[^。]*共\d+个样本/u.test(text));

expect(templateOpenings).toHaveLength(1);
expect(mixed.slides[0]!.narration[0]!.text).toMatch(/本页查看[^。]*共\d+个样本/u);
expect(mixed.slides.slice(1).flatMap(({ narration }) => narration.map(({ text }) => text)).join(''))
  .not.toMatch(/本页查看|本页单位、日期范围与样本/u);
```

- [ ] **Step 2: Run the focused integration test and verify RED**

Run:

```bash
pnpm test:e2e:integration -- --grep "builds distinct knowledge, mixed, identity and clarified reports"
```

Expected: FAIL because the current deterministic model emits no `本页查看……共 N 个样本` opening and repeats `本页单位、日期范围与样本均来自 Excel 证据。` on data pages.

- [ ] **Step 3: Parse order and evidence scope in the E2E model**

Change the E2E type and add a parser:

```ts
type ModelOutline = Pick<
  SlideOutline,
  'order' | 'title' | 'purpose' | 'role' | 'layout' | 'visualKind' | 'evidenceKeys'
>;

type ComposerEvidence = {
  analysis?: {
    scope: {
      dateRange: { from: string; to: string };
      sampleCount: number;
    };
  };
};

function parseComposerEvidence(prompt: string): ComposerEvidence {
  const line = prompt.split('\n').find((candidate) => candidate.startsWith('referencedEvidence: '));
  if (!line) throw new Error('missing composer evidence');
  return JSON.parse(line.slice('referencedEvidence: '.length)) as ComposerEvidence;
}
```

Task 1 must already have added `order` to the production composer prompt, so `parseComposerOutline` remains the single source of page order.

- [ ] **Step 4: Generate the E2E opening once and remove metadata boilerplate**

Change the signature to `slideDraftResponse(outline: ModelOutline, evidence: ComposerEvidence)`. Before returning the draft, add:

```ts
const scope = evidence.analysis?.scope;
const reportOpening = outline.order === 0 && onsiteKeys.length > 0 && scope
  ? `本页查看${scope.dateRange.from}至${scope.dateRange.to}的相关指标，共${scope.sampleCount}个样本。`
  : '';
```

Replace the non-identity narration branch with:

```ts
[
  { text: `${reportOpening}${outline.title}从问题意图出发展开讲解。`, claimIds },
  {
    text: onsiteKeys.length
      ? `${outline.purpose}，下面直接说明相关指标结论。`
      : '本页内容来自模型知识，不声称现场数值。',
    claimIds,
  },
]
```

Change the completion return to:

```ts
return JSON.stringify(slideDraftResponse(outline, parseComposerEvidence(prompt)));
```

Do not add sample context to a knowledge-only first page, and do not add it later if the first data page has `order > 0`.

- [ ] **Step 5: Run the focused integration test and verify GREEN**

Run:

```bash
pnpm test:e2e:integration -- --grep "builds distinct knowledge, mixed, identity and clarified reports"
```

Expected: PASS. The mixed two-page report has one opening in page zero segment zero and none in page one.

- [ ] **Step 6: Run the complete regression gate**

Run in this order:

```bash
pnpm exec vitest server/tests/intent-first-slide-composer.test.ts server/tests/report-generator.test.ts src/tests/narration-subtitle-cues.test.ts src/tests/narration-controller.test.tsx --run
pnpm run build
pnpm test:e2e:integration -- --grep "answers the exact recent-energy-rise question|builds distinct knowledge, mixed, identity and clarified reports|runs the final report flow"
```

Expected: every command exits 0. The build emits no TypeScript error. The selected integration flows retain dynamic multi-page generation, narration playback and evidence binding.

- [ ] **Step 7: Inspect scope and commit only Task 4 files**

Run:

```bash
git diff --check
git status --short
git diff -- e2e/server.ts e2e/integration.spec.ts
```

Confirm that unrelated existing changes in `package.json`, voice, wake-word and SSE files remain unstaged. Then commit:

```bash
git add e2e/server.ts e2e/integration.spec.ts
git commit -m "test: align report narration integration fixture"
```

## Completion Evidence

Before reporting success, record:

- The RED failure reason and GREEN pass result for each of the four tasks.
- The exact count of `本页查看` and `共 N 个样本` in first-page and later-page fallback narration tests.
- The subtitle cue arrays for `2.68 mg/L`, `99.80%` and `1,300.50 万元`.
- The final focused Vitest, production build and selected Playwright exit codes.
- `git status --short`, explicitly separating this task's commits from the user's pre-existing working-tree changes.
