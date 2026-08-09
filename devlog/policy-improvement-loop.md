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

1. **Pantry accumulation proof.** Grazing works; banking is unproven. A quiet
   2-hour window of `food` + chest contents (`rcon data get block <pantry xyz>`)
   should show deposits. If not: the remembered-food-spots idea — once the goal
   loop `!rememberHere`s a berry patch/herd, add a stock-gated rule (or action)
   that returns to remembered spots mechanically, turning one paid discovery
   into a permanent free route.
2. **The bed.** `sleep_at_night` has barely ever fired because the bot never
   holds a bed (needs wool → sheep). Getting a bed makes every night free and
   removes two prompt rules from play. Check whether `get_a_bed` (paid) fires
   and goes anywhere; consider a named chain if sheep are ever nearby.
3. **Path failure clustering.** `path 2h` — do `partial:visited=4` /
   `noPath` verdicts cluster at coordinates? If yes, that terrain is eating
   actions (failed berry runs may be pathing, not absence of bushes).
4. **Death forensics.** Deaths still happen on bad nights but leave no
   structured trace. Log `EVT death:<cause>:<pos>` from the death/respawn
   handler; every fold so far came from death patterns, and this makes them
   greppable instead of inferred.
5. **Regen relay timeout.** Merges have outgrown 600s. Either raise the
   timeout in mindserver.js/drive.js or shrink the merge prompt (the compose
   has redundancy an LLM merge doesn't need to re-read).
6. **Widen `food:inv` to all items** if you need to know *what* it eats —
   modded foods bypass `registry.foods`.
7. **Prompt budget per game-day.** The real KPI. One uninterrupted in-game
   day+night, count `POLICY RULE` lines + goal-loop turns. Target: single
   digits. (Never achieved a clean full-day measurement — observers kept
   getting interrupted by deploys; do the soak *before* editing anything.)
8. **The policy lock experiment.** With the profiles this complete, locking
   self-writes (`lock`) may be pure win — but it also silences the signal that
   found every gap so far. If you lock, watch death rates for regression.
