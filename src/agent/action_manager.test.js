// Run: node src/agent/action_manager.test.js
// Covers the interrupt path: an action that ignores the interrupt must be
// abandoned rather than kill the process, and must not corrupt its replacement.
import assert from 'assert';
import { ActionManager } from './action_manager.js';

function makeAgent() {
    const agent = {
        killed: false,
        bot: {
            output: '',
            interrupt_code: false,
            emit() {},
            stopDigging() {}, pathfinder: { stop() {} }, pvp: { stop() {} },
            collectBlock: { cancelTask() {} },
        },
        history: { add() {} },
        cleanKill() { agent.killed = true; },
        requestInterrupt() { agent.bot.interrupt_code = true; },
        clearBotLogs() { agent.bot.output = ''; agent.bot.interrupt_code = false; },
    };
    return agent;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A cooperative action stops when asked -- the normal case.
async function cooperative() {
    const agent = makeAgent();
    const am = new ActionManager(agent);
    const first = am.runAction('first', async () => {
        while (!agent.bot.interrupt_code) await sleep(5);
    }, { timeout: 0 });
    await sleep(20);
    const second = await am.runAction('second', async () => { agent.bot.output = 'second ran'; }, { timeout: 0 });
    await first;
    assert.equal(agent.killed, false, 'cooperative stop must not kill the process');
    assert.equal(second.interrupted, false, 'second action should run normally');
    assert.equal(am.executing, false, 'manager must be idle afterwards');
}

// The bug: an action that never checks interrupt_code. Used to cleanKill.
async function stubborn() {
    const agent = makeAgent();
    const am = new ActionManager(agent);
    let stubbornDone = false;
    let releaseStubborn;
    const held = new Promise(r => { releaseStubborn = r; });

    const first = am.runAction('stubborn', async () => {
        await held;               // ignores interrupt_code entirely
        stubbornDone = true;
    }, { timeout: 0 });

    await sleep(20);
    const t0 = Date.now();
    const second = await am.runAction('replacement', async () => { await sleep(10); }, { timeout: 0 });
    const waited = Date.now() - t0;

    assert.equal(agent.killed, false, 'a stubborn action must NOT kill the process');
    assert.ok(waited >= 10000 && waited < 13000, `should abandon after the ~10s grace, waited ${waited}ms`);
    assert.equal(second.success, true, 'the replacement action must run');
    assert.equal(stubbornDone, false, 'stubborn is still hanging, i.e. genuinely abandoned');

    // Now let the abandoned action finish. It must not touch the manager.
    const genAfter = am.generation;
    releaseStubborn();
    const firstResult = await first;
    await sleep(20);
    assert.equal(firstResult.interrupted, true, 'abandoned action reports interrupted');
    assert.equal(am.generation, genAfter, 'abandoned action must not bump generation');
    assert.equal(am.executing, false, 'abandoned action must not leave executing set');
}

// A late THROW from an abandoned action must also be contained.
async function stubbornThrows() {
    const agent = makeAgent();
    const am = new ActionManager(agent);
    let boom;
    const held = new Promise((_, rej) => { boom = rej; });
    const first = am.runAction('thrower', async () => { await held; }, { timeout: 0 });
    await sleep(20);

    await am.runAction('replacement', async () => { await sleep(10); }, { timeout: 0 });
    am.resume_func = () => {};           // replacement owns a resume
    am.executing = true;                 // pretend the replacement is still going
    const gen = am.generation;

    boom(new Error('late failure'));
    const r = await first;
    await sleep(20);
    assert.equal(r.interrupted, true, 'late throw reports interrupted');
    assert.equal(am.generation, gen, 'late throw must not bump generation');
    assert.equal(am.executing, true, 'late throw must not clear the replacement executing flag');
    assert.ok(am.resume_func !== null, 'late throw must not cancel the replacement resume');
    assert.equal(agent.killed, false, 'late throw must not kill the process');
}

const t0 = Date.now();
await cooperative();
await stubborn();
await stubbornThrows();
console.log(`ok: stubborn actions are abandoned, not fatal; late returns/throws stay contained (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
process.exit(0);
