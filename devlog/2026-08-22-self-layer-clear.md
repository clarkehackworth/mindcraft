# Self-layer clear unblocks the deep gear ladder

**Status:** shipped (live policy change, verified)
**Date:** 2026-08-22

## Problem

After the 2026-08-18 gear/mining activation, Andy's **self** layer had
re-learned 8 entries: five water variants, an Iceologer lesson, a night-outdoors
lesson, and — the active problem — a `never dig below y=10` rule.

The self layer outranks the active layer, so that single self rule vetoed the
new deep iron/diamond mining rules in the active policy. Combined with the
08-22 Docker host reboot (which dropped Andy to the bottom of the gear ladder —
live inventory was a single `peat_dirt`), he was stuck at stone with no path to
iron or diamond.

## Change

Ran the RUNBOOK-sanctioned fast unblock:

```bash
tools/live_*.sh clearlayer self
```

which sends `set-policy { layers: { self: null } }` and deletes the whole self
layer.

Verified by diffing the live policy file (`/app/bots/Andy/policy.json`), pulled
via `docker cp` before and after:

| | before (21:48) | after (mtime 21:52:04) |
|---|---|---|
| self layer | dict, 3 keys | **gone** (no `self` key) |
| active rules | 78 | 78 (unchanged) |
| `y=10` self veto | x3 | x0 |
| `Iceologer` self rule | x1 | x0 |

A 90s `rule:fire` sample after the clear shows the deep ladder firing live:
`mine_coal_ore`, `keep_stone_stocked`, plus the night-home rules.

## Safety gate (why this is safe)

Before clearing, confirmed in both the local base file and the live active
layer that the protection the self layer was "providing" already exists in the
active layer:

- Water: `surface_when_drowning`, `keep_out_of_water`, 3x `go_to_surface`.
- Cold: `dig_in_out_of_the_cold`.
- Night: `dig_in_for_the_night`, `wait_out_the_night_under_cover`.

So clearing the self layer did not strip the only drowning defense (the #1
killer) and did not remove any rule the active layer lacks. The 8 self entries
were all redundant with active, except the `y=10` veto, which is the one we
wanted gone.

## Options rejected

1. **Regenerate the policy** to drop the self layer — rejected. LLM multi-profile
   regen dies with `Context length exceeded`; the deterministic no-attribute copy
   path (RUNBOOK §5.2) is a heavyweight, slow merge when a one-line self clear
   achieves the same unblock.
2. **Surgically delete only the `y=10` rule**, keep the other 7 — rejected. The
   7 are redundant with active, so keeping them buys nothing while retaining
   self-layer veto power over active.
3. **Wait for the self layer to age out** — rejected. Self outranks active, so
   the deep-mining rules stay dead indefinitely.

## Reversibility

Pre-clear backup: `.backup/Andy-policy-2026-08-22-pre-clearlayer.json`. Restore
with `docker cp` + `set-policy` if the unblock misbehaves.

## Open

Drowning is still the #1 killer (28/36 in the pre-clear 24h). Watch the next
24-48h: if it persists after the unblock, that points at a policy gap or code
bug (RUNBOOK §7: reproduce → change → leave a `*.test.js` → deploy → verify
zero Uncaught/FATAL), not the self layer.
