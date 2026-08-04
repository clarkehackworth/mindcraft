// Run: node --test src/agent/behavior/equip_weapon.test.js
// Andy's "equip a weapon when in danger" rule fired 156 times in 12 minutes of
// daylight and interrupted goToCoordinates 54 times. Three defects: its guard
// accepted any of five swords while its action always named wooden_sword, it
// re-equipped what was already in hand, and interrupts:"all" let it cancel an
// escape every 3 seconds. equip_weapon picks by attack damage and reports
// honestly whether it did anything, so the rule cooldown can back off.
import test from 'node:test';
import assert from 'assert';
import { equipHighestAttack } from '../library/skills.js';
import { ACTIONS } from './policy.js';

const item = (name, attackDamage) => ({ name, attackDamage });

function makeBot(items, held = null) {
    const bot = {
        heldItem: held,
        equipped: [],
        inventory: { items: () => items },
        async equip(it) { bot.equipped.push(it.name); bot.heldItem = it; },
    };
    return bot;
}

test('picks the best weapon, not a hardcoded one', async () => {
    const bot = makeBot([item('wooden_sword', 4), item('iron_sword', 6)]);
    assert.equal(await equipHighestAttack(bot), true);
    assert.deepEqual(bot.equipped, ['iron_sword']);
});

test('equips a modded sword no hardcoded list would name', async () => {
    const bot = makeBot([item('wooden_sword', 4), item('cincinnasite_sword', 9)]);
    await equipHighestAttack(bot);
    assert.deepEqual(bot.equipped, ['cincinnasite_sword']);
});

test('re-equipping what is already held is not work', async () => {
    const held = item('iron_sword', 6);
    const bot = makeBot([item('wooden_sword', 4), held], held);
    assert.equal(await equipHighestAttack(bot), false, 'reports no progress so the rule backs off');
    assert.deepEqual(bot.equipped, [], 'and does not touch the hand');
});

test('no weapon at all is a no-op, not a failure to retry forever', async () => {
    const bot = makeBot([item('oak_log', 0)]);
    assert.equal(await equipHighestAttack(bot), false);
    assert.deepEqual(bot.equipped, []);
});

test('falls back to a tool when there is no weapon', async () => {
    const bot = makeBot([item('stone_pickaxe', 3)]);
    assert.equal(await equipHighestAttack(bot), true);
    assert.deepEqual(bot.equipped, ['stone_pickaxe']);
});

test('the policy action takes no args, so guard and action cannot disagree', async () => {
    assert.deepEqual(ACTIONS.equip_weapon.args, {});
    const bot = makeBot([item('stone_sword', 5)]);
    assert.equal(await ACTIONS.equip_weapon.fn({ bot }), true);
    assert.deepEqual(bot.equipped, ['stone_sword']);
});
