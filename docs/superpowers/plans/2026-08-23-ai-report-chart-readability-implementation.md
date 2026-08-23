# AI 汇报大屏图表可读性与单行字幕 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 1920 × 1080 AI 汇报大屏中放大条形图、雷达图、环形图和组件文字，增加语义图标，并让字幕按语音进度逐句单行显示且不遮挡图形。

**Architecture:** 保留现有 React + D3 SVG 渲染和数据契约。新增一个纯函数字幕切分/时间映射模块，由讲解控制器使用播放器公开的总时长和播放位置更新当前提示词；图表通过更紧凑的 SVG viewBox 与桌面大屏 CSS 填满所在面板；图标继续使用内联线性 SVG，通过指标键和标签映射语义家族。

**Tech Stack:** React 19, TypeScript 5.9, D3 7, CSS container queries, Vitest, Testing Library, Playwright。

## Global Constraints

- 目标验收尺寸固定为 1920 × 1080；窄屏样式只维持现有兼容。
- 需要展示几个指标就展示几个指标；四列只表示一行列数，不限制指标总量。
- 条形图核心绘图区不小于 300 × 180 像素，雷达图有效直径不小于 220 像素，环形图外径不小于 200 像素。
- 单条字幕预算为 36 个全角字符，ASCII 字符按半角宽度计入；字幕始终单行且不使用省略号隐藏字符。
- 不新增外部图标依赖，不使用表情符号，不修改报告数据契约、指标计算、趋势末端圆点逻辑、证据抽屉内容或右侧对话行为。
- 不使用 `overflow: hidden` 隐藏图表内容；空间不足时继续使用现有确定性分页。
- 不修改或提交用户已有的 `server/.env.example` 变更。

---

### Task 1: Add pure single-line subtitle cue segmentation

**Files:**
- Create: `src/features/ai/report/narration-subtitle-cues.ts`
- Test: `src/tests/narration-subtitle-cues.test.ts`

**Interfaces:**
- Produces `splitSubtitleCues(text: string, maxUnits?: number): SubtitleCue[]` and `cueTextAtProgress(cues: readonly SubtitleCue[], progress: number): string` for Task 2.
- `SubtitleCue` is `{ text: string; start: number; end: number }`, with normalized `[0, 1]` intervals.

- [ ] **Step 1: Write the failing tests**

Add tests for punctuation-first splitting, hard width splitting, full character preservation, and progress lookup:

```ts
import { cueTextAtProgress, splitSubtitleCues } from '../features/ai/report/narration-subtitle-cues';

it('splits narration at Chinese sentence punctuation before applying the one-line budget', () => {
  const text = '出水水质得分最新值为96分，期间峰值为96分，出现在2025-08。电耗得分最新值为90分。';
  const cues = splitSubtitleCues(text, 36);

  expect(cues.map(({ text: cue }) => cue)).toEqual([
    '出水水质得分最新值为96分，期间峰值为96分，出现在2025-08。',
    '电耗得分最新值为90分。',
  ]);
  expect(cues.every(({ text: cue }) => cue.length > 0)).toBe(true);
  expect(cues.map(({ text: cue }) => cue).join('')).toBe(text);
});

it('splits an overlong phrase without dropping text or punctuation', () => {
  const text = '本页查看2025年8月9日至2026年8月9日的出水水质得分，共366个样本。';
  const cues = splitSubtitleCues(text, 18);

  expect(cues.map(({ text: cue }) => cue).join('')).toBe(text);
  expect(cues.every(({ text: cue }) => cue.length <= 18)).toBe(true);
});

it('maps normalized playback progress to exactly one visible cue', () => {
  const cues = splitSubtitleCues('第一句。第二句。第三句。', 36);

  expect(cueTextAtProgress(cues, 0)).toBe('第一句。');
  expect(cueTextAtProgress(cues, 0.5)).toBe('第二句。');
  expect(cueTextAtProgress(cues, 1)).toBe('第三句。');
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `CI=1 node node_modules/vitest/vitest.mjs run src/tests/narration-subtitle-cues.test.ts`

Expected: FAIL because `narration-subtitle-cues.ts` and its exported functions do not exist yet.

- [ ] **Step 3: Implement the minimal cue splitter**

Implement the following behavior in `narration-subtitle-cues.ts`:

```ts
export type SubtitleCue = { text: string; start: number; end: number };

export const DEFAULT_SUBTITLE_UNITS = 36;

export function splitSubtitleCues(text: string, maxUnits = DEFAULT_SUBTITLE_UNITS): SubtitleCue[] {
  const source = text.trim();
  if (!source) return [];
  const chunks = splitAtPreferredBoundaries(source, maxUnits);
  const totalUnits = Math.max(1, chunks.reduce((sum, chunk) => sum + displayUnits(chunk), 0));
  let consumed = 0;
  return chunks.map((chunk) => {
    const start = consumed / totalUnits;
    consumed += displayUnits(chunk);
    return { text: chunk, start, end: consumed / totalUnits };
  });
}

export function cueTextAtProgress(cues: readonly SubtitleCue[], progress: number): string {
  if (cues.length === 0) return '';
  const normalized = Math.max(0, Math.min(1, progress));
  return cues.find((cue, index) => normalized < cue.end || index === cues.length - 1)?.text ?? '';
}
```

`splitAtPreferredBoundaries` must prefer `。！？；.!?;`, then `，、：,: `, and finally hard-cut by `displayUnits`. `displayUnits` counts full-width/CJK characters as 1 and ASCII characters as 0.5, while preserving every source character in order.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `CI=1 node node_modules/vitest/vitest.mjs run src/tests/narration-subtitle-cues.test.ts`

Expected: 3 tests passed.

- [ ] **Step 5: Commit the cue module**

```bash
git add src/features/ai/report/narration-subtitle-cues.ts src/tests/narration-subtitle-cues.test.ts
git commit -m "feat: split narration into single-line subtitle cues"
```

### Task 2: Expose audio duration and synchronize subtitles with playback

**Files:**
- Modify: `src/features/ai/voice/audio-segment-player.ts`
- Modify: `src/features/ai/report/useNarrationController.ts`
- Modify: `src/tests/narration-controller.test.tsx`

**Interfaces:**
- `AudioSegmentPlayer` gains `durationMs(): number`; it returns the decoded speech duration after `play()` has decoded audio and `0` before that.
- `useNarrationController` consumes `splitSubtitleCues` and `cueTextAtProgress`, updating only the current cue while narration is speaking.

- [ ] **Step 1: Write the failing tests**

Add a controllable fake player to `narration-controller.test.tsx` and cover initial cue, progress cue, pause/resume stability, and offset recovery:

```ts
it('shows one subtitle cue at a time and advances it with audio progress', async () => {
  const player = createFakePlayer({ durationMs: 10_000, positionMs: 0 });
  const narration = renderNarration({ createPlayer: () => player, autoplay: true });

  await waitFor(() => expect(narration.result.current.subtitle).toBe('第一句。'));
  player.setPosition(6_000);
  await act(async () => { await vi.advanceTimersByTimeAsync(150); });

  expect(narration.result.current.subtitle).toBe('第二句。');
  expect(narration.result.current.subtitle).not.toContain('第三句。');
});

it('keeps the cue aligned when narration resumes from a saved offset', async () => {
  const player = createFakePlayer({ durationMs: 10_000, positionMs: 6_000 });
  const narration = renderNarration({
    createPlayer: () => player,
    initialCursor: { slideId: 'slide-1', segmentId: 'segment-1', offsetMs: 6_000 },
    autoplay: true,
  });

  await waitFor(() => expect(narration.result.current.subtitle).toBe('第二句。'));
});
```

The fake player must implement the real `AudioSegmentPlayer` contract, including `durationMs`, `positionMs`, `onEnded`, `pause`, `resume`, and `stop`; do not mock the cue splitter.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `CI=1 node node_modules/vitest/vitest.mjs run src/tests/narration-controller.test.tsx`

Expected: FAIL because the player lacks `durationMs` and the controller still renders the complete narration segment.

- [ ] **Step 3: Implement duration and cue synchronization**

In `WebAudioSegmentPlayer`, store the decoded total in the existing `speechDurationMs` field and return it through `durationMs()`. In `useNarrationController`:

1. Build cues from `segment.text` immediately when `startCursor` begins.
2. Set the first cue before audio resolves so the visual state is deterministic.
3. After `player.play()` resolves, run a 120ms interval while the active narration player is current. Compute `progress = positionMs() / durationMs()` and set `cueTextAtProgress(cues, progress)`.
4. Clear the interval in `releasePlayback`, on segment end, on pause, on stop, and on unmount.
5. Restart the interval after resume and use the existing cursor offset to select the correct cue.
6. Keep the existing `aria-live` status and error behavior unchanged.

The interval callback must guard `mountedRef`, `operationRef`, and `playbackRef` so stale audio cannot overwrite the subtitle of a later slide.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `CI=1 node node_modules/vitest/vitest.mjs run src/tests/narration-subtitle-cues.test.ts src/tests/narration-controller.test.tsx`

Expected: all cue and narration-controller tests pass.

- [ ] **Step 5: Commit the synchronization behavior**

```bash
git add src/features/ai/voice/audio-segment-player.ts src/features/ai/report/useNarrationController.ts src/tests/narration-controller.test.tsx
git commit -m "feat: sync single-line subtitles with narration progress"
```

### Task 3: Enlarge chart viewboxes and add semantic metric icon families

**Files:**
- Modify: `src/features/ai/report/visuals/ComparisonBarsVisual.tsx`
- Modify: `src/features/ai/report/visuals/RadarVisual.tsx`
- Modify: `src/features/ai/report/visuals/HealthRingVisual.tsx`
- Modify: `src/features/ai/report/visuals/ReportVisualIcon.tsx`
- Modify: `src/features/ai/report/visuals/DataDashboardVisual.tsx`
- Test: `src/tests/report-visuals.test.tsx`

**Interfaces:**
- `ReportVisualIcon` accepts optional `metricKey` and `metricLabel` props while keeping `kind` and `data-icon-kind` unchanged.
- The icon component exposes a stable `data-icon-family` attribute with values such as `water`, `energy`, `carbon`, `cost`, `health`, `flow`, `metric`, `trend`, `bars`, `radar`, and `dashboard`.

- [ ] **Step 1: Write the failing visual tests**

Add tests that assert the larger SVG coordinate systems and semantic families without depending on pixel snapshots:

```tsx
it('uses large-screen chart viewboxes for bars, radar, and ring visuals', () => {
  const { container: bars } = render(<VisualRenderer visual={visualFixture('comparison-bars')} mode="canvas" />);
  const { container: radar } = render(<VisualRenderer visual={visualFixture('radar')} mode="canvas" />);
  const { container: ring } = render(<VisualRenderer visual={visualFixture('health-ring')} mode="canvas" />);

  expect(bars.querySelector('.report-chart--bars')).toHaveAttribute('viewBox', '0 0 720 320');
  expect(radar.querySelector('.report-chart--radar')).toHaveAttribute('viewBox', '0 0 360 360');
  expect(ring.querySelector('.report-chart--ring')).toHaveAttribute('viewBox', '0 0 240 240');
});

it('uses distinct semantic icon families for metric cards', () => {
  const visual = dataDashboardFixture({ summaryMetrics: [
    metric('tn', '总氮', 2.4),
    metric('blowerKwh', '鼓风能耗', 128.4, 'kWh/d'),
    metric('carbon', '碳源消耗', 537.2, 'kg/d'),
    metric('savedCost', '节省费用', 18579, '元/d'),
  ] });
  const { container } = render(<VisualRenderer visual={visual} mode="canvas" />);

  expect([...container.querySelectorAll('.report-data-dashboard__metric .report-visual-icon')]
    .map((icon) => icon.getAttribute('data-icon-family')))
    .toEqual(['water', 'energy', 'carbon', 'cost']);
});
```

- [ ] **Step 2: Run the visual tests to verify they fail**

Run: `CI=1 node node_modules/vitest/vitest.mjs run src/tests/report-visuals.test.tsx`

Expected: FAIL because the current viewboxes are 640×250, 300×300, and 220×220, and all metric cards use the generic metric icon family.

- [ ] **Step 3: Implement larger chart coordinate systems and semantic icons**

Use these constants and preserve the current data behavior:

```ts
// ComparisonBarsVisual.tsx
const WIDTH = 720;
const HEIGHT = 320;

// RadarVisual.tsx
const SIZE = 360;
const CENTER = SIZE / 2;
const RADIUS = 138;

// HealthRingVisual.tsx
const ring = arc().innerRadius(82).outerRadius(104).cornerRadius(10);
// viewBox: 0 0 240 240, transform center: 120 120
```

Update coordinate margins and label positions so text remains inside the new viewboxes. Extend `ReportVisualIcon` with explicit semantic matching: compare the normalized metric key first, then normalized label tokens, then use `metric`. Keep every icon as inline SVG paths with the same stroke system; do not add a package.

- [ ] **Step 4: Run the visual tests to verify they pass**

Run: `CI=1 node node_modules/vitest/vitest.mjs run src/tests/report-visuals.test.tsx`

Expected: all existing visual tests plus the new viewbox and icon-family tests pass.

- [ ] **Step 5: Commit the chart and icon changes**

```bash
git add src/features/ai/report/visuals/ComparisonBarsVisual.tsx src/features/ai/report/visuals/RadarVisual.tsx src/features/ai/report/visuals/HealthRingVisual.tsx src/features/ai/report/visuals/ReportVisualIcon.tsx src/features/ai/report/visuals/DataDashboardVisual.tsx src/tests/report-visuals.test.tsx
git commit -m "feat: enlarge report charts and diversify metric icons"
```

### Task 4: Apply desktop readability and panel-fill styles

**Files:**
- Modify: `src/styles/ai.css`
- Modify: `src/features/ai/report/ReportSubtitleBar.tsx`
- Test: `src/tests/report-layout-styles.test.ts`
- Test: `src/tests/report-workspace.test.tsx`

**Interfaces:**
- Desktop styles use the existing report CSS classes and do not change the mobile grid contract.
- `ReportSubtitleBar` renders the current cue text directly; empty text remains empty and does not add placeholder copy.

- [ ] **Step 1: Write the failing style and component tests**

Add assertions for desktop typography, chart fill, semantic icon scale, one-line subtitle rules, and evidence-line clearance:

```ts
it('raises the desktop report readability scale without changing thumbnail sizing', () => {
  expect(css).toMatch(/\.report-data-dashboard__metric[^}]*padding:\s*\.85rem\s+1rem/iu);
  expect(css).toMatch(/\.report-data-dashboard__metric\s+strong[^}]*font:[^}]*1\.7rem/iu);
  expect(css).toMatch(/\.report-data-dashboard__panel-label[^}]*font-size:\s*\.94rem/iu);
  expect(css).toMatch(/\.report-visual-icon[^}]*width:\s*1\.25rem[^}]*height:\s*1\.25rem/iu);
});

it('keeps the desktop subtitle as one centered non-interactive line above evidence', () => {
  expect(css).toMatch(/\.report-subtitle-bar__text[^}]*white-space:\s*nowrap/iu);
  expect(css).toMatch(/\.report-subtitle-bar[^}]*bottom:\s*clamp\(3\.5rem/iu);
  expect(css).toMatch(/\.report-subtitle-bar[^}]*pointer-events:\s*none/iu);
});
```

Add a workspace assertion that the subtitle region contains the currently active short cue and no fallback placeholder.

- [ ] **Step 2: Run the focused style and workspace tests to verify they fail**

Run: `CI=1 node node_modules/vitest/vitest.mjs run src/tests/report-layout-styles.test.ts src/tests/report-workspace.test.tsx`

Expected: FAIL because current desktop labels, icons, chart labels, and subtitle positioning do not satisfy the larger-scale and one-line rules.

- [ ] **Step 3: Implement the desktop styles**

Within the desktop report rules:

1. Increase metric card padding, labels, values, units, and panel labels to the sizes in the approved spec.
2. Set `.report-data-dashboard .report-chart` to fill its visual cell, with per-kind desktop min sizes for bars, radar, and ring.
3. Set `.report-health-ring` to use the panel short edge with a `min(100%, 320px)` cap and size its label in proportion to the enlarged ring.
4. Increase `.report-chart__axis-label` and `.report-chart__value` while retaining the thumbnail overrides.
5. Increase `.report-visual-icon` to 20px on the desktop report and keep it smaller in thumbnails.
6. Change `.report-subtitle-bar__text` to the smaller approved desktop size, `white-space: nowrap`, and a `max-width` aligned with the canvas content. Raise the fixed bottom offset so the subtitle stays above the evidence drawer line.
7. Keep `pointer-events: none`, the transparent background, and visually hidden live status.

Do not add an overflow mask to chart panels. If a selector needs containment, apply it to the SVG/visual child after verifying its bounds.

- [ ] **Step 4: Run the focused style and workspace tests to verify they pass**

Run: `CI=1 node node_modules/vitest/vitest.mjs run src/tests/report-layout-styles.test.ts src/tests/report-workspace.test.tsx`

Expected: all focused style and workspace tests pass.

- [ ] **Step 5: Commit the desktop styles**

```bash
git add src/styles/ai.css src/features/ai/report/ReportSubtitleBar.tsx src/tests/report-layout-styles.test.ts src/tests/report-workspace.test.tsx
git commit -m "fix: improve report desktop readability"
```

### Task 5: Add 1920 × 1080 geometry and subtitle acceptance coverage

**Files:**
- Modify: `e2e/dashboard.spec.ts`
- Test data only: existing mocked report fixtures in `e2e/dashboard.spec.ts`

**Interfaces:**
- Reuse the existing mocked report stream and 1920 × 1080 test; do not create a separate 1280 × 800 page or test route.
- Geometry assertions read computed DOM bounds and do not depend on screenshot pixels.

- [ ] **Step 1: Add the final E2E acceptance assertions**

The radar minimum is already covered by the real SVG viewbox unit test in Task 3. In `streams a complete no-scroll dynamic report at 1920x1080`, collect the bounds of the bars, ring, evidence drawer, subtitle, and metric labels. Add assertions equivalent to:

```ts
expect(reportGeometry.chartSizes.bars.width).toBeGreaterThanOrEqual(300);
expect(reportGeometry.chartSizes.bars.height).toBeGreaterThanOrEqual(180);
expect(reportGeometry.chartSizes.radar.width).toBeGreaterThanOrEqual(220);
expect(reportGeometry.chartSizes.ring.width).toBeGreaterThanOrEqual(200);
expect(reportGeometry.subtitleLineCount).toBe(1);
expect(reportGeometry.subtitleWhiteSpace).toBe('nowrap');
expect(reportGeometry.subtitleBounds.bottom).toBeLessThanOrEqual(reportGeometry.evidenceBounds.top + 2);
expect(reportGeometry.subtitleBounds.left).toBeGreaterThanOrEqual(reportGeometry.canvasBounds.left - 1);
expect(reportGeometry.subtitleBounds.right).toBeLessThanOrEqual(reportGeometry.canvasBounds.right + 1);
expect(reportGeometry.metricLabelFontSize).toBeGreaterThanOrEqual(15);
expect(reportGeometry.metricValueFontSize).toBeGreaterThanOrEqual(28);
```

Also assert that metric icon family values include at least two distinct semantic families in this multi-metric dashboard.

- [ ] **Step 2: Run the mocked E2E to establish the integrated baseline**

Run: `node node_modules/playwright/cli.js test e2e/dashboard.spec.ts --project=mocked`

Expected: the complete 1920 × 1080 report test and the existing multi-page cases execute; if an assertion fails, the output identifies the exact geometry contract to correct in Step 3.

- [ ] **Step 3: Correct the exact geometry contract when baseline output identifies a gap**

Use the browser geometry output to apply only the corresponding bounded correction: if bars are below 300 × 180, increase the bars panel's visual cell or `.report-chart--bars` fill rule; if the ring is below 200px, increase the ring's `min(100%, 320px)` cap or its parent support row; if the subtitle bottom crosses the evidence top, increase the fixed subtitle `bottom` token; if a visual crosses its panel edge, correct the visual child sizing rather than adding an overflow mask. Keep every visual within its own panel and preserve the existing pagination behavior.

- [ ] **Step 4: Run the mocked E2E to verify all 1920 × 1080 cases pass**

Run: `node node_modules/playwright/cli.js test e2e/dashboard.spec.ts --project=mocked`

Expected: all mocked E2E cases pass, including the complete no-scroll report and multi-page report scenarios.

- [ ] **Step 5: Commit the acceptance coverage**

```bash
git add e2e/dashboard.spec.ts
git commit -m "test: verify report chart readability at 1920"
```

### Task 6: Final verification and local handoff

**Files:**
- No production files; preserve the user change in `server/.env.example`.

- [ ] **Step 1: Run focused regression tests**

Run:

```bash
CI=1 node node_modules/vitest/vitest.mjs run src/tests/narration-subtitle-cues.test.ts src/tests/narration-controller.test.tsx src/tests/report-visuals.test.tsx src/tests/report-layout-styles.test.ts src/tests/report-workspace.test.tsx
```

Expected: 0 failed tests.

- [ ] **Step 2: Run type checking, production build, and whitespace validation**

Run:

```bash
node node_modules/typescript/bin/tsc -b --pretty false
node node_modules/vite/bin/vite.js build
git diff --check HEAD~6..HEAD
```

Expected: TypeScript and Vite exit 0; `git diff --check` produces no output. The known large-chunk Vite advisory may remain.

- [ ] **Step 3: Run the final visual detector**

Run:

```bash
node /Users/xiaoshen001/.codex/skills/impeccable/scripts/detect.mjs --json --scope layout src/styles/ai.css
```

Expected: no new layout findings attributable to this change.

- [ ] **Step 4: Refresh and open the local page**

Keep the existing server at `http://127.0.0.1:5173/`, refresh the in-app browser, enter the local dashboard through its existing visual login, and verify that the 1920 × 1080 report view is visible without a test-sized route.

- [ ] **Step 5: Review the final worktree**

Run: `git status --short`

Expected: only the user-owned `server/.env.example` remains uncommitted; no secret values are printed or staged.
