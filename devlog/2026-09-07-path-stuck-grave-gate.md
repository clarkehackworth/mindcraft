# path_stuck gate: stop the grave-retrieval re-fire loop

**Commit:** 2026-09-07

## Problem

`go_back_for_your_grave` fired 5 times in a 3-hour window and its trigger
was still true after each fire. The bot was stuck in a 1-wide stone shaft
at (-8, 48, 13) with no tools. `goto_place` to the grave is physically
impossible from a shaft with no pathfinding route, so the rule kept
re-firing every 2-minute cooldown doing futile pathfinding, burning LLM
tokens on STUCK messages, and preventing other rules from running.

The 2026-09-05 descend-perch fix addressed the *graveyard perch* version
(bot climbs tomb, can't get off, arrows). This is the *unreachable grave*
version: the bot is trapped somewhere else entirely and can't reach the
grave at all.

## Change

Added `{ "not": { "cond": "path_stuck", "count": 10 } }` to the
`when.all` array of `go_back_for_your_grave` in all three policy files:

- `policies/survive_upgrade.json`
- `policies/stayin_alive.json`
- `bots/Andy/policy.json` (layer: active)

The `path_stuck` condition already exists (policy.js:241): "The
pathfinder has failed this many times in a row without the bot moving a
block." `goto_place` already clears `path_stuck` in its clears list
(policy.js:490), so after a successful trip the counter resets and the
rule re-arms on the next idle window.

Count of 10: below the default 40 (which is for general pathfinding
stuck), because the grave rule is interrupts:idle with a 120s cooldown —
it fires infrequently, so 10 consecutive failed pathfinds is a strong
signal the target is unreachable from here. A lower count would risk
suppressing the rule during a legitimately long pathfind (e.g. walking
across the map to a distant grave).

## Rejected options

- **Increase the cooldown to 600s**: would slow the loop but not stop it.
  A 5-minute cooldown still means 12 futile pathfinds per hour while the
  bot is stuck in a shaft.
- **Add a `dist` gate (don't fetch gear >64 blocks away)**: the rule is
  already implicitly distance-limited by the pathfinder, but a hard
  distance cap would break legitimate cases where the grave is far but
  reachable. `path_stuck` is more precise: it fires only when the
  pathfinder has actually failed, not when the target is merely far.
- **Remove the rule entirely**: the bot genuinely needs to recover gear
  from graves. The 2026-09-05 devlog documents two graves standing
  unopened while the bot starved. The rule is correct; it just needs a
  guard for the unreachable case.
- **Use the existing `unresolved` counter to suppress the rule**: the
  counter already grows backoff (doubles to 200s cap), but that's a
  throttle, not a hard stop. The rule still fires every 200s doing
  futile pathfinding. `path_stuck` is a hard stop: the rule simply
  doesn't fire while the bot can't move.

## Files

`policies/survive_upgrade.json`, `policies/stayin_alive.json`,
`bots/Andy/policy.json`

## Verification

- `node tools/policy_file_check.js` — 7 layers, 0 invalid
- `node --test src/utils/policies_valid.test.js` — 6/6 pass
- `grep path_stuck` confirms the gate in all three files
