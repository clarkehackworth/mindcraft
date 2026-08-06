// Run: node src/agent/drowning_on_land.test.js
// The air bar reads 0 for the tick after a respawn, before the first health
// packet lands. Andy died 14 times to zombies and each death was followed by a
// phantom drowning: self_preservation interrupted whatever he was doing, killed
// the self-prompt loop, then logged "Surfaced with 20/20 air left". Seventeen
// wasted LLM turns in one run, all of them standing on dry grass.
import assert from 'assert';
import { initModes } from './modes.js';

function fakeAgent(head_block_name, oxygenLevel) {
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
    initModes(agent);
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

console.log('ok: neither self_preservation nor the drowning rule fires on dry land');
process.exit(0);
