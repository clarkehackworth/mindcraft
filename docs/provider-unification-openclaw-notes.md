# Provider / Native Tool Calling 迁移调研记录

日期：2026-04-29
分支：`native-tool`（基于 `develop`）
参考代码：OpenClaw 源码只读调研；未安装 OpenClaw 依赖。
验证 key 来源：`enhanced-coding-system` 工作区的 `keys.json` / 环境变量（只记录 key 名称，不记录密钥值）。

## 结论

OpenClaw 不是靠一个“统一 JS 库一键接入所有 API”的简单方式完成多 provider 支持；它的核心是：

1. **Provider Plugin 架构**：每个 provider 用插件声明 catalog、auth、动态模型解析、transport、tool schema 兼容、stream wrapper、usage/auth 等 hook。
2. **少量核心 transport family**：OpenAI Responses、OpenAI Chat Completions、Anthropic Messages、Google Generative AI、Azure Responses 等作为主通道；特殊 provider 再用 plugin hook 覆盖。
3. **Provider-family 兼容层**：tool schema、history/replay、reasoning/thinking、usage、streaming 差异集中在 provider hook，而不是散在业务代码里。
4. **独立 CLI/Dev 验证面**：`infer` / `models status --probe` 这类无业务环境的探针可验证 auth、模型、基础调用能力。

对 Mindcraft 来说，可迁移的不是“复制 OpenClaw 全套”，而是借鉴它的层次：

- `provider registry`：统一 provider metadata、key 名称、baseURL、默认模型、能力 flags。
- `transport adapter`：OpenAI-compatible / Anthropic / Gemini / Ollama / special SDK 分开。
- `tool schema adapter`：从 Mindcraft command/action/query 生成 canonical tool schema，再按 provider family 转换。
- `tool response normalizer`：所有 provider 的 tool call 输出归一到同一种内部结构。
- `dev probe mode`：不接 Minecraft，仅跑 `model -> native tool_call -> command adapter/mock tool -> result`。

## OpenClaw 源码观察

### 关键文件

- `src/plugins/types.ts`
  - `ProviderPlugin` 定义了 provider 的扩展点：catalog、auth、dynamic model、transport、tool schemas、stream wrapper、usage、cache、reasoning 等。
  - `registerProvider` 是 provider 注册入口。
- `src/plugins/provider-runtime.ts`
  - Provider runtime resolver / hook dispatcher。
  - 统一调用 `normalizeToolSchemas`、`normalizeTransport`、`resolveProviderStreamFn` 等 hook。
- `src/agents/pi-embedded-runner/model.ts`
  - model resolution pipeline：模型解析、auth、provider runtime normalization。
- `src/agents/provider-stream.ts`
  - 选择 provider 自定义 stream function；没有自定义时走 transport-aware stream。
- `src/agents/provider-transport-stream.ts`
  - 内置 transport family：OpenAI Responses、OpenAI Chat Completions、Anthropic Messages、Google Generative AI、Azure Responses。
- `src/plugin-sdk/provider-entry.ts`
  - `defineSingleProviderPluginEntry` 用少量配置快速定义普通 API-key provider。
- `src/plugin-sdk/provider-tools.ts`
  - `buildProviderToolCompatFamilyHooks("openai" | "gemini")`。
  - OpenAI strict schema / Gemini schema cleaning 等兼容逻辑集中在这里。
- `src/plugin-sdk/provider-model-shared.ts`
  - replay/history policy family：`openai-completions`、`anthropic-by-model`、`google-generative-ai` 等。
- `extensions/openrouter/index.ts`
  - 动态模型、OpenRouter 能力探测、stream wrapper、media/image/video/speech provider。
- `extensions/litellm/index.ts`
  - LiteLLM gateway provider，说明 gateway 也按 provider plugin 接入。
- `extensions/qwen/index.ts`
  - DashScope/Qwen provider 多 auth method、catalog、OpenAI-family 兼容、特殊模型限制处理。
- `extensions/openai/index.ts`
  - OpenAI / OpenAI Codex provider，并复用 OpenAI tool compat family hooks。

### OpenClaw 多 API 支持方式

OpenClaw 支持大量 provider 的原因主要不是 SDK 数量，而是 metadata + hook 分层：

| 层 | 职责 | Mindcraft 可借鉴点 |
| --- | --- | --- |
| Manifest/catalog | provider id、模型、能力、auth/env key | 把 `profiles/*.json` 中散落的 api/model/url/key 合并成 provider registry |
| Auth resolver | key 从 profile/env/auth store 解析 | 继续兼容 `keys.json`，但 provider 自己声明 key name |
| Transport | OpenAI-compatible / Anthropic / Gemini / Ollama 等 | Mindcraft 先实现 3-4 个 family，不需要一开始支持全部 |
| Tool compat | schema 清洗、provider-native tool 格式 | 把当前各 `src/models/*.js` 内的 tool 转换移出去 |
| Response normalizer | 把各 provider 输出归一 | 统一返回 `{ id, name, arguments }`，不再让模型层拼 `_native_tool_calls` JSON 字符串 |
| Probe/dev CLI | 无业务环境验证模型和 auth | Mindcraft dev mode 不连 Minecraft 也能测试 LLM + tool loop |

## Mindcraft 当前可迁移基础

Enhanced 分支已经有原型，但耦合较重：

- `src/models/gpt.js`：OpenAI-compatible `tools` / `tool_choice`，返回 typed native tool response object。
- `src/models/claude.js`：Anthropic `tools` / `tool_use` 转 OpenAI-like tool call。
- `src/models/gemini.js`：Gemini `functionDeclarations` 与返回转换。
- `src/models/groq.js`、`src/models/cerebras.js`、`src/models/mistral.js`、`src/models/hyperbolic.js` 等：各自内联 tool calling 差异。
- `src/models/prompter.js`：根据 `profile.use_native_tools` 决定传原生 tools，或退回 prompt/XML 工具文本。
- `src/agent/tools/toolManager.js`：coding tools 的 prompt/json 工具系统。
- `src/agent/commands/actions.js` / `src/agent/commands/queries.js`：Minecraft command 定义已有 `name/description/params/perform`，适合作为 function schema 生成源。
- `src/utils/keys.js`：只从 `keys.json` 或环境变量取 key，适合被 provider registry 复用。

主要问题：

1. tool schema 转换散落在各 model adapter。
2. enhanced 原型里 tool call 结果曾用 JSON 字符串伪装成普通 LLM 文本；本分支应改为 typed object，避免调用链不够类型安全。
3. provider 能力未知；`use_native_tools` 是 profile 级布尔值，缺少 provider/model 级能力探测。
4. OpenAI-compatible provider 共享逻辑没有统一抽象。
5. 没有独立 dev/probe surface，导致验证 LLM 能力通常要走 Minecraft agent 流程。

## 本地 key 安全发现结果

只发现以下可用 key（未输出密钥值）：

| Key 名称 | 来源 | 备注 |
| --- | --- | --- |
| `QWEN_API_KEY` | `enhanced-coding-system/keys.json` | 已做 live probe |

未发现/未配置，因此本轮跳过：

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY` / `GOOGLE_API_KEY`
- `OPENROUTER_API_KEY`
- `DEEPSEEK_API_KEY`
- `GROQCLOUD_API_KEY`
- `CEREBRAS_API_KEY`
- `XAI_API_KEY`
- `MISTRAL_API_KEY`
- `HUGGINGFACE_API_KEY`
- `HYPERBOLIC_API_KEY`
- `NOVITA_API_KEY`
- `MERCURY_API_KEY`
- `REPLICATE_API_KEY`
- `AZURE_OPENAI_API_KEY`

## API 验证结果

验证方式：不安装 OpenClaw，使用 Mindcraft enhanced 工作区现有依赖 / Node fetch 直接访问 DashScope OpenAI-compatible endpoint。

Endpoint：`https://dashscope.aliyuncs.com/compatible-mode/v1`
模型：`qwen-max`
Embedding 模型：`text-embedding-v3`

| Provider | 能力 | 结果 | 证据 |
| --- | --- | --- | --- |
| Qwen / DashScope | Chat completions | 通过 | `POST /chat/completions`，`qwen-max` 返回 `pong` |
| Qwen / DashScope | OpenAI-compatible native tools | 通过 | `tool_choice` 指定 `report_status`，finish_reason=`tool_calls`，返回 `report_status({status:"ok"})` |
| Qwen / DashScope | Embeddings | 通过 | `POST /embeddings`，`text-embedding-v3` 返回 1024 维向量 |
| Mindcraft `Qwen` adapter | native tools 贯通 | 通过 | `src/models/qwen.js` 继承 `GPT.sendRequest(..., tools)`，本分支归一返回 typed `tool_calls` object |

## 对 native-tool 分支的建议实现边界

### 第一阶段：只抽 native tool 基础，不重写所有 provider

建议先做薄迁移：

1. 新增 `src/models/providerRegistry.js`
   - provider id、key name、default baseURL、default model、transport family、tool support flags。
2. 新增 `src/models/toolSchemas.js`
   - canonical schema：OpenAI-style function schema。
   - `commands/actions/queries -> tools` 生成器。
3. 新增 `src/models/toolAdapters.js`
   - `openai`：基本 passthrough + strict schema 清理。
   - `anthropic`：`{name, description, input_schema}`。
   - `gemini`：`functionDeclarations` + schema 清理。
4. 新增 `src/models/toolCalls.js`
   - `normalizeOpenAIToolCalls` / `normalizeAnthropicToolUse` / `normalizeGeminiFunctionCall`。
   - 返回结构不要再是 JSON 字符串，改为 typed object，例如：
     ```js
     { type: 'tool_calls', calls: [{ id, name, arguments }] }
     ```
5. 保留人类 `!command` parser。
   - 人类聊天输入仍可走 `!command`。
   - AI 输出不再鼓励/依赖 `!command`。
6. 临时 fallback。
   - provider 不支持 native tools 时，允许短期文本/XML fallback，但需要明确 log/标记，后续可关闭。

### 第二阶段：dev mode / probe

新增不接 Minecraft 的验证命令或脚本：

- `npm run dev:tool-loop`（mock，无 Minecraft）或后续扩展为 `node scripts/dev-tool-loop.js --profile profiles/qwen-cn.json`
- 输入固定 prompt：要求模型调用一个 mock command/tool。
- 流程：profile -> provider adapter -> native tool call -> mock executor -> normalized result。
- 验收标准：不用 Minecraft 进程，也能证明 LLM 原生工具调用链可跑通。

### 第三阶段：Prompt/Profile 外置到 Markdown

按已确认需求分两步：

1. 机械转换：从 `develop` 的 JSON prompt 原文生成 Markdown，机器校验内容等价。
2. 语义修改：把提示词中“AI 用 `!command` 调工具”的要求改成“AI 使用原生 tools/function call”。

这样既满足“不要手写导致漏内容”，又允许迁移后去掉 AI 文本命令指导。

## 是否值得引入统一第三方库

暂不建议把 Mindcraft 的第一阶段迁移押注在某个“一键统一 API”库上：

- OpenClaw 自己也不是单库解决，而是 provider plugin + transport family。
- Mindcraft 已经有多 provider adapter，先抽公共层风险更低。
- 真正痛点是 tool schema/response/history/prompt 的兼容，不只是 HTTP 调用。
- Gateway 方案（OpenRouter / LiteLLM / Vercel AI Gateway）可以作为 provider 加入 registry，而不是替代本地 provider abstraction。

可评估但不应阻塞第一阶段：

- LiteLLM gateway：作为“100+ provider”后端入口。
- OpenRouter：动态模型与多 provider 入口。
- Vercel AI SDK / AI Gateway：如果未来要统一 JS SDK，可单独做 spike；但 Mindcraft 当前已有 provider 文件，直接重写成本较高。

## Skipped / TODO

- 未安装 OpenClaw 依赖；本轮只读源码。
- 除 Qwen 外，本地未发现可用 key，未做 live API probe。
- 未测试 Minecraft agent loop；本轮只验证 LLM/API/tool-call 基础能力。
- 未测试 streaming/tool-result continuation，多轮 tool loop 需要后续 dev mode 覆盖。
