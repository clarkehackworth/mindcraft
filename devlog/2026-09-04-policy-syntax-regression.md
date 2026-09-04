# Policy syntax regression: one bad rule silently disabled the entire survival layer

## Problem

Andy spent ~31 h trapped in the cave layer (`(-26,54,82)`) — starving in a
water/coal hole with no tools — after the cave-veto + night-shelter deploy
(`6c1974b`). The read: the two new rules simply never fired, and the rest of his
survival behavior looked thin as well.

Root cause: the new `shelter_at_base_when_night_falls_short` rule was written
with **string-prefix negation**:

```json
{ "cond": "not is_sheltered" }
{ "cond": "not far_from_home", "range": 16 }
```

In this policy language `not` is an **object combinator**, not a condition
prefix:

```json
{ "not": { "cond": "is_sheltered" } }
{ "not": { "cond": "far_from_home", "range": 16 } }
```

`validatePolicy` rejected the rule as `unknown condition "not is_sheltered"` —
and the validator treats **any invalid rule as invalidating the whole layer**.
So at load, Andy's entire active layer (80 rules: arming, the unbreakable gate,
flee, shelter, the cave-veto interplay) was silently discarded. No crash, no
error on screen, no restart — just a bot that could no longer survive. The
log showed `Loaded saved policy` and looked healthy.

This is exactly the failure mode AGENTS.md warns about: nothing in the load
path may throw, so the validator degrades by discarding — and a *silent*
discard of the whole layer is the worst possible shape of degradation.

## Change

1. **`bots/Andy/policy.json`** — the two conditions on
   `shelter_at_base_when_night_falls_short` converted to object-form `not`.
   Re-validated: 80/80 rules valid.
2. **`tools/policy_file_check.js`** (new) — validates **every policy the agent
can actually load** against the same `validatePolicy` the agent runs at
   startup: all live `bots/*/policy.json` layers **and** all `policies/*.json`
   base policies, plus a belt-and-braces walk naming any condition the
   `CONDITIONS` table does not know. Exit non-zero on any invalid layer.
   Run: `node tools/policy_file_check.js`. Result: **7 layers, 0 invalid**.
3. **`.backup/Andy-policy-2026-09-04-pre-syntax-fix.json`** — pre-fix snapshot.

## Why the check covers base policies too

`tools/live_*.sh regen <base>` rebuilds a live active layer **from a base
policy**. A bad rule in `policies/*.json` would reappear on the next regen
even after the live file is fixed, and would re-discard the whole layer.
Validating only the live file would make the guard one-shot; validating both
makes it durable. All 5 base policies are currently clean.

## Decisions / options rejected

- **Extend the language to accept `"cond": "not <x>"`** — rejected. The
  validator is the contract; making it accept a prefix form that the rest of
  the language does not use would let two syntaxes mean one thing and paper
  over the mistake. The policy file should conform to the language, not the
  other way around. The permanent check now fails a deploy-able file with a
  named line instead of letting it ship.
- **Make the validator warn-and-continue on one bad rule** — rejected.
  Dropping just the bad rule would be a more survivable failure mode than
  discarding the layer, but it would also let a typo'd rule sit dead for days
  while everything else looked fine. The discard is the safer *runtime*
  behavior; the check is the correct *process* fix. (If the discard behavior
  itself is ever reconsidered, it should log at a level that cannot be missed —
  not silently.)
- **Catch this at deploy time in the live helper** — partially done: the
  helper already `node --check`s JS files. The policy file is JSON consumed by
  the agent, so the check lives as a standalone gate that a deploy step (or a
  human) runs against the same file that ships. Keeping it a plain node script
  means it runs anywhere, no framework.

## Verification

- `node tools/policy_file_check.js` → `PASS: 7 layer(s), 0 invalid` (Andy
  active 80, Andy self 0, 5 base policies).
- Ad-hoc layer validator → `Bad rules total: 0` (was 1).
- Deploy via `tools/live_*.sh deploy bots/Andy/policy.json`, restart sent.
- Post-restart log: `Loaded saved policy for Andy`; `EVT
  rule:fire:active:shelter_at_base_when_night_falls_short` **fired** — it
could not have fired before the fix (the layer was discarded).
- Bot alive: `Pos (-30.6, 58, 83.6)`, `Health 24.0f`, container Up 32 h,
  0 `Uncaught`/`FATAL`.
- `origin/stable` untouched.

## Open question for the next window

The cave-veto and night-shelter shipped in `6c1974b` were **never actually
live** because of this regression — the layer carrying them was discarded. So
the observation window for those two fixes effectively **restarts with this
deploy**. Watch: cave-layer descents while tool-less (starvation class), and
nightfall position inside the enclosure vs. the `z=75–79` band (zombie class).
