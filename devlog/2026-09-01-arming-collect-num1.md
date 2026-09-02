# 2026-09-01: Arming collect num 4→1 — fix the step, not the trigger

## Problem

The `arm_yourself_from_the_chest` rule fires 12× per window (trigger is fine), but
the bot crafts **zero** wooden swords. The blocking `collect log num:4` step is
interrupted/abandoned before the `craft` step runs. 45 collect attempts, 0 crafted,
0 "no resources", 0 "chest never opened", 0 GoalChanged.

Live log: `arm_yourself_from_the_chest` → "ignored the interrupt for 10s, abandoning
it" → "finished executing, code_return:" (empty). The collect step is one long
blocking action (4 blocks × walk+dig each). When an interrupt lands mid-collect it
can't yield within 10s, so the whole trip is abandoned.

## Change

`policies/survive_upgrade.json`: `arm_yourself_from_the_chest.do[0]` collect
`num: 4` → `num: 1`.

**Recipe math** (verified against the pack's recipe model in `plank_recipes.js`):
- 1 log → 4 planks
- 2 planks → 1 stick
- wooden_sword = 2 planks (blade) + 1 stick (handle) = 4 planks = **exactly 1 log**

`num:4` was 4× the recipe — 4× the blocking collect window for zero benefit.

## Decisions

- **Why `num:1` and not `num:2`?** 1 log is the exact minimum. If the craft still
  fails with `no_drop` (the code documents intermittent drop-loss), the follow-up
  is `num:2` (8 planks = margin), not a larger over-collection.
- **Why not change the interrupt window?** That's a code change in the action
  manager — a much larger blast radius for a policy-level fix.
- **Why not split the collect into multiple 1-block steps?** More do-list entries
  = more tick overhead and more interrupt boundaries. One shorter blocking step is
  better than four shorter ones.
- **Why not arm him via rcon `give`?** That's a rescue, not a skill improvement.
  The user's framework: arming is a means to test a specific skill change, not an
  end in itself. The self-arming pipeline is the skill.
- **Why not decouple the self-prompter first?** The self-prompter (bobdylan) is
  also driving "get a stone pickaxe" and its commands are getting dropped, but
  the arm rule is the one that fires and gets abandoned — fixing the collect
  length is the higher-leverage first move. Self-prompter collision is the
  follow-up (Experiment 1b) if the collect length fix doesn't move the Crafted
  counter.

## Options rejected

| Option | Why rejected |
|--------|-------------|
| `give` via rcon | Rescue, not skill improvement. User framework. |
| Increase interrupt timeout (code) | Larger blast radius; policy fix is sufficient. |
| Split collect into 4× 1-block steps | More do-list entries, more interrupt boundaries. |
| `num:2` immediately | Premature; try the exact minimum first. |
| Decouple self-prompter first | Lower leverage; the arm rule is the one getting abandoned. |

## Verification

- Local gates: 5/5 green (policies_valid, plank_recipes, arming_fix_check shape,
  policy_check, syntax check).
- Deploy: tar-push to `/app/policies/` + deterministic no-attribute regen.
- Live verify: `LIVE collect num: 1` confirmed via `docker exec` node read.
- Backup: `.backup/Andy-policy-2026-09-01-pre-arming-num1.json` (tar, num:4).
- Bot: alive, ticking (EVT lines fresh), 0 Uncaught/FATAL.

## Measurement

Watch over the next ~1 day:
- `Crafted 1 wooden_sword` count (was 0; target ≥1)
- `collect` abandonment count (was 45/3h; target: dropping)
- `unarmed` death count (was 2/3h; target: dropping)

If `Crafted` is still 0 after the window → the interrupter is the real culprit →
Experiment 1b: decouple self-prompter from the active arm rule.
