// Run: node --test src/utils/flee_target.ollama.js
// The 2026-09-07 check-in pinned the bot at (-6, 46, 10) inside the hard
// NEAR_SPAWN_PIT_BOX with a drowned at (-6, 68, 5) -- 22 blocks ABOVE it.
// avoidEnemies re-armed GoalInvert(GoalFollow), whose negated heuristic A* can
// not bound, so "away from overhead" resolved to DOWN, into the pit's
// gravel/water floor: frozen `at=`, spin_abort, and an identical
// unreachable:GoalInvert:-6,68,5 every 20s cooldown, while dig_in refused
// ("capping where I stand"). Both escape legs aimed into the one direction the
// pit makes inescapable.
//
// This pins the opposite: a flee is a MAP move. It never biases down, it aims
// OUT of a hard pocket, and when no flat escape exists it says so instead of
// thrashing.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { fleeTargetFor } from './flee_target.js';
import { inHardPocket } from './water_aware_path.js';

test('the pinned check-in scenario flees OUT of the pit, level, not down', () => {
    const bot = { x: -6, y: 46, z: 10 };
    const drownedAbove = { x: -6, y: 68, z: 5 };
    const targets = fleeTargetFor(bot, drownedAbove, 17);

    assert.ok(targets.length >= 1, 'there is a flat escape from this pit; it must be offered');
    // Same x (the threat is directly overhead in x), same y, +z away in z.
    // 10 + 17 = 27, which is outside NEAR_SPAWN_PIT_BOX (zMax 12) -- the escape
    // leaves the pit rather than sliding along its floor.
    assert.deepEqual(targets[0], { x: -6, y: 46, z: 27 });
    assert.ok(!inHardPocket(targets[0]), 'the first escape point is not inside a hard pocket');
    // The bug was a dive. No offered point may sit below the bot's own level.
    assert.ok(targets.every(t => t.y >= 46), 'a flee never aims below where the bot stands');
});

test('a threat directly overhead still gives a deterministic flat heading', () => {
    // Horizontal delta ~0: there is no single "away", so the fixed fan decides
    // -- not Math.random, which would make the flee unreproducible.
    const targets = fleeTargetFor({ x: -6, y: 46, z: 10 }, { x: -6.1, y: 68, z: 10.1 }, 16);
    assert.deepEqual(targets[0], { x: 10, y: 46, z: 10 }, 'fan heading +x is chosen first');
    const again = fleeTargetFor({ x: -6, y: 46, z: 10 }, { x: -6.1, y: 68, z: 10.1 }, 16);
    assert.deepEqual(again, targets, 'no randomness: the same inputs give the same escape');
});

test('escape points that land inside a hard pocket are dropped', () => {
    // Cave-ring bot (inside DEATH_POCKET_BOX), threat overhead: +x/-x at 16
    // blocks both stay in the ring, but -16 in x exits it (xMax is -5).
    const bot = { x: -44, y: 55, z: 89 };
    const targets = fleeTargetFor(bot, { x: -44, y: 75, z: 89 }, 16);
    assert.ok(targets.length > 0 && targets.length < 9, 'some headings are in-pocket and got dropped');
    assert.ok(targets.every(t => !inHardPocket(t)), 'no offered point is inside a hard pocket');
});

test('deep in the flooded cave ring, running on the level honestly yields nothing', () => {
    // Center of the cave ring: every flat heading at 16 blocks stays inside it.
    // Returning [] is the caller's signal that fleeing cannot help -- fight, dig
    // in, or put a door between you -- rather than a fake direction to thrash on.
    const targets = fleeTargetFor({ x: -25, y: 54, z: 89 }, { x: -25.2, y: 70, z: 89.2 }, 16);
    assert.deepEqual(targets, [], 'no flat, in-the-clear escape exists inside the ring');
});

test('garbage in returns an empty list and never throws', () => {
    for (const [pos, threat] of [
        [null, { x: 0, y: 0, z: 0 }],
        [{ x: 0, y: 0, z: 0 }, null],
        [{ x: NaN, y: 4, z: 5 }, { x: 1, y: 2, z: 3 }],
        [undefined, undefined],
    ]) {
        assert.deepEqual(fleeTargetFor(pos, threat, 16), [], 'bad input degrades to no-escape, not a throw');
    }
});
