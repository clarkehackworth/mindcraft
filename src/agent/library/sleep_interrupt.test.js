// Run: node src/agent/library/sleep_interrupt.test.js
// goToBed waited out the whole night in a loop that checked nothing, so the
// ActionManager's 10s grace expired and it abandoned the action:
//   action "mode:policy:shelter_at_night" ignored the interrupt for 10s, abandoning it
// That is the rule that keeps the bot alive at night, so losing it costs a death.
import assert from 'assert';
import { Vec3 } from 'vec3';
import * as skills from './skills.js';

function sleepingBot() {
    const bot = {
        interrupt_code: false,
        isSleeping: false,
        woke: false,
        output: '',
        entity: { position: new Vec3(0, 72, 0) },
        modes: { pause: () => {}, isOn: () => false },
        findBlocks: () => [new Vec3(2, 72, 0)],
        blockAt: () => ({ name: 'red_bed', position: new Vec3(2, 72, 0) }),
        sleep: async function () { this.isSleeping = true; },
        wake: async function () { this.isSleeping = false; this.woke = true; },
        pathfinder: { setMovements: () => {}, setGoal: () => {}, goto: async () => {}, getPathTo: () => ({ status: 'success' }), isMoving: () => false },
        emit: () => {},
        on: () => {},
        removeListener: () => {},
    };
    return bot;
}

const bot = sleepingBot();
// Interrupt lands while the bot is in bed, the way a mob or a new order does.
const sleeping = skills.goToBed(bot);
await new Promise(r => setTimeout(r, 50));
assert.equal(bot.isSleeping, true, 'precondition: the bot got into bed');
bot.interrupt_code = true;

const finished = await Promise.race([
    sleeping.then(() => 'returned'),
    new Promise(r => setTimeout(() => r('hung'), 3000)),
]);

assert.equal(finished, 'returned', 'the sleep loop must notice the interrupt, well inside the 10s grace');
assert.equal(bot.woke, true, 'and get out of bed, or the next action moves a sleeping bot');

console.log('ok: an interrupted sleep wakes up instead of being abandoned');
process.exit(0);
