# 2026-08-25 — Arming: remove the water gate + inject inventory ground truth

## Problem

The 7h base soak (12:05→19:22 CDT, after the pit-respawn fix) proved the
**arming chain still never ran**: `arm_yourself_from_the_chest` fired 0 and
`arm_gate_closed` fired 0. I pulled his authoritative inventory via rcon and the
picture was sharp:

- `data get entity clarkhackworth Inventory` = **only `cooked_beef ×2`**; held
  item = beef. No sword, no planks, no tools.
- His **self-memory claimed "wood tools"** and the plan step *"craft tools ✓"*
  was marked done — a **false completion**. `!craftRecipe(wooden_sword)` had been
  issued ×2 and **failed** (no wood in hand), but the model kept believing it
  had tools.

Two independent mechanisms kept him unarmed:

1. **The `not water#8` gate was permanently false at the one place arming should
   happen.** He lives in a base water pocket, so `block_nearby:water#8` was always
   true → `not water#8` always false → the rule's when-gates never all-true →
   0 fires. The gate existed to stop the `collect log` goto pathing through water
   where `keep_out_of_water` would interrupt it — but the same water is also where
   the *chest* is, so the gate killed the rule exactly where it was needed.
2. **The LLM self-prompt path has no inventory ground truth.** The self-prompt
   turn carries goal + plan but never the live inventory, so a stale "I have
   wood tools" belief from memory persists indefinitely and drives false
   plan-completions. `runAsAction` does return the craft's failure message to the
   model, but a *persistent belief* outlives a single error line.

## Change

**Policy (`policies/survive_upgrade.json`)** — remove the `not water#8` gate from
**both** `arm_yourself_from_the_chest` *and* its telemetry mirror
`arm_gate_closed`, keeping the hostile#24 gate and the "same preconds, hostile
gate flipped" invariant so the 24h readout stays valid. The arm rule now fires on
`not has_item:weapon + chest<32 + not hostile<24`. Drowning mid-arming is already
covered by `surface_when_drowning` (`air:12`, `interrupts:all`), so a `collect`
goto either completes in shallow water or is nudged out by `keep_out_of_water`
and retries on the 60s cooldown. Rule descriptions carry this decision log.

**Code (`src/agent/self_prompter.js`)** — add `inventoryLine()`: every self-prompt
turn now appends the bot's **authoritative** inventory (via
`world.getInventoryCounts`), e.g. `\nYour ACTUAL inventory (from the game, not
memory): cooked_beef x2. ... If a plan step needs an item you do not have, get it
first -- do not mark it done.` Guarded by try/catch so it **never throws** (the
self-prompt loop runs where nothing catches; a throw takes down the agent). On a
missing/empty/malformed inventory it degrades to `''` and the turn proceeds
exactly as before. New import `./library/world.js` (world.js only pulls
pathfinder/vec3/mcdata — no cycle).

**Checks** — `tools/arming_fix_check.js` shape assertions updated to 3 gates (drop
the water asserts) + a new `arm_gate_closed` mirror block (3 preconds, hostile
gate flipped, `interrupts:idle`). `src/agent/self_prompter.test.js` gains an
`inventoryLine()` case: real-items surfaced, self-labelled as ground truth,
no-bot → `''`, throwing-inventory → `''`.

## Decisions / rejected options

- **Why not loosen the hostile#24 gate instead?** The 7h soak showed the binding
  constraint is the water gate (permanently false at base), not the hostile gate.
  Loosening 24→16 would only matter *after* the rule can fire at all. Kept the
  hostile gate; the `arm_gate_closed` telemetry will tell us in the next 24h if
  it's the next constraint.
- **Why remove the water gate rather than move the bot out of the water pocket?**
  The pocket *is* where the chest is. The pit-respawn fix already moved his
  respawn to Base; re-shaping Base to be dry is a world change, and the gate was
  the code-side bug. `surface_when_drowning` already covers the drowning risk the
  gate was hedging against.
- **Why ground-truth injection instead of "trust the model's plan"?** The model
  false-completes a plan step the moment it *says* it crafted something, because
  the self-prompt loop has no feedback that the craft failed. Re-stating the real
  inventory every turn is the only thing that beats a persistent false belief. It
  is cheap (one inventory walk per turn) and degrades silently.
- **Why not also surface the last craft-failure?** `runAsAction` already returns
  the failure message to the model; the problem is belief persistence, not missing
  feedback. Ground-truth inventory covers the belief; no new state needed.

## Verification (local, pre-deploy)

All green:
- `node --test src/agent/self_prompter.test.js` 1/1 (incl. inventoryLine case)
- `node --test src/agent/self_prompt_recovery.test.js` 4/4
- `node --test src/agent/self_conversation.test.js` 2/2
- `node --test src/utils/policies_valid.test.js` 6/6
- `node --test src/utils/recipe_cache.test.js` 9/9
- `node tools/arming_fix_check.js` shape pass (arm = 3 gates, mirror = 3 preconds flipped)
- `node tools/policy_check.js` pass

## Open / next

Deploy `self_prompter.js` + `survive_upgrade.json` (regen, no LLM), then the next
24h readout: `arm_gate_closed` fires vs arm-rule fires → gate-openness; and watch
whether the inventory line stops the false "wood tools" belief (fewer false
plan-completions, an actual `crafted wooden_sword`). `--live` mode of
arming_fix_check.js asserts `crafted > 0` and `Uncaught/FATAL = 0`.
