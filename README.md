<h1 align="center">🧠mindcraft⛏️</h1>
<h1 align="center">
  <a href="https://trendshift.io/repositories/14816" target="_blank"><img src="https://trendshift.io/api/badge/repositories/14816" alt="mindcraft-bots%2Fmindcraft | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>
</h1>

<p align="center">Crafting minds for Minecraft with LLMs and <a href="https://prismarinejs.github.io/mineflayer/#/">Mineflayer!</a></p>

<p align="center">
  <a href="https://github.com/mindcraft-bots/mindcraft/blob/main/FAQ.md">FAQ</a> | 
  <a href="https://discord.gg/mp73p35dzC">Discord Support</a> | 
  <a href="https://www.youtube.com/watch?v=gRotoL8P8D8">Video Tutorial</a> | 
  <a href="https://kolbynottingham.com/mindcraft/">Blog Post</a> | 
  <a href="https://mindcraft-minecollab.github.io/index.html">Paper Website</a> | 
  <a href="https://github.com/mindcraft-bots/mindcraft/blob/main/minecollab.md">MineCollab</a>
</p>

> [!Caution]
Do not connect this bot to public servers with coding enabled. This project allows an LLM to write/execute code on your computer. The code is sandboxed, but still vulnerable to injection attacks. Code writing is disabled by default, you can enable it by setting `allow_insecure_coding` to `true` in `settings.js`. Ye be warned.

# Getting Started
## Requirements

- [Minecraft Java Edition](https://www.minecraft.net/en-us/store/minecraft-java-bedrock-edition-pc) (up to v1.21.11, recommend v1.21.6)
- [Node.js Installed](https://nodejs.org/) (Node v18 or v20 LTS recommended. Node v24+ may cause issues with native dependencies)
- At least one API key from a supported API provider. See [supported APIs](#model-customization). OpenAI is the default.

> [!Important]
> If installing node on windows, ensure you check `Automatically install the necessary tools`
>
> If you encounter `npm install` errors on macOS, see the [FAQ](FAQ.md#common-issues) for troubleshooting native module build issues

## Install and Run

1. Make sure you have the requirements above.

2. Download the [latest release](https://github.com/mindcraft-bots/mindcraft/releases/latest) and unzip it, or clone the repository.

3. Rename `keys.example.json` to `keys.json` and fill in your API keys (you only need one). The desired model is set in `andy.json` or other profiles. For other models refer to the table below.

4. In terminal/command prompt, run `npm install` from the installed directory

5. Start a minecraft world and open it to LAN on localhost port `55916`

6. Run `node main.js` from the installed directory

If you encounter issues, check the [FAQ](https://github.com/mindcraft-bots/mindcraft/blob/main/FAQ.md) or find support on [discord](https://discord.gg/mp73p35dzC). We are currently not very responsive to github issues. To run tasks please refer to [Minecollab Instructions](minecollab.md#installation)


# Configuration
## Model Customization

You can configure project details in `settings.js`. [See file.](settings.js)

You can configure the agent's name, model, and prompts in their profile like `andy.json`. The model can be specified with the `model` field, with values like `model: "gemini-2.5-pro"`. You will need the correct API key for the API provider you choose. See all supported APIs below.

<details>
<summary><strong>⭐ VIEW SUPPORTED APIs ⭐</strong></summary>

| API Name | Config Variable| Docs |
|------|------|------|
| `openai` | `OPENAI_API_KEY` | [docs](https://platform.openai.com/docs/models) |
| `google` | `GEMINI_API_KEY` | [docs](https://ai.google.dev/gemini-api/docs/models/gemini) |
| `anthropic` | `ANTHROPIC_API_KEY` | [docs](https://docs.anthropic.com/claude/docs/models-overview) |
| `xai` | `XAI_API_KEY` | [docs](https://docs.x.ai/docs) |
| `deepseek` | `DEEPSEEK_API_KEY` | [docs](https://api-docs.deepseek.com/) |
| `ollama` (local) | n/a | [docs](https://ollama.com/library) |
| `qwen` | `QWEN_API_KEY` | [Intl.](https://www.alibabacloud.com/help/en/model-studio/developer-reference/use-qwen-by-calling-api)/[cn](https://help.aliyun.com/zh/model-studio/getting-started/models) |
| `mistral` | `MISTRAL_API_KEY` | [docs](https://docs.mistral.ai/getting-started/models/models_overview/) |
| `replicate` | `REPLICATE_API_KEY` | [docs](https://replicate.com/collections/language-models) |
| `groq` (not grok) | `GROQCLOUD_API_KEY` | [docs](https://console.groq.com/docs/models) |
| `huggingface` | `HUGGINGFACE_API_KEY` | [docs](https://huggingface.co/models) |
| `novita` | `NOVITA_API_KEY` | [docs](https://novita.ai/model-api/product/llm-api?utm_source=github_mindcraft&utm_medium=github_readme&utm_campaign=link) |
| `openrouter` | `OPENROUTER_API_KEY` | [docs](https://openrouter.ai/models) |
| `glhf` | `GHLF_API_KEY` | [docs](https://glhf.chat/user-settings/api) |
| `hyperbolic` | `HYPERBOLIC_API_KEY` | [docs](https://docs.hyperbolic.xyz/docs/getting-started) |
| `vllm` | n/a | n/a |
| `cerebras` | `CEREBRAS_API_KEY` | [docs](https://inference-docs.cerebras.ai/introduction) |
| `mercury` | `MERCURY_API_KEY` | [docs](https://www.inceptionlabs.ai/) |

</details>

For more comprehensive model configuration and syntax, see [Model Specifications](#model-specifications).

For local models we support [ollama](https://ollama.com/) and we provide our own finetuned models for you to use. 
To install our models, install ollama and run the following terminal command:
```bash
ollama pull sweaterdog/andy-4:micro-q8_0 && ollama pull embeddinggemma
```

## Online Servers
To connect to online servers your bot will need an official Microsoft/Minecraft account. You can use your own personal one, but will need another account if you want to connect too and play with it. To connect, change these lines in `settings.js`:
```javascript
"host": "111.222.333.444",
"port": 55920,
"auth": "microsoft",

// rest is same...
```
> [!Important]
> The bot's name in the profile.json must exactly match the Minecraft profile name! Otherwise the bot will spam talk to itself.

To use different accounts, Mindcraft will connect with the account that the Minecraft launcher is currently using. You can switch accounts in the launcher, then run `node main.js`, then switch to your main account after the bot has connected.

## Tasks

Tasks automatically start the bot with a prompt and a goal item to acquire or blueprint to construct. To run a simple task that involves collecting 4 oak_logs run 

`node main.js --task_path tasks/basic/single_agent.json --task_id gather_oak_logs`

Here is an example task json format: 

```
{
    "gather_oak_logs": {
      "goal": "Collect at least four logs",
      "initial_inventory": {
        "0": {
          "wooden_axe": 1
        }
      },
      "agent_count": 1,
      "target": "oak_log",
      "number_of_target": 4,
      "type": "techtree",
      "max_depth": 1,
      "depth": 0,
      "timeout": 300,
      "blocked_actions": {
        "0": [],
        "1": []
      },
      "missing_items": [],
      "requires_ctable": false
    }
}
```

The `initial_inventory` is what the bot will have at the start of the episode, `target` refers to the target item and `number_of_target` refers to the number of target items the agent needs to collect to successfully complete the task. 

If you want more optimization and automatic launching of the minecraft world, you will need to follow the instructions in [Minecollab Instructions](minecollab.md#installation)

## Docker Container

If you intend to `allow_insecure_coding`, it is a good idea to run the app in a docker container to reduce risks of running unknown code. This is strongly recommended before connecting to remote servers, although still does not guarantee complete safety.

```bash
docker build -t mindcraft . && docker run --rm --add-host=host.docker.internal:host-gateway -p 8080:8080 -p 3000-3003:3000-3003 -e SETTINGS_JSON='{"auto_open_ui":false,"profiles":["./profiles/gemini.json"],"host":"host.docker.internal"}' --volume ./keys.json:/app/keys.json --name mindcraft mindcraft
```
or simply
```bash
docker-compose up --build
```

When running in docker, if you want the bot to join your local minecraft server, you have to use a special host address `host.docker.internal` to call your localhost from inside your docker container. Put this into your [settings.js](settings.js):

```javascript
"host": "host.docker.internal", // instead of "localhost", to join your local minecraft from inside the docker container
```

To connect to an unsupported minecraft version, you can try to use [viaproxy](services/viaproxy/README.md)

# Bot Profiles

Bot profiles are json files (such as `andy.json`) that define:

1. Bot backend LLMs to use for talking, coding, and embedding.
2. Prompts used to influence the bot's behavior.
3. Examples help the bot perform tasks.

## Model Specifications

LLM models can be specified simply as `"model": "gpt-5.4"`, or more specifically with `"{api}/{model}"`, like `"openrouter/google/gemini-2.5-pro"`. See all supported APIs [here](#model-customization).

The `model` field can be a string or an object. A model object must specify an `api`, and optionally a `model`, `url`, and additional `params`. You can also use different models/providers for chatting, coding, vision, embedding, and voice synthesis. See the example below.

```json
"model": {
  "api": "openai",
  "model": "gpt-5.4",
  "url": "https://api.openai.com/v1/",
  "params": {
    "max_tokens": 1000,
    "temperature": 1
  }
},
"code_model": {
  "api": "openai",
  "model": "gpt-5.4-mini",
  "url": "https://api.openai.com/v1/"
},
"vision_model": {
  "api": "openai",
  "model": "gpt-5.4",
  "url": "https://api.openai.com/v1/"
},
"embedding": {
  "api": "openai",
  "url": "https://api.openai.com/v1/",
  "model": "text-embedding-3-small"
},
"speak_model": "openai/tts-1/echo"
```

`model` is used for chat, `code_model` is used for newAction coding, `vision_model` is used for image interpretation, `embedding` is used to embed text for example selection, and `speak_model` is used for voice synthesis. `model` will be used by default for all other models if not specified. Not all APIs support embeddings, vision, or voice synthesis.

All apis have default models and urls, so those fields are optional. The `params` field is optional and can be used to specify additional parameters for the model. It accepts any key-value pairs supported by the api. Is not supported for embedding models.

## Embedding Models

Embedding models are used to embed and efficiently select relevant examples for conversation and coding.

Supported Embedding APIs: `openai`, `google`, `replicate`, `huggingface`, `novita`

If you try to use an unsupported model, then it will default to a simple word-overlap method. Expect reduced performance. We recommend using supported embedding APIs.

## Voice Synthesis Models

Voice synthesis models are used to narrate bot responses and specified with `speak_model`. This field is parsed differently than other models and only supports strings formatted as `"{api}/{model}/{voice}"`, like `"openai/tts-1/echo"`. We only support `openai` and `google` for voice synthesis.

## Specifying Profiles via Command Line

By default, the program will use the profiles specified in `settings.js`. You can specify one or more agent profiles using the `--profiles` argument: `node main.js --profiles ./profiles/andy.json ./profiles/jill.json`


# Behavior Policies

*See also: [ARCHITECTURE.md §3.7](ARCHITECTURE.md#37-modes-and-policies--srcagentmodesjs-srcagentbehaviorpolicyjs)
for where this sits in the agent, and [RUNBOOK.md §5](RUNBOOK.md#5-regen-make-policy-changes-take-effect)
for running a regen against a live bot.*

Chatting with an LLM every time something happens is slow and expensive. A
**policy** is standing behavior compiled *once* into rules that run every tick
with no model in the loop: the LLM is a compiler here, not a runtime.

## Rules

A rule is a tiny behavior tree — a condition gating a list of actions:

```json
{
  "name": "flee_when_hurt",
  "description": "run from a fight that is going badly",
  "when": {"all": [{"cond": "health_below", "percent": 40},
                   {"cond": "hostile_nearby", "range": 12}]},
  "do": [{"act": "flee", "distance": 24}],
  "interrupts": "all",
  "cooldown": 10,
  "pinned": true
}
```

- `when` is built from the `CONDITIONS` table in `src/agent/behavior/policy.js`
  (`hostile_nearby`, `health_below`, `hunger_below`, `is_night`, `drowning`,
  `has_item`, `block_nearby`, `is_idle`, …), combined with `all` / `any` / `not`.
  Conditions are polled, so they must be fast and side-effect free.
- `do` is a list from the `ACTIONS` table (`flee`, `goto`, `stay`, `consume`,
  `equip_weapon`, `dig_in`, `collect`, `craft`, `deposit`, `set_mode`,
  `prompt_self`, …), run in order.
- `interrupts: "all"` makes the rule a reflex — it cancels whatever the agent is
  doing. `"idle"` means it only fires when the agent has nothing else to do.
- `pinned: true` lifts a rule above every unpinned rule from any layer. It is
  for rules that prevent death, only.

Rules are ticked by the same arbiter as the built-in **modes** (`modes.js`:
`self_preservation`, `cowardice`, `hunting`, `torch_placing`, …). A policy can
also flip modes on or off through its `modes` object, so a "never fight" policy
can turn `self_defense` off rather than fighting it rule-by-rule.

Anything written into a policy is validated before it installs
(`validatePolicy`). The validator rejects the mistakes that actually bit this
bot: an `interrupts: "all"` rule with a cooldown under 5s (nothing else ever
finishes), a reflex whose trigger its own actions cannot clear (fires forever), a
`stay` with no exit condition, rules gated only on `is_idle`, unknown condition
or action names, and near-duplicate rules.

## Profiles: bases and attributes

Compiled policies are stored in `policies/*.json` as reusable profiles. Each has
a `source` (the natural-language instructions), the compiled `policy`, an
optional `goal`, and a `kind`:

- **base** — a whole stance the agent can run on its own (`stayin_alive.json`,
  `mining.json`).
- **attribute** — something layered on top of a base ("never dig straight down").
  An attribute may be nothing but a sentence; the merge is what turns it into
  rules, so it does not need a compiled policy of its own.

Note this is a different thing from the *bot profiles* above (`andy.json`), which
configure models. Policy profiles live in `policies/`, model profiles in
`profiles/`.

**Regen** merges one base with any number of attributes into a single policy —
one LLM call, in the web UI or over the MindServer socket (`generate-policy`).
Merging is where conflicts get resolved, once, rather than being refereed on
every tick: later attributes beat earlier ones, attributes beat the base, and
duplicate rules collapse into one. A base with no attributes is copied
deterministically with no LLM call at all. The recipe (`{base, attributes}`) is
saved, so "regenerate with one more attribute" does not mean retyping it.

## The two layers

The running policy is composed from two layers, kept separately in
`bots/<name>/policy.json`:

| Layer | Written by | How |
|---|---|---|
| `active` | a person | Regen from a base + attributes, or `!policy` from chat |
| `self` | the agent | its own `!policy` calls, capped at 8 standing instructions |

Composition order, highest priority first: **pinned rules**, then `self`, then
`active`. So the agent's own rules win an ordinary conflict — it is the one
watching itself die — but a person can still outrank it by pinning. The agent
can only ever write to and clear `self`, never the layer a person set. Past the
8-instruction cap the oldest is evicted to `bots/<name>/policy_archive.txt`
rather than deleted.

Adding an instruction recompiles that whole layer from its accumulated source in
one call, with the *other* layer's rules shown to the compiler so it stops
re-deriving what is already installed.

The policy `goal` — the objective the self-prompting loop pursues — is taken
from the `active` layer only. An agent that can rewrite its own objective will.

Rules only react; they fire when the world pokes them. The goal is the half that
goes looking. A policy of nothing but rules leaves the agent standing in an
empty field with every gathering rule waiting for a resource within 24 blocks.

## Commands

| Command | Effect |
|---|---|
| `!policy(instructions)` | Add a standing instruction and recompile its layer |
| `!clearPolicy(layer)` | Clear `active`, `self`, or `all` |
| `!listProfiles()` | List the shared policy library |
| `!loadProfile(name)` | Load a base profile into the `active` layer |
| `!saveProfile(name, kind)` | Save the running policy to the library |
| `!updateProfile(name, instructions)` | Extend a library profile (does not change the running policy) |

A policy can be **locked** from the web UI, which blocks every change until it is
unlocked — used to quiesce an agent while regenerating it.

Runtime telemetry closes the loop: a rule that fires repeatedly without making
progress tells the agent so, by name and with its JSON, and the agent can revise
or drop it with `!policy`.


# Contributing

We welcome contributions to the project! We are generally less responsive to github issues, and more responsive to pull requests. Join the [discord](https://discord.gg/mp73p35dzC) for more active support and direction.

While AI generated code is allowed, please vet it carefully. Submitting tons of sloppy code and documentation actively harms development.

## Patches

Some of the node modules that we depend on have bugs in them. To add a patch, change your local node module file and run `npx patch-package [package-name]`

## Development Team
Thanks to all who contributed to the project, especially the official development team: [@MaxRobinsonTheGreat](https://github.com/MaxRobinsonTheGreat), [@kolbytn](https://github.com/kolbytn), [@icwhite](https://github.com/icwhite), [@Sweaterdog](https://github.com/Sweaterdog), [@Ninot1Quyi](https://github.com/Ninot1Quyi), [@riqvip](https://github.com/riqvip), [@uukelele-scratch](https://github.com/uukelele-scratch), [@mrelmida](https://github.com/mrelmida)


## Citation:
This work is published in the paper [Collaborating Action by Action: A Multi-agent LLM Framework for Embodied Reasoning](https://arxiv.org/abs/2504.17950). Please use this citation if you use this project in your research:
```
@article{mindcraft2025,
  title = {Collaborating Action by Action: A Multi-agent LLM Framework for Embodied Reasoning},
  author = {White*, Isadora and Nottingham*, Kolby and Maniar, Ayush and Robinson, Max and Lillemark, Hansen and Maheshwari, Mehul and Qin, Lianhui and Ammanabrolu, Prithviraj},
  journal = {arXiv preprint arXiv:2504.17950},
  year = {2025},
  url = {https://arxiv.org/abs/2504.17950},
}
```

## Contributors

Thanks to everyone who has submitted issues on and off Github, made suggestions, and generally helped make this a better project.

![Contributors](https://contrib.rocks/image?repo=mindcraft-bots/mindcraft)
