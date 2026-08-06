# Removing the model's self-destruct buttons

**Commits:** `d82b00c`, `b1825a1` · 2026-07-30 · shipped

Two changes with one theme: the agent should not be able to end itself, and a
bad file should not become a crash loop.

## `!restart` removed

It gave the model a way to answer "I'm stuck" with a **process restart** instead
of a different action. Because memory persists across restarts, the habit fed
itself — the summary carried the restart forward, and a failed path while
chopping a log escalated into a full relaunch.

**Decisions:**

- The supervisor already restarts on real failures, so nothing needed this.
- `cleanKill` stays; only the *model's direct access to it* goes. Operational
  restart remains possible, model-initiated restart doesn't.

## Corrupt memory file starts fresh

`load()` guarded on the file existing, then parsed it unconditionally and
rethrew on failure — killing the agent on every start. A truncated write or a
hand-cleared memory file produced a crash loop that could only be broken by
hand.

**Decision:** the file is about to be overwritten anyway, so starting fresh is
strictly better than any recovery attempt. Losing one session's memory beats
requiring manual intervention.

**Files:** `src/agent/commands/actions.js`, `src/agent/history.js`
