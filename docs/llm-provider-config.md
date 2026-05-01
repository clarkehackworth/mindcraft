# LLM Provider 配置说明

`llm_providers.json` 是项目级模型注册表，profile 只负责选择注册表里的 provider id 和模型名。

## 核心规则

- `models.<providerId>` 注册聊天/代码模型供应商。
- `embeddings.<providerId>` 注册嵌入模型供应商，和聊天模型分开。
- `keys.<KEY_NAME>` 保存密钥值；provider 用 `keyName` 指向它。
- `format` 写真实 API 协议/端点格式，例如：
  - `openai-completions`
  - `openai-responses`
  - `anthropic-messages`
  - `google-generative-ai`
  - `openai-embeddings`
- `name` 不需要；provider id 本身就是用户选择时使用的名字。
- 不需要模型名映射表；profile 里的 `model` 会原样传给对应 provider。

## 添加一个 OpenAI Chat Completions 兼容服务

在 `keys` 中添加：

```json
"MY_PROVIDER_API_KEY": ""
```

在 `models` 中添加：

```json
"my_provider": {
    "format": "openai-completions",
    "baseUrl": "https://api.example.com/v1",
    "keyName": "MY_PROVIDER_API_KEY"
}
```

profile 中选择：

```json
"model": {
    "provider": "my_provider",
    "model": "vendor/model-name"
}
```

这里的 `my_provider` 就是用户自定义 provider 名字；`vendor/model-name` 不会被额外映射或改写。

## 地区型 Provider 和 Profile

OpenClaw 的做法是：provider id 保持 canonical（例如 `qwen` / `minimax`），在 onboarding/auth-choice 中选择 China 或 Global，然后把同一个 provider 写成不同 baseUrl。Mindcraft 当前没有交互式 onboarding wizard，所以预置 profile 直接拆成地区版本，避免用户选错 endpoint：

- `profiles/qwen-cn.json` -> `provider: "qwen_cn"`
- `profiles/minimax-cn.json` -> `provider: "minimax_cn"`
- `profiles/minimax-intl.json` -> `provider: "minimax_intl"`

规则：

- 中国区 key/账号通常选 `_cn`。
- 国际区 key/账号通常选 `_intl`；当前预置只保留 MiniMax 国际区，Qwen 只保留中国区 key。
- 同一厂商的 CN/Intl key 不一定通用；如果 live test 出现 401，优先检查是否选错地区。
- 不要用模糊的 `qwen.json` / `minimax.json` 作为预置 profile 名称。

## MiniMax

MiniMax 走 OpenAI Chat Completions 兼容协议，按地区拆成两个 provider：

```json
"minimax_intl": {
    "format": "openai-completions",
    "baseUrl": "https://api.minimax.io/v1",
    "keyName": "MINIMAX_INTL_API_KEY",
    "defaultModel": "MiniMax-M2.7"
},
"minimax_cn": {
    "format": "openai-completions",
    "baseUrl": "https://api.minimaxi.com/v1",
    "keyName": "MINIMAX_CN_API_KEY",
    "defaultModel": "MiniMax-M2.7"
}
```

profile 中按地区选择 `minimax_intl` 或 `minimax_cn`。

## Kimi Coding

Kimi Coding 在官方文档中提供两类第三方 Coding Agent 接入方式。实测 OpenAI-compatible coding 入口会校验客户端身份；为了不伪造 User-Agent，这里使用同页 Claude Code 兼容入口，对应真实协议是 Anthropic Messages：

```json
"kimi": {
    "format": "anthropic-messages",
    "baseUrl": "https://api.kimi.com/coding/",
    "keyName": "KIMI_API_KEY",
    "defaultModel": "kimi-for-coding",
    "params": {
        "max_tokens": 32768,
        "provider": "kimi"
    }
}
```

profile 中选择 `provider: "kimi"`，模型默认可用 `kimi-for-coding`。

## 本地 Ollama

Ollama 使用 OpenAI-compatible 端点即可，不需要单独的 `ollama-chat` 配置格式：

```json
"ollama": {
    "format": "openai-completions",
    "baseUrl": "http://127.0.0.1:11434/v1"
}
```

Embedding 同样使用 OpenAI embeddings 端点：

```json
"ollama": {
    "format": "openai-embeddings",
    "baseUrl": "http://127.0.0.1:11434/v1",
    "defaultModel": "embeddinggemma"
}
```

本地 Ollama 不需要 `keyName`。

## Embedding 配置原则

预制 profile 不应该在同一个文件里静默依赖另一个供应商的 embedding。也就是说：

- 如果模型供应商自己有 embedding provider，profile 可以写同名 embedding，例如 `qwen_cn` + `qwen_cn`。
- 如果模型供应商没有 embedding provider，预制 profile 先不要写 `embedding` 字段，系统会在 embedding 不可用时回退到词重叠检索。
- 用户确实想跨供应商使用 embedding 时，可以自己在本地 profile 里显式添加。

MiniMax 当前官方文档索引里没有独立 Embeddings API / embedding 模型页面，所以 `profiles/minimax-cn.json` 和 `profiles/minimax-intl.json` 不预设 embedding。

## 添加 Embedding 服务

在 `embeddings` 中单独注册：

```json
"my_embedding_provider": {
    "format": "openai-embeddings",
    "baseUrl": "https://api.example.com/v1",
    "defaultModel": "text-embedding-model-name",
    "keyName": "MY_EMBEDDING_API_KEY"
}
```

profile 中选择：

```json
"embedding": {
    "provider": "my_embedding_provider",
    "model": "text-embedding-model-name"
}
```
