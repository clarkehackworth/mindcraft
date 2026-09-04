# 2026-09-04 — East-ring waterbox widen (A+B as geometry)

## Problem

Two recent drownings and one stuck-waterline episode all occurred **east of the
original death-pocket box** (`xMax = -15`), where the box priced nothing:

| Event | Position | In old box? |
|---|---|---|
| Drown | `(-7.9, 58.2, 93.3)` | **No** — 7 blocks east of `xMax=-15` |
| Stuck (oxygen 0, rescued) | `(-11.7, 60.2, 91.8)` | **No** — 3.3 blocks east of `xMax=-15`, y just above `yMax=60` |
| In-box drown (prior window) | `(-42.5, 57.0, 70.5)` | Yes — inside, but the 99 wasn't enough against the goal pull (known unshipped follow-up) |

The 2026-09-03 in-box drowning was attributed to the 99 being beatable by a
goal pull for a tool-less bot; the 2026-09-04 cave-veto commit (6c1974b)
escalated that to the 100 unbreakable wall for tool-less bots. The east-ring
drownings were a different failure: the box simply did not cover the water
ring's eastern extent, so the pricing never applied at all.

## Change

**`src/utils/water_aware_path.js`** — widened `DEATH_POCKET_BOX`:

| Axis | Before | After | Reason |
|---|---|---|---|
| `xMax` | -15 | **-5** | Covers both east-ring points (`-7.9`, `-11.7`) with ~2 blocks of margin. Keeps the Base column at `x=-29` cheap. |
| `yMax` | 60 | **61** | Covers the stuck waterline at `y=60.2`. The Base's standing ground is `y=62` (surface `y=63`), which stays outside the box. |

All other bounds (`xMin=-45, yMin=48, zMin=60, zMax=118`) unchanged — they
already cover every documented death.

**`water_aware_path.test.js`** — added assertions for the east-ring points
inside the box, the `x=-14` boundary, the `y=61` waterline inside, and the
Base's `y=62` standing ground outside.

## Key finding: B was already shipped

The "do both" approval asked for (A) widen the box and (B) price cave-layer
air, not just water. Reading the code before touching anything revealed that
**B is already in place since 6c1974b**: `waterCost` prices by *position*
(`inDeathPocket(pos) → DEATH_WATER_COST`), not by whether the block is water.
The test at line 212 proves it: `tool-less: the pocket is an unbreakable wall,
even on air`. So this change is pure geometry (A), not two separate
mechanisms. The devlog is honest about that rather than reimplementing dead
code.
## Options rejected

- **Minimal box (xMax=-8, yMax=60.2)** — no margin; the next documented
drowning 1.9 blocks further east would be outside again. The 2-block margin
on each side costs nothing (the box is a soft 99/100 price, not a hard wall,
and the Base column is unaffected).
- **Price air separately from water** — already done by the position-based
pricing; a separate air cost would double-count and risk pushing a
traversable block over the 100 cap.
- **Widen the z bounds** — all documented z values are within `60..118`;
no evidence of a z-direction gap.

## Verified

| Check | Result |
|---|---|
| `node water_aware_path.test.js` | 4 suites, 0 fail |
| Container deploy | `xMax: -5, yMax: 61` confirmed in `/app/src/utils/water_aware_path.js` |
| Bot liveness post-deploy | `(-50.4, 63.0, 67.4)`, Health `24.0f` |
| Survival layer firing | `rule:fire:active:keep_out_of_water` in post-restart log |
| `Uncaught` / `FATAL` | 0 |

## Observation window (starts now)

| Metric | What it validates | Success |
|---|---|---|
| East-ring descents (`x > -15`, `y ≤ 61`) | widened box | 0 — the 100 wall / 99 price covers the full ring |
| In-box drownings | 99/100 pricing | 0 |
| Nightfall position | shelter rule (already verified) | inside the enclosure |
