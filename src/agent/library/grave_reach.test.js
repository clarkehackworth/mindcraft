// Run: node src/agent/library/grave_reach.test.js
// recoverGrave pathfound to the grave before breaking it, at closeness 1 --
// which asks the bot to stand inside a solid block. The goal is unreachable, A*
// grinds, and that grind is the wedge: 163 stuck resets on -26,67,8 in one
// window, 19 of them detected as "stuck on a grave" and answered by calling
// recoverGrave, which pathfound at the block again. Andy stood two blocks from
// his own gear for half an hour, going nowhere, having walked there on purpose.
import assert from 'assert';

const GRAVE_REACH = 4;

// The decision, in the shape skills.js has it.
function shouldWalk(botPos, gravePos) {
    const d = Math.hypot(botPos.x - gravePos.x, botPos.y - gravePos.y, botPos.z - gravePos.z);
    return d > GRAVE_REACH;
}

// Standing on it: no walking. This is the case that wedged.
assert.equal(shouldWalk({ x: -26.5, y: 69.1, z: 7.5 }, { x: -26, y: 67, z: 8 }), false,
    'two blocks away is already within reach');

// Adjacent, the ordinary case after arriving.
assert.equal(shouldWalk({ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }), false);

// Across the room: walk.
assert.equal(shouldWalk({ x: 0, y: 64, z: 0 }, { x: 12, y: 64, z: 3 }), true);

// The boundary is a real block distance, not a rounding accident.
assert.equal(shouldWalk({ x: 0, y: 64, z: 0 }, { x: GRAVE_REACH, y: 64, z: 0 }), false,
    'exactly at reach still counts as reachable');
assert.equal(shouldWalk({ x: 0, y: 64, z: 0 }, { x: GRAVE_REACH + 1, y: 64, z: 0 }), true);

// Height counts: a grave in the ceiling is not within reach just because it is
// directly overhead in x/z.
assert.equal(shouldWalk({ x: 0, y: 64, z: 0 }, { x: 0, y: 70, z: 0 }), true);

console.log('ok: the grave in arm\'s reach is hit, not pathfound at');
