import { strict as assert } from 'node:assert';
import { waterCost, waterDepth, DEEP_WATER_COST, SHALLOW_WATER_COST, inDeathPocket, DEATH_WATER_COST, DEATH_POCKET_BOX } from './water_aware_path.js';

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

// 8. Documented death pockets get near-unbreakable pricing while dry.
{
    // The exact drown that motivated the box: (-23.5, 57.2, 112.5).
    const p = { x: -23.5, y: 57.2, z: 112.5, offset: (dx, dy, dz) => ({ x: -23.5 + dx, y: 57.2 + dy, z: 112.5 + dz }) };
    const pocketBot = { entity: { isInWater: false }, blockAt: (q) => { const y = Math.round(q.y); return { name: y === 57 ? 'water' : 'stone', boundingBox: 'empty', position: q }; } };
    assert.ok(inDeathPocket(p), 'the z=112 drown is inside the box');
    assert.equal(waterCost(pocketBot, p), DEATH_WATER_COST, 'documented pocket water prices near the unbreakable cap');
    // The stuck pocket (-41, 59, 85) and the oldest documented one (-39, 53, 87) too.
    assert.ok(inDeathPocket({ x: -41, y: 59, z: 85 }), 'stuck pocket in box');
    assert.ok(inDeathPocket({ x: -39, y: 53, z: 87 }), 'oldest pocket in box');
}

// 9. The box is bounded: the Base itself, its surface approaches, and terrain
//    well to the north/south stay on the soft cost, so he can still get home.
{
    assert.ok(!inDeathPocket({ x: -29, y: 63, z: 89 }), 'the Base at surface y=63 is outside the box');
    assert.ok(!inDeathPocket({ x: -29, y: 62, z: 89 }), 'one below the Base surface is outside');
    assert.ok(!inDeathPocket({ x: 50, y: 57, z: 89 }), 'east of the box is outside');
    assert.ok(!inDeathPocket({ x: -29, y: 57, z: 30 }), 'north of the box is outside');
    assert.ok(!inDeathPocket({ x: -29, y: 40, z: 89 }), 'below the box is outside');
    // Water just outside the box still gets the soft deep cost, not the pocket price.
    const justNorth = { x: -29, y: 57, z: 58, offset: (dx, dy, dz) => ({ x: -29 + dx, y: 57 + dy, z: 58 + dz }) };
    const nbBot = { entity: { isInWater: false }, blockAt: (q) => ({ name: Math.round(q.y) >= 57 ? 'water' : 'stone', boundingBox: 'empty', position: q }) };
    assert.equal(waterDepth(nbBot, justNorth), 2, 'fixture is a real pool, not a stream');
    assert.equal(waterCost(nbBot, justNorth), DEEP_WATER_COST, 'water just outside the box keeps the soft deep cost');
}

// 10. The escape is keyed on being INSIDE the pocket, not on isInWater.
{
    const p = { x: -23, y: 57, z: 112, offset: (dx, dy, dz) => ({ x: -23 + dx, y: 57 + dy, z: 112 + dz }) };
    // A bot physically inside the pocket keeps a free exit route.
    const inPocket = { entity: { isInWater: true, position: { x: -23, y: 57, z: 112 } }, blockAt: (q) => ({ name: 'water', boundingBox: 'empty', position: q }) };
    assert.equal(waterCost(inPocket, p), 0, 'inside the pocket, water is free to path out');
    // The leak the two in-box drownings exposed: a bot merely wet (wading a
    // stream OUTSIDE the pocket) no longer nullifies the pocket price.
    const wetOutside = { entity: { isInWater: true, position: { x: -29, y: 57, z: 30 } }, blockAt: (q) => ({ name: 'water', boundingBox: 'empty', position: q }) };
    assert.equal(waterCost(wetOutside, p), DEATH_WATER_COST, 'wet outside the pocket: the pocket still prices near the cap');
}

// 11. The pocket price leaves a route for a bot that can dig out: it is never
// the pathfinder's 100 wall. (A tool-less bot gets the hard wall instead --
// tested in the descent-veto section below.)
{
    assert.ok(DEATH_WATER_COST < 100, 'pocket price is under the unbreakable cap');
    assert.ok(DEATH_WATER_COST > DEEP_WATER_COST, 'pocket price dominates the soft deep cost');
    const m = installWaterAvoidance(fakeMovements(0), { inventory: { items: () => [{ name: 'stone_pickaxe' }] }, entity: { isInWater: false }, blockAt: () => ({ name: 'water', boundingBox: 'empty', position: { x: -23, y: 57, z: 112 } }) });
    const pblock = { position: { x: -23, y: 57, z: 112, offset: () => ({ x: -23, y: 58, z: 112 }) } };
    assert.equal(m.safeOrBreak(pblock), DEATH_WATER_COST, 'the installed hook prices pocket water at the pocket cost for a pickaxe bot');
}

// 12. Guards: inDeathPocket never throws on missing/odd input.
{
    assert.equal(inDeathPocket(null), false, 'null pos safe');
    assert.equal(inDeathPocket({ x: 1, y: 2 }), false, 'missing z safe');
}

console.log('ok: documented death pockets price near the unbreakable cap, bounded at the Base, free to escape');

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

// --- hasDigTool + the tool-less pocket wall: the cave-layer descent veto (starvation fix) ---
import { hasDigTool } from './water_aware_path.js';

// A fake bot with an inventory. The columnBot helper has no inventory, so the
// tool-less cases use a bot whose inventory.items() returns [].
function toolBot(items) {
    return {
        inventory: { items: () => items.map(n => ({ name: n })) },
        entity: { position: { x: 0, y: 0, z: 0 } },
        blockAt(q) {
            // The exact starvation spot: cave-layer AIR inside the ring.
            if (Math.round(q.y) === 54) return { name: 'air', boundingBox: 'empty', position: q };
            return { name: 'stone', boundingBox: 'block', position: q };
        }
    };
}
const caveAir = { x: -26, y: 54, z: 82, offset: (dx, dy, dz) => ({ x: -26 + dx, y: 54 + dy, z: 82 + dz }) };

// 1. The starvation spot (-26,54,82) is inside the ring.
assert.ok(inDeathPocket(caveAir), 'the starvation spot is in the box');

// 2. hasDigTool: a pickaxe counts, nothing else does -- a shovel does not
//    clear the coal_ore/diorite the starvation trap was made of.
assert.equal(hasDigTool(toolBot([])), false, 'no items: no dig tool');
assert.equal(hasDigTool(toolBot(['stone_pickaxe'])), true, 'pickaxe: has a dig tool');
assert.equal(hasDigTool(toolBot(['wooden_shovel'])), false, 'shovel only: no dig tool for the cave veto');
assert.equal(hasDigTool(null), false, 'null bot: no dig tool, no throw');

// 3. The installed wrapper turns the pocket's 99 into a hard 100 wall for a
//    tool-less bot -- on cave AIR, the water cost's own blind spot (a fall
//    into the pocket is never charged a water step).
{
    const pblock = { position: caveAir };
    const mTool = installWaterAvoidance(fakeMovements(0), toolBot([]));
    assert.equal(mTool.safeOrBreak(pblock), 100, 'tool-less: the pocket is an unbreakable wall, even on air');
    // A pickaxe bot keeps the soft 99 (it can descend to mine and dig out).
    const mPick = installWaterAvoidance(fakeMovements(0), toolBot(['stone_pickaxe']));
    assert.equal(mPick.safeOrBreak(pblock), DEATH_WATER_COST, 'pickaxe: the pocket stays the soft near-wall');
}

// 4. The wall targets the pocket only: cave-layer air OUTSIDE the box is free.
{
    const outside = { x: -26, y: 54, z: 55, offset: (dx, dy, dz) => ({ x: -26 + dx, y: 54 + dy, z: 55 + dz }) };
    const m = installWaterAvoidance(fakeMovements(0), toolBot([]));
    assert.equal(m.safeOrBreak({ position: outside }), 0, 'tool-less, cave air outside the box: free');
}

// 5. A bot already INSIDE the pocket keeps a free exit, tool or no tool --
//    waterCost returns 0 before the escalation can fire.
{
    const inPocket = toolBot([]);
    inPocket.entity = { position: { x: -26, y: 54, z: 82 } };
    const m = installWaterAvoidance(fakeMovements(0), inPocket);
    assert.equal(m.safeOrBreak({ position: caveAir }), 0, 'inside the pocket: free exit even for a tool-less bot');
}

// 6. The wall is direct: 100 flat, never base + 99 (the additive version is
//    exactly what clamped back to FREE -- the first draft's bug).
{
    const mCap = installWaterAvoidance(fakeMovements(80), toolBot([]));
    assert.equal(mCap.safeOrBreak({ position: caveAir }), 100, 'the wall is 100 flat, not base + 99');
}

// 7. Guards: null bot / null pos never throw out of the tick path.
{
    const m = installWaterAvoidance(fakeMovements(5), toolBot([]));
    assert.equal(m.safeOrBreak(null), 5, 'null block: base cost returned, no throw');
    assert.equal(m.safeOrBreak({ position: null }), 5, 'block with no position: base cost, no throw');
}

console.log('ok: the tool-less pocket wall vetoes the cave-layer descent, a pickaxe lifts it, the inside-pocket exit stays free');
