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
        look: (yaw, pitch, immediate) => { (bot.looks ??= []).push(yaw); },
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
for (const name of ['kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'])
    assert.equal(isBreathing({ oxygenLevel: 3, entity: fakeEntity, blockAt: () => ({ name }) }), false,
        `a head in ${name} with 3 air is not breathing`);
assert.equal(isBreathing({ oxygenLevel: -1, entity: fakeEntity, blockAt: () => ({ name: 'kelp' }) }), false,
    'negative air is definitely not breathing');
// A stair drowns you when it is waterlogged, which is a property and not a
// name. The old assertion checked the name alone, so it also condemned every
// dry staircase in the world -- fine while nothing consulted it, wrong now that
// the head block is what decides.
assert.equal(isBreathing({ oxygenLevel: 3, entity: fakeEntity,
    blockAt: () => ({ name: 'oak_stairs', getProperties: () => ({ waterlogged: true }) }) }), false,
    'a waterlogged stair is water');
assert.equal(isBreathing({ oxygenLevel: 3, entity: fakeEntity,
    blockAt: () => ({ name: 'oak_stairs', getProperties: () => ({ waterlogged: false }) }) }), true,
    'a dry stair is a stair');
// Reversed deliberately. This used to demand a full bar before calling it
// surfaced, which was right when the bar was the only signal -- but the bar was
// measured stuck at 0 for the rest of a session after one drowning, and under
// the old rule that bot could never be "breathing" again while standing in a
// field. Head in air is breathing; that is what the word means.
assert.equal(isBreathing({ oxygenLevel: 19, entity: fakeEntity, blockAt: () => ({ name: 'air' }) }), true,
    'head in air is breathing, whatever the bar is doing');
// An air pocket counts: he can breathe, whatever is packed around him.
assert.equal(isBreathing({ oxygenLevel: 20, entity: fakeEntity, blockAt: () => ({ name: 'stone' }) }), true,
    'full air in a pocket is breathing');
assert.equal(isBreathing({ entity: fakeEntity, blockAt: () => ({ name: 'air' }) }), true,
    'no oxygen data is not an emergency');
assert.equal(isBreathing({ entity: fakeEntity, blockAt: () => ({ name: 'kelp' }) }), false,
    'and a wet head is, with or without a bar');

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

// Andy sat at (-8.3, 50.0, 9.7) in an enclosed water pocket at y=50. The
// surface_when_night_finds_you_underground policy fired, isBreathing returned
// true (head above the waterline, oxygen refilled to 20), and the log reported
// "Surfaced with 20/20 air left" -- while the body was still submerged and the
// bot could not get out. isBreathing answers "is the head above water?" (the
// right question for drowning detection); surface() was using it to answer
// "did the bot get out of the water?" (a different question). The fix guards
// the success check with bot.entity.isInWater so the head-above-water state in
// an enclosed pocket is not reported as a successful rescue.
//
// fakeBot with head='air' and oxygen=20 gives exactly that state: isBreathing
// is true, isInWater is true. The old code returned true on the first loop
// tick; the fix must run the full timeout and report the enclosed pocket.
const pocket = fakeBot({ head: 'air', ceiling: 'water', oxygen: 20 });
pocket.entity.isInWater = true;
const pocket_start = Date.now();
assert.equal(await skills.surface(pocket, 1), false,
    'breathing but still in water is NOT surfaced -- the body is submerged');
assert.ok(Date.now() - pocket_start >= 900,
    'it keeps trying for the full timeout instead of returning early');
assert.match(pocket.output, /enclosed pocket/, 'the failure names the enclosed pocket');
assert.match(pocket.output, /Could not reach the surface/, 'still a failed surface, not a success');
assert.doesNotMatch(pocket.output, /Surfaced with/, 'the false success line is not emitted');

// A bot that is breathing AND out of water (dry land) still takes the early
// return -- the guard must not make the no-op case swim for 20 seconds.
const dry = fakeBot({ head: 'air', ceiling: 'air', oxygen: 20 });
const dry_start = Date.now();
assert.equal(await skills.surface(dry), true, 'a breathing bot on dry land is trivially surfaced');
assert.ok(Date.now() - dry_start < 200, 'the early return still fires on dry land');
assert.match(dry.output, /nothing to surface from/i, 'and it says it did nothing');

// An enclosed pocket with a diggable ceiling: the bot breathes at the
// waterline (head above, body in), but there is stone overhead it can dig
// through. The fix must not just time out -- it must dig the ceiling and
// escape.
const pocketCeiling = fakeBot({ head: 'air', ceiling: 'stone', oxygen: 20 });
pocketCeiling.entity.isInWater = true;
pocketCeiling.dig = async (block) => {
    pocketCeiling.dug.push(block.name);
    pocketCeiling.ceiling = 'air';
    pocketCeiling.entity.isInWater = false; // dug out of the pocket
};
assert.equal(await skills.surface(pocketCeiling, 5), true,
    'a pocket with a diggable ceiling is escaped by digging, not timed out');
assert.deepEqual(pocketCeiling.dug, ['stone'], 'the stone ceiling is dug through');
assert.match(pocketCeiling.output, /Surfaced with/, 'and the real rescue is reported once out');

console.log('ok: breathing-but-still-in-water is an enclosed pocket, not a rescue');

// Pinned under an undiggable ceiling while affirmatively in water: the bot
// cannot dig out and holding jump in place drowns it (the water-pocket deaths
// at y=54-56). The new escape swims sideways out -- one forward stroke per
// cardinal heading. It must actually look (turn) and hold forward, then
// release forward in the finally block so a surfaced bot does not keep walking.
const pinnedInWater = fakeBot({ head: 'water', ceiling: 'stone' });
pinnedInWater.canDigBlock = () => false;           // nothing in hand can break the ceiling
pinnedInWater.entity.isInWater = true;             // affirmatively submerged
const swim_start = Date.now();
assert.equal(await skills.surface(pinnedInWater, 1), false, 'an undiggable ceiling in water still fails the surface');
assert.ok(Date.now() - swim_start >= 900, 'it tries for the full timeout');
assert.ok(Array.isArray(pinnedInWater.looks) && pinnedInWater.looks.length >= 1, 'the bot turns to swim sideways out');
assert.equal(pinnedInWater.controls.forward, false, 'the forward stroke is released when it gives up');
assert.match(pinnedInWater.output, /swam sideways/, 'the failure names the sideways-swim attempt');
assert.match(pinnedInWater.output, /pinned under stone/, 'and still names what is overhead');

// The same undiggable ceiling on DRY land must NOT swim -- sliding a bot that
// is not in water would just waste the timeout. The existing sealed case above
// already pins under blue_ice with no isInWater, so it must have never looked.
assert.ok(!Array.isArray(sealed.looks) || sealed.looks.length === 0,
    'a dry-land pinned bot does not waste its timeout swimming');

console.log('ok: an undiggable ceiling in water triggers a sideways-swim escape, dry land does not');
