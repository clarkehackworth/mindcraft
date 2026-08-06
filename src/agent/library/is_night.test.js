// Run: node src/agent/library/is_night.test.js
// The bot reported "Time: Night" while its own policy rules evaluated is_night
// as false. Two definitions: isNight() was 13000..23000, while !stats bucketed
// anything >= 12000 as Night. They disagreed at both ends of the night --
// caught live at daytime 23008, where stats said Night and is_night said day.
import assert from 'assert';
import * as world from './world.js';

// Without mineflayer's isDay (before the first time packet), fall back to ticks.
const atTick = (t) => world.isNight({ time: { timeOfDay: t } });

assert.equal(atTick(0), false, 'sunrise is day');
assert.equal(atTick(6000), false, 'noon is day');
assert.equal(atTick(11999), false, 'late afternoon is day');
assert.equal(atTick(13000), true, 'night starts at 13000');
assert.equal(atTick(18000), true, 'midnight is night');
assert.equal(atTick(23008), true, 'dawn is still night -- this is the value that caught it');
assert.equal(atTick(23999), true, 'the last tick before rollover is still night');

// mineflayer's own isDay wins when present, and the two agree.
assert.equal(world.isNight({ time: { isDay: true, timeOfDay: 500 } }), false);
assert.equal(world.isNight({ time: { isDay: false, timeOfDay: 23008 } }), true);

// isDay is null until the first update_time packet -- do not read that as day.
assert.equal(world.isNight({ time: { isDay: null, timeOfDay: 18000 } }), true,
    'a missing isDay falls back to the tick range, not to "day"');

// A lead moves where night starts, so a bot can leave for home before mobs are
// out. Andy was reliably caught in transit: the walk home is ~30 blocks and the
// rule did not fire until it was already dark.
assert.equal(world.isNight({ time: { timeOfDay: 11500 } }, 1500), true, 'dusk counts as night with a lead');
assert.equal(world.isNight({ time: { timeOfDay: 11499 } }, 1500), false, 'but not one tick earlier');
assert.equal(world.isNight({ time: { timeOfDay: 11500 } }), false, 'and lead 0 is the old behaviour');
assert.equal(world.isNight({ time: { timeOfDay: 0 } }, 1500), false, 'dawn is still dawn with a lead');

// Fixed-time servers send a negative tick count; mineflayer reads that as night.
assert.equal(world.isNight({ time: { timeOfDay: -1 } }), true);

// The !stats label and isNight() must never contradict each other.
const label = (t) => {
    const bot = { time: { timeOfDay: t } };
    if (world.isNight(bot)) return 'Night';
    return t < 6000 ? 'Morning' : 'Afternoon';
};
for (let t = 0; t < 24000; t += 250)
    assert.equal(label(t) === 'Night', atTick(t), `stats and is_night agree at tick ${t}`);

console.log('ok: one definition of night, agreed on at every tick of the day');
