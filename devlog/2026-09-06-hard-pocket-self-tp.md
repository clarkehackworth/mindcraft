# 2026-09-06 — Hard-pocket self-tp escape

## Problem

After the near-spawn pit and cave ring were promoted to `hard: true`
(2026-09-06), a bot **already inside** a hard pocket has no breakable exit:
the pit has an unbreakable stone ceiling (`pathfinding & climbing FAIL`).
The stuck-escalation path (`STUCK_SAME_SPOT` consecutive ticks) called
`skills.moveAway(bot, 16)`, which requires a pathfinder route. In an
inescapable pit there is no route, so the bot bounces in a fixed column
forever (observed: Z locked at 1.49, Y bobs 50.0–51.06, action log empty).

The hard-wall fix correctly **stops the bot from getting in**, but nothing
resolves **"already inside and no exit."**

## Change

| Piece | File |
|---|---|
| `hardPocketEscapeTarget(pos, anchor)` | `src/utils/water_aware_path.js` |
| Stuck else-branch self-tp | `src/agent/agent.js` |
| Check §15 (6 sub-cases) | `src/utils/water_aware_path.test.js` |

**`hardPocketEscapeTarget`** — pure helper, takes `{x,y,z}` pos and anchor,
returns `{x,y,z}` target or `null`:
- `null` if bot is **not** in a hard pocket (moveAway is fine)
- `null` if anchor is **itself** in any death pocket (re-trap)
- `null` if anchor is **< 8 blocks** away (tp is a no-op; moveAway works)
- `null` if anchor is missing/NaN
- otherwise returns the anchor as the self-tp target

**Stuck else-branch** (`agent.js`): before falling back to `moveAway`,
computes the anchor (`bot.entity.spawnLocation ?? bot.respawn_point`) and
asks the helper. If a target is returned, the bot self-telports via
`bot.chat('/tp @s x y z')` — the same op-command pattern already used at
three sites in `skills.js`. The `bot.chat` call is wrapped in `try/catch`
per the "nothing in the tick path may throw" rule. If the helper returns
null (or the anchor is unset), the original `moveAway` fallback fires —
no regression for normal stuck cases.

**Check §15** covers: pit + Base → target, pit + ring anchor → null
(re-trap), outside pockets → null, anchor 3 blocks away → null (too
close), null/NaN/undefined guards → null/no-throw, ring + Base → target.

## Decisions

**Self-tp, not self-kill.** `bot.chat('/kill @s')` would drop the
inventory-grave **into the pit** where the bot cannot reach it to claim
it, recreating the exact stuck loop. Self-tp preserves the inventory and
lands the bot at the Base where the grave is reachable on the next armed
day.

**Helper in `water_aware_path.js`, not `skills.js`.** The pocket boxes,
`inHardPocket`, and `inDeathPocket` all live in `water_aware_path.js`.
The helper is pure (no bot, no chat), unit-testable, and
co-located with the data it reads. `skills.js` is the right layer for the
bot-facing action, but the pure decision logic belongs with the boxes.

**`spawnLocation` over `respawn_point`.** `bot.entity.spawnLocation`
is the server-side spawnpoint (re-asserted to Base during the pit fix).
`respawn_point` is the project's own anchor (set on respawn). Both point
at Base, but `spawnLocation` is the authoritative server value. Fallback
to `respawn_point` covers the brief window before the first respawn has
fired.

**Not a `descend_perch`-style policy rule.** The perch fix was a
self-stopping rule in the policy engine. This fix is in the stuck-
escalation path because the trigger condition is *stuck* (N consecutive
ticks in the same spot), not a positional gate. The policy engine
re-evaluates every tick; the stuck counter accumulates over time. These
are different failure modes needing different resolution points.

**One-off tp-rescue still valid as immediate un-stick.** The durable fix
prevents the *next* soft-stuck from persisting, but the sanctioned
`tp` to Base remains the right response when you find the bot already
bouncing in the hole.

## Verification

| Check | Result |
|---|---|
| `node src/utils/water_aware_path.test.js` | 5 ok lines, §15 new |
| `node src/agent/stuck_escalation.test.js` | pass |
| `node --test src/utils/policies_valid.test.js` | 0 skipped, 0 todo |
| `node tools/descend_perch_check.js` | PASS |
| `node tools/policy_file_check.js` | 7 layers, 0 invalid |
| `node --check` on all 3 modified files | clean |
