// Run: node --test src/utils/recipe_cache.test.js
// Costing one wooden_pickaxe re-derived the tag-expanded plank list, 522
// variants, on every recursive step: ~7s of blocked event loop for a single
// plan. Minecraft drops a client that misses two keepalives, so Andy timed out
// mid-plan and it read as a flaky network. Parsing is now cached per item --
// which is only safe while ranking still happens per call, because the whole
// point of the ranking is that it answers to what the bot is holding.
import test from 'node:test';
import assert from 'assert';
import registryLoader from 'prismarine-registry';
import { useRegistry, getItemCraftingRecipes, getCraftingPlan } from './mcdata.js';

useRegistry(registryLoader('1.20.1'));

const firstIngredients = (recipes) => Object.keys(recipes[0][0]);

test('ranking still answers to inventory after the list is cached', () => {
    // Warm the cache with one wood, then ask again holding a different one.
    const spruce = getItemCraftingRecipes('crafting_table', { spruce_planks: 8 });
    assert.ok(firstIngredients(spruce).includes('spruce_planks'),
        `expected spruce first, got ${firstIngredients(spruce)}`);

    const birch = getItemCraftingRecipes('crafting_table', { birch_planks: 8 });
    assert.ok(firstIngredients(birch).includes('birch_planks'),
        `cache froze the ranking: expected birch first, got ${firstIngredients(birch)}`);
});

test('the ingredient counts survive being read over and over', () => {
    // The [ingredients, {craftedCount}] entries are shared across callers now.
    // Nothing in the planner writes to them, and this fails the moment
    // something starts to -- the second plan would see doubled counts or a
    // half-emptied recipe and quietly ask for the wrong materials.
    //
    // The snapshot has to copy the WHOLE entry. It used to destructure two
    // elements and rebuild a two-element array, which was faithful until
    // d34169a appended the raw minecraft-data recipe as a third; after that the
    // snapshot was short by one every time and the assert could never pass. It
    // failed for a year on the shape of its own copy, not on any mutation --
    // and a red test nobody can act on is a test nobody reads.
    const before = getItemCraftingRecipes('crafting_table', { oak_planks: 8 });
    const snapshot = before.map(entry => entry.map(part => ({ ...part })));
    for (let i = 0; i < 5; i++) getCraftingPlan('wooden_pickaxe', 1, { oak_log: 3 });
    const after = getItemCraftingRecipes('crafting_table', { oak_planks: 8 });
    assert.deepEqual(after, snapshot, 'planning mutated the shared recipe entries');
});

test('plans are unchanged by caching', () => {
    const plan = getCraftingPlan('wooden_pickaxe', 1, { spruce_log: 3, crafting_table: 1 });
    assert.deepEqual(plan.required, {}, `3 spruce_log suffices, got ${JSON.stringify(plan.required)}`);
    assert.equal(plan.steps.at(-1).item, 'wooden_pickaxe');

    // Same question twice must give the same answer, warm cache or cold.
    const again = getCraftingPlan('wooden_pickaxe', 1, { spruce_log: 3, crafting_table: 1 });
    assert.deepEqual(again.required, plan.required);
    assert.deepEqual(again.steps.map(s => s.item), plan.steps.map(s => s.item));
});

// The lookahead is why "I am holding a log" beats "the recipe says oak". It
// used to answer that by ranking the ingredient's own recipes -- a recursive
// walk per ingredient name, ~500 of them in a tag-expanded list. It is now a
// set lookup, and these pin the behaviour that walk existed to produce.
test('holding a log picks that wood, not oak', () => {
    const plan = getCraftingPlan('crafting_table', 1, { spruce_log: 3 });
    assert.deepEqual(plan.steps.map(s => s.item), ['spruce_planks', 'crafting_table'],
        'a bot in a spruce forest must not be sent looking for oak');
    assert.deepEqual(plan.required, {});
});

test('the lookahead reaches through a whole chain of intermediates', () => {
    // birch_log -> birch_planks -> stick -> wooden_pickaxe, none of it held.
    const plan = getCraftingPlan('wooden_pickaxe', 1, { birch_log: 5, crafting_table: 1 });
    assert.deepEqual(plan.required, {}, `5 birch_log suffices, got ${JSON.stringify(plan.required)}`);
    assert.ok(plan.steps.some(s => s.item === 'birch_planks'), 'must go through birch, not oak');
    assert.ok(!plan.steps.some(s => s.item.startsWith('oak')), 'no oak anywhere in a birch plan');
});

test('an empty inventory still falls back to the common-materials bias', () => {
    // 3 planks for the head and 2 sticks costs 5 planks, so 2 logs.
    const plan = getCraftingPlan('wooden_pickaxe', 1, {});
    assert.deepEqual(plan.required, { oak_log: 2 },
        `with nothing held the answer is the common wood, got ${JSON.stringify(plan.required)}`);
});

test('ranking prefers what is directly held over what is one step away', () => {
    const recipes = getItemCraftingRecipes('crafting_table', { spruce_planks: 8, birch_log: 64 });
    assert.deepEqual(Object.keys(recipes[0][0]), ['spruce_planks'],
        'planks in hand beat a log that would have to be cut and crafted first');
});

test('switching registries drops the cache', () => {
    getItemCraftingRecipes('crafting_table', { oak_planks: 8 });
    useRegistry(registryLoader('1.20.1'));
    const after = getItemCraftingRecipes('crafting_table', { oak_planks: 8 });
    assert.ok(after.length > 0, 'recipes must still resolve against the new registry');
});
