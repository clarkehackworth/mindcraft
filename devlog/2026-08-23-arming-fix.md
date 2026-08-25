# Arming fix: chest fallback crafts and equips a starter sword

**Status:** shipped (live policy change, verified)
**Date:** 2026-08-23

## Problem

The 11h audit after the 2026-08-22 self-layer clear (46 deaths, 0 crashes) showed
the water fixes working — drowning fell to 10/46 (22%, from 78% of deaths the
prior window) — but a new #1 killer: **arrows, 26/46 (57%), all from modded
Chillagers**. 41/46 were daytime, 41/46 while Andy was **unarmed**, and 32/46
with an empty inventory.

The death spiral, verified in code and logs:

1. The pinned `arm_yourself_from_the_chest` rule's do-list was
   `[withdraw weapon, equip]`. The base chest holds planks and sticks, **not a
   weapon** (15 pine_planks, 6 sticks), so `withdraw` found nothing and the
   rule fired 10x "accomplishing nothing" — cooldown doubling, never arming.
2. `craft_a_weapon` was `[craft wooden_sword]` with **no equip step**. The
   crafted sword stayed in the bag: `has_item weapon` counts inventory, not the
   hand (`policy.js:188`), so he fought bare-handed while a sword sat in his
   hotbar. LLM plans showed the "equip sword" step stuck unchecked 100+ times —
   the policy layer, not the LLM, was the gap.
3. `flee_ranged_raiders` fired 95x, but fleeing doesn't outrun Chillager
   arrows at range, so the flee rule was not the answer.

## Change

Two edits to `policies/survive_upgrade.json` (19 insertions, 2 deletions),
relying on verified do-list semantics: a step that returns false does **not**
abort the rest of the list (per-step try/catch, `policy.js` ~1560), and
`withdraw` expands family names (`policy.js:589`), so `planks` matches the
chest's pine_planks.

| rule | do-list before | do-list after |
|---|---|---|
| `arm_yourself_from_the_chest` | withdraw weapon -> equip | withdraw weapon -> **withdraw planks x2 -> withdraw stick -> craft wooden_sword** -> equip |
| `craft_a_weapon` | craft wooden_sword | craft wooden_sword -> **equip** |

Now the pinned rule resolves its own trigger in both cases: if a real weapon
is stashed, step 1 takes it; if not (the verified common case), the chain
crafts and equips a starter sword from the chest's own planks. `equip_weapon`
is a cheap action explicitly sanctioned inside `interrupts: all` rules
(`policy.js:2017`).

Deploy: `deploy policies/survive_upgrade.json` -> `regen survive_upgrade`
(no attributes = deterministic copy, not the LLM merge).

## Options rejected

- **Tuning `flee_ranged_raiders` / daytime-cover rules** — bigger behavior
  changes; deferred until the arming fix is proven in the next 24-48h arrow
  window. One change at a time, per the RUNBOOK iterate-verify loop.
- **A new rule for the chest fallback** — the pinned `arm_yourself_from_the_chest`
  was already the right trigger (unarmed + chest nearby); a second rule would
  duplicate it and fight over the same action.
- **LLM-merge regen (attributes)** — known context-length dead end; the
  no-attribute path is a plain copy of the edited base.
- **Conditional do-list** — the format has no branching; the non-aborting
  step semantics are what make the fallback chain work, and the cost of the
  "chest already had a weapon" case is one-time waste of 2 planks + 1 stick.

## Safety and verification

- **Live == base confirmed before editing** (78 rules, 0 name diffs, both
  target do-lists identical in live and repo) — the regen could not discard any
  live `!policy` edit. Pre-change backup:
  `.backup/Andy-policy-2026-08-23-pre-arming-fix.json`.
- The `generate-policy` handler discards the merge if the active layer changed
  under it (`mindserver_proxy.js:196`), so a mid-regen `!policy` write cannot
  be silently overwritten.
- Post-regen live policy pull (`.backup/Andy-policy-2026-08-23-post-arming-fix.json`):
  compose `{base: survive_upgrade, attributes: [], generated_at: 1787496399674}`,
  78 rules, both new do-lists exact, self layer absent, 5 spot-checked rules
  intact (keep_stone_stocked, mine_coal_ore, surface_when_drowning,
  keep_out_of_water, flee_ranged_raiders).
- `watch 'Uncaught|FATAL|crash' 30m` = zero hits; liveness confirmed moving
  (`-13 62 77` -> `2 67 -1` across checks).
- Runnable check left behind (no new framework): `node tools/arming_fix_check.js`
  pins both do-lists, the unchanged triggers, and pinned/interrupts flags.
  `policies_valid` (6/6) and `policy_check` also pass.

## Next

Watch the next 24-48h arrow-death trend. If armed daytime deaths persist, the
next investigation is flee/cover behavior (a policy gap or code bug, RUNBOOK
§7: reproduce -> change -> leave a `*.test.js` -> deploy -> verify zero
Uncaught/FATAL).
