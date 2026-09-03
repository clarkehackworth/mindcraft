# Re-pin `base` to the verified Base + home-place sentinel

## Problem

A 12-hour check-in showed 40+ deaths clustered around `z 84–109` —
including the solidified Base spawn pocket `(-29, 63, 89)` itself.
The bot's LLM notes (auto-regenerated, not hand-authored) described a
"safe Base at `(-2, 63, 64)`" and a "water zone `x -5..15, z 80–95`"
— a garbled map that does not match the verified geography from the
devlogs.

Two remembered places were in play:

| Place | Value found | Verified truth |
|-------|------------|----------------|
| `home` | `[-29.7, 63, 89.4]` | **Already correct** — the solidified Base spawn pocket (`spawnpoint clarkhackworth -29 63 89` + barrier fill, 2026-08-25 / 2026-08-29) |
| `base` | `[-49.4, 63, 61.4]` | **Poisoned** — a dead spot west of the Base, never verified |

The LLM notes' "Base at `(-2, 63, 64)`" is a third location that
matches no devlog, no `tp` target, and no `spawnpoint`. The compact
memory string is LLM-regenerated on every batch and cannot be
hand-edited durably.

## Change

- **`memory.json` re-pin (container state, `mindcraft` container):**
  `base → [-29, 63, 89]` (the verified Base); `home` normalized from
  `[-29.7, 63, 89.4]` to `[-29, 63, 89]` (same location, integer coords).
  Done with the agent stopped (`docker cp` out → JSON-safe edit →
  `docker cp` back), backup at `memory.json.bak-prehomefix-20260903`.
  Notes and compact memory untouched.
- **`tools/home_place_check.js`:** assert-based sentinel — fails if a
  remembered `home`/`base` place is below surface level (y < 58),
  inside the origin pit (`x -10..6, z -9..16`), or inside the graveyard
  death band (`x -45..0, z 84..109`) *outside* the solidified safe Base
  pocket (`x -33..-26, z 84..93`). Run against any bot `memory.json`.
- **No policy change.** The night stack (`head_home_before_dark` →
  `sleep_at_night` / `dig_in_for_the_night` / `wait_out_the_night_under_cover`)
  was verified present and ON in the live policy. The Base is a roofless
  open structure in a mob-heavy zone — the night deaths at the Base are
  a shelter-building problem, not a steering problem.

## Decisions

- **Rejected: re-pinning `home` to `(-2, 63, 64)`** (the initial attempt
  this session). The LLM notes described that location as "the safe
  Base," but the devlogs (2026-08-25 pit-respawn, 2026-08-29 P9) prove
  the real Base is `(-29, 63, 89)` — the `tp` target, the per-player
  `spawnpoint`, and the barrier-solidified spawn pocket all agree. The
  notes are LLM-regenerated and had already diverged from the verified
  `places.home`. Caught by cross-checking against the devlogs before the
  commit; reverted in the same session.
- **Rejected: graveyard no-go box south of z=75** (originally approved).
The Base at `z=89` is *inside* the death band — a box at `z≥75` would
fence out the bot's own home. The band is where the Base *is*, not a
zone to avoid; the sentinel encodes the band-minus-pocket instead.
- **Rejected: revenant-specific boss-flee rule.** The `revenant` entity
name was never verified (zero log hits; deaths are generic
`death.attack.mob`). The size-based boss-tier reflex (≥ 3.0) already
fires for boss mobs. The night deaths at the Base are a shelter problem,
not a flee problem.
- **Rejected: "airtight the house at night" rule.** There is no house:
no bed, inventory one spruce plank, plan step 6 ("build bed/shelter")
unchecked. Nothing to airtight.
- **Rejected: editing the notes array.** The notes are correct about
the hazards (water pockets, graveyard band) but garbled about the Base
location. The compact memory string is LLM-regenerated and would not
keep an edit. The stale datum was the `base` *place*, not the prose.
- **Sentinel scope: documented hazards only.** A pin at a spot no
devlog documents (e.g. `(-2, 63, 64)`) *passes* the sentinel —
knowing a place is safe is a geography question, not an assertion
question. The sentinel's job is to catch regressions to the three
documented death zones.

## Verification

- Round-trip after copy-back: `home=[-29,63,89]`, `base=[-29,63,89]`,
  8 notes intact, JSON valid.
- `node tools/home_place_check.js` against four cases:
  - verified Base `[-29.7,63,89.4]` / `[-29,63,89]` → **PASS**
  - revenant death `[-25,60,105]` → **FAIL** (graveyard band, outside pocket)
  - origin pit `[-5,52,3]` → **FAIL** (below surface level)
  - cave layer `[-29,55,89]` → **FAIL** (below surface level)
- Sentinel run against the **live** container `memory.json` after the
  re-pin → PASS (see check-in of record).
- Agent container `Up` after the window; next observation is the first
  full night at the Base with the corrected `base` place (watch: does
  he arrive at `(-29, 89)` at dusk and sleep/dig there; do graveyard
  deaths *outside* the Base stop).
