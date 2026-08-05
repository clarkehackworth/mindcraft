// Run: node src/agent/library/goto_no_path.test.js
// Andy wanted an oak_log that searchForBlock reported 36 blocks out and 44 up
// inside a mountain. Both path probes said "no path", goToGoal walked at it
// anyway with destructive movements, and the bot spent minutes hopping against
// the roof of its own shelter while the LLM retried the same target forever.
import assert from 'assert';
import { Vec3 } from 'vec3';
import prismarine_registry from 'prismarine-registry';
import { useRegistry } from '../../utils/mcdata.js';
import * as skills from './skills.js';

// pf.Movements(bot) builds a real prismarine-block provider off the registry,
// so give it a real one rather than a stub.
const registry = prismarine_registry('1.20.1');
useRegistry(registry); // normally set on the bot's login event

function fakeBot(path_status) {
    const bot = {
        registry,
        entity: { position: new Vec3(-19.5, 72, -10.5) },
        interrupt_code: false,
        output: '',
        went: false,
        inventory: { items: () => [] },
        modes: { isOn: () => false },
        blockAt: () => null,
        findBlocks: () => [],
        emit: () => {},
        pathfinder: {
            setMovements: () => {},
            getPathTo: () => ({ status: path_status, path: [] }),
            goto: async () => { bot.went = true; },
        },
    };
    return bot;
}

const goal = { x: -104, y: 116, z: 1 }; // pathfinder is stubbed, so any goal will do

// No path either way: fail fast instead of walking at it.
const unreachable = fakeBot('noPath');
await assert.rejects(
    () => skills.goToGoal(unreachable, goal),
    /No path/,
    'an unreachable goal is an error the agent can react to, not a walk attempt'
);
assert.equal(unreachable.went, false, 'never hand an unreachable goal to pathfinder');

// Path exists: unchanged behaviour.
const reachable = fakeBot('success');
assert.equal(await skills.goToGoal(reachable, goal), true);
assert.equal(reachable.went, true);

// moveAway swallows the new throw: an escape that cannot path is a failed
// escape, not an exception for its callers (unstuck mode) to handle.
const cornered = fakeBot('noPath');
assert.equal(await skills.moveAway(cornered, 6), false);
assert.match(cornered.output, /nowhere to go/);

// A probe that ran out of search budget is not a wall. Andy's server has 17k
// block types, so every 3s probe to his own base 30 blocks away came back
// 'timeout' and goToGoal refused to take a step -- he spent a whole night
// asking for the same coordinates with a wider and wider tolerance.
const slow = fakeBot('timeout');
assert.equal(await skills.goToGoal(slow, goal), true, 'a slow search still gets walked');
assert.equal(slow.went, true);
assert.match(slow.output, /replanning/);

console.log('ok: goToGoal refuses unreachable goals instead of thrashing');

// A Vec3 is not a Goal, and every pathfinder entry point that takes one must
// say so rather than dying inside the pathfinder. goto and setGoal were guarded
// first; getPathTo was missed, and goToGoal calls THAT one first -- so generated
// code doing goToGoal(bot, new Vec3(...)) threw "goal.heuristic is not a
// function" with nothing pointing at the real mistake.
import { strict as assert2 } from 'node:assert';
import { readFileSync as read2 } from 'node:fs';
{
    const guard = read2(new URL('../../utils/mcdata.js', import.meta.url), 'utf8');
    for (const method of ['goto', 'getPathTo', 'setGoal'])
        assert2.match(guard, new RegExp(`notAGoal\\('${method}'\\)`), `${method} rejects a non-Goal`);
    // The three methods pathfinder actually calls on a goal. Checking only two
    // is what let the Vec3 through.
    for (const m of ['isEnd', 'isValid', 'heuristic'])
        assert2.match(guard, new RegExp(`typeof g\\.${m} === 'function'`), `a Goal must have ${m}`);
    console.log('ok: every pathfinder goal entry point rejects a non-Goal');
}
