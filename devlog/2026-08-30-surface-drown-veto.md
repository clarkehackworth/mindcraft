# Surface-drown: the wet-sensor veto now trusts the air bar in water

2026-08-30

## Problem

The last death's trace was the cleanest contradiction in the log:

```
EVT death:drown:trace:samples14:wet0:oxy=0,0,0,0,0,0,0,0,0,0,0,0,0,0
```

Fourteen air samples. The head block was **dry on every one** (`wet0`). The
oxygen bar was **empty on every one**. The bot drowned. The reflex was alive
and sampling — it just had two channels and the wrong one held the veto.

`lowAirPersists` gates the oxygen channel on a head-block test:
`if (headSubmerged(bot)) return false;` — and that test runs first, before the
oxygen window is even consulted. The veto was built to stop a measured
regression (eleven phantom fires on a bot standing in air, post-respawn, with
the bar stuck at 0), and it was built absolute: a dry head is never a drown,
no matter what. That is true on dry land. It is false at the waterline: a bot
floating with its head just above the surface reads `air` at the eye position
while the body is still losing air, and an unloaded chunk reads nothing at
all. Neither case has any head to be wet. The bar had everything it needed; it
never got a vote.

## Change

`src/agent/library/skills.js`, three small edits:

1. **`recordAir` captures `inwater`** — `bot.entity?.isInWater ?? false` —
   from the physics engine's entity status, which the server sets whether or
   not the chunk loaded.
2. **The veto is now keyed on the engine status.** It runs first, as before,
   but it lifts — and *only* lifts — when the body is **affirmatively** in
   water (`isInWater === true`). Then the oxygen channel gets its vote: low
   now + persistently low across the 4s window = fire. Absent (`undefined`)
   or `false` means the veto stands, exactly as it did before.
3. **`isBreathing` gets the same fallback.** It was purely block-based (the
   bar was removed after it was measured stuck at 0 on dry land for a whole
   session). Now: head says air + engine says affirmatively in water → the
   bar decides (empty = not breathing, so `surface()` actually swims instead
   of early-returning "already breathing"). On dry land the bar is never
   consulted — the original behavior is byte-for-byte intact.

Plus one line of telemetry in the death trace (`agent.js`): the trace now
reports `inwater<N>` alongside `wet<N>`, so the next event shows which side
of the split each sample sat on.

## Decisions

- **Rejected: trust the bar alone.** This is the option the regression
  history says no to. The bar was measured stuck at 0 for the rest of a
  session after one drowning — the scoped oxygen guard means we no longer
  inherit anyone else's refill, and the server does not resend a 0 that
  never changed. A bar-only gate fires eleven times per respawn on a bot
  standing in a field.
- **Rejected: trust `isInWater` alone, drop the head test.** The engine
  status is `?? true`-style absent on a bot that has not bothered to say —
  absent means "the old answer", and the old answer for a bot digging under
  a ceiling is "not in water", which is right. But a status alone also fires
  on the post-respawn tick when the entity status lags the respawn, and the
  head-block veto is what made the post-respawn phantom stop. So: the status
  **lifts** the veto, it does not **replace** it.
- **Rejected: keep the veto absolute** (i.e. do nothing). That is the fatal
  death. The two channels agree on everything except the waterline, and at
  the waterline the engine status is the only one of the three signals that
  cannot lie in either direction the failure went.
- **The 12 threshold** is shared with `lowAirPersists` so the two channels
  agree on what counts as an emergency; `surface()`'s existing >15 "recovered"
  line is untouched.

## Verification

- New runnable check: `src/agent/library/surface_drown.test.js`
  (`node --test`), 12 assertions. Pins the fatal trace
  (in water, head air, bar empty → fires), the unloaded-chunk drown (fires),
  the classic wet-head path (unchanged, fires), the dry-land phantom with a
  stuck bar (vetoed — the 11-fire regression), the unloaded-chunk dry
  phantom (vetoed), and the `isBreathing` split in all six combinations.
- Existing regression checks unchanged and green:
  `drowning_debounce` 7/7 (its mocks have no `isInWater`, so they run the
  old path), `oxygen_scope` 5/5.
- `node --check` on both edited files. Deployed via
  `tools/live_test.sh deploy` (push + agent restart);
  agent came back clean and the bot was alive at surface (y=70), full
  health.

## Open

- The second pocket at (5,56,-6) that the trace's death site sat near is
  still a live hazard; the sensor fix covers the *detection*, not the
  world. A barrier fill there is the matching P9-style world fix.
- The MythicMounts dragon that killed him while armed is the next
  investigation — it cannot be seen or counted through rcon entity
  selectors, so its handling (if any) is a policy question, not a
  sensor one.
