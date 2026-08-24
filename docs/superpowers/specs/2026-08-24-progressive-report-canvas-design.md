# Progressive Report Canvas Design

**Date:** 2026-08-24

**Status:** Approved for implementation

**Scope:** AI-generated HTML report presentation only

## 1. Goal

Replace the blocking pre-report states (for example, “正在组织分析” and “正在生成首个页面”) with an immediate report-canvas experience. The user should enter the final large-screen report workspace as soon as generation starts and see the page take shape in place, similarly to the progressive presentation used by AI slide-generation products.

The implementation will preserve the current server-side whole-slide generation contract. It will use the outline and existing `slide.ready` event to provide a stable blurred page structure first, then progressively reveal the real slide modules on the client.

## 2. Confirmed Experience

1. Enter the report workspace immediately after the user starts generation.
2. Keep the final large-screen page dimensions and layout stable from the beginning.
3. Represent unfinished modules with blurred structural placeholders.
4. Do not show “分析中”, “绘制中”, or similar generation-status copy inside the canvas.
5. Never show fabricated metric values, labels, chart lines, or conclusions in unfinished modules.
6. Reveal real content in this order:
   - title and takeaway;
   - summary metric cards, from left to right;
   - primary chart;
   - supporting charts, in their rendered order;
   - evidence-detail entry.
7. Keep later pages visible as blurred thumbnails while they are planned or generating.
8. Do not steal focus from the page the user is currently viewing when later pages finish.
9. A page that has already completed its reveal must render fully clear on revisit and must not replay the sequence.

## 3. Current-State Constraint

The current report stream publishes page-level events:

- `report.outline` supplies page titles, order, layout, role, and visual kind;
- `slide.generating` marks a whole page as generating;
- `slide.ready` supplies the complete `ReportSlide` payload.

There are no module-level server events. Therefore the proposed experience is a client-side progressive presentation, not a claim that the backend has independently completed each module. Before `slide.ready`, the canvas shows only safe structural placeholders derived from the report outline. After `slide.ready`, the real modules are revealed in sequence.

This keeps the report/evidence contract unchanged and avoids partial or internally inconsistent page payloads.

## 4. Workspace State Flow

### 4.1 Creating before a snapshot exists

The workspace header, thumbnail rail shell, final canvas frame, conversation panel, and subtitle footprint render immediately. The centered `ReportGenerationStatus` and `report-workspace__loading` presentation are not used for normal creation.

Because no outline exists yet, the canvas uses a neutral dashboard skeleton made only of blurred geometric blocks. It contains no generated title, metric names, values, or chart marks.

### 4.2 Outline available, first page not ready

The first outline page becomes the selected canvas page. Its real outline title may be displayed because it is already part of the server response. The expected page composition is inferred from the outline layout and visual kind; all unknown content remains blurred.

Planned and generating pages appear in the thumbnail rail as blurred structural previews without visible “等待生成” or “生成中” copy. Their accessible labels continue to expose status to screen readers.

### 4.3 Slide ready

When `slide.ready` arrives, the final `ReportSlideView` is mounted in the same frame as the placeholder. Module visibility is controlled by a client reveal stage:

1. heading;
2. summary metrics;
3. primary visual;
4. support visual 1;
5. support visual 2 and any remaining support visuals;
6. evidence drawer entry.

Atomic pages without a data-dashboard visual skip absent stages. Empty metric or support groups do not create artificial delay.

### 4.4 Later pages

Subsequent outline pages continue to update in the thumbnail rail. A page becoming ready updates its thumbnail without navigating the main canvas. The first ready page may become active automatically only when there is no user-selected or playable page yet.

### 4.5 Clarification, failure, and restore

- A required clarification remains an explicit interaction because generation cannot continue without user input. The canvas structure remains visible behind or alongside the clarification treatment.
- A failed page keeps its stable placeholder frame and receives the existing retry affordance in the thumbnail rail. Error information remains available through accessible labels and the retry control rather than replacing the full canvas with a generic waiting state.
- Restoring an existing ready report does not replay progressive reveal. Ready pages render fully clear immediately.

## 5. Visual Treatment

Unfinished modules use:

- a neutral dark-blue structural surface consistent with the report theme;
- `filter: blur(...)` plus reduced opacity on placeholder shapes;
- a restrained edge glow or low-contrast sweep to indicate activity without text;
- clipping within the module boundary so blur cannot overlap adjacent components;
- fixed dimensions matching the final module to prevent layout shift.

Module completion uses a short transition from blurred to clear, with a small opacity lift and optional cyan scan highlight. It must not resize, translate, or reflow the module.

Recommended timing:

- heading: 320 ms;
- metric-card stagger: 70–100 ms per card, capped so large metric sets remain quick;
- primary visual: 380–450 ms;
- each support visual: 300–380 ms;
- evidence entry: 220–280 ms;
- total reveal target: about 1.2–1.6 seconds per page.

The existing chart motion may begin when its containing module is revealed. The new reveal sequence must not fight GSAP chart animation or cause values to animate while still visibly blurred.

## 6. Component Design

### 6.1 `ReportWorkspace`

- Remove the normal-creation dependency on `firstPlayableSlide` for deciding whether the canvas is available.
- Track a selected outline/slide ID so planned and generating pages can have a stable canvas representation.
- Replace blocking generation/loading branches with a persistent report rail and canvas shell.
- Preserve special branches for terminal errors and required clarification, but keep the report structure visible where safe.
- Keep the current rule that completed later pages do not automatically replace the active page.

### 6.2 New pending-page canvas component

Add a focused component, tentatively `ReportPendingSlideView`, that accepts an optional `SlideOutline` and renders only non-semantic structural placeholders. It should mirror the high-level layout of `ReportSlideView` and `DataDashboardVisual` without manufacturing report content.

It must support:

- no-outline neutral state;
- atomic-visual outline state;
- dashboard-style outline state;
- canvas and thumbnail variants where useful;
- stable large-screen sizing and containment.

### 6.3 Progressive reveal controller

Add a small client hook or component-level state machine, tentatively `useReportModuleReveal`, keyed by report ID and slide ID.

Responsibilities:

- return the currently revealed module stage;
- reveal only modules that exist on the ready slide;
- remember completed slide IDs for the lifetime of the workspace;
- cancel timers when the active report or slide changes;
- mark restored/pre-existing ready slides as complete;
- honor reduced-motion preferences by rendering a ready slide completely clear without staged animation.

The completed set belongs at workspace level, similar to the existing `animatedSlides` tracking, so navigation does not replay the sequence.

### 6.4 `ReportSlideView` and visual modules

Expose stable reveal targets with data attributes or lightweight wrappers:

- heading/takeaway;
- metric group and individual metric cards;
- primary chart section;
- each supporting chart section;
- evidence entry.

For non-dashboard visuals, the visual renderer is the primary module. These markers should describe presentation grouping only and must not alter evidence semantics or chart data.

### 6.5 Thumbnail rail

- Continue showing every outline page.
- Replace visible pending-status text with a blurred miniature structure.
- Retain accessible status wording in button labels and assistive-only text.
- Keep retry controls for failed pages.
- Ready thumbnails render the real slide as today.

## 7. Accessibility and Motion

- The canvas must retain meaningful `role="status"` or live-region updates outside blurred visual content so assistive technology can announce page readiness without visible status copy.
- Blurred placeholders are decorative and must be `aria-hidden`.
- Unready fake controls must not be focusable.
- Under `prefers-reduced-motion: reduce`, remove sweep/scan motion and module delays. A ready slide appears clear immediately; a not-ready slide remains a static blurred structure.
- Contrast and focus behavior for real content remain unchanged.

## 8. Error and Race Handling

- Clear pending reveal timers when a report exits, switches, fails, or is cancelled.
- Ignore late timers from a superseded slide render.
- If a ready slide is corrected/replaced, treat the replacement as a new page that may reveal once when first activated.
- If the selected planned page disappears after a new outline, fall back to the first valid outline or first playable slide.
- If the visual renderer fails, keep the existing visual error boundary behavior; do not leave the entire page permanently blurred.
- Do not wait on narration or audio availability before clearing visual modules.

## 9. Testing Strategy

### Unit and component tests

- creation renders the persistent canvas rather than the centered loading page;
- no-outline state contains no fabricated report values or labels;
- outline-only state shows the real outline title and blurred structural modules;
- `slide.ready` reveals only existing modules in the confirmed order;
- large metric sets reveal without extending the sequence excessively;
- atomic pages skip dashboard-only stages;
- revisiting a completed page does not replay reveal;
- restored ready reports render fully clear;
- later ready pages do not steal active-page focus;
- clarification, failure, retry, cancellation, and correction states remain usable;
- pending thumbnails have no visible status copy but retain accessible status labels;
- reduced-motion mode disables staged motion.

### Regression checks

- report workspace tests;
- visual renderer and dashboard layout tests;
- narration and subtitle tests;
- mocked report-stream end-to-end tests;
- production build;
- large-screen browser inspection at the project’s supported display size.

## 10. Non-Goals

- No module-level server streaming protocol.
- No change to report evidence, claim, metric, or narration schemas.
- No fabricated progressive text generation inside a finished module.
- No redesign of the approved dashboard layout, typography, colors, chart sizing, or subtitle behavior.
- No reintroduction of small-screen test pages; validation remains focused on the supported large-screen experience.

## 11. Acceptance Criteria

The feature is accepted when a new report immediately opens into a stable large-screen canvas, unfinished sections are represented only by contained blurred structures, real content clears in the confirmed order after each page is ready, no visible generation-status wording appears in the canvas or pending thumbnails, completed pages remain stable on revisit, and all existing evidence, narration, correction, retry, and large-screen layout behavior continues to work.
