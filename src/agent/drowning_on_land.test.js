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
            // initModes wires the air sampler to physicsTick, mineflayer's own
            // clock, because the mode loop stops for the whole of any blocking
            // action. Capturing the handler here proves the wiring happened;
            // calling it is how this test advances the air history.
            on(evt, fn) { if (evt === 'physicsTick') agent.bot._tick = fn; },
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
    assert.equal(typeof agent.bot._tick, 'function', 'initModes wires the air sampler');
    for (const name of Object.keys(agent.bot.modes.getJson()))
        agent.bot.modes.setOn(name, name === 'self_preservation');
    return { agent, ranAction: () => ran, tick: () => agent.bot._tick() };
}

// Just respawned: the air bar reads a stale 0 for one tick, then the real value
// lands. This used to be caught by requiring a wet head, which turned out to
// veto real drownings too (see below), so the debounce catches it instead --
// the phantom is exactly one reading, and one reading fires nothing.
const land = fakeAgent('air', 0);
await land.agent.bot.modes.update();
assert.equal(land.ranAction(), null, 'the stale reading alone does nothing');
land.agent.bot.oxygenLevel = 20;
await new Promise(r => setTimeout(r, 120));
await land.agent.bot.modes.update();
assert.equal(land.ranAction(), null, 'and once the real value lands there is nothing to do');

// Actually drowning. Several updates, because one low reading is not enough:
// self_preservation interrupts every action and stops the self-prompt loop, and
// it was doing that on air that had already refilled by the time surface() ran.
//
// The head block is 'water' here, reversing what this test used to assert.
// It claimed a really drowning bot reads above=air with a dry head, from a
// sample of oxygen falling while every positional test said dry. That sample
// was the mineflayer entity-id bug: a Drowned's air_supply landing in
// bot.oxygenLevel while this bot breathed fine on land. Re-measured in the pen
// at 8,63,-7 against a scoped bar, a real drowning reads
//     selfpres:drown:oxygen=0:above=air:inwater=true:wet=12/12
// -- twelve of twelve samples with the head genuinely under. The positional
// tests were never lying; the number was.
// Fresh copy of the module: modes_list is module state, so the debounce window
// from the respawn case above carries into this one and its first reading would
// count as the second. (The jump cases below do the same thing for `active`.)
const kelp = fakeAgent('water', 4, (await import('./modes.js?case=drowning')).initModes);
kelp.tick();
await kelp.agent.bot.modes.update();
assert.equal(kelp.ranAction(), null, 'one low reading does not interrupt anything');
// Five samples at the 300ms mode tick, which is 1.5s of a ~15s drowning. Two
// was tried and measured: a bot standing in a dry cave produced two lows inside
// four seconds often enough to fire this 46 times in 20 minutes.
for (let i = 0; i < 4; i++) {
    await new Promise(r => setTimeout(r, 120));
    kelp.tick();
    await kelp.agent.bot.modes.update();
}
assert.equal(kelp.ranAction(), 'mode:self_preservation', 'sustained low air is drowning');

// The policy condition shares lowAirPersists with the mode above, so it now
// shares the head-block veto too -- there is no longer a split lesson here. The
// "every positional test reads dry exactly when it is drowning" reading that
// used to justify one is retired: it came from oxygen readings that belonged to
// other entities, and the cases below still pass because they are about the
// DEBOUNCE, which is unchanged. A single reading is a stray packet whether or
// not the head is wet.
//
// The dry-mineshaft phantom that head-block checks were meant to catch is
// handled by a debounce instead: five low samples inside a four second window,
// which a real drowning fills and noise never does. See
// drowning_debounce.test.js.
const { evalCondition } = await import('./behavior/policy.js');
const at = (oxygenLevel) => ({ bot: { oxygenLevel } });
const drowning = { cond: 'drowning', air: 12 };
assert.equal(evalCondition(drowning, at(20)), false, 'a full bar is not drowning');
assert.equal(evalCondition(drowning, at(8)), false, 'one low reading alone is a stray packet');
// Even zero waits: the measured false positives read oxygen=2 and oxygen=4 with
// nothing around them, lower than the real dips, so there is no fast path for a
// very low reading. Note these go through evalCondition without recordAir, which
// is the point -- with no sampled history there is nothing to believe.
assert.equal(evalCondition(drowning, at(0)), false, 'one reading of zero is still one reading');

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
