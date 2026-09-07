# Flee fallback: run toward a concrete out-of-pocket point, not away from the mob

## Problem

The 2026-09-07 check-in pinned Andy at `(-6,46,10)` inside the
`NEAR_SPAWN_PIT_BOX` (the hard near-spawn pit, shipped 2026-09-06) with a
drowned at `(-6,68,5)` — **22 blocks above** him. `avoidEnemies` was re-arming
`GoalInvert(GoalFollow(enemy, distance+1))` every 500ms. `GoalInvert` negates
the goal's heuristic, which A* cannot bound, so "away from something overhead"
resolved to **DOWN** — straight into the pit's gravel/water floor, the one
direction the pit makes inescapable. The signature in the logs was frozen
`at=`, `spin_abort`, and an identical `path:unreachable:GoalInvert:-6,68,5`
every cooldown, while `dig_in` refused ("capping where I stand"). Both escape
legs aimed into the direction that traps him.

This is the exact "Open" item the 2026-09-06 near-spawn-pit entry flagged: a
strong goal pulling the bot toward/through a near-wall pocket, named there as
"the likely next candidate for a hard-pocket or **flee-fallback** treatment."

## Change

`src/utils/flee_target.js` (new) + the runnable check
`flee_target.test.js` (new), and `avoidEnemies` in
`src/agent/library/skills.js`.

**`fleeTargetFor(pos, threat, distance)`** — a pure, no-throw utility that
returns a short list of **concrete, walkable escape points**:

1. Holds **Y level** — a flee never aims below where the bot stands, so an
   overhead threat can no longer resolve to a dive.
2. Aims **OUT of a hard pocket** — each candidate is dropped if it lands inside
   `inHardPocket(...)` (the near-spawn pit and the cave ring), so the escape
   leaves the pocket rather than sliding along its floor.
3. Is **deterministic** — a fixed heading fan decides "away" when the threat is
   essentially directly overhead, so a flee is reproducible, not
   `Math.random`.
4. **Returns `[]` when no flat in-the-clear escape exists** (deep in the
cave ring). That empty list is the caller's signal that running cannot help —
   degrade to fight, dig-in, or a door — rather than a fake direction to
   thrash on.
5. **Never throws** on bad input (null/NaN/undefined) — it degrades to `[]`.

**`avoidEnemies`** now, per loop pass:

- computes `fleeTargetFor(bot.entity.position, enemy.position, distance+1)`;
- takes the **first** escape point the existing `isUnreachable` memo does not
  already refuse, and arms a **bounded concrete `pf.goals.GoalNear(x, y, z, 2)`**
  toward it;
- falls back to the old `GoalInvert(GoalFollow(...))` **only when no flat
  escape exists** (the deep-in-ring sub-case) — i.e. today's behavior, now
  strictly narrower in scope.

The key property is that a concrete goal **has coordinates**, so the spin
backstop records it as unreachable and `isUnreachable` refuses it on the next
pass. The old `GoalInvert` was **invisible to that memo by construction** —
no target coordinate to record — so it re-fired every cooldown forever. The
new code rides the existing `unreachable` memoization for free; no new
watchdog, no new state to drift. The deadline and the give-up log line are
byte-identical, so `flee_timeout.test.js` keeps passing.

## Rejected options

- **A new flee watchdog / spin counter.** Rejected: the existing `unreachable`
  memo already does this job for any goal with coordinates. The old `GoalInvert`
  only escaped it because it had no coordinates to record. Adding a second
  counter duplicates state and a second thing to keep in sync.
- **Clamp `GoalInvert`'s Y so it never aims down.** Rejected: the negated
  heuristic is the root cause — the search is unbounded *and* direction-biased
  by geometry. Clamping the output still wastes replans on an unbounded search
  and leaves the bot oscillating on the pocket floor.
- **World edit / RCON barrier around the pit.** Rejected: the user explicitly
  declined world fills for water pockets (2026-09-06 entry). A
  behavior/pathfinding fix is the sanctioned approach, and this is one.

## Verification

- `node --test src/utils/flee_target.test.js src/agent/library/flee_timeout.test.js
  src/utils/water_aware_path.test.js src/agent/path_spin.test.js` — 14 pass, 0
  fail, including all five new `flee_target` assertions: the pinned check-in
  scenario flees **out** of the pit at level (not down); an overhead threat
  yields a deterministic flat heading; in-pocket candidates are dropped;
  deep-in-ring honestly yields `[]`; and garbage input degrades to `[]` without
  throwing.
- `node --check src/agent/library/skills.js` — OK.
- `node tools/policy_file_check.js` — PASS: 7 layer(s), 0 invalid.
- Deployed via the live host + restart; re-confirming the container copy and
  watching for the `unreachable:GoalInvert` spin signature to disappear from
  the logs.
