# Cave ring: promote the death pocket to a hard wall

## Problem

The 2026-09-06 2h monitor window produced four deaths, all inside the
cave-ring `DEATH_POCKET_BOX` at y=55-58:

- `drown` at (-8,58,93)
- `drown` at (-42,55,89)
- `drown` at (-29,56,108)
- `mob` (melee) kill at (-31,58,102)

The drown traces show sustained full submersion with oxygen at 0 the
whole way. In the same window `go_back_for_your_grave` fired 13 times,
re-pulling the bot into the box straight through the 99 near-wall.

The box had been priced as *soft*: `DEATH_WATER_COST` (99) for everyone,
with the `hasDigTool` exception letting a pickaxe bot keep the 99 on the
theory that "a pickaxe bot can descend to mine and can always dig
itself out". That premise was falsified by this window: a pickaxe cannot
outpace a 15s oxygen window. The 99 near-wall was a death sentence, not a
deterrent -- and the near-wall is exactly the wrong instrument here, for
the same reason the near-spawn pit was (see
devlog/2026-09-06-near-spawn-pit-hard-wall.md): the grave that
go_back_for_your_grave targets sits at the pocket floor, so the only
route to the goal descends into the pocket, and a strong goal pull routes
straight through a 99.

## Change

`DEATH_POCKET_BOX` is now `hard: true`.

- `inHardPocket()` covers both boxes (pit + ring). For a bot OUTSIDE a
  hard pocket, in-box blocks are an absolute 100 wall -- no path at all --
  so even a strong goal whose target sits at the pocket floor cannot route
  in; the goto fails clean and the bot moves on.
- A bot already INSIDE keeps a free way out: `waterCost` returns 0 for
  an in-box bot (position-keyed, checked before the hard escalation
  fires), so anyone who falls in can always path out.
- `DEATH_WATER_COST` stays 99 (under the unbreakable cap) -- it is the
  in-box price the hard-escalation step reads.
- The installer's soft-branch (`hasDigTool` keeps the 99) is now dormant
  -- both boxes are hard, so `inHardPocket` catches every in-box block
  first -- and is kept, with a comment, for a future soft pocket that is
  genuinely mineable AND has a dry escape a pickaxe can reach in time.

Box geometry was NOT changed: all four in-ring deaths are already inside
the 2026-09-04 widened box (x -45..-5, y 48..61, z 60..118), and the Base
(-29,63,89) stays outside (y=63 > yMax=61), so the Base and its surface
approaches remain cheap.

## Decisions

- **Widen the box? No.** Every death this window is already inside it.
  The 2026-09-04 east-ring widen holds.
- **Drop only the pickaxe exception (keep the 99 for pickaxe bots)? No.**
  99 is a near-wall, not a wall. When the goal itself sits in the pocket
  (go_back_for_your_grave), the goal pull routes straight through it.
  This is the exact leak the pit fix identified; the same instrument
  applies.
- **Promote to hard? Yes.** Same contract as the near-spawn pit: absolute
  wall for a bot outside, free exit for a bot inside. Degrades gracefully
  (goto fails clean) rather than crash-looping.
- **Tune the policy / go_back_for_your_grave? No.** The wall makes the
  underlying goto fail; the rule itself stays.

## Verification

- `node src/utils/water_aware_path.test.js` -- PASS. New section 14f pins
  this window's four in-ring death coordinates to the hard ring:
  `inHardPocket` true for each, a pickaxe bot at the Base gets the
  absolute 100 wall on ring water, and a bot inside the ring keeps the
  free 0 exit. Section 3 and 11 updated: pickaxe OUTSIDE now gets 100.
- `node tools/policy_file_check.js` -- PASS (7 layers, 0 invalid).
- `node tools/descend_perch_check.js` -- PASS.
- `node src/utils/oxygen_scope.test.js`, `node src/utils/movement_limits.test.js` -- PASS.
- Deployed (`deploy src/utils/water_aware_path.js`); Andy reconnected
  alive at (-7.7, 52.4, 1.5), Health 24/24, post-restart log clean
  (no Uncaught/FATAL/heap).

## Watching

- In-ring drownings: expect zero.
- `go_back_for_your_grave` fires into the ring: expect them to stop
  routing in (goto fails clean).
- Any new "goal unreachable" behavior from the extra wall -- should
  degrade to the bot moving on, never a crash.
