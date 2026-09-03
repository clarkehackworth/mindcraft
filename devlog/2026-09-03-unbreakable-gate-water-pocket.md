# 2026-09-03 — Unbreakable-dig gate + water death-pocket no-go

Two small, targeted fixes for the two failures the re-pin night exposed.
Both are in the dig/path cost layer, not the policy layer, because the policy
layer was already doing the right thing — its skills were just dying under it.

## Problem

The first full night after the home/base re-pin (devlog
`2026-09-02-home-repin-safe-base`) was still rough. Two distinct killers, both
now fully traced:

1. **`dig_in` churned all night against the barrier-filled Base.** The safe Base
   pocket is the barrier-solidified spawn pocket (2026-08-29, 208
   water→barrier). `barrier` has `hardness -1` / `diggable false`, but it
   *passes `canHarvest` for every tool*. So the old tool check in `breakBlockAt`
   never fired, the dig sailed into mineflayer, and mineflayer threw
   `dig time ... is Infinity` **straight up through `digDown` into the `dig_in`
   rule**. That rule then re-fired on cooldown — **10 failures in one window,
   31 `flee_ranged_raiders` fires, 5 flagged unresolved — and never once
   sheltered the bot. The night-defense was spinning in place.**
2. **He drowned in the flooded cave ring around the Base.** Death at
   `(-23.5, 57, 112.5)`, and the catalog of every documented drown in the last
   windows sits at the cave layer `y=53–58` in a ring around the Base:
   `(-23.5,57.2,65.5) (-23.5,57,112.5) (-27,56,91) (-25,58,87) (-33,54,87)
   (-39,53,87)` plus the stuck pocket `(-41,59,85)`. The soft deep-water cost
   (40) was measured too weak against a goal pull — he was mid
   `gather_wood_for_base` when the planner routed him through.

## Change

- **`breakBlockAt` unbreakable gate** (`src/agent/library/skills.js`): before the
  dig, compute `bot.digTime(block)` (wrapped in `try/catch` so an exotic throw
  degrades to a refuse, never a throw into the rule/tick path) and refuse any
  block whose dig time is not finite. `barrier` → `Infinity` → refused with a
  named log line, *before* the dig is attempted. Finite dig times still pass to
  the existing tools/maroon checks untouched.
- **Water death-pocket no-go** (`src/utils/water_aware_path.js`): a `DEATH_POCKET_BOX`
  covering the measured ring (`x -45..-15, y 48..60, z 60..118`) that prices any
  water block inside it at `DEATH_WATER_COST = 99` — under the pathfinder's
  100 unbreakable cap, so it's a near-wall, not a wall. Stops at `y=60` so the
  Base at surface `y=63` and its surface approaches stay cheap. The existing
  `isInWater` early-return still wins first, so a bot already inside keeps a
  free way out. Wired in automatically: `installWaterAvoidance` already patches
  the live `Movements.safeOrBreak` (consulted on every A* candidate step in
  `mineflayer-pathfinder`), so the box lands on the real pathfinder with no new
  call sites.

## Decisions

- **Why a gate on dig time, not a block-name deny-list.** The failure was
  general: *any* block that cannot be broken in finite time (barrier today,
  unbreakable modded blocks tomorrow) sails past `canHarvest` (which answers
  "will it drop", not "can it be cleared"). A name list whack-a-moles; a dig
  that can never finish is not a slow dig, so gating on the time itself is the
  real invariant.
- **Why `99` and not `100` for the pocket.** The pathfinder treats a cost of
  100 as an absolute wall. A bot that is already inside the pocket must keep a
  cheap way out; `99` is near-impossible to route through but never a dead end.
- **Why a box and not a prose no-go.** A geographic no-go *box* is the wrong
  shape for the Base itself (it sits inside the ring), so this is a
  **water-cost** box, not a movement veto: it prices the *liquid*, leaves the
  solid Base and its dry approaches free, and degrades gracefully.
- **Why not fix the policy instead.** The policy (`dig_in_when_hunted`,
  `flee_ranged_raiders`) was already firing correctly. Re-ordering or re-gating
  it can't help when the underlying skill throws on an unbreakable target — the
  bug is that the skill *hangs/throws* rather than failing fast. Fix the skill,
  let the policy's existing fall-through do its job.

## Verification

| Check | Result |
|-------|--------|
| `water_aware_path.ollama.js` (extended: 6 death-pocket cases) | 3 `ok` lines, 0 fail |
| `break_block_unbreakable.ollama.js` (new: barrier refused / finite passes / digTime-throw degrades / full pass-through) | `ok`, 0 fail |
| `movement_limits.ollama.js`, `surface_drown.ollama.js` (import `skills.js`) | pass |
| `policies_valid.ollama.js`, `tools/policy_check.js`, `tools/home_place_check.js` | pass |
| Pre-existing reds (stash-proven, not touched) | `collect_pickup.ollama.js` (flaky 100ms `setTimeout`) and `craft_cycle.ollama.js` (asserts missing `mod_data/prominence2.json`) — both fail identically with these changes stashed |

## Deploy

- `src/agent/library/skills.js` + `src/utils/water_aware_path.js` pushed via the
  live helper, agent restarted.
- Verify in container: `grep "Refusing to break" /app/src/agent/library/skills.js`
  and `grep "DEATH_WATER_COST" /app/src/utils/water_aware_path.js`.

## Open items

- The Base's roofless *structure* is the next layer: dig_in now fails fast on
  barrier instead of hanging, so the night-defense should fall through to
  `flee`/`stay` cleanly — but actually *roofing* the Base is a shelter-building
  problem, not a steering one.
- Watch whether the `y<60` descent into the cave ring stops once the pathfinder
  prices the pocket at 99.