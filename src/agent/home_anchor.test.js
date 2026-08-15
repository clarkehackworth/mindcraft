// Run: node --test src/agent/home_anchor.test.js
// Roaming, soak 13/14: every death site was 150-390 blocks from camp, the bot
// declared a new base wherever it wandered to, and by nightfall it was in a hole
// in the wilderness with no crafting table, furnace or chest -- so it had nothing
// to do until morning. Night idleness was a symptom of roaming, not a separate
// problem.
//
// Three things had to be true before "go home" could mean anything:
//   1. remembered places survive a restart (they did not: MemoryBank has had
//      getJson/loadJson since it was written and nothing ever called either),
//   2. the leash is anchored on home rather than on wherever this process
//      happened to log in,
//   3. something notices the bot has drifted and walks it back.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { MemoryBank } from './memory_bank.js';
import { CONDITIONS } from './behavior/policy.js';
import { withinExplorationRadius, explorationAnchor } from './library/skills.js';
import settings from '../../settings.js';
import { readFileSync } from 'node:fs';

test('remembered places survive a save/load round trip', () => {
    // The bug: places lived only in RAM, so the agent asked for
    // goToRememberedPlace("Home") and was told no such place exists -- it had
    // saved one, ten minutes and one restart earlier.
    const before = new MemoryBank();
    before.rememberPlace('home', 39, 67, -38);
    before.rememberPlace('pantry', 41, 67, -35);
    const after = new MemoryBank();
    after.loadJson(JSON.parse(JSON.stringify(before.getJson())));
    assert.deepEqual(after.recallPlace('home'), [39, 67, -38]);
    assert.deepEqual(after.recallPlace('pantry'), [41, 67, -35]);
});

test('the leash anchors on home, not on where the process started', () => {
    // Restarting the agent 300 blocks out used to make 300 blocks out the new
    // centre of its world, which is how a leash follows a wandering bot.
    const bot = { home_point: { x: 0, y: 64, z: 0 }, spawn_point: { x: 300, y: 64, z: 300 } };
    assert.equal(explorationAnchor(bot).x, 0, 'home wins over spawn');
    const original = settings.exploration_radius;
    try {
        settings.exploration_radius = 128;
        assert.equal(withinExplorationRadius(bot, 100, 0), true, 'inside the radius');
        assert.equal(withinExplorationRadius(bot, 300, 300), false, 'the old spawn point is now out of bounds');
        settings.exploration_radius = 0;
        assert.equal(withinExplorationRadius(bot, 9999, 9999), true, '0 still means unlimited');
    } finally { settings.exploration_radius = original; }
});

test('spawn_point is still the fallback before a home is known', () => {
    const bot = { spawn_point: { x: 10, y: 64, z: 10 } };
    assert.equal(explorationAnchor(bot).x, 10);
    assert.equal(withinExplorationRadius({}, 5, 5), true, 'no anchor at all is not a cage');
});

test('far_from_home measures horizontal drift from home', () => {
    const at = (x, z, y = 64) => ({
        bot: { home_point: { x: 0, y: 64, z: 0 }, entity: { position: { x, y, z } } },
    });
    assert.equal(CONDITIONS.far_from_home.fn(at(10, 10), {}), false, 'at camp');
    assert.equal(CONDITIONS.far_from_home.fn(at(300, 0), {}), true, 'the distance every death site was at');
    assert.equal(CONDITIONS.far_from_home.fn(at(50, 0), { range: 48 }), true, 'range is honoured');
    assert.equal(CONDITIONS.far_from_home.fn(at(50, 0), { range: 96 }), false);
    // Down a mineshaft is not away from home, or the bot would be called home
    // every time it went mining.
    assert.equal(CONDITIONS.far_from_home.fn(at(10, 10, -40), {}), false, 'depth is not distance');
    assert.equal(CONDITIONS.far_from_home.fn({ bot: { entity: { position: { x: 0, y: 0, z: 0 } } } }, {}),
        false, 'no home known: nothing to be far from');
});

test('history.save/load actually carries places', () => {
    // The round trip above only proves MemoryBank can do it. This is the part
    // that was missing for the entire life of the class: nobody called it.
    const src = readFileSync(new URL('./history.js', import.meta.url), 'utf8');
    assert.match(src, /places:\s*this\.agent\.memory_bank\.getJson\(\)/,
        'save() writes the places');
    assert.match(src, /if\s*\(data\.places\)\s*this\.agent\.memory_bank\.loadJson\(data\.places\)/,
        'load() reads them back');
});
