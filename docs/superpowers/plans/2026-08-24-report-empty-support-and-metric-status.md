# Report Empty Support and Metric Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove empty finished-report chart slots, restore 0/1/2-support space usage, and keep metric status text inside its card without reducing typography.

**Architecture:** Pending report pages retain the existing fixed blurred dashboard skeleton. Ready `data-dashboard` pages render only real summary and support modules and select a CSS grid from their actual support count; atomic `kpi-grid` pages return to their direct renderer. Metric cards use explicit label, status, and value grid areas so status never becomes an overflowing third row.

**Tech Stack:** React 19, TypeScript, CSS Grid, Vitest + Testing Library, Playwright, Vite.

## Global Constraints

- Validate only the large-screen report experience at 1920×1080; do not add a 1280×800 test page.
- Preserve the fixed blurred pending skeleton and the current reveal order.
- Ready pages must render no fabricated or empty chart components.
- Keep existing chart ordering, palette, icons, metric typography, subtitles, evidence drawer, and chat behavior.
- Display at most two supporting charts.
- Do not modify server contracts, shared report schemas, or metric generation logic.
- Preserve the user's existing `server/.env.example` and `.DS_Store` changes; never stage them.

## File Map

- `src/features/ai/report/visuals/DataDashboardVisual.tsx`: render real summary metrics and real supporting panels only; expose actual support count; add the metric status hook.
- `src/features/ai/report/visuals/VisualRenderer.tsx`: render atomic `kpi-grid` directly on ready canvas pages.
- `src/styles/ai.css`: ready dashboard 0/1/2-support grids and non-overlapping metric card grid areas; leave pending skeleton rules unchanged.
- `src/tests/report-visuals.test.tsx`: DOM behavior for empty/one/two supports, atomic KPI pages, and status markup.
- `src/tests/report-layout-styles.test.ts`: CSS contract for ready dynamic layouts, pending fixed layout, and status/value grid areas.
- `e2e/dashboard.spec.ts`: 1920×1080 visual geometry for a one-support ready page, atomic KPI page, and metric status containment.

---

### Task 1: Render Only Real Modules on Ready Pages

**Files:**
- Modify: `src/tests/report-visuals.test.tsx`
- Modify: `src/features/ai/report/visuals/DataDashboardVisual.tsx`
- Modify: `src/features/ai/report/visuals/VisualRenderer.tsx`

**Interfaces:**
- Consumes: `DataDashboardVisualSpec.supporting`, `DataDashboardVisualSpec.summaryMetrics`, and existing `AtomicVisualRenderer` props.
- Produces: `.report-data-dashboard[data-support-count="0|1|2"]`, `data-support-slots` equal to the real count, and no `[data-dashboard-support-empty]` nodes on ready pages.

- [ ] **Step 1: Replace fixed-slot tests with failing ready-page DOM tests**

```tsx
it('omits empty ready dashboard modules when there are no summary metrics or supports', () => {
  const { container } = render(<VisualRenderer visual={dataDashboardFixture({ summaryMetrics: [], supporting: [] })} mode="canvas" />);
  const dashboard = container.querySelector('.report-data-dashboard');

  expect(dashboard).toHaveAttribute('data-support-count', '0');
  expect(dashboard).toHaveAttribute('data-support-slots', '0');
  expect(container.querySelector('[data-dashboard-slot="metrics"]')).toBeNull();
  expect(container.querySelector('[data-dashboard-slot="support"]')).toBeNull();
  expect(container.querySelectorAll('[data-dashboard-support-empty]')).toHaveLength(0);
  expect(container.querySelectorAll('.report-data-dashboard__primary [role="img"]')).toHaveLength(1);
});

it('renders one real support without a second empty ready slot', () => {
  const visual = dataDashboardFixture({
    supporting: [{ kind: 'health-ring', metric: metric('health', '运行健康度', 92, '分'), target: 100 }],
  });
  const { container } = render(<VisualRenderer visual={visual} mode="canvas" />);
  const dashboard = container.querySelector('.report-data-dashboard');

  expect(dashboard).toHaveAttribute('data-support-count', '1');
  expect(dashboard).toHaveAttribute('data-support-slots', '1');
  expect(container.querySelectorAll('[data-dashboard-support-slot]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-dashboard-support-empty]')).toHaveLength(0);
});

it('renders atomic kpi-grid directly without empty dashboard chrome', () => {
  const { container } = render(<VisualRenderer visual={visualFixture('kpi-grid')} mode="canvas" />);

  expect(container.querySelector('.report-kpi-grid')).not.toBeNull();
  expect(container.querySelector('.report-data-dashboard--atomic-kpi')).toBeNull();
  expect(container.querySelector('[data-dashboard-support-empty]')).toBeNull();
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
./node_modules/.bin/vitest run src/tests/report-visuals.test.tsx
```

Expected: FAIL because ready dashboards still render two empty support slots and atomic KPI still uses `report-data-dashboard--atomic-kpi`.

- [ ] **Step 3: Render actual summary and support collections only**

In `DataDashboardVisual.tsx`, remove `fixedSupportSlots`; set `data-support-slots={supportSlots.length}`; render the metric `<dl>` only when `summaryMetrics.length > 0`; render the support wrapper only when `supportSlots.length > 0`; and map `supportSlots` directly:

```tsx
{visual.summaryMetrics.length > 0 && (
  <dl
    className="report-data-dashboard__metrics"
    style={summaryStyle}
    data-dashboard-slot="metrics"
    aria-label="关键指标摘要"
    {...revealProps(revealedModules, 'metrics')}
  >
    {visual.summaryMetrics.map((metric, index) => (
      <div
        className="report-data-dashboard__metric"
        key={`${metric.snapshotId}:${metric.key}`}
        data-reveal-index={index}
        style={{ '--report-reveal-index': index } as CSSProperties}
      >
        <dt>
          <ReportVisualIcon kind="metric" metricKey={metric.key} metricLabel={metric.label} />
          <span>{metric.label}</span>
        </dt>
        <dd>
          <strong data-motion-number data-final-value={metric.value}>{formatReportNumber(metric.value)}</strong>
          <span>{metric.unit}</span>
        </dd>
        {metric.status && <small>{metric.status}</small>}
      </div>
    ))}
  </dl>
)}

{supportSlots.length > 0 && (
  <div className="report-data-dashboard__support" data-dashboard-slot="support" aria-label="辅助图">
    {supportSlots.map((item, index) => (
      <section
        key={`${item.kind}-${index + 1}`}
        data-dashboard-support-slot={index}
        data-panel-kind={item.kind}
        data-reveal-index={index}
        aria-label={`辅助图 ${index + 1}`}
        {...revealProps(revealedModules, `support-${index}`)}
      >
        <div className="report-data-dashboard__panel-label">
          <ReportVisualIcon kind={item.kind} />
          <span>{reportVisualLabel(item.kind)}</span>
        </div>
        <ReportVisualErrorBoundary label={`辅助图 ${index + 1}`}>
          <AtomicVisualRenderer visual={item} mode={mode} />
        </ReportVisualErrorBoundary>
      </section>
    ))}
  </div>
)}
```

In `VisualRenderer.tsx`, delete `AtomicKpiCanvas` and its icon import, then restore direct atomic rendering:

```tsx
const content = visual.kind === 'data-dashboard'
  ? <DataDashboardVisual visual={visual} mode={mode} revealedModules={revealedModules} />
  : <AtomicVisualRenderer visual={visual} mode={mode} />;
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
./node_modules/.bin/vitest run src/tests/report-visuals.test.tsx
```

Expected: all `report-visuals` tests PASS, including 0, 1, and 2 real support counts.

- [ ] **Step 5: Commit the ready-page DOM fix**

```bash
git add src/features/ai/report/visuals/DataDashboardVisual.tsx src/features/ai/report/visuals/VisualRenderer.tsx src/tests/report-visuals.test.tsx
git commit -m "fix: remove empty ready report modules"
```

---

### Task 2: Restore Dynamic Ready Dashboard Geometry

**Files:**
- Modify: `src/tests/report-layout-styles.test.ts`
- Modify: `src/styles/ai.css`

**Interfaces:**
- Consumes: ready dashboard `data-support-count="0|1|2"` from Task 1.
- Produces: full-width primary for zero supports, full-height right column for one support, two equal right rows for two supports; pending skeleton selectors remain fixed at two rows.

- [ ] **Step 1: Write the failing CSS contract**

Replace the current fixed-ready assertion with:

```ts
it('uses dynamic final support layouts while pending geometry stays fixed', () => {
  expect(css).toMatch(/\.report-data-dashboard\[data-support-count="0"\]\s*\{[^}]*grid-template-areas:\s*"metrics metrics"\s*"primary primary";/su);
  expect(css).toMatch(/\.report-data-dashboard\[data-support-count="1"\]\s+\.report-data-dashboard__support\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);/su);
  expect(css).toMatch(/\.report-data-dashboard\[data-support-count="2"\]\s+\.report-data-dashboard__support\s*\{[^}]*grid-template-rows:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/su);
  expect(css).toMatch(/\.report-data-dashboard\[data-summary-rows="0"\]\[data-support-count="0"\]\s*\{[^}]*grid-template-areas:\s*"primary";/su);
  expect(css).toMatch(/\.report-canvas-geometry-shell--dashboard\.report-slide--canvas\s+\.report-visual-renderer--canvas\[data-visual-kind="kpi-grid"\]\s+\.report-kpi-grid\s*\{[^}]*height:\s*100%;[^}]*grid-auto-rows:\s*minmax\(0,\s*1fr\);/su);
  expect(css).toMatch(/\.report-pending-slide__support\s*\{[^}]*grid-template-rows:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/su);
});
```

- [ ] **Step 2: Run the style test and verify RED**

Run:

```bash
./node_modules/.bin/vitest run src/tests/report-layout-styles.test.ts
```

Expected: FAIL because ready CSS has one unconditional two-row support rule and no 0/1-count overrides.

- [ ] **Step 3: Add count-aware ready CSS and remove empty-ready styles**

Replace the unconditional ready support rows and empty-component styles with:

```css
.report-data-dashboard[data-support-count="0"] {
  grid-template-areas: "metrics metrics" "primary primary";
  grid-template-rows: auto minmax(0, 1fr);
}
.report-data-dashboard[data-summary-rows="0"][data-support-count="0"] {
  grid-template-areas: "primary";
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
}
.report-data-dashboard[data-summary-rows="0"]:not([data-support-count="0"]) {
  grid-template-areas: "primary support";
  grid-template-rows: minmax(0, 1fr);
}
.report-data-dashboard[data-support-count="1"] .report-data-dashboard__support {
  grid-template-rows: minmax(0, 1fr);
}
.report-data-dashboard[data-support-count="2"] .report-data-dashboard__support {
  grid-template-rows: repeat(2, minmax(0, 1fr));
}
.report-canvas-geometry-shell--dashboard.report-slide--canvas .report-visual-renderer--canvas[data-visual-kind="kpi-grid"] .report-kpi-grid {
  height: 100%;
  grid-auto-rows: minmax(0, 1fr);
}
```

Delete `.report-data-dashboard__metrics--empty`, `.report-data-dashboard__support-empty`, and `.report-data-dashboard--atomic-kpi` rules. Do not alter `.report-pending-slide__support`.

- [ ] **Step 4: Run style and visual tests and verify GREEN**

Run:

```bash
./node_modules/.bin/vitest run src/tests/report-layout-styles.test.ts src/tests/report-visuals.test.tsx src/tests/report-pending-slide.test.tsx
```

Expected: all three files PASS and pending skeleton tests still find two support placeholders.

- [ ] **Step 5: Commit the dynamic layout CSS**

```bash
git add src/styles/ai.css src/tests/report-layout-styles.test.ts
git commit -m "fix: restore dynamic ready dashboard layout"
```

---

### Task 3: Keep Metric Status Inside the Card

**Files:**
- Modify: `src/tests/report-visuals.test.tsx`
- Modify: `src/tests/report-layout-styles.test.ts`
- Modify: `src/features/ai/report/visuals/DataDashboardVisual.tsx`
- Modify: `src/styles/ai.css`

**Interfaces:**
- Consumes: optional `BoundMetric.status`.
- Produces: `.report-data-dashboard__metric-status` in the `status` grid area; `dt` in `label`; `dd` in `value`.

- [ ] **Step 1: Write failing status DOM and CSS tests**

Add to `report-visuals.test.tsx`:

```tsx
it('renders metric status in a dedicated card status slot', () => {
  const compliant = { ...metric('tn', '总氮', 2.4), status: '达标' };
  const { container } = render(
    <VisualRenderer visual={dataDashboardFixture({ summaryMetrics: [compliant] })} mode="canvas" />,
  );

  const card = container.querySelector('.report-data-dashboard__metric');
  expect(card?.querySelector('dt')).toHaveTextContent('总氮');
  expect(card?.querySelector('dd')).toHaveTextContent('2.4');
  expect(card?.querySelector('.report-data-dashboard__metric-status')).toHaveTextContent('达标');
});
```

Add to `report-layout-styles.test.ts`:

```ts
it('keeps metric labels, status, and values in separate card grid areas', () => {
  expect(css).toMatch(/\.report-data-dashboard__metric\s*\{[^}]*display:\s*grid;[^}]*grid-template-areas:\s*"label status"\s*"value value";[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+max-content;/su);
  expect(css).toMatch(/\.report-data-dashboard__metric\s+dt\s*\{[^}]*grid-area:\s*label;/su);
  expect(css).toMatch(/\.report-data-dashboard__metric\s+dd\s*\{[^}]*grid-area:\s*value;/su);
  expect(css).toMatch(/\.report-data-dashboard__metric-status\s*\{[^}]*grid-area:\s*status;[^}]*overflow:\s*hidden;/su);
  expect(css).toMatch(/\.report-data-dashboard__metric-status\s*\{[^}]*white-space:\s*nowrap;/su);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
./node_modules/.bin/vitest run src/tests/report-visuals.test.tsx src/tests/report-layout-styles.test.ts
```

Expected: FAIL because status has no class and metric cards do not define grid areas.

- [ ] **Step 3: Add the dedicated status hook and card grid**

Change the status element in `DataDashboardVisual.tsx`:

```tsx
{metric.status && <small className="report-data-dashboard__metric-status">{metric.status}</small>}
```

Update `ai.css` without changing existing font sizes:

```css
.report-data-dashboard__metric {
  display: grid;
  grid-template-areas: "label status" "value value";
  grid-template-columns: minmax(0, 1fr) max-content;
  grid-template-rows: auto minmax(0, 1fr);
  align-items: start;
  min-width: 0;
  padding: .72rem .75rem;
  border: 1px solid rgb(111 175 192 / 18%);
  background: rgb(7 19 27 / 48%);
}
.report-data-dashboard__metric dt { grid-area: label; }
.report-data-dashboard__metric dd {
  grid-area: value;
  align-self: end;
  min-width: 0;
}
.report-data-dashboard__metric-status {
  grid-area: status;
  justify-self: end;
  max-inline-size: 5rem;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
./node_modules/.bin/vitest run src/tests/report-visuals.test.tsx src/tests/report-layout-styles.test.ts
```

Expected: both files PASS and typography assertions remain unchanged.

- [ ] **Step 5: Commit the metric status fix**

```bash
git add src/features/ai/report/visuals/DataDashboardVisual.tsx src/styles/ai.css src/tests/report-visuals.test.tsx src/tests/report-layout-styles.test.ts
git commit -m "fix: contain report metric status labels"
```

---

### Task 4: Verify 1920×1080 Dynamic Geometry

**Files:**
- Modify: `e2e/dashboard.spec.ts`

**Interfaces:**
- Consumes: ready layout and status hooks from Tasks 1–3.
- Produces: mocked browser coverage proving that pending skeletons stay fixed, one real support fills the right column, atomic KPI has no empty dashboard chrome, and status bounds stay inside their card.

- [ ] **Step 1: Make the mocked first dashboard exercise one support and one status**

Create the relevant fixtures as:

```ts
const largeScreenMetrics = [
  metric('qualityScore', '出水水质得分', '分', 96),
  metric('energyScore', '电耗得分', '分', 90),
  { ...metric('tn', '总氮（TN）', 'mg/L', 1.96), status: '达标' },
  metric('ammonia', '氨氮', 'mg/L', .38),
  metric('tp', '总磷', 'mg/L', .29),
  metric('cod', 'COD', 'mg/L', 22.26),
  metric('ss', '悬浮物', 'mg/L', 6.44),
  metric('carbonEmissionKg', '碳排放', 'kg/d', 184.6),
];

const firstDashboardVisual = energySlide.visual.kind === 'data-dashboard'
  ? { ...energySlide.visual, supporting: energySlide.visual.supporting.slice(0, 1) }
  : (() => { throw new Error('Expected energy dashboard visual'); })();

const firstDashboardSlide: ReportSlide = {
  ...energySlide,
  id: 'first-dashboard',
  order: 0,
  title: '首屏综合看板',
  visual: firstDashboardVisual,
};
```

- [ ] **Step 2: Replace fixed ready-slot equality with failing dynamic-layout assertions**

After the ready canvas appears, assert:

```ts
await expect(readyCanvas.locator('.report-data-dashboard')).toHaveAttribute('data-support-count', '1');
await expect(readyCanvas.locator('[data-dashboard-support-slot]')).toHaveCount(1);
await expect(readyCanvas.locator('[data-dashboard-support-empty]')).toHaveCount(0);

const readySupport = await stableBox(readyCanvas.locator('[data-dashboard-support-slot="0"]'));
expect(Math.abs(readySupport.top - pendingSlotBoxes[2]!.top)).toBeLessThanOrEqual(2);
expect(Math.abs(readySupport.bottom - pendingSlotBoxes[3]!.bottom)).toBeLessThanOrEqual(2);
```

For atomic KPI ready state, assert direct content and no empty chrome:

```ts
await expect(readyCanvas.locator('.report-kpi-grid')).toBeVisible();
await expect(readyCanvas.locator('.report-data-dashboard--atomic-kpi')).toHaveCount(0);
await expect(readyCanvas.locator('[data-dashboard-support-empty]')).toHaveCount(0);
```

Extend the existing report geometry evaluation to return each status/card pair and assert containment:

```ts
const metricStatusBounds = [...slide.querySelectorAll<HTMLElement>('.report-data-dashboard__metric-status')].map((status) => ({
  status: box(status, 'metric status'),
  card: box(status.closest('.report-data-dashboard__metric'), 'metric status card'),
}));
```

```ts
expect(reportGeometry.metricStatusBounds).toHaveLength(1);
for (const { status, card } of reportGeometry.metricStatusBounds) {
  expect(status.left).toBeGreaterThanOrEqual(card.left - 1);
  expect(status.right).toBeLessThanOrEqual(card.right + 1);
  expect(status.top).toBeGreaterThanOrEqual(card.top - 1);
  expect(status.bottom).toBeLessThanOrEqual(card.bottom + 1);
}
```

- [ ] **Step 3: Run the targeted mocked regression after the unit-test-driven implementation**

Run:

```bash
CI=1 ./node_modules/.bin/playwright test --project=mocked --grep "pending and ready dashboard|atomic kpi-grid|dynamic report workspace"
```

Expected: PASS. The production behavior has already been driven from RED to GREEN by the focused Vitest tests in Tasks 1–3; this step verifies the same contract in the real 1920×1080 browser geometry.

- [ ] **Step 4: Run the complete focused and browser regression suite**

Run:

```bash
./node_modules/.bin/vitest run src/tests/report-module-reveal.test.tsx src/tests/report-pending-slide.test.tsx src/tests/report-workspace.test.tsx src/tests/report-layout-styles.test.ts src/tests/report-slide-motion.test.tsx src/tests/report-visuals.test.tsx src/tests/app.test.tsx
./node_modules/.bin/tsc -b
./node_modules/.bin/vite build
CI=1 ./node_modules/.bin/playwright test --project=mocked
git diff --check
```

Expected: 7 focused Vitest files PASS, TypeScript PASS, Vite build PASS with only the existing bundle-size warning, all mocked Playwright tests PASS, and `git diff --check` prints nothing.

- [ ] **Step 5: Commit the large-screen regression coverage**

```bash
git add e2e/dashboard.spec.ts
git commit -m "test: cover dynamic ready report geometry"
```

---

### Task 5: Final Review and Worktree Check

**Files:**
- Review only: all files changed by Tasks 1–4.

**Interfaces:**
- Consumes: all completed commits.
- Produces: reviewed local `main` with only the user's pre-existing uncommitted files remaining.

- [ ] **Step 1: Inspect the final diff and status**

Run:

```bash
git diff origin/main...HEAD -- src/features/ai/report/visuals/DataDashboardVisual.tsx src/features/ai/report/visuals/VisualRenderer.tsx src/styles/ai.css src/tests/report-visuals.test.tsx src/tests/report-layout-styles.test.ts e2e/dashboard.spec.ts
git status --short --branch
```

Expected: no empty-ready-slot implementation remains; pending skeleton rules remain; status has an internal grid slot; only `server/.env.example` and `.DS_Store` remain uncommitted outside the task.

- [ ] **Step 2: Request a code review focused on regressions**

Reviewer prompt:

```text
Review the empty-ready-slot and metric-status fix against the approved spec. Focus on: pending skeleton stability, 0/1/2 ready support layouts, atomic KPI full use of space, metric status containment, accessibility, and accidental changes to chart typography or server contracts. Report only actionable findings with file and line references.
```
