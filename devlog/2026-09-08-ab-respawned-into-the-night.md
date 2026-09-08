# A/B candidate 2: respawned into the night

**Status:** running on AndyB from 2026-09-08 ~11:50 UTC. Control: Andy on
`survive_upgrade` (now including candidate 1). Candidate: AndyB on
`survive_upgrade_b`.

## Why

After candidate 1 the dominant death mode for both bots is the night
respawn: Andy died four times in fifteen seconds on its spawnpoint at 08:51,
AndyB five times in eight minutes at 09:20-09:28. Every incident file shows
the same thing: night, unarmed, a zombie within two blocks, action
`cowardice` or `self_preservation`. Every dig_in reflex is gated on NOT
`near_respawn 8` (a hole on the spawn tile is a trap, see the pit-respawn
devlog), so a bot standing on its spawn tile at night has no free reflex at
all and the built-in modes take random steps until it dies again.

## The change (one rule, `policies/survive_upgrade_b.json`)

`respawned_into_the_night`, pinned, `interrupts: all`, cooldown 30, placed
above `dig_in_when_hunted`:

- when: `is_night` and `near_respawn 8` and not `is_sheltered`
- do: `move_away 12` (so the dig_in gates release and the hole is not on
  the tile), `dig_in`, `stay until not is_night`.

Fixtures in `scenarios.test.js`: on the spawn tile at night with a zombie
adjacent, B fires this rule first and the base fires no dig_in at all;
twelve blocks off, the ordinary `dig_in_when_hunted` takes over on B.

## How to judge

Same window, both agents. The number to watch is deaths within 60s of a
previous death (the spawn-camp cluster), then deaths/h overall. If the
move-away step itself gets the bot killed more often than standing did, the
alternative is `dig_in` on the spot with a cap and accept the pit risk.
