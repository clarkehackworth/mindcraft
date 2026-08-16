// Run: node src/agent/behavior/recover_drops.test.js
// Andy would spend three windows crafting a sword, a pickaxe and a hundred
// blocks, die once, and start again from nothing. Across a nine-hour soak most
// deaths were the second, third and fourth in a chain that began with one: a
// bot with an empty inventory cannot pillar out of a hole (it starved in one),
// cannot fight what killed it (three arrow deaths, all unarmed), and cannot eat.
//
// pickupNearbyItems had existed the whole time. No rule could ask for it,
// because it was never an action -- and leave_your_death_spot then walked the
// bot 24 blocks off, which is the surest way to let the pile despawn.
import assert from 'assert';
import { ACTIONS, validatePolicy } from './policy.js';
import { readFileSync } from 'fs';

// The action exists and hands the radius through.
{
    assert.ok(ACTIONS.pick_up_drops, 'pick_up_drops is an action a rule can name');
    assert.equal(ACTIONS.pick_up_drops.cost, 'blocking', 'it walks to each drop');
}

const seed = JSON.parse(readFileSync(new URL('../../../policies/stayin_alive.json', import.meta.url)));
const rule = seed.policy.rules.find(r => r.name === 'leave_your_death_spot');

// Order is the point: pick the gear up, then leave. Reversed, the walk away is
// what loses it.
{
    const acts = rule.do.map(s => s.act);
    assert.deepEqual(acts, ['pick_up_drops', 'equip_weapon', 'move_away'],
        'gear first, then arm yourself with it, then go');
}

// A separate rule for this cannot work, and the validator is why: nothing
// pick_up_drops does clears at_death_position, so it would interrupt, achieve
// nothing, and fire again forever. Folding it into the rule that already ends
// the situation is what makes it legal.
{
    const alone = {
        name: 'take_back_what_you_dropped',
        description: 'x',
        when: { all: [{ cond: 'at_death_position', range: 12 }] },
        do: [{ act: 'pick_up_drops', range: 10 }],
        interrupts: 'all', cooldown: 10,
    };
    assert.match(validatePolicy({ rules: [alone] }) ?? '', /achieves nothing/,
        'a pickup-only interrupts:all rule is a livelock and must stay refused');
}

// And the whole shipped policy still passes.
assert.equal(validatePolicy(seed.policy), null, 'stayin_alive stays valid');

console.log('ok: the gear comes back before the bot walks away');
