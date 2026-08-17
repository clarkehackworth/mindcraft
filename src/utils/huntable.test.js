// Run: node src/utils/huntable.test.js
// isHuntable listed seven vanilla animals by name -- chicken, cow, llama,
// mooshroom, pig, rabbit, sheep -- and not one of them lives in a Frozen Pine
// Taiga. Andy sat there at 13/60 health owning a single crafting table, firing
// search_out_game every few minutes for "Could not find any sheep in 128
// blocks", with 126 entities inside that radius. Regeneration needs 18 food and
// he had 9, so the injury was permanent and nothing on the menu existed.
import assert from 'assert';
import { isHuntable, dropsFood } from './mcdata.js';

const mob = (name, type = 'animal', extra = {}) => ({ name, type, metadata: [], ...extra });

// The vanilla seven still qualify.
for (const n of ['chicken', 'cow', 'llama', 'mooshroom', 'pig', 'rabbit', 'sheep'])
    assert.equal(isHuntable(mob(n)), true, `${n} is still food`);

// A mod pack's own livestock has no loot entry at all, and stays huntable --
// guessing "yes" for an unknown animal is the whole point of the change, and
// guessing "no" puts the bot back to starving in a biome full of animals it
// refuses to look at.
for (const n of ['ru_deer', 'some_modded_boar'])
    assert.equal(isHuntable(mob(n)), true, `${n} is unknown to the registry, so worth a try`);

// But "is an animal" is not "is dinner". Dropping the vanilla seven lost that:
// a starving bot at food 6 and falling spent a window hunting cats, which drop
// string. entityLoot knows exactly, so it gets asked.
// The judgement itself, against the real drop tables. isHuntable reads a
// registry these tests do not have -- which is also why the vanilla-seven
// assertions above pass on structure rather than on loot -- so the decision is
// split out and checked directly.
const FOODS = { beef: 1, chicken: 1, rabbit: 1, mutton: 1, porkchop: 1 };
const loot = (...items) => ({ drops: items.map(item => ({ item })) });

assert.equal(dropsFood(loot('leather', 'beef'), FOODS), true, 'a cow is dinner');
assert.equal(dropsFood(loot('feather', 'chicken'), FOODS), true, 'so is a chicken');
assert.equal(dropsFood(loot('string'), FOODS), false, 'a cat drops string');
assert.equal(dropsFood(loot(), FOODS), false, 'a fox drops nothing at all');
assert.equal(dropsFood(loot('leather'), FOODS), false, 'a horse is not lunch');
assert.equal(dropsFood(undefined, FOODS), true, 'an animal the registry never heard of is worth a try');

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

// And a rule has to be able to ask for "meat" without naming the species. The
// hunting MODE could already see any animal, at range 8, when idle -- but no
// action exposed it, so every food rule had to guess the local fauna and every
// one of them guessed a temperate biome.
{
    const { ACTIONS } = await import('../agent/behavior/policy.js');
    assert.ok(ACTIONS.hunt, 'hunt is an action a rule can name');
    assert.equal(ACTIONS.hunt.cost, 'blocking', 'it walks to the animal and fights it');
    assert.ok(ACTIONS.hunt.clears.includes('has_food'),
        'succeeding is what stops the rule firing again');
    assert.doesNotMatch(ACTIONS.hunt.desc, /rabbit|sheep|cow\b/,
        'the description must not teach a model to think in species again');
}

console.log('ok: a rule can ask for meat without naming the animal');
