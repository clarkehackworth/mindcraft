# 2026-09-03 — Water pocket escape keyed on position, not wetness

The water death-box shipped yesterday with a leak that cost two in-box
drownings. One-line-class fix: the escape route that overrides the pocket
price must be keyed on **being inside the pocket**, not on **being wet**.

## Problem

Post-deploy window (15:15Z→17:49Z, one continuous session, 0 crashes) read:

- **Gate: working, and better than expected.** 5 clean `Refusing to break`
  refusals, 0 raw `dig time … Infinity` throws. The gate fired on **two
  unbreakable species**: `barrier` at the Base pocket `(-29,62,89)` and —
  new — `grave` blocks in the graveyard ring `(-27,59,96)` ×2,
  `(-36,56,91)`. `dig_in` fired 105× and now refuses cleanly instead of
  throwing through the rule. The 31-fire churn is gone. (Nothing to do here.)
- **Water box: too weak.** 3 post-deploy drownings, **2 inside the box**
  `(-45..-15, 48..60, 60..118)`:
  - 16:34Z `(-39,57,70)` — in box, `items4` (mid-job, gearing up)
  - 16:41Z `(-18,60,131)` — **outside** (`z=131 > zMax=118`), known edge miss
  - 17:12Z `(-36,56,91)` — in box, `items3`

The leak was line 66 of `water_aware_path.js`:

```js
if (bot.entity && bot.entity.isInWater) return 0;   // ← killed the box
```

The intent was "a bot already inside the pocket keeps a free way out." The
implementation was "a bot in **any** water has the pocket free." So during a
gather job, the instant his feet touched a 1-deep stream *outside* the box,
`isInWater` flipped true, the 99-pricing on the entire pocket vanished, and
the planner routed straight through it. The bot had 3–4 items in hand on
both in-box drownings — he was mid-job and wet when the pocket went free.

## Change

`waterCost()` in `src/utils/water_aware_path.js`, reordered so the pocket
owns its own escape and the legacy wet-escape only applies to non-pocket
water:

```js
// 1. Escape: a bot physically INSIDE the pocket keeps a free exit.
if (bot.entity && inDeathPocket(bot.entity.position)) return 0;
// 2. The pocket itself prices near the unbreakable cap.
if (inDeathPocket(pos)) return DEATH_WATER_COST;
// 3. Legacy: wet bot → non-pocket water is free (river escape, unchanged).
if (bot.entity && bot.entity.isInWater) return 0;
```

test 10 re-keyed: a bot with `position` inside the pocket →
free exit; a bot merely wet *outside* the pocket → pocket still prices 99
(the exact leak case, now asserted).

## Rejected options

- **Widen the box to `z=131`.** The 16:41Z death was 13 blocks past the box
  edge and the box is the *measured* death ring, not a guess — extending it
  on a single sample would start fencing in live terrain. The cave-layer-air
  pricing follow-up (below) covers it better.
- **Remove the wet-escape entirely.** It is the river-escape: a bot wading a
  stream must still be able to path *out* of water. Killing it would make
  rivers uncrossable — the exact trap the file header warns against.
- **Price the cave-layer *air* (`y=53..60`) too.** Correct follow-up (a bot on
  cheap air at y=56 that falls in is never charged a water step), but it's a
  separate behavior change with its own failure modes (trapping a bot on a
  ledge). Not mixed into this change so the observation window can attribute
  the one-variable fix.

## Verification

- `node --check src/utils/water_aware_path.js` → SYNTAX_OK
- `node src/utils/water_aware_path.test.js` → all 3 suites pass
  (costs / pockets+bounds+**escape re-keyed** / install) including the new
  "wet outside the pocket → pocket still prices 99" assert.
- Deployed via `tools/live_test.sh deploy src/utils/water_aware_path.js`,
  agent restart sent, container marker grep + liveness checked.

## Watching next window

| Metric | Last window | Success looks like |
|--------|-------------|--------------------|
| In-box drownings (`y=53..60`, in ring) | **2** | 0 — a wet bot on a job no longer un-prices the pocket |
| Out-of-box drownings | 1 (`z=131`) | 0 if the cave-layer-air follow-up lands; otherwise flagged |
| `Refusing to break` | 5 (barrier+grave) | keeps firing cleanly, still 0 raw Infinity throws |
| Night zombie deaths | 3 (graveyard edges) | out of scope for this change — tracked, not blamed |

