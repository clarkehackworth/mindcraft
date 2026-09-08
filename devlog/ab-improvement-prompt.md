# Prompt: improve the Mindcraft bots with A/B testing

Paste everything below the line into a fresh AI session started in
`/home/jeff/dev/mindcraft`.

---

You are improving a Minecraft survival bot. Repo: `/home/jeff/dev/mindcraft`
(branch `develop`). It runs in container `mindcraft` on `ssh jeff@docker.lan`
against a heavily modded 1.20.1 server. Read `devlog/README.md`,
`devlog/policy-improvement-loop.md` and `devlog/2026-09-07-faster-iteration-loop.md`
before touching anything. `ARCHITECTURE.md` explains the policy engine.

## Goal

Fewer deaths per hour, then fewer paid LLM turns per hour, for the same or
better progress (goals reached, gear crafted). Behaviour lives in
`policies/*.json` rules evaluated for free by `src/agent/behavior/policy.js`;
only `prompt_self` steps and goal-loop turns cost an LLM call.

## Two bots, one server

| agent | in-game name | role | home |
|---|---|---|---|
| Andy  | `clarkhackworth`  | **control**: runs `policies/survive_upgrade.json` | ~-30,53,90 |
| AndyB | `clarke_hackworth` | **candidate**: runs the policy under test | ~255,8,-5 (300 blocks east) |

Address AndyB with `AGENT_NAME=AndyB MC_PLAYER=clarke_hackworth` in front of
every `tools/live_test.sh` command. The script ignores a bare `AGENT=`
variable; a command without `AGENT_NAME` goes to Andy. Both bots have
bot-to-bot chat blocked; keep it that way.

## The loop (one change per iteration)

1. **Baseline.** `tools/live_test.sh scorecard 2h` for each agent. Note
   deploy sha, deaths, paid turns, noPath, rule fires, goals.
2. **Diagnose from incidents, not log grep.** `AGENT_NAME=<x> tools/live_test.sh
   incidents 10` lists per-death JSON files (cause, position, inventory,
   nearby mobs, running action, whether an LLM turn was in flight, last 60s
   of events). Read the files. Pick the single most frequent death class.
3. **Candidate policy.** Copy `policies/survive_upgrade.json` to
   `policies/survive_upgrade_b.json` (or edit the existing `_b`), make ONE
   change: a new free rule, a gate change, a reorder, or a new named action
   in `policy.js` / skill in `src/agent/library/skills.js` when a whole class
   of prompts can become a reflex. Never touch `survive_upgrade.json` for a
   candidate.
4. **Add a fixture** to `src/agent/behavior/scenarios.test.js` reproducing
   the death class from an incident file (facts in, expected first-firing
   rule out). Add `survive_upgrade_b` to its `COMPOSES`. It must fail before
   the change and pass after.
5. **Validate locally, non-negotiable:**
   `for t in src/agent/behavior/*.test.js tools/policy_check.js; do node --test $t; done`
   Two tests are known red and not yours: `named_actions.test.js`,
   `collect_pickup.test.js`.
6. **Deploy and install on the candidate only:**
   `tools/live_test.sh deploy` (stamps `DEPLOY_SHA`), then
   `AGENT_NAME=AndyB tools/live_test.sh regen survive_upgrade_b`. Regen is
   deterministic and takes seconds; confirm with `AGENT_NAME=AndyB
   tools/live_test.sh policy` that `compose.base` is `survive_upgrade_b`.
   Code changes (policy.js, skills.js, agent.js) affect BOTH bots on restart;
   for those, compare before/after by sha instead
   (`tools/soak_watch.sh scorecard` groups the cron samples per sha).
7. **Optionally force the scenario** on the candidate: `night`, `hunger`,
   `raider [mob]`, `freeze`, `water`, `pit` scenarios in live_test.sh, or
   the rcon primitives (`summon`, `damage`, `time`, `tp`). Scenario tests
   get setup help; soaks get none.
8. **Soak at least 2 hours, ideally a full day/night cycle x3.** Then
   scorecard both agents over the same window. A win is fewer deaths/h with
   paid/h not worse. Run-to-run variance is large (a past feature survived
   four iterations and was deleted after an A/B/A showed noise > effect), so
   do not promote on one window.
9. **Promote or revert.** Win: fold the change into `survive_upgrade.json`,
   `tools/live_test.sh regen survive_upgrade` on Andy, delete the `_b` diff.
   Loss: keep the fixture if it encodes a real lesson, revert the rule.
10. **Write the devlog entry** `devlog/YYYY-MM-DD-<slug>.md` and a row in
    `devlog/README.md`: what died, what changed, both scorecards, verdict.
    Commit with the sha in the message. One iteration = one commit.

## Rules that have cost hours before

- `docker logs --since` returns nothing on this host. Use the harness
  (`scorecard`, `rules`, `deaths`, `food`, `path`, `watch`), which tails and
  filters by timestamp. Two event formats: docker log `EVT rule:fire:<layer>:<rule>`,
  socket stream `mode:fire:policy:<layer>:<rule>`.
- rcon probes must be READ-ONLY (`data get`, `execute if block`). Never
  `fill`, `clone`, `setblock` to answer a question.
- Never kill the process as an error strategy; never `eslint --fix` repo-wide.
- "idle" means "maybe never" on a bot with a goal: a rule that acts where it
  stands and stops itself uses `interrupts: all`; one that travels stays
  `idle` and only works near the top of the list. Never `interrupts: all`
  with an `is_idle` trigger.
- Gate gathering on stock, not hunger. Free escalation before paid prompts.
- When the self layer keeps writing the same rule (`policy` shows it), fold
  the lesson into the base profile and then `clearlayer self`.
- Check a rule's ACTION OUTCOME, not just its fire. Check `incidents` before
  concluding a rule is dead.
- The MS login: if a bot ever needs to re-login, its code is in
  `tools/live_test.sh watch 'microsoft.com/link' 3m`; Andy must use the
  `clarkhackworth` account and AndyB `clarke_hackworth`, in a private browser
  window. Same account twice = the two bots kick each other forever.
- Do not stop to ask for permission for deploy/regen/scenario steps; they are
  the loop. Stop and ask only before changing the Minecraft server itself or
  anything under `/var/lib` on the host.

Start with step 1 and report the baseline table before making any change.
