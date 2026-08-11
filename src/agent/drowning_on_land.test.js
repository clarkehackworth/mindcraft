// Run: node src/agent/drowning_on_land.test.js
// The air bar reads 0 for the tick after a respawn, before the first health
// packet lands. Andy died 14 times to zombies and each death was followed by a
// phantom drowning: self_preservation interrupted whatever he was doing, killed
// the self-prompt loop, then logged "Surfaced with 20/20 air left". Seventeen
// wasted LLM turns in one run, all of them standing on dry grass.
import assert from 'assert';
import { initModes } from './modes.js';

function fakeAgent(head_block_name, oxygenLevel, init = initModes) {
    let ran = null;
    const agent = {
        name: 'test',
        bot: {
            entity: { position: { offset: () => ({}) }, eyeHeight: 1.62 },
            oxygenLevel,
            health: 20,
            lastDamageTime: 0,
            controlState: {},
            pathfinder: { goal: null },
            blockAt: () => ({ name: head_block_name }),
            setControlState: () => {},
            clearControlStates: () => {},
            inventory: { findInventoryItem: () => null },
        },
        isIdle: () => true,
        self_prompter: { isActive: () => false, stopLoop: () => {} },
        actions: {
            currentActionLabel: null,
            resume_func: null,
            runAction: async (label, fn) => { ran = label; await fn(); return { message: '' }; },
        },
        prompter: { getInitModes: () => null },
        openChat: () => {},
    };
    init(agent);
    for (const name of Object.keys(agent.bot.modes.getJson()))
        agent.bot.modes.setOn(name, name === 'self_preservation');
    return { agent, ranAction: () => ran };
}

// Just respawned: air bar still stale at 0, but the head is in air.
const land = fakeAgent('air', 0);
await land.agent.bot.modes.update();
assert.equal(land.ranAction(), null, 'you cannot drown with your head in air');

// Actually drowning, and not in a block named 'water' -- kelp drowns you too.
const kelp = fakeAgent('kelp', 4);
await kelp.agent.bot.modes.update();
assert.equal(kelp.ranAction(), 'mode:self_preservation', 'a wet head with no air is still drowning');

// The policy condition needs the same guard, and for a while did not have it.
// A modpack that scales health (52/20 here) also moved the air bar, so the
// number alone had Andy re-firing the drowning rule every 5 seconds in a dry
// mineshaft at y=71 -- and once the reflex was pointed at skills.surface, which
// succeeds instantly when you are already breathing, it reported progress every
// time and never backed off.
const { evalCondition } = await import('./behavior/policy.js');
const at = (head, oxygenLevel) => ({ bot: {
    oxygenLevel,
    entity: { position: { offset: () => ({}) }, eyeHeight: 1.62 },
    blockAt: () => ({ name: head }),
} });
const drowning = { cond: 'drowning', air: 12 };
assert.equal(evalCondition(drowning, at('air', 0)), false, 'head in air is never drowning');
assert.equal(evalCondition(drowning, at('cave_air', 3)), false, 'cave air is air');
assert.equal(evalCondition(drowning, at('water', 20)), false, 'a full bar is not drowning');
assert.equal(evalCondition(drowning, at('water', 8)), true);
assert.equal(evalCondition(drowning, at('kelp', 4)), true, 'kelp drowns you without being called water');

// A ceiling is not water. Andy dug in for the night, which puts a block over
// his head, and with the air bar under full the swim-up branch re-asserted jump
// every tick for the rest of the run. Mineflayer swims when you hold jump and
// the server takes the client's word for where it is, so he climbed 2,000
// blocks into the sky at a steady 0.9 blocks a second, fell, and climbed again.
// Soak 6 measured five game-days of that and read them as a bot with nothing to
// path to.
// modes_list is module state and `active` survives one fake agent into the
// next, so each case gets its own copy of the module.
let case_n = 0;
async function jumpWatcher(head_block_name, oxygenLevel, { isInWater = false, jump = false } = {}) {
    const fresh = await import(`./modes.js?case=${++case_n}`);
    const { agent } = fakeAgent(head_block_name, oxygenLevel, fresh.initModes);
    const bot = agent.bot;
    bot.entity.isInWater = isInWater;
    bot.controlState = { jump };
    bot.setControlState = (name, value) => { bot.controlState[name] = value; };
    return { agent, held: () => bot.controlState.jump };
}

const sheltered = await jumpWatcher('stone', 8);
await sheltered.agent.bot.modes.update();
assert.equal(sheltered.held(), false, 'a stone ceiling is not a reason to swim');

const climbing = await jumpWatcher('stone', 8, { jump: true });
await climbing.agent.bot.modes.update();
assert.equal(climbing.held(), false, 'a jump held on dry land gets released');

// Air to spare (over the drowning threshold), so this is the passive nudge
// branch rather than the surface() reflex.
const swimming = await jumpWatcher('water', 15, { isInWater: true });
await swimming.agent.bot.modes.update();
assert.equal(swimming.held(), true, 'and a bot actually in water still surfaces');

console.log('ok: neither self_preservation nor the drowning rule fires on dry land');
process.exit(0);
