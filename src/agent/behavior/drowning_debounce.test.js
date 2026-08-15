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

const drowning = CONDITIONS.drowning.fn;
// Each call is one evaluation tick. The condition dedupes samples closer than
// 100ms apart, so tests that mean "two ticks" must actually let time pass.
const tick = async (agent, oxygenLevel, args = {}) => {
    await new Promise(r => setTimeout(r, 120));
    agent.bot.oxygenLevel = oxygenLevel;
    return drowning(agent, args);
};
const fresh = () => ({ bot: { oxygenLevel: 20 } });

test('a single stray low packet does not fire', async () => {
    const agent = fresh();
    assert.equal(await tick(agent, 20), false);
    assert.equal(await tick(agent, 8), false, 'one low reading is not a drowning');
    assert.equal(await tick(agent, 20), false);
    assert.equal(await tick(agent, 20), false, 'and it does not linger');
});

test('a real drowning fires, despite the bar bouncing', async () => {
    // The measured sequence from a drowning that killed him.
    const agent = fresh();
    let fired = false;
    for (const oxygen of [17, 14, 19, 15, 1, 4, 19, -1])
        fired = fired || await tick(agent, oxygen);
    assert.ok(fired, 'a bouncing bar still reads as drowning');
});

test('two low readings in the window are enough', async () => {
    const agent = fresh();
    assert.equal(await tick(agent, 10), false);
    assert.equal(await tick(agent, 19), false, 'the bar bounced back up');
    assert.equal(await tick(agent, 11), true, 'second low inside the window fires');
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

test('a drowning that goes straight to critical still fires, one tick later', async () => {
    const agent = fresh();
    assert.equal(await tick(agent, 3), false, 'first reading arms it');
    assert.equal(await tick(agent, 1), true, 'the second fires -- 300ms into a ~15s drowning');
});

test('missing oxygen data never fires', async () => {
    assert.equal(drowning({ bot: {} }, {}), false);
});
