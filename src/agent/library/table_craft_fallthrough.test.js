// Run: node src/agent/library/table_craft_fallthrough.test.js
// Live bug: !craftRecipe("furnace") crafted a table, placed it at (9,52,5), then
// getNearestBlock returned null for the table it had just watched itself place.
// craftingTable stayed null while recipes stayed table-aware, so the code fell
// through to bot.craft(recipe, n, null) and threw a raw mineflayer
// "Recipe requires craftingTable, but one was not supplied". The agent saw a
// stack trace, retried the identical command, and ground into the
// repeated-command blocker.
import assert from 'assert';
import { useRegistry } from '../../utils/mcdata.js';

// A registry with just enough in it for craftRecipe to look up "furnace".
useRegistry({
    itemsByName: { furnace: { id: 280, name: 'furnace' }, crafting_table: { id: 58, name: 'crafting_table' } },
    items: { 280: { id: 280, name: 'furnace' }, 58: { id: 58, name: 'crafting_table' }, 4: { id: 4, name: 'cobblestone' } },
    itemsArray: [{ id: 280, name: 'furnace' }, { id: 58, name: 'crafting_table' }],
    blocksByName: { furnace: { id: 280 }, crafting_table: { id: 58 } },
    blocksArray: [{ id: 280, name: 'furnace' }, { id: 58, name: 'crafting_table' }],
    recipes: { 58: [], 280: [{ result: { id: 280, count: 1 }, inShape: [[58, 58, 58], [58, null, 58], [58, 58, 58]] }] },
});

const { craftRecipe } = await import('./skills.js');

// No crafting table exists anywhere and none can be made. This covers the
// contract that broke live -- the agent gets a sentence it can act on, never a
// mineflayer stack trace -- via the no-table-obtainable path. The placed-but-
// not-yet-visible path needs a live world and is not simulated here.
const bot = {
    entity: { position: { x: 9, y: 52, z: 5, distanceTo: () => 1, offset: () => ({}) } },
    inventory: { count: () => 0, items: () => [], slots: [] },
    // Table-free lookup finds nothing; table-aware lookup finds the recipe.
    recipesFor: (_id, _meta, _n, table) => (table ? [{ requiresTable: true, result: { count: 1 } }] : []),
    craft: async () => { throw new Error('Recipe requires craftingTable, but one was not supplied'); },
    findBlocks: () => [],
    blockAt: () => null,
    output: '',
    interrupt_code: false,
    emit: () => {},
    chat: () => {},
    modes: { isOn: () => false },
};

let threw = null, result;
try { result = await craftRecipe(bot, 'furnace', 1); }
catch (e) { threw = e; }

assert.equal(threw, null, `craftRecipe must not throw a raw mineflayer error: ${threw && threw.message}`);
assert.equal(result, false, 'a craft that cannot reach a table reports failure');
assert.doesNotMatch(bot.output, /was not supplied/, 'the raw mineflayer message never reaches the agent');
assert.match(bot.output, /crafting table/i, 'the agent is told what is actually wrong');

console.log('ok: a table-requiring craft with no reachable table fails cleanly instead of throwing');
process.exit(0);
