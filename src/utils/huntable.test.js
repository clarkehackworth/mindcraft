// Run: node src/utils/huntable.test.js
// isHuntable listed seven vanilla animals by name -- chicken, cow, llama,
// mooshroom, pig, rabbit, sheep -- and not one of them lives in a Frozen Pine
// Taiga. Andy sat there at 13/60 health owning a single crafting table, firing
// search_out_game every few minutes for "Could not find any sheep in 128
// blocks", with 126 entities inside that radius. Regeneration needs 18 food and
// he had 9, so the injury was permanent and nothing on the menu existed.
import assert from 'assert';
import { isHuntable } from './mcdata.js';

const mob = (name, type = 'animal', extra = {}) => ({ name, type, metadata: [], ...extra });

// The vanilla seven still qualify.
for (const n of ['chicken', 'cow', 'llama', 'mooshroom', 'pig', 'rabbit', 'sheep'])
    assert.equal(isHuntable(mob(n)), true, `${n} is still food`);

// And so does anything else the registry calls an animal, which is how a mod
// pack's own livestock becomes visible without naming any of it here.
for (const n of ['fox', 'goat', 'ru_deer', 'some_modded_boar'])
    assert.equal(isHuntable(mob(n)), true, `${n} is an animal and therefore food`);

// Not everything passive is dinner.
assert.equal(isHuntable(mob('bat', 'ambient')), false, 'bats are ambient, not animals');
assert.equal(isHuntable(mob('cod', 'water_creature')), false, 'fish need fishing, not punching');
assert.equal(isHuntable(mob('zombie', 'hostile')), false, 'hostiles are not livestock');

// The two that hunt back stay off the menu: wolves come in packs and a polar
// bear is worth about half the bot's health.
assert.equal(isHuntable(mob('wolf')), false);
assert.equal(isHuntable(mob('polar_bear')), false);

// Babies are not food.
const calf = mob('cow'); calf.metadata[16] = true;
assert.equal(isHuntable(calf), false, 'metadata 16 is the baby flag');

// And nothing blows up on junk.
assert.equal(isHuntable(null), false);
assert.equal(isHuntable({}), false);
assert.equal(isHuntable({ name: 'cow' }), false, 'no type is not an animal');

console.log('ok: the menu is whatever the registry calls an animal');
