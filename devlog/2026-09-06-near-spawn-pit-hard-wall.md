# Near-spawn pit: make the death trap an absolute wall

## Problem

Andy died of `drown` repeatedly at the origin pit complex — the
2026-09-06 window had two in one 2h: (-7,44,11) and (-7,46,10). This is
the same pit documented in the 2026-08-25 pit-respawn-fix: a dry gravel
pit at ~(-5,51,2) plus an enclosed water pit at ~(5,55,-6), all at the
origin. It is an **inescapable** death trap — a stone ceiling the bot
cannot break ("pathfinding & climbing FAIL"), no exit the bot can make.

The pit sat **outside** the existing cave-ring `DEATH_POCKET_BOX`
(z -8..12 vs zMin=60, y 44..56 vs yMin=48), so it priced **nothing**.
Every time the bot drowned there, a grave formed at the pit floor and
`go_back_for_your_grave` routed it straight back in — a
`drown -> grave -> route-back-in -> drown` loop.

## Why a 99 near-wall was not enough

The first draft of this fix added a tight `NEAR_SPAWN_PIT_BOX` priced at
the same `DEATH_WATER_COST` (99) as the cave ring. That is the right
answer for a *mineable* cave layer — a pickaxe bot can descend to mine
and dig itself out, so 99 (a strong deterrent, not a wall) is correct
there. But it is the wrong answer for an inescapable trap. The grave
that `go_back_for_your_grave` targets sits **at the pit floor**, so the
only route to the goal descends into the water — and a strong goal pull
routes straight **through** a 99 near-wall (the exact way the cave-ring
bot still drowned at 99). A near-wall only works when there is a
drastically cheaper dry alternative; when the goal itself is in the
water, the goal pull wins.

## Change

`src/utils/water_aware_path.js` (+ the runnable check in
`water_aware_path.test.js`):

1. **`NEAR_SPAWN_PIT_BOX = { xMin: -9, xMax: 5, yMin: 43, yMax: 58,
   zMin: -8, zMax: 12, hard: true }`** — a second, tight box over the
   origin pit complex. `yMin` drops to 43 so the y=44/46 drown floors are
   covered; the z span -8..12 keeps the surface approaches (the Base at
   z=89, the spawn surface at y=73) cheap.
2. **`inHardPocket(pos)`** — a pocket marked `hard` is an absolute death
   trap with no exit the bot can make, as opposed to a mineable cave
   layer. Only the near-spawn pit is `hard`; the cave ring stays soft.
3. **Installer escalation split** in `installWaterAvoidance`. When
   `waterCost` returns the pocket price (99), the wrapper now:
   - returns an **absolute 100 wall** if the block is in a hard pocket —
     for a bot **outside** it, regardless of tools. A pickaxe does NOT
     help against an unbreakable stone ceiling, so the soft ring's
     pickaxe exception does not apply. No path exists, so even a strong
     goal whose target sits at the pit floor cannot route in: the goto
     fails clean and the bot moves on.
   - otherwise (soft cave ring) returns 100 only when `!hasDigTool(bot)`
     (the existing starvation fix) — a pickaxe bot keeps the soft 99.
   - a bot **already inside** either pocket still gets 0 from `waterCost`
     itself (the free exit), before the escalation can fire — the
     "inside is free to path out" invariant is preserved.

The soft cave ring is otherwise unchanged: a mineable layer a pickaxe
bot can descend and dig out of stays at 99.

## Rejected options

- **World fill / RCON barrier around the pit.** The user explicitly
  declined world fills for water pockets. A behavior/pathfinding-cost fix
  is the sanctioned approach and is what this is.
- **Keep the pit at the soft 99 (cave-ring parity).** Rejected: the
  goal-pull-through-a-near-wall leak (the grave at the pit floor) means a
  99 does not stop `go_back_for_your_grave` from routing back in. That is
  precisely the loop being fixed.
- **Make the whole pit complex hard for the cave ring too.** Rejected: the
  cave ring is a real mineable layer — hard-walling it would block the
  bot from descending to mine and would be a regression. Only the
  inescapable origin pit is `hard`.

## Spawnpoint (rescued, not a world-edit fix)

The bot's per-player spawnpoint was re-asserted to the Base
`spawnpoint clarke_hackworth -29 63 89` (idempotent) so that if he does
die, he respawns at the Base, not at the pit. When the bot was found
stuck on its own grave at (-6,46,10) after a restart (the entity
persists across restarts), it was `tp`'d to the Base as a one-off
rescue only — the durable fix is the code above, not the tp.

## Verification

- `node src/utils/water_aware_path.test.js` — 5 sections pass, including
  the new hard-pocket section: pit is `hard` (ring is not); a **pickaxe**
  bot outside the pit gets the absolute 100 wall (a pickaxe does NOT
  lift a hard wall — the key difference from the soft ring); a tool-less
  bot outside also gets 100; a bot **inside** the pit gets 0 (free exit),
  tool or no tool; the wall is 100 flat, not base+99.
- `node tools/policy_file_check.js` — PASS: 7 layer(s), 0 invalid.
- `node tools/descend_perch_check.js` — all checks pass.
- Deployed via `bash tools/live_*.sh deploy src/utils/water_aware_path.js`
  + restart; re-confirmed the container copy has the hard-pocket code
  (`grep -c 'inHardPocket|hard: true'` = 3); bot alive post-restart,
  Health 24/24, Air 300s, **0 Uncaught/FATAL**.

## Open (reported, not fixed this run)

While observing, the bot was seen oscillating through the **cave-ring**
death pocket (`flee_ranged_raiders` + `path:unreachable:GoalInvert`,
repeated `path_reset:stuck`) around (-23..-30, 59, 100). It was healthy
(24/24, Air full) and **moving** (not a hard stuck), and the cave ring is
a soft pocket this change deliberately did not alter — so it is a
pre-existing pattern, not a regression from this fix. It is the same
class of leak (a strong goal pulling the bot toward/through a near-wall
water pocket) and is the likely next candidate for a hard-pocket or
flee-fallback treatment if it produces another in-pocket death.
