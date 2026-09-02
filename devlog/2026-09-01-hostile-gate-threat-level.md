# 2026-09-01: Arm gate hostile_nearby 24 → recently_attacked 10 — threat level, not presence

## Problem

Experiment 1 (collect `num:4→1`) deployed, healthy, but the arm rule never fires
(`arm_fires: 0`) because the 24-block **presence** gate is permanently closed at
this base. The base sits in a graveyard biome — `entity.graveyard.revenant` mobs
spawn 1–2 blocks from Base (death positions `(-28.5, 63, 89.5)`, `(-27.3, 63, 90.5)`,
1–2 blocks from `(-29, 63, 89)`). `hostile_nearby range:24` is therefore `true`
permanently, and `not hostile_nearby` is permanently `false` — the arm rule is
dead at the one place it should work. `arm_gate_closed` (P5 telemetry) fired 3×
confirming the gate is the binding constraint, exactly what it was built to detect.

This is the same failure mode as the 2026-08-25 water#8 gate: a presence gate
that is permanently true at the one location the rule is meant for, permanently
blocking it. The water gate was removed (0 fires in a 7h soak proved it); the
hostile gate can't simply be removed — the 79× GoalChanged pre-emption (2026-08-24)
proved arming mid-raid is a real death pattern. The gate needs to be **threat-level
aware**, not presence-aware.

## Change

`src/agent/behavior/policy.js` — new condition:

```js
recently_attacked: {
    args: { seconds: 'number, how recent the damage must be (default 10)' },
    fn: (agent, a) => agent.bot.lastDamageTime > 0 && (Date.now() - agent.bot.lastDamageTime) < (a.seconds ?? 10) * 1000
}
```

Reuses the existing `lastDamageTime` signal (already set by the damage listener,
already used by `health_pct` and the flee reflex). No new listener, no new state,
no tick-path changes. `false` when `lastDamageTime` is 0 (never hit) — a fresh
spawn or a bot that has never taken damage is not under attack.

`policies/survive_upgrade.json` — two rules:
- `arm_yourself_from_the_chest`: `not hostile_nearby range:24` → `not recently_attacked seconds:10`
- `arm_gate_closed` (P5 mirror): `hostile_nearby range:24` → `recently_attacked seconds:10`

`tools/arming_fix_check.js` — shape assertions updated to the new gate; `gateStr`
helper extended to print `seconds` alongside `range`.

## Decisions

- **Why `recently_attacked` and not just removing the gate?** The 2026-08-24
  audit showed 79 GoalChanged pre-empptions while arming — starting a blocking
  collect while being actively raided is the exact death pattern. The gate earns
  its place during a real raid. The bug is that *ambience* (a revenant idling
  2 blocks away) and *threat* (a revenant hitting you) are indistinguishable to
  `hostile_nearby`. `recently_attacked` distinguishes them: the gate closes for
  10 seconds after the last hit, then reopens. A revenant camping at base without
  hitting you doesn't close the gate. A revenant actively hitting you does.

- **Why 10 seconds?** Matches the ActionManager interrupt window (10s) already
  used in the collect-abandon logic. If the bot was hit within the last 10s, the
  same interrupt that would abandon a blocking collect is likely still active.
  After 10s with no hit, the raid (if any) has ended or the bot has fled, and
  the 60s arm-rule cooldown provides the retry margin.

- **Why not `entity_nearby` with a name filter?** Would require knowing every
  hostile mob name in the mod pack (revenant, plus any others). `lastDamageTime`
is mob-agnostic: it doesn't matter *what* hit you, only that you were hit.
  More general, less maintenance.

- **Why not a `health_pct` gate?** Health doesn't drop on every hit (armor,
  shields, partial hits). `lastDamageTime` fires on *any* damage event, making
  it a more sensitive threat signal than health.

- **Mirror rule updated in the same commit.** The P5 telemetry rule must keep
  the same preconds with the hostile gate flipped, or the 24h readout ("is the
  gate the binding constraint?") is invalid. The mirror now reads: armed-preconds
  met AND bot was hit in the last 10s → gate is closed by *active combat*, not
  by ambient presence. A high `arm_gate_closed` count after this change would
  mean the bot is genuinely being hit too often to arm; a low count means the
  gate is no longer the binding constraint.

## Verification

- `node --check src/agent/behavior/policy.js` — syntax OK
- `node tools/arming_fix_check.js` — shape assertions passed, `when-gates:
  not has_item:weapon + block_nearby:chest#32 + not recently_attacked:#10`
- `node tools/policy_check.js` — all assertions passed
- `node --test src/utils/policies_valid.test.js` — 6 pass / 0 fail
- `node --test src/utils/plank_recipes.test.js` — 1 pass / 0 fail
- `node --test src/agent/behavior/*.test.js` — 205 pass / 1 fail (pre-existing:
  `prompt_self is the exception, not the default` — 7 rules carry `prompt_self`
  steps, cap is ≤6; the 4 duplicated rule names across files predate this change.
  Confirmed failing at HEAD via `git stash` → run → `git stash pop`.)
- Direct import check: `recently_attacked` in CONDITIONS, arm gate
  `not recently_attacked#10`, mirror gate `recently_attacked#10`
- All 5 policy JSONs parse valid
- eslint: same 7 pre-existing errors at HEAD (line numbers shifted +5 by the
  insertion); no new errors introduced

## Pending (observation window)

- `arm_yourself_from_the_chest` fires when: no weapon + chest <32 + not hit in
  last 10s. At the graveyard base, the gate should now open between revenant
  hits (10s window) and the 60s cooldown provides retry margin.
- `arm_gate_closed` count: high → bot is genuinely being hit too often (combat
  experiment needed); low → gate is no longer the binding constraint, the
  collect/craft chain (Experiment 1, `num:1`) is the next thing to watch.
- `Crafted 1 wooden_sword` count: the Experiment 1 metric, now unblocked.
