// Andy sat in one spot in a frozen pine taiga and died 7 times. The chain:
//   1. a watchdog aborted any path where the bot dug a block it could not HARVEST
//   2. canHarvest means "drops something", not "can be broken" -- snow_block
//      breaks by hand in 1s, it just yields no snowball without a shovel
//   3. so paths through snow kept aborting, and the fix for THAT made the planner
//      treat every snow block as impassable
//   4. in a biome made of snow, that leaves no route anywhere: every goal timed
//      out with "Took to long to decide path to goal!"
// Time is the right test. Slow-but-possible beats not moving at all.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import minecraftData from 'minecraft-data';
import PrismarineBlock from 'prismarine-block';
import { MAX_HAND_DIG_MS } from './mcdata.js';

const registry = minecraftData('1.20.1');
const Block = PrismarineBlock('1.20.1');
const block = name => new Block(registry.blocksByName[name].id, 0, 0);
// mineflayer's hand-dig time for a block with no applicable tool
const handDigMs = name => Math.ceil(1000 * registry.blocksByName[name].hardness * 5);

test('the threshold lets the bot break what is merely slow', () => {
    for (const name of ['snow', 'snow_block', 'dirt', 'ice', 'stone'])
        assert.ok(handDigMs(name) <= MAX_HAND_DIG_MS,
            `${name} takes ${handDigMs(name) / 1000}s by hand and must stay passable -- it is what the taiga is made of`);
});

test('and still refuses what is hopeless', () => {
    for (const name of ['obsidian', 'deepslate'])
        assert.ok(handDigMs(name) > MAX_HAND_DIG_MS,
            `${name} takes ${handDigMs(name) / 1000}s by hand and is not worth pathing through`);
});

// The specific confusion that caused it.
test('canHarvest is about drops, not about breaking', () => {
    const snow = block('snow_block');
    assert.ok(!snow.canHarvest(null), 'no shovel means no snowball...');
    assert.equal(registry.blocksByName.snow_block.diggable, true, '...but it is still diggable');
    assert.ok(handDigMs('snow_block') < 2000, 'and it takes about a second');
});
