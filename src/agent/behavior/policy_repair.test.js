import { strict as assert } from 'node:assert';
import test from 'node:test';
import { repairPolicy, validatePolicy } from './policy.js';

const flee = { name: 'run_away', description: 'x', when: { cond: 'hostile_nearby', range: 12 }, do: [{ act: 'flee', distance: 16 }] };
const real = { name: 'eat', description: 'x', when: { cond: 'hunger_below', value: 7 }, do: [{ act: 'consume' }] };

test('a retreat-on-proximity rule becomes the cowardice mode', () => {
    const out = repairPolicy({ modes: { hunting: true }, rules: [flee, real] });
    assert.equal(out.modes.cowardice, true);
    assert.equal(out.modes.hunting, true);
    assert.deepEqual(out.rules.map(r => r.name), ['eat']);
    assert.equal(validatePolicy(out), null, 'the repaired policy passes the check that rejected the original');
});

test('the same trigger with a real action is left alone', () => {
    const armed = { ...flee, name: 'arm', do: [{ act: 'equip_weapon' }, { act: 'flee', distance: 16 }] };
    const input = { modes: {}, rules: [armed] };
    assert.equal(repairPolicy(input), input, 'unchanged policies are returned as-is');
});

test('proximity behind a not is not cowardice', () => {
    const input = { modes: {}, rules: [{ ...flee, when: { not: { cond: 'hostile_nearby', range: 12 } } }] };
    assert.equal(repairPolicy(input), input);
});

test('an interrupting rule faster than the floor is slowed to it, not rejected', () => {
    const fast = { name: 'surface', description: 'x', when: { cond: 'drowning', air: 12 }, do: [{ act: 'go_to_surface' }], interrupts: 'all', cooldown: 3 };
    const out = repairPolicy({ modes: {}, rules: [fast] });
    assert.equal(out.rules[0].cooldown, 5);
    assert.equal(out.rules[0].interrupts, 'all', 'an urgent rule stays urgent');
    assert.equal(validatePolicy(out), null);
});

test('a livelocking interrupt waits for a gap instead of being thrown away', () => {
    // flee cannot make health_below false, so as interrupts:all it cancels
    // everything forever; as idle it still runs, just not on top of other work.
    const loop = { name: 'low_health', description: 'x', when: { cond: 'health_below', value: 6 }, do: [{ act: 'flee', distance: 16 }, { act: 'goto', x: 0, y: 0, z: 0 }], interrupts: 'all', cooldown: 10 };
    const out = repairPolicy({ modes: {}, rules: [loop] });
    assert.equal(out.rules[0].interrupts, 'idle');
    assert.equal(out.rules.length, 1, 'the rule survives');
    assert.equal(validatePolicy(out), null);
});

test('a rule that only fires on nothing-happening is dropped, and the rest survive', () => {
    const aimless = { name: 'avoid_dig_down', description: 'x', when: { cond: 'is_idle' }, do: [{ act: 'say', message: 'do not dig down' }] };
    const out = repairPolicy({ modes: {}, rules: [aimless, real] });
    assert.deepEqual(out.rules.map(r => r.name), ['eat'], 'one bad rule no longer rejects the good ones with it');
    assert.equal(validatePolicy(out), null);
});

test('a rule with a real trigger keeps its prompt_self', () => {
    const grounded = { name: 'restock', description: 'x', when: { cond: 'block_nearby', name: 'chest', range: 16 }, do: [{ act: 'prompt_self', message: 'restock' }] };
    const input = { modes: {}, rules: [grounded] };
    assert.equal(repairPolicy(input), input);
});

test('rules differing only in numbers collapse to the first', () => {
    const a = { name: 'avoid_water_a', description: 'x', when: { cond: 'block_nearby', name: 'water', range: 3 }, do: [{ act: 'move_away', distance: 8 }] };
    const b = { ...a, name: 'avoid_water_b', when: { cond: 'block_nearby', name: 'water', range: 6 }, do: [{ act: 'move_away', distance: 12 }] };
    const out = repairPolicy({ modes: {}, rules: [a, b] });
    assert.deepEqual(out.rules.map(r => r.name), ['avoid_water_a']);
    assert.equal(validatePolicy(out), null);
});

test('rules differing in a string are both kept', () => {
    const a = { name: 'stow_cobble', description: 'x', when: { cond: 'has_item', item: 'cobblestone', count: 128 }, do: [{ act: 'deposit', item: 'cobblestone' }] };
    const b = { name: 'stow_dirt', description: 'x', when: { cond: 'has_item', item: 'dirt', count: 128 }, do: [{ act: 'deposit', item: 'dirt' }] };
    const input = { modes: {}, rules: [a, b] };
    assert.equal(repairPolicy(input), input, 'different jobs, not duplicates');
});

test('a healthy policy is returned untouched', () => {
    const fine = { modes: {}, rules: [{ name: 'eat', description: 'x', when: { cond: 'hunger_below', value: 7 }, do: [{ act: 'consume' }], interrupts: 'all', cooldown: 8 }] };
    assert.equal(repairPolicy(fine), fine);
});

test('malformed input does not throw before the validator can explain it', () => {
    for (const bad of [null, {}, { rules: 'nope' }, { rules: [{ when: { all: 'nope' }, do: [{ act: 'flee' }] }] }])
        assert.doesNotThrow(() => repairPolicy(bad));
});
