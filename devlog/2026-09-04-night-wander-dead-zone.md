# Night-wander dead zone: shelter widen + no-wander stay

Date: 2026-09-04
Bot: Andy (clarke_hackworth)
Branch: `develop` → `feat/mindserver-bind-auth` (origin/stable untouched)

## Problem

At the 20:04 CDT check-in the bot was **35 blocks west of the Base, at night, with
no weapon, no food, no tools — just dirt.** Eight deaths in the prior three hours,
including a Drowned death *inside* the widened water box at 17:50 and a Skeleton
dead ~50 blocks east at 17:48.

The survival layer was firing hard (4,277 `flee_ranged_raiders`, 2,671
`give_up_on_a_stuck_path`, 2,560 `keep_out_of_water` in two hours) — yet he kept
dying. The cause was not a missing rule. It was a **dead zone between two rules
that each only saw half the picture:**

| Rule | Fires when | What it does |
|------|-----------|--------------|
| `head_home_before_dark` | distance **> 48** | `goto home` (closeness 8) — **no `stay`** |
| `shelter_at_base_when_night_falls_short` | distance **< 16** | `goto home` (closeness 1) + `stay until not is_night` |

A bot at **35 blocks** — exactly where he was found — was inside **neither** range.
`head_home` only reached out past 48, and even then it *pulled him back but never
held him*: no `stay`, so he arrived and wandered straight back into the graveyard
ring. `shelter` only reached in to 16, so it never fired for the 16–48 band. The
dead zone (16, 48] is where a bot can be at night with **no rule telling it to go
home and stay.** That is the ×2 zombie / phantom / skeleton death class.

## Change

Two edits to the live active layer (`bots/Andy/policy.json`), 80 → 81 rules:

| Edit | What | Closes |
|------|------|--------|
| **A — widen `shelter_at_base` far_from_home 16 → 48** | `shelter_at_base_when_night_falls_short` now fires at distance < 48 (was < 16). It already carries the `stay`, so the 16–48 band now gets *go home and hold*. | (16, 48] |
| **B — new `night_no_wander` rule** | `is_night` + `not is_sheltered` + `far_from_home 16` → `goto home` (closeness 1) + `stay until not is_night 1500`. The explicit *"no wandering at night"* hold — the `stay` that `head_home_before_dark` lacks. | the far band (≥16), and the >48 band that `head_home` used to leave wandering |

After the change, **every distance band at night is covered by a rule that carries
a `stay`:** <16 → shelter (and now night_no_wander), 16–48 → shelter (widened),
>48 → head_home (pull) *plus* night_no_wander (the stay). No distance left with
"pull but no hold."

## Why these two (and what was rejected)

- **Rejected: widen `head_home_before_dark` and add a `stay` to it.** Cleaner in
  principle, but `head_home` is a *pre-dark* pull (lead 4000, closeness 8 — it
  wants you home *before* dark, not *held* at dark). Conflating a soft pre-dark
  pull with a hard night hold in one rule would change two behaviors at once. Keeping
  the hold in a dedicated `night_no_wander` rule means the window stays attributable:
  if he still wanders, it's the hold, not the pull.
- **Rejected: shrink `shelter` to only <16 and add a separate 16–48 rule.** Three
  rules for one job (shelter-near, shelter-mid, no-wander-far) instead of two.
  Widening the existing `shelter` (which already has the right `do`) is less surface
  to get wrong than authoring a third rule.
- **Rejected: a distance-0 "always at home at night" rule.** It would forbid
  legitimate night movement (a raid, a food run) and fights the other pinned rules.
  `night_no_wander` only fires when *far* from home, so it never blocks a bot that
  is already at the Base.

## Verification

| Check | Result |
|-------|--------|
| `node tools/policy_file_check.js` (authoritative guard, the one that caught the 2026-09-04 syntax regression) | **PASS: 7 layer(s), 0 invalid**; `ok Andy/active: 81 rules valid` |
| `node --test src/utils/policies_valid.test.js` | pass 6, fail 0 |
| `node tools/policy_check.js` | all assertions passed |
| Local file | 80 → 81 rules; `shelter` far_from_home range 48 (inside its `not`); `night_no_wander` inserted after `shelter` |
| **Live running agent** (socket `policy` dump, not disk) | `night_no_wander present: True`; `shelter far_from_home range: 48` — the new layer is actually loaded, not just on disk |
| Bot | Alive, `(-28.5, 63.1, 89.5)` at the Base, Health 23.7/24, daytime |

Pre-edit snapshot: `.backup/Andy-policy-2026-09-04-pre-shelter-widen.json`.

## Observation window (starts at the next nightfall)

| Metric | Before | Success looks like |
|--------|--------|--------------------|
| Night position | 35 blocks west, roofless, empty-handed | at the Base, roofed, **held** |
| `shelter_at_base` / `night_no_wander` fires | 0 (shelter) / n/a (rule absent) | firing at nightfall, holding him |
| Night zombie / phantom / skeleton deaths | the ×2 class | 0 |
| Drownings (separate class, widened box 2026-09-04) | 1 in-box + east ring | 0 |

The 17:50 in-box Drowned death is a **separate, still-open** class: the widened box
prices the pocket but does not stop a bot already in the water or falling from
cave air. Tracked in `devlog/2026-09-04-east-ring-waterbox-widen.md`; not addressed
here so this window stays attributable to the night-wander fix alone.
