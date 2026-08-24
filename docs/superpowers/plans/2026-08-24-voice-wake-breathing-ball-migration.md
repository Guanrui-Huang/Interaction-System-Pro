# Voice Wake and Breathing Ball Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the local “小智小智” wake-word interaction, wake/analysis voice prompts, and microphone breathing-ball animation from the sibling project into `D:\Interaction-System-main` without changing unrelated dashboard or report behavior.

**Architecture:** Keep the target project's existing Qwen recognition, TTS gateway, AI page, and report generator. Add a separate browser `useWakeWord` PCM stream to the local `/api/voice/keyword` WebSocket, backed by a server-side sherpa-onnx keyword spotter. Extend the existing synthesis protocol with two assistant prompts—wake acknowledgement and dynamic analysis acknowledgement—while extracting only the relevant CSS animation rules.

**Tech Stack:** React 19, TypeScript 5.9, Vite 7, Express 5, `ws`, Vitest, Testing Library, pnpm 11.16.0, `sherpa-onnx-node` 1.13.6, bundled sherpa-onnx keyword model.

## Global Constraints

- Keep the target project's existing dashboard, report workspace, chart, data, and environment behavior unchanged.
- Migrate the wake word “小智小智” and the responses “诶，我在，请问有什么吩咐” and “好滴，现在我来分析：{用户问题}”.
- The dynamic analysis prompt must finish playing before `onStartReport({ question, page })` is called; prompt failure must not block the report.
- The browser sends PCM only to the local `/api/voice/keyword` WebSocket; provider credentials remain server-side.
- Use 16 kHz mono PCM for keyword detection; stop all tracks, AudioContext nodes, timers, and sockets on wake, cancel, close, and unmount.
- If the keyword model or voice provider is unavailable, preserve manual microphone and text input paths and expose a typed user-facing error.
- Only files listed in the approved specification's allowlist may be added or modified; do not copy `node_modules/`, `dist/`, `.env`, report artifacts, or unrelated source changes.
- Keep `prefers-reduced-motion` behavior: disable animation only, not the voice controls.

---

## File Map

### New files

- `models/kws/README.md` and `models/kws/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/*`: bundled keyword model copied from `D:\AI-Interaction-System-main\models\kws`.
- `server/src/services/voice/keyword-spotter.ts`: optional sherpa-onnx model loader and typed streaming adapter.
- `server/tests/voice-keyword-spotter.test.ts`: model path/configuration tests using a fake module.
- `src/features/ai/voice/useWakeWord.ts`: browser microphone/AudioWorklet/WebSocket wake-word session lifecycle.
- `src/tests/voice-wake-word.test.tsx`: wake lifecycle, PCM forwarding, permission, unsupported, stop, and timeout tests.
- `src/features/ai/voice/assistant-prompts.ts`: one-shot assistant prompt cancellation registry.

### Modified files

- `package.json`, `pnpm-lock.yaml`: add and lock `sherpa-onnx-node@^1.13.6` only.
- `shared/voice.ts`: add wake/prompt error codes and message types; make the analysis prompt carry a bounded question string.
- `server/src/services/voice/gateway.ts`: validate prompt and keyword messages; add `/api/voice/keyword`; synthesize fixed/dynamic prompts.
- `server/src/index.ts`: create the optional keyword spotter and inject it into the voice gateway.
- `src/features/ai/voice/useVoicePlayback.ts`: add prompt playback while preserving report speech playback.
- `src/features/ai/voice/VoiceInteraction.tsx`: render wake state and toggle; add hearing state for the breathing ball.
- `src/features/ai/AiPage.tsx`: coordinate wake acknowledgement, automatic recognition, dynamic analysis acknowledgement, and cleanup.
- `src/styles/ai.css`: add only breathing-ball, wake-toggle, and reduced-motion rules.
- `src/tests/ai-page.test.tsx`, `src/tests/voice-playback.test.tsx`, `server/tests/voice-gateway.test.ts`: extend tests for the new behavior.

## Task 1: Add the keyword model adapter and dependency

**Files:**
- Create: `server/tests/voice-keyword-spotter.test.ts`
- Create: `server/src/services/voice/keyword-spotter.ts`
- Copy: `models/kws/README.md`
- Copy: `models/kws/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx`
- Copy: `models/kws/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx`
- Copy: `models/kws/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx`
- Copy: `models/kws/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/tokens.txt`
- Copy: `models/kws/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/keywords.txt`
- Modify: `package.json`, `pnpm-lock.yaml`

**Interfaces:**
- Produces `createKeywordSpotter(options?: CreateKeywordSpotterOptions): KeywordSpotterHandle | undefined`.
- `KeywordSpotterHandle` exposes `createStream`, `isReady`, `decode`, `getResult`, and `reset`.
- `KeywordSpotterStream.acceptWaveform` accepts `{ samples: Float32Array; sampleRate: number }`.

- [ ] **Step 1: Write the failing adapter tests.** Add tests that create a temporary model directory and fake `SherpaOnnxNodeModule`, then assert the exact 16 kHz/80-dimension transducer configuration, missing-file fallback, missing-keyword fallback, and trimmed `SHERPA_ONNX_KWS_MODEL_DIR` resolution.

```ts
it('builds a CPU keyword spotter from the bundled model files', () => {
  const spotter = createKeywordSpotter({ module: fakeModule, modelDir, keywordsFile });
  expect(spotter).toBeInstanceOf(FakeKeywordSpotter);
  expect(FakeKeywordSpotter.lastConfig).toMatchObject({
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: { transducer: { encoder, decoder, joiner }, tokens, provider: 'cpu' },
    keywordsFile,
  });
});
```

- [ ] **Step 2: Run the focused test and verify the expected RED failure.**

Run: `pnpm exec vitest server/tests/voice-keyword-spotter.test.ts --run`

Expected: collection fails because `server/src/services/voice/keyword-spotter.ts` does not exist yet; do not proceed until the failure is attributable to the missing adapter rather than a test typo.

- [ ] **Step 3: Implement the minimal adapter and stage model files.** Use `createRequire(import.meta.url)` to load `sherpa-onnx-node` optionally; resolve the default directory `models/kws/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01`; check encoder, decoder, joiner, tokens, and `keywords.txt`; instantiate CPU `KeywordSpotter` with sample rate 16,000, feature dimension 80, one thread, keyword score 1.0, and threshold 0.25. Return `undefined` for missing module, missing files, or constructor failure.

- [ ] **Step 4: Add the dependency and install the frozen lockfile.** Add exactly `"sherpa-onnx-node": "^1.13.6"` under `dependencies`, copy only the five model files and README from the source model directory, then run:

```powershell
pnpm install --lockfile-only
pnpm install --frozen-lockfile
```

- [ ] **Step 5: Run the focused adapter test and commit the self-contained task.**

Run: `pnpm exec vitest server/tests/voice-keyword-spotter.test.ts --run`

Expected: all adapter tests pass. Commit only the Task 1 allowlist with `git -c user.name="Codex" -c user.email="codex@local" commit -m "feat: add local keyword spotter"`.

## Task 2: Extend shared voice messages and the server gateway

**Files:**
- Modify: `shared/voice.ts`
- Modify: `server/src/services/voice/gateway.ts`
- Modify: `server/tests/voice-gateway.test.ts`

**Interfaces:**
- Add `ASSISTANT_PROMPT_IDS = ['wake', 'analysis-started'] as const` and `AssistantPromptId`.
- Add `KeywordClientMessage` and `KeywordServerMessage` for `{ type: 'start', format: 'pcm', sampleRate: 16000 }`, `{ type: 'ready' }`, `{ type: 'wake', keyword }`, and typed errors.
- Extend synthesis messages with:

```ts
type SynthesisClientMessage =
  | { type: 'synthesize'; reportId: string; speechId: string }
  | { type: 'prompt'; prompt: 'wake' }
  | { type: 'prompt'; prompt: 'analysis-started'; question: string }
  | { type: 'cancel' };
```

- Keep `SynthesisServerMessage` unchanged.

- [ ] **Step 1: Add failing gateway tests.** Add tests that connect to `/api/voice/keyword`, send the exact start message, receive `ready`, send one PCM buffer, and assert a fake spotter's wake result produces `{ type: 'wake', keyword: '小智小智' }`. Add tests that reject malformed keyword messages, return `VOICE_WAKE_UNAVAILABLE` when no spotter is injected, accept the two prompt variants, and cap/clean the dynamic question before TTS.

- [ ] **Step 2: Run the gateway tests and verify RED.**

Run: `pnpm exec vitest server/tests/voice-gateway.test.ts --run`

Expected: new keyword/prompt cases fail because the target gateway has no keyword path and no prompt message branch; existing gateway tests must remain green.

- [ ] **Step 3: Implement shared constants and schemas.** Add `VOICE_WAKE_UNAVAILABLE`, `VOICE_WAKE_TIMEOUT`, and `VOICE_TTS_QUOTA_EXHAUSTED` only if they are required by the migrated gateway behavior; add the associated sanitized Chinese messages. Add Zod schemas that strictly validate the keyword start message and prompt union, with a bounded `question` length.

- [ ] **Step 4: Implement the keyword WebSocket branch.** Add `KEYWORD_PATH = '/api/voice/keyword'`, inject optional `KeywordSpotterHandle`, convert incoming little-endian PCM16 bytes to `Float32Array` at 16 kHz, call `acceptWaveform`, `decode`, `getResult`, and `reset`, and send the wake event once per detected keyword. Close and sanitize errors on malformed input, spotter absence, stream failure, or socket shutdown.

- [ ] **Step 5: Implement assistant prompt synthesis.** Keep the fixed prompt text `wake: '诶，我在，请问有什么吩咐'`. Build the analysis prompt as `好滴，现在我来分析：${cleanQuestion}` after trimming, removing control characters, and enforcing the shared prompt length limit. Route both through the existing DashScope TTS path and preserve report narration leases for `synthesize` messages.

- [ ] **Step 6: Run the gateway tests and commit.**

Run: `pnpm exec vitest server/tests/voice-gateway.test.ts --run`

Expected: the new keyword/prompt tests and all existing gateway tests pass. Commit with `git -c user.name="Codex" -c user.email="codex@local" commit -m "feat: add wake and assistant prompt gateway messages"`.

## Task 3: Add the browser wake-word Hook

**Files:**
- Create: `src/features/ai/voice/useWakeWord.ts`
- Create: `src/tests/voice-wake-word.test.tsx`

**Interfaces:**
- `WakeWordStatus = 'idle' | 'starting' | 'listening' | 'waking' | 'error'`.
- `useWakeWord({ onWake?, dependencies? })` returns `{ status, errorCode, start, stop, cancel }`.
- Reuse target `VoiceBrowserDependencies` and `Pcm16Resampler` instead of creating another PCM implementation.

- [ ] **Step 1: Add the failing Hook tests.** Cover: start sends `{ type: 'start', format: 'pcm', sampleRate: 16000 }`; server `ready` starts AudioWorklet PCM forwarding; a wake message calls `onWake` once and stops tracks; unsupported browser maps to `VOICE_UNSUPPORTED`; denied permission maps to `VOICE_PERMISSION_DENIED`; `stop` returns to idle; and the ten-minute safety timer maps to `VOICE_WAKE_TIMEOUT`.

- [ ] **Step 2: Run the Hook tests and verify RED.**

Run: `pnpm exec vitest src/tests/voice-wake-word.test.tsx --run`

Expected: the test file fails to resolve `useWakeWord.ts`; no implementation code is written before this failure is observed.

- [ ] **Step 3: Implement the Hook lifecycle.** Create an AudioContext, request mono microphone input with echo cancellation/noise suppression, load `/voice-pcm-capture-worklet.js`, connect the worklet through a zero-gain node, open the local keyword WebSocket, resample to 16 kHz, forward PCM buffers, and handle ready/wake/error/close messages. On every terminal path stop tracks, disconnect nodes, close the context and socket, clear the safety timer, and reset the active session reference.

- [ ] **Step 4: Run the Hook tests and commit.**

Run: `pnpm exec vitest src/tests/voice-wake-word.test.tsx --run`

Expected: all Hook tests pass. Commit with `git -c user.name="Codex" -c user.email="codex@local" commit -m "feat: add browser wake word hook"`.

## Task 4: Add prompt playback without breaking report speech

**Files:**
- Create: `src/features/ai/voice/assistant-prompts.ts`
- Modify: `src/features/ai/voice/useVoicePlayback.ts`
- Modify: `src/tests/voice-playback.test.tsx`

**Interfaces:**
- Preserve the existing `play(reportId, speechId)`, `pause`, `resume`, and `stop` methods.
- Add:

```ts
playPrompt(
  prompt: 'wake' | 'analysis-started',
  onFinished?: () => void,
  options?: { persistOnUnmount?: boolean; question?: string },
): Promise<void>;
```

- `playPrompt('analysis-started', undefined, { question })` must send the dynamic question field; `playPrompt('wake')` must not send a question field.
- `assistant-prompts.ts` exports `registerAssistantPromptStop(stop): () => void` and `stopAssistantPrompt(): void` so a newer prompt cancels the previous one.

- [ ] **Step 1: Add failing playback tests.** Extend the existing fake socket/player tests to assert prompt requests, dynamic question forwarding, completion callback invocation, cancellation of an active prompt, prompt error mapping, and `persistOnUnmount` cleanup semantics. Assert existing report narration tests still send `{ type: 'synthesize', reportId, speechId }`.

- [ ] **Step 2: Run the playback tests and verify RED.**

Run: `pnpm exec vitest src/tests/voice-playback.test.tsx --run`

Expected: prompt tests fail because the target hook exposes no `playPrompt` and the target shared message type has no prompt variant; existing report playback tests remain green.

- [ ] **Step 3: Refactor the target hook's existing request path into a shared prompt/report request helper.** Keep the current audio segment validation, sequence checks, pause/resume behavior, and error mapping unchanged. Add prompt request serialization, prompt completion callback, persistent unmount behavior, and prompt-stop registration as the only new branches.

- [ ] **Step 4: Run playback tests and commit.**

Run: `pnpm exec vitest src/tests/voice-playback.test.tsx --run`

Expected: all playback tests pass. Commit with `git -c user.name="Codex" -c user.email="codex@local" commit -m "feat: add assistant prompt playback"`.

## Task 5: Integrate wake responses, dynamic analysis response, and breathing ball UI

**Files:**
- Modify: `src/features/ai/AiPage.tsx`
- Modify: `src/features/ai/voice/VoiceInteraction.tsx`
- Modify: `src/styles/ai.css`
- Modify: `src/tests/ai-page.test.tsx`

**Interfaces:**
- `AiPage` owns one `useWakeWord` session and cancels it when recognition starts, a report launches, the dialog closes, or the component unmounts.
- On wake, `playback.playPrompt('wake', () => startRecognition())` starts recognition only after the acknowledgement prompt finishes.
- On text or voice launch, `playback.playPrompt('analysis-started', undefined, { persistOnUnmount: true, question: trimmed })` resolves before `onStartReport({ question: trimmed, page: originPage })`; prompt failure is swallowed and the report still launches.
- `VoiceInteraction` accepts optional `wake` state and `onToggleWake`, so existing callers without wake props remain valid.

- [ ] **Step 1: Add failing AI page tests.** Extend the existing mocked voice harness to assert: wake listening starts when the AI page opens; the wake toggle starts/stops the Hook; a wake event plays the wake prompt and only then starts recognition; submitting `分析总氮趋势` calls `playPrompt('analysis-started', ..., { question: '分析总氮趋势' })` before `onStartReport`; and closing the dialog cancels recognition, wake, and playback. Add assertions for the “语音唤醒” button and wake status text.

- [ ] **Step 2: Run the AI page tests and verify RED.**

Run: `pnpm exec vitest src/tests/ai-page.test.tsx --run`

Expected: new wake/prompt assertions fail because the target page does not use `useWakeWord` or `playPrompt`; existing manual text and microphone tests remain green.

- [ ] **Step 3: Implement the page orchestration.** Add refs for the wake cancel function and recognition starter, start wake listening on page open, stop wake before manual recognition, play the wake acknowledgement before recognition, play the dynamic analysis acknowledgement before report launch, and skip stopping the prompt on unmount after a report has launched.

- [ ] **Step 4: Add the UI state.** Update `VoiceInteraction` to show the wake toggle, `VOICE_ERROR_MESSAGES` for wake errors, `aria-pressed` state, and `ai-microphone--hearing` when confirmed/interim text exists during recording. Add only the source rules for `ai-mic-breathe`, `ai-mic-breathe-ring`, `ai-wake-toggle`, `ai-wake-toggle__dot`, `ai-wake-pulse`, and reduced-motion suppression. Do not copy the source report-layout CSS.

- [ ] **Step 5: Run AI page tests and commit.**

Run: `pnpm exec vitest src/tests/ai-page.test.tsx --run`

Expected: all AI page tests pass. Commit with `git -c user.name="Codex" -c user.email="codex@local" commit -m "feat: integrate wake responses and breathing ball"`.

## Task 6: Wire the server startup and run focused regression checks

**Files:**
- Modify: `server/src/index.ts`
- Modify: `server/tests/startup.test.ts` only if the existing startup contract needs a new optional spotter assertion.

**Interfaces:**
- `startApplication()` calls `createKeywordSpotter()` once and passes the resulting optional handle as `keywordSpotter` to `attachVoiceWebSocketGateway`.
- Missing native module or model files must not prevent the API from listening on `127.0.0.1:8787`.

- [ ] **Step 1: Add a failing startup assertion for optional loading.** Test that startup still creates a listener when `createKeywordSpotter()` returns `undefined`, while the gateway receives the optional dependency when it is available.

- [ ] **Step 2: Run the startup test and verify RED.**

Run: `pnpm exec vitest server/tests/startup.test.ts --run`

Expected: the new assertion fails because `server/src/index.ts` does not yet call or inject `createKeywordSpotter()`.

- [ ] **Step 3: Implement the one-line startup dependency construction and gateway injection.** Keep dataset loading, report generation, voice config, ports, and shutdown behavior unchanged.

- [ ] **Step 4: Run focused server regression tests and commit.**

Run: `pnpm exec vitest server/tests/startup.test.ts server/tests/voice-gateway.test.ts server/tests/voice-keyword-spotter.test.ts --run`

Expected: all selected tests pass. Commit with `git -c user.name="Codex" -c user.email="codex@local" commit -m "feat: wire keyword spotter into local server"`.

## Task 7: Final verification and allowlist audit

**Files:**
- No new production files; update only allowlisted files if a focused test exposes a regression.

- [ ] **Step 1: Run all focused client and server tests.**

Run:

```powershell
pnpm exec vitest src/tests/voice-wake-word.test.tsx src/tests/voice-playback.test.tsx src/tests/ai-page.test.tsx --run
pnpm exec vitest server/tests/voice-keyword-spotter.test.ts server/tests/voice-gateway.test.ts server/tests/startup.test.ts --run
```

Expected: all selected tests pass.

- [ ] **Step 2: Build the project.**

Run: `pnpm run build`

Expected: `tsc -b` and `vite build` exit with code 0. A pre-existing chunk-size warning is acceptable if no new build error appears.

- [ ] **Step 3: Run the complete test suite and record baseline failures.**

Run: `pnpm run test --run`

Expected: no new failures attributable to the allowlisted files. Existing repository failures must be listed separately instead of being silently ignored.

- [ ] **Step 4: Audit the changed-file allowlist.**

Run:

```powershell
git diff HEAD~6..HEAD --name-only
git diff --check
```

Expected: every changed path is in the approved specification allowlist; no `.env`, `dist/`, `node_modules/`, unrelated report files, or temporary files appear.

- [ ] **Step 5: Verify local runtime.**

Run:

```powershell
pnpm run dev
```

Then verify `http://127.0.0.1:5173/` returns 200, `http://127.0.0.1:8787/api/health` returns `{"status":"ok"}`, and the manual text input remains available even if the keyword spotter reports `VOICE_WAKE_UNAVAILABLE`.

- [ ] **Step 6: Commit only verification-safe allowlisted changes.**

Run: `git -c user.name="Codex" -c user.email="codex@local" commit -m "test: verify voice wake migration"`

Expected: the final commit contains only the allowlisted migration changes and verification updates.
