// Eleven drowning deaths carried a full death trace -- samples17:wet17, 16/16,
// 15/15, 13/13 -- with no selfpres:drown line anywhere in the log. The reflex
// was not vetoed and not wrong; it was never asked. recordAir was moved to
// physicsTick precisely because update() stalls for the whole of any blocking
// action, but the DECISION stayed in update(). Every one of those deaths
// happened inside something holding the loop (a policy rule's action, or an
// awaited LLM call), and the fires that did land were the harmless ones --
// wet=0/15, wet=1/27 -- i.e. the moments the bot was idle enough to be asked.
import { strict as assert } from 'node:assert';
import test from 'node:test';

async function freshModes(tag) {
    return await import(`./modes.js?drown_tick=${tag}`);
}

// Enough of an agent for initModes to wire itself to, with a bot that is
// unambiguously drowning: head in water, oxygen empty.
function drowningAgent() {
    const agent = {
        name: 'test',
        bot: {
            _handlers: {},
            on(evt, fn) { (this._handlers[evt] ??= []).push(fn); },
            tick() { for (const fn of this._handlers.physicsTick ?? []) fn(); },
            entity: { position: { offset: () => ({}) }, eyeHeight: 1.62, isInWater: true },
            oxygenLevel: 0,
            blockAt: () => ({ name: 'water' }),
            health: 20, lastDamageTime: 0, controlState: {}, pathfinder: { goal: null },
            setControlState: () => {}, clearControlStates: () => {},
            inventory: { findInventoryItem: () => null },
        },
        // The whole point: NOT idle. A blocking action holds the loop.
        isIdle: () => false,
        self_prompter: { isActive: () => false, stopLoop: () => {} },
        actions: {
            currentActionLabel: 'action:collectBlocks',
            resume_func: null,
            ran: [],
            runAction: async function (label, fn) { this.ran.push(label); await fn(); return { message: '' }; },
        },
        prompter: { getInitModes: () => null },
        openChat: () => {},
    };
    return agent;
}

test('a drowning bot is rescued even while a blocking action holds the loop', async () => {
    const { initModes } = await freshModes('busy');
    const agent = drowningAgent();
    initModes(agent);
    for (const name of Object.keys(agent.bot.modes.getJson()))
        agent.bot.modes.setOn(name, name === 'self_preservation');

    // Fill the air history the way physicsTick does, then let the tick decide.
    for (let i = 0; i < 15; i++) {
        agent.bot.tick();
        for (const s of agent.bot._air_history) s.t -= 300;
    }
    await new Promise(r => setTimeout(r, 50));

    assert.ok(agent.actions.ran.includes('mode:self_preservation'),
        'the rescue ran without update() ever being called');
});

test('it does not re-fire at 20Hz while the rescue is already running', async () => {
    const { initModes } = await freshModes('reentry');
    const agent = drowningAgent();
    let running = 0, peak = 0;
    agent.actions.runAction = async function (label, fn) {
        this.ran.push(label);
        running++; peak = Math.max(peak, running);
        await new Promise(r => setTimeout(r, 60));
        await fn();
        running--;
        return { message: '' };
    };
    initModes(agent);
    for (const name of Object.keys(agent.bot.modes.getJson()))
        agent.bot.modes.setOn(name, name === 'self_preservation');

    for (let i = 0; i < 15; i++) {
        agent.bot.tick();
        for (const s of agent.bot._air_history) s.t -= 300;
    }
    for (let i = 0; i < 40; i++) agent.bot.tick();   // two seconds of ticks
    await new Promise(r => setTimeout(r, 120));

    assert.equal(peak, 1, 'one rescue at a time');
    assert.equal(agent.actions.ran.filter(l => l === 'mode:self_preservation').length, 1,
        'twenty ticks a second must not dispatch twenty rescues');
});

test('a dry bot is never dispatched', async () => {
    const { initModes } = await freshModes('dry');
    const agent = drowningAgent();
    agent.bot.blockAt = () => ({ name: 'air' });
    agent.bot.oxygenLevel = 20;
    initModes(agent);
    for (const name of Object.keys(agent.bot.modes.getJson()))
        agent.bot.modes.setOn(name, name === 'self_preservation');

    for (let i = 0; i < 40; i++) {
        agent.bot.tick();
        for (const s of agent.bot._air_history ?? []) s.t -= 300;
    }
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(agent.actions.ran, [], 'standing in air is not an emergency');
});

test('the mode being switched off still switches it off', async () => {
    const { initModes } = await freshModes('off');
    const agent = drowningAgent();
    initModes(agent);
    for (const name of Object.keys(agent.bot.modes.getJson()))
        agent.bot.modes.setOn(name, false);

    for (let i = 0; i < 15; i++) {
        agent.bot.tick();
        for (const s of agent.bot._air_history) s.t -= 300;
    }
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(agent.actions.ran, [], 'a disabled reflex stays disabled');
});
