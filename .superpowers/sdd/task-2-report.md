# Task 2 Report: Audio Duration and Subtitle Synchronization

## Scope

Implemented Task 2 subtitle synchronization without changing `server/.env.example`.

- `AudioSegmentPlayer.durationMs()` now exposes decoded speech duration and returns `0` before decoding.
- Narration text is split into subtitle cues immediately when a cursor begins; the first cue is rendered before audio resolves.
- A 120 ms narration-only timer derives the current cue from `positionMs() / durationMs()`.
- Timers are cleared during release, segment end, pause, interruption, stop, and unmount. Resume starts a fresh timer.
- Timer callbacks require the mounted component, current operation, and active playback identity, so stale audio cannot replace a later slide's subtitle.
- Existing voice-playback fake player now implements the expanded audio-player contract with `durationMs(): 0`.

## TDD Evidence

### RED

Command:

```sh
CI=1 node node_modules/vitest/vitest.mjs run src/tests/narration-controller.test.tsx
```

Result: exit 1; 34 passed and 3 failed. The new controller regressions received the complete narration (`第一句。第二句。第三句。`) where they expected the initial or offset-aligned single cue. This demonstrated the missing controller behavior before implementation.

### GREEN

Command:

```sh
CI=1 node node_modules/vitest/vitest.mjs run src/tests/narration-subtitle-cues.test.ts src/tests/narration-controller.test.tsx
```

Result: exit 0; 43 tests passed across 2 files.

The controller regressions cover initial cue rendering, progress advance, pause/resume stability, and restoring a saved offset. They use a controllable fake player implementing the real `AudioSegmentPlayer` contract and the production cue splitter.

### Type Check

Command:

```sh
node node_modules/typescript/bin/tsc -b --pretty false
```

The first run exposed the expanded interface requirement in the pre-existing `FakeAudioSegmentPlayer` used by `voice-playback.test.tsx`. Added its zero-duration contract implementation. The final run exited 0 with no diagnostics.

## Self-Review

- Confirmed `speechDurationMs` already records decoded total duration; `durationMs()` exposes that state directly.
- Confirmed subtitle updates are narration-only and do not alter aria-live status, error text, or pause/resume cursor-offset semantics.
- Confirmed timer teardown covers every required lifecycle path and callbacks guard mounted, operation, and active playback ownership.
- Confirmed only Task 2 implementation/tests are staged for commit; this report and unrelated workspace edits are excluded.

## Final Verification

- Focused subtitle/controller tests: 43/43 passing.
- TypeScript project check: passing.

## Task 2 Review Fix

- Reset `speechDurationMs` to `0` at the start of every new `WebAudioSegmentPlayer.play()` before asynchronous decoding, preventing a reused player from exposing stale duration.
- Added a focused `voice-playback.test.tsx` regression covering zero duration before first decode, decoded duration after play resolves, and zero duration during a second decode.

### Verification

```sh
CI=1 node node_modules/vitest/vitest.mjs run src/tests/narration-subtitle-cues.test.ts src/tests/narration-controller.test.tsx src/tests/voice-playback.test.tsx
```

Result: exit 0; 66 tests passed across 3 files.

```sh
node node_modules/typescript/bin/tsc -b --pretty false
```

Result: exit 0 with no diagnostics.

### Self-Review

- Confirmed the production change is limited to resetting the existing duration state before decode; no unrelated playback behavior changed.
- Confirmed the regression uses the existing fake audio context/deferred decode pattern and exercises the public player contract.
- Confirmed `server/.env.example` and pre-existing unrelated workspace edits remain untouched.
