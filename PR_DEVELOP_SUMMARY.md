# PR Summary vs develop

## Verified functionality

- Verified single-agent survival and construction flows.
- Verified voice broadcast / narration behavior.
- Verified multiple agents can run concurrently while cooperating with each other.
- Tested and passed mainstream provider protocols: OpenAI Chat, OpenAI Responses, Gemini, and Anthropic-compatible messages.
- Verified both user-sent messages and agent-to-agent messages still hit the conversation cache after branching/interruption.

This PR updates Mindcraft from the legacy text-command/provider layout toward a native tool-calling runtime with richer multi-agent traceability and broader provider support.

## Functional changes

- Adds native function/tool calling for agent actions, including structured tool calls/results in conversation history.
- Adds native ChatGPT Codex login support, enabling the Codex/ChatGPT Responses transport through a ChatGPT account login flow.
- Adds provider-registry based LLM configuration via `settings_llm_providers.json`, including Kimi, MiniMax, OpenRouter, Gemini, Codex, Replicate, and other presets.
- Splits editable default prompts into markdown files under `profiles/defaults/prompts/` for easier review and prompt maintenance.
- Improves message priority handling so user/admin messages interrupt active actions before the next model turn.
- Makes `newAction`/coding requests independent from the main conversation request path so coding does not pollute conversation cache/state.
- Adds bot-to-bot response branching (`botResponder`) that forks the current conversation context instead of rebuilding or replacing the system prompt.
- Expands Runtime UI trace rendering for native tool calls, tool results, branch decisions, token/cache metadata, and active tool status.

## Review notes

- The largest review surface is in `src/agent/`, `src/models/`, and `src/mindcraft/public/index.html`.
- New test coverage was added for native tools, provider config, Codex ChatGPT transport, conversation queueing, trace projection, token usage, and prompt hygiene.
- `settings.js` is updated as the working template and enables the current multi-agent preset profiles.

## Verification

- Targeted native-tool/Codex/prompt tests have been run successfully.
- ESLint has been run on the recently changed implementation and test files.
