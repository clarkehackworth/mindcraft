// Run: node src/agent/library/surface.test.js
// Andy pathfound to a block it found underwater and drowned at (68.7, 52.8, -135.3).
// The old self_preservation drowning branch only jumped when there was NO
// pathfinder goal -- and the bot was pathfinding, so it never fired at all.
// It also keyed off "is there water above" rather than actual oxygen, and never
// released the jump control once set.
import assert from 'assert';
import * as skills from './skills.js';
const { isBreathing } = skills;
const fakeEntity = { position: { offset: () => ({}) }, eyeHeight: 1.62 };

function fakeBot({ head = 'water', ceiling = 'water', oxygen = 5 } = {}) {
    const bot = {
        // The server refills air the moment the head clears, and drains it for
        // any block you cannot breathe in -- kelp and seagrass included.
        get oxygenLevel() { return bot.head === 'air' ? 20 : oxygen; },
        interrupt_code: false,
        output: '',
        controls: {},
        stopped_pathfinder: false,
        cleared: false,
        dug: [],
        // Feet mid-block, as they are while swimming up: the block at feet+1 is
        // already air while the head (eye level) is still under water. Reading
        // feet+1 is what made the bot declare "Surfaced" and sink back down.
        entity: { eyeHeight: 1.62, position: { y: 49.8, offset: (x, dy) => ({ y: Math.floor(49.8 + dy) }) } },
        blockAt: (p) => ({ name: { 50: 'air', 51: bot.head, 52: bot.ceiling }[p.y] ?? 'water' }),
        head,
        ceiling,
        canDigBlock: () => true,
        dig: async (block) => { bot.dug.push(block.name); bot.ceiling = 'air'; bot.head = 'air'; },
        pathfinder: { stop: () => { bot.stopped_pathfinder = true; } },
        clearControlStates: () => { bot.cleared = true; },
        setControlState: (c, v) => { bot.controls[c] = v; },
        emit: () => {},
    };
    return bot;
}

// Surfacing abandons the path -- that is the whole point, the goal is what
// dragged it under.
const drowning = fakeBot();
const dive_start = Date.now();
const swim = skills.surface(drowning);
setTimeout(() => { drowning.head = 'air'; }, 300);
assert.equal(await swim, true);
assert.ok(Date.now() - dive_start >= 250, 'air at feet+1 does not count as surfaced -- the head is what drowns');
assert.ok(drowning.stopped_pathfinder, 'the pathfinder goal is abandoned before swimming up');
assert.equal(drowning.controls.jump, false, 'the jump control is released once surfaced');
assert.match(drowning.output, /Surfaced/, 'reaching air is reported');

// Pinned under ice: swimming up does nothing, so the ceiling gets dug out.
// Andy drowned exactly here -- jump held against the ice sheet for the full
// timeout while its oxygen ran down.
const underIce = fakeBot({ ceiling: 'ice' });
assert.equal(await skills.surface(underIce), true);
assert.deepEqual(underIce.dug, ['ice'], 'the ice overhead is dug through');
assert.match(underIce.output, /Surfaced/, 'digging out counts as surfacing');

// No air reachable at all: give up rather than hold the action forever.
const trapped = fakeBot();
const start = Date.now();
assert.equal(await skills.surface(trapped, 1), false);
assert.ok(Date.now() - start >= 900, 'it tries for the full timeout');
assert.equal(trapped.controls.jump, false, 'the jump control is released on timeout too');
assert.match(trapped.output, /Could not reach the surface/);

// An interrupt still releases the control -- a stuck jump would break walking.
const interrupted = fakeBot();
const pending = skills.surface(interrupted, 10);
setTimeout(() => { interrupted.interrupt_code = true; }, 200);
await pending;
assert.equal(interrupted.controls.jump, false, 'the jump control is released when interrupted');

// Andy drowned in a kelp forest while the log said "Surfaced with -1/20 air
// left". Water, kelp, seagrass and waterlogged stairs all drown you; only the
// first is named 'water', so any block-name test of "am I underwater" is wrong.
for (const name of ['kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'oak_stairs'])
    assert.equal(isBreathing({ oxygenLevel: 3, entity: fakeEntity, blockAt: () => ({ name }) }), false,
        `a head in ${name} with 3 air is not breathing`);
assert.equal(isBreathing({ oxygenLevel: -1, entity: fakeEntity, blockAt: () => ({ name: 'kelp' }) }), false,
    'negative air is definitely not breathing');
assert.equal(isBreathing({ oxygenLevel: 19, entity: fakeEntity, blockAt: () => ({ name: 'air' }) }), false,
    'still refilling is not surfaced yet');
// An air pocket counts: he can breathe, whatever is packed around him.
assert.equal(isBreathing({ oxygenLevel: 20, entity: fakeEntity, blockAt: () => ({ name: 'stone' }) }), true,
    'full air in a pocket is breathing');
// Only a server that sends no oxygen at all falls back to block names.
assert.equal(isBreathing({ entity: fakeEntity, blockAt: () => ({ name: 'air' }) }), true,
    'no oxygen data falls back to the head block');
assert.equal(isBreathing({ entity: fakeEntity, blockAt: () => ({ name: 'kelp' }) }), false,
    'and the fallback still rejects kelp');

console.log('ok: drowning abandons the path, swims up, and always releases the jump');

// surface() failed 25 times for every 15 it succeeded, always at oxygen=0, and
// said only "Could not reach the surface within 20 seconds". Four attempts at
// the drowning bug went into the detection condition, because the escape's own
// failure carried no evidence at all. The two failures need opposite fixes:
// pinned under something unbreakable is a tool problem, open water that never
// ends is a direction problem.
const sealed = fakeBot({ head: 'water', ceiling: 'blue_ice' });
sealed.canDigBlock = () => false;
await skills.surface(sealed, 0.3);
assert.match(sealed.output, /pinned under blue_ice/, 'names what is overhead');
assert.match(sealed.output, /nothing in hand can break it/, 'and that no tool helps');
assert.match(sealed.output, /5\/20 air/, 'with the air reading that decided it');

const open = fakeBot({ head: 'water', ceiling: 'water' });
await skills.surface(open, 0.3);
assert.match(open.output, /nothing overhead to break/, 'open water is the other failure');

console.log('ok: a failed surface says which failure it was');
