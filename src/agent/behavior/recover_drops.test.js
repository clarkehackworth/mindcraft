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

// This server runs YIGD: a death does not scatter the inventory, it puts the
// whole lot inside a grave block at the death site. So pickupNearbyItems found
// nothing after every death -- "Picked up 0 item" -- and the bot started from
// nothing however promptly it walked back. The grave is also the obstacle the
// pathfinder cannot pass: 269 of 318 stuck resets in one window were a single
// one, with 3 goals reached in half an hour. Breaking it does both jobs.
//
// recoverGrave itself wants a live block registry to do anything, so what is
// pinned here is the wiring: which one is asked first, and whether the
// description says so. Both are things a later edit could quietly undo.
{
    const { recoverGrave } = await import('../library/skills.js');
    assert.equal(typeof recoverGrave, 'function', 'the skill exists to be called');

    const src = ACTIONS.pick_up_drops.fn.toString();
    assert.ok(src.includes('recoverGrave'), 'the action opens the grave');
    assert.ok(src.indexOf('recoverGrave') < src.indexOf('pickupNearbyItems'),
        'grave first, loose items second -- the floor is empty on this server');
    assert.match(ACTIONS.pick_up_drops.desc, /grave/,
        'and the description says so, since a model picks its actions by reading it');
}

console.log('ok: the grave is opened before the floor is swept');

// Going back for the grave had to be a rule of its own. Every recovery path was
// reactive -- leave_your_death_spot wants the bot already within 12 blocks of
// the death spot, the stuck handler wants eight collisions on the grave itself
// -- and the bot respawns elsewhere and walks off, so neither ever fired. Two
// graves stood unopened holding everything it owned while it starved.
{
    const seed = JSON.parse(readFileSync(new URL('../../../policies/stayin_alive.json', import.meta.url)));
    const back = seed.policy.rules.find(r => r.name === 'go_back_for_your_grave');
    assert.ok(back, 'something goes TO the grave, not only reacts at it');
    assert.deepEqual(back.do.map(s => s.act), ['goto_place', 'pick_up_drops'],
        'walk there, then open it');
    assert.equal(back.do[0].name, 'last_death_position', 'the place the death handler records');

    // Daylight and no hostiles: the sibling rule already paid for that lesson --
    // "the walk is what killed the bot, 28 times in one game-day".
    const gates = JSON.stringify(back.when);
    assert.match(gates, /is_night/, 'not at night');
    assert.match(gates, /hostile_nearby/, 'not with something watching');
    assert.match(gates, /place_known/, 'and only once there is somewhere to go');
    assert.equal(back.interrupts, 'idle', 'the gear can wait for a gap');

    // It waits its turn behind coming home: the first idle rule claims the gap,
    // and drifting home outranks fetching gear. night_work pins that ordering.
    const idle = seed.policy.rules.filter(r => r.interrupts === 'idle').map(r => r.name);
    assert.equal(idle[0], 'come_home_when_far', 'homing still claims the gap first');
    assert.equal(idle[1], 'go_back_for_your_grave', 'and the grave trip is next in line');
}

console.log('ok: something goes back for the grave on purpose');
