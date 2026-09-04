# Cave-layer descent veto + night shelter at the Base

**Date:** 2026-09-04 · **Branch:** `develop` (feat/mindserver-bind-auth line) · **Status:** shipped

## Problem

The 6-hour window after the escape-position fix (2026-09-03) held 3 deaths with
crashes at 0, and the unbreakable gate firing cleanly (8 clean refusals, 0 raw
`dig time` Infinity throws). So the water *escape* leak was closed — but two
other killers were now the whole death count:

1. **Starvation, cave layer.** Stuck at `(-26, 54, 82)` — inside the measured
   pocket, y=54 — in a water/**coal**-filled depression. No pickaxe, bare
   hands, `coal_ore` and `diorite` around him, no way out. Starved. The pocket
   was priced at 99 (a strong deterrent) for *everyone*, yet a tool-less bot
   still got routed down: 99 is a near-wall, not a wall, and a goal pull plus
   a long route can beat it.
2. **Zombie at night, ×2.** `(-27, 63, 79)` and `(-27, 63, 75)` — both night,
   both surface, both ~10–14 blocks **south** of the Base, both unarmed
   (`items0`). He was *near* the house at nightfall, not *in* it. The existing
   `head_home_before_dark` rule only fires when `far_from_home` exceeds 48 —
   ten blocks out, it never sees him. And the rule that *was* meant for exactly
   this case, `shelter_at_base_when_night_falls_short`, was written against a
   condition `closer_than` that does not exist in the policy language — the
   rule parsed but could never match, a silent dead rule.

## Change 1: the tool-less pocket wall (starvation class)

`src/utils/water_aware_path.js`:

- **`hasDigTool(bot)`** (exported): true iff the inventory carries a
  **pickaxe**. Null-safe (no throw out of the tick path).
- **The wrapper escalates, not a second cost.** In
  `installWaterAvoidance`'s wrapped `safeOrBreak`, after `waterCost` prices a
  block, `if (extra === DEATH_WATER_COST && !hasDigTool(bot)) return 100;`
  — a tool-less bot sees the pocket as the pathfinder's unbreakable **100
  wall**, on cave **air** as well as water (a fall into the pocket is never
  charged a water step, which was the water cost's own blind spot). A
  pickaxe bot keeps the soft **99** — it can descend to mine and can always
  dig itself out. A bot already *inside* the pocket still gets **0** from
  `waterCost` itself, checked before the escalation, so the free exit
  survives.

`water_aware_path.test.js`: the old `caveAirCost` section (a separate
position-only cost function) is replaced by wrapper-based tests: tool-less
air-in-box → 100, pickaxe → 99, outside the box → free, inside the pocket →
free exit, the wall is 100 **flat** (never `base + 99`), and null block/pos
never throw.

**Options rejected:**

- *A separate `caveAirCost(pos)` function.* Double-ownership of the pocket
  price: `waterCost` already returns 99 for any position in the box, air or
  water, so a second function pricing the same blocks was redundant, and the
  first draft of it was **additive** (`base + 99`, clamped by the ≤100 guard
  back to *free*) — it was a silent no-op. The wrapper escalation owns the
  99→100 upgrade in one place.
- *Widen the box / veto all `y < 60`.* The box is the *measured* death ring,
  and a global cave veto would kill legitimate cave mining for pickaxe bots.
- *Gate on "inventory non-empty".* A bot with only a sword still cannot clear
  `coal_ore`/`diorite`; the tool that matters is the pickaxe, and only the
  pickaxe.
- *A stuck-escalation to dig out.* He had no tool to dig *with*; escalation
  can't manufacture one. Not going down is cheaper than digging out.

## Change 2: the night shelter rule gets a real condition (zombie class)

`bots/Andy/policy.json` — `shelter_at_base_when_night_falls_short` now reads

```
all: [ is_night (lead 1500), not is_sheltered, not far_from_home 16 ]
do:  goto the Base
```

`far_from_home` (policy.js:312) is horizontal-only, `dist > range`; wrapped in
`not` (negated at eval, policy.js:1514, sibling args preserved at 1363),
`not far_from_home 16` = **within 16 blocks of home** — the "ten blocks south
of the house at dusk" band that `head_home_before_dark`'s 48 never covers.
`is_night` with lead 1500 fires *before* nightfall, while the mob spawn
budget is still cheap. `not is_sheltered` keeps a bot that is already under
cover from abandoning it for the walk.

**Options rejected:**

- *Shrink `head_home_before_dark`'s range to 16.* That rule's job is the long
  leash ("you're far out, come home"); re-tuning it to fix a near-home gap
  couples two behaviors and re-tests a rule that was working.
- *Gate on "mob nearby".* Both deaths happened while *walking home at dusk*,
  not while being chased; a mob gate would have let the first hit land first.
- *Build the roofed enclosure (the original "airtight house").* Bigger, its
  own change, its own observation window. The rule gets him **into** the
  existing structure — the barrier pocket — which mobs cannot open; that is
  the whole fix needed for this class.

The policy file is gitignored (`bots/**/`); the durable trail is the
`.backup/Andy-policy-2026-09-04-pre-cave-veto-night-shelter.json` snapshot,
same convention as every prior policy change.

## Verification

| Check | Result |
|-------|--------|
| `node src/utils/water_aware_path.test.js` (4 suites, incl. new tool-less wall section: 100 flat on air, 99 pickaxe, 0 outside box, 0 inside pocket, null guards) | pass, 0 fail |
| `node tools/policy_check.js` (validates every rule against the real condition table — this is what catches a `closer_than`-style dead rule) | all assertions passed |
| `node --test src/utils/policies_valid.test.js` | 0 fail |

## Observation window

| Metric | Last window | Success looks like |
|--------|-------------|--------------------|
| Cave-layer starvation | 1 (trapped, y=54, no pickaxe) | 0 — the tool-less planner routes around the pocket, not into it |
| Night zombie deaths **within 16 of home** | 2 | 0 — dusk + near + unsheltered = inside the pocket before dark |
| Night zombie deaths **far from home** | 0 | 0 — `head_home_before_dark` untouched |
| `Refusing to break` (unbreakable gate) | 8 clean | keeps firing cleanly, 0 raw Infinity throws |
| Pocket drownings | 0 | 0 — escape-position fix holds |

## Follow-ups (not this change)

- The out-of-box `z=131` drowning edge (cave-layer air *outside* the measured
  ring) stays covered by the soft deep-water cost only; revisit only if it
  recurs.
- The roofed night enclosure is the next-size-up fix if `shelter_at_base` +
  the pocket still leak a night death.
