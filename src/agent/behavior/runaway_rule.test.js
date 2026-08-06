// Andy wrote himself this rule via !policy and the validator accepted it:
//   {"name":"night_shelter","pinned":true,"interrupts":"all","cooldown":1,
//    "when":{"any":[{"cond":"is_night"},{"cond":"hostile_nearby","range":16}]},
//    "do":[{"act":"go_to_bed"},{"act":"stay","until":"not is_night 1500 and not hostile_nearby 16"}]}
// In daylight, any mob within 16 blocks fired it every second, cancelling every
// action he started -- the sheep search included -- and the stay then parked him
// in the open waiting for a mob to wander off.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { validatePolicy } from './policy.js';

const rule = extra => ({ rules: [{
    name: 'night_shelter', description: 'shelter',
    when: { any: [{ cond: 'is_night', lead: 1500 }, { cond: 'hostile_nearby', range: 16 }] },
    // flee answers the hostile_nearby branch; without it the livelock check fires
    // first and this file would be testing that instead of the cooldown floor.
    do: [{ act: 'flee', distance: 24 }, { act: 'go_to_bed' }], interrupts: 'all', cooldown: 30, ...extra,
}] });

test('the exact rule that broke the live bot is rejected', () => {
    const err = validatePolicy(rule({
        cooldown: 1, pinned: true,
        do: [{ act: 'go_to_bed' }, { act: 'stay', until: 'not is_night 1500 and not hostile_nearby 16' }],
    }));
    assert.ok(err, 'must not be accepted');
});

test('an interrupts:all rule may not fire faster than every 5 seconds', () => {
    assert.match(validatePolicy(rule({ cooldown: 1 })) ?? '', /cooldown of at least 5/);
    assert.match(validatePolicy(rule({ cooldown: 4 })) ?? '', /cooldown of at least 5/);
    assert.equal(validatePolicy(rule({ cooldown: 5 })), null, '5 is allowed');
});

test('the default cooldown is too fast for an interrupts:all rule', () => {
    const { cooldown, ...no_cooldown } = rule().rules[0];
    assert.match(validatePolicy({ rules: [no_cooldown] }) ?? '', /cooldown of at least 5/);
});

test('an idle rule may fire as fast as it likes', () => {
    assert.equal(validatePolicy(rule({ cooldown: 1, interrupts: 'idle' })), null);
});

test('a stay cannot wait for a mob to leave while standing still', () => {
    const err = validatePolicy(rule({
        do: [{ act: 'go_to_bed' }, { act: 'stay', until: 'not hostile_nearby 16' }],
    }));
    assert.match(err ?? '', /Standing still does not make a mob leave/);
});

test('fleeing first makes the same stay legitimate', () => {
    assert.equal(validatePolicy(rule({
        do: [{ act: 'flee', distance: 32 }, { act: 'stay', until: 'not hostile_nearby 16' }],
    })), null);
});

test('breaking a stay ON a mob is still fine -- that is the working night rule', () => {
    assert.equal(validatePolicy(rule({
        when: { cond: 'is_night', lead: 1500 },
        do: [{ act: 'go_to_bed' }, { act: 'stay', until: 'not is_night 1500 or hostile_nearby 8' }],
    })), null);
});
