# 智慧污水处理厂 AI 动态汇报

本地优先的 React、Vite 与 Express 演示系统。仪表盘读取经校验的 Excel 演示数据，提供运行总览、健康指数、水质和能耗数据。

## 异步报告

用户提交问题后，`POST /api/ai/reports` 立即返回 `202`、不透明 `reportId` 和空的初始快照，不再返回预制首屏。工作区先依次展示“正在理解问题”“正在检索相关数据”“正在组织分析”“正在生成首个页面”等真实生成阶段，再通过快照和 SSE 发布与问题对应的首屏及后续页面。页面数量由问题复杂度动态决定，可在 1–12 页之间变化。

涉及现场数值、趋势、达标、异常、费用、能耗或运行状态的问题，会从后台 Excel 全模块数据中提取受限证据，不受发起问题时所在业务页限制；纯知识问题由模型知识生成，不伪造现场数据；混合问题可在同一页面分别标明模型知识和 Excel 现场证据。身份问题仅展示白名单内的公开助手资料；当 `DEEPSEEK_MODEL=deepseek-v4-flash` 时精确显示 `DeepSeek v4-flash`，不会暴露环境变量、凭据或私有模型配置。问题对象不明确时，工作区会先要求澄清，再在同一任务中继续生成。

目录中的缩略图会真实渲染对应页面的同一份内容，主画布使用响应式 HTML 可视化并随窗口流式重排，不锁定固定 16:9 比例。首个已验证页面到达前不会播放讲解；到达后默认自动讲解并连续预取后续语音。后续页面若遇到瞬时网络失败会自动重试一次；两次失败后报告保留已完成页面并进入部分可用状态，同时只为失败页面提供一个手动重试入口。文字或语音追问会中断当前讲解，回答结束后按同一页、同一分段和精确偏移量语义恢复。

报告支持刷新，文字输入在语音不可用时始终可用。内存注册表默认 30 分钟空闲过期、最长保留 2 小时，并限制为 32 份并发报告。测试使用确定性伪造模型和语音实现，不依赖真实凭据或网络。

## 开发

需要 Node.js `^20.19.0 || >=22.12.0` 和 pnpm 11.16.0。

```powershell
corepack enable
pnpm install --frozen-lockfile
Copy-Item server/.env.example server/.env
pnpm run generate:data
pnpm run dev
```

前端运行在 `http://127.0.0.1:5173`，Express API 运行在 `http://127.0.0.1:8787`。生产构建：

```powershell
pnpm run serve:built
```

浏览器验收使用单一来源的构建产物与确定性伪造模型/语音服务，不读取真实凭据，也不会调用外部网络。可在 `http://127.0.0.1:4173` 启动该边界：

```powershell
pnpm run serve:e2e
```

## 语音唤醒

进入看板并允许使用麦克风后，说 **Hi Karen** 或 **嗨，凯伦** 唤醒 AI 运营助手。唤醒词由项目内的中英双语模型在本地检测。[Sherpa-ONNX 模型来源](https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2) · [模型许可证](models/kws/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/LICENSE)

## 测试

```powershell
pnpm run test --run
pnpm run test:server
pnpm run test:e2e:mocked
pnpm run test:e2e:integration
pnpm run build
```

可在 `server/.env` 中配置 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL` 和 `DEEPSEEK_MODEL`；`DEEPSEEK_MODEL` 未配置时默认为 `deepseek-chat`。密钥、工作簿路径和原始文件字节不会进入客户端状态、模型提示或 API 响应。

实时语音识别使用阿里云百炼 `qwen3.5-omni-flash-realtime`；报告讲解独立使用专业口播模型 `qwen-audio-3.0-tts-plus`，默认采用旗舰中文女声 `longanlingxin`。合成前会按句子语义分配克制的情感标签：异常与风险转为严肃语气，建议与行动项转为温和但坚定的语气；另通过中文语种提示和自然口播指令控制节奏、换气、数字重音与句尾降调。在 `server/.env` 中配置 `DASHSCOPE_API_KEY` 和 `DASHSCOPE_WORKSPACE_ID`，两条链路共用同一组百炼凭证。可通过 `QWEN_OMNI_MODEL` 和 `QWEN_OMNI_BASE_URL` 覆盖识别模型与接口，通过 `DASHSCOPE_TTS_MODEL`、`DASHSCOPE_TTS_BASE_URL` 和 `DASHSCOPE_TTS_VOICE` 覆盖口播模型、接口与音色。Qwen-Audio-TTS 的 HTTP 合成仅支持北京地域。浏览器只连接本地语音网关，百炼凭证不会发送到客户端。
