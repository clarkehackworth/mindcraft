// Run: node --test src/agent/mode_preempt.test.js
// Standing next to a zombie, Andy's self_preservation interrupted self_defense
// 157 times in a row and his policy's flee rule interrupted cowardice 122
// times. Every interrupt cancelled the pathfinder mid-escape (175 PathStopped
// exceptions), the loser restarted the moment the winner finished, and 300ms
// later the same preemption happened again. He never got more than a step from
// the mob killing him -- 493 deaths to zombies. Priority order already decides
// who wins a tie; the loser has to sit out until the situation is over.
import test from 'node:test';
import assert from 'assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { chdir, cwd } from 'process';
import { initModes } from './modes.js';

const original = cwd();
const scratch = mkdtempSync(`${tmpdir()}/mode-preempt-`);
chdir(scratch);
test.after(() => { chdir(original); rmSync(scratch, { recursive: true, force: true }); });

// Two rules that both want to run right now, the way a policy flee rule and
// cowardice both fire on "hostile nearby".
const rule = (name) => ({
    name,
    description: name,
    when: { cond: 'always' },
    do: [{ act: 'stay', seconds: 1 }],
    cooldown: 0,
});

function makeAgent() {
    const agent = {
        name: 'TestBot',
        task: null,
        prompter: { getInitModes: () => null },
        actions: {
            executing: false,
            currentActionLabel: '',
            async runAction(label, fn) { await fn(); return { success: true, message: '' }; },
        },
        isIdle() { return !this.actions.executing; },
        self_prompter: { isActive: () => false, stopLoop() {}, },
        handleMessage() {},
        bot: { interrupt_code: false, emit() {}, on() {} },
    };
    initModes(agent);
    // Built-ins would compete for the same tick; this test is about the arbiter.
    for (const m of agent.bot.modes.getJson ? Object.keys(agent.bot.modes.getJson()) : [])
        agent.bot.modes.setOn(m, false);
    return agent;
}

test('a preempted entry sits out instead of re-triggering the same preemption', async () => {
    const agent = makeAgent();
    const modes = agent.bot.modes;
    modes.installPolicy({ rules: [rule('winner'), rule('loser')] }, 'test');
    const [winner, loser] = modes.rules;

    // The loser is mid-escape; the arbiter is about to hand the tick to the
    // higher-priority winner.
    loser.active = true;
    agent.actions.executing = true;
    agent.actions.currentActionLabel = loser.name;

    await modes.update();

    assert.equal(loser.paused, true, 'the preempted rule must stand down');
    assert.equal(winner.paused, false, 'the winner keeps running');
});

test('the pause lifts once the bot is idle again', async () => {
    const agent = makeAgent();
    const modes = agent.bot.modes;
    modes.installPolicy({ rules: [rule('winner'), rule('loser')] }, 'test');
    const [, loser] = modes.rules;

    loser.paused = true;
    agent.actions.executing = false; // escape finished, nothing running

    await modes.update();

    assert.equal(loser.paused, false, 'unPauseAll on idle is the reset');
});

test('nothing is paused when no other entry is active', async () => {
    const agent = makeAgent();
    const modes = agent.bot.modes;
    modes.installPolicy({ rules: [rule('only')] }, 'test');
    const [only] = modes.rules;

    agent.actions.executing = true;
    agent.actions.currentActionLabel = 'action:goToCoordinates';

    await modes.update();

    assert.equal(only.paused, false, 'a lone rule must not pause itself');
});
