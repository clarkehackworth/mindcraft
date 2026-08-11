# The policy improvement loop

How to run the stayin_alive / food_gathering optimization loop against the live
bot. Written after ~8 iterations of it; follow the procedure and read the
gotchas before touching anything. The goal, in priority order: the bot stays
alive, gathers food, and pays as few LLM turns as possible doing either.

## Principles (learned, not theoretical)

- **The engine prices everything.** Rules in `src/agent/behavior/policy.js`
  evaluate every tick for free; only `prompt_self` steps and goal-loop turns
  cost an LLM call. Optimization = moving work from prompts into named actions,
  then gating the surviving prompts so they fire only when judgment is
  genuinely needed (biome-specific "what is edible here", not "dig a hole").
- **The self layer is a signal, not noise.** When the bot repeatedly writes
  the same self rule (`live_test.sh policy` shows the layer), it has found a
  gap in the active layer. Fold the lesson into the base/attribute profile
  (with proper gates — the bot's own versions thrash), then clear the layer.
  Clearing without folding just makes it rewrite the rule, at LLM cost.
  Zero self-writes over a rough night = the profiles are complete for now.
- **Idle-priority rules are close to dead code on a bot with a goal.** Every
  gate on `craft_a_bed` was satisfied -- 3 wool and a log confirmed by rcon, no
  bed anywhere, hostiles cleared, healed, daylight -- and it sat unfired for
  five minutes. In that window only two rules fired at all, both `interrupts:
  all`. The goal loop never goes quiet long enough to hand an idle rule a turn,
  so "idle" in practice means "maybe never", not "when convenient". Promoting
  the rule to `all` made it fire within one regen cycle. This is why the pantry
  walk kept getting preempted too, and it puts a question mark over the whole
  gathering half of food_gathering, which is idle-gated throughout. Reserve
  idle for rules that are genuinely optional or that travel; anything one-shot
  and cheap should interrupt, since it can only do so once.
- **Gate gathering on stock, not hunger.** Hunger-gated rules produce a bot
  that eats but never banks. `berry_run_while_stocked_low` and
  `hunt_for_the_larder` are the pattern: fire when inventory is low and things
  are calm.
- **Emergency prompts are last resorts behind free escalation.** Free search
  rules fire at hunger 15/13; the two food prompts only at 11 and 8. Night
  shelter: bed > free dig_in > prompt-on-dig-failure. Keep that ladder.
- **Scenario tests get setup help; soaks get none.** `hunger`/`night`/`freeze`
  isolate one mechanism and may clear hostiles or grant cap material. The
  unaided answer comes from passive observation windows only.

## The loop

1. **Read state**: `tools/live_test.sh policy` (composed rules + self layer),
   `rules 30m` (fire counts — paid prompts visible by name), `food 30m`,
   `path 30m`, plus vitals via `pos` / rcon Health / foodLevel.
2. **Diagnose**: prompt rules firing often → find the free-action gap.
   Self rules present → read them; fold the legitimate lessons, drop the
   duplicates/broken ones (the compiler writes bad conditions — e.g. a
   "ledge awareness" rule keyed on `block_nearby air 4`, true everywhere).
3. **Edit** `policies/stayin_alive.json` (base) / `policies/food_gathering.json`
   (attribute), or the engine itself (new ACTIONS/CONDITIONS in policy.js,
   skills in library/skills.js) when a whole class of prompts can become a
   reflex (that's how `dig_in` + `is_sheltered` were born).
4. **Validate locally** — non-negotiable, the validator has caught real bugs
   every time:
   `node --input-type=module -e "import {validatePolicy} from './src/agent/behavior/policy.js'; ..."`
   then `for t in src/agent/behavior/*.test.js tools/policy_check.js; do node $t; done`
   (the test suite validates the shipped profiles too).
5. **Deploy**: `tools/live_test.sh deploy <files>` (tars to the container,
   restarts the agent). Wait for `pos` to return coordinates.
6. **Clear self layer** if you folded its lessons: `clearlayer self`.
7. **Regen**: `tools/live_test.sh regen stayin_alive food_gathering`.
   Read the gotchas below before deciding a regen "failed".
8. **Verify compose**: `policy` — expected rule names/gates present.
9. **Test**: targeted scenario (`hunger` | `night` | `freeze` | `raider`),
   then a passive window with the telemetry commands.
10. **Repeat.** One change-set per iteration; the merge is an LLM call, so
    batch edits before regenerating.

## Harness reference (tools/live_test.sh)

- `deploy [files]` — push changed files + restart agent
- `policy` / `regen <base> [attrs]` / `clearlayer <layer>` / `lock|unlock` (via drive.js)
- `rules [since]` — rule fire counts; `food [since]` — hunger + food-inventory
  story; `path [since]` — pathfinder verdicts + breadcrumbs
- Scenarios: `hunger`, `night`, `freeze`, `raider [mob]`
- `say` (chat → bot; `!commands` bypass the LLM), `evt` (socket stream),
  `watch <regex> [since]` (docker logs), `pos`, `rcon`, `snapshot`/`restore`

## Gotchas that cost hours

- **The merge is slow, big, and lands after it "fails".** Three things bite in
  a row, and all three cost an afternoon on 2026-08-09:
  1. *A cap, not a mistake.* The profile's `max_tokens` (8000) is sized for a
     chat turn, but a two-profile merge re-emits the whole policy. It came back
     cut off three times -- "Response was not valid JSON: Unexpected end of
     JSON input" -- and `compilePolicy` dutifully retried each one three times,
     because a truncation looks like a coin flip. It is not; retries cannot fix
     a ceiling. `compilePolicy` now asks for 16000 and puts the reply's length
     in the error, so the next cap is one line to read.
  2. *Client timeouts below the relay timeout.* Wrapping regen in
     `timeout 1750` killed a merge 50 seconds before the 1800s relay would have
     answered. Keep any client timeout comfortably above the relay's.
  3. *It installs late anyway.* With the bigger cap the merge now exceeds even
     1800s, so `regen` reports "Agent did not respond" and then the policy
     appears about seven minutes later. Never retry on that error -- watch
     `compose.generated_at` until it changes.
- **`drive.js` output over 64KB used to vanish.** It printed and then called
  `process.exit`, which drops whatever stdout has not flushed to a pipe: the
  policy dump arrived cut at exactly 65536 bytes and parsed as invalid JSON,
  which reads like a truncating server. Fixed by setting `process.exitCode` and
  closing the socket. If a harness command ever returns suspiciously round
  output again, this is the shape of it.
- **Ask the bot before believing a note about the world.** `get_a_bed` carried
  a description asserting the bed recipe needed `feather_block`, and that alone
  kept it a paid prompt. One free `!getCraftingPlan` disproved it.
- **Regen on a busy bot starves >600s and "fails".** The harness regen already
  sends `!stop` and holds the policy lock. Even so, merges can exceed the 600s
  relay timeout ("Agent did not respond") **and still install late** — always
  check `policy` for the expected change before retrying. Retrying while a
  merge is in flight triggers the revision-conflict discard. (The proxy now
  rebases: only a mid-merge change to the *active* layer discards.)
- **Two EVT formats.** Docker logs: `EVT rule:fire:<layer>:<rule>`. Socket
  stream (`evt`): `mode:fire:policy:<layer>:<rule>`. Wrong pattern = "rule
  never fired" false negatives.
- **The duplicate-rule validator is right.** If it says two rules are the same
  rule with different numbers, merge them (that's how eat_when_hungry formed).
- **Modded server realities.** Dig times are slower than vanilla (bare-hand
  stone exceeds dig_in's 10s cap — hence `craft_a_pickaxe`); mobs roam in
  daylight; entity ids need `summon` verification before adding to rules;
  much food is modded (invisible to `registry.foods`, so `food:inv` may miss
  what `food:level ... :ate` catches).
- **`is_freezing` can only be confirmed by making the meter move** (powder
  snow); absence of evidence isn't evidence.
- **foodLevel 0→20 in one event is a respawn, not a meal** (`:reset` label).
- **Subagents stall on long waits.** Sonnet workers park on "waiting for the
  monitor" mid-scenario. Give them explicit "poll the task result, never end
  your turn to wait" instructions, and be ready to collect results yourself
  from docker logs — everything important is greppable after the fact.

## State as of 2026-08-09

Nights, storms, and chases are handled by free rules (`dig_in` family,
`is_sheltered` gates, `wait_out_the_night_under_cover`); typical windows show
0–2 paid prompts per 20 minutes (was ~8/15min); self-writes at zero after the
armed-daytime shelter fold; feeding is continuous and proactive. The composed
active layer is ~37 rules from stayin_alive + food_gathering.

## Worth doing / checking next

1. ~~**Pantry accumulation proof.**~~ Done, 2026-08-09, and the answer was
   worse than "unproven": `!savedPlaces` returned nothing at all and the chest
   `!viewChest` walked to (24,72,-26) was empty. `stock_the_pantry` had been
   gated on a chest within 24 blocks while the bot forages 60 blocks away, so
   nothing was ever bankable, and every food run re-paid for a 128-block
   search because no spot survived the trip home.

   The remembered-spots loop is now the fix: `place_known` (condition) plus
   `remember_here` / `goto_place` (actions, both free), with
   `remember_the_berry_patch` and `remember_the_pantry` recording a spot on
   sight, `walk_the_berry_route` beating the search rules to a known patch,
   and `stock_the_pantry` walking to the remembered chest. Gate the recording
   on `not place_known` (fires once) and the walking on `place_known` (quiet
   until there is somewhere to go); `src/agent/behavior/remembered_places.test.js`
   holds that shape.

   Verified live: `remember_the_pantry` fired free, `!savedPlaces` went from
   empty to `pantry`, and `stock_the_pantry` walked and banked 16 carrots
   (chest at 9,67,-67 now holds them). Two things to know:
   - `deposit` uses the *nearest* chest, not the remembered one. When the walk
     is cut short the food still lands somewhere, which is the point, but the
     "pantry" is wherever the bot happens to be standing.
   - The blocking half only lands in calm weather. Freezing, strays and the
     goal loop all preempt an idle-priority 60-block walk; three attempts died
     to interruptions before one completed. Idle rules that travel need a quiet
     window, so measure them in one.

2. ~~**The bed.**~~ Done, 2026-08-09. `get_a_bed` justified staying a prompt
   in its own description -- "the recipe is server-dependent, this one wants
   feather_block, not wool" -- and that was simply wrong. `!getCraftingPlan`
   (free, no LLM) ends its plan with `3 magenta_wool + 3 oak_planks -> 1
   magenta_bed`: the ordinary recipe. Ask the bot before believing a note
   about the world; it can check for nothing.

   Replaced by a free chain: `hunt_sheep_for_wool` (the wool is the only part
   that needs walking anywhere; hunting mode does the killing), `craft_a_bed`,
   `place_the_bed` -- each gated on *both* "no bed in the bag" and "no bed
   within 16", so putting one down silences the whole chain instead of sending
   it back out for more sheep. `sleep_at_night` was already waiting on a
   nearby bed. Survival prompts are down from five to four;
   `shelter_when_night_and_no_bed` stays deliberately, as the fallback for
   nights when digging in fails.

   Half proven, 2026-08-09. `place_the_bed` fired and there is a real bed at
   (-52,88,-66); `sleep_at_night`, which the entry above says had barely ever
   fired, has now fired three times. `craft_a_bed` has still not been seen --
   that bed was crafted by the goal loop, on a paid turn, and only the placing
   was free. `hunt_sheep_for_wool` remains unobserved too.

   Getting there took promoting `craft_a_bed` and `place_the_bed` from idle to
   `interrupts: all`, for the reason below, which is the more important half of
   what this attempt found.

3. **Path failure clustering.** `path 2h` — do `partial:visited=4` /
   `noPath` verdicts cluster at coordinates? If yes, that terrain is eating
   actions (failed berry runs may be pathing, not absence of bushes).
4. **Death forensics.** Deaths still happen on bad nights but leave no
   structured trace. Log `EVT death:<cause>:<pos>` from the death/respawn
   handler; every fold so far came from death patterns, and this makes them
   greppable instead of inferred.
5. ~~**Regen relay timeout.**~~ Raised to 1800s in `mindserver.js`
   (2026-08-09) after a two-profile merge blew through 600s twice. Note the
   relay lives in the mindserver, not the agent, so `deploy` is not enough --
   the container has to be restarted for the new timeout to take.

6. **Widen `food:inv` to all items** if you need to know *what* it eats —
   modded foods bypass `registry.foods`.
7. **Prompt budget per game-day.** The real KPI. One uninterrupted in-game
   day+night, count `POLICY RULE` lines + goal-loop turns. Target: single
   digits. (Never achieved a clean full-day measurement — observers kept
   getting interrupted by deploys; do the soak *before* editing anything.)
8. **The policy lock experiment.** With the profiles this complete, locking
   self-writes (`lock`) may be pure win — but it also silences the signal that
   found every gap so far. If you lock, watch death rates for regression.

## Soak 8 (2026-08-10 22:51 UTC → 2026-08-11 ~13:50 UTC, 15h)

The clean measurement finally happened, and it measured a disaster:

- **80 deaths** (62 mob, 6 drown, 4 arrow, 2 freeze). 36 of them within two
  blocks of the bed at (-52,88,-66): a `mutantmonsters:mutant_zombie`
  spawn-camped the respawn point. 37 deaths in the 06:00 UTC hour alone,
  ~10 s apart, tagged `day:unarmed` — so `dig_in_at_your_death_spot`
  (night-gated, commit 242a16b) never applied, and `leave_your_death_spot`
  ran its 24-block daytime walk 14 times and lost the footrace every time.
- **2,039 paid prompts**, ~136/h — the death spiral IS the prompt bill: every
  respawn restarts the goal loop.
- **1,411 `noPath` lines.** Target was single digits. Most are presumed
  spiral fallout; remeasure after the fix before believing them.
- **Self-layer regrew 8 rules** overnight (was zero). All eight restate two
  gaps: "never be unarmed at night" and "avoid last_death_position" — the
  second is unsatisfiable advice when respawn *places* you there.
- MC server itself restarted at 12:15 UTC (restart count 3, health flapping
  "unhealthy") — some agent reconnect noise is server-side, not ours.

**Root cause found in the engine, not the rules.** `Rule.last_fire`,
`last_eval` and the no-progress `backoff` multiplier persist across death
(policy.js `eligible()`). In a respawn-camp spiral every protective rule
fires once, fails (it died mid-dig), doubles its backoff, and is then
ineligible through the next several deaths — `dig_in_when_hunted` at
cooldown 60×backoff sat silent while deaths came every 10 s. The rules were
right; the engine muted them exactly when they were needed.

**Fix (2026-08-11):** the `death` handler in agent.js now resets
`last_fire`/`last_eval`/`backoff` on every rule and logs
`EVT policy:cooldowns_reset:death`. Death already resets position and
inventory; now it resets the rulebook too. The existing no-progress backoff
re-arms immediately after respawn, so a rule that fails post-respawn still
backs off — it just doesn't inherit last life's penalties.

Next: soak 9 to remeasure noPath and prompt budget on a spiral-free day.
`craft_a_weapon` also failed repeatedly with "missing ingredient" after
crafting pine planks/sticks (Prominence recipe path) — 22 fires; worth its
own look if soak 9 still shows it.
