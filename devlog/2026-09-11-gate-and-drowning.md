# Gate, utilization, incident fixtures, A/B bench; drowning + melee-prompt fixes

Date 2026-09-11. Read from the 120k-line log window on deploy 95b5a69.

## What the log said
- Andy 13 deaths / 6h (2.2/h), AndyB 5. Same band as the August soaks; a month of iteration had not moved it.
- Drowning was the top class across both bots (7 of 18), all daytime, all under `mode:self_preservation`.
  `surface()` logged "Surfaced with 0/20 air left" 1,396 times. `keep_out_of_water` fired 223x with no outcome.
- 6 of Andy's 13 incidents had a prompt in flight, several with a zombie at 1 block.
- LLM-issued commands: `!stats` 123, `!nearbyBlocks` 58, `!inventory` 18, plus ~110 dropped duplicates: a third of paid turns were the bot asking for facts.
- 25 of 80 rules never fired, including `surface_when_drowning`, `flee_when_hurt`, `steer_clear_of_lava`, `sleep_at_night`.
- AndyB drifted from x=255 to x=690 via `go_find_trees`; 4 of 5 deaths were in water out there.

## Iteration loop
1. `live_test.sh gate`: water + pit + night in ~10 min, PASS/FAIL each (no death during the scenario and the rescue marker seen). Run after `deploy`, before a soak.
2. `node tools/incident_to_fixture.js <incident.json> [compose]`: prints the facts and the rule that fires NOW as a paste-ready CANDIDATE line. Every death becomes a regression fixture in seconds.
3. `scorecard` prints the never-fired rules for the agent's compose (POLICY env overrides).
4. `scorecard` appends one row to `devlog/scorecard.csv` (deaths, paid, noPath, best pickaxe, iron, never-fired count).
5. `tools/ab-server/compose.yaml`: offline-mode vanilla 1.20.1 + one mindcraft container with three candidate profiles. No MS accounts, so candidates scale with CPU. Vanilla only; Prominence remains the validation target.

## What the gate found on its first run
- Open-topped water pen: the bot swam out in 5s, Air never below 293. Proved nothing. The pen is now a WELL dug into the terrain with an ice LID by default (`water 90 12 ice`; `none` for open) and reports INCONCLUSIVE when Air never dropped.
- Ice lid reproduced the death class on the first try: rescue fired at Air 12, bot rose to the lid, the self-prompt loop took a paid turn that walked it back into the lake, server Air went to -18, and the reflex stopped firing because `lowAirPersists` treated any negative reading as a broken packet. Every drowning incident that day died at oxygen=-1. Snowy-plains lakes are frozen; hand-digging ice underwater takes about as long as the air lasts.
- The grave at -24,57,76 is under a frozen lake; `go_back_for_your_grave` walked the bot into it three times today. Fixed in agent.js: a drowning death, or a death standing in water, records no grave (`EVT death:grave_in_water:skipped`). Andy's saved wet grave was removed from `bots/Andy/memory.json` by hand.
- Do not edit `live_test.sh` while a gate is running: bash reads the script incrementally and the first run died with `hat: command not found` when the file shifted under it.

## The rcon water pen measured the harness, not the bot
Blocks placed by rcon are never sent to the agent's client. Through a server-side ice lid the drowning tick logged `wet=0/27` and `above=air` while server Air read -16, so the ceiling-dig branch could not run and the pen proved nothing either way. The gate's water step is now `drown`: teleport the bot under REAL water (`DROWN_SPOT`, default the frozen lake at -24,57,76) and watch it get out. The old `water` pen stays for hand use.

Two bugs the real lake exposed that the pen never could:
- The lake ceiling at -24,57,76 is a `barrier` block, unbreakable and not placed by any player. That is why deaths clustered there: under a barrier there is no way up, only sideways.
- A ceiling dig outlived the whole rescue: 116s of a 45s budget on a cobweb, 94s on planks. `bot.dig()` resolves when the server says the block broke, which underwater with the wrong tool can be never. Each dig is now capped at the remaining budget.

## Grave under water
`go_back_for_your_grave` walked the bot into the frozen lake at -24,57,76 three times on 2026-09-11. A drowning death, or a death standing in water, now records no grave at all (`EVT death:grave_in_water:skipped`, agent.js). Andy's already-saved wet grave was deleted from `bots/Andy/memory.json` by hand.

## The drowning gate needs a real hazard and a survival criterion
- The drop point is verified to be a water block by rcon BEFORE the teleport. Escaping in under a second leaves the air bar at 300, so "air never dropped" cannot tell a fast rescue from a dry spot; only the block can.
- Air is sampled every second. At the old 5s cadence the bar had already refilled and a real dip read as 300.
- Pass is survival, not a marker. If the bot gets out before air goes critical the rescue never fires, and that is the best outcome.

## Rescue thrash: fixed
Twelve `surface()` attempts in thirty seconds, most dying "interrupted after 0s". Cause: every policy rule carries `interrupts: 'all'`, the arbiter loop offers a turn to every entry ahead of the active one, and `execute()` -> `runAction()` -> `stop()` cancels whatever is running. So `keep_out_of_water`, `go_back_for_your_grave` and `go_find_trees` each took the wheel from a bot underwater with one air unit left.

`urgentHolder()` in modes.js (exported, unit-tested in `behavior/urgent_hold.test.js`): a NON-urgent mode stands down while an urgent one is mid-fire, logging `EVT mode:yield:<rule>:to:<urgent>`. Urgent modes still preempt each other, which is what the existing pause is for. The hold expires after 60s so a wedged urgent mode cannot own the bot for good.

Measured over three drowning runs at the lake, after the fix: zero interrupted attempts, one "Surfaced with 20/20 air left", zero deaths, and two yields naming `keep_stone_stocked` and `hunt_sheep_for_wool`. Min air 190, 207, 296.

## Two defects in my own context-injection change
- **Circular import.** `contextLine()` statically imported `queryList` from commands/queries.js. queries.js imports commands/index.js for getCommandDocs, and index.js reads `queryList` at module scope, so the cycle only resolves when index.js loads first -- which every other entry point does. Importing queries.js first made `self_prompter.test.js` and `goal_completion.test.js` die with "Cannot access 'queryList' before initialization". The live bot never hit it because its load order happens to be the working one. Now imported at call time, via index.js.
- **Headers leaked into the prompt.** Dropping the header by position (`slice(1)`) left "STATS; Position: ..." and "NEARBY_BLOCKS, snow (x160)" in the live prompt, because not every query puts its header alone on line one. Now dropped by shape: a bare ALL_CAPS token at the start of a line.

Lesson: a killed test run is not a passing test run. The first report of "tests green" here came from a sweep the OOM killer stopped after three files.

## Still open
- `werewolf` at 1.7 blocks killed the bot mid-`goToCoordinates` and the path was never dropped. `HOSTILE_PANIC_RANGE` exists and is 6, so this is the known modded-mob blindness in `isHostile` (mcdata.js already documents category 'creature' -> registry type 'animal'). Every modded hostile that misclassifies is invisible to the panic drop, the self-prompt hold, and the death-prompt hold, all of which ask `hostileWithin`.
- The lake ceiling at -24,57,76 includes a `barrier` block, unbreakable by any tool. Under a barrier there is no way up, only sideways.

## Bot fixes
0. Negative oxygen is handled like "no bar": `lowAirPersists` counts submerged-head samples instead of vetoing. (Below-zero while drowning AND a stale -1 while floating head-up were both seen; the head block tells them apart, the number cannot.) `surface()` budget 20s -> 45s so ice can be dug. Self-prompt loop also holds while submerged with air <= 12 (`EVT selfprompt:held:drowning`).
1. `surface()`: success requires the dry reading (head in air, `isInWater` false) to HOLD for 1.5s; a bob at the waterline cannot. While breathing in open water it aims at the nearest solid block with air above (within 12) and swims on raw controls, since the pathfinder reset on water for a full minute before each drowning.
2. Self-prompt loop skips its turn while a hostile is within 8 (`EVT selfprompt:held:hostile:<name>`); the death prompt waits up to 30s for the same (`EVT deathprompt:held:hostile`).
3. Every self-prompt turn carries stats, nearby entities, and the top 20 nearby blocks ("Current state (do not ask for it)").
4. Dead rules: none deleted. 19 of the 25 are progress-gated (iron, diamond, bread, bed) and correct. The 4 lifesavers plus the leash are pinned as CANDIDATE fixtures in scenarios.test.js. `flee_when_hurt` was gated on `has_food`, which the bot rarely has; now gated on `hostile_nearby 12`. `surface_when_drowning` is shadowed live by the mode at the same threshold, kept as the backstop.
5. Leash: `go_find_trees` needs `not far_from_home 96`; `come_home_when_far` is now `interrupts: all` at 128 blocks (the idle-gated version starved behind go_find_trees).

Verify: `for t in src/agent/behavior/*.test.js; do node --test $t; done` (named_actions known red), `node tools/policy_check.js`.
