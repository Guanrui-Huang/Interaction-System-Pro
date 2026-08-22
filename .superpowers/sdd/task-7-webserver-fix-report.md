# Task 7 WebServer Fix Report

Date: 2026-08-22
Commit base: `e1827b7`

## Change

Updated `playwright.config.ts` `webServer.command` from `pnpm exec ...` invocations to direct local binaries:

- `./node_modules/.bin/tsc -b`
- `./node_modules/.bin/vite build`
- `./node_modules/.bin/tsx e2e/server.ts`

Kept `url`, `timeout`, and `reuseExistingServer` unchanged.

## Verification

Pre-fix behavior:

- `./node_modules/.bin/playwright test --project=mocked`
- Result: Playwright stalled in `config.webServer` startup and did not reach test output/assertions while the `pnpm exec ...` command path was active.

Post-fix focused verification:

- Command: `./node_modules/.bin/playwright test --project=mocked --grep "renders a question-specific 1-page mocked report for 污水脱氮是什么？"`
- Sandbox note: the direct-binary startup got past the original `pnpm` issue immediately, but local sandboxing blocked `tsx` IPC pipe creation under `/var/folders/...`, so the final verification run was repeated with normal local process permissions.
- Result: Playwright started the web server, executed the focused mocked test, and reached assertions successfully.
- Output summary: `1 passed (8.0s)`

## Scope Check

No production UI, E2E fixture data, `server/.env.example`, or unrelated config was changed for this fix.
