// dig_in answered "I need shelter" with "go deeper" once too often. isSheltered
// already stops it re-digging from inside a capped hole; this is the other loop:
//
//   dig_in caps the hole
//   climb_out_of_the_deep breaks the cap to escape, then reports
//     "Could not climb out: gained no height, nothing to pillar with"
//   the bot is now UNSHELTERED at the bottom of its own shaft
//   dig_in fires again -> three blocks deeper
//
// Measured over one hour: y=68 -> 52, and the shaft opened into flooded cave.
// All five drown deaths in that window were down there.
//
// No mocking: this Node has no ESM module mock, and t.mock.method cannot
// redefine a module export. The stub instead makes digDown run off the end of
// the world immediately, so "did it try to dig" is readable from the log.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { ACTIONS } from './policy.js';
import Vec3 from 'vec3';

const DUG = /end of the world/i;   // digDown ran
const CAPPED = /below home/i;      // the depth floor stopped it

function agentAt(y, { home_y = 71 } = {}) {
    const bot = {
        entity: { position: new Vec3(9, y, 5) },
        home_point: { x: 9, y: home_y, z: 5 },
        // Air overhead, so isSheltered is false and dig_in gets as far as the
        // depth decision. digDown then asks for the blocks under its start
        // position, and those read as unloaded -- which digDown reports and
        // returns from, without needing a world to dig.
        blockAt: (p) => (p === null ? null
            : { name: 'air', position: { offset: () => null } }),
        inventory: { items: () => [] },   // nothing to cap or torch with
        output: '',
    };
    return { bot };
}

test('at the surface it still digs in', async () => {
    const { bot } = agentAt(70);
    assert.equal(await ACTIONS.dig_in.fn({ bot }), true);
    assert.match(bot.output, DUG, 'one block above home is a normal foxhole');
    assert.doesNotMatch(bot.output, CAPPED);
});

test('deep below home it caps instead of descending', async () => {
    const { bot } = agentAt(55);
    assert.equal(await ACTIONS.dig_in.fn({ bot }), true);
    assert.doesNotMatch(bot.output, DUG, 'sixteen blocks under home is not a place to dig down');
    assert.match(bot.output, CAPPED, 'and it says why, so a no-op is not mistaken for a dig');
});

test('the floor is measured from home, not from an absolute y', async () => {
    // A base in a mountain valley and a base on a plateau are different worlds;
    // the anchor is the only thing that knows which one this is.
    const { bot } = agentAt(55, { home_y: 60 });
    assert.equal(await ACTIONS.dig_in.fn({ bot }), true);
    assert.match(bot.output, DUG, 'y=55 is shallow when home is y=60');
});

test('the ratchet terminates instead of running to bedrock', async () => {
    // The point is not that it digs once -- from the surface it legitimately
    // takes a few foxholes to reach the floor. The point is that it STOPS. The
    // measured failure dug every time it fired, for an hour, y=68 down to y=52
    // and still going.
    let y = 70, digs = 0;
    for (let cycle = 0; cycle < 40; cycle++) {
        const { bot } = agentAt(y);
        await ACTIONS.dig_in.fn({ bot });
        if (DUG.test(bot.output)) { digs++; y -= 3; }
    }
    assert.ok(digs < 40, `it stopped digging: ${digs} of 40 fires dug`);
    // Floor is 8 below home and each foxhole is 3 deep, so the deepest reachable
    // point is home-8-3. Nowhere near the flooded cave layer that drowned it.
    assert.ok(y >= 71 - 11, `bottomed out at y=${y}, not at bedrock`);
});
