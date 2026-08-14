// dig_in fires wherever the bot happens to stand, and the respawn tile is the
// one place a hole must never be: the bot reappears above its own shaft, falls
// in, and cannot climb out. Two independent spawn points were destroyed this
// way in one night -- the second through ground verified solid two hours
// earlier -- ending in nine fall deaths at (-242,76,252).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONDITIONS } from './policy.js';

const at = (x, y, z) => ({
    position: { x, y, z, distanceTo: (p) => Math.hypot(x - p.x, y - p.y, z - p.z) },
});
const bot = (pos, respawn) => ({ bot: { entity: pos, respawn_point: respawn } });

test('standing on the respawn tile counts as near it', () => {
    const agent = bot(at(0, 64, 0), { x: 0, y: 64, z: 0 });
    assert.equal(CONDITIONS.near_respawn.fn(agent, {}), true);
});

test('far from the respawn tile does not', () => {
    const agent = bot(at(40, 64, 0), { x: 0, y: 64, z: 0 });
    assert.equal(CONDITIONS.near_respawn.fn(agent, {}), false);
});

test('the range is the caller\'s to set', () => {
    const agent = bot(at(10, 64, 0), { x: 0, y: 64, z: 0 });
    assert.equal(CONDITIONS.near_respawn.fn(agent, { range: 8 }), false);
    assert.equal(CONDITIONS.near_respawn.fn(agent, { range: 16 }), true);
});

test('no respawn point yet is not "near" anything', () => {
    // Before the first spawn there is nothing to compare against, and a
    // condition that answered true there would ban digging everywhere.
    const agent = bot(at(0, 64, 0), undefined);
    assert.equal(CONDITIONS.near_respawn.fn(agent, {}), false);
});
