// Run: node src/utils/modded_food.test.js
// The pack ships hundreds of foods the bot is expected to live on, and the
// registry's food table was vanilla-only: has_food and consume both ask
// bot.registry.foods, so every modded meal was invisible to the eat-when-hungry
// reflex. The dumper now emits food properties; this pins that they land in the
// table those callers actually read, in the shape they expect.
import assert from 'assert';
import registryLoader from 'prismarine-registry';
import { applyModDataPacks } from './mod_data.js';

const registry = registryLoader('1.20.1');
const vanilla_food_count = Object.keys(registry.foods).length;

applyModDataPacks(registry, [{
    minecraft_version: '1.20.1',
    blocks: [],
    items: [
        { id: 40000, name: 'farmersdelight:roast_chicken', displayName: 'Roast Chicken', stackSize: 16,
          food: { foodPoints: 12, saturationModifier: 0.8 } },
        { id: 40001, name: 'create:brass_ingot', displayName: 'Brass Ingot', stackSize: 64 },
    ],
    entities: [],
    recipes: {},
}]);

const food = registry.foodsByName['roast_chicken'];
assert.ok(food, 'a modded food must be registered by its stripped name');
assert.equal(food.foodPoints, 12);
// saturation is the applied amount: nutrition * modifier * 2, same as vanilla's
// table (apple: 4 * 0.3 * 2 = 2.4).
assert.equal(food.saturation, 12 * 0.8 * 2);
assert.equal(food.effectiveQuality, 12 + food.saturation);

// has_food and consume index by item TYPE id, not by name -- registering only
// foodsByName would leave both of them still blind.
assert.ok(registry.foods[40000], 'the food must be keyed by item id too');
assert.equal(registry.foods[40000].name, 'roast_chicken');
assert.equal(Object.keys(registry.foods).length, vanilla_food_count + 1);

// A non-food modded item must not become edible.
assert.ok(!registry.foodsByName['brass_ingot'], 'items without food properties stay inedible');
console.log('ok: modded foods reach bot.registry.foods by both id and name');

// An older dump carries no food key at all; that must degrade quietly rather
// than registering a food with NaN nutrition.
const before = Object.keys(registry.foods).length;
applyModDataPacks(registry, [{
    minecraft_version: '1.20.1', blocks: [],
    items: [{ id: 40002, name: 'oldpack:mystery_meat', displayName: 'Mystery Meat', stackSize: 64 }],
    entities: [], recipes: {},
}]);
assert.equal(Object.keys(registry.foods).length, before, 'a pack without food data adds no foods');
console.log('ok: a pre-food dump still loads, just without foods');
