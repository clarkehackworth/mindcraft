# 2026-09-02: Collect retry for transient pathfinder interrupts

## Problem

The arm rule (`arm_yourself_from_the_chest`) fires 24× in a 7h window after the
threat-level gate fix unblocked it, but the pipeline never reaches `craft`:

| Collect outcome | Count |
|----------------|-------|
| `Collected 0 log` | 5 |
| `GoalChanged` (collect interrupted) | 4 |
| `Collected 12 log` (LLM path, not policy) | 1 |
| `Crafted wooden_sword` | **0** |

Root cause: the collect step is a single `await bot.collectBlock.collect(block)`
per block. The path from Base to the nearest tree crosses the water pocket at
`z=93–105`. `keep_out_of_water` (interrupts:all, 32 fires in the same window)
or `self_preservation` (PRIORITY_ABOVE_POLICY) changes the pathfinder goal
mid-walk. `collectBlock`'s catch breaks the loop on `interrupt_code`, returns
false, and the 60s rule cooldown pushes the next attempt far away. The
do-chain's `craft` step starves.

This is the third layer of the self-arming pipeline that needed fixing:
1. **Gate** (2026-08-24): presence-based → threat-level (done, #11)
2. **Collect num** (2026-09-01): 4 → 1, match the recipe (done, #10)
3. **Collect retry** (this): transient interrupts abandon the whole step

## Change

Added `collectWithRetry(bot, collect, maxAttempts=3, settleMs=2000)` in
`policy.js`. The collect action fn now calls it instead of calling
`skills.collectBlock` directly.

Discriminator: after `collectBlock` returns false, `bot.interrupt_code` SET
means a transient pathfinder GoalChanged (retryable — the fresh re-scan may
find a closer tree on a drier path); `interrupt_code` NOT SET means a genuine
failure (no blocks nearby, no tools) — bail immediately. A 2s settle between
attempts gives the interrupter time to clear before the re-scan.

Runnable check: `src/agent/behavior/collect_retry.test.js` (6 cases).

## Decisions

- **Bounded (3 attempts), not unbounded.** The graveyard's ambient interrupts
  keep the bot moving, so an unbounded retry loop would mask a genuinely stuck
  rule and burn CPU. The 60s cooldown handles the next real shot.
- **`interrupt_code` as the discriminator, not a timeout.** A genuine failure
  (no blocks) returns false with `interrupt_code` cleared — retrying cannot
  help. A transient interrupt sets `interrupt_code` — the fresh scan may find
  a different (closer, drier) target.
- **2s settle, not 0.** The pathfinder goal change from `keep_out_of_water`
  or `self_preservation` needs a beat to resolve. An immediate re-scan would
  hit the same path and the same interrupt.
- **Refactored to an exported helper, not inline.** The inline loop in the
  action fn isn't directly testable (would need to
  monkey-patch `skills.collectBlock`). The helper takes a `collect` function
  and a fake `bot`, so the check is a pure unit test with no ESM mocking.

## Rejected options

- **Make collect uninterruptible.** Would break ActionManager preemption (mode
  2) — if a hostile actually attacks mid-collect, we want to abandon and flee,
  not keep walking to the tree.
- **Decouple the self-prompter from the arm rule.** The LLM also issues
  `!collectBlocks("spruce_log", 8)` commands that compete for the same action
  slot. This is a real problem (two control systems, one slot) but it's a
  separate fix with a bigger blast radius. The retry fix addresses the policy
  path first; the LLM path can be addressed in a follow-up.
- **Bump collect num to 2 or 3.** The interrupt isn't a length problem —
  `num:1` is the minimum (1 log = 1 sword). More logs = longer trip = more
  interrupt exposure, which is the opposite of what we want.
- **Increase the arm rule cooldown.** Would reduce fire count (good) but also
  reduce the chance of a clean window (bad). The retry fix addresses the
  failure mode without changing the cadence.
