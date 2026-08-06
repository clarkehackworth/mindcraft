// Run: node --test src/agent/finish_grace.test.js
// Cancelling a 16-log collect at block 14 threw the whole trip away: drops are
// only banked as they are picked up, the agent read "Collected 0" and concluded
// the trees were unreachable, and the thing that cancelled it was usually the
// model starting a new idea rather than anything dangerous. A non-urgent
// interrupter now waits a moment for a nearly-finished action -- and an urgent
// one still does not.
//
// Note on timings: the cooperative stop polls every 300ms, so even an
// "immediate" interrupt costs about that. The bounds below are around that
// floor, not around zero.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { ActionManager } from './action_manager.js';
import { reportProgress } from './library/skills.js';

function makeAgent() {
    const agent = {
        killed: false,
        bot: {
            output: '', interrupt_code: false, action_progress: null,
            emit() {}, stopDigging() {}, pathfinder: { stop() {} }, pvp: { stop() {} },
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

// A collect that reports done/total and finishes on its own after a moment.
// `state.finished` rather than bot.output: starting an action clears bot.output,
// so the replacement would wipe the very evidence under test.
function collect(agent, { done, total, finish_after_ms }) {
    const state = { finished: false };
    state.fn = async () => {
        reportProgress(agent.bot, done, total);
        const until = Date.now() + finish_after_ms;
        while (Date.now() < until && !agent.bot.interrupt_code) await sleep(5);
        if (!agent.bot.interrupt_code) state.finished = true;
    };
    return state;
}

test('a non-urgent interrupter lets a nearly-finished action land', async () => {
    const agent = makeAgent();
    const am = new ActionManager(agent);
    const c = collect(agent, { done: 15, total: 16, finish_after_ms: 150 });
    const first = am.runAction('collect', c.fn, { timeout: 0 });
    await sleep(20);
    await am.runAction('action:newAction', async () => {}, { timeout: 0, urgent: false });
    await first;
    assert.equal(c.finished, true, 'the collect finished instead of being thrown away');
});

test('an urgent interrupter takes the slot without waiting', async () => {
    // flee/eat/surface must never wait on a woodcutting trip.
    const agent = makeAgent();
    const am = new ActionManager(agent);
    const c = collect(agent, { done: 15, total: 16, finish_after_ms: 2000 });
    const first = am.runAction('collect', c.fn, { timeout: 0 });
    await sleep(20);
    const started = Date.now();
    await am.runAction('mode:self_preservation', async () => {}, { timeout: 0, urgent: true });
    await first;
    assert.equal(c.finished, false, 'the collect was cut short');
    assert.ok(Date.now() - started < 1000, 'the reflex did not sit through the grace window');
});

test('urgent is the default, so an un-updated caller behaves as before', async () => {
    const agent = makeAgent();
    const am = new ActionManager(agent);
    const c = collect(agent, { done: 15, total: 16, finish_after_ms: 2000 });
    const first = am.runAction('collect', c.fn, { timeout: 0 });
    await sleep(20);
    await am.runAction('legacy', async () => {}, { timeout: 0 });
    await first;
    assert.equal(c.finished, false);
});

test('an action that is barely started gets no grace', async () => {
    // The grace is for work about to land, not a licence to ignore the arbiter.
    const agent = makeAgent();
    const am = new ActionManager(agent);
    const c = collect(agent, { done: 1, total: 16, finish_after_ms: 2000 });
    const first = am.runAction('collect', c.fn, { timeout: 0 });
    await sleep(20);
    await am.runAction('action:newAction', async () => {}, { timeout: 0, urgent: false });
    await first;
    assert.equal(c.finished, false, '1/16 is not nearly finished');
});

test('an action that reports nothing gets no grace', async () => {
    const agent = makeAgent();
    const am = new ActionManager(agent);
    let finished = false;
    const first = am.runAction('silent', async () => {
        const until = Date.now() + 2000;
        while (Date.now() < until && !agent.bot.interrupt_code) await sleep(5);
        if (!agent.bot.interrupt_code) finished = true;
    }, { timeout: 0 });
    await sleep(20);
    await am.runAction('action:newAction', async () => {}, { timeout: 0, urgent: false });
    await first;
    assert.equal(finished, false, 'no progress reported means never nearly-finished');
});

test('the grace is bounded: a nearly-done action that never ends is still stopped', async () => {
    const agent = makeAgent();
    const am = new ActionManager(agent);
    const first = am.runAction('stuck', async () => {
        reportProgress(agent.bot, 15, 16);
        while (!agent.bot.interrupt_code) await sleep(10);
    }, { timeout: 0 });
    await sleep(20);
    const started = Date.now();
    await am.runAction('action:newAction', async () => {}, { timeout: 0, urgent: false });
    await first;
    const waited = Date.now() - started;
    assert.ok(waited >= 2500, `it did wait out the grace (waited ${waited}ms)`);
    assert.ok(waited < 8000, `but not forever (waited ${waited}ms)`);
    assert.equal(am.executing, false);
});

test('stale progress does not carry into the next action', async () => {
    // Without clearing, the NEXT action inherits 15/16 and gets a grace it never
    // earned -- before it has done anything at all.
    const agent = makeAgent();
    const am = new ActionManager(agent);
    await am.runAction('collect', async () => reportProgress(agent.bot, 15, 16), { timeout: 0 });
    let finished = false;
    const second = am.runAction('next', async () => {
        const until = Date.now() + 2000;
        while (Date.now() < until && !agent.bot.interrupt_code) await sleep(5);
        if (!agent.bot.interrupt_code) finished = true;
    }, { timeout: 0, urgent: false });
    await sleep(20);
    assert.equal(agent.bot.action_progress, null, 'progress was reset when the new action took over');
    await am.runAction('third', async () => {}, { timeout: 0, urgent: false });
    await second;
    assert.equal(finished, false, 'the new action did not inherit the old one\'s grace');
});
