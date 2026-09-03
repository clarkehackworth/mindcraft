#!/usr/bin/env node
// Sentinel for the 2026-09-02 `base` re-pin: the remembered `home`/`base`
// places must be at or near the verified safe Base, or the home-steering
// rules (head_home_before_dark, come_home_when_far, far_from_home) walk the
// bot into a documented death zone at dusk.
//
// All hazard geometry is from the DEVLOGS, not the bot's LLM notes. The notes'
// "Base is at (-2, 63, 64)" / "water zone x-5..15, z80-95" map is garbled
// (see 2026-09-02-home-repin-safe-base.md). Ground truth:
//   - SAFE BASE POCKET = the solidified spawn pocket, `fill -33 56 84 -26 62 93`
//     barrier over the refilling water (2026-08-29 P9) + `spawnpoint
//     clarkhackworth -29 63 89` (2026-08-25). x -33..-26, z 84..93.
//   - ORIGIN PIT = the unclimbable dry-gravel + water death pit of 2026-08-25,
//     roughly x -9..5, z -6..9 (widened below as a safety margin).
//   - GRAVEYARD BAND = the recurring night death cluster (z 84..109), which
//     ENCLOSES the safe Base pocket. A pin inside the band is only legal if it
//     is inside the safe pocket — everything else in the band is a documented
//     death spot (revenant/melee deaths at z 91-109).
//
// What the sentinel catches: a home/base that regresses to the origin pit,
// drops below surface level into the cave/pit layer, or lands in the graveyard
// band outside the solidified pocket. It does NOT vouch for unverified
// locations — a pin at a spot no devlog documents will pass (that's a
// geography question, not a sentinel question).
//
// Usage: node tools/home_place_check.js /path/to/memory.json
// Exit 0 = remembered home/base places are safe, exit 1 = a place is in a
// documented death zone (or the file has no home/base places).

import fs from 'fs';

const SURFACE_Y = 58; // below this is the pit/cave death layer (y 51-58)
const ORIGIN_PIT = { x0: -10, x1: 6, z0: -9, z1: 16 };
const SAFE_BASE_POCKET = { x0: -33, x1: -26, z0: 84, z1: 93 };
const GRAVEYARD_BAND = { x0: -45, x1: 0, z0: 84, z1: 109 };

function inBox(x, z, b) {
  return x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1;
}

function check(name, p) {
  if (!Array.isArray(p) || p.length !== 3 || p.some(v => !Number.isFinite(v))) {
    throw new Error(`${name}: expected [x, y, z] finite numbers, got ${JSON.stringify(p)}`);
  }
  const [x, y, z] = p;
  if (y < SURFACE_Y) {
    throw new Error(`${name} ${JSON.stringify(p)} is below surface level y=${SURFACE_Y} (pit/cave death layer)`);
  }
  if (inBox(x, z, ORIGIN_PIT)) {
    throw new Error(`${name} ${JSON.stringify(p)} is inside the origin pit ${JSON.stringify(ORIGIN_PIT)}`);
  }
  if (inBox(x, z, GRAVEYARD_BAND) && !inBox(x, z, SAFE_BASE_POCKET)) {
    throw new Error(`${name} ${JSON.stringify(p)} is in the graveyard band ${JSON.stringify(GRAVEYARD_BAND)} but outside the safe Base pocket ${JSON.stringify(SAFE_BASE_POCKET)}`);
  }
  console.log(`ok: ${name} = ${JSON.stringify(p)}`);
}

const fp = process.argv[2];
if (!fp) {
  console.error('usage: node tools/home_place_check.js /path/to/memory.json');
  process.exit(2);
}
const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
let checked = 0;
for (const name of ['home', 'base']) {
  if (d.places && d.places[name]) {
    check(name, d.places[name]);
    checked++;
  }
}
if (checked === 0) throw new Error('no home/base places found in ' + fp);
console.log('home_place_check: PASS');
