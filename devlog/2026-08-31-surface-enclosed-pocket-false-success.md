# Surface() reports "Surfaced with 20/20 air left" while the bot is still submerged

**Date:** 2026-08-31
**Status:** shipped

## Problem

The `surface()` skill in `src/agent/library/skills.js` uses `isBreathing(bot)` as
its success check. `isBreathing` answers "is the head above water?" — the right
question for drowning detection (added by the surface-drown veto fix on
2026-08-30). But `surface()` was using it to answer a different question: "did
the bot get out of the water?".

In an enclosed water pocket (cave at y=50, underground pool, water-filled
shaft), the bot's head clears the waterline — oxygen refills to 20,
`isBreathing` returns `true` — but the body is still submerged
(`bot.entity.isInWater === true`). There is no path to the surface: the pocket
is sealed, the bot bobs in place, and `surface()` logs
"Surfaced with 20/20 air left" and returns `true`.

This was observed live on 2026-08-31: Andy sat at `(-8.3, 50.0, 9.7)` in an
enclosed water pocket. The `surface_when_night_finds_you_underground` policy
fired, the log reported "Surfaced with 20/20 air left", and the bot was still
at y=50. The `self_preservation` reflex was also firing (`oxygen=12
wet=32/32` → `skills.surface(bot)`), but it was being told the rescue had
already succeeded.

## Change

Three edits in `surface()` (`src/agent/library/skills.js`):

1. **Early check guard.** The pre-loop `if (isBreathing(bot))` early return now
   also checks `bot.entity?.isInWater !== true`. Breathing but in water is not
   surfaced — it falls through to the swim/dig loop.

2. **Loop check guard.** The in-loop `if (isBreathing(bot))` success return now
   checks `bot.entity?.isInWater === true`. If breathing but still in water, it
   sets `ever_breathed_in_water = true` and keeps trying (the bot might dig
   through a ceiling). If breathing and out of water, it returns `true` as
   before.

3. **Failure message.** A new first-priority branch in the failure `why`
   selector: if `ever_breathed_in_water && !blocked_by`, the failure is named
   "head above water but body still submerged — enclosed pocket, no path up"
   instead of the generic "nothing overhead to break; swimming up did not reach
   air". The log stops lying about the cause.

## Rejected options

- **Checking `bot.entity.position.y` against the world height.** Rejected:
  the bot is at y=50 in a cave; "below surface" is not the same as "in water",
  and a bot in a cave with no water overhead would be falsely flagged.
- **Checking the head block for water in the early return.** Rejected:
  `isBreathing` already does the head-block check with the oxygen-bar fallback
  (the surface-drown fix). Adding a second head-block check here would
  duplicate the logic and miss the kelp/seagrass case that the bar handles.
- **Making `isBreathing` return `false` when `isInWater` is true.** Rejected:
  this would break the surface-drown veto, which correctly treats
  "head above water, body in water, bar refilled" as breathing. The two
  functions answer different questions; they should not be forced to agree.

## Verification

- `node --check src/agent/library/skills.js` — SYNTAX_OK.
- `surface.test` — 3 sections pass, including 3 new
  enclosed-pocket assertions:
  - breathing + in water → NOT surfaced, runs full timeout, failure names
    "enclosed pocket", no "Surfaced with" line.
  - breathing + out of water (dry land) → early return still fires, "nothing
    to surface from".
  - breathing + in water + diggable stone ceiling → digs the ceiling, escapes,
    reports "Surfaced with" once out.
- `surface_noop.test` — pass (regression guard).
- `surface_drown.test` — 12/12 pass (isBreathing unchanged).
- `drowning_debounce.test` — 7/7 pass.
- `oxygen_scope.test` — 5/5 pass.
- `water_aware_path.test` — pass.
- `stay.test` — pass.
- `boss_tier` / `huntable` — pass.
- Deployed via `bash tools/live_*.sh deploy src/agent/library/skills.js`.
- Post-deploy rcon: bot alive, full health.

## Open items

- The `surface_when_night_finds_you_underground` policy still calls
  `skills.surface(bot)` in an enclosed pocket. With this fix, the call now
  correctly reports failure after the timeout, so the policy can escalate
  (tp-rescue, dig, etc.) instead of believing the rescue succeeded. Whether
  the policy should add a tp-rescue fallback after a surface() failure is a
  separate decision.

