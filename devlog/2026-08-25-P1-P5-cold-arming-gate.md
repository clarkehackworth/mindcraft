# 2026-08-25 — P1-P5: Cold-Rule State Gap, Log Spam, Night-Lock, Gate Telemetry

## Problem

After the 09:00 CDT checkpoint, three failure modes were confirmed from the 90-min log slice:

1. **`get_out_of_the_cold` is a proven killer (P1).** Fired 10× in the window; the bot froze to death at `(-22,58,-14)` in front of it. Root cause: a **state gap**. In the open shaft (y58→y66 surface), `is_sheltered` correctly read false (sky above), but `can_dig_down` was also false (stone/ore underfoot, no pickaxe). So `dig_in_out_of_the_cold` (the rule that actually builds shelter, line 342) never fired. `get_out_of_the_cold` (line 375) fired instead, executed `move_away 10` (which does **not** clear weather-freezing — the `isFreezing` code comment at `policy.js:94` says "walking ten blocks does not stop it snowing"), and re-fired every 60s cooldown. 10 fires = ~100 blocks of wandering in a snowstorm. The prompt told the bot to "dig two blocks into the nearest hillside" but `can_dig_down` was false, so the instruction was unreachable. The leather-armour suggestion was also unreachable (0 items post-death).

2. **`entity.objectType` deprecation spam (P3).** 1,934 lines in a 20-min slice (~1.6 lines/s) from `getNearestDrop` at `skills.js:1139`. Caught (no `Uncaught`/`FATAL`), but at this rate it masks real errors in log monitoring.

3. **`dig_in_when_hunted` night-lock (P4).** The stay-until condition `not hostile_nearby 12 and not is_night 1500` with `seconds: -1` holds **all night** at night (is_night 1500 is false during the night window → the stay runs indefinitely until ~1500 ticks before dawn). While this mode ran, `agent.js:687` dropped every LLM self-prompt command, locking the bot out of the dig-up escape for the entire night. The policy's own `give_up_on_a_stuck_path` (40 noPath) finally broke him out at dawn — and he then froze to death.

4. **Arming chain still unproven (P5).** 0 fires of `arm_yourself_from_the_chest` in the 90-min window, even though the bot reached base (goal_reached + head_home completed). The 24-block hostile gate is the top suspect on a 443-mod server with chillagers. Cannot distinguish "gate closed most of the day" from "chest trigger never matched" without telemetry.

## Change

### P1 — `get_out_of_the_cold` state-gap fix (policy)

- Added `"not": {"cond": "can_dig_down"}` to the `when.all` list. Now the rule only fires when `dig_in_out_of_the_cold` **cannot** help (can_dig_down false). When can_dig_down is true, `dig_in_out_of_the_cold` (earlier in file, line 342) handles it.
- Removed `move_away 10` from the `do` list. It does not clear weather-freezing and sends the bot wandering into the storm. The LLM should pathfind to a diggable hillside or natural cover, not blindly move 10 blocks.
- Rewrote the `prompt_self` message to lead with the reachable action for an empty-handed bot: "find a diggable hillside or dirt bank where you CAN dig in, or a natural overhang/cave entrance." Dropped the leather-armour suggestion (unreachable with 0 items). Kept the powder-snow escape and torch/campfire options as secondary.
- `cooldown` stays at 60s. `pinned` stays true.
- Changed `interrupts` from `all` to `idle`: the policy validator (`policies_valid.ollama.js`) rejects a rule that interrupts whatever is running while only doing `prompt_self` (which cannot change the trigger conditions). With `interrupts: idle` the freeze prompt reaches the bot when it is idle — which is exactly the stuck case, since failed pathfinds leave the action slot free — and it never stomps a running flee/dig attempt.

### P3 — `entity.objectType` spam fix (skills.js:1139)

- Removed `e.objectType === 'Item'` from the `getNearestDrop` predicate. The remaining three checks (`e.name === 'item'`, `e.displayName === 'Item'`, `e.entityType === 'item'`) cover the same ground for both vanilla and modded servers. One-line change.

### P4 — `dig_in_when_hunted` night-lock cap (policy)

- Changed `seconds: -1` → `seconds: 600` (10 min) on the stay action. After 10 min the stay ends, the rule's do-list completes, and the next rule evaluation happens. If the hostile is still there, the rule re-fires after the 60s cooldown and the bot tries again. This breaks the all-night lock while still giving the bot a full 10 minutes to wait out a hunt.

### P5 — Arm-gate telemetry rule (policy + policy.js)

- Added a `log` action leaf to `ACTIONS` in `policy.js`: a cheap sub-ms no-op that prints `EVT policy:log:<message>`. Added to `AIMLESS_ACTIONS` so a log-only rule with no positive trigger would still be rejected by the aimlessness guard (this rule has a positive chest trigger, so it is fine).
- Added `arm_gate_closed` rule at the end of the rules array: `when` = not has_item:weapon + block_nearby:chest#32 + hostile_nearby#24 + not water#8 — exactly the arm rule's preconditions with the 24-block hostile gate flipped, so exactly one of the two is eligible per tick and they cannot compete. `do` = `log` (marker line), cooldown 300, `interrupts: idle`, pinned.
- The measurement is the engine's own fire log: `EVT rule:fire:arm_gate_closed` is printed for every rule fire (policy.js:1565) *before* the arbiter decides whether it may take the action slot. `interrupts: idle` means the telemetry rule never stomps the arming chain it is measuring (single action slot, `action_manager.js`), and the count is recorded even when the arbiter defers it.
- 24h readout: high `arm_gate_closed` count + 0 arm fires → gate is the binding constraint (loosen 24→16 or day-gate). Low `arm_gate_closed` + arm fires but stuck/unresolved → chain is broken downstream. Both low → the bot is simply far from base (chest trigger never matches).

### P6 — Death-mix analysis (no code)

Death mix in the 90-min slice: 1 death (zombie, night, unarmed, 1 item). Cumulative 12.5h: 11 deaths — arrow 4, starve 2, freeze 1, iceologer 1, mob 1, drown 1, other 1. The rotation from the handoff (arrow 4, starve 2, mob 1, drown 1) is now dominated by **ranged** (arrow 4 + iceologer 1 = 5/11) and **cold** (freeze 1 + starve 2 = 3/11). After P1-P5 land, the next levers are: (a) ranged-killer handling (skeleton/iceologer aggro at range), (b) food rules (starve 2), (c) de-dupe `death.attack.drown` (same event double-labeled).

## Decisions

- **Why not fix `isSheltered` for tight cavities?** The hole was an open shaft (sky above), not a tight cavity. `isSheltered` correctly returned false. The bug was the state gap between `can_dig_down` and `get_out_of_the_cold`, not the shelter detection. Changing `isSheltered` to check side blocks would be a broader change with unclear blast radius (it gates `dig_in_when_hunted`, `shelter_when_night_and_no_bed`, `wait_out_the_night_under_cover`, and `flee_when_hurt`). Rejected.
- **Why `seconds: 600` for P4, not 300 or 900?** 300s (5 min) is too short — a hostile mob in a 443-mod pack can take 5-10 min to lose aggro. 900s (15 min) is too long — the bot could freeze in a hole for 15 min. 600s (10 min) is the sweet spot: enough to wait out a hunt, short enough to avoid the night-lock. The rule's 60s cooldown means if the hostile is still there after 10 min, the bot re-evaluates and tries again.
- **Why a telemetry rule for P5, not a code change to the policy engine?** A code change to log every non-fire of every rule would be invasive and affect all rules. A single telemetry rule scoped to the arm chain is minimal, reversible, and answers the specific question ("is the 24-block gate the binding constraint?") without touching the engine.
- **Why a `log` action for P5, not `prompt_self`?** The code's own comment calls `prompt_self` "a standing bill" — ~30s latency and a paid model generation per fire. For a rule that fires every 300s while at base, that is a standing cost plus the risk of the LLM hijacking the action slot in the middle of the arming chain it is meant to measure. The `log` leaf is free, sub-ms, and the fire log the engine already prints is the actual measurement. Rejected: `prompt_self` (cost + interference), engine change to log non-fires (invasive, all rules).
- **Why not loosen the arm gate (24→16) now?** The gate was added on 2026-08-24 specifically to prevent arming mid-raid (79× GoalChanged pre-emption proved it). Loosening it without telemetry data on how often it's closed risks re-introducing the mid-raid death pattern. Measure first, then decide.

## Options Rejected

- **Adding a `has_pickaxe` condition to `dig_in_out_of_the_cold`:** The rule already gates on `can_dig_down`, which checks `canHarvest` against held items. No change needed.
- **Making `get_out_of_the_cold` use `dig_in` as its action:** `dig_in` requires `can_dig_down` to be true (it's a precondition of the dig_in skill). If can_dig_down is false, dig_in fails. The prompt + LLM pathfinding is the right tool for the "find a diggable spot" case.
- **Removing the `hostile_nearby 24` gate from `arm_yourself_from_the_chest`:** Rejected for the same reason as above — the gate exists to prevent mid-raid arming. Measure before removing.

## Verification

- `node tools/arming_fix_check.js` — shape check
- `node tools/policy_check.js` — rule assertions
- `node src/utils/policies_valid.test.js` — 6/6 policy validators
- `node src/utils/recipe_cache.test.js` — 9/9 recipe cache
- Deploy + regen + `live_ollama.sh policy` (base name, rule count, layers)
- `live_ollama.sh evt 'rule:fire' 600` — watch new rules fire over ~10 min
- `live_ollama.sh deaths 6h` — death curve

## Backups

- `.backup/Andy-policy-2026-08-25-pre-P1-P5.json` — repo policy pre-edit (sha d1d34847)
- Reversible via `docker cp` + regen.
