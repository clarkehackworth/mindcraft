import { strict as assert } from 'node:assert';
import { waterCost, waterDepth, DEEP_WATER_COST, SHALLOW_WATER_COST } from './water_aware_path.js';

// Fake bot whose blockAt answers from a y->name map at one (x,z) column.
function columnBot(names, { isInWater = false } = {}) {
    return {
        entity: { isInWater, position: { x: 0, y: 0, z: 0 } },
        blockAt(pos) {
            const n = names[pos.y];
            if (n === undefined) return { name: 'air', boundingBox: 'empty' };
            const bb = /water|lava/.test(n) ? 'empty' : (n === 'air' || n === 'cave_air' ? 'empty' : 'block');
            return { name: n, boundingBox: bb, position: pos };
        }
    };
}
const P = (y) => ({ x: 0, y, z: 0, offset: (dx, dy, dz) => ({ x: 0, y: y + dy, z: 0 }) });

// 1. Not water -> zero cost.
assert.equal(waterCost(columnBot({ 0: 'stone' }), P(0)), 0, 'solid block is not water');
assert.equal(waterCost(columnBot({ 0: 'air' }), P(0)), 0, 'air is not water');

// 2. Shallow stream: water at feet, air above, solid below -> 1 deep -> shallow cost.
assert.equal(waterDepth(columnBot({ 1: 'air', 0: 'water', '-1': 'stone' }), P(0)), 1, '1-deep stream');
assert.equal(waterCost(columnBot({ 1: 'air', 0: 'water', '-1': 'stone' }), P(0)), SHALLOW_WATER_COST, 'shallow water is cheap');

// 3. Deep pool: water at feet AND water above -> 2 deep -> deep cost.
assert.equal(waterDepth(columnBot({ 1: 'water', 0: 'water', '-1': 'stone' }), P(0)), 2, 'pool with water above');
assert.equal(waterCost(columnBot({ 1: 'water', 0: 'water', '-1': 'stone' }), P(0)), DEEP_WATER_COST, 'deep water is expensive');

// 4. Deep pit: water at feet with water below (sinking) -> 2 deep -> deep cost.
assert.equal(waterDepth(columnBot({ 1: 'air', 0: 'water', '-1': 'water' }), P(0)), 2, 'water below = sinking');
assert.equal(waterCost(columnBot({ 1: 'air', 0: 'water', '-1': 'water' }), P(0)), DEEP_WATER_COST, 'sinking water is expensive');

// 5. Bot already in water -> zero cost (must be free to path out to shore).
assert.equal(waterCost(columnBot({ 1: 'water', 0: 'water', '-1': 'stone' }, { isInWater: true }), P(0)), 0, 'in water: no penalty (escape route)');
assert.equal(waterCost(columnBot({ 1: 'air', 0: 'water', '-1': 'stone' }, { isInWater: true }), P(0)), 0, 'in water: shallow also free');

// 6. Null / missing guards -> zero, never throws.
assert.equal(waterCost(null, P(0)), 0, 'null bot safe');
assert.equal(waterCost(columnBot({ 0: 'water' }), null), 0, 'null pos safe');

// 7. Deep dominates shallow, both under the pathfinder's 100 'unbreakable' cap.
assert.ok(DEEP_WATER_COST > SHALLOW_WATER_COST, 'deep > shallow');
assert.ok(DEEP_WATER_COST < 100, 'deep cost leaves a path (not an absolute avoid)');
assert.ok(SHALLOW_WATER_COST < 100, 'shallow cost leaves a path');

console.log('ok: water-aware path cost (shallow cheap, deep expensive, free to escape)');

// --- installWaterAvoidance: the installer that wires the cost onto Movements ---
import { installWaterAvoidance } from './water_aware_path.js';

// A Movements the pathfinder hands us: it just needs a safeOrBreak to wrap.
function fakeMovements(baseCost = 0) {
    return {
        safeOrBreak: function (block) { return baseCost; },
    };
}
const deepPoolBot = (inWater = false) => columnBot({ 1: 'water', 0: 'water', '-1': 'stone' }, { isInWater: inWater });
const deepBlock = { position: P(0) }; // a block whose feet are water, water above -> deep

// 1. Idempotent: a second install is a no-op (sentinel guard), safeOrBreak wrapped once.
{
    const m = installWaterAvoidance(fakeMovements(0), deepPoolBot());
    const wrappedOnce = m.safeOrBreak;
    const m2 = installWaterAvoidance(m, deepPoolBot()); // same object again
    assert.equal(m2, m, 'install returns the same Movements');
    assert.equal(m2.safeOrBreak, wrappedOnce, 'safeOrBreak is wrapped exactly once (idempotent)');
    assert.equal(typeof m.updateWaterAvoidance, 'function', 'updateWaterAvoidance marker present');
}

// 2. Adds the deep cost to a traversable water block when the bot is dry.
{
    const m = installWaterAvoidance(fakeMovements(0), deepPoolBot(false));
    assert.equal(m.safeOrBreak(deepBlock), DEEP_WATER_COST, 'deep water block costs deep when dry');
}

// 3. Free to escape: bot already in water -> zero extra.
{
    const m = installWaterAvoidance(fakeMovements(0), deepPoolBot(true));
    assert.equal(m.safeOrBreak(deepBlock), 0, 'in water the escape route is free');
}

// 4. Never pushes a traversable block over the 100 'unbreakable' cap.
{
    // base 70 (e.g. an expensive dig) + deep 40 = 110 > 100 -> must stay 70, not become a wall.
    const m = installWaterAvoidance(fakeMovements(70), deepPoolBot(false));
    assert.equal(m.safeOrBreak(deepBlock), 70, 'a wadable block is never pushed over the 100 cap');
    // base 60 + deep 40 = 100 -> exactly at the cap, still legal (<= 100).
    const m2 = installWaterAvoidance(fakeMovements(60), deepPoolBot(false));
    assert.equal(m2.safeOrBreak(deepBlock), 100, 'cost may reach, but not exceed, the 100 cap');
}

// 5. A non-water block (no position / not water) adds nothing.
{
    const m = installWaterAvoidance(fakeMovements(5), deepPoolBot(false));
    assert.equal(m.safeOrBreak(null), 5, 'null block: base cost returned, no throw');
    const stoneBot = columnBot({ 0: 'stone' });
    const m2 = installWaterAvoidance(fakeMovements(5), stoneBot);
    assert.equal(m2.safeOrBreak({ position: P(0) }), 5, 'a solid block adds no water cost');
    assert.equal(m2.safeOrBreak({ position: null }), 5, 'a block with no position adds no water cost, no throw');
}

// 6. A throwing original safeOrBreak degrades to the unbreakable cost (never throws out).
{
    const m = installWaterAvoidance({ safeOrBreak() { throw new Error('pathfinder exploded'); } }, deepPoolBot(false));
    assert.doesNotThrow(() => m.safeOrBreak(deepBlock), 'the wrapper never throws out of the tick path');
    assert.equal(m.safeOrBreak(deepBlock), 100, 'a failing base cost degrades to unbreakable (100)');
}

// 7. Null / missing guards: install is a no-op, returns what it was given.
{
    assert.equal(installWaterAvoidance(null, deepPoolBot()), null, 'null Movements safe');
    const m = fakeMovements(0);
    assert.equal(installWaterAvoidance(m, null), m, 'null bot: the same Movements object comes back, unwrapped');
    assert.equal(typeof m.safeOrBreak, 'function', 'null bot: no wrapper installed, original safeOrBreak intact');
}

console.log('ok: installWaterAvoidance wires the soft cost idempotently, no-throw, under the 100 cap');
