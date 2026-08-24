# 声控唤醒与呼吸球交互迁移设计

## 目标

将 `D:\AI-Interaction-System-main\Interaction-System-main` 中的两组交互能力，以最小差异迁移到 `D:\Interaction-System-main`：

1. AI 页面打开后可监听唤醒词“**小智小智**”；唤醒后播放“诶，我在，请问有什么吩咐”，再进入现有语音提问流程。
2. 麦克风按钮增加呼吸球动画和唤醒状态反馈。
3. 用户提交问题后，在原有汇报生成前播放“好滴，现在我来分析：{用户问题}”，播报完成后继续原有汇报流程。

目标项目现有的仪表盘、AI 汇报工作区、图表、数据、环境文件和其他交互保持不变。

## 现状与边界

目标项目已有 Qwen 实时语音识别、语音播报和 AI 汇报链路，但没有源项目中的本地关键词唤醒链路、唤醒模型和提示音请求协议。源项目还包含较多与本需求无关的汇报布局和视觉改动，不能整体覆盖。

本次只迁移以下能力：

- 本地 16 kHz PCM 关键词唤醒；
- 唤醒后的提示音和动态分析提示音；
- 麦克风呼吸球、声波速度和“语音唤醒”状态控件；
- 实现上述能力所需的模型文件、服务端协议、共享类型、测试和依赖锁定信息。

不迁移：

- 源项目中与汇报工作区、图表、报告布局、数据、`dist/` 和 `.env` 相关的变化；
- 源项目 `node_modules/`；
- 任何未列入允许修改清单的文件。

## 方案

采用“最小回移”方案，在目标项目当前版本上做局部补丁：

1. 复用目标项目已有的 `useVoiceRecognition`、`useVoicePlayback`、WebSocket 语音网关和 AI 汇报启动边界，不复制源项目的完整页面。
2. 增加独立的 `useWakeWord` Hook 和服务端 `keyword-spotter` 适配器。浏览器只向本地 `/api/voice/keyword` WebSocket 发送 PCM，关键词模型只在服务端加载。
3. 扩展现有语音合成协议，允许客户端请求固定唤醒提示音和带用户问题文本的分析提示音。服务端统一使用已配置的 DashScope TTS 链路，前端不接触凭据。
4. 只抽取源 `ai.css` 中与麦克风呼吸球和唤醒控件相关的规则，不覆盖源项目其余报告样式。
5. 当本地唤醒模型无法加载或语音服务不可用时，显示已有的可读错误，并保留手动点击麦克风和文字提问路径。

## 数据与交互流程

### 唤醒流程

```text
打开 AI 页面
  -> useWakeWord.start()
  -> 浏览器 AudioWorklet 采集 16 kHz PCM
  -> WebSocket /api/voice/keyword
  -> sherpa-onnx-node 关键词识别
  -> 返回 { type: "wake", keyword: "小智小智" }
  -> 停止唤醒监听
  -> 播放“诶，我在，请问有什么吩咐”
  -> 自动开始现有语音识别
```

手动点击“语音唤醒”按钮可启动或停止监听；开始录音、提交问题、关闭 AI 页面和组件卸载时必须取消唤醒会话，避免麦克风、WebSocket 和 AudioContext 泄漏。

### 动态分析回应

```text
用户提交文字或语音问题
  -> 清理并保存用户问题
  -> 播放“好滴，现在我来分析：{问题}”
  -> 提示音完成后调用现有 onStartReport({ question, page })
  -> 原有汇报工作区继续生成
```

问题文本通过服务端提示音请求发送，服务端对文本做长度限制和控制字符清理；不得把 API Key、环境变量、文件路径或原始工作簿内容放入提示音请求。

## 允许修改文件白名单

以下为目标项目允许新增或修改的文件范围。实现时必须用 `git diff --name-only` 对照此清单复核。

### 新增

- `models/kws/README.md`
- `models/kws/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/` 下的关键词模型文件
- `src/features/ai/voice/useWakeWord.ts`
- `src/tests/voice-wake-word.test.tsx`
- `server/src/services/voice/keyword-spotter.ts`
- `server/tests/voice-keyword-spotter.test.ts`
- `src/features/ai/voice/assistant-prompts.ts`

### 修改

- `package.json`：仅加入 `sherpa-onnx-node`，版本与源项目一致。
- `pnpm-lock.yaml`：仅由 pnpm 为上述依赖更新锁定内容。
- `shared/voice.ts`：加入唤醒错误码、提示音 ID、关键词 WebSocket 消息和带问题文本的提示音请求类型。
- `server/src/services/voice/gateway.ts`：加入 `/api/voice/keyword` WebSocket、提示音请求校验和动态分析提示音文本生成。
- `server/src/index.ts`：创建关键词识别器并注入网关。
- `src/features/ai/voice/useVoicePlayback.ts`：增加 `playPrompt`，并保留现有报告播报 API 行为。
- `src/features/ai/voice/VoiceInteraction.tsx`：增加唤醒状态、唤醒按钮和呼吸球状态 class；保留原有手动语音按钮。
- `src/features/ai/AiPage.tsx`：接入唤醒 Hook，编排唤醒回应、分析回应和现有报告启动。
- `src/styles/ai.css`：仅加入呼吸球、声波加速、唤醒按钮及 reduced-motion 规则。
- `src/tests/ai-page.test.tsx`：覆盖自动启动/停止唤醒、唤醒回应和动态分析提示音后再提交报告。
- `src/tests/voice-playback.test.tsx`：覆盖提示音请求、动态问题文本和取消清理。
- `server/tests/voice-gateway.test.ts`：覆盖关键词 WebSocket、提示音请求校验、未配置/上游错误映射。

### 明确禁止修改

除上述白名单外，不修改任何业务、视觉、数据、配置或构建文件；不生成或提交 `.env`、`dist/`、`node_modules/` 和临时文件。

## 测试与验证

按 TDD 顺序执行：

1. 先在目标项目补充唤醒 Hook、提示音、网关和 AI 页面交互的失败测试，并确认失败原因是功能缺失而非导入/环境错误。
2. 迁移最小实现，让新增定向测试通过。
3. 运行现有语音测试、AI 页面测试和服务端网关测试。
4. 运行 `pnpm run build`，确认 TypeScript 和 Vite 构建通过。
5. 运行 `pnpm run test --run`，记录源仓库已有失败与本次改动造成的失败，不能把既有失败误报为迁移成功。
6. 运行 `git diff --name-only`，结果只能包含上述白名单；运行 `git diff --check` 检查空白错误。
7. 启动本地服务，确认前端 HTTP 200、`/api/health` 返回 `{"status":"ok"}`，并确认手动文字提问路径仍可用。

## 风险与降级

- `sherpa-onnx-node` 是本地原生依赖，若当前平台无法加载或模型文件缺失，只禁用语音唤醒并显示 `VOICE_WAKE_UNAVAILABLE`，不影响手动麦克风和文字输入。
- DashScope TTS 未配置或上游失败时，提示音失败不得阻塞文字汇报；分析提示音失败后仍应继续调用 `onStartReport`。
- 用户关闭 AI 页面或开始新的识别前必须取消旧唤醒会话，避免双重监听和重复提交。
- `prefers-reduced-motion` 下关闭呼吸球和唤醒指示动画，但不关闭功能本身。
