# User messages superseding an active goal

**Status:** uncommitted (`src/agent/agent.js`, `src/agent/self_prompter.js`)
2026-07-31

## Problem

Two ways a user instruction got swallowed while a `!goal` was running.

**1. The old goal re-asserts itself.** When a user speaks during self-prompting,
`max_responses` is set to 1 — respond once, then let self-prompting take over.
But the next self-prompt re-states the original goal, so the user's instruction
is buried under it one turn later. From the user's side the bot acknowledged the
request and then ignored it.

**2. Setting a new goal mid-action does nothing.** `SelfPrompter.start()` set
state and called `startLoop()`, but a long-running action — `!stay` is the usual
one — was still parked in the previous loop iteration. The loop can't re-prompt
until that returns, so the new goal was silently dropped.

## Change

- On a user message during self-prompting, append a system message naming the
  current goal and stating that the model **must** use `!goal` / `!endGoal` /
  `!policy` if the instruction changes it — otherwise the old goal resumes
  automatically.
- `SelfPrompter.start()` is now `async` and awaits `agent.actions.stop()` before
  starting the loop, so the parked action returns and the loop re-prompts with
  the new goal.

## Decisions

- **Tell the model the mechanism, not just the goal.** "Your current goal is X"
  isn't enough; it needs to know that doing nothing means X resumes. Naming the
  three exits (`!goal`, `!endGoal`, `!policy`) makes the right move obvious.
- **`!policy` is listed as an option here on purpose** — standing instructions
  ("always eat when hungry") are not goals, and routing them to `!goal` was one
  of the failure modes that motivated [behavior policy](2026-07-31-behavior-policy.md).
- **Interrupt on `start()` rather than in the `!goal` command.** Any path that
  sets a new goal needs this, not just the command.
- Safe now that `actions.stop()` is bounded ([abandoning stuck actions](2026-07-30-abandon-stuck-actions.md));
  before that change, awaiting it here could have hung indefinitely.

**Files:** `src/agent/agent.js`, `src/agent/self_prompter.js`
