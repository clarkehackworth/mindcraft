// Run: node src/utils/craft_plan.test.js
// Andy spent ~10 LLM roundtrips stepping log -> planks -> sticks -> table ->
// wooden_pickaxe one craft at a time. getCraftingPlan walks that chain in code
// so craftRecipe can auto-craft intermediates; this pins the structured shape
// it returns, and that the human-readable plan still renders after the
// steps became objects.
import assert from 'assert';
import registryLoader from 'prismarine-registry';
import { useRegistry, getCraftingPlan, getDetailedCraftingPlan } from './mcdata.js';

useRegistry(registryLoader('1.20.1'));

const plan = getCraftingPlan('wooden_pickaxe', 1, { oak_log: 3, crafting_table: 1 });
assert.ok(plan, 'wooden_pickaxe is craftable, plan must not be null');
assert.deepEqual(plan.required, {}, `3 oak_log suffices, nothing else required: ${JSON.stringify(plan.required)}`);
assert.equal(plan.steps.at(-1).item, 'wooden_pickaxe', 'target is the last step');
const intermediates = plan.steps.slice(0, -1).map(s => s.item);
assert.ok(intermediates.includes('oak_planks') && intermediates.includes('stick'),
    `intermediates must cover planks and sticks: ${intermediates}`);
for (const step of plan.steps) {
    assert.equal(typeof step.count, 'number');
    assert.ok(Object.keys(step.ingredients).length > 0, `step ${step.item} lists its ingredients`);
}

assert.equal(getCraftingPlan('oak_log', 1, {}), null, 'base items have no plan');
assert.equal(getCraftingPlan('not_a_real_item', 1, {}), null, 'unknown items have no plan');

const detailed = getDetailedCraftingPlan('wooden_pickaxe', 1, { oak_log: 3 });
assert.ok(detailed.includes('Craft') && detailed.includes('wooden_pickaxe'),
    `formatted plan still renders from structured steps: ${detailed}`);

// Recipe choice must follow the inventory, not a hardcoded list of vanilla
// favourites. Andy, holding spruce/larch wood in a forest with no oak in it,
// was told a wooden_pickaxe needs 1 oak_log, and spent a day trying to get oak.
const spruce = getCraftingPlan('wooden_pickaxe', 1, { spruce_log: 3, crafting_table: 1 });
assert.deepEqual(spruce.required, {}, `spruce_log must satisfy a wooden_pickaxe: ${JSON.stringify(spruce.required)}`);
const sprucePlanks = spruce.steps.map(s => s.item);
assert.ok(sprucePlanks.includes('spruce_planks'), `plan must use the wood on hand: ${sprucePlanks}`);
assert.ok(!sprucePlanks.includes('oak_planks'), `plan must not reach for oak: ${sprucePlanks}`);
assert.match(getDetailedCraftingPlan('wooden_pickaxe', 1, { spruce_log: 3 }), /spruce/,
    'the human-readable plan names the wood the bot is holding');

// With nothing at all, the old vanilla bias is still the sensible default.
const empty = getCraftingPlan('wooden_pickaxe', 1, {});
assert.ok(Object.keys(empty.required).some(i => i.includes('log')), 'an empty inventory still plans from logs');

// Mining beats crafting when it costs fewer raw units. Prominence 2 has a
// 12 pebble -> 3 cobblestone recipe, and taking the first recipe blindly told
// Andy his stone_pickaxe was 12 pebbles away instead of 3 mined cobblestone.
const stone = getCraftingPlan('stone_pickaxe', 1, { spruce_log: 3 });
assert.equal(stone.required.cobblestone, 3, `cobblestone is mined, not crafted: ${JSON.stringify(stone.required)}`);

console.log('ok: crafting plan returns a structured, executable step chain');
process.exit(0);
