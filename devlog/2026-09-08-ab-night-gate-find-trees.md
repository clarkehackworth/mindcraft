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

## Check at 223 minutes (06:08 UTC), three dusks in

| agent | deaths | night | armed at death | paid turns | noPath | goals | inventory at check |
|---|---|---|---|---|---|---|---|
| Andy (control) | 6 | 5 | 2 | 228 | 50 | 320 | empty (died 06:08) |
| AndyB (candidate) | 4 | 3 | 2 | 249 | 71 | 308 | 17 logs, table, sticks, planks |

Deaths per hour: Andy 1.6, AndyB 1.1. Paid turns per hour: Andy 61, AndyB 67.

AndyB's crafting chain now works end to end: wooden pickaxe and shovel at
02:42, then after the wider table placement landed, a full stone set (axe,
pickaxe, sword) at 03:56. It lost that set five minutes later drowning at
food=4, re-armed with a wooden sword at 04:17, and died again at 05:24
(drown, food=6) and 05:29 (zombie at 0.6, night, unarmed). Two wooden
pickaxe crafts at 04:26 and 04:42 still hit "never produced the result".

Night deaths on the candidate: 04:04 with `dig_in_when_hunted` running and a
zombie at 1.1 blocks; 05:29 under `cowardice`. The gate keeps the work rules
out of the dark, but the free shelter reflexes still lose to a mob that is
already adjacent. Andy died three times in 65 seconds at 03:59-04:00 to
zombies at its own base.

Two of AndyB's four deaths were drownings at food 4 and 6: hunger is now the
next blocker, not wood.

**Verdict so far:** fewer deaths, more progress per death, slightly more
paid turns. Not decisive over one window with this much variance. Keep it
running through another full day/night pair before promoting, and treat
food (starving into water) as candidate 2.

## Check at 550 minutes (11:35 UTC), about seven dusks in

Full window since 02:25:

| agent | deaths | deaths/h | night unarmed | drown | starve | paid turns | paid/h | noPath | goals |
|---|---|---|---|---|---|---|---|---|---|
| Andy (control) | 29 | 3.2 | 21 | 2 | 0 | 744 | 81 | 466 | 515 |
| AndyB (candidate) | 14 | 1.5 | 6 | 4 | 1 | 453 | 49 | 188 | 1188 |

Since the previous check (327 min): Andy 23 deaths / 516 paid / 195 goals;
AndyB 10 deaths / 204 paid / 884 goals.

What the incident files show:

- **Both bots get spawn-camped at night.** Andy died four times in fifteen
  seconds at 08:51 on its own spawnpoint (-2,63,64), and AndyB five times in
  eight minutes at 09:20-09:28. Respawning into the same night with nothing
  in hand, next to whatever killed you, is the dominant death mode for both.
  The candidate does not address it; it just dies there less often because
  it spends more of the day with tools and torches.
- **AndyB's day deaths are drownings while armed** at y=39-53 (614,39,67;
  634,40,53; 597,53,-67): it goes after ore through flooded caves. One
  starvation at 08:42, food=0.
- Andy never leaves the flooded village around its base; 21 of 29 deaths are
  night, unarmed, to mobs within 60 blocks of home.

**Verdict:** the candidate halves deaths per hour, cuts paid turns per hour
by 40%, and more than doubles goals reached, consistently across two checks
and seven dusks. Recommend promoting. Next candidates, in order: (2) night
respawn -- do not stand on the spawnpoint at night; move the spawnpoint or
dig in immediately on respawn; (3) food before it hits single digits;
(4) no ore runs through water.
