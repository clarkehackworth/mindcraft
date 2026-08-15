// Run: node --test src/agent/library/climb_out.test.js
// Andy's shelter rule dug down three blocks, found no torch to place, and left
// him at the bottom of a one-wide shaft. From there the pathfinder cannot plan a
// route out, so it returns partial paths forever: 1,607 replans in four minutes,
// all from -24,65,-6, and nothing else in the log. give_up_on_a_stuck_path fired
// three times and each time called move_away -- which is pathfinder-based, and
// failed the same way. Every escape route ran through the broken thing.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { Vec3 } from 'vec3';
import registryFor from 'prismarine-registry';
import { useRegistry } from '../../utils/mcdata.js';
import { climbOut, moveAway } from './skills.js';

// moveAway and goToGoal both build a real pf.Movements, which reads the block
// registry. Nothing here depends on the block table, but a stub of it would be
// longer than the real thing.
const registry = registryFor('1.20.1');
useRegistry(registry);

// A bot in a pit: pathfinder.goto never moves it, but a one-block-up GoalBlock
// does, because that is a search A* can always solve.
function pitBot({ floor_y = 65, out_y = 68, can_climb = true } = {}) {
    const bot = {
        entity: { position: new Vec3(-24.5, floor_y, -6.5) },
        interrupt_code: false,
        modes: { isOn: () => false },
        output: '',
        registry,
        inventory: { items: () => [] },
        pathfinder: {
            setMovements: () => {},
            // goToGoal probes before it walks. In a real pit the one-block-up
            // goal is the only one that comes back 'success', because it is the
            // only one the pathfinder can solve by placing a block and jumping.
            getPathTo: (movements, goal) => ({
                status: can_climb && goal?.y === Math.floor(bot.entity.position.y) + 1
                    ? 'success' : 'noPath',
            }),
            goto: async (goal) => {
                // GoalBlock one block up is the only goal that resolves in here.
                const y = goal?.y;
                if (y !== undefined && can_climb && bot.entity.position.y < out_y
                    && y === Math.floor(bot.entity.position.y) + 1) {
                    bot.entity.position = bot.entity.position.offset(0, 1, 0);
                    return;
                }
                if (bot.entity.position.y >= out_y) {
                    // Out of the hole: an ordinary escape routes fine again.
                    bot.entity.position = bot.entity.position.offset(12, 0, 5);
                    return;
                }
                throw new Error('NoPath');
            },
        },
    };
    return bot;
}

test('climbing out of a three-deep shaft gains height', async () => {
    const bot = pitBot();
    assert.equal(await climbOut(bot), true);
    assert.equal(bot.entity.position.y, 68, 'three one-block hops, no pathfinding required');
});

test('a bot with nothing to climb with says so instead of looping', async () => {
    // Out of blocks, out of pickaxe: the first hop gains nothing, so there is no
    // point taking the second. This is the branch that has to stay honest --
    // reporting a climb that did not happen is how move_away used to tell a
    // stranded bot it had escaped.
    const bot = pitBot({ can_climb: false });
    assert.equal(await climbOut(bot), false);
    assert.equal(bot.entity.position.y, 65);
});

test('move_away climbs out of the pit and then actually moves away', async () => {
    const bot = pitBot();
    const start = bot.entity.position.clone();
    assert.equal(await moveAway(bot, 24), true, 'stranded is recoverable, not terminal');
    assert.ok(bot.entity.position.distanceTo(start) >= 1, 'and it ends up somewhere else');
});

test('climbing straight up is not moving away', async () => {
    // Once climbOut was in the picture the bot could satisfy a 3-D distance
    // check by going nowhere: it climbed two blocks out of a pit, reported
    // "Moved away from (-30,14,-5) to (-30,16,-5)", fell back in, and reported
    // that as a move too. It bounced 14,15,16,17,16,15,14 over one column for
    // ten minutes, and every bounce cleared path_stuck so nothing escalated.
    const bot = pitBot();
    // Out of the hole the retry still routes nowhere horizontally -- all the
    // displacement on offer is the climb itself.
    bot.pathfinder.goto = async (goal) => {
        const y = goal?.y;
        if (y !== undefined && y === Math.floor(bot.entity.position.y) + 1) {
            bot.entity.position = bot.entity.position.offset(0, 1, 0);
            return;
        }
        throw new Error('NoPath');
    };
    assert.equal(await moveAway(bot, 24), false, 'straight up is not away');
    assert.match(bot.output, /nowhere to go/);
});

test('move_away still reports failure when the climb cannot help', async () => {
    const bot = pitBot({ can_climb: false });
    assert.equal(await moveAway(bot, 24), false);
    assert.match(bot.output, /nowhere to go/);
});
