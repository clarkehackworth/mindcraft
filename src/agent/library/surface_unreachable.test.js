// Run: node src/agent/library/surface_unreachable.test.js
// Andy sat pinned at y=54 under a mountain for hours. goToSurface picked the
// top of the column (y=71), goToPosition said "Unable to reach, you are 17
// blocks away" 30 times over, and goToSurface returned true anyway. The pinned
// "interrupts: all" drowning rule read that as progress, so its backoff never
// grew and it re-fired every 5s forever -- nothing else in the policy, and not
// even unstuck mode, ever got a turn.
import assert from 'assert';
import { Vec3 } from 'vec3';
import prismarine_registry from 'prismarine-registry';
import { useRegistry } from '../../utils/mcdata.js';
import * as skills from './skills.js';

const registry = prismarine_registry('1.20.1');
useRegistry(registry);

function fakeBot(path_status) {
    const bot = {
        registry,
        entity: { position: new Vec3(-19.5, 54, -11.5) },
        interrupt_code: false,
        output: '',
        inventory: { items: () => [] },
        modes: { isOn: () => false },
        // Solid stone capping the column at y=70, air everywhere above.
        blockAt: (pos) => ({
            name: pos.y <= 70 ? 'stone' : 'air',
            position: new Vec3(pos.x, pos.y, pos.z),
        }),
        findBlocks: () => [],
        emit: () => {},
        pathfinder: {
            setMovements: () => {},
            getPathTo: () => ({ status: path_status, path: [] }),
            goto: async () => {
                if (path_status !== 'success') throw new Error('stuck');
                bot.entity.position = new Vec3(-19.5, 71, -11.5);
            },
        },
    };
    return bot;
}

// Walled in with no way to climb: say so, so the rule backs off.
const walled = fakeBot('noPath');
assert.equal(await skills.goToSurface(walled), false,
    'a surface we never reached is not a trip to the surface');
assert.match(walled.output, /Could not dig up past y=54/);

// Clear water above: unchanged behaviour.
const open = fakeBot('success');
assert.equal(await skills.goToSurface(open), true);
assert.match(open.output, /Going to the surface at y=71/);

// Sealed under stone: the whole-route search fails, but each single block up
// succeeds. Andy sat at y=55 with 75 cobblestone and a pickaxe for hours
// because the first noPath was the end of the story.
const sealed = fakeBot('noPath');
let step = 0;
sealed.pathfinder.getPathTo = () => ({ status: step++ === 0 ? 'noPath' : 'success', path: [] });
sealed.pathfinder.goto = async (goal) => {
    // Only a one-block-up goal is solvable; the full climb is not.
    if (goal.y !== Math.floor(sealed.entity.position.y) + 1) throw new Error('stuck');
    sealed.entity.position = new Vec3(-19.5, goal.y, -11.5);
};
assert.equal(await skills.goToSurface(sealed), true,
    'a bot that can dig one block up can dig seventeen');
assert.equal(Math.floor(sealed.entity.position.y), 71);
assert.match(sealed.output, /Dug up to the surface at y=71/);

// A treetop is not the surface: aiming at one is what made the climb fail.
const wooded = fakeBot('success');
wooded.blockAt = (p) => ({
    name: p.y <= 70 ? 'stone' : p.y <= 85 ? 'pine_leaves' : 'air',
    position: new Vec3(p.x, p.y, p.z),
});
assert.equal(await skills.goToSurface(wooded), true);
assert.match(wooded.output, /Going to the surface at y=71/,
    'the ground under the tree, not the top of it');

console.log('ok: goToSurface digs out instead of faking progress or aiming at treetops');

// Water in the ceiling: the first live climb out of a cave broke into an
// aquifer and drowned. Step the shaft sideways to a dry column and carry on.
// The pool here sits over x <= -18, so the dry ground starts one block east.
const pool = fakeBot('noPath');
let pool_step = 0;
pool.blockAt = (p) => ({
    name: (p.y === 56 && p.x <= -18) ? 'water' : p.y <= 70 ? 'stone' : 'air',
    position: new Vec3(p.x, p.y, p.z),
});
pool.pathfinder.getPathTo = () => ({ status: pool_step++ === 0 ? 'noPath' : 'success', path: [] });
pool.pathfinder.goto = async (goal) => {
    const at = pool.entity.position.floored();
    const one_up = goal.y === at.y + 1 && goal.x === at.x && goal.z === at.z;
    const sideways = goal.y === at.y;
    if (!one_up && !sideways) throw new Error('stuck');
    pool.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
};
assert.equal(await skills.goToSurface(pool), true,
    'a wet ceiling is a reason to move over, not to give up');
assert.match(pool.output, /water above y=54; moving the shaft to -17/);
assert.equal(pool.entity.position.x, -16.5, 'the shaft ends up clear of the pool');
assert.equal(Math.floor(pool.entity.position.y), 71);

// Under open water in every direction: nothing to do but say so.
const submerged = fakeBot('noPath');
submerged.blockAt = (p) => ({
    name: p.y === 56 ? 'water' : p.y <= 70 ? 'stone' : 'air',
    position: new Vec3(p.x, p.y, p.z),
});
assert.equal(await skills.goToSurface(submerged), false);
assert.match(submerged.output, /no dry column within 4 blocks/);

console.log('ok: goToSurface detours around an aquifer instead of drowning in it');
