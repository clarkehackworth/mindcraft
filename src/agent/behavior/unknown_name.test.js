// Run: node --test src/agent/behavior/unknown_name.test.js
// A rule that names something this world has never heard of does not error --
// it silently never matches, which is far worse than failing. Two of those in
// one session, both of which looked completely correct in review:
//   has_item "sword"                 -> not a family, so it stayed "sword" and
//                                       matched no item on earth
//   entity "entity.frostiful.chillager" -> the translation key, not the entity id
// Neither had ever fired. This is the one class of mistake the validator can
// only catch by looking names up.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { validatePolicy, CONDITIONS } from './policy.js';
import { useRegistry } from '../../utils/mcdata.js';

const registry = {
    itemsByName: { stone_sword: {}, bread: {}, stick: {} },
    blocksByName: { oak_log: {}, oak_planks: {}, chest: {}, water: {} },
};

// The action is incidental here -- this file is about names -- but it cannot be
// say-only any more: a rule that only talks is rejected on its own merits, and
// that error would mask the name error these tests are checking for.
const rule = (extra) => ({
    rules: [{ name: 'r', description: 'd', when: { cond: 'always' }, do: [{ act: 'go_to_surface' }], ...extra }],
});

test('a name the registry does not know is rejected, with the reason', () => {
    useRegistry(registry);
    const err = validatePolicy(rule({ when: { cond: 'has_item', item: 'sword' } }));
    assert.ok(err, 'the exact mistake that shipped twice');
    assert.match(err, /does not exist in this world/);
    assert.match(err, /"sword" is not a family name/, 'and says what to write instead');
});

test('it looks inside nested conditions and action steps', () => {
    useRegistry(registry);
    assert.ok(validatePolicy(rule({
        when: { all: [{ cond: 'always' }, { not: { cond: 'block_nearby', name: 'mithril_ore' } }] },
    })), 'nested and negated still checked');
    assert.ok(validatePolicy(rule({
        do: [{ act: 'craft', item: 'lightsaber' }],
    })), 'action args too');
});

test('real names, families and "weapon" all pass', () => {
    useRegistry(registry);
    for (const when of [
        { cond: 'has_item', item: 'weapon' },       // a family this module defines
        { cond: 'has_item', item: 'stone_sword' },  // exact
        { cond: 'block_nearby', name: 'log' },      // wood family -> oak_log
        { cond: 'block_nearby', name: 'planks' },
    ]) assert.equal(validatePolicy(rule({ when })), null, JSON.stringify(when));
    assert.equal(validatePolicy(rule({ do: [{ act: 'craft', item: 'bread' }] })), null);
});

test('with no registry loaded it stays out of the way', () => {
    // Validation runs before login and throughout the tests; refusing every
    // name because there is nothing to check against would be worse than the
    // bug. Permissive when it cannot know.
    useRegistry(null);
    assert.equal(validatePolicy(rule({ when: { cond: 'has_item', item: 'anything_at_all' } })), null);
});

test('at_death_position reads the place the death handler already saved', () => {
    const agent = (place, dist) => ({
        memory_bank: { recallPlace: () => place },
        bot: { entity: { position: { distanceTo: () => dist } } },
    });
    assert.equal(CONDITIONS.at_death_position.fn(agent([10, 64, 10], 3), {}), true);
    assert.equal(CONDITIONS.at_death_position.fn(agent([10, 64, 10], 40), {}), false);
    // Before the first death there is no place to be near, and the old
    // at_position 0,0,0 placeholder was true at the world origin instead.
    assert.equal(CONDITIONS.at_death_position.fn(agent(null, 0), {}), false, 'never died');
});
