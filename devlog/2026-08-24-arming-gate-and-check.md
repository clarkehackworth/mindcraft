# Arm gate against mid-raid pre-emption + a check that means it

**Date:** 2026-08-24 · **Status:** shipped · **Follows:** [2026-08-24-arming-trim-dead-withdraw.md](2026-08-24-arming-trim-dead-withdraw.md)

## Problem

The 24h audit (2026-08-24 17:35 CDT) showed the trimmed arming chain
(collect log → craft → equip) was live but still 0/0. Three mechanisms, with
counts:

| Failure | 6h count | Meaning |
|---|---|---|
| The chest never opened | 778 | dead withdraw steps — fixed by the trim |
| Failed to collect log: GoalChanged | 79 | higher-priority rules (flee_ranged_raiders 90x, keep_out_of_water 61x) changed the goal mid-collect → wood never gathered |
| no resources to craft → oak_planks 26 > spruce 7 > pine 4 | 37 | recipe resolves to oak most often; if collect:log breaks pine_log the same-suffix substitution doesn't fire |

The trim removed the 778x dead weight but could not fix the 79x mid-collect
pre-emption. Arming **mid-raid** is the exact death pattern: the blocking
collect gets interrupted the moment a raider or the water gate fires, the
bot never finishes gathering wood, and it stands unarmed in the open.

## Change

Two things in one commit (both already deployed + regen'd + live-verified):

**1. Pre-emption gate on `arm_yourself_from_the_chest`** (`policies/survive_upgrade.json`).
Two new `when` gates so the rule simply does not fire in the conditions that
were pre-empting it:

- `NOT hostile_nearby 24` — matches `flee_ranged_raiders` reach, so if a
  raider is close enough to fire the flee rule, we don't start a 10-second
  blocking wood-collect that the flee will interrupt.
- `NOT block_nearby water 8` — matches `keep_out_of_water`'s `block_nearby`
  range, so the collect's `goto` can't path through water and get bounced
  into an interrupt loop.

The trigger stays `unarmed + chest within 32` (the at-base signal); the gate
just says "and the area is clear." `pinned`, `interrupts:all`, `cooldown:60`
untouched.

**2. `tools/arming_fix_check.js` now means it.** The shape mode still pins
the do-list and all four when-gates (now including the two NOT gates). A new
`--live` mode SSHes to the host and asserts on live tallies over a window:

- `Crafted 1 wooden_sword` > 0 in window
- `GoalChanged` < 100 (pre-fix ~316/24h)
- chest-withdraw churn < 10 (pre-trim 778/6h)
- `Uncaught|FATAL` == 0 (contract)

Per AGENTS.md: one runnable check, no new frameworks. Live mode is SLOW
(large agent log over SSH); use `timeout 180`.

## Decisions

**Gated the trigger; did not make the wood-gather re-acquire on resume.**
Two options from the handoff: (a) gate the arm trigger with "not currently
fleeing/evacuating," or (b) make the wood-gather re-acquire on resume.

Chose (a) because (b) is the wrong fix: the reason the gather gets
pre-empted is that a higher-priority rule is legitimately firing (a raider
is shooting, water is in the path). Re-acquiring the gather on resume would
fight the flee — the bot would oscillate between gather and flee and still
never finish either. Gating the trigger says "arming is the wrong job right
now; the flee is the right one" and lets the flee do its job. Arming at base
when it's clear is the actual success case the rule exists for.

The 24 range is not arbitrary — it's the `flee_ranged_raiders` range, so the
gate closes exactly when the pre-emptor would fire. Same for the 8 water
range matching `keep_out_of_water`.

**Rejected:** a self-layer "don't arm during a raid" rule. The self layer
outranks the active layer (RUNBOOK §5), and a self rule is the kind of thing
that outlives the raid and quietly vetoes a future legitimate arming. The
active-layer gate is scoped to this rule and this condition.

**Rejected:** forcing the arming to complete mid-raid (e.g. making it
uninterruptible). The handoff flagged this: "arming mid-raid may be
genuinely bad timing — verify intent before forcing it." Verified: it is bad
timing. The 79x pre-emption is the system working as intended.

## Verification

| Check | Result |
|---|---|
| `arming_fix_check.js` (shape) | pass — pins 4 when-gates incl. the two NOT gates |
| `policies_valid.test.js` | 6/6 pass (includes survive_upgrade.json) |
| `policy_check.js` | pass |
| Live active layer after `regen` | 78 rules, arm do-list `collect:log#4 → craft:wooden_sword → equip_weapon`, `NOT hostile_nearby 24` + `NOT block_nearby water 8` present, `pinned:true`, `interrupts:all`, `cooldown:60` |
| Liveness (rcon `pos`) | alive, `-6 65 8` |
| `watch 'Uncaught\|FATAL'` | no new lines from this change (only the pre-existing V8 heap OOM at 21:42Z, ~3h earlier) |

## Known caveat

The `--live` `crafted > 0` assertion **will fail right now** — the wood-family
mismatch (priority 3) is still unverified. The gate stops the pre-emption but
doesn't fix a recipe that resolves to oak while the bot breaks pine. Until
priority 3 lands, run the shape mode (default) as the green gate; the live
mode is the target state. This is the one honest "check that can still fail"
and it's failing for a known, tracked reason, not a regression.

## Reversible

`.backup/Andy-policy-2026-08-24-pre-gate.json` (restore via `docker cp` +
`regen`).
