# Faster iteration: deterministic merge, incident files, fixtures, scorecards

**Status:** shipped (code); two-bot A/B blocked on a second account (see below).

## The problem

One policy change cost about a day to judge: edit, deploy, wait 7-30 minutes
for the LLM merge (which sometimes dropped `interrupts` or truncated), run a
scenario, soak for hours, then grep four log patterns by hand. A 20k-line
sample of the live log was 44% `move:path:partial` lines, enough that
`docker logs --since 24h` timed out before any analysis could start.

## What changed

1. **Deterministic merge** (`mergeProfiles` in policy.js). When the base and
   every attribute ship rules, regen is bookkeeping: base rules in order, then
   attributes appended, a same-named rule from a later profile replacing the
   earlier one in place, goals joined in order. The validator runs on the
   result and a conflict fails *at the profile* ("do not merge cleanly")
   instead of being refereed by a 4B model. The LLM compile path remains only
   for prose-only profiles and the agent's own `!policy` self-writes.
   `restoreDeclaredPacing` is no longer needed on this path (nothing gets
   dropped). The one real duplicate between shipped profiles,
   `build_a_furnace_for_cooking` (food_gathering) vs `build_a_furnace`
   (stayin_alive), is gone; `tools/policy_check.js` now asserts the shipped
   base+attribute combinations merge cleanly.

2. **Incident files.** Every death writes `bots/<name>/incidents/<ts>.json`:
   cause, position, night/armed, food, oxygen, inventory, held item, nearby
   entities with distance, the running action, whether an LLM turn was in
   flight, the deployed sha, and the last 60s of EVT lines from a ring buffer
   (a one-time wrap of `console.log` that keeps only `EVT`/`Awaiting`/
   `Received.` lines). `live_test.sh incidents [n]` pulls and summarises the
   latest n, `incident <name>` prints one.

3. **Scenario fixtures** (`src/agent/behavior/scenarios.test.js`). A flat
   facts object stands in for the world; the test overrides each condition's
   `fn` with a small interpreter and asks which rule the arbiter fires first.
   Seven cases seeded from devlog death classes (night underground, foxhole
   exemption, hunted at night, drowning outranks night rules, eat before
   search, stuck path, ranged raider by day). The test also fails if a new
   engine condition has no interpreter. Add a case from an incident file when
   you fix a death class. Run `node src/agent/behavior/scenarios.test.js
   --dump` to see the full firing order per scenario.

4. **Path-partial rate limit.** `move:path:partial` is now one line per 10s
   with `n=<count>`, so tallies stay exact and the log shrinks by roughly
   half. `scorecard` sums the counts.

5. **Deploy stamp + scorecards.** `deploy` writes `/app/DEPLOY_SHA`
   (`<short sha>[-dirty]`). `soak_watch.sh` samples now carry `sha=`,
   `paid=`, `nopath=`; `soak_watch.sh scorecard` prints one row per sha with
   deaths/h and paid/h. `live_test.sh scorecard [since]` is the one-shot
   version straight from docker logs.

6. **Two-bot A/B.** `live_test.sh spawn <name>` creates a second agent in
   the running container over the mindserver socket (`drive.js create`), from
   a copy of `profiles/litellm.json` with the container's live settings, and
   prints the Microsoft device-code link from its log. The auth cache is keyed
   by agent name, so the login must use a **different Microsoft account** than
   Andy's (`clarke_hackworth` is Andy). Both agents get `!startConversation`
   and `!endConversation` blocked (AndyB via its settings, Andy via
   `bots/Andy/settings.json` overrides) because on first spawn Andy spent its
   first minute briefing AndyB about being stuck. Blocking the command alone
   was not enough: AndyB's relayed login error opened a conversation on
   Andy's side and every later command Andy issued went to AndyB. With
   `!startConversation` blocked, `receiveFromBot` now drops inbound bot
   messages too (`conversation_isolation.test.js`). `init_agent.js` now prefixes
   every log line with `[Name]`; `AGENT_NAME=<name>` selects whose lines
   `scorecard`/`rules`/`incidents`/soak samples read, `MC_PLAYER=<gamertag>`
   its rcon target. Runtime agents do not survive a container recreate.
   `spawn` is re-runnable: an existing agent is restarted, which re-issues the
   code.

7. **Brain switch.** `live_test.sh brain <litellm-route>` rewrites the
   container's `profiles/litellm.json` chat and code models and restarts;
   `brain default` goes back to the local 4B model. The route name has to
   exist in litellm (it needs a key to list them, so not verified here).

8. Not done, on purpose: splitting skills.js/agent.js, or adding a numeric
   `priority` to rules. The fixtures catch ordering bugs cheaper.

## Found on the way: `docker logs --since` is broken on docker.lan

Every harness command (`rules`, `deaths`, `food`, `path`, `soak_watch.sh`)
fetched the log with `docker logs --since <window>`. On the docker.lan daemon
that returns **zero lines** for `10m` and `2h` and hangs on an absolute
timestamp. `--tail N` with N larger than the file (300000) shows the same
symptom: a forward read that stops at 2026-09-06T13:30 after 65,948 lines,
which looks like a bad entry in the json-file log. `--tail 120000` reads
backwards from the end and streams in four seconds. Unknown since when; the
2026-09-01/02 "watching Crafted count" windows may have been watching nothing.
`rawlog` in live_test.sh now tails a bounded count and filters by each line's
own timestamp; soak_watch.sh does the same. Recreating the container (not
`restart`) starts a fresh log file; add `logging.options.max-size` to the
compose service when doing so.

## Also found: the harness was querying the wrong player

`rcon list` shows the bot online as `clarke_hackworth`; both scripts
defaulted `MC_PLAYER` to `clarkhackworth`. Every rcon primitive (`pos`, `tp`,
`give`, `damage`, `heal`, the scenario setups, and the soak sample's
hp/food/y) was addressing a player that does not exist and returning empty.
Default corrected; `pos` and the soak sample now return real values.
Since the A/B split the accounts are: Andy = `clark_hackworth` (harness
default), AndyB = `clarke_hackworth` (`MC_PLAYER=clarke_hackworth`). Andy's
first login had been made with the `clarke_` account by mistake; its cache
(`~/.minecraft/nmp-cache/ab5a00_*`, sha1("Andy")[:6]) was cleared to re-login.

## How the loop looks now

edit -> `node src/agent/behavior/scenarios.test.js` (ms) -> `deploy` ->
`regen` (seconds, not minutes) -> scenario -> `scorecard 2h` before/after ->
`incidents 5` for anything that died.
