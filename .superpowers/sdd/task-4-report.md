# Task 4 Report — Desktop readability and panel fill

## Scope

Implemented the Task 4 desktop report readability treatment in:

- `src/styles/ai.css`
- `src/features/ai/report/ReportSubtitleBar.tsx`
- `src/tests/report-layout-styles.test.ts`
- `src/tests/report-workspace.test.tsx`

The unrelated pre-existing changes in `.superpowers/sdd/task-1-report.md` and `server/.env.example` were left untouched.

## TDD evidence

### RED

After adding the desktop readability, geometry-bound, subtitle, and active-cue tests, ran:

```sh
CI=1 node node_modules/vitest/vitest.mjs run src/tests/report-layout-styles.test.ts src/tests/report-workspace.test.tsx
```

Result: `4 failed | 53 passed`.

The failures were the intended missing behavior:

1. Desktop metric padding/value/icon/panel-label scale had not been raised.
2. Bars, radar, and ring had no protected `300×180`, `220×220`, and `200×200` drawing bounds after panel chrome consumed space.
3. The health ring still used its old `340px` sizing rather than the required `320px` panel-short-edge cap.
4. The subtitle still used the old low bottom offset and did not enforce a single desktop line.

For the later review correction, first added a test forbidding subtitle `overflow: hidden` and `text-overflow: ellipsis`, then ran:

```sh
CI=1 node node_modules/vitest/vitest.mjs run src/tests/report-layout-styles.test.ts
```

Result: `1 failed | 15 passed`, specifically because the subtitle rule contained `overflow: hidden`.

### GREEN

After implementing the styles and direct cue binding, ran the focused command:

```sh
CI=1 node node_modules/vitest/vitest.mjs run src/tests/report-layout-styles.test.ts src/tests/report-workspace.test.tsx
```

Result: `2 passed`, `58 passed`.

Then ran the relevant wider report regressions:

```sh
CI=1 node node_modules/vitest/vitest.mjs run src/tests/report-layout-styles.test.ts src/tests/report-workspace.test.tsx src/tests/report-visuals.test.tsx src/tests/narration-subtitle-cues.test.ts
```

Result: `4 passed`, `106 passed`.

Finally ran:

```sh
pnpm run build
```

Result: exit code `0`.

## Implementation

- Raised desktop metric padding, text scale, panel labels, chart labels/values, and semantic icons; thumbnail icons remain smaller.
- Changed dashboard panel content tracks to `minmax(min-content, 1fr)` and added chart-level minimum drawing bounds: bars `300×180`, radar `220×220`, ring `200×200`. The style test injects the report stylesheet and verifies those dimensions through `getComputedStyle`.
- Kept panel overflow unmasked; the chart child owns the minimum dimensions so panel labels and padding cannot shrink the drawable geometry.
- Updated health rings to a `min(100%, 320px)` width/height cap, retaining an SVG square drawing area and proportionally enlarged center value.
- Kept the subtitle directly bound to the current controller cue (including an empty cue), raised its desktop bottom clearance above evidence, and made it a centered non-interactive single line without CSS ellipsis or hidden overflow.
- Preserved the narrow-screen grid and thumbnail chart overrides.

## Self-review

- `git diff --check` reported no whitespace errors.
- Confirmed no panel selector introduces `overflow: hidden`.
- Confirmed `server/.env.example` was not staged or modified by this task.
