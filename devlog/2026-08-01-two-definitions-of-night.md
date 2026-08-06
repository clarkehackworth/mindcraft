# `!stats` and the policy engine disagreed about whether it was night

**Commit:** uncommitted · 2026-08-01

## Problem

`!stats` bucketed time of day one way; the policy engine's `is_night`
condition used a different tick range. They disagreed for a window at each
end of the night — caught live at daytime tick 23008, where `!stats` told the
model "Time: Night" while `is_night` evaluated false, so the model was acting
on a clock that contradicted what it was being told.

## Change

`world.isNight()` is now the single source both go through — it prefers
mineflayer's own `bot.time.isDay` and falls back to a tick range that no
longer has the gap. `!stats` and the policy engine both call it.

## Files

`src/agent/library/world.js`, `src/agent/commands/queries.js`,
`src/agent/behavior/policy.js`, `src/agent/library/is_night.test.js`
