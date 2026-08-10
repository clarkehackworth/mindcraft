// A collectBlocks that never returned held Andy for 90 minutes on 2026-08-10:
// alive, logged in, standing still, generating nothing. The log said "abandoning
// it" every ten seconds and meant only that a flag had been cleared -- the await
// on the action's promise was still there, so the self-prompt loop that called
// it never got its turn back. In a soak that reads exactly like a calm bot: zero
// deaths, zero paid turns, zero everything.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { ActionManager } from './action_manager.js';

function managerWithStubAgent() {
    const agent = {
        history: { add() {} },
        bot: { output: '', interrupt_code: false, emit() {}, chat() {} },
        isIdle: () => false,
        cleanKill() {},
        clearBotLogs() {},
        requestInterrupt() {},
    };
    const am = new ActionManager(agent);
    agent.actions = am;
    return am;
}

const never = () => new Promise(() => {});

// The abandonment poll is unref'd, so in a test whose only pending work is that
// poll, node decides it has nothing to do and exits mid-await. A live agent
// always has a socket holding the loop open; here we have to supply one.
function keepLoopAlive() {
    const t = setInterval(() => {}, 50);
    return () => clearInterval(t);
}

test('an action that never returns does not hold its caller forever', async () => {
    const stop = keepLoopAlive();
    try {
    const am = managerWithStubAgent();
    const running = am.runAction('action:collectBlocks', never, { timeout: 0 });
    // Let the action actually register. stop() before executing is set finds
    // nothing to abandon and returns straight away -- a real race, but not the
    // one under test here.
    await new Promise(r => setTimeout(r, 50));
    // Whatever else is going on, stop() is the thing the harness already calls
    // every ten seconds while it says "abandoning it".
    await am.stop();
    const res = await running;
    assert.equal(res.interrupted, true);
    assert.equal(res.success, false);
    } finally { stop(); }
});

test('a replacement action also releases the one it displaced', async () => {
    const stop = keepLoopAlive();
    try {
    const am = managerWithStubAgent();
    const stuck = am.runAction('action:collectBlocks', never, { timeout: 0 });
    await new Promise(r => setTimeout(r, 50));
    const replacement = await am.runAction('action:goToCoordinates', async () => 'arrived', { timeout: 0 });
    const res = await stuck;
    assert.equal(res.interrupted, true);
    assert.equal(replacement.success, true);
    } finally { stop(); }
});

test('an action that finishes normally is unaffected', async () => {
    const am = managerWithStubAgent();
    const res = await am.runAction('action:craft', async () => { am.agent.bot.output = 'made a sword'; }, { timeout: 0 });
    assert.equal(res.success, true);
    assert.equal(res.interrupted, false);
});

test('a failing action still reports its error rather than hanging', async () => {
    const am = managerWithStubAgent();
    const res = await am.runAction('action:boom', async () => { throw new Error('no path'); }, { timeout: 0 });
    assert.equal(res.success, false);
    assert.match(res.message, /no path/);
});
