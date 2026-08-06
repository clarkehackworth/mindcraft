// Run: node --test src/agent/library/collect_pickup.test.js
// collectBlocks broke seventeen pine_logs in six hours and banked none of them.
// mineflayer's collectBlock decides what drop to walk to from minecraft-data's
// drop table, which has no entry for a modded block, so it breaks the block and
// leaves the item on the ground. No wood meant no planks, no sword, and twenty
// deaths holding nothing -- so "banked nothing" now sweeps for the drops before
// they are written off.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { Vec3 } from 'vec3';
import prismarine_registry from 'prismarine-registry';
import { bankedAnything } from './skills.js';
import * as mc from '../../utils/mcdata.js';

// pickupNearbyItems builds a pf.Movements and goToGoal looks up block ids, so
// both the bot and mcdata need a registry.
const registry = prismarine_registry('1.20.1');
mc.useRegistry(registry);

// bankedAnything calls pickupNearbyItems, which pathfinds to the nearest item
// entity. Give it a world with one drop in it (or none) and let it really run.
function fakeBot({ dropOnGround }) {
    const inventory = [];
    const drop = { name: 'item', position: new Vec3(1, 64, 0) };
    const bot = {
        output: '',
        interrupt_code: false,
        paths: 0,
        registry,
        world: { getBlock: () => null },
        game: { dimension: 'overworld' },
        entity: { position: new Vec3(0, 64, 0) },
        inventory: { items: () => inventory },
        nearestEntity: (match) => (dropOnGround && !drop.taken && match(drop) ? drop : null),
        pathfinder: {
            setMovements: () => {},
            getPathTo: () => ({ status: 'success' }),
            // Walking to the drop is what banks it.
            goto: async () => {
                bot.paths++;
                drop.taken = true;
                inventory.push({ name: 'pine_log', type: 1, count: 2 });
            },
            setGoal: () => {},
        },
    };
    return bot;
}

test('a collect that banked nothing sweeps, and the sweep can rescue it', async () => {
    const bot = fakeBot({ dropOnGround: true });
    assert.equal(await bankedAnything(bot, 0, 2), true, 'the drops were recovered, so not a failure');
    assert.ok(bot.paths > 0, 'it actually went and got them');
});

test('drops that are really gone still report failure', async () => {
    const bot = fakeBot({ dropOnGround: false });
    assert.equal(await bankedAnything(bot, 0, 2), 'no_drop', 'swept, found nothing at all');
});

test('a collect that banked something does not sweep', async () => {
    const bot = fakeBot({ dropOnGround: true });
    bot.inventory.items().push({ name: 'pine_log', type: 1, count: 2 });
    assert.equal(await bankedAnything(bot, 0, 2), true);
    assert.equal(bot.paths, 0, 'nothing to recover, so no pathfinding spent looking');
});

test('breaking no blocks at all is not a lost drop', async () => {
    const bot = fakeBot({ dropOnGround: true });
    assert.equal(await bankedAnything(bot, 0, 0), true);
    assert.equal(bot.paths, 0);
});

test('an interrupted collect is not evidence that the drops were lost', async () => {
    // bankedAnything bails early on an interrupt rather than pathfind past the
    // grace period -- so it never looked, and the caller must not report a
    // verdict it did not reach. Asserted here as the reason the early return is
    // distinguishable at all: it happens with the flag still set.
    const bot = fakeBot({ dropOnGround: true });
    bot.interrupt_code = true;
    assert.equal(await bankedAnything(bot, 0, 2), 'interrupted',
        'named so the caller reports an interrupt rather than a verdict it never reached');
});

test('an interrupted collect does not sweep', async () => {
    // The sweep pathfinds per item; doing that after an interrupt holds the
    // action open past its grace period.
    const bot = fakeBot({ dropOnGround: true });
    bot.interrupt_code = true;
    assert.equal(await bankedAnything(bot, 0, 2), 'interrupted');
    assert.equal(bot.paths, 0);
});

test('a drop the bot cannot path to does not take the whole collect down', async () => {
    // goToGoal throws on an unreachable goal by design. A log that rolled
    // somewhere unwalkable is an ordinary outcome, not a reason to blow up
    // collectBlocks -- which is what would happen, since the call site does not
    // wrap it.
    const bot = fakeBot({ dropOnGround: true });
    bot.pathfinder.goto = async () => { throw new Error('No path to the goal'); };
    bot.pathfinder.getPathTo = () => ({ status: 'noPath' });
    assert.ok(await bankedAnything(bot, 0, 2) !== true, 'reports a reason rather than throwing');
});

test('a drop entity under a modded name is still seen', async () => {
    // The sweep used to match only entity.name === 'item'. A server that
    // registers its drop entity as anything else made the sweep walk nowhere
    // while the log sat in front of the bot.
    const bot = fakeBot({ dropOnGround: true });
    // One stable entity, so "did the sweep pick it up" is answerable. Building a
    // fresh object per call would make the loop's identity check never match and
    // spin forever.
    const modded = { name: 'minecraft:item', objectType: 'Item', position: new Vec3(1, 64, 0) };
    bot.nearestEntity = (match) => (!modded.taken && match(modded) ? modded : null);
    bot.pathfinder.goto = async () => {
        bot.paths++;
        modded.taken = true;
        bot.inventory.items().push({ name: 'pine_log', type: 1, count: 2 });
    };
    assert.equal(await bankedAnything(bot, 0, 2), true);
    assert.ok(bot.paths > 0, 'it recognised the drop and went to it');
});

test('a drop that lands a moment late is waited for, not written off', async () => {
    // The item entity arrives a tick or two after the block breaks. Checking
    // immediately swept an empty world and declared the log lost while it was
    // still spawning -- which is why the losses clustered on small collects.
    const bot = fakeBot({ dropOnGround: false });
    setTimeout(() => bot.inventory.items().push({ name: 'pine_log', type: 1, count: 1 }), 100);
    assert.equal(await bankedAnything(bot, 0, 1), true, 'the late arrival counted');
    assert.equal(bot.paths, 0, 'and no pathfinding was spent, because it arrived on its own');
});

test('a full-but-unchanged inventory is still a failure, not a pass', async () => {
    // items_before is the count, so "already had things, gained nothing" must
    // read as nothing banked rather than as success.
    const bot = fakeBot({ dropOnGround: false });
    bot.inventory.items().push({ name: 'dirt', type: 2, count: 30 });
    assert.equal(await bankedAnything(bot, 30, 2), 'no_drop');
});
