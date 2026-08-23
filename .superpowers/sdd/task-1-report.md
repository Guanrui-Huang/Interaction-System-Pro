# Task 1 Report: Shared Report Chart Palette And No Duplicate Colors

## Result

Implemented a shared ordered report-chart palette so dashboard trend and bar visuals coordinate colors, multi-metric charts no longer duplicate carbon colors, and the report palette now exposes eight distinct gradients.

## RED verification

Command:

```bash
../../node_modules/.bin/vitest run src/tests/chart-theme.test.ts src/tests/report-visuals.test.tsx
```

Output:

```text
RUN  v3.2.7 /Users/xiaoshen001/Documents/ChatGPT/ai部署/Interaction-System-Pro/.worktrees/report-chart-legibility

❯ src/tests/chart-theme.test.ts (3 tests | 2 failed)
  × report bar themes > provides eight distinct report gradients
    → expected ... to have a length of 8 but got 7
  × report bar themes > allocates stable unique themes in first-seen order
    → chartThemesForMetrics is not a function

❯ src/tests/report-visuals.test.tsx (48 tests | 2 failed)
  × assigns different bar themes to separate carbon metrics in the same chart
    → expected [] to have a length of 2 but got 0
  × shares one ordered palette across dashboard trend and comparison visuals without duplicate bar colors
    → expected undefined to be 'water'

Test Files  2 failed (2)
Tests  4 failed | 47 passed (51)
Exit code: 1
```

This was the expected RED state: missing eighth theme, missing ordered allocator, and missing shared theme wiring/data attributes.

## GREEN verification

Command:

```bash
../../node_modules/.bin/vitest run src/tests/chart-theme.test.ts src/tests/report-visuals.test.tsx
```

Output:

```text
RUN  v3.2.7 /Users/xiaoshen001/Documents/ChatGPT/ai部署/Interaction-System-Pro/.worktrees/report-chart-legibility

✓ src/tests/chart-theme.test.ts (3 tests) 2ms
✓ src/tests/report-visuals.test.tsx (48 tests) 231ms

Test Files  2 passed (2)
Tests  51 passed (51)
Duration  965ms
Exit code: 0
```

`git diff --check -- src/charts/chart-theme.ts src/features/ai/report/visuals/ReportChartThemeContext.tsx src/features/ai/report/visuals/DataDashboardVisual.tsx src/features/ai/report/visuals/TrendVisual.tsx src/features/ai/report/visuals/ComparisonBarsVisual.tsx src/tests/chart-theme.test.ts src/tests/report-visuals.test.tsx` also passed with exit code 0.

## Files changed

- `src/charts/chart-theme.ts`: added the eighth `signal` palette, exported shared theme types, and added the ordered `chartThemesForMetrics()` allocator while keeping `barThemeForMetric()` for legacy/single-metric use.
- `src/features/ai/report/visuals/ReportChartThemeContext.tsx`: added report-level palette context, atomic-visual metric extraction, and the local/shared `useReportChartThemes()` hook.
- `src/features/ai/report/visuals/DataDashboardVisual.tsx`: collects first-seen dashboard metrics and wraps the full canvas dashboard in the shared theme provider.
- `src/features/ai/report/visuals/TrendVisual.tsx`: resolves series themes once per chart and adds `data-metric-key` diagnostics on lines.
- `src/features/ai/report/visuals/ComparisonBarsVisual.tsx`: resolves item themes once per chart and adds `data-metric-key` diagnostics on bars.
- `src/tests/chart-theme.test.ts`: updated palette cardinality and added ordered-allocation coverage.
- `src/tests/report-visuals.test.tsx`: added dashboard palette coordination and carbon-theme regression tests, and updated existing multi-metric expectations to the new ordered palette contract.
- `.superpowers/sdd/task-1-report.md`: this report.

## Self-review

- Shared dashboards now keep the same metric key on the same theme across summary ordering, primary trend, and supporting bars.
- Multi-metric charts outside the dashboard use a local first-seen allocator instead of semantic matching, while single-metric fallback behavior still uses `barThemeForMetric()`.
- Repeated metric keys reuse their original theme, and different carbon metrics in one bar chart no longer collapse to the same family.
- Thumbnail dashboard layout is unchanged because the provider is only needed for full-canvas composition; standalone thumbnail charts still use the local ordered hook path.
- Only the Task 1 brief files plus the required task report were modified.

## Concerns

- Verification covered the exact Task 1 target suite and file diff checks; I did not run the broader project test suite because the brief scoped verification to these two tests.

## Fix: keep 9+ chart themes unique

### Files

- `src/tests/chart-theme.test.ts`: added a focused regression that allocates nine distinct metric keys, verifies the first eight families stay aligned with the approved palette order, and proves the ninth metric no longer collides with the first.
- `src/charts/chart-theme.ts`: kept the approved eight base palette entries unchanged, widened runtime theme families to allow derived identifiers, and added deterministic overflow-theme generation for metrics beyond the eighth entry.

### Test evidence

RED after adding the regression:

```text
../../node_modules/.bin/vitest run src/tests/chart-theme.test.ts
FAIL  src/tests/chart-theme.test.ts > report bar themes > keeps every distinct metric unique after the eighth palette entry
AssertionError: expected 8 to be 9
```

GREEN after the fix:

```text
../../node_modules/.bin/vitest run src/tests/chart-theme.test.ts
Test Files  1 passed (1)
Tests  4 passed (4)
```

Task 1 scoped suite:

```text
../../node_modules/.bin/vitest run src/tests/chart-theme.test.ts src/tests/report-visuals.test.tsx
Test Files  2 passed (2)
Tests  52 passed (52)
```

### Self-review

- The first eight palette entries are unchanged and still returned verbatim for the first eight distinct metric keys.
- The ninth and later distinct keys now receive deterministic derived themes instead of wrapping back to an existing family.
- Repeated metric keys still reuse their original theme within the same chart.
