# 2026-08-30 — Boss-tier mobs are not dinner, and you flee them

## Problem

Andy died to a `mythicmounts:dragon` while armed and near the surface. The
root cause was classification, not combat: the pack files its boss-class
mounts as ordinary **animals**. So `mythicmounts:dragon` is
`category: 'creature'` -> registry type `animal`, attackable, and
**3.625 x 3.6875**. That means:

- `isHostile()` is **blind** to it (it reads as an animal, not a hostile), so the
  cowardice reflex never fired.
- `isHuntable()` treated it as dinner, so **hunting mode would charge a dragon
  for a meal** — trading a hit with something that can kill the bot at any gear
  level.

A boss is the one threat that cannot be out-gear'd. The whole point is to never
be in a fight with one in the first place.

## Change

The only server-sent "this is a boss" signal is **collision size** (a name list
is the anti-pattern this codebase documents twice, in `RANGED_HOSTILE` and
`FIGHTS_BACK`), so `isBossTier` is a size predicate on `max(width, height)`,
threshold **3.0**:

- **`src/utils/mcdata.js`** — new `isBossTier(mob)`. Returns true when
  `max(width, height) >= 3.0`. Guarded on null / missing size (a degenerate
  entity is not a boss). Threshold grounded in the real registry: livestock tops
  out at a llama (1.87); the medium mounts (griffon 2.31, gecko 2.38, direwolf
  2.69) and enderman (2.9) sit at 2.0–2.9 — a threat when weak but survivable
  with gear; everything at/above 3.0 is boss-class (dragon 3.69, archelon 3.94,
  adventurez dragon 4.8, ender_dragon 16).
- **`src/utils/mcdata.js`** — `isHuntable()` now returns **false** for
  boss-tier mobs before it would let a boss through as an animal. A dragon is
  never on the menu, but the gate does not eat the real one.
- **`src/agent/modes.js`** — the `cowardice` reflex now flees
  `isHostile(entity) || isBossTier(entity)`. This reuses the built-in reflex the
  policy validator already endorses, so there is **no new policy rule** and no
  retreat-loop trip. A boss is fled from exactly like a hostile.
- **`src/agent/library/skills.js`** — `avoidEnemies` no longer trades a reflex
  swing at a boss-tier mob within 3 blocks. Fleeing is the whole point; a swing
  is the one thing a boss could still collect while the bot is running.

## Rejected options

- **Fold `isBossTier` into `isHostile`.** Rejected: that would make
  `self_defense` **attack** the dragon. The correct behaviour is to flee and
  never target it, so it stays a separate predicate and is wired only into the
  flee/not-huntable paths.
- **A name list of boss mobs.** Rejected: the anti-pattern this file already
  documents twice. A size predicate catches every boss-class mount the pack
  ships (and any future one), not just the ones we happened to name.
- **A policy rule to flee dragons.** Rejected: it would be another entry in the
  policy storm and could trip the retreat-loop guard. The built-in cowardice
  reflex already does exactly this; extending its predicate is one line and is
  what the validator endorses.

## Verification

- **New** `src/utils/boss_tier.test.js` — 12 assertions:
  the real dragon (3.625 x 3.6875) and ender/archelon/adventurez dragons are
  boss-tier; all six livestock (chicken..llama) and the 2.0–2.9 medium mounts
  and enderman are **not**; the threshold is on `max(w,h)` (tall-thin and
  wide-flat both trip it); no-size/null/empty are not boss-tier; the dragon and
  a boss mount are **not** huntable while a chicken and a llama **are**.
  Green.
- Regression checks still green: `huntable.test.js`,
  `oxygen_scope.test.js`.
- `node --check` clean on `mcdata.js`, `modes.js`, `skills.js`, and the check.
- Deployed the three runtime files (`mcdata.js`, `modes.js`, `skills.js`) to the
  live container; clean restart, no `SyntaxError`/throw on the new code.
- Live rcon after restart: `Pos [61.5, 62.0, -38.3]`, `Health 24.0f` — alive,
  full health, sheltering (night in-world) per policy.

## Open

- The `(5, 56, -6)` pocket world fill remains a separate P9-style task (this
  change is a policy/sensor guard, not a world fix).
- Next check-in: confirm the armed loop holds and that a boss encounter now
  produces a flee rather than a charge.