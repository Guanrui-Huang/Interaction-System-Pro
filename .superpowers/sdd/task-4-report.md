# Task 4 Report — Persistent Report Canvas During Creation

## Scope

Implemented Task 4 of the progressive report canvas plan in:

- `src/features/ai/report/ReportWorkspace.tsx`
- `src/features/ai/report/ReportThumbnailRail.tsx`
- `src/features/ai/report/ReportGenerationStatus.tsx` (deleted)
- `src/styles/ai.css`
- `src/tests/report-workspace.test.tsx`
- `src/tests/app.test.tsx`

Kept the pre-existing unrelated changes in `server/.env.example` and `.DS_Store` untouched.

Did not modify:

- `src/features/ai/report/ReportPendingSlideView.tsx`
- `src/features/ai/report/useReportModuleReveal.ts`
- server code
- Task 5 E2E files

## TDD Evidence

### RED

Updated the workspace and app tests first to encode the approved behavior:

- persistent rail/canvas during null, generating, and clarification states
- no visible `等待生成` / `生成中` thumbnail copy
- accessible pending button names preserved
- live-create reveal-once then restored immediate-clear coverage

Tried the brief’s focused command first:

```sh
pnpm test src/tests/report-workspace.test.tsx src/tests/app.test.tsx --run
```

In this sandbox, `pnpm` could not verify the pinned package-manager signature without registry access, so it was not usable as a reliable verifier here.

Used the repo-local Vitest runner to continue the red/green loop:

```sh
./node_modules/.bin/vitest run src/tests/report-workspace.test.tsx src/tests/app.test.tsx
```

Result before implementation: failures matched the intended Task 4 gap:

- `ReportWorkspace` still branched to blocking generation UI
- pending thumbnails still relied on visible status text

### GREEN

Implemented the workspace/rail refactor, then verified with the user-provided local Vitest command:

```sh
CI=1 node node_modules/vitest/vitest.mjs run src/tests/report-workspace.test.tsx src/tests/app.test.tsx src/tests/report-module-reveal.test.tsx src/tests/narration-controller.test.tsx
```

Result: `4 passed`, `101 passed`.

## Implementation Summary

### `ReportThumbnailRail`

- Changed `snapshot` to accept `ReportJobSnapshot | null`.
- For `snapshot === null`, renders one decorative pending thumbnail shell with `ReportPendingSlideView mode="thumbnail"` and no selection button.
- Replaced visible pending thumbnail text blocks with structural `ReportPendingSlideView` previews.
- Kept pending/failed state text only in accessible button labels and retry behavior.

### `ReportWorkspace`

- Removed the blocking `ReportGenerationStatus` and no-snapshot loading branches.
- Always renders the rail/canvas stage for non-error creation and restore flows.
- Tracks reveal completion by report ID and slide ID so:
  - slides created in the live request reveal once
  - restored slides render immediately clear when there is no `launchQuestion`
- Calls `useReportModuleReveal` unconditionally from the workspace and passes revealed modules into `ReportSlideView`.
- Preserved:
  - invalid-correction fallback
  - clarification flow, now as an overlay above the canvas
  - chat/sidebar behavior
  - narration controls and subtitle bar
  - retry/correction handling
  - keyboard focus behavior driven by existing slide and clarification components

### Styles

- Removed obsolete blocking-generation CSS for:
  - `.report-generation-status`
  - `.report-workspace__loading`
  - `.report-workspace__pending`
- Removed obsolete thumbnail pending text styling that no longer has callers.
- Added `.report-workspace__clarification-overlay` with the requested blurred overlay treatment.
- Kept the large-screen fixed workspace layout intact and did not add any new `1280x800` page treatment.

### Tests

- Rewrote pending-state expectations to assert the persistent workspace stage.
- Added reveal lifecycle coverage for:
  - null/create shell
  - outline-only generating shell
  - first ready live-created slide progressive reveal
  - restored revisit immediate-clear behavior
- Updated the app-level create-shell test to hold the report creation request open so it genuinely observes the pre-settlement state.

## Verification

Verified with:

```sh
CI=1 node node_modules/vitest/vitest.mjs run src/tests/report-workspace.test.tsx src/tests/app.test.tsx src/tests/report-module-reveal.test.tsx src/tests/narration-controller.test.tsx
```

Observed result:

- `src/tests/report-workspace.test.tsx`: passed
- `src/tests/app.test.tsx`: passed
- `src/tests/report-module-reveal.test.tsx`: passed
- `src/tests/narration-controller.test.tsx`: passed
- total: `101 passed`

## Self-review

- Checked the task diff for unintended overlap with unrelated user changes.
- Confirmed only Task 4 implementation/test files plus this report are intended for staging.
- Confirmed the stale previous contents of `task-4-report.md` were replaced with this task’s report.
- `git diff --check` reported no whitespace issues for the task files.
