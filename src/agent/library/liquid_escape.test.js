// Run: node src/agent/library/liquid_escape.test.js
// Andy fell into a 2-block flooded pocket at (81,60,-124). Pathfinder has no
// swim move, so every goal came back "path not found" while dry land sat one
// block away, and teleporting him to the lip of the hole just let him walk back
// in. escapeLiquid steers out by hand.
import assert from 'assert';
import { Vec3 } from 'vec3';
import { escapeLiquid, isInLiquid } from './skills.js';

// Only the listed positions are solid ground; `water` is the flooded set.
function fakeBot(feet, solids, waters = []) {
    const key = (x, y, z) => `${x},${y},${z}`;
    const solid = new Set(solids.map(([x, y, z]) => key(x, y, z)));
    const wet = new Set(waters.map(([x, y, z]) => key(x, y, z)));
    return {
        entity: { position: feet },
        interrupt_code: false,
        output: '',
        controls: {},
        setControlState(name, on) { this.controls[name] = on; },
        looked: [],
        lookAt(p) { this.looked.push(p); return Promise.resolve(); },
        blockAt(p) {
            const k = key(p.x, p.y, p.z);
            if (solid.has(k)) return { name: 'stone', boundingBox: 'block' };
            if (wet.has(k)) return { name: 'water', boundingBox: 'empty' };
            return { name: 'air', boundingBox: 'empty' };
        },
    };
}

// The real pocket: water at (81,60,-124) walled in. Two dry landings are in
// range; the nearest, (80,61,-124), is the one it must pick.
const pocket = [[81, 60, -124], [82, 60, -124]];
const floor = [[81, 59, -124], [82, 59, -124], [79, 60, -124], [80, 60, -124]];
// -123.7 floors to -124: the block coordinate is one lower than it reads.
const dry = fakeBot(new Vec3(81.6, 60.2, -123.7), floor, pocket);
assert.equal(isInLiquid(dry), true, 'feet in a water block counts as in liquid');

// The bot climbs out partway through, as the real one would once it floats up.
setTimeout(() => { dry.entity.position.set(80.5, 61, -123.5); }, 300);
assert.equal(await escapeLiquid(dry), true);
assert.match(dry.output, /Swam out of the liquid/, 'success is reported');
assert.deepEqual(dry.looked[0], new Vec3(80.5, 61, -123.5), 'it aims at the dry landing');
assert.equal(dry.controls.jump, false, 'controls are released on the way out');
assert.equal(dry.controls.forward, false);

// Not in liquid at all: escapeLiquid declines so the caller falls back to moveAway.
const onLand = fakeBot(new Vec3(0.5, 64, 0.5), [[0, 63, 0]]);
assert.equal(await escapeLiquid(onLand), false, 'a dry bot is not this function to fix');
assert.deepEqual(onLand.controls, {}, 'and its controls are left alone');

// Sealed in water with no dry ground in range: give up, but say what to try.
const sealed = [];
for (let x = -9; x <= 9; x++) for (let z = -9; z <= 9; z++) for (let y = 58; y <= 66; y++) sealed.push([x, y, z]);
const drowning = fakeBot(new Vec3(0.5, 60, 0.5), [], sealed);
assert.equal(await escapeLiquid(drowning), false);
assert.match(drowning.output, /no dry ground within 8 blocks/, 'the dead end is explained, not silent');
assert.equal(drowning.controls.jump, undefined, 'no point swimming nowhere');

console.log('ok: escapeLiquid swims out of pockets pathfinder cannot leave');
