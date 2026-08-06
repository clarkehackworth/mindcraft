# Compiled policy rules that retreat forever

**Commit:** uncommitted · 2026-08-01

## Problem

Andy ping-ponged between two cave positions for hours. Its compiled policy had
`avoid_hostile_areas`: hostile mob within 24 blocks → `move_away 16`. `move_away`
picks a random direction, so underground — where "hostile within 24" is nearly
always true — it kept landing back inside the radius and re-triggering.
`flee_danger` was the same shape. Both duplicated the built-in `cowardice`
mode, which was already on and does this correctly.

## Change

`validatePolicy` now rejects a rule whose trigger is mob proximity and whose
only actions are `flee`/`move_away`, pointing the compiler at `cowardice`
instead. Same rule added to the compile prompt. Stripped both rules from
Andy's live policy as an immediate fix.

## Files

`src/agent/behavior/policy.js`, `src/agent/behavior/policy.test.js`
