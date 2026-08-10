// Cleared on Sunday, and by evening the self layer held four rules that all
// dig_in and stay at night, on top of the dig_in_for_the_night already running.
// The compile prompt does list the installed rules and ask the model not to
// restate them; a small local model reads that as a suggestion. So the drop is
// deterministic now.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { dropDuplicatesForTest as dropDuplicates } from './policy.js';

const installed = [
    { name: 'dig_in_for_the_night',
      when: { all: [{ cond: 'is_night' }, { not: { cond: 'is_sheltered' } }] },
      do: [{ act: 'dig_in' }, { act: 'stay' }] },
    { name: 'leave_your_death_spot',
      when: { all: [{ cond: 'at_death_position' }, { cond: 'holding' }] },
      do: [{ act: 'move_away' }] },
];
const quiet = () => {};

test('the rules the bot keeps rewriting are dropped', () => {
    const written = { rules: [
        // Same actions, and each shares is_night with the installed rule.
        { name: 'night_or_threat_shelter',
          when: { any: [{ cond: 'is_night' }, { cond: 'hostile_nearby' }] },
          do: [{ act: 'dig_in' }, { act: 'stay' }] },
        { name: 'no_chase_at_night_without_weapon',
          when: { all: [{ cond: 'is_night' }, { not: { cond: 'has_item' } }] },
          do: [{ act: 'dig_in' }, { act: 'stay' }] },
    ] };
    dropDuplicates(written, installed, quiet);
    assert.deepEqual(written.rules, []);
});

test('a genuinely new lesson survives sharing an action', () => {
    // keep_out_of_water also move_aways, like leave_your_death_spot, but nothing
    // it triggers on overlaps -- dropping it would lose the lesson.
    const written = { rules: [{ name: 'keep_out_of_water',
        when: { all: [{ cond: 'block_nearby' }, { cond: 'is_idle' }] },
        do: [{ act: 'move_away' }] }] };
    dropDuplicates(written, installed, quiet);
    assert.deepEqual(written.rules.map(r => r.name), ['keep_out_of_water']);
});

test('same trigger but different actions is not a duplicate', () => {
    const written = { rules: [{ name: 'sleep_at_night',
        when: { cond: 'is_night' },
        do: [{ act: 'go_to_bed' }, { act: 'stay' }] }] };
    dropDuplicates(written, installed, quiet);
    assert.deepEqual(written.rules.map(r => r.name), ['sleep_at_night']);
});

test('what was dropped is announced, not swallowed', () => {
    const said = [];
    dropDuplicates({ rules: [{ name: 'dupe', when: { cond: 'is_night' }, do: [{ act: 'dig_in' }, { act: 'stay' }] }] },
        installed, m => said.push(m));
    assert.equal(said.length, 1);
    assert.match(said[0], /dupe.*dig_in_for_the_night/);
});
