# AI Report Comparison Bars Glow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI 报告中的 `comparison-bars` 条形图采用已确认的 B「清晰辉光」效果，使每根柱保持自身渐变并产生同色柔和辉光。

**Architecture:** 在 `ComparisonBarsVisual` 中为每个数据柱增加一个位于实际柱体后方的装饰性 SVG glow rect；所有 glow rect 复用组件实例内唯一的高斯模糊 filter，并以对应主题的 `theme.end` 作为填充色。CSS 只负责将实际柱体提升到 `0.96` 不透明度、将辉光层控制在 `0.42`，不修改趋势图、布局、数据和动画。

**Tech Stack:** React 19、TypeScript、SVG、D3 scale、CSS、Vitest、Testing Library、Vite

## Global Constraints

- 保留 `BAR_THEMES` 当前八组渐变颜色，不新增色系。
- 实际柱体不透明度必须为 `0.96`。
- 辉光层必须使用每根柱主题的 `theme.end`，目标不透明度为 `0.42`，模糊半径采用 `stdDeviation="4.5"`。
- 辉光层是纯装饰，不得添加 `data-motion-bar`、`data-metric-key` 或 `data-bar-theme`，不得改变现有柱体选择器语义。
- 保留现有柱体尺寸、位置、渐变、数值、标签、主题映射和入场动画。
- 不修改趋势图、雷达图、健康环、报告布局、图表尺寸、指标顺序、文字、数据或动画时序。
- 缩略图与主画布继续复用同一图表结构；辉光不得造成裁切或标签遮挡。

---

### Task 1: Add one theme-colored SVG glow layer per comparison bar

**Files:**
- Modify: `src/features/ai/report/visuals/ComparisonBarsVisual.tsx`
- Test: `src/tests/report-visuals.test.tsx`

**Interfaces:**
- Consumes: `useReportChartThemes(visual.items): BarTheme[]`, where every theme exposes `family`, `start`, and `end`.
- Produces: one `.report-chart__bar-glow` SVG rect per `.report-chart__bar`, plus one component-instance-local filter whose ID begins with `report-comparison-glow-`.
- Preserves: `.report-chart__bar[data-motion-bar][data-metric-key][data-bar-theme]` remains the only animated/data-bearing bar element.

- [ ] **Step 1: Write the failing component test**

Add this test after `renders wide adaptive bars with stable theme diagnostics` in `src/tests/report-visuals.test.tsx`:

```tsx
it('renders one theme-colored glow behind each comparison bar', () => {
  const items = [
    metric('qualityScore', '出水水质得分', 96, '分'),
    metric('energyScore', '电耗得分', 90, '分'),
  ];
  const { container } = render(
    <VisualRenderer visual={{ kind: 'comparison-bars', items }} mode="canvas" />,
  );
  const bars = Array.from(container.querySelectorAll<SVGRectElement>('.report-chart__bar'));
  const glows = Array.from(container.querySelectorAll<SVGRectElement>('.report-chart__bar-glow'));
  const filter = container.querySelector<SVGFilterElement>('filter[id^="report-comparison-glow-"]');
  const brightStops = Array.from(container.querySelectorAll<SVGStopElement>('linearGradient stop[offset="100%"]'))
    .map((stop) => stop.getAttribute('stop-color'));

  expect(filter).not.toBeNull();
  expect(filter?.querySelector('feGaussianBlur')).toHaveAttribute('stdDeviation', '4.5');
  expect(glows).toHaveLength(bars.length);
  expect(glows.map((glow) => glow.getAttribute('fill'))).toEqual(brightStops);
  expect(glows.every((glow) => glow.getAttribute('filter') === `url(#${filter!.id})`)).toBe(true);
  expect(glows.every((glow) => glow.getAttribute('aria-hidden') === 'true')).toBe(true);

  for (const [index, glow] of glows.entries()) {
    const bar = bars[index]!;
    expect(['x', 'y', 'width', 'height'].map((name) => glow.getAttribute(name))).toEqual(
      ['x', 'y', 'width', 'height'].map((name) => bar.getAttribute(name)),
    );
  }
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest src/tests/report-visuals.test.tsx --run -t "renders one theme-colored glow behind each comparison bar"
```

Expected: FAIL because the filter and `.report-chart__bar-glow` elements do not exist.

- [ ] **Step 3: Add the component-local filter and glow rects**

In `ComparisonBarsVisual.tsx`, add the filter ID immediately after `gradientIds`:

```tsx
const glowFilterId = `report-comparison-glow-${reactId}`;
```

Inside `<defs>`, after the gradient map, add:

```tsx
<filter
  id={glowFilterId}
  x="-50%"
  y="-30%"
  width="200%"
  height="160%"
  colorInterpolationFilters="sRGB"
>
  <feGaussianBlur in="SourceGraphic" stdDeviation="4.5" />
</filter>
```

Replace the compact `visual.items.map` body with the following geometry-preserving version:

```tsx
{visual.items.map((item, index) => {
  const barY = y(item.value);
  const top = Math.min(barY, zeroY);
  const barX = x(item.key);
  const barHeight = Math.abs(barY - zeroY);
  const theme = barThemes[index]!;
  return (
    <g key={item.key}>
      <rect
        className="report-chart__bar-glow"
        aria-hidden="true"
        x={barX}
        y={top}
        width={x.bandwidth()}
        height={barHeight}
        fill={theme.end}
        filter={`url(#${glowFilterId})`}
      />
      <rect
        className="report-chart__bar"
        data-motion-bar
        data-metric-key={item.key}
        data-bar-theme={theme.family}
        x={barX}
        y={top}
        width={x.bandwidth()}
        height={barHeight}
        fill={`url(#${gradientIds[index]})`}
      />
      <text
        className="report-chart__value"
        x={(barX ?? 0) + x.bandwidth() / 2}
        y={item.value >= 0 ? top - 10 : barY + 18}
        textAnchor="middle"
      >
        {formatReportNumber(item.value)}
      </text>
      <text
        className="report-chart__axis-label"
        x={(barX ?? 0) + x.bandwidth() / 2}
        y={HEIGHT - 20}
        textAnchor="middle"
      >
        {item.label}
      </text>
    </g>
  );
})}
```

- [ ] **Step 4: Run component regression tests and verify GREEN**

Run:

```bash
pnpm exec vitest src/tests/report-visuals.test.tsx --run
```

Expected: PASS, including mixed-sign and all-negative geometry tests; existing `.report-chart__bar` counts remain unchanged because glow rects use a separate class.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/features/ai/report/visuals/ComparisonBarsVisual.tsx src/tests/report-visuals.test.tsx
git commit -m "feat: add per-metric comparison bar glows"
```

---

### Task 2: Apply B-scheme intensity and verify the combined visual hierarchy

**Files:**
- Modify: `src/styles/ai.css`
- Test: `src/tests/report-layout-styles.test.ts`

**Interfaces:**
- Consumes: `.report-chart__bar-glow` emitted by Task 1.
- Produces: selected B-scheme intensity contract: actual bar opacity `0.96`, glow opacity `0.42`, and no fixed-color CSS drop-shadow on `.report-chart__bar`.
- Preserves: all trend, radar, ring, chart sizing, large-screen label, thumbnail, and responsive rules.

- [ ] **Step 1: Write the failing CSS contract test**

Add this test after `raises comparison bar values and labels to the large-screen scale` in `src/tests/report-layout-styles.test.ts`:

```ts
it('uses the selected clear-glow intensity for comparison bars', () => {
  expect(css).toMatch(/\.report-chart__bar\s*\{[^}]*opacity:\s*\.96;[^}]*\}/su);
  expect(css).not.toMatch(/\.report-chart__bar\s*\{[^}]*drop-shadow\([^}]*\}/su);
  expect(css).toMatch(
    /\.report-chart__bar-glow\s*\{[^}]*opacity:\s*\.42;[^}]*pointer-events:\s*none;[^}]*\}/su,
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest src/tests/report-layout-styles.test.ts --run -t "uses the selected clear-glow intensity for comparison bars"
```

Expected: FAIL because `.report-chart__bar` still uses `opacity: .76` and a fixed green `drop-shadow`, while `.report-chart__bar-glow` has no rule.

- [ ] **Step 3: Replace the old generic bar rule with the B-scheme rules**

In `src/styles/ai.css`, replace:

```css
.report-chart__bar { opacity: .76; filter: drop-shadow(0 0 5px rgb(35 239 177 / 28%)); }
```

with:

```css
.report-chart__bar { opacity: .96; }
.report-chart__bar-glow { opacity: .42; pointer-events: none; }
```

- [ ] **Step 4: Run the focused UI suites and verify GREEN**

Run:

```bash
pnpm exec vitest src/tests/report-visuals.test.tsx src/tests/report-layout-styles.test.ts --run
```

Expected: both test files PASS; the new structure and intensity contracts are green alongside existing report visual/layout tests.

- [ ] **Step 5: Run production build and the Impeccable detector**

Run:

```bash
pnpm build
node "C:\Users\观锐\.codex\skills\impeccable\scripts\detect.mjs" --json src/features/ai/report/visuals/ComparisonBarsVisual.tsx src/styles/ai.css
```

Expected: build exits `0`; detector exits `0` with no blocking findings for the two changed UI targets. The existing Vite chunk-size warning is non-blocking.

- [ ] **Step 6: Perform one bounded visual QA pass**

Run the existing development server with:

```bash
pnpm dev
```

Open `http://127.0.0.1:5173/`, generate the mixed trend-and-comparison report used by the 1920×1080 dashboard fixture, and inspect once at desktop (`1920×1080`) and once at narrow width (`390×844`).

Expected:

- Each bar keeps its original blue/green/teal/blue-violet gradient and emits a matching-color soft glow.
- The bars are visibly brighter than the initial screenshot but do not overpower the trend lines.
- Value labels and axis labels remain crisp and unobstructed.
- Glow remains inside the chart panel in main-canvas and thumbnail layouts.
- No layout, scroll, animation, or data-selection behavior changes.

If the first bounded pass reveals clipping or label obstruction, make one batched correction limited to filter bounds or glow opacity, rerun Step 4 and Step 5, then perform one confirmation pass and stop polishing.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/styles/ai.css src/tests/report-layout-styles.test.ts
git commit -m "style: brighten comparison bars with clear glows"
```

---

## Final Verification

Run:

```bash
pnpm exec vitest src/tests/report-visuals.test.tsx src/tests/report-layout-styles.test.ts src/tests/chart-theme.test.ts --run
pnpm build
git diff --check HEAD~2..HEAD
```

Expected: all focused tests and build pass; the final two-commit range has no whitespace errors and touches only the four implementation/test files listed in this plan.
