// Run: node src/agent/library/moveaway.test.js
// Andy mined a moat around himself and ended up on a 1x1 pillar over a 7-block
// void with an empty inventory. !moveAway(6) reported "Moved away from (7,80,3)
// to (7,80,3)" and returned true, so he retried the same escape for hours.
import assert from 'assert';
import { Vec3 } from 'vec3';
import prismarine_registry from 'prismarine-registry';
import { useRegistry } from '../../utils/mcdata.js';
import * as skills from './skills.js';

// pf.Movements(bot) builds a real prismarine-block provider off the registry,
// so give it a real one rather than a stub.
const registry = prismarine_registry('1.20.1');
useRegistry(registry); // normally set on the bot's login event

function fakeBot(start, end, path_status = 'noPath') {
    const position = start.clone();
    return {
        registry,
        entity: { position },
        interrupt_code: false,
        output: '',
        inventory: { items: () => [] },
        modes: { isOn: () => false },
        blockAt: () => null,
        findBlocks: () => [],
        emit: () => {},
        pathfinder: {
            setMovements: () => {},
            getPathTo: () => ({ status: path_status, path: [] }),
            // Whatever pathfinder managed, it resolves; the bot lands at `end`.
            goto: async () => { position.set(end.x, end.y, end.z); },
        },
    };
}

// Stranded: goto resolves but the bot never left the pillar.
const stuck = fakeBot(new Vec3(7.5, 80, 3.5), new Vec3(7.5, 80, 3.5));
assert.equal(await skills.moveAway(stuck, 6), false, 'a bot that did not move has not moved away');
assert.match(stuck.output, /nowhere to go/, 'the failure says why, so the agent tries something else');

// Actually moved: still reports success, and the "from" is the old position,
// not a live reference that followed the bot.
const moved = fakeBot(new Vec3(7.5, 80, 3.5), new Vec3(20.5, 80, 3.5), 'success');
assert.equal(await skills.moveAway(moved, 6), true);
assert.match(moved.output, /from \(7, 80, 3\) to \(20, 80, 3\)/, 'the log shows both ends of the move');

// An inverted goal makes getPathTo report 'noPath' even on open ground, because
// GoalInvert negates the heuristic and A* cannot bound the search. Routing the
// escape through goToGoal's probe therefore refused to take a single step: every
// "I'm dying!" in Andy's log answered "nowhere to go" while he stood on grass.
const open_ground = fakeBot(new Vec3(7.5, 72, 3.5), new Vec3(27.5, 72, 3.5), 'noPath');
assert.equal(await skills.moveAway(open_ground, 20), true, 'a failed probe must not veto walking');

console.log('ok: moveAway fails loudly when the bot is stranded');
