# Task 4 Fix Report

Date: Saturday, August 22, 2026

Status: Implemented

Base:
- `7f402d3` `feat: paginate dense report pages for large screens`

Fix Summary:
- Added a deterministic metric-coverage pass ahead of Task 4 large-screen pagination.
- Coverage now uses the full ordered `bundle.analysis.scope.metrics` list as `requiredMetricKeys`.
- Required scope keys are validated directly against metric descriptors without imposing an `excel`-source restriction.
- Missing analyzed metrics are only appended to already-metric report pages whose visual kind can still represent them safely:
  - `kpi-grid`: any analyzed metric
  - `radar`: score-like analyzed metrics only
  - `comparison-bars`: same-unit analyzed metrics only
  - `trend-line` / `trend-area`: analyzed metrics with at least two points only
- If a scoped key does not resolve to metric evidence, or no compatible metric-report page can safely host a missing scoped metric, pagination rejects with `REPORT_OUTLINE_INVALID`.
- Balanced split behavior remains unchanged after coverage is established.

Regression Coverage:
- Added unit coverage proving an omitted-metric `kpi-grid` outline is expanded and paginated until every required analyzed metric appears.
- Added unit coverage proving a `health-ring`-only outline rejects when omitted analyzed metrics cannot be represented safely.
- Added unit coverage proving non-Excel metric descriptors in `analysis.scope.metrics` are still covered when they resolve to valid metric evidence.
- Added focused compatibility-guard regression coverage for:
  - `comparison-bars`: same-unit enforcement
  - `radar`: score-like enforcement
  - `trend-line`: at least two points per covered metric
- Re-ran the existing planner coverage exercising the same pagination path at the `planReport()` integration boundary.
- Kept the existing capacity and chart-cardinality checks by narrowing those fixtures to evidence bundles that intentionally contain only the metrics under test.

Files Changed:
- `.superpowers/sdd/task-4-fix-report.md`
- `server/src/domain/report-layout-budget.ts`
- `server/tests/report-layout-budget.test.ts`

Focused Verification:
- Command:
  - `./node_modules/.bin/vitest server/tests/report-layout-budget.test.ts server/tests/intent-first-report-planner.test.ts --run`
- Result:
  - `2` test files passed
  - `28` tests passed
  - `0` failed

Notes:
- Did not modify UI files.
- Did not touch or stage `server/.env.example`.
- Kept scope focused to the Task 4 pagination path and report artifact.
