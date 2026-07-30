// Run: node src/utils/lag_adapt.test.js
// Covers lag adaptation: view distance following the server's stall rate without
// flapping, movement taming, and the exploration leash.
import assert from 'assert';
import { createViewDistancePicker, createStallTracker, createLoopLagTracker, smoothTps, tameMovementsForLag } from './mcdata.js';
import { withinExplorationRadius } from '../agent/library/skills.js';
import settings from '../../settings.js';

const SHRINK_SETTLE = 60000, GROW_SETTLE = 300000;

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

// --- stall counting ---------------------------------------------------------
// A stall is wall-clock time the tick clock never accounted for. 20 ticks in
// 1000ms is healthy; 20 ticks in 3000ms means the server froze for two seconds.
let st = createStallTracker();
assert.equal(st.sample(20, 1000, 1000), 0, 'a healthy interval loses no tick time');
assert.equal(st.sample(20, 3000, 4000), 2000, 'a 3s interval of 20 ticks lost 2s');
assert.equal(st.sample(20, 0, 4000), 0, 'a zero interval must not be counted');

// The bot blocking its own event loop -- an LLM response landing, a GC -- delays
// the packet and is indistinguishable from a server freeze unless subtracted.
// Getting this wrong makes the bot shrink its view distance over its own pauses.
st = createStallTracker();
assert.equal(st.sample(20, 3000, 1000, 2000), 0, 'delay caused by this process is not a server stall');
assert.equal(st.ratePerMin(61000), 0, 'and must not be counted');
st = createStallTracker();
st.sample(20, 4000, 1000, 500);
assert.ok(st.ratePerMin(61000) > 0, 'a real freeze still counts when the loop was only briefly blocked');
// just under the threshold does not count
st = createStallTracker();
st.sample(20, 2400, 1000);
assert.equal(st.ratePerMin(61000), 0, '1.4s lost is under the 1.5s threshold');

// rate is per minute over the observed window, never extrapolated from seconds
st = createStallTracker();
st.sample(20, 1000, 1000);                       // starts the clock
for (let i = 0; i < 5; i++) st.sample(20, 3000, 10000 + i * 1000);
assert.ok(st.ratePerMin(61000) > 4.5 && st.ratePerMin(61000) < 5.5,
    `5 stalls in the first minute should read ~5/min, got ${st.ratePerMin(61000)}`);
// same 5 stalls an hour later have aged out of the window
assert.equal(st.ratePerMin(3600000), 0, 'stalls older than the window must drop out');

// a quiet server reads as zero, not as a divide-by-tiny-number spike
st = createStallTracker();
st.sample(20, 1000, 1000);
assert.equal(st.ratePerMin(2000), 0, 'no stalls means no rate, even seconds in');

// --- event loop lag ---------------------------------------------------------
// Blocking the loop synchronously must show up as delay; the tracker is what
// tells the stall counter to discount it.
const lag = createLoopLagTracker(50);
const block_until = Date.now() + 400;
while (Date.now() < block_until) { /* deliberately block */ }
await new Promise(r => setTimeout(r, 120));
const observed = lag.takeMax();
assert.ok(observed > 100, `blocking 400ms should register as loop delay, got ${observed}`);
assert.equal(lag.takeMax(), 0, 'taking the max resets it');
lag.stop();

// --- tier selection ---------------------------------------------------------
function settleOn(rate) {
    const pick = createViewDistancePicker();
    let now = 0, last = pick(rate, now);
    // shrink is rate limited, so step well past both settle windows
    for (let i = 0; i < 20; i++) { now += 300001; last = pick(rate, now) ?? last; }
    return last;
}
assert.equal(settleOn(0), 'far', 'a quiet server should sit at far');
assert.equal(settleOn(0.3), 'normal', '0.3 stalls/min -> normal');
assert.equal(settleOn(1.0), 'short', '1 stall/min -> short');
assert.equal(settleOn(4), 'tiny', 'a badly stuttering server should shrink to tiny');
assert.equal(settleOn(0.1), 'far', '0.1 is the top of far');
assert.equal(settleOn(0.11), 'normal', 'just over 0.1 drops a tier');

// The measured baseline: bot alone produced ~22 stalls/hour = 0.37/min, which
// must actually shrink the window rather than sit at far like the tps version.
assert.equal(settleOn(22 / 60), 'normal', 'the observed baseline must not read as healthy');
assert.equal(settleOn(30 / 60), 'normal', 'the post-deploy rate must not read as healthy');

// --- flapping (the regression that shipped last time) ------------------------
// The tps version alternated far/normal 8 times in 9 minutes because it sat on
// a boundary. Oscillating input must now produce at most a couple of changes.
const pick = createViewDistancePicker();
let now = 0, changes = 0;
for (let i = 0; i < 600; i++) {          // 10 minutes of samples, 1/second
    now += 1000;
    if (pick(i % 2 ? 0 : 4, now)) changes++;
}
assert.ok(changes <= 3, `oscillating input must not flap, got ${changes} changes in 10 minutes`);

// but a real, sustained recovery is still honoured
const recover = createViewDistancePicker();
let t = 0;
assert.equal(recover(4, t), 'tiny', 'starts where the server is');
t += SHRINK_SETTLE; recover(0, t);
assert.equal(recover(0, t + 1000), null, 'a moment of quiet is not a recovery');
t += GROW_SETTLE + 1000;
assert.equal(recover(0, t), 'far', 'sustained quiet must eventually widen again');

// shrinking does not wait for the long window
const drop = createViewDistancePicker();
assert.equal(drop(0, 0), 'far', 'starts quiet');
assert.equal(drop(4, SHRINK_SETTLE + 1), 'tiny', 'shrinking reacts on the short window');

// a steady server changes once and then stays put
const steady = createViewDistancePicker();
let s = 0, steady_changes = 0;
for (let i = 0; i < 600; i++) { s += 1000; if (steady(0, s)) steady_changes++; }
assert.equal(steady_changes, 1, 'a steady server should settle after one change');

// --- movement taming --------------------------------------------------------
// loadPlugin defers injection, so bot.pathfinder is undefined until the bot is
// in the world. Hooking it too early used to throw and kill agent startup.
tameMovementsForLag({});                       // no pathfinder at all
tameMovementsForLag({ pathfinder: {} });       // present but not injected yet

// once injected, it wraps setMovements and tames only when the server is slow
const seen = [];
const slow = { server_stalls_per_min: 2, pathfinder: { setMovements: m => seen.push(m) } };
tameMovementsForLag(slow);
let mv = { allowParkour: true, allowSprinting: true };
slow.pathfinder.setMovements(mv);
assert.equal(mv.allowParkour, false, 'parkour must be off on a stuttering server');
assert.equal(mv.allowSprinting, false, 'sprinting must be off on a stuttering server');
assert.equal(seen.length, 1, 'the original setMovements must still be called');

const fast = { server_stalls_per_min: 0, pathfinder: { setMovements: () => {} } };
tameMovementsForLag(fast);
mv = { allowParkour: true, allowSprinting: true };
fast.pathfinder.setMovements(mv);
assert.equal(mv.allowParkour, true, 'a quiet server should keep parkour');
assert.equal(mv.allowSprinting, true, 'a quiet server should keep sprinting');

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

console.log('ok: tps smoothing rejects bad samples, tiers hold their boundaries, stall tiers hold, no flapping, leash is euclidean');
process.exit(0);
