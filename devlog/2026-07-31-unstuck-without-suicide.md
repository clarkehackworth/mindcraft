# Unstuck without suicide

**Status:** uncommitted (`src/agent/modes.js`) · 2026-07-31

## Problem

The `unstuck` mode's escape path ended in:

```js
const crashTimeout = setTimeout(
    () => agent.cleanKill("Got stuck and couldn't get unstuck"), 10000);
```

**A restart cannot move the bot in the world.** The bot comes back at the same
coordinates, in the same hole, still stuck — so the mode fires again and kills
again. Positional stuckness is the one failure a restart is structurally unable
to fix, and it was the one failure wired to a restart.

Third instance of the same anti-pattern on this branch, after
[abandoning stuck actions](2026-07-30-abandon-stuck-actions.md) and [no self-destruct](2026-07-30-no-self-destruct.md).

## Change

Bounded escape attempt, then hand the problem to the LLM:

- 10s timer now calls `agent.requestInterrupt()` instead of `cleanKill`.
- `moveAway` wrapped in try/catch — a failed escape is information, not a fault.
- **Success is verified positionally**, not assumed: compare against a cloned
  start position and only say "I'm free" if the bot actually moved
  `this.distance`.
- On failure, back off (`stuck_time = -60`) so the LLM gets ~60s to act before
  the mode re-fires.
- Send a `(STUCK)` system message naming the block underfoot and at leg level,
  with the coordinates, and explicitly telling it **not** to repeat the
  navigation command that got it stuck.

## Decisions

- **Escalate to the LLM, not to the supervisor.** Getting out of a hole is a
  reasoning problem — dig the block you're standing on, pillar out — and the LLM
  can do it. The mode's job is to notice and to describe the situation well
  enough to be actionable.
- **Report the blocks, not just "stuck".** Standing on `deepslate` with `air` at
  your feet implies a different escape than standing in `powder_snow`. Without
  those two facts the model guesses.
- **Verify escape by distance moved.** The old code said "I'm free" whenever
  `moveAway` returned, which it does even when it went nowhere. That made the
  logs lie about how often this fires.
- Marked `// ponytail:` in the source with the reasoning, so the next person
  doesn't re-add the kill.

**Files:** `src/agent/modes.js`

A `console.log` with a stack trace was also added to `cleanKill` in `agent.js` —
after three of these, every remaining call site should be attributable.
