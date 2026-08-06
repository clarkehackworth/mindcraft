// Run: node src/agent/library/place_no_path.test.js
// Live bug: !placeHere("furnace") with the bot standing on the target spot tried
// to step back, pathfinder found no route, and the raw
//   NoPath: No path to the goal!
//     at error (/app/node_modules/mineflayer-pathfinder/lib/goto.js:2:15) ...
// went straight to the agent as a stack trace. Every other failure in placeBlock
// logs a sentence and returns false; these two paths threw instead.
import assert from 'assert';
import { useRegistry } from '../../utils/mcdata.js';
import minecraftData from 'minecraft-data';

const registry = minecraftData('1.20.1');
useRegistry(registry);

const { placeBlock } = await import('./skills.js');

function botStandingOnTarget() {
    const pos = { x: 9, y: 55, z: 5 };
    pos.plus = (v) => ({ ...pos, y: pos.y + v.y, distanceTo: () => 0.5 });
    pos.distanceTo = () => 0.5; // on top of the target: triggers the step-back
    return {
        entity: { position: pos },
        // Solid ground under the target so placeBlock gets past "nothing to place on".
        blockAt: (p) => ({ name: p && p.y < 55 ? 'stone' : 'air', position: p }),
        inventory: { items: () => [{ name: 'furnace', type: 280 }], count: () => 1, slots: [],
                     findInventoryItem: () => ({ name: 'furnace', type: 280 }) },
        modes: { isOn: () => false },
        registry,
        pathfinder: {
            setMovements: () => {},
            goto: async () => { throw new Error('NoPath: No path to the goal!'); },
            getPathTo: () => ({ status: 'noPath' }),
        },
        equip: async () => {},
        placeBlock: async () => {},
        lookAt: async () => {},
        setControlState: () => {},
        output: '',
        interrupt_code: false,
        emit: () => {},
        chat: () => {},
    };
}

const bot = botStandingOnTarget();
let threw = null, result;
try { result = await placeBlock(bot, 'furnace', 9, 55, 5); }
catch (e) { threw = e; }

assert.equal(threw, null, `placeBlock must not leak a pathfinder exception: ${threw && threw.message}`);
assert.equal(result, false, 'a place it cannot reach reports failure');
assert.doesNotMatch(bot.output, /NoPath|node_modules/, 'no stack trace reaches the agent');
assert.match(bot.output, /Cannot place furnace/, 'the agent is told what is wrong in words');

console.log('ok: placeBlock reports an unreachable spot instead of throwing NoPath at the agent');
process.exit(0);
