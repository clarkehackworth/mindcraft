# Wood family verified: no bug, oak was the GateChanged consequence

2026-08-24, following the 24h re-check audit that left the arming chain at 0/0
sword crafts. The audit's "next steps" listed a **wood-family mismatch** (hypothesis
P3): `collect:log` was suspected of breaking a different wood than `wooden_sword`
resolved to, so the recipe ranked oak and the craft failed.

## What I checked

Traced the full path end to end and probed it against the real 1.20.1 registry
(`recipe_cache.test.js` loads `prismarine-registry`):

- `collect:log` → `expandBlockName('log')` → `WOOD_TYPES` (derived from the live
  `bot.registry` + mod_data packs), so on Prominence II it breaks **pine_log**.
- `getItemCraftingRecipes` ranks by what the bot *holds* first, falling back to the
  common-materials bias (oak) only when nothing is held. Probed:
  - held `spruce_log` → `['spruce_planks','stick']` first
  - empty → `['oak_planks','stick']` (the tiebreak)
- `getCraftingPlan('wooden_sword', 1, {spruce_log:4})` → `required:{}`, steps
  `4 spruce_planks → 4 stick → 1 wooden_sword`. The whole chain expands from a
  held log haul.

## Why the oak 26 / spruce 7 / pine 4 split is *correct*

The "no resources to craft" line ranks against `reachableCounts` = held + within
sight. That split is the ranking working as designed, not a bug:

| Named wood | Meaning |
| --- | --- |
| oak (26) | held **no** log and saw none — interrupted mid-collect before gathering wood |
| spruce (7) / pine (4) | held a **partial** log haul (1–2 of the 4 a sword needs) |

The oak cases are the `GoalChanged` pre-emption (hypothesis P2): a higher-priority
rule changed the goal mid-collect, so the bot reached the craft step empty-handed.
That is exactly what the 2026-08-24 gate (b36a4b0) suppresses — arming no longer
fires while a hostile is within 24 or water within 8. So **P3 resolves as a
symptom of P2, not an independent fix.**

## Decision

- **Rejected:** re-pointing `collect:log` at a specific plank family, and changing
  the recipe ranking to prefer a held wood — both would be fixing code that is
  already correct, and would mask the real cause (the gate).
- **Kept:** the existing ranking. It already answers to what the bot holds.
- **Added:** a `recipe_cache.test.js` pin for the exact arm path —
  "wooden_sword plans through the held wood; oak is only the empty-hand
  tiebreak" — so a regression to oak-on-held-log is caught by a runnable check.

## Verification

`node --test src/utils/recipe_cache.test.js` → 9/9 (was 8, +1 pin). No runtime
change, so no live deploy; the live agent already runs b36a4b0. The outstanding
readout is the `arming_fix_check.js --live` 24h window (crafted wooden_sword > 0),
which had not yet run since the gate landed.
