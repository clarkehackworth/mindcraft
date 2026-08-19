# Mindcraft Runbook

How to connect, interrogate, fix, regen, deploy, and verify the `Andy` agent
on the live frozen-taiga server. Everything is driven from this repo over one
SSH hop — you never touch the container directly except to read state.

> **Read `AGENTS.md` and `ARCHITECTURE.md` first.** The hard rules in `AGENTS.md`
> (never `cleanKill` as an error strategy, nothing in the tick or packet path
> may throw, don't trust `minecraft-data` on a modded server, non-trivial logic
> leaves a runnable check behind) are not optional — they are the reason this
> bot survives. If a fix would violate one, stop and rethink.

---

## 1. Topology (who is where)

| Thing | Location | Notes |
|---|---|---|
| You (this repo) | `/a0/usr/projects/mindcraft` | branch `feat/mindserver-bind-auth`, remote `git@github.com:clarkehackworth/mindcraft.git` (SSH key) |
| Docker host | `ssh jeff@docker.lan` | all commands hop through here |
| Bot container | `mindcraft` | runs the agent process; exposes the MindServer socket on `:8080` |
| MC server | `minecraft-prominence2` | the modded server (~443 mods), RCON + in-game `Andy` |
| Agent | `Andy` | the persona in the game. **`Andy` != `bot.username`** under MS auth — check both when correlating logs |

Everything talks over the **MindServer socket** (`http://<host>:8080`) with an
auth token. `tools/live_test.sh` pulls the token from the container for you
(env `MINDSERVER_TOKEN` wins), so you normally never type it.

## 2. Connect / environment

```bash
cd /a0/usr/projects/mindcraft
export MC_HOST='jeff@docker.lan'          # single SSH hop; every subcommand uses it
# optional overrides if you move things:
#   export MINDSERVER_URL='http://docker.lan:8080'
#   export MINDSERVER_TOKEN='<token>'      # else pulled from container
```

Sanity check you are connected and the agent is up:

```bash
tools/live_test.sh pos        # where Andy is
tools/live_test.sh policy     # current base + rule count + layers (source of truth for policy state)
```

## 3. Interrogate (is it doing well?)

Prefer `evt` (socket, instant, structured) over log grepping where an EVT line
exists. Log windows take a duration (`5m`, `1h`, `6h`).

```bash
tools/live_test.sh deaths [window]      # death causes + circumstances + what it owned; `raw` for ungrouped
tools/live_test.sh food  [window]       # hunger bar + inventory deltas
tools/live_test.sh path    [window]     # non-success pathfinder verdicts, resets, goals, breadcrumbs
tools/live_test.sh watch  <pat> [win]   # raw tail of the agent log matching <pat>
tools/live_test.sh evt <pattern> [secs] # await a specific EVT line (e.g. 'rule:fire')
tools/live_test.sh snapshot / restore   # freeze/restore agent state for a repro
```

Interpreting:
- **Deaths are the headline.** `deaths` groups cause, then `(night|day):(armed|unarmed)`,
  then `:itemsN` (what it owned). A run of **unarmed** deaths = a gear problem,
  not a combat problem. Falls get coordinates — clustering near one spot is a
  pathing bug; a single fall is noise.
- **`nearestEntity` stack frames are usually benign** on this modded server:
  prismarine-entity `objectType` warnings, caught + logged. Confirm there are
  **zero** `Uncaught`/`FATAL` lines before treating any stack trace as a real bug.
- **Pathing:** repeated `noPath`/timeout at the *same* spot, or breadcrumbs that
  stop while a goal is active, are the real bugs.

## 4. Fix — policy vs code

Most behavior problems are **policy state**, not code. Change the smallest layer
you can. Policy is layered; the **self layer outranks the active layer**, so a
single learned self rule (e.g. `stay 32 blocks from your death spot`) can
silently override an active-layer rule (`go_back_for_your_grave`) and break
recovery.

- **A learned self rule is blocking something** -> `tools/live_test.sh clearlayer self`
  (the legitimate lessons are already compiled into the active layer; what is
  left is usually duplication + overrides).
- **A capability is dormant** (mining, gear ladder, etc.) -> activate it by
  regenerating from a base that includes it (see section 5).
- **A rule is wrong** -> edit the base `policies/<name>.json`, then regen.
- **Code is wrong** -> only when logs show an actual logic/parse bug, not a
  policy gap. Then section 7. Always leave a `*.test.js` next to the change or
  an assert script in `tools/` (no new frameworks).

## 5. Regen (make policy changes take effect)

Regen is **the** way policy changes go live. `tools/live_test.sh regen` wraps
the whole ceremony — it sends `!stop`, **locks** the agent (quiesce), runs the
regen, unlocks — so **always use it, not raw `drive`.**

Two paths (`drive.js` -> `generate-policy`):

1. **LLM merge** — `regen <base> <attr1> <attr2> ...`
   Merges the base + each attribute profile through the LLM. Powerful, but it
   puts every profile's JSON + registry docs in one context. **It hits
   `Context length exceeded` on the large profiles** (the 4-profile merge failed
   this way). Do not fight it — use path 2.
2. **Deterministic no-attribute copy** — `regen <base>` (no attributes)
   The LLM-free path: it just copies `policies/<base>.json` into the active
   layer. Fast, reproducible, no context ceiling. **This is the workaround for
   the LLM merge failing on context length** — and it is what the 2026-08-18
   gear/mining activation used.

Workflow to *add* dormant capabilities (the proven one):

```bash
# 1. Build a combined base in the repo: current validated rules + the new
#    attribute rules (no name collisions), one combined goal, elbow_room mode.
#    (e.g. policies/survive_upgrade.json = 60 validated + 18 from leveling_up + mining)
cp <built-base>.json policies/<base>.json

# 2. Validate locally before touching the live bot:
node --test src/utils/policies_valid.test.js

# 3. Push the base into the container's /app/policies (it is on the volume, not git-tracked live):
tar -C . -czf - policies/<base>.json | ssh $MC_HOST 'docker exec -i mindcraft tar xz -C /app'

# 4. Regen from it, no attributes:
tools/live_test.sh regen <base>

# 5. Verify (section 8).
```

## 6. Deploy (code) & restart

`deploy` is the only sanctioned way to push code. It: syntax-checks every `.js`
with `node --check` (aborts on error), tars the changed files, copies them into
`/app`, then restarts the agent over the socket (falls back to
`docker restart mindcraft`).

```bash
tools/live_test.sh deploy                 # auto-detects changed src/, profiles/, policies/, settings.js, main.js
tools/live_test.sh deploy src/agent/x.js  # or name files explicitly
```

- **Restart is safe and expected** — memory persists across restarts (that is
  exactly why `cleanKill`-as-error-strategy is banned in `AGENTS.md`; a crash
  loop is worse than a degraded run). The agent comes back with its state.
- Process control also exists directly: `tools/live_test.sh restart|stop|start`.
- **Do not** deploy a fork for a dependency bug — dependency fixes go in
  `patches/` via patch-package.

## 7. Code changes (when it really is code)

```bash
# 1. Reproduce/inspect: watch the log, grab the failing window.
# 2. Change the code. Leave one runnable check behind:
node --test src/<path>/<name>.test.js      # co-located test
# 3. Local gate (node v22, no extra frameworks):
node --test src/utils/policies_valid.test.js
timeout 120 node tools/policy_check.js      # asserts a few rules fire
# 4. Deploy + restart (socket restart, container fallback):
tools/live_test.sh deploy
# 5. Verify it is back and behaving (section 8). Watch for Uncaught/FATAL — there should be none.
```

## 8. Verify (did it actually take?)

Never trust a deploy/restart to have worked — confirm.

```bash
tools/live_test.sh policy                 # base name, rule count, layers (self should be 0 after clearlayer self)
tools/live_test.sh evt 'rule:fire' 600    # watch the new rules actually fire over ~10 min
tools/live_test.sh deaths 6h              # is the death curve bending?
tools/live_test.sh food  6h               # is it still eating?
```

Success looks like: new rules (e.g. `mine_coal_ore`, `keep_stone_stocked`,
`arm_yourself_from_the_chest`) firing in `evt`, self layer at 0, and unarmed
death count dropping over the next day.

## 9. Before the next run

- **Commit the live changes.** Right now the gear/mining work is uncommitted:
  `policies/survive_upgrade.json` (new), `devlog/2026-08-18-gear-and-mining-activation.md`,
  `devlog/README.md`. Commit them so a fresh clone reproduces the deployed state.
- **Back up the agent's policy state** (it lives only on the volume, not in git):
  ```bash
  ssh $MC_HOST 'docker cp mindcraft:/app/bots/Andy/policy.json -' > backup-andy-policy.json
  ```
  `policy.json` = base + active rules + self layer + lock flag. If a regen goes
  sideways, this is what you restore.
- **Check the MC server healthcheck.** `minecraft-prominence2` is reporting
  `unhealthy` (ping i/o timeout, FailingStreak ~1709) even though the bot is
  alive and playing — almost certainly a healthcheck artifact, not a dead
  server. Confirm before a run so you are not chasing a ghost:
  `ssh $MC_HOST 'docker inspect -f {{json .State.Health}} minecraft-prominence2'`.
- **Re-check Andy's inventory ~6h after a gear change** to confirm it reached
  stone gear by the next night (it starts each new cycle near empty).

## 10. Gotchas (learned the hard way)

- **`Andy` != `bot.username`.** Microsoft auth gives the in-game persona a name;
  `bot.username` is the account. Check both when matching log lines to the agent.
- **The self layer outranks the active layer.** A single self rule can veto an
  active rule. `clearlayer self` is the fastest unblock; the good lessons are
  already in the active layer.
- **LLM regen has a context ceiling.** Large multi-profile merges fail with
  `Context length exceeded`. Use the deterministic no-attribute copy path (5.2)
  and build the combined base by hand in the repo.
- **Modded server = untrusted `minecraft-data`.** Prefer server-sent data from
  `bot.registry`; fall back to a harmless placeholder, never throw. The
  `nearestEntity` prismarine warnings are a symptom of this and are benign.
- **Nothing in the tick/packet path may throw.** It runs with no catcher; one
  uncaught throw takes down the whole agent process. Degrade, log, or hand it to
  the LLM — never `cleanKill` as an error strategy (memory persists, so that
  becomes a crash loop).
- **Live state is on a Docker volume, not the git repo.** `/app/bots`,
  `/app/policies`, `/app/profiles`, `/app/src` are all on `mindcraft_mindcraft_data`.
  The repo's `bots/` + `policies/` are the *source* you edit; the container's
  copies are what runs. `deploy` / `docker cp` bridge them — there is no auto-sync.
- **Deliberate shortcuts are marked `ponytail:`** in the code with a named
  ceiling. Leave the marker when you touch that spot; do not silently expand it.

---

### Quick reference

| Goal | Command |
|---|---|
| Where / what is it doing now | `tools/live_test.sh pos` / `policy` |
| Is it dying? | `tools/live_test.sh deaths 6h` |
| Eating? | `tools/live_test.sh food 6h` |
| Pathing bug? | `tools/live_test.sh path 1h` |
| Unblock a learned rule | `tools/live_test.sh clearlayer self` |
| Activate a capability | build base -> `policies_valid.test.js` -> `docker cp` -> `tools/live_test.sh regen <base>` |
| Ship code | `node --test ...` -> `tools/live_test.sh deploy` |
| Confirm it took | `tools/live_test.sh policy` + `evt 'rule:fire' 600` |
