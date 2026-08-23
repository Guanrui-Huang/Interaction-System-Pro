# AI 汇报大屏密集指标与辅助条形图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 1920 × 1080 AI 汇报大屏中让最多 7 个指标卡单行展示，放大双辅助条形图并阻止越界，增加稳定的智慧水务多色配色，并把字幕移到证据线下方。

**Architecture:** 保留现有 React 数据契约和 D3 SVG 渲染。`DataDashboardVisual` 计算摘要列数；`chart-theme.ts` 提供趋势图与条形图共享的纯函数指标语义配色；`ComparisonBarsVisual` 使用更紧凑的 SVG 绘图区；`TrendVisual` 按指标语义着色并只为主序列保留面积填充；CSS 管理大屏空间预算和证据线下字幕；Playwright 使用 7 指标、双条形图页面验证真实几何。

**Tech Stack:** React 19, TypeScript 5.9, D3 7, CSS Grid, Vitest, Testing Library, Playwright。

## Global Constraints

- 只验收 1920 × 1080，不新增 1280 × 800 测试页。
- 1 至 7 个摘要指标单行呈现；8 个以上最多 7 列并自动换行，指标总量不受 4 个限制。
- 不缩小现有指标名称、数值、单位、状态和图标字号。
- 每个辅助条形图核心绘图区不小于 300 × 180 像素，不得越过面板或证据线。
- 字幕位于“展开证据明细”横线下方；证据展开时只隐藏视觉字幕，保留无障碍状态。
- 不改变数据契约、指标计算、趋势末端单点逻辑、证据内容、右侧对话或窄屏规则。
- 不使用溢出隐藏掩盖图表越界；空间不足时沿用现有分页。
- 不修改或提交用户已有的 `server/.env.example` 与 `.superpowers/sdd/task-1-report.md` 变更。

---

### Task 1: Replace the four-column summary cap with seven-column density

**Files:**
- Modify: `src/features/ai/report/visuals/DataDashboardVisual.tsx`
- Modify: `src/styles/ai.css`
- Test: `src/tests/report-visuals.test.tsx`
- Test: `src/tests/report-layout-styles.test.ts`

**Interfaces:**
- `.report-data-dashboard` exposes `data-summary-columns` and `data-summary-rows`.
- `--report-summary-columns` remains the CSS grid interface.
- Maximum summary columns: `7`.

- [ ] **Step 1: Write the failing visual test**

Replace the six-metric/four-column test with:

```tsx
it.each([
  { count: 7, columns: '7', rows: '1' },
  { count: 8, columns: '7', rows: '2' },
])('renders $count summary metrics with the seven-column cap', ({ count, columns, rows }) => {
  const metrics = Array.from({ length: count }, (_, index) => (
    metric(`metric-${index}`, `指标 ${index + 1}`, 90 + index, '分')
  ));
  const { container } = render(<VisualRenderer visual={dataDashboardFixture({ summaryMetrics: metrics })} mode="canvas" />);
  const dashboard = container.querySelector<HTMLElement>('.report-data-dashboard')!;
  const summary = container.querySelector<HTMLElement>('.report-data-dashboard__metrics')!;

  expect(container.querySelectorAll('.report-data-dashboard__metric')).toHaveLength(count);
  expect(summary.style.getPropertyValue('--report-summary-columns')).toBe(columns);
  expect(dashboard).toHaveAttribute('data-summary-columns', columns);
  expect(dashboard).toHaveAttribute('data-summary-rows', rows);
});
```

Add this style contract:

```ts
it('uses compact summary spacing without shrinking desktop text', () => {
  expect(css).toMatch(/\.report-slide--visual-data-dashboard\.report-slide--canvas\s*\{[^}]*padding-inline:\s*14px;/su);
  expect(css).toMatch(/\.report-data-dashboard__metrics\s*\{[^}]*gap:\s*\.3rem;/su);
  expect(css).toMatch(/\.report-data-dashboard__metric\s*\{[^}]*padding:\s*\.72rem\s+\.75rem;/su);
  expect(css).toMatch(/\.report-data-dashboard__metric\s+dt\s*\{[^}]*font-size:\s*\.94rem;/su);
  expect(css).toMatch(/\.report-data-dashboard__metric\s+strong\s*\{[^}]*font:\s*[^;}]*1\.8rem/isu);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `CI=1 node node_modules/vitest/vitest.mjs run src/tests/report-visuals.test.tsx src/tests/report-layout-styles.test.ts`

Expected: FAIL because columns and rows still use `4`, the data hook is absent, and spacing is wider.

- [ ] **Step 3: Implement the density calculation and CSS**

Use this component logic:

```tsx
const MAX_SUMMARY_COLUMNS = 7;
const summaryColumns = Math.min(Math.max(visual.summaryMetrics.length, 1), MAX_SUMMARY_COLUMNS);
const summaryRows = Math.ceil(visual.summaryMetrics.length / MAX_SUMMARY_COLUMNS);
```

Add `data-summary-columns={summaryColumns}` to the dashboard root. Keep the existing CSS variable and use:

```css
.report-slide--visual-data-dashboard.report-slide--canvas { padding-inline: 14px; }
.report-data-dashboard__metrics {
  grid-area: metrics;
  display: grid;
  grid-template-columns: repeat(var(--report-summary-columns), minmax(0, 1fr));
  gap: .3rem;
  margin: 0;
}
.report-data-dashboard__metric {
  min-width: 0;
  padding: .72rem .75rem;
  border: 1px solid rgb(111 175 192 / 18%);
  background: rgb(7 19 27 / 48%);
}
```

- [ ] **Step 4: Run tests and commit**

Run: `CI=1 node node_modules/vitest/vitest.mjs run src/tests/report-visuals.test.tsx src/tests/report-layout-styles.test.ts`

Expected: PASS.

```bash
git add src/features/ai/report/visuals/DataDashboardVisual.tsx src/styles/ai.css src/tests/report-visuals.test.tsx src/tests/report-layout-styles.test.ts
git commit -m "fix: fit seven report metrics on one row"
```

---

### Task 2: Add seven stable water-operations chart themes and enlarge bars

**Files:**
- Modify: `src/charts/chart-theme.ts`
- Modify: `src/features/ai/report/visuals/ComparisonBarsVisual.tsx`
- Modify: `src/features/ai/report/visuals/TrendVisual.tsx`
- Modify: `src/styles/ai.css`
- Create: `src/tests/chart-theme.test.ts`
- Test: `src/tests/report-visuals.test.tsx`
- Test: `src/tests/report-layout-styles.test.ts`

**Interfaces:**
- Export `BarThemeFamily` and `barThemeForMetric(metricKey: string, metricLabel: string)`.
- `CHART_THEME.bars` contains seven `{ family, start, end }` entries.
- Each bar exposes `data-bar-theme`.
- Each trend series consumes the same semantic theme and exposes `data-series-theme`; only the first series keeps an area fill.

- [ ] **Step 1: Write failing palette tests**

Create `src/tests/chart-theme.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { barThemeForMetric, CHART_THEME } from '../charts/chart-theme';

describe('report bar themes', () => {
  it('provides seven distinct gradients', () => {
    expect(CHART_THEME.bars).toHaveLength(7);
    expect(new Set(CHART_THEME.bars.map(({ family }) => family)).size).toBe(7);
    expect(new Set(CHART_THEME.bars.flatMap(({ start, end }) => [start, end])).size).toBe(14);
  });

  it('maps the common seven metrics to stable distinct families', () => {
    const metrics = [
      ['qualityScore', '出水水质得分'], ['energyScore', '电耗得分'], ['tn', '总氮（TN）'],
      ['ammonia', '氨氮'], ['tp', '总磷'], ['cod', 'COD'], ['ss', '悬浮物'],
    ] as const;
    const themes = metrics.map(([key, label]) => barThemeForMetric(key, label).family);
    expect(new Set(themes).size).toBe(7);
    expect(metrics.map(([key, label]) => barThemeForMetric(key, label).family)).toEqual(themes);
  });
});
```

Add this visual test to `src/tests/report-visuals.test.tsx`:

```tsx
it('renders wide adaptive bars with stable theme diagnostics', () => {
  const items = [
    metric('qualityScore', '出水水质得分', 96, '分'),
    metric('energyScore', '电耗得分', 90, '分'),
    metric('tn', '总氮（TN）', 1.96),
    metric('ammonia', '氨氮', .38),
    metric('tp', '总磷', .29),
    metric('cod', 'COD', 22.26),
    metric('ss', '悬浮物', 6.44),
  ];
  const { container } = render(<VisualRenderer visual={{ kind: 'comparison-bars', items }} mode="canvas" />);
  const bars = [...container.querySelectorAll<SVGRectElement>('.report-chart__bar')];

  expect(bars).toHaveLength(7);
  expect(new Set(bars.map((bar) => bar.dataset.barTheme)).size).toBe(7);
  expect(Number(bars[0]?.getAttribute('width'))).toBeGreaterThan(40);
});
```

Add a trend contract using the same seven metrics:

```tsx
it('uses the same seven semantic themes for trend series and fills only the primary series', () => {
  const items = [
    metric('qualityScore', '出水水质得分', 96, '分'),
    metric('energyScore', '电耗得分', 90, '分'),
    metric('tn', '总氮（TN）', 1.96),
    metric('ammonia', '氨氮', .38),
    metric('tp', '总磷', .29),
    metric('cod', 'COD', 22.26),
    metric('ss', '悬浮物', 6.44),
  ];
  const series = items.map((item) => ({
    key: item.key, label: item.label, unit: item.unit ?? '',
    snapshotId: item.snapshotId, claimIds: item.claimIds,
    points: [{ label: '2025-08', value: item.value * .96 }, { label: '2026-08', value: item.value }],
  }));
  const { container } = render(<VisualRenderer visual={{ kind: 'trend-area', series }} mode="canvas" />);
  const lines = [...container.querySelectorAll<SVGPathElement>('.report-chart__line[data-series-theme]')];

  expect(lines).toHaveLength(7);
  expect(new Set(lines.map((line) => line.dataset.seriesTheme)).size).toBe(7);
  expect(container.querySelectorAll('.report-chart__area')).toHaveLength(1);
});
```

Add this style test to `src/tests/report-layout-styles.test.ts`:

```ts
it('raises comparison bar values and labels to the large-screen scale', () => {
  expect(css).toMatch(/\.report-chart--bars\s+\.report-chart__value\s*\{[^}]*font-size:\s*15px;/su);
  expect(css).toMatch(/\.report-chart--bars\s+\.report-chart__axis-label\s*\{[^}]*font-size:\s*14px;/su);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `CI=1 node node_modules/vitest/vitest.mjs run src/tests/chart-theme.test.ts src/tests/report-visuals.test.tsx src/tests/report-layout-styles.test.ts`

Expected: FAIL because only two gradients exist; bars and trend series do not share a semantic helper or diagnostics; every trend-area series still receives a fill; larger bar text does not exist.

- [ ] **Step 3: Implement the palette helper**

Define these families and colors in `chart-theme.ts`:

```ts
export type BarThemeFamily = 'water' | 'treatment' | 'flow' | 'energy' | 'analytics' | 'resource' | 'risk';
const BAR_THEMES = [
  { family: 'water', start: '#1689DC', end: '#2CE4F5' },
  { family: 'treatment', start: '#19BFA0', end: '#42F0C7' },
  { family: 'flow', start: '#0A9FA8', end: '#47D9D1' },
  { family: 'energy', start: '#1454A6', end: '#2B8CF0' },
  { family: 'analytics', start: '#6B2FB2', end: '#AA56F0' },
  { family: 'resource', start: '#A9AB45', end: '#EEEF97' },
  { family: 'risk', start: '#DB2777', end: '#F472B6' },
] as const satisfies readonly { family: BarThemeFamily; start: string; end: string }[];
```

Add the exact matcher and deterministic fallback:

```ts
const BAR_THEME_MATCHERS: readonly [BarThemeFamily, RegExp][] = [
  ['energy', /energy|power|electric|kwh|电耗|能耗|电能|鼓风/iu],
  ['resource', /phosph|\btp\b|cost|saving|fee|总磷|费用|成本|节省/iu],
  ['risk', /\bcod\b|carbon|co2|organic|碳|排放|风险/iu],
  ['analytics', /ammonia|nh3|process|氨氮|工艺|分析/iu],
  ['flow', /\bss\b|flow|volume|悬浮物|流量|水量|处理量|吨水/iu],
  ['treatment', /\btn\b|nitrogen|health|总氮|健康|达标/iu],
  ['water', /quality|water|effluent|水质|出水/iu],
];

function stableThemeIndex(value: string): number {
  let hash = 0;
  for (const character of value) hash = ((hash * 31) + character.codePointAt(0)!) >>> 0;
  return hash % BAR_THEMES.length;
}

export function barThemeForMetric(metricKey: string, metricLabel: string) {
  const source = `${metricKey} ${metricLabel}`;
  const family = BAR_THEME_MATCHERS.find(([, matcher]) => matcher.test(source))?.[0];
  return family
    ? BAR_THEMES.find((theme) => theme.family === family)!
    : BAR_THEMES[stableThemeIndex(source)]!;
}
```

Assign `bars: BAR_THEMES` inside `CHART_THEME`.

- [ ] **Step 4: Apply the shared palette to `TrendVisual`**

Replace the index-only palette helper with:

```tsx
function paletteForSeries(series: Pick<BoundSeries, 'key' | 'label'>) {
  return barThemeForMetric(series.key, series.label);
}
```

Pass each series item to this helper in the legend, gradient definitions and rendered-series loop. Add `data-series-theme={palette.family}` to `.report-chart__line`. Keep all line gradients and terminal markers, but render the area path only when `visual.kind === 'trend-area' && index === 0`.

- [ ] **Step 5: Enlarge and color `ComparisonBarsVisual`**

Import `barThemeForMetric`, then use this calculation:

```tsx
const PLOT = { left: 52, right: 28, top: 34, bottom: 54 };
const bandPadding = visual.items.length <= 4 ? .28 : .18;
const x = scaleBand()
  .domain(visual.items.map((item) => item.key))
  .range([PLOT.left, WIDTH - PLOT.right])
  .padding(bandPadding);
const barThemes = visual.items.map((item) => barThemeForMetric(item.key, item.label));
const gradientIds = barThemes.map((_, index) => `report-comparison-bar-${reactId}-${index}`);
```

Render definitions and bars with:

```tsx
{barThemes.map((gradient, index) => (
  <linearGradient key={gradientIds[index]} id={gradientIds[index]} x1="0" y1="1" x2="0" y2="0">
    <stop offset="0%" stopColor={gradient.start} />
    <stop offset="100%" stopColor={gradient.end} />
  </linearGradient>
))}
```

```tsx
<rect
  className="report-chart__bar"
  data-motion-bar
  data-bar-theme={barThemes[index]!.family}
  x={x(item.key)}
  y={top}
  width={x.bandwidth()}
  height={Math.abs(barY - zeroY)}
  fill={`url(#${gradientIds[index]})`}
/>
```

Place values at `top - 10`, axis labels at `HEIGHT - 20`, then add:

```css
.report-chart--bars .report-chart__value { font-size: 15px; }
.report-chart--bars .report-chart__axis-label { font-size: 14px; }
```

- [ ] **Step 6: Run tests and commit**

Run: `CI=1 node node_modules/vitest/vitest.mjs run src/tests/chart-theme.test.ts src/tests/report-visuals.test.tsx src/tests/report-layout-styles.test.ts`

Expected: PASS.

```bash
git add src/charts/chart-theme.ts src/features/ai/report/visuals/ComparisonBarsVisual.tsx src/features/ai/report/visuals/TrendVisual.tsx src/styles/ai.css src/tests/chart-theme.test.ts src/tests/report-visuals.test.tsx src/tests/report-layout-styles.test.ts
git commit -m "feat: diversify report chart colors"
```

---

### Task 3: Contain two support charts and move subtitles below evidence

**Files:**
- Modify: `src/styles/ai.css`
- Test: `src/tests/report-layout-styles.test.ts`

**Interfaces:**
- `data-support-count="2"` identifies the double-support layout.
- The evidence button's existing `aria-expanded` attribute controls visual subtitle opacity through CSS `:has()`.

- [ ] **Step 1: Write failing style contracts**

Replace the fixed-height two-support assertion with:

```ts
it('lets two supporting charts share available height without overflow', () => {
  expect(css).toMatch(/\.report-data-dashboard\[data-support-count="2"\]\s+\.report-data-dashboard__support\s*\{[^}]*grid-template-rows:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/su);
  expect(css).toMatch(/\.report-data-dashboard__primary,\s*\.report-data-dashboard__support\s*>\s*section\s*\{[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\);[^}]*min-height:\s*0;/su);
  expect(css).toMatch(/\.report-data-dashboard__support\s*>\s*section\[data-panel-kind=['"]comparison-bars['"]\]\s*\{[^}]*min-height:\s*0;/su);
});
```

Replace the desktop subtitle test with:

```ts
it('keeps the subtitle below collapsed evidence and hides it while evidence is open', () => {
  expect(css).toMatch(/\.report-subtitle-bar\s*\{[^}]*bottom:\s*clamp\(1rem,\s*1\.85vh,\s*1\.25rem\);[^}]*pointer-events:\s*none;/su);
  expect(css).toMatch(/\.report-workspace:has\(\.report-evidence-drawer\s*>\s*button\[aria-expanded=['"]true['"]\]\)[^{]*\.report-subtitle-bar__text,[^{]*\.report-subtitle-bar__error\s*\{[^}]*opacity:\s*0;/su);
  expect(css).toMatch(/\.report-subtitle-bar__text\s*\{[^}]*white-space:\s*nowrap;/su);
});
```

- [ ] **Step 2: Run the style test and verify RED**

Run: `CI=1 node node_modules/vitest/vitest.mjs run src/tests/report-layout-styles.test.ts`

Expected: FAIL on fixed `15rem` rows, `min-content` tracks, `13.5rem` panel minimum and `8vh` subtitle offset.

- [ ] **Step 3: Implement the shrink chain and subtitle placement**

Use these rules:

```css
.report-data-dashboard__primary,
.report-data-dashboard__support > section {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  padding: .55rem;
  border: 1px solid rgb(111 175 192 / 16%);
  background: rgb(5 17 25 / 36%);
  container-type: size;
}
.report-data-dashboard[data-support-count="2"] .report-data-dashboard__support {
  grid-template-rows: repeat(2, minmax(0, 1fr));
}
.report-data-dashboard__support > section[data-panel-kind='comparison-bars'] { min-height: 0; }
.report-subtitle-bar { bottom: clamp(1rem, 1.85vh, 1.25rem); }
.report-workspace:has(.report-evidence-drawer > button[aria-expanded='true']) .report-subtitle-bar__text,
.report-workspace:has(.report-evidence-drawer > button[aria-expanded='true']) .report-subtitle-bar__error { opacity: 0; }
```

Do not target `.report-subtitle-bar__status`.

- [ ] **Step 4: Run tests and commit**

Run: `CI=1 node node_modules/vitest/vitest.mjs run src/tests/report-layout-styles.test.ts`

Expected: PASS.

```bash
git add src/styles/ai.css src/tests/report-layout-styles.test.ts
git commit -m "fix: contain double bar panels above evidence"
```

---

### Task 4: Add the 1920 × 1080 dense double-bar browser regression

**Files:**
- Modify: `e2e/dashboard.spec.ts`

**Interfaces:**
- The mocked `energySlide` becomes the canonical 7-card, trend-plus-two-bars acceptance fixture.

- [ ] **Step 1: Build the seven-metric fixture**

Use:

```ts
const largeScreenMetrics = [
  metric('qualityScore', '出水水质得分', '分', 96),
  metric('energyScore', '电耗得分', '分', 90),
  metric('tn', '总氮（TN）', 'mg/L', 1.96),
  metric('ammonia', '氨氮', 'mg/L', .38),
  metric('tp', '总磷', 'mg/L', .29),
  metric('cod', 'COD', 'mg/L', 22.26),
  metric('ss', '悬浮物', 'mg/L', 6.44),
];
const largeScreenScoreMetrics = largeScreenMetrics.slice(0, 2);
const largeScreenWaterMetrics = largeScreenMetrics.slice(2);
```

Use the two score metrics in the primary trend. Set supporting visuals to:

```ts
supporting: [
  { kind: 'comparison-bars', items: largeScreenScoreMetrics },
  { kind: 'comparison-bars', items: largeScreenWaterMetrics },
],
```

- [ ] **Step 2: Add real-geometry assertions**

Inside the existing `canvas.evaluate`, collect the geometry with the test's existing `box()` helper:

```ts
const metricCardBounds = [...slide.querySelectorAll<HTMLElement>('.report-data-dashboard__metric')]
  .map((card) => box(card, 'metric card'));
const barCharts = [...slide.querySelectorAll<HTMLElement>('[data-panel-kind="comparison-bars"] .report-chart--bars')]
  .map((chart) => box(chart, 'bar chart'));
const barThemes = [...slide.querySelectorAll<HTMLElement>('.report-chart__bar[data-bar-theme]')]
  .map((bar) => bar.dataset.barTheme ?? '');
const barValue = slide.querySelector<SVGTextElement>('.report-chart--bars .report-chart__value')!;
const barAxisLabel = slide.querySelector<SVGTextElement>('.report-chart--bars .report-chart__axis-label')!;
const evidenceButton = slide.querySelector<HTMLElement>('.report-evidence-drawer > button')!;
```

Add these fields to the returned geometry object:

```ts
metricCardBounds,
barCharts,
barThemes,
barValueFontSize: Number.parseFloat(getComputedStyle(barValue).fontSize),
barAxisLabelFontSize: Number.parseFloat(getComputedStyle(barAxisLabel).fontSize),
evidenceButtonBounds: box(evidenceButton, 'evidence button'),
subtitleTextOpacity: Number.parseFloat(getComputedStyle(subtitleText).opacity),
```

Then assert:

```ts
expect(reportGeometry.metricCardBounds).toHaveLength(7);
expect(new Set(reportGeometry.metricCardBounds.map(({ top }) => Math.round(top))).size).toBe(1);
for (const card of reportGeometry.metricCardBounds) expect(card.width).toBeGreaterThanOrEqual(179);
expect(reportGeometry.barCharts).toHaveLength(2);
for (const chart of reportGeometry.barCharts) {
  expect(chart.width).toBeGreaterThanOrEqual(300);
  expect(chart.height).toBeGreaterThanOrEqual(180);
}
expect(new Set(reportGeometry.barThemes).size).toBe(7);
expect(reportGeometry.barValueFontSize).toBeGreaterThanOrEqual(15);
expect(reportGeometry.barAxisLabelFontSize).toBeGreaterThanOrEqual(14);
expect(reportGeometry.subtitleBounds.top).toBeGreaterThanOrEqual(reportGeometry.evidenceButtonBounds.top - 1);
expect(reportGeometry.subtitleBounds.bottom).toBeLessThanOrEqual(reportGeometry.evidenceButtonBounds.bottom + 2);
```

Retain the existing no-scroll, title, font, panel-containment and non-overlap assertions. Then verify expanded evidence hides only the visual subtitle:

```ts
await page.getByRole('button', { name: '展开证据明细' }).click();
await expect(page.locator('.report-subtitle-bar__text')).toHaveCSS('opacity', '0');
await expect(page.locator('.report-subtitle-bar__status')).toHaveAttribute('role', 'status');
await page.getByRole('button', { name: '收起证据明细' }).click();
await expect(page.locator('.report-subtitle-bar__text')).toHaveCSS('opacity', '1');
```

- [ ] **Step 3: Run the focused browser test**

Run: `CI=1 node node_modules/playwright/cli.js test e2e/dashboard.spec.ts --project=mocked --grep "streams a complete no-scroll dynamic report at 1920x1080"`

Expected: PASS and attach the updated `dynamic-report-1920x1080` screenshot. If card width is below 179px, adjust only dashboard-slide horizontal padding or metric gap; do not reduce fonts. If a chart crosses evidence, reduce panel chrome/gap before changing the 300 × 180 minimum.

- [ ] **Step 4: Commit the browser regression**

```bash
git add e2e/dashboard.spec.ts
git commit -m "test: cover dense double bar report at 1920"
```

---

### Task 5: Run full verification and inspect the live page

**Files:**
- Verify only.

**Interfaces:**
- No new interfaces.

- [ ] **Step 1: Run unit/style tests**

Run: `CI=1 node node_modules/vitest/vitest.mjs run src/tests/chart-theme.test.ts src/tests/report-visuals.test.tsx src/tests/report-layout-styles.test.ts`

Expected: PASS.

- [ ] **Step 2: Run build**

Run: `pnpm run build`

Expected: `tsc -b` and `vite build` pass.

- [ ] **Step 3: Run browser tests**

Run: `CI=1 pnpm run test:e2e:mocked`

Expected: all mocked Playwright tests pass.

- [ ] **Step 4: Run the Impeccable detector**

Run: `node /Users/xiaoshen001/.codex/skills/impeccable/scripts/detect.mjs --json --scope layout src/styles/ai.css`

Expected: no new high-severity layout finding caused by this change; review findings instead of masking them with overflow.

- [ ] **Step 5: Inspect and reopen the live page**

At 1920 × 1080, inspect `http://127.0.0.1:5173/` in the in-app browser. Verify seven cards in one row, both bars within panels, seven distinct colors, subtitle below the evidence line, hidden subtitle while evidence is open, and no scrolling or overlap. Leave the verified page open.

- [ ] **Step 6: Verify repository hygiene**

Run:

```bash
git status --short
git diff --check
git log -6 --oneline
```

Expected: only the user's pre-existing `.superpowers/sdd/task-1-report.md` and `server/.env.example` changes remain unstaged.
