// Run: node src/agent/air_sampling_blocked.test.js
// The air sampler lived at the top of modes.update(). That looked like a fixed
// 300ms clock and was not one: the agent loop awaits modes.update(), which
// awaits entry.update(), which awaits execute(), which awaits runAction. A
// blocking action therefore holds the entire chain for as long as it runs, and
// wait_out_the_night_under_cover runs a `stay` until dawn.
//
// So the drowning reflex could not fire while any long action was in progress,
// however hard the bot was drowning. Andy died at -57,58,81 twenty-five seconds
// into one of those stays, and at 2,54,-4 while sinking through a two-minute
// silence -- neither death had a single selfpres:drown fire before it.
import assert from 'assert';
import { initModes } from './modes.js?case=blocked';
import { lowAirPersists } from './library/skills.js';

let release;
const blocker = new Promise(r => { release = r; });

const agent = {
    name: 'test',
    bot: {
        on(evt, fn) { if (evt === 'physicsTick') agent.bot._tick = fn; },
        entity: { position: { offset: () => ({}) }, eyeHeight: 1.62 },
        oxygenLevel: 4,
        health: 20,
        lastDamageTime: 0,
        controlState: {},
        pathfinder: { goal: null },
        blockAt: () => ({ name: 'water' }),
        setControlState: () => {},
        clearControlStates: () => {},
        inventory: { findInventoryItem: () => null },
    },
    isIdle: () => false,
    self_prompter: { isActive: () => false, stopLoop: () => {} },
    actions: { currentActionLabel: 'action:stay', resume_func: null, runAction: async () => ({ message: '' }) },
    prompter: { getInitModes: () => null },
    openChat: () => {},
};
initModes(agent);

// A blocking action is running and the mode loop is not being called at all --
// which is exactly the state modes.update() is in while it awaits one.
const held = (async () => { await blocker; })();

// The game tick keeps arriving regardless, because it belongs to mineflayer.
for (let i = 0; i < 6; i++) {
    agent.bot._tick();
    await new Promise(r => setTimeout(r, 120));
}
release();
await held;

assert.equal(lowAirPersists(agent.bot), true,
    'air is still sampled while a blocking action holds the mode loop');
console.log('ok: the air sampler survives a blocking action');
