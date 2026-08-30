// Run: node src/utils/boss_tier.test.js
//
// A mod pack files its boss-class mounts as ordinary animals. mythicmounts:dragon
// is category 'creature' -> registry type 'animal', attackable, 3.625 x 3.6875.
// So isHostile is blind to it and the 'animal' check in isHuntable would let it
// through: without a boss gate the hunting mode charges a dragon for a meal and
// trades a hit with something that can kill the bot at any gear level. The only
// server-sent "this is a boss" signal is collision size, so isBossTier is a size
// test, not a name list (a name list is the anti-pattern this file documents
// twice, RANGED_HOSTILE and FIGHTS_BACK).
//
// The threshold 3.0 is grounded in the real registry: livestock tops out at a
// llama (1.87); the medium mounts (griffon 2.31, gecko 2.38, direwolf 2.69) and
// the enderman (2.9) sit at 2.0-2.9 -- a threat when weak but survivable with
// gear; everything at/above 3.0 is boss-class (dragon 3.69, archelon 3.94,
// adventurez dragon 4.8, ender_dragon 16).
import assert from 'assert';
import { isBossTier, isHuntable } from './mcdata.js';

// A runtime entity carries width/height (mineflayer copies them off the registry
// entityData onto every entity), so the test builds them directly -- no registry.
const mob = (name, type = 'animal', width = 0, height = 0, extra = {}) =>
    ({ name, type, width, height, metadata: [], ...extra });

// The dragon that actually killed Andy: animal-typed, boss-class by size.
assert.equal(isBossTier(mob('dragon', 'animal', 3.625, 3.6875)), true, 'mythicmounts:dragon is boss-tier by size');
// The ender dragon is the ceiling of the scale.
assert.equal(isBossTier(mob('ender_dragon', 'hostile', 16, 8)), true, 'ender_dragon is boss-tier');
// A big boss from another pack, same story.
assert.equal(isBossTier(mob('archelon', 'animal', 3.9375, 3.4375)), true, 'archelon is boss-tier');
assert.equal(isBossTier(mob('dragon', 'animal', 4.8, 3.3)), true, 'adventurez dragon is boss-tier');

// Real livestock is not a boss. The ceiling is the llama.
for (const [n, w, h] of [
    ['chicken', 0.4, 0.7], ['cow', 0.9, 1.4], ['pig', 0.9, 0.9],
    ['sheep', 0.9, 1.3], ['wolf', 0.6, 0.85], ['llama', 0.9, 1.87],
])
    assert.equal(isBossTier(mob(n, 'animal', w, h)), false, `${n} is livestock, not a boss`);

// The medium mounts and the enderman sit at 2.0-2.9. They are a threat when weak
// but survivable with gear, so they must NOT be treated as unkillable bosses --
// the line is deliberately above them, with margin on both sides.
for (const [n, w, h] of [
    ['griffon', 1.4375, 2.3125], ['geckotoalizard', 2.375, 1.75],
    ['direwolf', 1.25, 2.6875], ['enderman', 0.6, 2.9], ['firebird', 1.5, 1.375],
])
    assert.equal(isBossTier(mob(n, 'animal', w, h)), false, `${n} is a medium mount, below the boss line`);

// The test is on max(width, height), so orientation cannot hide a boss.
assert.equal(isBossTier(mob('tall_thin', 'animal', 0.5, 3.1)), true, 'tall and thin is boss-tier by height');
assert.equal(isBossTier(mob('wide_flat', 'animal', 3.1, 0.5)), true, 'wide and flat is boss-tier by width');

// No size is not a boss: a degenerate or unknown entity must not trip the gate,
// and nothing may blow up on junk.
assert.equal(isBossTier(mob('ghost', 'animal', 0, 0)), false, 'no size is not a boss');
assert.equal(isBossTier(null), false, 'null is not a boss');
assert.equal(isBossTier({}), false, 'an empty object is not a boss');

// The consequence that matters: a boss is not dinner, even though it reads as an
// animal -- but the gate must not eat the real menu.
assert.equal(isHuntable(mob('dragon', 'animal', 3.625, 3.6875)), false, 'the dragon is not on the menu');
assert.equal(isHuntable(mob('archelon', 'animal', 3.9375, 3.4375)), false, 'a boss mount is not on the menu');
// In this check mcdata is unset, so an ordinary animal resolves through the
// "unknown animal is worth a try" path and stays huntable.
assert.equal(isHuntable(mob('chicken', 'animal', 0.4, 0.7)), true, 'a chicken is still dinner');
assert.equal(isHuntable(mob('llama', 'animal', 0.9, 1.87)), true, 'a llama is still dinner');

console.log('ok: boss-tier is size, and a boss is not dinner');
