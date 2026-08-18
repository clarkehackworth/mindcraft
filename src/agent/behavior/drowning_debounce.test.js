// Run: node --test src/agent/behavior/drowning_debounce.test.js
// Soak 14: surface_when_drowning fired four times in twelve minutes and every
// outcome read "Surfaced with 20/20 air left" -- air was already full when the
// action started, so nothing was drowning. One of them interrupted an
// in-progress craftRecipe("stone_pickaxe"), which then failed.
//
// The condition was a single reading of oxygenLevel <= 12. That was itself a
// fix: the version before it wanted CONSECUTIVE low readings, which never
// matched because this server's air bar bounces (17,14,19,15,1,4,19,-1 measured
// through one real drowning). Two low readings anywhere in a short window
// satisfies both -- a real drowning floods the window, a stray packet cannot.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { CONDITIONS } from './policy.js';
import { recordAir } from '../library/skills.js';

const drowning = CONDITIONS.drowning.fn;
// Sampling happens once per mode tick, in ModeController.update, NOT inside the
// condition -- readers run at different cadences and a policy condition is only
// evaluated every `cooldown` seconds. So a tick here is recordAir + a read.
// Samples closer than 100ms apart are deduped, so ticks must let time pass.
const tick = async (agent, oxygenLevel, args = {}) => {
    await new Promise(r => setTimeout(r, 120));
    agent.bot.oxygenLevel = oxygenLevel;
    recordAir(agent.bot);
    return drowning(agent, args);
};
// The head is in water in every case here, because what is under test is the
// DEBOUNCE and a drowning bot's head is wet. lowAirPersists now vetoes on the
// head block first -- measured after a real rescue in the pen at 8,63,-7, the
// bar stuck at 0 and fired eleven more times at wet=0/6 through wet=0/32 with
// the bot standing in air. A stub with no world at all inherits that veto and
// would make every case below pass for the wrong reason.
const fresh = () => ({
    bot: {
        oxygenLevel: 20,
        _air_history: [],
        entity: { position: { offset: () => ({}) }, eyeHeight: 1.62 },
        blockAt: () => ({ name: 'water' }),
    },
});

test('a single stray low packet does not fire', async () => {
    const agent = fresh();
    assert.equal(await tick(agent, 20), false);
    assert.equal(await tick(agent, 8), false, 'one low reading is not a drowning');
    assert.equal(await tick(agent, 20), false);
    assert.equal(await tick(agent, 20), false, 'and it does not linger');
});

test('a real drowning fires, despite the bar bouncing', async () => {
    // Measured through a drowning that killed him: the bar bounces, but the low
    // readings keep coming and that is what the sample count is counting.
    const agent = fresh();
    let fired = false;
    for (const oxygen of [17, 14, 19, 15, 1, 4, 19, -1, 6, 7, 2, 0])
        fired = fired || await tick(agent, oxygen);
    assert.ok(fired, 'a bouncing bar still reads as drowning');
});

test('a couple of low readings are not enough', async () => {
    // This asked for two, and two was measured in the wild on a bot standing in
    // a dry cave: 46 fires in 20 minutes, 38 of which found full air by the time
    // the action ran. Each was an interrupts:all that killed the self-prompt
    // loop, so the bot spent the period being rescued from nothing.
    const agent = fresh();
    assert.equal(await tick(agent, 10), false);
    assert.equal(await tick(agent, 19), false, 'the bar bounced back up');
    assert.equal(await tick(agent, 11), false, 'two lows is what dry-cave noise looks like');
    assert.equal(await tick(agent, 11), false, 'three, still noise');
    assert.equal(await tick(agent, 11), false, 'four');
    assert.equal(await tick(agent, 11), true, 'five low samples is a drowning');
});

test('lows further apart than the window do not accumulate', async () => {
    const agent = fresh();
    assert.equal(await tick(agent, 8, { window_ms: 200 }), false);
    await new Promise(r => setTimeout(r, 260));
    assert.equal(await tick(agent, 8, { window_ms: 200 }), false,
        'the first low aged out; this is again a single stray');
});

test('a single very low reading is noise, not an emergency', async () => {
    // Measured on the live bot: oxygen=2 and oxygen=4, each with no other low
    // reading inside the window, each surfacing at 20/20. There is no emergency
    // bypass for these -- the stray packets read lower than the real dips.
    // Short window so the test does not have to wait out the real four seconds;
    // what matters is that the two strays fall in different windows, which is
    // what recent=0 in the live log means.
    const args = { window_ms: 200 };
    const agent = fresh();
    assert.equal(await tick(agent, 2, args), false, 'one reading of 2 with nothing around it');
    assert.equal(await tick(agent, 20, args), false);
    await new Promise(r => setTimeout(r, 260));
    assert.equal(await tick(agent, 4, args), false, 'and one of 4, a window later');
});

test('a drowning that goes straight to critical still fires, promptly', async () => {
    // Five samples at the 300ms mode tick is 1.5s of a drowning that lasts
    // about fifteen. There is no separate fast path for very low readings:
    // that bypass existed, and it was where every false positive came in --
    // the stray packets read 2 and 4, lower than the real dips.
    const agent = fresh();
    for (const [i, oxygen] of [3, 1, 2, 0, 0].entries())
        assert.equal(await tick(agent, oxygen), i >= 4,
            `sample ${i + 1} of 5`);
});

test('missing oxygen data never fires', async () => {
    assert.equal(drowning({ bot: {} }, {}), false);
});
