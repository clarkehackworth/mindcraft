// EVT digabort:by:resetPath <- bot.pathfinder.setGoal
//
// mineflayer-pathfinder cancels the dig in flight on every goal change, and
// bot.targetDigBlock is global to the bot -- so any rule that walks somewhere
// cancels whatever else was digging. Measured twice: a drowning rescue's
// ceiling dig restarted from zero about once a second through a fatal
// drowning, and later
//     Rule 'active:flee_ranged_raiders' step dig_in failed: Digging aborted
// on a bot at 15/60 health pinned by a stray, dig_in being its only escape.
//
// The first fix guarded only the drowning rescue. This one covers every dig a
// skill deliberately starts, which is what the evidence had said all along.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { protectDeliberateDigs } from './mcdata.js';
import { protectedDig } from '../agent/library/skills.js';

// digging.js reassigns bot.stopDigging per dig and sets it to noop between
// digs, so the guard has to survive reassignment.
function botDigging({ onDig } = {}) {
    const bot = { aborted: 0, dug: 0 };
    protectDeliberateDigs(bot);
    bot.stopDigging = () => { bot.aborted++; };
    bot.dig = async (...args) => { bot.dug++; if (onDig) await onDig(bot, ...args); };
    return bot;
}

test('the pathfinder may still cancel its own path steps', async () => {
    const bot = botDigging();
    bot.stopDigging();
    assert.equal(bot.aborted, 1, 'nothing is protected when no skill is digging');
});

test('a deliberate dig is not cancellable while it runs', async () => {
    // The goal change lands mid-dig, which is exactly when it did in the world.
    const bot = botDigging({ onDig: (b) => { b.stopDigging(); b.stopDigging(); } });
    await protectedDig(bot, { name: 'stone' });
    assert.equal(bot.dug, 1);
    assert.equal(bot.aborted, 0, 'a goal change does not get to cancel it');
});

test('protection ends with the dig, and is not latched on', async () => {
    const bot = botDigging();
    await protectedDig(bot, { name: 'stone' });
    bot.stopDigging();
    assert.equal(bot.aborted, 1, 'afterwards, cancels are honoured again');
});

test('a throwing dig still releases the protection', async () => {
    const bot = botDigging({ onDig: () => { throw new Error('Digging aborted'); } });
    await assert.rejects(() => protectedDig(bot, { name: 'stone' }));
    bot.stopDigging();
    assert.equal(bot.aborted, 1, 'a failed dig cannot leave the bot uncancellable');
});

test('overlapping digs do not have the inner one unprotect the outer', async () => {
    // A counter, not a boolean. dig_in breaking three blocks while the drowning
    // reflex starts its own dig is two claims on the same guard.
    const bot = botDigging({
        onDig: async (b, block) => {
            if (block.name === 'outer') {
                await protectedDig(b, { name: 'inner' });
                b.stopDigging();   // still inside the outer dig
            }
        },
    });
    await protectedDig(bot, { name: 'outer' });
    assert.equal(bot.dug, 2);
    assert.equal(bot.aborted, 0, 'the outer dig kept its protection');
    bot.stopDigging();
    assert.equal(bot.aborted, 1, 'and both released at the end');
});
