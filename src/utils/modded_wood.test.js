// A modpack's woods are not the vanilla eight. Andy stood in a frozen pine
// taiga holding pine_log and pine_planks while "has_item log" read false, so
// gather_wood_for_base, build_storage_chests and craft_first_tools never fired.
import assert from 'assert';
import { expandBlockName, useRegistry, WOOD_TYPES, VANILLA_WOOD_TYPES } from './mcdata.js';

// Enough of a registry to name the woods: the modpack's pine plus vanilla spruce.
const modded = { blocksByName: {
    spruce_log: { id: 1 }, pine_log: { id: 2 }, redwood_log: { id: 3 },
    spruce_planks: { id: 11 }, pine_planks: { id: 12 }, redwood_planks: { id: 13 },
    stripped_pine_log: { id: 4 },        // vanilla spelling of a stripped variant
    'betternether:willow_log': { id: 5 },
    'betternether:willow_planks': { id: 15 },
    'betternether:willow_stripped_log': { id: 6 },  // mod spelling: stripped in the middle
    // A decoration mod's cosmetic log. No planks are made from it, and it has no
    // sign, boat, fence or stairs either -- carrying it multiplied every wood
    // family by a variant that matches nothing, and block_nearby {name:"log"}
    // scans the whole expansion on a timer.
    'chipped:hollow_oak_log': { id: 20 },
    stone: { id: 7 },
} };

useRegistry(modded);
assert.deepEqual([...WOOD_TYPES].sort(), ['betternether:willow', 'pine', 'redwood', 'spruce']);
// Neither spelling of "stripped" may become a wood of its own.
assert.ok(!WOOD_TYPES.some(w => w.includes('stripped')), 'stripped variants are not woods');
// A wood you cannot make planks from is not a wood.
assert.ok(!WOOD_TYPES.some(w => w.startsWith('chipped:')), 'cosmetic logs with no planks are not woods');
assert.ok(expandBlockName('log').includes('pine_log'), 'log family must reach the modpack wood');
assert.ok(expandBlockName('planks').includes('pine_planks'), 'planks family must reach the modpack wood');
assert.ok(expandBlockName('stripped_log').includes('stripped_pine_log'));

// An empty or absent registry keeps the vanilla list, so tests and anything
// running before login behave exactly as they did.
useRegistry({ blocksByName: {} });
assert.deepEqual(WOOD_TYPES, VANILLA_WOOD_TYPES);
useRegistry(undefined);
assert.deepEqual(WOOD_TYPES, VANILLA_WOOD_TYPES);

console.log('ok: wood families follow the modpack registry, falling back to vanilla');
