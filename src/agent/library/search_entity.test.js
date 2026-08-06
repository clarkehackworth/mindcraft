import { strict as assert } from 'node:assert';
import test from 'node:test';
import { searchForEntity, spiralWaypoints, goToXZ, ENTITY_VIEW_RANGE } from './skills.js';
import minecraftData from 'minecraft-data';
import { useRegistry } from '../../utils/mcdata.js';

// bot that only sees a sheep once it has made `stopsNeeded` stops
function makeBot({ stopsNeeded = Infinity, biomes = [], step = 64 } = {}) {
    let stops = 0;
    const visited = [];
    const pos = { x: 0, y: 64, z: 0, clone() { return { ...this, clone: this.clone, distanceTo: this.distanceTo }; },
        distanceTo(o) { return Math.hypot(this.x - o.x, this.z - o.z); } };
    const walk = () => { pos.x += step; };  // each stop actually gets somewhere
    const bot = {
        output: '',
        get stops() { return stops; },
        visited,
        travel: async () => { stops++; visited.push('hop'); walk(); return true; },
        goTo: async (_b, x, _y, z) => { stops++; visited.push([x, z]); walk(); return true; },
        entity: { position: pos },
        nearestEntity: () => stops >= stopsNeeded
            ? { name: 'sheep', position: { x: 5, y: 64, z: 0, distanceTo: () => 5 } }
            : null,
        world: { getBiome: () => 0 },
        registry: { biomes: { 0: { name: biomes.length ? biomes[Math.min(stops, biomes.length) - 1] ?? 'taiga' : 'taiga' } } },
        pathfinder: { setMovements() {}, goto: async () => {} },
        modes: { isOn: () => false },
    };
    return bot;
}

const opts = bot => ({ travel: bot.travel, goTo: bot.goTo });

test('spiral waypoints sweep outward with legs short enough to path to', () => {
    const pts = spiralWaypoints({ x: 0, z: 0 }, 480, 16, 64);
    assert.ok(pts.length > 1);
    const radii = pts.map(p => Math.hypot(p.x, p.z));
    assert.ok(radii.every(r => r <= 481), 'no waypoint outside the radius');
    assert.ok(radii[radii.length - 1] > radii[0], 'sweeps outward');

    // The bug this replaced: a first waypoint 190 blocks out that the pathfinder
    // always timed out on, so the bot never moved and reported "no sheep".
    assert.ok(radii[0] <= 65, `first leg is one hop, got ${radii[0]}`);
    for (let i = 1; i < pts.length; i++) {
        const leg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
        assert.ok(leg <= 80, `leg ${i} is ${Math.round(leg)} blocks, too far to path in one goto`);
    }
    // consecutive stops must not all head the same way, or it walks a straight line
    const angles = pts.map(p => Math.atan2(p.z, p.x));
    assert.ok(new Set(angles.map(a => Math.round(a * 2))).size > 2, 'turns as it goes');
});

test('waypoints never exceed the requested range', () => {
    const pts = spiralWaypoints({ x: 0, z: 0 }, 100, 16, 64);
    assert.ok(pts.every(p => Math.hypot(p.x, p.z) <= 100));
});

test('spiral travels to real waypoints instead of hopping blindly', async () => {
    const bot = makeBot({ stopsNeeded: 3 });
    await searchForEntity(bot, 'sheep', 500, { pattern: 'spiral', ...opts(bot) });
    assert.equal(bot.stops, 3);
    assert.ok(bot.visited.every(v => Array.isArray(v)), 'used goTo waypoints, not random hops');
    assert.match(bot.output, /Found sheep/);
});

test('random pattern still hops', async () => {
    const bot = makeBot({ stopsNeeded: 2 });
    await searchForEntity(bot, 'sheep', 500, { pattern: 'random', ...opts(bot) });
    assert.equal(bot.stops, 2);
    assert.ok(bot.visited.every(v => v === 'hop'));
});

test('does not travel when the entity is already in sight', async () => {
    const bot = makeBot({ stopsNeeded: 0 });
    await searchForEntity(bot, 'sheep', 500, opts(bot));
    assert.equal(bot.stops, 0);
});

test('a short range stays a single local look', async () => {
    const bot = makeBot();
    await searchForEntity(bot, 'sheep', 32, opts(bot));
    assert.equal(bot.stops, 0);
});

test('failure names the biomes covered and never claims the full range was checked', async () => {
    const bot = makeBot();
    await searchForEntity(bot, 'sheep', 500, opts(bot));
    assert.ok(bot.stops > 0, 'should have tried travelling');
    assert.ok(!bot.output.includes('500 blocks'), 'must not claim 500 blocks were searched');
    assert.match(bot.output, new RegExp(`${ENTITY_VIEW_RANGE} blocks`));
    assert.match(bot.output, /Terrain covered: taiga/);
    assert.match(bot.output, /keep travelling/);
});

// The deployed run hit exactly this: every goto timed out, the bot stayed put,
// and the output said "no sheep found" -- so the model concluded the area was
// empty and went mining. Being stuck must not read as being sure.
test('a bot that cannot move says so instead of claiming no sheep are around', async () => {
    const bot = makeBot();
    bot.goTo = async () => false;
    bot.travel = async () => false;
    await searchForEntity(bot, 'sheep', 500, opts(bot));
    assert.match(bot.output, /never left where you are standing/);
    assert.ok(!/Could not find any sheep/.test(bot.output), 'must not report a negative result it did not earn');
});

test('one unreachable waypoint does not abandon the search', async () => {
    const bot = makeBot({ stopsNeeded: 2 });
    const realGoTo = bot.goTo;
    let calls = 0;
    bot.goTo = async (...a) => (++calls === 1 ? false : realGoTo(...a));
    bot.travel = async () => false;  // no fallback hop either: the first direction is a dead end
    await searchForEntity(bot, 'sheep', 500, opts(bot));
    assert.ok(calls > 1, 'tried another direction');
    assert.match(bot.output, /Found sheep/);
});

test('a one-block shuffle does not count as having searched somewhere new', async () => {
    const bot = makeBot({ step: 1 });  // pathfinder "succeeds" but the bot is pinned
    await searchForEntity(bot, 'sheep', 500, opts(bot));
    assert.match(bot.output, /never left where you are standing/);
});

// An interrupted search returned nothing at all, which printed as "undefined";
// the model read that as the command being broken and abandoned the sheep.
test('an interrupted search says it was interrupted, not that nothing is there', async () => {
    const bot = makeBot();
    const realGoTo = bot.goTo;
    bot.goTo = async (...a) => { const r = await realGoTo(...a); bot.interrupt_code = true; return r; };
    await searchForEntity(bot, 'sheep', 500, opts(bot));
    assert.match(bot.output, /interrupted/);
    assert.match(bot.output, /Nothing was ruled out/);
    assert.ok(!/Could not find any sheep/.test(bot.output));
});

test('gives up after several directions in a row are blocked', async () => {
    const bot = makeBot();
    let calls = 0;
    bot.goTo = async () => { calls++; return false; };
    bot.travel = async () => false;
    await searchForEntity(bot, 'sheep', 500, opts(bot));
    // 3 consecutive blocked waypoints, each tried at full then half distance.
    assert.equal(calls, 6, 'stops after MAX_BLOCKED consecutive failures');
});

// Live failure: "sweeping outward to 88, 19" -> "Took to long to decide path to
// goal!". The waypoints carried the STARTING y, so on hilly frozen taiga each one
// was a point buried in a hillside or floating in the air, and A* burned its whole
// budget failing to reach an unreachable 3D point. A sweep wants the column.
test('a sweep waypoint asks for the column, not a fixed height', async () => {
    const registry = minecraftData('1.20.1');
    useRegistry(registry);   // mc.getBlockId() reads the module-level registry
    let goal = null;
    const bot = {
        output: '', spawn_point: { x: 0, z: 0 }, registry,
        entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 5, clone() { return { ...this }; } } },
        pathfinder: {
            setMovements() {},
            // called synchronously by goToGoal, which reads .status off the result
            getPathTo: () => ({ status: 'success' }),
            goto: async g => { goal = g; },
        },
        modes: { isOn: () => false },
        chat() {},
    };
    await goToXZ(bot, 88, 19, 8);
    assert.ok(goal, 'a goal was handed to the pathfinder');
    assert.equal(goal.constructor.name, 'GoalNearXZ',
        'a fixed-Y goal is a point in a hillside on sloped terrain, and A* times out reaching it');
    assert.equal(goal.x, 88);
    assert.equal(goal.z, 19);
    assert.ok(!('y' in goal), 'no Y for the terrain to have to match');
});

// pathfinder.goto walks while it replans, so "Took to long to decide path to
// goal!" is often thrown after the bot has already crossed most of the distance.
// Treating that as a failure reported "you never left where you are standing"
// from 40 blocks away, and abandoned a search that was working.
test('a goto that times out mid-walk still counts as ground covered', async () => {
    const bot = makeBot({ stopsNeeded: 2 });
    bot.goTo = async () => { bot.entity.position.x += 50; return false; };  // moved, then threw
    bot.travel = async () => false;                                          // no fallback hop
    await searchForEntity(bot, 'sheep', 500, opts(bot));
    assert.ok(!/never left where you are standing/.test(bot.output),
        'it walked 50 blocks a stop -- that is not standing still');
});

// A* is superlinear in distance, and frozen taiga is expensive to search because
// every snow block needs a shovel the bot lacks. A 64-block leg exhausted the
// budget; the same heading at half the distance is a far smaller search.
test('a leg too far to plan is retried at half distance before giving up on it', async () => {
    const bot = makeBot({ stopsNeeded: 99 });
    const tried = [];
    bot.goTo = async (_b, x, _y, z) => { tried.push([x, z]); return false; };
    bot.travel = async () => false;
    await searchForEntity(bot, 'sheep', 500, opts(bot));
    assert.ok(tried.length >= 2, 'tried more than once');
    const [full, half] = tried;
    const d = p => Math.hypot(p[0], p[1]);
    assert.ok(d(half) < d(full), `half-distance retry (${d(half).toFixed(0)}) must be nearer than the full leg (${d(full).toFixed(0)})`);
    assert.ok(Math.abs(Math.atan2(half[1], half[0]) - Math.atan2(full[1], full[0])) < 0.01, 'same heading');
});
