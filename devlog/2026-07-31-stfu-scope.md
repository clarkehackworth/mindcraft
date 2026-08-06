# `!stfu` stops the chatting, not the working

**Commit:** `c399afb` (+ an uncommitted follow-up in `agent.js`) · 2026-07-31

## Problem

Twice in one afternoon the model answered its startup prompt — *"respond with
hello world and your name"* — with `!stfu`. That stopped the self-prompter as
well as the chat, and the bot then sat inert for a quarter of an hour until
someone noticed and spoke to it.

Same shape as `!restart` ([no self-destruct](2026-07-30-no-self-destruct.md)): a command that lets the
model opt out of the task, whose effect outlives the turn that chose it.

## Change

- `!stfu` no longer stops work. It silences chat only; `!endGoal` is what stops
  work.
- Its description now says what it does.
- Any incoming message clears `shut_up`, so a self-inflicted `!stfu` costs one
  quiet turn and nothing more.

## Follow-up (uncommitted)

`shut_up` was still being checked in `checkInterrupt`, which meant it broke the
self-prompt loop out early. Three silent no-command strikes and an active
`!goal` was killed anyway — the same bug through a different door.

`checkInterrupt` now only honours `shut_up` for non-self-prompt turns:

```js
(!self_prompt && this.shut_up)
```

`routeResponse` already suppresses the chat output, so muting doesn't need to
starve the loop as well.

## Decisions

- **Keep the command.** Silencing a noisy bot is a reasonable thing for a person
  to ask for. The problem was its blast radius, not its existence.
- **Separate "don't talk" from "don't act" everywhere.** Any interrupt that a
  mute triggers is a bug; the mute belongs at the output boundary only.

**Files:** `src/agent/agent.js`, `src/agent/commands/actions.js`
