# enhanced-coding-system 相对 develop 的改动分析

记录日期：2026-04-29
仓库：`/Users/Ninot/NinotQuyi/mindcraft`
分析 worktree：`/Users/Ninot/NinotQuyi/mindcraft-enhanced-coding-system`

## 分析范围

已执行远端同步：

```bash
git fetch --all --prune --tags
```

对比对象：

```text
origin/develop:                 8acbd90 Merge pull request #761 from domdomegg/update-model-ids
origin/enhanced-coding-system:  ec5bd0f refactor: use template method pattern to decouple API key dependencies
merge-base:                     d54eec6
```

分支关系：

```text
develop 相比 enhanced 多 55 个提交
enhanced 相比 develop 分叉点多 99 个提交
```

主要使用 PR/feature-branch 语义的三点 diff：

```bash
git diff origin/develop...HEAD
```

统计结果：

```text
79 files changed, 5262 insertions(+), 1017 deletions(-)
```

补充说明：原始工作目录 `/Users/Ninot/NinotQuyi/mindcraft` 存在未提交修改和未跟踪文件；本文档记录的是干净 worktree 中 `origin/enhanced-coding-system` 相对 `origin/develop` 的分支 diff，不包含本地未提交内容。

---

## 总体结论

`enhanced-coding-system` 是一次围绕 **Coding Agent 工具化、Native Tool Calling、多模型工具调用适配、Prompt/Profile 重构、执行安全边界、Learned Skills、以及 Minecraft 行为可靠性增强** 的大规模功能分支。

可以划分为以下主要功能模块：

1. Coding Agent 工具化重构
2. Native Tool Calling 支持
3. Prompt/Profile 外置与重构
4. Coding 安全边界与 Workspace 限制
5. Learned Skills 持久化技能系统
6. Minecraft 生存/建造/查询能力增强
7. Provider/Profile 生态扩展
8. 依赖与 SDK 更新

---

## 1. Coding Agent 工具化重构

核心新增目录：

```text
src/agent/tools/
```

新增工具文件：

```text
edit.js
execute.js
finishCoding.js
glob.js
grep.js
lint.js
ls.js
multiEdit.js
read.js
todoWrite.js
toolManager.js
tools-prompt.md
write.js
```

主要变化：

- 将原本“直接生成 JavaScript codeblock”的 coding 模式改造成工具调用式工作流。
- 新增 `Read / Write / Edit / MultiEdit / Execute / Lint / Grep / Glob / LS / TodoWrite / FinishCoding` 等工具。
- `ToolManager` 负责：
  - JSON tool response 解析；
  - native tool calls 转换；
  - 工具执行调度；
  - 工作区路径校验；
  - todo / learned skills 提醒。
- `ExecuteTool` 负责：
  - 执行 bot action-code JavaScript 文件；
  - 执行前 lint 检查；
  - IIFE 格式校验；
  - 超时处理；
  - 错误栈映射；
  - 捕获 bot chat/output；
  - 执行失败时返回更详细错误信息。

代表文件：

```text
src/agent/coder.js
src/agent/tools/toolManager.js
src/agent/tools/execute.js
src/models/prompter.js
profiles/defaults/prompts/coding.md
```

---

## 2. Native Tool Calling 模型适配层

大量模型的 `sendRequest` 签名被扩展为支持 tools 参数：

```js
sendRequest(turns, systemMessage, stop_seq, tools)
```

受影响模型：

```text
src/models/gpt.js
src/models/claude.js
src/models/gemini.js
src/models/groq.js
src/models/grok.js
src/models/cerebras.js
src/models/mistral.js
src/models/huggingface.js
src/models/ollama.js
src/models/replicate.js
src/models/hyperbolic.js
src/models/novita.js
src/models/azure.js
src/models/openrouter.js
src/models/mercury.js
src/models/qwen.js
src/models/vllm.js
```

主要变化：

- OpenAI-compatible 模型支持 `tools`。
- 模型返回 `_native_tool_calls` JSON。
- `Prompter.promptCoding()` 将 native tool calls 转成内部 JSON tools 格式。
- 支持在 profile 中切换：
  - native tools API；
  - prompt-engineering tools 格式。
- `GPT` 引入 template method pattern：
  - `initClient()`；
  - 子类只覆盖 client 初始化，减少 provider 间重复逻辑。

代表文件：

```text
src/models/gpt.js
src/models/prompter.js
src/models/azure.js
src/models/openrouter.js
src/models/mercury.js
```

---

## 3. Coding Prompt / Profile 配置重构

默认 profile 从内联长 prompt 改成外部 Markdown 文件：

```text
profiles/defaults/prompts/coding.md
profiles/defaults/prompts/conversing.md
profiles/defaults/prompts/bot_responder.md
profiles/defaults/prompts/image_analysis.md
profiles/defaults/prompts/saving_memory.md
```

`profiles/defaults/_default.json` 改为引用 prompt 文件路径：

```json
"coding": "profiles/defaults/prompts/coding.md",
"conversing": "profiles/defaults/prompts/conversing.md",
"tools_manual": "src/agent/tools/tools-prompt.md"
```

主要作用：

- 提升 coding prompt 的可维护性。
- 将 tool 使用规范独立成文档。
- 新增 `$TOOLS`、`$CODING_GOAL` 等占位符。
- coding examples 从 JavaScript codeblock 改成 JSON tools 调用示例。

代表文件：

```text
profiles/defaults/_default.json
profiles/defaults/prompts/coding.md
src/agent/tools/tools-prompt.md
src/models/prompter.js
```

---

## 4. Coding 安全边界 / Workspace 限制

新增配置：

```js
"code_workspaces": [
  "bots/{BOT_NAME}/action-code",
  "bots/{BOT_NAME}/learnedSkills",
  "bots/{BOT_NAME}/"
]
```

主要作用：

- 限制 AI 只能在允许目录中读写/执行文件。
- `ToolManager.validateWorkspaces()` 对 `file_path` 做校验。
- coding 生成的动作代码主要放到：

```text
bots/{BOT_NAME}/action-code
```

代表文件：

```text
settings.js
src/agent/tools/toolManager.js
src/agent/tools/write.js
src/agent/tools/edit.js
src/agent/tools/execute.js
```

---

## 5. Learned Skills 动态技能系统

新增文件：

```text
src/agent/library/learnedSkillsManager.js
```

主要能力：

- 从每个 bot 的目录加载自定义 learned skills：

```text
bots/{botName}/learnedSkills/
```

- 校验 learned skill 文件内容。
- 提取 JSDoc / function signature 作为 skill docs。
- 合并到原有 `SkillLibrary` 的相关技能检索中。
- coding prompt 中新增 learned skills 规范。

代表文件：

```text
src/agent/library/learnedSkillsManager.js
src/agent/library/skill_library.js
profiles/defaults/prompts/coding.md
```

---

## 6. Minecraft 行为能力增强与可靠性修复

改动集中在：

```text
src/agent/library/skills.js
src/agent/library/world.js
src/agent/modes.js
src/agent/commands/actions.js
src/agent/commands/queries.js
```

主要内容：

- 新增 `world.getBuildingStructure()`，让 LLM 能读取建筑结构。
- `!nearbyBlocks` 输出更丰富的水、岩浆和环境状态。
- `getNearestBlocksWhere()` 支持 function 或 block id array。
- 多处循环增加 `bot.interrupt_code` 检查。
- `unstuck` 模式改成随机附近位置多次尝试。
- `self_preservation` 对火、岩浆、水、下落方块处理更强。
- action/mode 执行增加 catch，避免 floating promise 崩溃。
- `!newAction` 描述改为工具式 coding 工作流。
- 增加 cheat mode 支持和部分动作返回值细化。

代表文件：

```text
src/agent/library/world.js
src/agent/library/skills.js
src/agent/modes.js
src/agent/commands/actions.js
src/agent/commands/queries.js
```

---

## 7. Provider / Profile 扩展

新增或扩展多个 profile：

```text
profiles/cerebras.json
profiles/groq.json
profiles/huggingface.json
profiles/hyperbolic.json
profiles/novita.json
profiles/ollama.json
profiles/openrouter.json
```

同时修改：

```text
profiles/gpt.json
profiles/claude.json
profiles/gemini.json
profiles/qwen.json
profiles/grok.json
profiles/mistral.json
profiles/deepseek.json
profiles/azure.json
...
```

主要内容：

- 新增更多 LLM provider profile。
- 给不同 provider 配置 tool calling / model 参数。
- 调整部分 stop sequence，避免和 patch/tool 格式冲突。
- 默认 profile 中降低部分自保/战斗模式默认开启程度。

---

## 8. 依赖与 SDK 更新

`package.json` 新增/更新依赖：

```text
@huggingface/inference: ^4.11.3
axios
diff
glob
minimatch
tree-sitter
tree-sitter-bash
```

大致用途：

- HuggingFace 新 SDK。
- 文件 glob / minimatch。
- diff/edit 工具。
- lint / shell 分析相关能力。
- HTTP provider 支持。

---

## 重要文件变更概览

按 churn 排名前列的文件包括：

```text
src/agent/tools/execute.js              755 lines added
src/agent/tools/toolManager.js          497 lines added
profiles/defaults/prompts/coding.md     412 lines added
src/agent/coder.js                      345 lines changed
src/agent/tools/tools-prompt.md         308 lines added
src/agent/library/skills.js             261 lines changed
src/agent/library/learnedSkillsManager.js 232 lines added
src/agent/tools/lint.js                 225 lines added
src/agent/tools/todoWrite.js            182 lines added
src/agent/tools/grep.js                 173 lines added
src/agent/library/world.js              166 lines changed
src/models/prompter.js                  146 lines changed
```

---

## 一句话总结

`enhanced-coding-system` 的核心价值是：把 Mindcraft 的 coding 模式从“一次性代码块生成器”升级为“带工具调用、文件编辑、执行反馈、错误修复、待办管理、learned skills 和多模型 native tool calls 支持的 agentic coding system”，同时增强 Minecraft 世界查询、生存自保、unstuck 和 provider profile 生态。
