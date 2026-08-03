// Run: node src/agent/library/craftable_filter.test.js
// Two ways the crafting answers went wrong on a modded server.
//
// !craftable listed coal_ore, id_regex, always_true and sixteen table cloths
// while Andy held four pine planks: the mod dump left those recipes' ingredients
// unresolvable, mineflayer's recipesFor() waved them through, and the model got
// a 70-line registry dump with nothing craftable in it.
//
// And empty-handed, "you cannot craft a wooden_pickaxe" named oak_planks --
// the tiebreak's vanilla bias -- while Andy stood in a pine forest. He went
// looking for oak for a day. What is in sight has to break that tie.
import assert from 'assert';
import { useRegistry, getItemCraftingRecipes } from '../../utils/mcdata.js';
import { getCraftableItems } from './world.js';

const ids = { oak_planks: 1, oak_log: 2, pine_planks: 3, pine_log: 4, stick: 6, wooden_pickaxe: 7, coal_ore: 8 };
const byId = Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, { id, name }]));

useRegistry({
    itemsByName: byId,
    itemsArray: Object.values(byId),
    items: Object.fromEntries(Object.values(byId).map(i => [i.id, i])),
    blocksByName: {},
    recipes: {
        7: [ // both plank variants exist, as the tag expansion leaves them
            { result: { id: 7, count: 1 }, inShape: [[1, 1, 1], [null, 6, null], [null, 6, null]] },
            { result: { id: 7, count: 1 }, inShape: [[3, 3, 3], [null, 6, null], [null, 6, null]] },
        ],
        1: [{ result: { id: 1, count: 4 }, ingredients: [2] }],
        3: [{ result: { id: 3, count: 4 }, ingredients: [4] }],
        6: [
            { result: { id: 6, count: 4 }, inShape: [[1], [1]] },
            { result: { id: 6, count: 4 }, inShape: [[3], [3]] },
        ],
        8: [{ result: { id: 8, count: 1 }, inShape: [[8]] }],   // the mod dump's self-recipe
    },
});

const requires = (inventory) => Object.keys(getItemCraftingRecipes('wooden_pickaxe', inventory)[0][0]);

// Holding the planks already worked, and must keep working.
assert.ok(requires({ pine_planks: 8, stick: 4 }).includes('pine_planks'), 'held planks win');

// The bug: nothing in hand, so every variant scores zero and oak takes the tiebreak.
assert.ok(requires({ stick: 4 }).includes('oak_planks'), 'empty-handed, the old bias still names oak');

// The fix: a pine forest in sight is what reachableCounts() passes in.
assert.ok(requires({ stick: 4, pine_log: 1 }).includes('pine_planks'),
    'pine trees in sight must outrank the oak that does not grow here');

// getCraftableItems: recipesFor is the candidate generator, our data is the filter.
const bot = {
    inventory: {
        slots: [null, { name: 'pine_planks', count: 4, type: 3 }],
        items: () => [{ name: 'pine_planks', count: 4, type: 3 }],
    },
    entity: { position: { distanceTo: () => 99, offset: () => ({}) } },
    findBlock: () => null,
    // recipesFor waves through everything, as it does on the real modded server
    recipesFor: () => [{}],
};
const craftable = getCraftableItems(bot);
assert.ok(craftable.includes('stick'), '4 pine planks really do make sticks');
assert.ok(!craftable.includes('coal_ore'), 'a self-referential mod recipe is not craftable from nothing');
assert.ok(!craftable.includes('wooden_pickaxe'), '4 planks is not 3 planks plus 2 sticks');
assert.ok(!craftable.includes('oak_planks'), 'no oak logs held, so no oak planks');

console.log('ok: craftable is filtered to the inventory, and recipes rank by what is in reach');
process.exit(0);
