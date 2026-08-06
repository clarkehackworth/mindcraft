// Run: node src/agent/library/consume_any.test.js
// consume() took an optional item name, but the `if (itemName)` branch had no
// else -- so calling it with no argument could only ever log "You do not have
// any undefined to eat". That made a single eat_when_hungry policy rule
// impossible: it would have needed one rule per food in the game.
import assert from 'assert';
import prismarine_registry from 'prismarine-registry';
import * as skills from './skills.js';

const registry = prismarine_registry('1.20.1');
const id = (name) => registry.itemsByName[name].id;

function fakeBot(item_names) {
    const items = item_names.map(n => ({ name: n, type: id(n) }));
    return {
        registry,
        output: '',
        eaten: null,
        entity: { position: { x: 0, y: 0, z: 0 } },
        inventory: {
            items: () => items,
            findInventoryItem: (n) => items.find(i => i.name === n),
        },
        equip: async function (item) { this.eaten = item.name; },
        consume: async () => {},
        emit: () => {},
    };
}

// No name given: find the food and eat it, ignoring the cobblestone and the pick.
const stocked = fakeBot(['cobblestone', 'iron_pickaxe', 'cooked_beef']);
assert.equal(await skills.consume(stocked), true);
assert.equal(stocked.eaten, 'cooked_beef', 'eat whatever food is in the bag');

// A named item still wins, even when other food is present.
const picky = fakeBot(['cooked_beef', 'bread']);
assert.equal(await skills.consume(picky, 'bread'), true);
assert.equal(picky.eaten, 'bread');

// Nothing edible: say so rather than eating a pickaxe, and do not say
// "any undefined to eat".
const empty = fakeBot(['cobblestone', 'iron_pickaxe']);
assert.equal(await skills.consume(empty), false);
assert.equal(empty.eaten, null);
assert.doesNotMatch(empty.output, /undefined/, 'the old message named no food at all');

console.log('ok: consume with no argument eats whatever food is on hand');
process.exit(0);
