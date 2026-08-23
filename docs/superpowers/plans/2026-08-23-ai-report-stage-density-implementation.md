# AI Report Stage Density Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 1920 × 1080 大屏中压缩顶部和页面内留白，让标题与图表获得更多有效空间，并将讲解字幕改为不占布局的居中悬浮字幕。

**Architecture:** 保留当前报告数据、指标完整性、分页和图表渲染链路，只调整报告工作区的 CSS 网格、数据看板标题带和字幕组件。桌面工作区从三行改为两行，字幕通过覆盖层定位到画布底部；数据看板标题采用显式的 `meta/title/takeaway` 网格区域，图形沿父级高度链路伸展，既有分页器继续负责超容量内容。

**Tech Stack:** React 19、TypeScript 5.9、CSS Grid、Vitest 3、Testing Library、Playwright 1.55。

## Global Constraints

- 唯一布局和浏览器验收尺寸为 1920 × 1080；不要新增 1280 × 800 测试页面或验收分支。
- 指标总量由分析结果决定；每行最多四列不是指标总量上限。
- 汇报画布和单张汇报页不得依赖滚轮；右侧 AI 对话历史继续独立滚动。
- 不修改、不暂存、不提交用户现有的 `server/.env.example` 变更。
- 不改变现有报告数据契约、指标完整性规则、趋势末端圆点逻辑或对话交互功能。
- 修改 UI 前执行 Impeccable 布局预检；完成前执行最终缺陷扫描、自动化测试和 1920 × 1080 浏览器验收。

## File Map

- `src/styles/ai.css`：桌面工作区两行网格、字幕覆盖层、标题带、页面内边距和图表面板的空间规则。
- `src/features/ai/report/ReportSubtitleBar.tsx`：只渲染实际字幕文本，保留状态和错误的可访问语义。
- `src/tests/report-layout-styles.test.ts`：保护桌面布局、标题网格、字幕覆盖层和无滚动样式契约。
- `src/tests/report-workspace.test.tsx`：保护字幕文本空态和报告工作区结构。
- `e2e/dashboard.spec.ts`：补充字幕覆盖层和标题/图表几何验收。

---

### Task 1: Lock the new report geometry with failing tests

**Files:**
- Modify: `src/tests/report-layout-styles.test.ts`
- Modify: `src/tests/report-workspace.test.tsx`
- Modify: `e2e/dashboard.spec.ts`

**Interfaces:**
- Consumes: existing `.report-workspace`, `.report-subtitle-bar`, `.report-slide--visual-data-dashboard` selectors.
- Produces: executable expectations for the two-row desktop work area, balanced title band, overlay subtitle, full-height visual propagation, and no subtitle fallback copy.

- [ ] **Step 1: Add the failing CSS contract assertions**

Append a test to `src/tests/report-layout-styles.test.ts`:

```ts
it('uses a compact two-row canvas with a floating subtitle and balanced dashboard heading', () => {
  expect(css).toMatch(/\.report-workspace\s*\{[^}]*grid-template-areas:\s*"header header header"\s+"rail canvas chat";[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\);/su);
  expect(css).toMatch(/\.report-workspace__canvas\s*\{[^}]*padding:\s*clamp\(10px,\s*1\.25vw,\s*20px\);/su);
  expect(css).toMatch(/\.report-slide--canvas\s*\{[^}]*gap:\s*clamp\(10px,\s*1\.35vw,\s*22px\);[^}]*padding:\s*clamp\(14px,\s*1\.65vw,\s*28px\);/su);
  expect(css).toMatch(/\.report-slide--visual-data-dashboard\.report-slide--canvas\s+\.report-slide__heading\s*\{[^}]*grid-template-columns:\s*max-content\s+minmax\(0,\s*1fr\);[^}]*grid-template-areas:\s*"meta title"\s+"takeaway takeaway";/su);
  expect(css).toMatch(/\.report-slide--visual-data-dashboard\.report-slide--canvas\s+\.report-slide__heading\s*>\s*p:first-child\s*\{[^}]*grid-area:\s*meta;/su);
  expect(css).toMatch(/\.report-slide--visual-data-dashboard\.report-slide--canvas\s+\.report-slide__heading\s+h2\s*\{[^}]*grid-area:\s*title;[^}]*text-wrap:\s*balance;/su);
  expect(css).toMatch(/\.report-slide--visual-data-dashboard\.report-slide--canvas\s+\.report-slide__takeaway\s*\{[^}]*grid-area:\s*takeaway;/su);
  expect(css).toMatch(/\.report-subtitle-bar\s*\{[^}]*position:\s*fixed;[^}]*pointer-events:\s*none;[^}]*background:\s*transparent;/su);
  expect(css).toMatch(/\.report-subtitle-bar__text\s*\{[^}]*color:\s*#fff;[^}]*text-align:\s*center;[^}]*text-shadow:/su);
  expect(css).toMatch(/\.report-subtitle-bar__status\s*\{[^}]*position:\s*absolute;[^}]*width:\s*1px;[^}]*height:\s*1px;/su);
});
```

- [ ] **Step 2: Add the failing subtitle empty-state assertion**

In `src/tests/report-workspace.test.tsx`, add a test beside the existing subtitle tests. Use the existing `session` helper and set `narration.subtitle` to an empty string before rendering:

```tsx
it('does not render placeholder copy when the narration subtitle is empty', () => {
  const previousSubtitle = narration.subtitle;
  narration.subtitle = '';
  render(<ReportWorkspace session={session(snapshot())} />);

  expect(screen.getByRole('region', { name: '讲解字幕' })).not.toHaveTextContent('等待讲解字幕');
  narration.subtitle = previousSubtitle;
});
```

- [ ] **Step 3: Extend the desktop E2E geometry assertion**

In the existing 1920 geometry block in `e2e/dashboard.spec.ts`, add these returned values:

```ts
subtitlePosition: getComputedStyle(document.querySelector<HTMLElement>('.report-subtitle-bar')!).position,
subtitlePointerEvents: getComputedStyle(document.querySelector<HTMLElement>('.report-subtitle-bar')!).pointerEvents,
subtitleText: document.querySelector<HTMLElement>('.report-subtitle-bar__text')?.textContent ?? '',
titleLines: canvas.locator('h2').evaluate((heading) => heading.getClientRects().length),
```

Then assert:

```ts
expect(geometry.subtitlePosition).toBe('fixed');
expect(geometry.subtitlePointerEvents).toBe('none');
expect(geometry.subtitleText).not.toBe('等待讲解字幕');
expect(reportGeometry.canvasScrollHeight).toBeLessThanOrEqual(reportGeometry.canvasClientHeight + 1);
expect(reportGeometry.barWidth).toBeGreaterThanOrEqual(300);
expect(reportGeometry.barHeight).toBeGreaterThanOrEqual(216);
```

- [ ] **Step 4: Run the focused tests and verify the new tests fail for the intended reasons**

Run:

```bash
pnpm exec vitest src/tests/report-layout-styles.test.ts src/tests/report-workspace.test.tsx --run
```

Expected: FAIL because the current desktop grid reserves a subtitle row, the dashboard heading uses fixed opposing columns, the subtitle is a grid item with a background, and the component renders the `等待讲解字幕` fallback.

- [ ] **Step 5: Commit the red tests**

```bash
git add src/tests/report-layout-styles.test.ts src/tests/report-workspace.test.tsx e2e/dashboard.spec.ts
git commit -m "test: define report stage density geometry"
```

### Task 2: Implement the compact canvas and floating subtitle

**Files:**
- Modify: `src/styles/ai.css:129-156,222-324,380-408,654-724`
- Modify: `src/features/ai/report/ReportSubtitleBar.tsx:3-11`

**Interfaces:**
- Consumes: Task 1's CSS and component expectations.
- Produces: a desktop report workspace whose canvas owns all remaining height, a subtitle overlay bounded to the canvas column, and a dashboard title band with balanced wrapping.

- [ ] **Step 1: Remove the subtitle row from the desktop workspace**

Change the desktop workspace declarations to:

```css
.report-workspace {
  display: grid;
  grid-template-areas: "header header header" "rail canvas chat";
  grid-template-columns: var(--report-rail-width) minmax(0, 1fr) var(--report-chat-width);
  grid-template-rows: auto minmax(0, 1fr);
}
```

Reduce the page padding and gap without changing the existing report colors or border system:

```css
.report-workspace__canvas { padding: clamp(10px, 1.25vw, 20px); }
.report-slide--canvas {
  gap: clamp(10px, 1.35vw, 22px);
  padding: clamp(14px, 1.65vw, 28px);
}
```

- [ ] **Step 2: Give the dashboard title its full flexible width**

Replace the current data-dashboard heading rule with:

```css
.report-slide--visual-data-dashboard.report-slide--canvas .report-slide__heading {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  grid-template-areas: "meta title" "takeaway takeaway";
  align-items: start;
  gap: .4rem 1.25rem;
}
.report-slide--visual-data-dashboard.report-slide--canvas .report-slide__heading > p:first-child {
  grid-area: meta;
  margin: 0;
  align-self: center;
}
.report-slide--visual-data-dashboard.report-slide--canvas .report-slide__heading h2 {
  grid-area: title;
  min-width: 0;
  max-width: none;
  text-wrap: balance;
  overflow-wrap: normal;
  line-break: strict;
}
.report-slide--visual-data-dashboard.report-slide--canvas .report-slide__takeaway {
  grid-area: takeaway;
  max-width: none;
  margin-top: .35rem;
}
```

Reduce the generic heading spacing so the `LIVE REPORT` line does not create a top void; leave other slide types unchanged.

- [ ] **Step 3: Make the subtitle a non-blocking visual overlay**

Replace the subtitle bar rules with:

```css
.report-subtitle-bar {
  position: fixed;
  z-index: 48;
  left: calc(var(--report-rail-width) + clamp(10px, 1.25vw, 20px));
  right: calc(var(--report-chat-width) + clamp(10px, 1.25vw, 20px));
  bottom: clamp(.7rem, 1.8vh, 1.25rem);
  display: grid;
  justify-items: center;
  min-width: 0;
  padding: 0 .75rem;
  background: transparent;
  pointer-events: none;
}
.report-subtitle-bar__text {
  max-width: min(72ch, 78vw);
  color: #fff;
  font-size: clamp(.95rem, 1.2vw, 1.3rem);
  line-height: 1.45;
  text-align: center;
  text-shadow: 0 2px 5px rgb(0 0 0 / 92%), 0 0 14px rgb(0 0 0 / 72%);
}
.report-subtitle-bar__status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
```

Keep the existing error alert semantics, but position it inside the overlay without restoring a reserved layout row. Update the mobile workspace to keep the existing stacked behavior by using the `subtitle` area only inside the mobile media query; desktop must not reference a subtitle grid area.

- [ ] **Step 4: Remove the placeholder copy from the component**

Change `ReportSubtitleBar.tsx` so the subtitle paragraph uses the actual controller value:

```tsx
export function ReportSubtitleBar({ controller }: { controller: NarrationController }) {
  return (
    <section className="report-subtitle-bar" aria-label="讲解字幕">
      <p className="report-subtitle-bar__text">{controller.subtitle}</p>
      <p className="report-subtitle-bar__status" role="status" aria-live="polite" aria-atomic="true">
        {controller.canNarrate === false ? '没有可播放的讲解页面' : controller.message}
      </p>
      {controller.error && <p className="report-subtitle-bar__error" role="alert">{controller.error}</p>}
    </section>
  );
}
```

- [ ] **Step 5: Run the focused tests and verify they pass**

Run:

```bash
pnpm exec vitest src/tests/report-layout-styles.test.ts src/tests/report-workspace.test.tsx --run
```

Expected: PASS, with the existing report conversation, subtitle, and layout tests remaining green.

- [ ] **Step 6: Commit the compact canvas implementation**

```bash
git add src/styles/ai.css src/features/ai/report/ReportSubtitleBar.tsx
git commit -m "fix: reclaim report canvas space"
```

### Task 3: Verify chart fill, title wrapping, and no-overlap behavior at 1920 × 1080

**Files:**
- Modify: `src/tests/report-layout-styles.test.ts`
- Modify: `e2e/dashboard.spec.ts`

**Interfaces:**
- Consumes: Task 2's two-row workspace and dashboard title areas.
- Produces: regression coverage for usable chart dimensions, title line behavior, and the existing semantic pagination path.

- [ ] **Step 1: Add chart panel fill assertions**

Add to `src/tests/report-layout-styles.test.ts`:

```ts
it('lets dashboard panels use their full assigned area without overlap', () => {
  expect(css).toMatch(/\.report-data-dashboard__primary,\s*\.report-data-dashboard__support\s*>\s*section\s*\{[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\);[^}]*min-height:\s*0;/su);
  expect(css).toMatch(/\.report-data-dashboard\s+\.report-visual-renderer,\s*\.report-data-dashboard\s+\.report-visual,\s*\.report-data-dashboard\s+\.report-visual__graphic\s*\{[^}]*min-height:\s*0;[^}]*height:\s*100%;/su);
  expect(css).toMatch(/\.report-data-dashboard\s+\.report-chart\s*\{[^}]*height:\s*100%;[^}]*max-height:\s*none;/su);
  expect(css).toMatch(/\.report-data-dashboard__support\s*>\s*section\[data-panel-kind=['"]comparison-bars['"]\]\s*\{[^}]*min-height:\s*13\.5rem;/su);
});
```

- [ ] **Step 2: Run the layout tests and verify they pass**

Run:

```bash
pnpm exec vitest src/tests/report-layout-styles.test.ts --run
```

Expected: PASS.

- [ ] **Step 3: Run the mocked 1920 Playwright test**

Run:

```bash
pnpm exec playwright test e2e/dashboard.spec.ts --project=mocked
```

Expected: PASS with the existing six-metric dashboard, four terminal trend points, 300px minimum bar width, 216px minimum bar height, no canvas scroll, and every workspace region inside the viewport.

- [ ] **Step 4: Capture one final visual defect scan**

Run:

```bash
node /Users/xiaoshen001/.codex/skills/impeccable/scripts/detect.mjs --json src/styles/ai.css src/features/ai/report/ReportSubtitleBar.tsx src/features/ai/report/ReportSlideView.tsx
```

Expected: no unexplained layout findings. If the scan reports a real overflow or arbitrary spacing regression, fix it in the production CSS, rerun the focused layout test, then rerun this scan once.

- [ ] **Step 5: Run the full verification set**

Run:

```bash
pnpm exec vitest --run
pnpm run build
pnpm exec playwright test --project=mocked
git diff --check
git status --short
```

Expected: all tests/builds pass; `git diff --check` is clean; the only unrelated worktree modification remains `server/.env.example`.

- [ ] **Step 6: Commit the regression coverage**

```bash
git add src/tests/report-layout-styles.test.ts e2e/dashboard.spec.ts
git commit -m "test: verify report stage density at 1920"
```

## Self-Review

- Spec coverage: top whitespace is covered by Task 2's two-row grid and reduced paddings; title orphan wrapping by Task 2's title areas and `text-wrap: balance`; chart fill and non-overlap by Task 3's style and browser assertions; subtitles by Task 1/2; pagination remains the unchanged existing path and is covered by the existing end-to-end and server suites.
- Placeholder scan: the plan contains no `TBD`, `TODO`, or incomplete implementation step.
- Type consistency: all selectors and component fields match the current files; `controller.subtitle`, `controller.message`, `controller.error`, and `controller.canNarrate` already exist on `NarrationController`.
- Scope: no schema, server, dependency, or data-flow changes are included because the requested issues are caused by the current presentation-layer geometry.
