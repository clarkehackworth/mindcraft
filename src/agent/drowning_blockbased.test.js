// The oxygen channel is dead on this server: scopeOxygenToSelf() leaves
// bot.oxygenLevel undefined because the server never sends the bot's own
// air_supply. lowAirPersists therefore has to decide on the head block, and
// these are the cases that decide it.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { headSubmerged, recordAir, lowAirPersists, isBreathing } from './library/skills.js';

// eyeHeight 1.62 puts the head in the block above the feet.
function botIn(head_block, { oxygen } = {}) {
    const bot = {
        oxygenLevel: oxygen,
        entity: { position: { offset: (x, y, z) => ({ x, y, z }) }, eyeHeight: 1.62, isInWater: false },
        blockAt: () => head_block,
    };
    return bot;
}

// prismarine-block exposes waterlogged as a property, not a name.
const block = (name, props) => ({ name, getProperties: () => props ?? {} });

// recordAir drops any sample taken within 100ms of the last one, so a tight
// loop records exactly once -- a plain `for` loop of 12 calls proves nothing.
// Age the existing samples instead of faking the clock: same effect, no global
// patching. 300ms is the real mode tick.
function tick(bot, n, ms = 300) {
    for (let i = 0; i < n; i++) {
        recordAir(bot);
        for (const s of bot._air_history) s.t -= ms;
    }
}

test('headSubmerged knows the things that drown you by more than their name', () => {
    assert.equal(headSubmerged(botIn(block('water'))), true);
    assert.equal(headSubmerged(botIn(block('flowing_water'))), true);
    // The kelp forest that killed the bot and that every name === 'water' test
    // in this file's history read as dry land.
    assert.equal(headSubmerged(botIn(block('kelp_plant'))), true);
    assert.equal(headSubmerged(botIn(block('tall_seagrass'))), true);
    assert.equal(headSubmerged(botIn(block('bubble_column'))), true);
    assert.equal(headSubmerged(botIn(block('oak_stairs', { waterlogged: true }))), true);

    assert.equal(headSubmerged(botIn(block('air'))), false);
    assert.equal(headSubmerged(botIn(block('oak_stairs', { waterlogged: false }))), false);
    // A dug-in bot under its own roof is not drowning. "Not air" was the old
    // test and it called every ceiling water.
    assert.equal(headSubmerged(botIn(block('stone'))), false);
    // An unloaded chunk is not evidence of water; guessing here would hand the
    // reflex a trigger it could never clear.
    assert.equal(headSubmerged(botIn(null)), false);
});

test('a real drowning is detected with no air bar at all', () => {
    const bot = botIn(block('water'));
    assert.equal(bot.oxygenLevel, undefined, 'this server sends no air_supply for us');
    // ~3s of mode ticks with the head under.
    tick(bot, 12);
    assert.equal(lowAirPersists(bot), true);
    assert.equal(isBreathing(bot), false);
});

test('wading through does not trip it', () => {
    const bot = botIn(block('water'));
    // A couple of ticks submerged crossing a river, then out.
    tick(bot, 4);
    assert.equal(lowAirPersists(bot), false, 'four samples is not three seconds under');
});

test('dry land cannot drown, however long the bot stands there', () => {
    const bot = botIn(block('air'));
    tick(bot, 40);
    assert.equal(lowAirPersists(bot), false);
    assert.equal(isBreathing(bot), true);
    // This is the phantom that fired every few seconds at -25,69,2 with the
    // server reporting Air=300 the whole time.
});

test('a working air bar still wins when one exists', () => {
    // Not every server is this one -- if oxygen is real, use it.
    const bot = botIn(block('air'), { oxygen: 20 });
    tick(bot, 40);
    assert.equal(lowAirPersists(bot), false, 'full bar, no drowning');
    assert.equal(isBreathing(bot), true);

    const sinking = botIn(block('water'), { oxygen: 4 });
    tick(sinking, 12);
    assert.equal(lowAirPersists(sinking), true);
});

test('the window does not keep firing after the bot has surfaced', () => {
    // Measured in the water pen: the escape worked, then the reflex fired again
    // at above=air:wet=13/15 on the samples from the drowning it had just
    // ended, and reported "Surfaced with 20/20 air left" -- the phantom in
    // miniature. Being under NOW is required, not just having been under.
    const water = block('water'), air = block('air');
    let head = water;
    const bot = botIn(null);
    bot.blockAt = () => head;

    tick(bot, 12);
    assert.equal(lowAirPersists(bot), true, 'drowning');

    head = air; // surfaced; the history is still full of wet samples
    assert.equal(lowAirPersists(bot), false, 'out of the water is out of danger');
    assert.ok((bot._air_history ?? []).filter(s => s.submerged).length >= 10,
        'and it is genuinely the stale window being ignored, not an empty one');
});

test('a stuck air bar cannot drown a bot standing in a field', () => {
    // The pen at 8,63,-7: the bot drowned, was rescued, and bot.oxygenLevel
    // stayed at 0 afterwards because the refill metadata is never sent. Eleven
    // consecutive phantom fires followed, logged wet=0/6 through wet=0/32 --
    // every one of them on a bot whose head was in air.
    const bot = botIn(block('air'), { oxygen: 0 });
    tick(bot, 32);
    assert.equal((bot._air_history ?? []).filter(s => s.submerged).length, 0,
        'thirty-two samples, none submerged');
    assert.equal(lowAirPersists(bot), false, 'the head block vetoes the stale number');
    assert.equal(isBreathing(bot), true, 'and surface() can take its early return');
});

test('the veto does not suppress a drowning that the bar DOES see', () => {
    // Both channels agreeing is the case that must survive the veto.
    const bot = botIn(block('water'), { oxygen: 4 });
    tick(bot, 12);
    assert.equal(lowAirPersists(bot), true);
});
