// Run: node src/agent/library/maroon.test.js
// Andy mined out everything within four blocks of himself and ended up on a 1x1
// pillar at (7,80,3) over a 7-block void, empty inventory, no path anywhere. He
// retried the same escape for five hours. Digging now refuses the break that
// takes the last foothold away.
import assert from 'assert';
import { Vec3 } from 'vec3';
import { wouldMaroon } from './skills.js';

// Only the listed positions are solid; everything else is air.
function fakeBot(feet, solids) {
    const solid = new Set(solids.map(([x, y, z]) => `${x},${y},${z}`));
    return {
        entity: { position: feet },
        blockAt: (p) => solid.has(`${p.x},${p.y},${p.z}`)
            ? { name: 'stone', boundingBox: 'block' }
            : { name: 'air', boundingBox: 'empty' },
    };
}

// The pillar, one foothold left at (8,79,3). Taking it maroons him.
const pillar = fakeBot(new Vec3(7.5, 80, 3.5), [[7, 79, 3], [8, 79, 3]]);
assert.equal(wouldMaroon(pillar, new Vec3(8, 79, 3)), true, 'the last foothold is not diggable');

// Two footholds: taking one still leaves the other, so it is allowed.
const two = fakeBot(new Vec3(7.5, 80, 3.5), [[7, 79, 3], [8, 79, 3], [6, 79, 3]]);
assert.equal(wouldMaroon(two, new Vec3(8, 79, 3)), false, 'a spare foothold keeps digging legal');

// A wall or a ceiling was never a foothold, even standing on the bare pillar.
assert.equal(wouldMaroon(pillar, new Vec3(8, 81, 3)), false, 'breaking overhead cannot strand you');
assert.equal(wouldMaroon(pillar, new Vec3(8, 82, 3)), false, 'breaking a ceiling cannot strand you');

// digDown: a 1x1 shaft in solid rock is enclosed, not marooned -- the walls are
// something to dig into, so mining the floor out from under yourself is fine.
const shaft = [];
for (let x = -1; x <= 1; x++)
    for (let z = -1; z <= 1; z++)
        for (let y = 8; y <= 11; y++)
            if (x !== 0 || z !== 0 || y < 10) shaft.push([x, y, z]);
const mine = fakeBot(new Vec3(0.5, 10, 0.5), shaft);
assert.equal(wouldMaroon(mine, new Vec3(0, 9, 0)), false, 'ordinary mining is untouched');

// Flat ground: neighbours are floor, so nothing here is the last foothold.
const ground = [];
for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) ground.push([x, 63, z]);
const field = fakeBot(new Vec3(0.5, 64, 0.5), ground);
assert.equal(wouldMaroon(field, new Vec3(1, 63, 0)), false, 'digging in open ground is untouched');

console.log('ok: digging refuses the break that strands the bot on a pillar');
