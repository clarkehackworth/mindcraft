// Run: node src/utils/lag_adapt.test.js
// Covers lag adaptation: view distance tracking the server's tick rate without
// flapping, and the exploration leash.
import assert from 'assert';
import { createViewDistancePicker, smoothTps, tameMovementsForLag } from './mcdata.js';
import { withinExplorationRadius } from '../agent/library/skills.js';
import settings from '../../settings.js';

// --- smoothing --------------------------------------------------------------
assert.equal(smoothTps(20, 20, 1000), 20, 'a healthy sample should hold steady at 20');
assert.ok(smoothTps(20, 5, 1000) < 20, 'a slow sample must pull the average down');
assert.ok(smoothTps(20, 5, 1000) > 5, 'one sample must not swing the whole way');
// A resume after a pause reports a huge tick jump. Reading that as a fast server
// would widen the view distance at the worst possible moment.
assert.equal(smoothTps(8, 2000, 1000), 8, 'an impossible sample must be ignored');
assert.equal(smoothTps(8, 20, 0), 8, 'a zero interval must not divide by zero');

// converging on a steady rate reaches it
let tps = 20;
for (let i = 0; i < 60; i++) tps = smoothTps(tps, 10, 1000);
assert.ok(Math.abs(tps - 10) < 0.1, `should converge on 10 tps, got ${tps}`);

// --- tier selection ---------------------------------------------------------
const SETTLE = 60000;
function settleOn(rate) {
    const pick = createViewDistancePicker();
    let now = 0, last = pick(rate, now);
    for (let i = 0; i < 20; i++) { now += SETTLE + 1; last = pick(rate, now) ?? last; }
    return last;
}
assert.equal(settleOn(20), 'far', 'a healthy server should sit at far');
assert.equal(settleOn(16), 'normal', '16 tps -> normal');
assert.equal(settleOn(12), 'short', '12 tps -> short');
assert.equal(settleOn(5), 'tiny', 'a badly stalled server should shrink to tiny');

// boundaries land on the documented side
assert.equal(settleOn(18), 'far', '18 is the bottom of far');
assert.equal(settleOn(17.9), 'normal', 'just under 18 drops a tier');
assert.equal(settleOn(11), 'short', '11 is the bottom of short');
assert.equal(settleOn(10.9), 'tiny', 'just under 11 drops to tiny');

// --- flapping ---------------------------------------------------------------
// A server oscillating across a boundary must not rewrite settings constantly:
// each settings packet is work for the server we are trying to relieve.
const pick = createViewDistancePicker();
let now = 0, changes = 0;
for (let i = 0; i < 600; i++) {          // 10 minutes of samples, 1/second
    now += 1000;
    if (pick(i % 2 ? 19 : 9, now)) changes++;
}
assert.ok(changes <= 11, `10 minutes of oscillation should yield ~10 changes at most, got ${changes}`);
assert.ok(changes > 0, 'it must still react at all');

// a steady server changes once and then stays put
const steady = createViewDistancePicker();
let t = 0, steady_changes = 0;
for (let i = 0; i < 600; i++) { t += 1000; if (steady(20, t)) steady_changes++; }
assert.equal(steady_changes, 1, 'a steady server should settle after one change');

// --- movement taming --------------------------------------------------------
// loadPlugin defers injection, so bot.pathfinder is undefined until the bot is
// in the world. Hooking it too early used to throw and kill agent startup.
tameMovementsForLag({});                       // no pathfinder at all
tameMovementsForLag({ pathfinder: {} });       // present but not injected yet

// once injected, it wraps setMovements and tames only when the server is slow
const seen = [];
const slow = { server_tps: 9, pathfinder: { setMovements: m => seen.push(m) } };
tameMovementsForLag(slow);
let mv = { allowParkour: true, allowSprinting: true };
slow.pathfinder.setMovements(mv);
assert.equal(mv.allowParkour, false, 'parkour must be off on a slow server');
assert.equal(mv.allowSprinting, false, 'sprinting must be off on a slow server');
assert.equal(seen.length, 1, 'the original setMovements must still be called');

const fast = { server_tps: 20, pathfinder: { setMovements: () => {} } };
tameMovementsForLag(fast);
mv = { allowParkour: true, allowSprinting: true };
fast.pathfinder.setMovements(mv);
assert.equal(mv.allowParkour, true, 'a healthy server should keep parkour');
assert.equal(mv.allowSprinting, true, 'a healthy server should keep sprinting');

// a null movements object must not throw
fast.pathfinder.setMovements(null);

// --- exploration leash ------------------------------------------------------
const bot = { spawn_point: { x: 100, z: -50 } };
const original = settings.exploration_radius;

settings.exploration_radius = 0;
assert.equal(withinExplorationRadius(bot, 99999, 99999), true, '0 means unlimited');

settings.exploration_radius = 200;
assert.equal(withinExplorationRadius(bot, 100, -50), true, 'spawn itself is inside');
assert.equal(withinExplorationRadius(bot, 250, -50), true, '150 blocks out is inside a 200 radius');
assert.equal(withinExplorationRadius(bot, 400, -50), false, '300 blocks out is outside');
// Euclidean, not per-axis: per-axis would make the real radius 1.41x bigger.
assert.equal(withinExplorationRadius(bot, 250, 100), false,
    '(250,100) is ~212 blocks from spawn and must be rejected');
assert.equal(withinExplorationRadius({}, 99999, 99999), true, 'no anchor yet means no leash');
settings.exploration_radius = original;

console.log('ok: tps smoothing rejects bad samples, tiers hold their boundaries, no flapping, leash is euclidean');
process.exit(0);
