# Abandoning actions instead of killing the process

**Commit:** `99f5c72` · 2026-07-30 · shipped

## Problem

Interrupts are cooperative. `requestInterrupt` sets a flag and stops pathfinder,
digging and pvp; then `stop()` spins until the running action returns on its
own. Nothing can force it, and generated code has no obligation to check the
flag — so the wait had **no upper bound**. After ten seconds the only exit was
`cleanKill`. A mob landing a hit mid-path was enough to take the whole process
down.

## Change

`stop()` waits a bounded grace period, then **abandons** the action and moves
on. The abandoned action keeps running; a generation counter makes that safe —
each action skips its own cleanup once it's been superseded.

## Decisions

- **Abandon, don't kill.** We can't force a coroutine to stop, but we can stop
  *waiting* for it. The process surviving is worth more than the guarantee that
  only one action is in flight.
- **Generation counter over a cancellation token.** A token would require every
  action, including LLM-generated code, to cooperate — which is the assumption
  that failed in the first place. A counter checked at the cleanup boundary
  needs nothing from the action itself.

## Bug this also fixed

`executing` was a single shared boolean. An interrupted action returning late
would clear it, wipe `bot.output` and reset `interrupt_code` out from under its
replacement — after which a third action saw an idle manager and ran
*concurrently* with the second. The generation check closes this.

Stale timeouts are guarded the same way: an abandoned action never reaches
`clearTimeout`, so its timer would otherwise fire minutes later and stop
whatever was running by then. `timedout` is also reset per action rather than
latching `true` forever after the first timeout.

## Tests

`src/agent/action_manager.test.js` — 104 lines covering abandonment, the
late-return case, and stale timers.

**Files:** `src/agent/action_manager.js`, `src/agent/action_manager.test.js`
