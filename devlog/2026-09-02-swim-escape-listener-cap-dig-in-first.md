# 2026-09-02: Swim escape, listener cap, and dig-in-first at night

## Problem

The collect-retry deploy (#12) finally moved the `Crafted wooden_sword` counter
from zero to **3** in a 7h window — the self-arming pipeline (gate → collect →
craft) works. But the bot died **8 times** in the same window, and 4 of those
were the exact deaths the earlier water fixes were supposed to prevent:

| Cause | Count | Notes |
|-------|-------|-------|
| Drowned | **4** | y=54–56, z=65–88 — the water pockets near Base |
| Zombie (night) | 2 | `(-27, 63, 76/77)` — at/near Base |
| Revenant (day) | 1 | `(-28, 63, 89)` — at Base, the graveyard camp |
| Phantom (night) | 1 | the only death where he was armed — unblockable ranged |

Plus a `MaxListenersExceededWarning: 21 collectBlock_finished listeners` — the
collect retry tripling `collectBlock` calls made a pre-existing listener leak
measurable.

Three separate fixes, three separate root causes:

1. **Drownings in enclosed pockets.** `surface()` held `jump` and swam up. In a
   pocket with an **undiggable** ceiling (stone it has no tool for), swimming up
   does nothing — the bot drowns in place. The old failure line said "pinned
   under X, nothing in hand can break it" and gave up. Holding still underwater
   is a death sentence.
2. **The listener leak.** `mineflayer-collectblock`'s pickup wait is a
   promise resolved by `entityGone`. A drop that never despawns (modded item,
   out of reach) leaves the `TemporarySubscriber` attached forever. Each
   collect adds one; 21 > Node's default cap of 20.
3. **Nighttime base deaths.** `flee_ranged_raiders` and `dig_in_when_hunted`
   both led with a long `flee` (40 / 16 blocks). Base terrain is fragmented —
   the pathfinder freezes the bot mid-flee, and a melee zombie closes the 14-
   block gap before the `dig_in` step (second in the do-list) ever runs. The
   rule fired 4× in the window and dug in 0×.

## Change

**1. Swim sideways out (`src/agent/library/skills.js`, `surface()`).**
When the ceiling is undiggable **and** `bot.entity.isInWater === true`, the
bot now swims sideways instead of holding jump in place: one ~1.5s forward
stroke per cardinal heading (`SLIDE_YAWS`), cycled on the loop's existing 100ms
tick so `interrupt_code` still preempts between strokes. Jump is already held
from loop entry, so each stroke also rises — a pocket that slopes up in *any*
heading is an exit. The stroke is released in the `finally` block (with the
jump) on **every** path, including the early `return true` — a bot that
surfaced mid-stroke would otherwise keep walking off the surface it just
reached. Dry-land pinned behavior is unchanged: a bot that is not in water
keeps the dig-or-wait loop, because sliding a dry bot just wastes the timeout.
The failure line now names the swim: "swam sideways through all four headings
for the full timeout and found no slope out."

**2. Listener cap (`patches/mineflayer-collectblock+1.6.0.patch`).**
The pickup wait gets an 8s `setTimeout` cap that resolves through the same
`finish()` as `entityGone`, so `tempEvents.cleanup()` runs even when the drop
never despawns. Applied via the existing `postinstall: patch-package` hook —
no fork (AGENTS.md: dependency fixes go in `patches/`). The running container
needed the patched file pushed explicitly (the tar deploy does not re-run
postinstall): `deploy node_modules/mineflayer-collectblock/lib/CollectBlock.js`.

**3. Dig-in-first at night (`policies/survive_upgrade.json`,
`bots/Andy/policy.json`).** Both `flee_ranged_raiders` and `dig_in_when_hunted`
reordered from `[flee, dig_in, stay]` to `[dig_in, flee, stay]`. `dig_in` is
local (no pathfinder) — it roofs the bot in the blocks it is standing in, so a
hunter cannot reach a bot frozen mid-flee. If the dig fails (no blocks, no
tool), the executor's per-step try/catch falls through to `flee` then `stay`
until dawn / the mob is gone — strictly better than the old order, which led
with the step that fails. The `flee` stays in the do-list because the validator
requires a RETREAT step before a `stay` gated on `not hostile_nearby`
(`policy.js:969–974`).

## Decisions

**Swim vs. dig sideways.** There is no dig-sideways skill, and in an enclosed
pocket the bot cannot move its feet far enough to make horizontal digging
useful. Swimming is free (mineflayer handles it), tick-driven (interruptible),
and every stroke also rises. Rejected: a `dig` loop in the X/Z directions — it
would need a new skill, a new check, and still fails in a pocket with no
horizontal room.

**Swim only when affirmatively in water.** `isInWater === true`, not
`!== false` — the bar is absent on dry land and the dry-land pinned case must
keep its current behavior. The harness asserts both: an underwater pinned bot
turns and releases forward; a dry-land pinned bot never looks.

**8s pickup cap vs. longer.** The pickup wait is a secondary confirmation — the
item is already reached. 8s is generous for a despawn-never modded item and
short enough that a genuinely broken drop does not stall the action for a
minute. Rejected: 30s (too long to stall an action), unbounded (the bug).

**`[dig_in, flee, stay]` vs. `[dig_in, stay]`.** The validator rejects a `stay`
gated on `not hostile_nearby` without a RETREAT step. And if the dig fails on
open ground, fleeing is the right answer — the reorder degrades gracefully
instead of holding a bot that cannot shelter.

**Reorder vs. new rule.** A dedicated `shelter_first_when_hunted` rule would
have been a fourth rule competing for the same trigger. The existing rules
already fire (4× in the window) — the problem was step order, not trigger
coverage. Rejected: a separate rule (rule proliferation, cooldown collisions).

## Runnable checks

- `src/agent/library/surface.test.js` — extended with the
  swim-escape case: an undiggable ceiling **in water** must turn (look), hold
  forward, release it on timeout, and name the swim in the failure line; an
  undiggable ceiling **on dry land** must not look (no wasted timeout).
  All 4 surface suites pass (12+1+1+1, 0 fail).
- `src/utils/policies_valid.test.js` — 6/6 pass after the
  reorder.
- `tools/policy_check.js` — all assertions pass.

## Deploy

- `deploy src/agent/library/skills.js policies/survive_upgrade.json bots/Andy/policy.json`
  → socket restart, agent reconnected.
- `deploy node_modules/mineflayer-collectblock/lib/CollectBlock.js` → socket
  restart, agent reconnected.
- Verified in container: `swam sideways` ×1 in `/app/src/agent/library/skills.js`,
  `Dig in first` ×2 in `/app/bots/Andy/policy.json`, `pickupTimeout` ×2 in
  `/app/node_modules/mineflayer-collectblock/lib/CollectBlock.js`.
- 0 `Uncaught`/`FATAL` across the 20-minute window covering both restarts.
- The bot respawned at night near `x-36,z71` immediately after the deploy — the
  new night policy is in live play from the first respawn.
- Pre-edit policy backup: `.backup/Andy-policy-2026-09-02-pre-night-defense.json`.
