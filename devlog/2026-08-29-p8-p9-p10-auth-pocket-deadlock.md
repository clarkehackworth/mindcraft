# Auth-race fix, spawn pocket solidified, stuck-command deadlock

Three fixes shipped from the 2026-08-27 check-in readout: P10 (the auth
window was structurally unwinnable), P9 (the Base spawn sits over a refilling
water feature), and P8 (a stuck rule action swallows the model's fresh
commands for its whole lifetime). P10 + P8 are code (`src/agent/agent.js`,
deployed); P9 is a world change via rcon (no code, no deploy).

## The readout that drove this

48h before the fix: 213 deaths (~4.4/h) — 130 drowned (61%), 67 mob, 9
arrow, 3 starve. `arm_yourself` fired 564 times against 553
`arm_gate_closed` (the gate fix held — the gate is open, the chain is not the
binding constraint). `give_up_on_a_stuck_path` fired 1672 times and 705
self-prompt commands were dropped as "still running". The last 8 deaths were
all in the Base spawn cluster `(-30..-28, y58-62, z85-93)`, night, final
traces `wet14, oxy=0`. Then the MSA token expired and the bot sat in an auth
crash-loop for ~54h: respawn #69 to #821, 756 `invalid_grant`, 756 rotating
device codes, 0 deaths, 0 uncaught throws — a clean, total blackout.

## P10 — the liveness watchdog killed the auth window

**Problem.** `spawn_timeout` was explicitly raised to 300s *for* the
interactive device-code login (see the settings comment), but the liveness
watchdog ("no server time updates for 3 minutes") fires at ~188s and kills
the connection. During a device-code login there are no server time packets by
design — the bot is waiting for a human. So every attempt died at 188s,
invalidating the code, and the 40-80s backoff re-issued a new one. The
approval window was 188s with a code that rotated faster than the
notification arrives: no human can win that race. That is why the 54h
blackout could not be fixed by just approving a code.

**Change.** `agent.js`: an `_logged_in` flag (initial `false`). The liveness
interval early-returns while `!this._logged_in`, so the 300s `spawn_timeout`
owns the pre-login window. The `login` handler sets `_logged_in = true` and
resets `_livenessLastUpdate = Date.now()` so the post-login clock starts from
actual authentication, not from `_connect` (which can be 300s earlier in the
interactive flow). Post-login, the watchdog behaves exactly as before.

**Rejected.** (a) Raising the watchdog threshold to 300s — would also delay
post-login hang detection by the same margin, for the wrong phase. (b)
Killing the process on `invalid_grant` — violates the no-cleanKill rule;
memory persists across restarts and the crash-loop carried the failure
forward for 54h. (c) Auto-approving / faster code rotation — the loop was
already re-issuing codes as fast as the backoff allowed; the problem is the
window length, not the rotation speed.

## P9 — solidified the Base spawn water pocket (world change)

**Problem.** The pit-respawn fix (2026-08-25) moved the respawn out of the
origin pit and worked — zero origin-pit deaths. But the respawn at
`(-29, 63, 89)` sits directly over a refilling water feature: a pool at
y58, water at y61-62, and a source at the top (y62) that refilled cells after
a drain. Every death → respawn at Base → fall into the pocket → drown. 130 of
213 deaths (61%) were drownings.

**Change.** `rcon fill -33 56 84 -26 62 93 barrier replace water` — **208
water blocks → barrier** in one server-side command. `replace water` touches
*only* water cells: air (including the y63 spawn cell), stone, and the bot are
untouched. Barrier was chosen because it is solid, walk-on, unbreakable by
mobs, invisible, and — decisively — present in this modded 443 server's
registry. Verified: the death-cluster cells `(-30,58,89)`, `(-30,60,89)` and
the y62 source-level cells `(-29,62,89)`, `(-28,62,88)`, `(-27,62,88)` are now
barrier, not water; the spawn cell `(-29,63,89)` is still air. The bot was at
`(4.7, 66, -22.3)` with full air during the work — outside the box, full
oxygen, no clip risk.

**Rejected / missteps.** (a) *Drain to air* — tried first
(`fill ... air replace water`, 64 blocks). Wrong twice: the y62 source
refilled the drained cells (verified: water again at `(-30,58,89)` and
`(-28,61,92)`), and it left a dry air pit at his spawn — a "stranded in a
hole" trap. (b) *Wool* — `fill ... wool replace water` parsed fine but the
server said `Unknown block type 'minecraft:wool'`: the modded registry does
not have it, so no vanilla block name could be assumed. (c) *Fill only below
y62* — the source would re-flood the air cells; including the source level in
the fill is what removes the refilling. (d) *Per-source setblock removal* —
`setblock` has no `replace <block>` clause (a syntax error on this server),
and scanning for the source cell-by-cell over SSH was too slow; the
water-only `replace water` fill is safer anyway (it cannot touch a solid or
the bot). Note for future world work: `barrier` works on this server, `wool`
and `planks` do not.

## P8 — a stuck mode:action swallowed every fresh command

**Problem.** `handleMessage` drops *every* self-prompt LLM command while a
`mode:` action is executing. The gate was added for a real reason (soak 11):
a stale in-flight command — the one the model committed to *before* the rule
fired — lands mid-action and cancels the rule's goal (~30% of policy actions
ended "interrupted"). But a rule action holds `executing` for its whole life
(up to the 120s action timeout). When `give_up_on_a_stuck_path`
(`interrupts: all`) fires and its own `move_away` is itself stuck (no route
out of the pit), the gate keeps swallowing the model's *fresh* escape and
collect commands — the exact commands that could break it out. 705 drops over
48h; the bot could not act on its own diagnosis. This is also why 564
arming-chain starts still produced no sword: the collect/escape steps were
dropped mid-chain.

**Change.** `agent.js`: the drop is now bounded by the action's age. `const
mode_age_ms = Date.now() - this.actions.last_action_time;` and the gate drops
only while `mode_age_ms < STALE_COMMAND_WINDOW_MS` (`STALE_COMMAND_WINDOW_MS =
60000`, a named constant next to the other tuning constants). Young action
(<60s): still drops — the soak-11 protection is preserved for the one stale
command it guards against. Stuck action (≥60s): fresh commands pass through,
and a fresh command runs `executeCommand → runAction → stop()`, taking over
from the stuck action. 60s is one self-prompt turn: long enough that the
command the model committed to before the rule fired is still suppressed,
short enough that a `move_away` wedged for a full minute starts yielding.
Before, the effective window was the action's full 120s timeout.

**Rejected.** (a) Remove the gate entirely — revives the soak-11 regression
(rule actions killed by their own stale command). (b) A per-rule window in the
policy schema — more surface for no demonstrated need; one global constant is
enough and matches the other tuning knobs. (c) Capping the `give_up` action's
own runtime (e.g. 30s) — changes behavior for every rule action; this fix only
changes *who wins* once an action is already stuck, and leaves the action's
full runtime intact for actions that are actually working.

**Check.** `src/agent/stale_command_drop.test.js` (assert script, house
pattern per `stoploop_concurrent.test.js`) re-implements the predicate but
reads the real `STALE_COMMAND_WINDOW_MS` and the age-bounded guard out of
`agent.js` source, so a regression that removes the bound or drifts the
constant fails it. It also asserts the P10 `_logged_in` early-return and
login re-arm are present. `node --check` passes on both `agent.js` and the
check.

## Deployment

- P9: applied live via rcon on the Minecraft server container (no agent code
  involved; survives agent restarts).
- P10 + P8: `deploy src/agent/agent.js src/agent/stale_command_drop.test.js`
  pushed to the agent container and restarted it. The restart re-ran the MSA
  login; with P10 in place the 300s `spawn_timeout` now actually governs the
  auth window instead of the 188s watchdog.
- The 08-25 P1-P5 / pit-respawn / arming-water-gate work in the same working
  tree ships in the same commit.
