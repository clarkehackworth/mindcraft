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
assert.equal(mv.dontCreateFlow, false, 'block placement next to liquid must be allowed, or a bot cannot pillar out of its own flooded mine');
assert.equal(seen.length, 1, 'the original setMovements must still be called');

// a null movements object must not throw
bot_pf.pathfinder.setMovements(null);
assert.equal(seen.length, 2, 'null still reaches the original');

// --- player builds are dug through only as a last resort --------------------
let scans = 0;
const bot_base = {
    registry: { blocksArray: [{ id: 7, name: 'oak_door' }, { id: 8, name: 'oak_trapdoor' }, { id: 9, name: 'stone' }] },
    pathfinder: { setMovements: () => {} },
};
// The scanner is injected rather than reading bot.findBlocks: findBlocks builds a
// Block for every block in a 128-cube on direct-palette chunks, and this runs from
// inside A*. Names, not ids, because that is what world.getNearestBlocks takes.
const scanDoors = (bot, names) => {
    scans++;
    assert.deepEqual(names, ['oak_door'], 'only real doors anchor a build, not trapdoors');
    return [{ x: 0, y: 64, z: 0 }];
};
tameMovements(bot_base, scanDoors);
const mv_base = { exclusionAreasBreak: [] };
bot_base.pathfinder.setMovements(mv_base);
bot_base.pathfinder.setMovements(mv_base);
// Two penalties -- the build box and the harvestable check -- across two calls,
// so each is registered once rather than per call.
assert.equal(mv_base.exclusionAreasBreak.length, 2, 'each penalty must be registered once, not per call');
const penalty = mv_base.exclusionAreasBreak[0];
const at = (x, y, z) => penalty({ position: { x, y, z } });
assert.ok(at(5, 64, 5) >= 99, 'a wall inside the base must be priced out of digging');
assert.ok(at(0, 64, 0) < 100, 'never fully unbreakable, or a bot shut inside has no path out');
assert.equal(at(40, 64, 40), 0, 'terrain far from any door digs at the normal cost');
assert.equal(at(0, 90, 0), 0, 'and so does terrain well above the roof');
assert.equal(penalty(null), 0, 'a missing block must not throw');
assert.equal(scans, 1, 'the door scan is cached, not run per block');

// a bot whose world is not loaded yet must not break pathfinding
const bot_early = {
    registry: { blocksArray: [{ id: 7, name: 'oak_door' }] },
    findBlocks: () => { throw new Error('Chunk not loaded'); },
    pathfinder: { setMovements: () => {} },
};
tameMovements(bot_early);
const mv_early = { exclusionAreasBreak: [] };
bot_early.pathfinder.setMovements(mv_early);
assert.equal(mv_early.exclusionAreasBreak[0]({ position: { x: 0, y: 0, z: 0 } }), 0, 'a failed scan means no penalty');

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
