# A/B candidate 1: night-gate the work rules, go find trees

**Status:** running on AndyB from 2026-09-08 ~02:25 UTC. Control: Andy on
`survive_upgrade`. Candidate: AndyB on `survive_upgrade_b`.

## Why

24h of deaths: 21 mob, 9 drown, 2 arrow, 0 fall. Both bots restart from
nothing after every death and the day is spent failing to get wood:
`collectBlock` re-picked the same unreachable log (fixed in `b9f87cf`), and
neither bot had a log within sight, with no rule that goes looking. Then
night: Andy died with `gather_wood_for_base` running in the dark and a
kobold one block away, because the free dig-in rule's gates did not hold
and the fallback shelter rule is a paid prompt that the idle work rules
overtook.

## The change (one change-set, `policies/survive_upgrade_b.json`)

1. `{"not": {"cond": "is_night", "lead": 1500}}` added to 17 travelling
   idle rules: sheep, wood, storage, pantry, berries (3), larder, game,
   find-food, next tier, ore x3, stone, find ore, haul. In-place rules
   (craft, smelt, torches, wear/hold gear) stay unconditional so the bot can
   still arm itself in a hole at night.
2. `go_find_trees`: by day, idle, no log within 16 and fewer than 4 logs in
   the bag -> `search_block log 160` then `collect log 8`. Cooldown 300s.

Fixtures in `scenarios.test.js` (`CANDIDATE`): at night with logs nearby,
none of wood/sheep/coal fire on B; by day on bare stone, `go_find_trees`
fires first on B; on the control, wood still fires with logs nearby.

## How to judge

`tools/live_test.sh scorecard <window>` vs
`AGENT_NAME=AndyB MC_PLAYER=clarke_hackworth tools/live_test.sh scorecard <window>`
over the same window, at least two hours, ideally three day/night cycles.
Win = fewer deaths/h with paid/h not worse, and AndyB holding logs/tools at
dusk. Promote by folding into `survive_upgrade.json` and regen Andy.

## Interim, 85 minutes in (03:48 UTC)

| agent | deaths | paid turns | noPath | goals | inventory at check |
|---|---|---|---|---|---|
| Andy (control) | 1 (drown, day) | 69 | 8 | 20 | sand, dirt |
| AndyB (candidate) | 0 | 57 | 5 | 61 | 36 cobblestone, 7 coal, 19 torches, planks, table |

`go_find_trees` fired four times and found logs every time. AndyB crafted a
wooden pickaxe and shovel at 02:42, mined the cobblestone and coal with the
pickaxe, and the pickaxe **wore out**: that is where the "vanishing tools"
went, both tonight and earlier. Every re-arm after that failed: the table 20
blocks away was unreachable and the bot stood in a one-wide, water-edged
tunnel with no air block beside it for a new one. `tableWithinReach` now
searches any air block with a floor within two blocks (deployed, this commit).
Too early to promote; the night gate has one dusk behind it.
