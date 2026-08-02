// Run: node src/utils/plank_recipes.test.js
// Minecraft's wooden recipes take the #minecraft:planks TAG, and every mod that
// adds a wood registers its planks into it. A mod data pack dump has no tags --
// it lists each tag recipe once with one representative item, always
// minecraft:oak_planks. So the registry claimed a wooden_pickaxe needs oak
// specifically, and mineflayer's recipesFor() reads the same table: Andy could
// neither plan nor craft one while standing in a frozen pine taiga holding 20
// pine_planks, and eventually wrote "pine unusable" into his own memory.
import assert from 'assert';
import { expandPlankRecipes, expandChoiceRecipes } from './mod_data.js';

// oak and pine are real woods (they have logs). The chipped mod's decorative
// "planks" have no log and are NOT in the tag -- crafting from them would be
// rejected by the server.
const items = {
    oak_planks: 1, oak_log: 2,
    'regions_unexplored:pine_planks': 3, 'regions_unexplored:pine_log': 4,
    'chipped:versailles_oak_planks': 5,
    stick: 6, wooden_pickaxe: 7,
};
const registry = () => ({
    itemsByName: Object.fromEntries(Object.entries(items).map(([name, id]) => [name, { id, name }])),
    recipes: {
        7: [{ result: { id: 7, count: 1 }, inShape: [[1, 1, 1], [null, 6, null], [null, 6, null]] }],
        1: [{ result: { id: 1, count: 4 }, ingredients: [2] }],           // oak_log -> oak_planks
        3: [{ result: { id: 3, count: 4 }, ingredients: [4] }],           // pine_log -> pine_planks
        6: [{ result: { id: 6, count: 4 }, inShape: [[1], [1]] }],        // planks -> stick
    },
});

const reg = registry();
const added = expandPlankRecipes(reg);
assert.ok(added > 0, 'variants were added');

const pickaxeIngredients = reg.recipes[7].map(v => v.inShape.flat().filter(Boolean));
assert.ok(pickaxeIngredients.some(ing => ing.includes(3)),
    'a wooden_pickaxe must be craftable from pine_planks -- this is the bug that stranded Andy');
assert.ok(pickaxeIngredients.some(ing => ing.includes(1)), 'the original oak recipe survives');
assert.ok(!pickaxeIngredients.some(ing => ing.includes(5)),
    'decorative chipped planks have no log and are not in the tag, so they must not appear');

// The recipe that PRODUCES planks must not be expanded, or a pine log would
// claim to craft oak planks.
assert.equal(reg.recipes[1].length, 1, 'oak_planks still comes only from oak_log');
assert.deepEqual(reg.recipes[1][0].ingredients, [2], 'and its ingredient is untouched');
assert.equal(reg.recipes[3].length, 1, 'pine_planks still comes only from pine_log');

// Sticks are a plank recipe too, and they were equally stuck on oak.
assert.ok(reg.recipes[6].some(v => v.inShape.flat().includes(3)), 'sticks can be made from pine too');

// Nothing to expand when there is only one wood: vanilla-only registries and
// packs that already list every variant must come out unchanged.
const single = { itemsByName: { oak_planks: { id: 1 }, oak_log: { id: 2 } }, recipes: { 7: [{ inShape: [[1]] }] } };
assert.equal(expandPlankRecipes(single), 0, 'one plank type means nothing to substitute');
assert.equal(single.recipes[7].length, 1, 'and the recipe list is left alone');

// A pack dumped after the tag fix states what each slot accepts, so no guessing
// is needed. mineflayer only understands single-item slots, so {"any": [...]}
// must be gone by the time anything reads registry.recipes.
const tagged = {
    recipes: {
        7: [{ result: { id: 7, count: 1 },
              inShape: [[{ any: [1, 3] }, { any: [1, 3] }, { any: [1, 3] }], [null, 6, null], [null, 6, null]] }],
        9: [{ result: { id: 9, count: 1 }, ingredients: [2] }],   // no choices at all
    },
};
const grew = expandChoiceRecipes(tagged);
assert.ok(grew > 0, 'choice slots expand');

const shapes = tagged.recipes[7].map(v => v.inShape);
assert.equal(shapes.length, 2, 'one variant per candidate, not per combination');
for (const shape of shapes) {
    const top = shape[0];
    assert.equal(new Set(top).size, 1, `slots sharing a choice set move together: ${JSON.stringify(top)}`);
    assert.ok(top.every(c => typeof c === 'number'), `no {any} cells may survive: ${JSON.stringify(top)}`);
}
assert.deepEqual(shapes.map(s => s[0][0]).sort(), [1, 3], 'every candidate is represented');
assert.equal(tagged.recipes[7][0].inShape[1][1], 6, 'non-choice cells are left alone');

// The recipe with no choices must survive untouched -- an earlier version of
// this dropped every single-item recipe in the pack.
assert.equal(tagged.recipes[9].length, 1, 'a recipe with no choices is kept');
assert.deepEqual(tagged.recipes[9][0].ingredients, [2], 'and is unchanged');

// Old packs have no choice sets, so the caller falls back to the plank guess.
assert.equal(expandChoiceRecipes({ recipes: { 7: [{ inShape: [[1, 1, 1]] }] } }), 0,
    'a pre-tag pack reports nothing expanded, so the plank heuristic still runs');

console.log('ok: tag-collapsed plank recipes are expanded back across every real wood');
process.exit(0);
