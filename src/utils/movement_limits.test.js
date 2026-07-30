// Run: node src/utils/lag_adapt.test.js
// Covers movement taming and the exploration leash. The adaptive view distance
// this file used to test was removed: measured A/B/A on a stuttering server, the
// two identical arms differed more than the two settings did.
import assert from 'assert';
import { tameMovements } from './mcdata.js';
import { withinExplorationRadius } from '../agent/library/skills.js';
import settings from '../../settings.js';

// --- movement taming --------------------------------------------------------
// loadPlugin defers injection, so bot.pathfinder is undefined until the bot is
// in the world. Hooking it too early used to throw and kill agent startup.
tameMovements({});                       // no pathfinder at all
tameMovements({ pathfinder: {} });       // present but not injected yet

// once injected, it wraps setMovements and turns both off
const seen = [];
const bot_pf = { pathfinder: { setMovements: m => seen.push(m) } };
tameMovements(bot_pf);
const mv = { allowParkour: true, allowSprinting: true, allowFreeMotion: true };
bot_pf.pathfinder.setMovements(mv);
assert.equal(mv.allowParkour, false, 'parkour must be off');
assert.equal(mv.allowSprinting, false, 'sprinting must be off');
assert.equal(mv.allowFreeMotion, true, 'unrelated movement options must be left alone');
assert.equal(seen.length, 1, 'the original setMovements must still be called');

// a null movements object must not throw
bot_pf.pathfinder.setMovements(null);
assert.equal(seen.length, 2, 'null still reaches the original');

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

console.log('ok: movement taming survives a missing pathfinder, leash is euclidean');
process.exit(0);
