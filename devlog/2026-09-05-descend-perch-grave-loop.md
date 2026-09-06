# Descend perch: stop the grave-climb arrow-death loop

## Problem

Andy died repeatedly on skeleton arrows while perched on tomb pillars at
y=71 and y=68 in the graveyard. The `go_back_for_your_grave` rule fires on
`place_known last_grave_position` and does `goto_place closeness 2`.
The `last_grave_position` is recorded at the elevated death Y (the tomb
top) by `agent.js:1170` — YIGD puts the grave block at the death spot,
not at ground level. So the bot climbs the tomb to satisfy `closeness 2`,
perches 5–8 blocks above the ground, and skeletons outside the open south
wall shoot him. The rule fired 1,740 times in the observation window.

The `y_above` condition (policy.js:363) was written specifically for this:
"the bot climbs exposed perches where a ranged hostile can shoot but a
melee one cannot reach, and flee/move_away keep him at the same height.
Gate a descend rule on this so the bot gets off the perch before the
arrow lands." — but no descend action existed. `climb_out` only goes up.

## Change

Four code changes, one policy rule:

1. **`getOffPerch(bot, range)`** in `src/agent/library/skills.js`.
   Non-destructive descend. Scans the 8 neighbor columns for the nearest
   standable surface (solid below, air at feet+head) strictly below the
   feet, pathfinds there (pathfinder walks off the edge and falls).
   Fallback: face the steepest drop-off and walk off until feet Y drops.
   Never breaks perch blocks — so any cap or build up there is preserved.
   Returns true only if feet Y actually fell.

2. **`descend_perch` action** in `src/agent/behavior/policy.js` (ACTIONS).
   `cost: 'blocking'`, `clears: ['y_above', 'ranged_hostile_nearby',
   'hostile_nearby', 'entity_nearby']`, `fn: skills.getOffPerch`.
   Not in RETREAT_ACTIONS (descending is real progress, not a step back,
   so the cowardice check must not fire). Clears both trigger conditions
   so the rule that triggers on them is self-stopping — no livelock.

3. **`get_off_the_perch` rule** in Andy's self layer
   (`bots/Andy/policy.json` → `layers.self.policy.rules`).
   Pinned, `interrupts: 'all'`, `cooldown: 5`,
   `when: all[ y_above 67, ranged_hostile_nearby 24 ]`,
   `do: [ descend_perch ]`.
   The self layer is where Andy-specific world knowledge belongs
   (his graveyard floor is y=67 — a hard altitude that does not belong
   in the generic base policy). Pinned so it preempts the unpinned
   `go_back_for_your_grave` and the flee that keeps him at height.

4. **`MemoryBank.forgetPlace(name)`** in `src/agent/memory_bank.js`.
   Deletes a place from the memory dict. Hooked into `pick_up_drops`
   (policy.js): when `recoverGrave` returns true (grave opened, loot
   inside), call `agent.memory_bank.forgetPlace('last_grave_position')`.
   This stops the 1,740-fire loop at its source: once the gear is
   recovered, the target no longer exists. A failed trip keeps the place
   so the rule retries on the next idle window — correct behavior.

## Rejected options

- **Cap the tomb tops with glowstone** (manual world edit): removes the
  perch but makes the stored `last_grave_position` target unreachable,
  turning the climb-loop into an unreachable-target stall. Also a manual
  world edit — the durable fix must live in code or policy per AGENTS.md.
- **Ground `last_grave_position` to floor Y at record time**: would work
  but changes the semantics of a field that also serves the avoidance
  rules. The `forgetPlace` hook is more targeted: it clears the target
  only when the loot is actually recovered, and a failed trip still
  retries.
- **Put the rule in the base policy** (`survive_upgrade.json`): the
  `y_above 67` threshold is Andy-specific world knowledge. A different
  base at a different altitude would need a different Y. The self layer
  is the right home.

## Verification

- `node tools/descend_perch_check.js` — 7/7 pass (action wired, rule
  validates, self-stopping, condition shapes, forgetPlace, live self
  layer, full composed policy).
- `node tools/policy_file_check.js` — 7 layers, 0 invalid (the
  authoritative guard that validates both live layers AND base policies).
- `node --test src/utils/policies_valid.test.js` — 6/6 pass.
- `node --test src/agent/reflex_tick.test.js src/agent/stuck_escalation.test.js src/agent/skill_suggestions.test.js` — 11/11 pass.
- `node --check` on all three modified src files — clean.
