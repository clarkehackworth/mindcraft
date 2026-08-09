// flee_when_hurt fired 64 times in 20 minutes on the live bot: health was below 8,
// it fled and then failed to eat ("You do not have any food to eat"), health never
// rose, and 10 seconds later it fired again -- cancelling every action in between,
// including the ones that would have got it food. A rule whose action cannot fix
// its own trigger must not hold an interrupts:all trigger.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import { evalCondition } from './policy.js';

function agentWith(items) {
    return { bot: {
        inventory: { items: () => items },
        registry: { foods: { 5: { name: 'bread' }, 6: { name: 'cooked_beef' } } },
    } };
}

test('has_food sees food in the bag', () => {
    assert.equal(evalCondition({ cond: 'has_food' }, agentWith([{ type: 5, name: 'bread' }])), true);
});

test('has_food is false with only inedible items', () => {
    assert.equal(evalCondition({ cond: 'has_food' }, agentWith([{ type: 99, name: 'cobblestone' }])), false);
    assert.equal(evalCondition({ cond: 'has_food' }, agentWith([])), false);
});

test('every rule that eats is gated on having something to eat', () => {
    const p = JSON.parse(fs.readFileSync('policies/stayin_alive.json', 'utf8'));
    const eaters = p.policy.rules.filter(r => (r.do ?? []).some(a => a.act === 'consume'));
    // Two since eat_when_starving and eat_before_hungry merged into one
    // eat_when_hungry: the floor only proves the filter found the eaters.
    assert.ok(eaters.length >= 2, 'found the eating rules');
    for (const r of eaters) {
        const conds = JSON.stringify(r.when);
        assert.match(conds, /has_food/, `${r.name} can fire with no food and re-trigger forever`);
    }
});

test('the starving bot is not left fleeing forever', () => {
    const p = JSON.parse(fs.readFileSync('policies/stayin_alive.json', 'utf8'));
    const flee = p.policy.rules.find(r => r.name === 'flee_when_hurt');
    const hurt_and_empty = agentWith([]);
    hurt_and_empty.bot.health = 3;
    hurt_and_empty.bot.food = 2;
    const fires = flee.when.all.every(c => evalCondition(c, hurt_and_empty));
    assert.equal(fires, false, 'must yield so the food-finding rules get a turn');
});
