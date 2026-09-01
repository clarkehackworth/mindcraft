# Water-aware pathing + an explicit stay(-1) cap

## Problem

Water is Andy's #1 killer — 130 of 213 deaths (61%) in the P9 era, and the
whole 2026-08-30 session re-proved it three separate ways:

- **A new post-deploy drown** at `(-9, 50, 8)` (y50, daytime, unarmed, 0
  items) — chased down into an *enclosed* underground water pocket, where the
  surface-drown `isInWater` veto (a *choice* gate) never fired.
- **A surface pool** at `(-2.5, 63, -4.7)`: `Block at Legs/Head: water`,
  `First Solid Above Head: none`, and the move trace was **vertical-only
  oscillation** (`y 63.2→65.4` at constant x/z) — bobbing in place, not
  swimming to shore. The self-preservation reflex fired
  (`selfpres:drown:tick oxygen=12 wet=32/32 → skills.surface(bot)`) but
  `surface()` did not escape him.
- **The telemetry churn** (devlog #7): `dig_in_when_hunted` re-fired 10× with
  the trigger still true because its `!stay` condition — *the ghost is gone* —
  was **unreachable** in an enclosed pocket, so the do never returned and the
  rule's own backoff never escalated.

The root cause across all three: the pathfinder treats water as a **free**
block to route through, so it sends Andy into deep pools to reach a goal (or
flee), and once he is in a pool with no dry landing in range and no blocks to
pillar, `surface()` just bobs. The surface-drown veto stops him *choosing* to
walk into open surface water, but it does nothing when a goal is on the far
side of a pool, or when he is already in one.

## Change

### New `src/utils/water_aware_path.js`

Mirrors the existing `updateLavaAvoidance` pattern. Exports:

- `waterDepth(bot, pos)` — liquid directly **above** the feet (a pool you
  float in) or **below** it (you'd sink) = 2; a 1-deep stream (air above, solid
  below) = 1; not water = 0.
- `waterCost(bot, pos)` — `SHALLOW_WATER_COST` (4) for a 1-deep wadable stream,
  `DEEP_WATER_COST` (40) for anything deeper, **0** when the bot is already in
  water (the escape route must stay free so he can path back to shore), 0 for
  non-water. Null-guarded, never throws.
- `installWaterAvoidance(movements, bot)` — wraps `movements.safeOrBreak` once
  (sentinel-guarded, idempotent, self-heals on a fresh `Movements` after
  reconnect) to add the soft cost, degrading to the unbreakable cost on any
  error and **clamped so `base + extra` never exceeds 100** (the pathfinder's
  'unbreakable' cap — a wadable pool must never become a wall). Exposes a no-op
  `updateWaterAvoidance()` for API symmetry with the lava hook.

### `src/utils/mcdata.js` — wiring

Import the installer, and in `tameMovements` wrap `getPathTo` **again**
(outermost, runs first) so the cost is installed on the `Movements` every path
computes over. Same runtime-wrap style as the existing goal-guard wrap — no
`node_modules` edit, no new patch-package file, no fork. The install is wrapped
in `try/catch` because this runs in the pathfinder, where nothing catches.

### `src/agent/library/skills.js` — the stay cap (devlog #7)

An **explicit** `!stay(-1, condition)` whose condition never becomes true
previously parked the bot forever (the do never returned). Now it is capped to
one Minecraft day (1200 s = 24000 ticks @ 20 tps) so the bot un-parks and the
rule's existing unresolved/backoff machinery in `policy.js` can escalate. The
bound is applied **after** the already-true return (a met condition never logs a
spurious bound), and a **night-wait** (no condition, "day broke") is
intentionally left unbounded — that condition is real and reachable.

## Rejected options

- **Hard `blocksToAvoid` for water** — would make a river uncrossable, the
  exact 'can't get across' trap we are fixing. A soft cost is the point: the
  bot strongly prefers a dry route but can still cross shallow water when no dry
  route exists.
- **World fill at the (5, 56, -6) pocket** (P9-style `barrier replace water`) —
  the user explicitly declined world edits this session. This fix is
  behavior-only and does not touch the world.
- **A tp-rescue** — done as a **stopgap** (he was re-stuck in the surface pool
  minutes after the first rescue), but whack-a-mole without the pathing fix.
- **A new `water_escape` mode/skill** — the pathing fix covers the *entry*
  half and the existing self-preservation reflex already covers the *in-water*
  half; a new mode adds policy-storm risk for little gain.

## Verification

- `src/utils/water_aware_path.test.js` — 22 assertions: the
  cost/depth function (shallow cheap, deep expensive, free to escape, null-safe)
  **and** the installer (idempotent, no-throw, degrades a throwing `safeOrBreak`
  to 100, never pushes a wadable block over the 100 cap, in-water no-op,
  null-bot returns the Movements unwrapped).
- `src/agent/library/stay.test.js` — extended: an explicit
  `stay(-1, cond)` now logs `Bounded an indefinite wait` and a night-wait does
  not; all prior stay/stayUntil/self-prompting assertions still pass.
- Regressions green: `boss_tier`, `huntable`, `surface_drown`,
  `drowning_debounce`, `oxygen_scope`.
- `node --check` clean on `water_aware_path.js`, `mcdata.js`, `skills.js` + the
  two checks.
- Deployed the 3 runtime files (`bash tools/live_*.sh deploy ...` → "restart
  sent to Andy"); clean restart, no throw on the new code. Post-restart rcon:
  alive, full health 24.0f. (He was at y51 in the cave region at check time —
  already in water, so the **behavioral** proof that he now routes *around*
  pools rather than into them is the next observation window's job, not the
  deploy's.)

## Open items

- **Observation window:** confirm over the next few hours that he stops
  re-entering deep pools (and that the `dig_in_when_hunted` / `stay` churn and
  the 21-listener warning quiet down as a downstream effect).
- **The (5, 56, -6) water pocket world fill** — still pending if the
  behavior-only fix does not hold. The user declined it this session.
- **Commit + push** — this set awaits approval.
