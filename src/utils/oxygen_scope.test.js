import { test } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { scopeOxygenToSelf } from './mcdata.js';

// Order matters, and it is the opposite of what it looks like. mineflayer's
// loader.js defers plugin injection with
//     setTimeout(() => bot.emit('inject_allowed'), 0)
// so entities.js registers its entity_metadata handler on the NEXT TICK -- after
// initBot has finished and after scopeOxygenToSelf has run. The first version of
// this test registered upstream's handler first, which quietly assumed the
// reverse and passed against a fix that did nothing on the live bot.
//
// So: install ours, THEN upstream's, exactly as it happens for real.
function botUnderUpstream(own_id = 7) {
    const bot = { _client: new EventEmitter(), entity: { id: own_id }, oxygenLevel: 20 };
    scopeOxygenToSelf(bot);
    // lib/plugins/entities.js: handles every entity, writes bot.oxygenLevel with
    // no check that the packet was about us. That missing check is the bug.
    bot._client.on('entity_metadata', (packet) => {
        if (packet.air_supply != null) bot.oxygenLevel = Math.round(packet.air_supply / 15);
    });
    return bot;
}

test('the fix survives upstream registering its handler afterwards', () => {
    const bot = botUnderUpstream();
    bot._client.emit('entity_metadata', { entityId: 7, air_supply: 300 });
    assert.equal(bot.oxygenLevel, 20, 'our own full bar is read normally');

    // A Drowned at the shoreline. Math.round(-15/15) is the -1 behind
    // "Surfaced with -1/20 air left" on a bot standing on dry land.
    bot._client.emit('entity_metadata', { entityId: 99, air_supply: -15 });
    assert.equal(bot.oxygenLevel, 20, 'someone else suffocating is not our emergency');

    // The values no <0 guard can catch: a squid mid-bar is indistinguishable
    // from a bot halfway to drowning.
    bot._client.emit('entity_metadata', { entityId: 42, air_supply: 90 });
    assert.equal(bot.oxygenLevel, 20, 'a plausible-looking foreign reading is still foreign');
});

test('the bot\'s own air still falls when the bot is the one drowning', () => {
    const bot = botUnderUpstream();
    bot._client.emit('entity_metadata', { entityId: 7, air_supply: 300 });
    bot._client.emit('entity_metadata', { entityId: 99, air_supply: 0 });
    bot._client.emit('entity_metadata', { entityId: 7, air_supply: 60 });
    assert.equal(bot.oxygenLevel, 4, 'a real drowning reads through');

    bot._client.emit('entity_metadata', { entityId: 99, air_supply: 300 });
    assert.equal(bot.oxygenLevel, 4, 'and a mob surfacing does not rescue us on paper');
});

test('foreign packets before the bot has an entity are ignored, not believed', () => {
    const bot = { _client: new EventEmitter(), entity: null, oxygenLevel: undefined };
    scopeOxygenToSelf(bot);
    bot._client.on('entity_metadata', (packet) => {
        if (packet.air_supply != null) bot.oxygenLevel = Math.round(packet.air_supply / 15);
    });

    bot._client.emit('entity_metadata', { entityId: 99, air_supply: -15 });
    assert.equal(bot.oxygenLevel, undefined,
        'pre-spawn there is no "us" to compare against, so nothing is ours; ' +
        'isBreathing/lowAirPersists both treat undefined as "no reading"');
});

test('packets that carry no air_supply leave the reading alone', () => {
    const bot = botUnderUpstream();
    bot._client.emit('entity_metadata', { entityId: 7, air_supply: 150 });
    assert.equal(bot.oxygenLevel, 10);
    bot._client.emit('entity_metadata', { entityId: 99, pose: 2 });
    assert.equal(bot.oxygenLevel, 10, 'a mob lying down says nothing about our air');
});

test('the guard does not leak across packets', () => {
    const bot = botUnderUpstream();
    // Ours, then theirs: the flag set by our packet must not still be believed
    // when the next one belongs to someone else.
    bot._client.emit('entity_metadata', { entityId: 7, air_supply: 300 });
    bot._client.emit('entity_metadata', { entityId: 99, air_supply: 0 });
    bot._client.emit('entity_metadata', { entityId: 99, air_supply: 0 });
    assert.equal(bot.oxygenLevel, 20);
});
