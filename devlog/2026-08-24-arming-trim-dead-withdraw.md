# 2026-08-24 — Trim the three dead chest-withdraw steps from arming

Follow-up to `2026-08-23-arming-collect-wood.md` (and the "next change" it
named at the bottom). The 08-23 collect-wood fix is live but not working: the
24h re-check audit (fired 17:35 CDT) shows `arm_yourself_from_the_chest` fired
35x / stuck 40x (flat vs baseline) and **0** wooden_swords crafted or equipped in
the window. The bot is arming himself from nothing, and the dead weight is the
chest path.

## Problem

The do-list was `withdraw weapon → withdraw planks → withdraw stick → collect
log#4 → craft wooden_sword → equip_weapon`. The first three steps assume the mod
chest GUI opens and hands over a stored weapon or pre-made planks/sticks. On
Prominence 2 it does not — the 24h audit tallies:

| Failure line | 6h count | Meaning |
|---|---|---|
| `The chest never opened` | **778** | the 3 withdraw steps each churn ~10s, bot stands **unarmed in the open** the whole time |
| `Failed to collect log: GoalChanged` | 79 | higher-priority rules (flee_ranged_raiders 90x, keep_out_of_water 61x) flip the goal mid-collect → wood never gathered (separate bug, see Next) |
| `no resources to craft → oak_planks(26) > spruce(7) > pine(4)` | 37 | recipe resolves to oak most; if `collect:log` breaks pine, the same-suffix substitution doesn't fire (separate bug, see Next) |

778 churn events × ~10s ≈ the bot spending minutes per arming attempt doing
nothing but failing to open a chest, while the one step that *could* source wood
(`collect log`) runs last and only if he survives to it. The withdraws never
contributed a craft — the chest is empty or the GUI won't open — so they are pure
dead weight with a live liability (unarmed, in the open).

## Change

Remove the three `withdraw` steps from `arm_yourself_from_the_chest` in
`policies/survive_upgrade.json`. The do-list is now the self-sufficient chain:

```
collect log#4 → craft wooden_sword → equip_weapon
```

The **trigger is unchanged** (unarmed + a chest within 32), so the chest-nearby
gate is kept as the *at-base* signal — the rule still fires when he is home and
needs a weapon. What changed is only what it *does* once it fires: it no longer
wastes ~30s per attempt on a chest that never opens, and it gets to the
self-sufficient wood source immediately.

Also updated `tools/arming_fix_check.js` to pin the trimmed chain (it previously
`deepStrictEqual`-pinned the 6-step list, so it had to move with the change to
stay a meaningful gate).

## Decisions / options rejected

- **Fix the `withdraw` skill for the mod's chest GUI.** Rejected, again: it is a
  bigger, riskier change to a shared skill, and the chest is often empty/out of
  range too — even a working GUI wouldn't guarantee planks. The 08-23 devlog
  already chose the bot-controlled wood source over this; the 778x count just
  confirms the withdraws are not the ideal path, so they go.
- **Keep the withdraws but reorder `collect log` first.** Rejected: a `withdraw`
  that opens no chest still costs ~10s each (the 778x count). Reordering doesn't
  remove the dead time; it only delays it. Removing removes it.
- **Gate the trigger tighter (e.g. drop `chest nearby 32`).** Rejected for this
  change: the data shows the rule *already fires* 35x (a chest is in range) and
  it stalls on the do-list, not the trigger. Trigger semantics belong to the
  GoalChanged fix (Next), not this trim.
- **Force-arming mid-raid.** Not attempted: arming during a `flee_ranged_raiders`
  / `keep_out_of_water` pre-emption may be genuinely bad timing. That intent
  question is part of the GoalChanged work, kept separate so this stays minimal
  and lowest-risk.

## Safety

- One base file changed (`policies/survive_upgrade.json`) + one check file
  (`tools/arming_fix_check.js`). No source or tick-path code touched — `collect`,
  `craft`, `equip` are existing actions, so nothing new can throw in the packet
  path. `pinned`, `interrupts:all`, `cooldown:60`, and both `when` gates
  unchanged.
- Local gates before deploy, all green:
  - `node tools/arming_fix_check.js` → passes, pins `collect:log#4 -> craft:wooden_sword -> equip_weapon`.
  - `node --test src/utils/policies_valid.test.js` → 6/6 pass.
  - `node tools/policy_check.js` → all pass.
- Reversible: `.backup/Andy-policy-2026-08-24-pre-arming-trim.json` (pre, 87040
  bytes). Restore via `docker cp` + `regen survive_upgrade`.

## Verification (live, via socket)

- `deploy policies/survive_upgrade.json` → base pushed to `/app`, restart sent
  (exit 0).
- `regen survive_upgrade` (deterministic no-attribute path) → `regen OK`.
- **Live** composed policy re-pulled: active layer `generated from base
  "survive_upgrade"`, 78 rules, `arm_yourself_from_the_chest` do-list is exactly
  `collect:log -> craft:wooden_sword -> equip_weapon`, `pinned: true`,
  `interrupts: all`, `cooldown: 60`. The 3 withdraw steps are gone from the
  running agent.
- Bot alive: rcon `pos` → `-6 65 8` (moving).
- Crash watch `watch 'Uncaught|FATAL' 6h` → **exactly one** line, the pre-existing
  V8 heap OOM (`Ineffective mark-compacts near heap limit ... heap out of
  memory`) from 21:42Z (~3h before this change). Zero new `Uncaught` and zero new
  `FATAL` from the trim. That OOM is the separate stability bug (handoff priority
  5), not introduced and not fixed here.

## Next (priority order, unchanged from the handoff)

1. **GoalChanged pre-emption (79x mid-collect).** Trim alone won't fix it — the
   bot now reaches `collect log` faster, but a higher-priority rule still flips
   the goal mid-gather. Options: gate the arm trigger with "not fleeing/
   evacuating" (check how the arbiter exposes active rules in `src/agent/behavior/`),
   or make the wood-gather re-acquire on resume. Verify intent before forcing
   arming mid-raid.
2. **Wood family.** Confirm which block `collect:log` actually breaks vs what
   `wooden_sword` resolves to (oak > spruce > pine in the 37x "no resources"
   lines). If mismatched, point the collect at the resolved plank family or fix
   the recipe ranking (`modded_wood.test.js` covers family names
   but not this ranking path).
3. **Make the check mean it.** Extend `arming_fix_check.js` or add
   `tools/arming_tally_check.js` to assert on *live* tallies: `Crafted 1
   wooden_sword` > 0 in window, chest-churn < N, GoalChanged < N. (This check can
   only pin the do-list shape today; shape ≠ outcome.)
4. **Track the V8 heap OOM.** One occurrence, clean 16s auto-restart, no
   `Uncaught`, no crash loop — contract intact, but the heap grows unbounded
   (likely death/respawn storm + LLM response history). A `tools/soak_watch.sh`
   soak or a heap-snapshot look. Separate from arming.

Readout is the next 24–48h: the `stuck`/chest-churn count should fall sharply
(the 778x source is gone), which removes the ~30s/rule of unarmed dead weight. If
he is *still* 0/0 on craft after that, the cause is #1 or #2 above, not the
do-list.
