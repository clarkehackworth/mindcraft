# Behavior policy layer

**Status:** uncommitted · 2026-07-31 · the largest change on this branch

## Problem

Standing instructions had nowhere to live. Tell the bot *"flee from mobs, and
eat when your health is low"* and it goes into chat history — where it decays
out of context, competes with the current task, and only ever affects behavior
if the model happens to remember it on the turn that matters. Meanwhile the
things that *do* run every tick — the built-in modes — are a hardcoded list a
user can only switch on and off.

So: conditional behavior the user cares about is expressed in the layer that
forgets, and the layer that doesn't forget isn't user-editable.

## Change

A policy is a set of standing rules compiled from natural language by the LLM.
Each rule is a small behavior tree: a condition subtree (`all` / `any` / `not`
combinators over condition leaves) gating a sequence of action leaves. The
`ModeController` ticks rules alongside built-in modes, in priority order.

**Components:**

| piece | what it is |
|---|---|
| `src/agent/behavior/policy.js` | condition + action leaf registries, validator, `Rule` runtime, JSON persistence, LLM compiler prompt, `describePolicy` pretty-printer |
| `src/agent/modes.js` | `ModeController` becomes a priority arbiter over `[safety modes, policy rules, remaining modes]` |
| `src/agent/commands/actions.js` | `!policy` and `!clearPolicy` |
| `src/agent/mindserver_proxy.js` | `get-policy` / `set-policy` sockets |
| `src/mindcraft/public/index.html` | policy modal: rendered view on the left, raw JSON editor on the right |
| `tools/policy_check.js` | `node tools/policy_check.js` — assert-based self-check |

11 condition leaves (`hostile_nearby`, `health_below`, `has_item`, `is_night`,
`is_idle`, …) and 14 action leaves (`flee`, `fight_back`, `goto`, `collect`,
`consume`, `equip`, `say`, `set_mode`, `prompt_self`, …).

## Decisions

- **A fixed leaf vocabulary, not generated code.** The LLM compiles English into
  JSON referencing named leaves; it does not write JS that runs every tick.
  Anything running at tick frequency with no human in the loop must be
  restricted to a set we can validate — a bad leaf is a validation error, a bad
  generated function is a dead agent.
- **Compile once, not per tick.** `!policy` calls the LLM once and stores the
  result. Rules then evaluate as plain data. An LLM call in the tick path would
  be unaffordable and unreliable.
- **Conditions must be fast and side-effect free.** Documented at the top of the
  registry — they run every tick for every rule.
- **Safety reflexes outrank user policy.**
  `PRIORITY_ABOVE_POLICY = ['self_preservation', 'unstuck']` — a user rule
  cannot stop the bot from saving itself or from escaping a hole. Everything
  else sits below the policy rules.
- **Rules carry no agent references.** `ModeController` already had a security
  warning about this (mode state is serialized); rule specs are plain data, and
  the agent is passed *in* to `update()`.
- **`installPolicy` snapshots pre-policy mode state**, so `clearPolicy` restores
  what the user had rather than leaving the policy's `modes` overrides behind.
- **Policy persists to disk and reloads in `initModes`.** A standing instruction
  that doesn't survive a restart isn't standing.
- **`!policy` replaces the whole policy rather than appending.** Merge semantics
  for natural-language rules ("is this a new rule or an edit of that one?") is a
  problem with no good answer; replacement is predictable and the UI shows the
  current state, so editing is a real option.
- **The command description does the hard work.** It explicitly tells the model
  to use `!policy` for *"always…" / "never…" / "whenever X do Y" / "from now
  on…"* and states that chat memory alone will not change automatic behavior,
  with `!goal` called out as the thing for tasks. The failure mode being guarded
  against is the model nodding along in chat and changing nothing.
- **UI shows a rendered view *and* raw JSON.** `condToText` / `actToText`
  render rules as English so a non-author can read them; the JSON editor is
  there because the compiler will sometimes get it wrong and hand-fixing one
  field beats re-phrasing the instruction until it lands.
- **UI edits go through the same validator** and are written into agent history
  (`"policy was edited via web UI. now: …"`) — the model must know its own rules
  changed under it.
- **`prompt_self` is dispatched *after* the action completes**, not as a step
  inside it — re-entering the ActionManager while it's executing is exactly the
  concurrency bug [abandoning stuck actions](2026-07-30-abandon-stuck-actions.md) fixed. Steps are partitioned
  in `Rule.update`: real actions run as one sequence under `execute()`, prompts
  fire afterwards as `(POLICY RULE 'name')` system messages.
- **Per-rule cooldown, default 3s.** Without it an eligible condition fires the
  rule every tick.
- **One assert-based self-check, not a test framework.** `tools/policy_check.js`
  covers validation rejects (missing `when`/`do`, unknown condition, unknown
  action, duplicate names), the `all`/`any`/`not` combinators, and rule runtime
  (cooldown, `prompt_self` dispatch).

## Related

`ARCHITECTURE.md` was written before this — the arbiter change needed a written
model of the process/component layout, the mode tick, and where the LLM boundary
sits. It documents the two organizing ideas of the codebase: one agent = one OS
process, and the LLM only emits text (behavior comes from parsing `!command()`
out of it, so there's no tool-calling protocol dependency).

## Still open

- No test for the arbiter's preemption ordering, only for the leaves.
- `set_mode` resolves through `ModeController._find`, which searches built-in
  modes *and* rules — so a rule can switch off `self_preservation`, or another
  rule, despite those sitting above it in priority. Not currently guarded.
