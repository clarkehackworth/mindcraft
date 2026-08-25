# 2026-08-23 — Arm self-sufficiently: `collect log` before the craft

Follow-up to `2026-08-23-arming-fix.md`. The arming fix (09:49) made the chest
fallback craft + equip a starter sword, but the 6h audit after it showed the rule
still isn't arming him.

## Problem

6h audit (14:47): `arm_yourself_from_the_chest` **fired 29x, got stuck 40x**, and
11/14 of the fresh deaths were **empty-handed** (and 13/14 unarmed). The live log
proved the do-list starves:

```
The chest never opened; giving up.            <- the mod's chest GUI won't open
Could not find any pine_planks in the 4 nearest chests.
You do not have the resources to craft a wooden_sword. It requires: larch_planks: 2, stick: 1
```

The do-list was `withdraw weapon → withdraw planks → withdraw stick → craft
wooden_sword → equip_weapon`. It assumed the chest would open and hand over planks
or sticks. On this server it does not (the mod replaced the chest GUI; the chest is
empty or out of range), so the bot reaches `craft wooden_sword` **empty-handed** and
every step no-ops. `craftRecipe` itself is fine — the log also shows it succeeding
when the bot has wood (`Crafted 1 wooden_sword` from a world-sourced log, via the
modded raw-recipe path that substitutes same-suffix wood). The gap is that nothing
in the do-list **fetches wood** when the chest is broken.

## Change

One line in `policies/survive_upgrade.json`, `arm_yourself_from_the_chest`: insert
`collect log` (num 4) immediately before the `craft` step.

```
withdraw weapon → withdraw planks → withdraw stick → collect log#4 → craft wooden_sword → equip_weapon
```

The withdraws stay first (the ideal path when a chest *does* hold a stored weapon
or pre-made planks). `collect log` is the self-sufficient fallback: it makes the rule
guarantee a wood source independent of the chest. `collect` is a **blocking** action
(so it registers as real_work and resets the stuck counter), the `log` family name
reaches the modpack's `pine_log` (verified in `modded_wood.test.js`; `gather_wood_for_base`
already uses it and fires 22x), 4 logs covers planks + stick, and it degrades to a
logged `false` if no tree is within 64 — no regression.

## Decisions / options rejected

- **Fix the `withdraw` skill for the mod's chest GUI** — a bigger, riskier change to a
  shared skill, and the chest is also often empty/out of range, so even a working
  GUI wouldn't always yield planks. A wood source the bot controls is more robust.
- **Trim the three dead chest-withdraw steps** — a real secondary liability (each
  spends ~10s "the chest never opened" while the bot stands unarmed in the open), but
  a separate, bigger behavioral change. Kept them as the ideal path for now; if
  post-deploy data still shows the churn delays arming, that's the next change.
- **Relax the trigger (drop `chest nearby 32`)** — changes arbiter/priority semantics,
  and the data shows the rule *already fires* 29x (a chest is in range); it gets stuck
  on the do-list, not the trigger.

## Safety

- Only one base file changed (`policies/survive_upgrade.json`); trigger, `pinned`,
  `interrupts:all` unchanged. No source/tick-path code touched — `collect log` is an
  existing action, so nothing new can throw in the packet path.
- Local gates before deploy: `arming_fix_check.js` (updated to pin the new do-list),
  `policies_valid` 6/6, `policy_check` all pass.
- Reversible: `.backup/Andy-policy-2026-08-23-post-collect-wood.json` (post) and
  `.backup/Andy-policy-2026-08-23-post-arming-fix.json` (pre-this-change).

## Verification

- `deploy policies/survive_upgrade.json` → base pushed to `/app`, restart sent (exit 0).
- `regen survive_upgrade` (deterministic no-attribute path) → `regen OK`.
- **Live** composed policy re-pulled: do-list is exactly
  `withdraw weapon → withdraw planks → withdraw stick → collect log#4 → craft wooden_sword → equip_weapon`,
  `pinned: true`, `interrupts: all`.
- Bot alive (rcon `pos` → `-30 58 84`).

## Next

Readout is the next 24–48h: expect the `stuck` count to fall (a `collect` now earns
real_work credit) and the `unarmed`/`empty-handed` daytime arrow deaths to drop. If he
still dies unarmed, the collect is failing (no tree within 64, or the wood family is
wrong) and the next change is the withdraw-churn trim above.
