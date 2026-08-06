# Adaptive view distance

**Commits:** `54827f6` → `35eb7ee` → `467ed63` → `887116f` → `2f979c5`
2026-07-30 · **built, iterated four times, then deleted**

The most instructive entry here. A feature with a plausible premise, real
supporting numbers, four rounds of refinement — and it measured as no better
than a constant, so it's gone.

## The premise

The bot was the main cause of the lag it kept failing to path through. From the
server log:

| condition | stalls/hour |
|---|---|
| empty server | 0.27 |
| only the bot online | 22 |

It never set a view distance, so mineflayer's default of `far` kept a 25×25
chunk window pinned around it, and its goals sent it hundreds of blocks into
never-generated terrain. On a modpack this heavy that freezes the server for two
seconds at a time — which is exactly what breaks pathing.

## What was built (`54827f6`)

- `view_distance: "auto"`, following the server's tick rate. `bot.time.age`
  counts world ticks and `update_time` carries it every 20, so TPS falls out of
  comparing its advance against the wall clock — no server-side support needed.
- `exploration_radius`, leashing the bot to spawn. Default 0 (unlimited), so
  nothing changes until set.
- Sprinting and parkour disabled below 18 tps. Both commit to a movement and
  only learn afterwards whether the server agreed, so across a stall the bot
  lands somewhere the server never saw it go.
- `goToPosition` rejects non-finite coordinates, naming `.position` in the
  message, so the [prompt example fixes](2026-07-30-prompt-example-fixes.md) mistake is visible where it
  happens rather than as a disconnect.

## Iteration 1 — wiring (`35eb7ee`)

`loadPlugin` defers injection, so `bot.pathfinder` doesn't exist when `initBot`
runs. Wrapping `setMovements` there threw and killed startup outright, which the
supervisor declined to retry ("exited too quickly").

Moved the hook to spawn. **Lesson recorded at the time:** the tests covered the
pure tps and leash logic but never exercised bot wiring, which is exactly where
it broke. `tameMovementsForLag` was exported and tested against a bot with no
pathfinder, an uninjected one, and an injected one.

## Iteration 2 — wrong metric (`467ed63`)

Deployed, the tps version alternated `far`/`normal` eight times in nine minutes
and left stalls unchanged at ~30/hour. The reason: **this server doesn't run
slow, it freezes.** Two seconds every minute or two, healthy ticks either side.
Averaged over any useful window that's ~19.5 tps, which reads as healthy;
averaged over a window short enough to notice the pause, it sits exactly on the
threshold and oscillates.

Replaced the average with a direct stall count — an `update_time` interval where
the wall clock ran more than a second ahead of the tick clock — and a rolling
five-minute rate.

Hysteresis made **asymmetric**, because growing back is what caused the
flapping: shrink after a minute, widen only after the quieter rate has held for
five.

## Iteration 3 — the bot blamed the server for its own pauses (`887116f`)

`update_time` arrives about once a second, so a 1s threshold counted anything
that blocked *this process* for that long — an LLM response landing, a GC — as a
server freeze. During an idle window the bot reported up to 1 stall/min while
the server logged none.

Threshold raised to 1.5s, and event-loop delay measured directly (watching how
late a fixed interval fires) and subtracted from tick time lost. What remains is
attributable to the server.

## Deletion (`2f979c5`)

A/B/A on the live server, same task and matched activity in every arm:

| arm | stalls | actions |
|---|---|---|
| `far` | 3 | 14 |
| `tiny` | 8 | 15 |
| `far` | 17 | 14 |

The two identical arms differ by nearly **six times** and the third sits between
them. Run-to-run variance on one setting is larger than the gap between
settings. Ordered far-then-tiny this reads as "tiny is worse"; reversed it reads
as "tiny is better". Neither is true — and a two-arm test would have shipped one
of them.

The original premise was sound as far as it was measured: 0.27 stalls/hour empty
vs 22 with the bot. But that's evidence about *the bot being present*, not about
*how much world it keeps loaded*, and the difference doesn't survive being
tested directly.

So the stall counter, the loop-lag tracker, the tier table and the picker all
go. `view_distance` becomes a plain setting.

## What survived

- **`view_distance` as a plain setting** — the bot should set one; it just
  shouldn't be clever about which.
- **Sprinting and parkour off.** They were gated on the measured stall rate; now
  they're simply off, which is what the gate resolved to in practice and needs
  no machinery to decide. Tests moved to `movement_limits.test.js`.
- **`goToPosition` non-finite guard.**

## Decisions worth keeping

- **Run A/B/A, not A/B.** The third arm is what revealed the variance. Two arms
  would have shipped a result.
- **A metric that is right on average can be wrong for the thing you care
  about.** Average TPS was fine and useless; the failure was a distribution
  tail.
- **Measure the thing, not a proxy for it.** "Bot present costs 22 stalls/hour"
  was true and did not imply the mechanism we assumed.
- Net: −342 lines. Deleting a working feature that doesn't pay for itself is a
  result, not a failure.

**Files:** `settings.js`, `src/utils/mcdata.js`, `src/agent/library/skills.js`,
`src/utils/movement_limits.test.js` (`src/utils/lag_adapt.test.js` deleted)
