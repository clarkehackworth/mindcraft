// Run: node --test src/agent/reflex_tick.test.js
// The agent loop awaits the running action, so during any blocking action the
// arbiter -- and every reflex in it -- simply does not run. Drowning got its
// own physics-tick sampler after eleven deaths with zero fires; reflexTick is
// the same fix for the rest. This pins the contract: an urgent entry fires
// while the loop is blocked, a non-urgent one does not, and an active entry
// blocks everything below it.
import test from 'node:test';
import assert from 'assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { chdir, cwd } from 'process';
import { initModes, reflexTick } from './modes.js';

const original = cwd();
const scratch = mkdtempSync(`${tmpdir()}/reflex-tick-`);
chdir(scratch);
test.after(() => { chdir(original); rmSync(scratch, { recursive: true, force: true }); });

const rule = (name, extra = {}) => ({
    name,
    description: name,
    when: { cond: 'always' },
    do: [{ act: 'stay', seconds: 1 }],
    cooldown: 0,
    ...extra,
});

function makeAgent() {
    const fired = [];
    const agent = {
        name: 'TestBot',
        task: null,
        fired,
        prompter: { getInitModes: () => null },
        actions: {
            executing: true, // the loop is BLOCKED: mid-collect, mid-stay
            currentActionLabel: 'action:collectBlocks',
            async runAction(label, fn) { fired.push(label); return { success: true, message: '' }; },
        },
        isIdle() { return !this.actions.executing; },
        self_prompter: { isActive: () => false, stopLoop() {} },
        handleMessage() {},
        bot: { interrupt_code: false, emit() {}, on() {} },
    };
    initModes(agent);
    for (const m of Object.keys(agent.bot.modes.getJson()))
        agent.bot.modes.setOn(m, false); // built-ins out of the way; this is about dispatch
    return agent;
}

// reflexTick's cadence gate is module-global; space the calls out.
const nextWindow = () => new Promise(r => setTimeout(r, 550));

test('a pinned rule fires from the physics tick while the agent loop is blocked', async () => {
    await nextWindow();
    const agent = makeAgent();
    agent.bot.modes.installPolicy({ rules: [rule('flee_now', { pinned: true, interrupts: 'all' })] }, 'test');
    reflexTick(agent);
    await new Promise(r => setTimeout(r, 20)); // dispatch is fire-and-forget
    assert.deepEqual(agent.fired, ['mode:policy:flee_now'],
        'the urgent rule must dispatch even though nothing is awaiting the arbiter');
});

test('an unpinned rule stays on the arbiter: reflexes are for emergencies', async () => {
    await nextWindow();
    const agent = makeAgent();
    agent.bot.modes.installPolicy({ rules: [rule('tidy_up')] }, 'test');
    reflexTick(agent);
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(agent.fired, [], 'a non-urgent rule must not ride the physics tick');
});

test('an active entry blocks everything below it, same as the arbiter', async () => {
    await nextWindow();
    const agent = makeAgent();
    agent.bot.modes.installPolicy({
        rules: [rule('already_running', { pinned: true }), rule('wants_in', { pinned: true, interrupts: 'all' })],
    }, 'test');
    agent.bot.modes.rules[0].active = true;
    reflexTick(agent);
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(agent.fired, [], 'entries at or below an active one wait their turn');
});
