# Idle-only modes were discarding every self-prompted command

**Commit:** uncommitted · 2026-08-01

## Problem

The bot tried for hours to search for pumpkins and never once actually ran
the command — every `!searchForBlock("pumpkin", 128)` vanished before
execution. Cause: any mode firing while self-prompting called
`self_prompter.stopLoop()`, which set an interrupt flag that made the agent
discard whatever command the model had just decided on. `day_gather_food`
fires on a cooldown whenever the bot is idle — exactly when the loop is
waiting on the model's API response — so it ate almost every command
produced. This was upstream of several things that looked like separate bad
model decisions (e.g. parking with `!stay(-1)`), since the model was
partly reacting to a world where its own commands silently disappeared.

## Change

`stopLoop` now takes `discard_pending`, separating "stop issuing new
prompts" from "cancel the command already in flight." Only modes that
interrupt everything (`interrupts: 'all'` — safety modes like
`self_preservation`) discard the pending command; idle-only modes just pause
between prompts.

## Files

`src/agent/self_prompter.js`, `src/agent/modes.js`,
`src/agent/self_prompter.test.js`
