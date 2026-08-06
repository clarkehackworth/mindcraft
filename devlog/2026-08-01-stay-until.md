# `!stay(-1)` had no way to end, so `!stayUntil` replaced the guessing

**Commit:** uncommitted · 2026-08-01

## Problem

With a goal like "gather food by day, stay at base until morning", the model
had no command that meant "wait for a condition" — only `!stay(seconds)`. It
reached for `!stay(-1)` and parked indefinitely, including once during
daylight while its own goal said to be gathering. Nothing woke it back up;
the self-prompt loop just kept re-choosing to stay.

## Change

- `!stay(-1)` issued at night now ends at dawn by default (no code change
  needed elsewhere — `stay()` grew an optional `until` predicate).
- New `!stayUntil(condition, timeout_seconds)` command, reusing the same
  condition vocabulary the policy engine's rules use (`is_night`,
  `health_below`, `has_item`, etc.), written as a flat expression
  (`"not is_night"`, `"health_below 10 and hostile_nearby 8"`) because the
  command parser can't carry JSON args.
- `!stay(-1)` is now refused while self-prompting — nothing in that state can
  end an unconditional wait — and points the model at `!stayUntil`.

## Files

`src/agent/library/skills.js`, `src/agent/library/world.js`,
`src/agent/behavior/policy.js`, `src/agent/commands/actions.js`,
`src/agent/library/stay.test.js`
