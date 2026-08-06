// Told once to "shelter at night or when mobs are near", the policy compiler
// wrote the instruction twice:
//   night_mobs_go_to_bed_or_shelter  any[is_night, hostile_nearby 20] -> go_to_bed
//   low_light_shelter_priority       any[is_night, hostile_nearby 16] -> go_to_bed
// Both pinned, both interrupts:all, both firing, neither doing anything the other
// did not -- and the agent had no bed, so both were no-ops that cancelled its work.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import { validatePolicy } from './policy.js';

const shelter = (name, range) => ({
    name, description: 'shelter',
    when: { any: [{ cond: 'is_night', lead: 1500 }, { cond: 'hostile_nearby', range }] },
    // flee answers the mob branch, so these are legal rules individually --
    // isolating what this file tests: that the PAIR is redundant.
    do: [{ act: 'flee', distance: 24 }, { act: 'go_to_bed' }], interrupts: 'all', cooldown: 5, pinned: true,
});

test('the duplicate pair from the live bot is rejected', () => {
    const err = validatePolicy({ rules: [
        shelter('night_mobs_go_to_bed_or_shelter', 20),
        shelter('low_light_shelter_priority', 16),
    ] });
    assert.match(err ?? '', /are the same rule/);
    assert.match(err ?? '', /night_mobs_go_to_bed_or_shelter/);
    assert.match(err ?? '', /low_light_shelter_priority/);
});

test('one of them on its own is fine', () => {
    assert.equal(validatePolicy({ rules: [shelter('shelter_at_night', 16)] }), null);
});

// Numbers are tuning; names are meaning.
test('same shape but different item names are different rules', () => {
    const stow = (name, item, count) => ({
        name, description: 'stow',
        when: { all: [{ cond: 'block_nearby', name: 'chest', range: 24 }, { cond: 'has_item', item, count }] },
        do: [{ act: 'deposit', item }], interrupts: 'idle', cooldown: 60,
    });
    assert.equal(validatePolicy({ rules: [stow('stow_bulk', 'cobblestone', 128), stow('stow_food', 'cooked_beef', 24)] }), null);
});

test('the emergency and opportunistic versions of a rule both belong', () => {
    const eat = (name, value, interrupts) => ({
        name, description: 'eat',
        when: { all: [{ cond: 'hunger_below', value }, { cond: 'has_food' }] },
        do: [{ act: 'consume' }], interrupts, cooldown: 30,
    });
    assert.equal(validatePolicy({ rules: [eat('eat_when_starving', 7, 'all'), eat('eat_before_hungry', 17, 'idle')] }), null);
});

test('every shipped policy is free of duplicates', () => {
    for (const f of fs.readdirSync('policies').filter(n => n.endsWith('.json'))) {
        const p = JSON.parse(fs.readFileSync(`policies/${f}`, 'utf8'));
        assert.equal(validatePolicy(p.policy), null, `${f} must validate`);
    }
});
