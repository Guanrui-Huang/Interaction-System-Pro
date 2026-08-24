# Progressive Report Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open the final large-screen report canvas immediately and progressively clear real page modules from blurred structural placeholders after each whole slide becomes ready.

**Architecture:** Keep the existing outline and `slide.ready` server contract. Add a pending-slide renderer driven only by safe outline metadata, a client-only reveal state machine for ready slides, and stable reveal boundaries around heading, metrics, primary visual, supporting visuals, and evidence. `ReportWorkspace` always renders the rail/canvas shell during non-terminal creation, while restored ready reports bypass reveal animation.

**Tech Stack:** React 19, TypeScript 5.9, Vitest, Testing Library, GSAP 3, CSS container queries, Playwright.

## Global Constraints

- Do not add module-level server events or change shared report/evidence schemas.
- Do not display fabricated metric values, chart marks, labels, or conclusions in pending modules.
- Do not show visible “分析中”, “绘制中”, “等待生成”, or “生成中” copy inside the canvas or pending thumbnails.
- Keep the final large-screen layout fixed; revealing a module must not resize, translate, or reflow it.
- Reveal in this order: title/takeaway, metrics left-to-right, primary chart, supporting charts in rendered order, evidence-detail entry.
- A completed page renders fully clear on revisit and a restored ready report does not replay reveal.
- `prefers-reduced-motion: reduce` disables sweep motion and staged delays.
- Preserve clarification, retry, correction, narration, subtitles, evidence, and the approved chart/layout styling.
- Validate only the supported large-screen experience; do not add a 1280×800 test page.

---

## File Structure

- Create `src/features/ai/report/ReportPendingSlideView.tsx`: safe outline-derived canvas and thumbnail skeletons.
- Create `src/features/ai/report/useReportModuleReveal.ts`: pure reveal-plan builder plus timed React hook.
- Modify `src/features/ai/report/ReportSlideView.tsx`: expose heading, primary, and evidence reveal boundaries and coordinate existing chart motion.
- Modify `src/features/ai/report/visuals/VisualRenderer.tsx`: pass reveal state into dashboard visuals.
- Modify `src/features/ai/report/visuals/DataDashboardVisual.tsx`: expose metric, primary, and indexed support reveal boundaries.
- Modify `src/features/ai/report/ReportThumbnailRail.tsx`: render pending structural previews without visible status copy and support the pre-snapshot shell.
- Modify `src/features/ai/report/ReportWorkspace.tsx`: replace blocking generation branches with the persistent rail/canvas and run the reveal controller.
- Delete `src/features/ai/report/ReportGenerationStatus.tsx`: the blocking generation status is no longer part of normal creation.
- Modify `src/styles/ai.css`: pending geometry, contained blur, clear transition, scan effect, clarification overlay, reduced motion.
- Create `src/tests/report-pending-slide.test.tsx`: safe pending canvas and thumbnail structure coverage.
- Create `src/tests/report-module-reveal.test.tsx`: deterministic reveal order, timing, cleanup, restore, and reduced-motion coverage.
- Modify `src/tests/report-workspace.test.tsx`: creation, outline-only, pending thumbnails, integration, restore, and failure assertions.
- Modify `src/tests/app.test.tsx`: immediate application-level canvas assertion.
- Modify `e2e/dashboard.spec.ts`: mocked 1920×1080 creation and final-layout regression.

---

### Task 1: Safe pending page and thumbnail structures

**Files:**
- Create: `src/features/ai/report/ReportPendingSlideView.tsx`
- Modify: `src/styles/ai.css`
- Create: `src/tests/report-pending-slide.test.tsx`

**Interfaces:**
- Consumes: `SlideOutline` from `shared/report.ts`.
- Produces: `ReportPendingSlideView({ outline, mode }: { outline?: SlideOutline; mode: 'canvas' | 'thumbnail' })`.

- [ ] **Step 1: Write failing pending-component tests**

Create `src/tests/report-pending-slide.test.tsx` and render the component with and without real outline metadata:

```tsx
import { render, screen, within } from '@testing-library/react';
import type { SlideOutline } from '../../shared/report';
import { ReportPendingSlideView } from '../features/ai/report/ReportPendingSlideView';

const pendingOutline: SlideOutline = {
  id: 'slide-1', order: 0, title: '总氮与能耗综合分析', purpose: '说明关键变化',
  role: 'answer', layout: 'visual-focus', evidencePolicy: 'data', visualKind: 'trend-line',
  evidenceKeys: ['tn'], status: 'generating',
};

it('renders canvas and thumbnail structures without fabricated content', () => {
  const { container } = render(<>
    <ReportPendingSlideView mode="canvas" />
    <ReportPendingSlideView mode="thumbnail" />
  </>);

  expect(container.querySelector('[data-slide-state="pending"][data-slide-mode="canvas"]')).toBeInTheDocument();
  expect(container.querySelector('[data-slide-state="pending"][data-slide-mode="thumbnail"]')).toBeInTheDocument();
  expect(screen.queryByText('分析中')).not.toBeInTheDocument();
  expect(screen.queryByText(/\d+(?:\.\d+)?\s*(?:mg\/L|分|%)/u)).not.toBeInTheDocument();
});

it('uses only real outline metadata in the pending canvas', () => {
  const { container } = render(<ReportPendingSlideView outline={pendingOutline} mode="canvas" />);

  const canvas = container.querySelector('[data-slide-state="pending"][data-slide-mode="canvas"]');
  expect(canvas).not.toBeNull();
  expect(within(canvas as HTMLElement).getByRole('heading', { name: '总氮与能耗综合分析' })).toBeVisible();
  expect(canvas?.querySelectorAll('[data-pending-module]').length).toBeGreaterThanOrEqual(3);
  expect(within(canvas as HTMLElement).queryByText('生成中')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
pnpm test src/tests/report-pending-slide.test.tsx --run
```

Expected: FAIL because `ReportPendingSlideView.tsx` does not exist.

- [ ] **Step 3: Implement the pending slide component**

Create `ReportPendingSlideView.tsx` with this public shape and safe structure:

```tsx
import type { SlideOutline } from '../../../../shared/report';

type PendingMode = 'canvas' | 'thumbnail';

const dashboardKinds = new Set<SlideOutline['visualKind']>([
  'trend-line', 'trend-area', 'comparison-bars', 'health-ring', 'radar', 'scatter',
]);

function PendingBars({ count, className }: { count: number; className: string }) {
  return (
    <div className={className} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => <i key={index} />)}
    </div>
  );
}

export function ReportPendingSlideView({ outline, mode }: { outline?: SlideOutline; mode: PendingMode }) {
  const dashboard = outline ? dashboardKinds.has(outline.visualKind) : true;
  return (
    <section
      className={`report-pending-slide report-pending-slide--${mode}${dashboard ? ' report-pending-slide--dashboard' : ' report-pending-slide--atomic'}`}
      data-slide-id={outline?.id ?? 'pending-report'}
      data-slide-mode={mode}
      data-slide-state="pending"
      role={mode === 'canvas' ? 'region' : undefined}
      aria-label={mode === 'canvas' ? (outline ? `待完成页面：${outline.title}` : '待完成汇报页面') : undefined}
      aria-hidden={mode === 'thumbnail' || undefined}
    >
      <div className="report-pending-slide__guide" aria-hidden="true" />
      <header className="report-pending-slide__heading">
        {outline
          ? <h2>{outline.title}</h2>
          : <PendingBars count={1} className="report-pending-slide__title-placeholder" />}
        <PendingBars count={2} className="report-pending-slide__takeaway" />
      </header>
      <div className="report-pending-slide__visual" aria-hidden="true">
        {dashboard && <PendingBars count={4} className="report-pending-slide__metrics" />}
        <div className="report-pending-slide__chart" data-pending-module="primary"><i /><i /><i /><i /><i /></div>
        {dashboard && (
          <div className="report-pending-slide__support">
            <div data-pending-module="support-1"><i /><i /><i /></div>
            <div data-pending-module="support-2"><i /><i /><i /></div>
          </div>
        )}
      </div>
      {mode === 'canvas' && <div className="report-pending-slide__evidence" data-pending-module="evidence" aria-hidden="true"><i /></div>}
    </section>
  );
}
```

Add contained pending styles under the existing report slide styles. Use the existing canvas dimensions and color tokens:

```css
.report-pending-slide { position: relative; display: grid; height: 100%; min-height: 0; box-sizing: border-box; overflow: clip; border: 1px solid rgb(92 158 177 / 18%); background: linear-gradient(145deg, rgb(18 38 51 / 89%), rgb(7 19 27 / 95%)); }
.report-pending-slide--canvas { grid-template-areas: "heading" "visual" "evidence"; grid-template-rows: auto minmax(0, 1fr) auto; gap: .75rem; padding: 14px; }
.report-pending-slide__guide { position: absolute; inset: 0 auto 0 0; width: 2px; background: var(--report-cyan); box-shadow: 0 0 14px rgb(44 228 245 / 54%); }
.report-pending-slide__heading { grid-area: heading; min-width: 0; }
.report-pending-slide__heading h2 { margin: 0; color: #f3fcfd; font-size: clamp(28px, 4cqw, 58px); line-height: 1.08; }
.report-pending-slide__visual { grid-area: visual; display: grid; grid-template: "metrics metrics" auto "primary support" minmax(0, 1fr) / minmax(0, 1.7fr) minmax(18rem, 1fr); gap: .75rem; min-height: 0; }
.report-pending-slide__metrics { grid-area: metrics; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .3rem; }
.report-pending-slide__metrics i { min-height: 4.8rem; border: 1px solid rgb(111 175 192 / 16%); background: rgb(15 47 60 / 48%); }
.report-pending-slide__chart { grid-area: primary; display: flex; align-items: end; justify-content: space-around; min-height: 0; padding: 10%; border: 1px solid rgb(111 175 192 / 16%); }
.report-pending-slide__chart i { width: 11%; height: var(--pending-height, 58%); background: linear-gradient(180deg, rgb(44 228 245 / 48%), rgb(35 239 177 / 12%)); }
.report-pending-slide__chart i:nth-child(2) { --pending-height: 76%; }
.report-pending-slide__chart i:nth-child(3) { --pending-height: 44%; }
.report-pending-slide__chart i:nth-child(4) { --pending-height: 68%; }
.report-pending-slide__chart i:nth-child(5) { --pending-height: 52%; }
.report-pending-slide__support { grid-area: support; display: grid; grid-template-rows: repeat(2, minmax(0, 1fr)); gap: .75rem; min-height: 0; }
.report-pending-slide__support > div { display: flex; align-items: end; justify-content: space-evenly; min-height: 0; padding: 12%; border: 1px solid rgb(111 175 192 / 16%); }
.report-pending-slide__support i { width: 22%; height: 58%; background: rgb(170 86 240 / 26%); }
.report-pending-slide__takeaway, .report-pending-slide__title-placeholder { display: grid; gap: .35rem; width: min(62%, 44rem); margin-top: .55rem; }
.report-pending-slide__takeaway i, .report-pending-slide__title-placeholder i, .report-pending-slide__evidence i { display: block; height: .75rem; background: rgb(125 176 190 / 22%); }
.report-pending-slide__takeaway i:last-child { width: 64%; }
.report-pending-slide__evidence { grid-area: evidence; min-height: 1.8rem; border-top: 1px solid rgb(44 228 245 / 18%); }
.report-pending-slide__evidence i { width: 9rem; margin-top: .55rem; }
.report-pending-slide [data-pending-module], .report-pending-slide__metrics, .report-pending-slide__takeaway, .report-pending-slide__title-placeholder { filter: blur(8px); opacity: .46; animation: report-pending-breathe 1.8s ease-in-out infinite alternate; }
.report-pending-slide--thumbnail { min-height: 116px; padding: 22px 8px 8px; }
.report-pending-slide--thumbnail .report-pending-slide__heading { display: none; }
.report-pending-slide--thumbnail .report-pending-slide__visual { grid-template: "primary" 1fr / 1fr; }
.report-pending-slide--thumbnail .report-pending-slide__metrics, .report-pending-slide--thumbnail .report-pending-slide__support { display: none; }
@keyframes report-pending-breathe { from { opacity: .34; } to { opacity: .54; } }
@media (prefers-reduced-motion: reduce) { .report-pending-slide [data-pending-module], .report-pending-slide__metrics, .report-pending-slide__takeaway, .report-pending-slide__title-placeholder { animation: none; } }
```

- [ ] **Step 4: Run the focused tests and verify pass**

Run:

```bash
pnpm test src/tests/report-pending-slide.test.tsx --run
```

Expected: PASS for both safe-structure tests.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/features/ai/report/ReportPendingSlideView.tsx src/styles/ai.css src/tests/report-pending-slide.test.tsx
git commit -m "feat: add blurred report page structures"
```

---

### Task 2: Deterministic module reveal state machine

**Files:**
- Create: `src/features/ai/report/useReportModuleReveal.ts`
- Create: `src/tests/report-module-reveal.test.tsx`

**Interfaces:**
- Consumes: `ReportSlide | undefined`, `immediate: boolean`, `onComplete(slideId: string): void`.
- Produces: `ReportRevealModule`, `reportRevealPlan(slide)`, and `useReportModuleReveal(options)` returning `{ revealedModules, progressive }`.

- [ ] **Step 1: Write failing reveal-plan and hook tests**

Create `src/tests/report-module-reveal.test.tsx` using `renderHook`, fake timers, and a dashboard slide with metrics plus two support visuals. Assert this exact order:

```tsx
expect(reportRevealPlan(dashboardSlide)).toEqual([
  'heading', 'metrics', 'primary', 'support-0', 'support-1', 'evidence',
]);
```

Stub `matchMedia` to return `matches: false` for the timed tests so jsdom exercises progressive mode rather than the reduced-motion fallback.

Add timed assertions:

```tsx
vi.useFakeTimers();
const onComplete = vi.fn();
const { result, unmount } = renderHook(() => useReportModuleReveal({
  slide: dashboardSlide,
  immediate: false,
  onComplete,
}));

expect([...result.current.revealedModules]).toEqual(['heading']);
await act(async () => vi.advanceTimersByTimeAsync(320));
expect(result.current.revealedModules.has('metrics')).toBe(true);
await act(async () => vi.advanceTimersByTimeAsync(420));
expect(result.current.revealedModules.has('primary')).toBe(true);
await act(async () => vi.advanceTimersByTimeAsync(300));
expect(result.current.revealedModules.has('support-0')).toBe(true);
await act(async () => vi.advanceTimersByTimeAsync(300));
expect(result.current.revealedModules.has('support-1')).toBe(true);
await act(async () => vi.advanceTimersByTimeAsync(240));
expect(result.current.revealedModules.has('evidence')).toBe(true);
expect(onComplete).toHaveBeenCalledWith(dashboardSlide.id);
unmount();
```

Also test:

- atomic slides produce `['heading', 'primary', 'evidence']`;
- `immediate: true` returns the complete set on the first render;
- reduced motion returns the complete set on the first render;
- unmount cancels remaining timers and never calls `onComplete` afterward.

- [ ] **Step 2: Run the new test and verify failure**

Run:

```bash
pnpm test src/tests/report-module-reveal.test.tsx --run
```

Expected: FAIL because `useReportModuleReveal.ts` does not exist.

- [ ] **Step 3: Implement the reveal plan and hook**

Create `useReportModuleReveal.ts` with these exported types and timing rules:

```ts
import { useEffect, useMemo, useState } from 'react';
import type { ReportSlide } from '../../../../shared/report';

export type ReportRevealModule = 'heading' | 'metrics' | 'primary' | `support-${number}` | 'evidence';

const gapBeforeModule = (module: ReportRevealModule): number => {
  if (module === 'metrics') return 320;
  if (module === 'primary') return 420;
  if (module.startsWith('support-')) return 300;
  return 240;
};

export function reportRevealPlan(slide: ReportSlide): ReportRevealModule[] {
  if (slide.visual.kind !== 'data-dashboard') return ['heading', 'primary', 'evidence'];
  return [
    'heading',
    ...(slide.visual.summaryMetrics.length > 0 ? ['metrics' as const] : []),
    'primary',
    ...slide.visual.supporting.map((_, index) => `support-${index}` as const),
    'evidence',
  ];
}

function reducedMotionRequested(): boolean {
  return typeof window.matchMedia !== 'function'
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useReportModuleReveal({ slide, immediate, onComplete }: {
  slide?: ReportSlide;
  immediate: boolean;
  onComplete(slideId: string): void;
}) {
  const plan = useMemo(() => slide ? reportRevealPlan(slide) : [], [slide]);
  const planKey = plan.join('|');
  const slideId = slide?.id;
  const reduced = reducedMotionRequested();
  const [visibleCount, setVisibleCount] = useState(() => immediate || reduced ? plan.length : Math.min(1, plan.length));

  useEffect(() => {
    if (!slideId) {
      setVisibleCount(0);
      return undefined;
    }
    if (immediate || reduced) {
      setVisibleCount(plan.length);
      onComplete(slideId);
      return undefined;
    }
    setVisibleCount(Math.min(1, plan.length));
    let elapsed = 0;
    const timers = plan.slice(1).map((module, index) => {
      elapsed += gapBeforeModule(module);
      return window.setTimeout(() => {
        const nextCount = index + 2;
        setVisibleCount(nextCount);
        if (nextCount === plan.length) onComplete(slideId);
      }, elapsed);
    });
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [immediate, onComplete, plan.length, planKey, reduced, slideId]);

  const revealedModules = useMemo(
    () => new Set<ReportRevealModule>(plan.slice(0, visibleCount)),
    [planKey, visibleCount],
  );
  return { revealedModules, progressive: Boolean(slide && !immediate && !reduced) };
}
```

Add a test that rerenders an equivalent republished slide object with the same ID and reveal plan and verifies that visible modules do not reset.

- [ ] **Step 4: Run the reveal tests and verify pass**

Run:

```bash
pnpm test src/tests/report-module-reveal.test.tsx --run
```

Expected: PASS with all timer, cleanup, restore, atomic, and reduced-motion cases.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/features/ai/report/useReportModuleReveal.ts src/tests/report-module-reveal.test.tsx
git commit -m "feat: add report module reveal controller"
```

---

### Task 3: Connect real slide modules to contained blur and reveal

**Files:**
- Modify: `src/features/ai/report/ReportSlideView.tsx`
- Modify: `src/features/ai/report/visuals/VisualRenderer.tsx`
- Modify: `src/features/ai/report/visuals/DataDashboardVisual.tsx`
- Modify: `src/styles/ai.css`
- Test: `src/tests/report-workspace.test.tsx`

**Interfaces:**
- Consumes: `ReadonlySet<ReportRevealModule> | undefined`; `undefined` means a fully visible non-progressive page.
- Produces: `data-reveal-module`, `data-reveal-visible`, and `data-reveal-index` markers without changing visual data semantics.

- [ ] **Step 1: Write failing reveal-boundary tests**

Add a dashboard fixture with two summary metrics and two supporting visuals. Render `ReportSlideView` with only `new Set(['heading'])` and assert:

```tsx
expect(container.querySelector('[data-reveal-module="heading"]')).toHaveAttribute('data-reveal-visible', 'true');
expect(container.querySelector('[data-reveal-module="metrics"]')).toHaveAttribute('data-reveal-visible', 'false');
expect(container.querySelector('[data-reveal-module="primary"]')).toHaveAttribute('data-reveal-visible', 'false');
expect(container.querySelector('[data-reveal-module="support-0"]')).toHaveAttribute('data-reveal-visible', 'false');
expect(container.querySelector('[data-reveal-module="support-1"]')).toHaveAttribute('data-reveal-visible', 'false');
expect(container.querySelector('[data-reveal-module="evidence"]')).toHaveAttribute('data-reveal-visible', 'false');
expect(container.querySelector('[data-reveal-module="metrics"]')).toHaveAttribute('aria-hidden', 'true');
expect(container.querySelector('[data-reveal-module="evidence"]')).toHaveAttribute('inert');
```

Rerender with the full plan set and assert every marker is `data-reveal-visible="true"`, the evidence button is focusable, and the component dimensions/classes do not change.

- [ ] **Step 2: Run the focused workspace test and verify failure**

Run:

```bash
pnpm test src/tests/report-workspace.test.tsx --run
```

Expected: FAIL because the reveal props and markers are not implemented.

- [ ] **Step 3: Add shared reveal props to slide and visual components**

In `ReportSlideView.tsx`, add:

```tsx
import type { ReportRevealModule } from './useReportModuleReveal';

type RevealProps = {
  'data-reveal-module': ReportRevealModule;
  'data-reveal-visible': 'true' | 'false';
  'aria-hidden'?: true;
  inert?: true;
};

function revealProps(modules: ReadonlySet<ReportRevealModule> | undefined, module: ReportRevealModule): RevealProps {
  const visible = modules === undefined || modules.has(module);
  return {
    'data-reveal-module': module,
    'data-reveal-visible': String(visible) as 'true' | 'false',
    ...(!visible ? { 'aria-hidden': true, inert: true } : {}),
  };
}
```

Extend `ReportSlideViewProps` with:

```ts
revealedModules?: ReadonlySet<ReportRevealModule>;
```

Mark the heading, atomic primary visual, and a stable wrapper around `ReportEvidenceDrawer`. For data-dashboard pages, pass `revealedModules` through `VisualRenderer` and do not blur the outer visual wrapper. Start `useReportSlideMotion` only when `primary` is visible:

```tsx
const primaryVisible = revealedModules === undefined || revealedModules.has('primary');
useReportSlideMotion(rootRef, slide.visual.kind, active && mode === 'canvas' && primaryVisible, animate, onFirstActivation);
```

In `VisualRenderer.tsx`, extend the props and pass the set only to `DataDashboardVisual`:

```tsx
export function VisualRenderer({ visual, mode, revealedModules }: {
  visual: VisualSpec;
  mode: VisualMode;
  revealedModules?: ReadonlySet<ReportRevealModule>;
}) {
  const content = visual.kind === 'data-dashboard'
    ? <DataDashboardVisual visual={visual} mode={mode} revealedModules={revealedModules} />
    : <AtomicVisualRenderer visual={visual} mode={mode} />;
  return <div className={`report-visual-renderer report-visual-renderer--${mode}`} data-visual-kind={visual.kind}>{content}</div>;
}
```

In `DataDashboardVisual.tsx`, mark the summary `<dl>`, primary `<section>`, and each support `<section>` with the same reveal attributes. Add `style={{ '--report-reveal-index': index } as CSSProperties}` to metric cards so the clear transition can stagger left-to-right without changing layout.

- [ ] **Step 4: Add contained real-module blur and clear styles**

Add:

```css
[data-reveal-module] { position: relative; min-width: 0; overflow: clip; transition: filter .4s ease, opacity .4s ease; }
[data-reveal-module][data-reveal-visible="false"] { filter: blur(10px) saturate(.45); opacity: .34; pointer-events: none; user-select: none; }
[data-reveal-module][data-reveal-visible="false"]::after { content: ""; position: absolute; z-index: 8; inset: 0; background: linear-gradient(110deg, rgb(9 28 38 / 78%), rgb(25 65 76 / 62%), rgb(9 28 38 / 78%)); backdrop-filter: blur(8px); }
.report-slide--progressive [data-reveal-module][data-reveal-visible="true"] { animation: report-module-clear .42s ease both; }
.report-slide--progressive [data-reveal-module="metrics"][data-reveal-visible="true"] .report-data-dashboard__metric { animation: report-module-clear .34s ease both; animation-delay: calc(var(--report-reveal-index, 0) * 80ms); }
@keyframes report-module-clear { from { opacity: .42; filter: blur(8px) saturate(.6); } to { opacity: 1; filter: none; } }
@media (prefers-reduced-motion: reduce) { .report-slide--progressive [data-reveal-module][data-reveal-visible="true"], .report-slide--progressive [data-reveal-module="metrics"][data-reveal-visible="true"] .report-data-dashboard__metric { animation: none; } }
```

Set `report-slide--progressive` only when `revealedModules` is supplied. Ensure every reveal wrapper clips its pseudo-element and that the pseudo-element never crosses a component border.

- [ ] **Step 5: Run component and motion tests**

Run:

```bash
pnpm test src/tests/report-workspace.test.tsx src/tests/dashboard-motion.test.tsx --run
```

Expected: PASS; GSAP still reaches `data-slide-motion-state="final"`, reduced motion remains final, and reveal markers match the supplied set.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/features/ai/report/ReportSlideView.tsx src/features/ai/report/visuals/VisualRenderer.tsx src/features/ai/report/visuals/DataDashboardVisual.tsx src/styles/ai.css src/tests/report-workspace.test.tsx
git commit -m "feat: progressively reveal report modules"
```

---

### Task 4: Replace blocking generation with the persistent workspace

**Files:**
- Modify: `src/features/ai/report/ReportWorkspace.tsx`
- Modify: `src/features/ai/report/ReportThumbnailRail.tsx`
- Delete: `src/features/ai/report/ReportGenerationStatus.tsx`
- Modify: `src/styles/ai.css`
- Modify: `src/tests/report-workspace.test.tsx`
- Modify: `src/tests/app.test.tsx`

**Interfaces:**
- Consumes: `ReportPendingSlideView`, `useReportModuleReveal`, existing `ReportSession` and `ReportJobSnapshot`.
- Produces: persistent rail/canvas rendering for null, outline-only, partially ready, ready, clarification, and retry states.

- [ ] **Step 1: Rewrite the old pending-state tests to the approved behavior**

Replace assertions that require `ReportGenerationStatus`, visible “等待生成”/“生成中” thumbnail copy, or zero thumbnails/canvases. Assert instead:

```tsx
expect(screen.getByRole('main', { name: 'AI 动态汇报工作区' })).toBeInTheDocument();
expect(container.querySelector('.report-thumbnail-rail')).not.toBeNull();
expect(container.querySelector('[data-slide-state="pending"][data-slide-mode="canvas"]')).not.toBeNull();
expect(screen.queryByText('正在生成首个页面')).not.toBeInTheDocument();
expect(screen.queryByText('等待生成', { exact: true })).not.toBeInTheDocument();
expect(screen.queryByText('生成中', { exact: true })).not.toBeInTheDocument();
```

Keep the accessible button-name assertions:

```tsx
expect(screen.getByRole('button', { name: '第 2 页，能耗对比，生成中' })).toHaveAttribute('aria-disabled', 'true');
expect(screen.getByRole('button', { name: '第 2 页，能耗对比，等待生成' })).toHaveAttribute('aria-disabled', 'true');
```

Add fake-timer integration coverage that rerenders outline-only state to ready state, checks the stage sequence, advances through completion, navigates away/back, and verifies the page is immediately clear on revisit.

- [ ] **Step 2: Run workspace and app tests and verify failure**

Run:

```bash
pnpm test src/tests/report-workspace.test.tsx src/tests/app.test.tsx --run
```

Expected: FAIL because normal creation still branches to blocking status content and pending thumbnails still show visible status text.

- [ ] **Step 3: Make `ReportThumbnailRail` render the pre-snapshot shell and structural pending previews**

Change `snapshot` to `ReportJobSnapshot | null`. For `snapshot === null`, render one decorative pending list item containing `ReportPendingSlideView mode="thumbnail"`; do not render a selection button. For outline items without a ready slide, replace `.report-thumbnail__pending` with:

```tsx
<ReportPendingSlideView outline={item} mode="thumbnail" />
```

Keep `statusText` only for `selectionLabel`, retry behavior, `aria-disabled`, and screen-reader-only content. Remove visible `<em>{statusText[item.status]}</em>` output.

- [ ] **Step 4: Restructure `ReportWorkspace` to always render the report stage**

Track reveals per report and seed only slides restored without a launch question. This makes restored pages immediately clear while allowing pages created in the current live request to reveal once:

```tsx
const revealReportId = useRef<string>();
const revealedSlides = useRef(new Set<string>());
if (snapshot?.reportId && revealReportId.current !== snapshot.reportId) {
  revealReportId.current = snapshot.reportId;
  revealedSlides.current.clear();
  if (!launchQuestion) snapshot.slides.forEach(({ id }) => revealedSlides.current.add(id));
}
const markRevealComplete = useCallback((slideId: string) => { revealedSlides.current.add(slideId); }, []);
```

Select a safe outline for the pending canvas:

```tsx
const orderedOutlines = useMemo(
  () => snapshot ? [...snapshot.outline].sort((left, right) => left.order - right.order) : [],
  [snapshot],
);
const pendingOutline = orderedOutlines.find(({ id }) => id === requestedActive) ?? orderedOutlines[0];
```

Call the reveal hook unconditionally:

```tsx
const reveal = useReportModuleReveal({
  slide: activeSlide,
  immediate: Boolean(activeSlide && revealedSlides.current.has(activeSlide.id)),
  onComplete: markRevealComplete,
});
```

Replace the `awaiting-clarification`, pre-first-slide generation, snapshot-ready, and no-snapshot loading branches with one persistent stage for all non-error states:

```tsx
mainContent = (
  <>
    <ReportThumbnailRail
      snapshot={snapshot}
      activeSlideId={activeSlide?.id ?? pendingOutline?.id}
      playingSlideId={session.playingSlideId ?? (narration.status === 'speaking' ? narration.activeSlideId : undefined)}
      onSelect={selectThumbnail}
      onRetry={session.retrySlide}
    />
    <section className="report-workspace__canvas" aria-label="流式汇报画布">
      {activeSlide
        ? <ReportSlideView
            key={activeSlide.id}
            slide={activeSlide}
            mode="canvas"
            active
            animate={!animatedSlides.current.has(activeSlide.id)}
            revealedModules={reveal.progressive ? reveal.revealedModules : undefined}
            onFirstActivation={() => markAnimated(activeSlide)}
          />
        : snapshot && snapshot.slides.length > 0 && !firstPlayableSlide && !['generating', 'awaiting-clarification'].includes(snapshot.status)
          ? <div className="report-workspace__empty" role="status"><i aria-hidden="true" /><p>当前没有可播放的有效页面</p><span>页面更正关系异常，请刷新汇报或稍后重试。</span></div>
          : <ReportPendingSlideView outline={pendingOutline} mode="canvas" />}
      {snapshot?.status === 'awaiting-clarification' && snapshot.clarification && (
        <div className="report-workspace__clarification-overlay">
          <ReportClarification key={snapshot.clarification.clarificationId} request={snapshot.clarification} onSubmit={session.submitClarification} />
        </div>
      )}
    </section>
    {snapshot && <ReportSubtitleBar controller={narration} />}
    <p className="sr-only" role="status" aria-live="polite">
      {activeSlide ? `第 ${activeSlide.order + 1} 页已完成` : pendingOutline ? `第 ${pendingOutline.order + 1} 页正在生成` : '汇报页面结构已建立'}
    </p>
  </>
);
```

Preserve the existing terminal/non-terminal error branch, correction button, empty-invalid-correction fallback, chat panel, and navigation bounds. A clarification overlay must not hide the rail and must retain keyboard focus behavior.

- [ ] **Step 5: Remove obsolete blocking status code and style the clarification overlay**

Delete `ReportGenerationStatus.tsx`, remove its import, and remove `.report-generation-status`, normal `.report-workspace__loading`, and normal `.report-workspace__pending` styles that no longer have callers. Keep `.report-workspace__error` intact.

Add:

```css
.report-workspace__clarification-overlay { position: absolute; z-index: 10; inset: 0; display: grid; place-items: center; padding: clamp(1.25rem, 4vw, 4rem); background: rgb(7 19 27 / 64%); backdrop-filter: blur(5px); }
```

- [ ] **Step 6: Run integration-level unit tests**

Run:

```bash
pnpm test src/tests/report-module-reveal.test.tsx src/tests/report-workspace.test.tsx src/tests/app.test.tsx src/tests/narration-controller.test.tsx --run
```

Expected: PASS. The canvas appears immediately, pending thumbnails contain no visible generation status, ready modules reveal once, restored pages are clear, and narration logic is unchanged.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/features/ai/report/ReportWorkspace.tsx src/features/ai/report/ReportThumbnailRail.tsx src/features/ai/report/ReportGenerationStatus.tsx src/styles/ai.css src/tests/report-workspace.test.tsx src/tests/app.test.tsx
git commit -m "feat: open report canvas during generation"
```

---

### Task 5: Large-screen mocked flow and visual regression

**Files:**
- Modify: `e2e/dashboard.spec.ts`
- Modify: `src/tests/report-workspace.test.tsx`

**Interfaces:**
- Consumes: final DOM markers from Tasks 1–4.
- Produces: automated proof of the 1920×1080 progressive experience and no layout overlap.

- [ ] **Step 1: Update the mocked E2E creation assertions**

In `keeps eight metrics and auxiliary labels readable at 1920x1080`, replace old loading assertions with:

```ts
await expect(page.getByRole('main', { name: 'AI 动态汇报工作区' })).toBeVisible();
await expect(page.locator('[data-slide-state="pending"][data-slide-mode="canvas"]')).toBeVisible();
await expect(page.locator('[data-slide-state="pending"][data-slide-mode="thumbnail"]')).toBeVisible();
await expect(page.getByText('正在生成首个页面', { exact: true })).toHaveCount(0);
await expect(page.getByText('等待生成', { exact: true })).toHaveCount(0);
await expect(page.getByText('生成中', { exact: true })).toHaveCount(0);
```

After `api.releaseTerminal()`, wait for the active page to reach a fully clear state before geometric assertions:

```ts
const activeCanvas = page.locator('[data-slide-mode="canvas"]:not([data-slide-state="pending"])');
await expect(activeCanvas).toBeVisible();
await expect(activeCanvas.locator('[data-reveal-visible="false"]')).toHaveCount(0, { timeout: 5_000 });
```

Retain the existing 1920×1080 metric count, label size, chart size, evidence-line, overlap, and screenshot assertions.

- [ ] **Step 2: Add reduced-motion browser coverage**

Use Playwright emulation before launch:

```ts
await page.emulateMedia({ reducedMotion: 'reduce' });
```

Assert the pending structure is static, then release the terminal stream and verify the ready canvas immediately has no `[data-reveal-visible="false"]` nodes and no `report-module-clear` animation dependency.

- [ ] **Step 3: Run the mocked E2E project**

Run:

```bash
pnpm test:e2e:mocked
```

Expected: all mocked Playwright tests PASS; the progressive-report test runs only at the supported large-screen viewport.

- [ ] **Step 4: Inspect the real local page at large-screen size**

Run the existing local application, create a report, and inspect these checkpoints at 1920×1080:

1. immediate no-snapshot canvas shell;
2. outline title plus blurred module structure;
3. title and takeaway clear;
4. metrics clear left-to-right;
5. primary chart clear;
6. support charts clear without crossing component borders;
7. evidence entry clear and subtitles remain below the evidence line;
8. revisit completed page with no replay.

Capture one pending and one completed screenshot as test artifacts. Reject the implementation if any module shifts size, blur crosses a border, text becomes readable before its module clears, or later-page completion steals focus.

- [ ] **Step 5: Commit Task 5**

```bash
git add e2e/dashboard.spec.ts src/tests/report-workspace.test.tsx
git commit -m "test: cover progressive report generation"
```

---

### Task 6: Full verification and integration readiness

**Files:**
- Verify only; fix files only when a failing check identifies a feature regression.

**Interfaces:**
- Consumes: all Task 1–5 commits.
- Produces: evidence that the feature is ready to merge or push without including unrelated workspace changes.

- [ ] **Step 1: Run formatting and diff checks**

```bash
git diff --check main...HEAD
git status --short
```

Expected: no whitespace errors. Existing unrelated `.superpowers/sdd/task-1-report.md`, `server/.env.example`, and `.DS_Store` changes remain unstaged and untouched if still present.

- [ ] **Step 2: Run the complete frontend and server unit suite**

```bash
pnpm test --run
```

Expected: all feature-related tests PASS. If the repository still reports the three documented baseline failures, verify they are exactly the two missing TN artifact cases and the existing Playwright command-contract mismatch before treating them as unrelated.

- [ ] **Step 3: Run the production build**

```bash
pnpm run build
```

Expected: TypeScript project references and Vite production build PASS with no new warnings attributable to the feature.

- [ ] **Step 4: Run the mocked large-screen E2E suite once more**

```bash
pnpm test:e2e:mocked
```

Expected: all mocked tests PASS.

- [ ] **Step 5: Review the final commit range**

```bash
git log --oneline --decorate main..HEAD
git diff --stat main...HEAD
git diff --name-status main...HEAD
```

Expected: only the planned report frontend, tests, styles, and plan/spec files are present. No environment file, user task record, generated screenshot, or `.DS_Store` is included.

- [ ] **Step 6: Request code review before integration**

Use the `requesting-code-review` skill against the final commit range. Resolve all correctness findings, rerun the affected focused tests, then rerun Steps 1–4 before claiming completion.
