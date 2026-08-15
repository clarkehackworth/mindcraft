// Run: node --test src/agent/behavior/rule_dedupe.test.js
// Andy's active layer carried surface_when_drowning ({drowning} -> go_to_surface,
// cooldown 5) while his self layer wrote avoid_deep_water: same trigger, same
// opening action, cooldown 5, and it fired six times in half an hour. The exact
// signature match could not see it, because the self version appended a
// move_away and so the `do` arrays differed by one element.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { composePolicy } from './policy.js';

const state = (layers) => ({ layers });
const names = (s) => composePolicy(s).rules.map(r => r.name);

test('a reworded restatement of a preempting rule is dropped', () => {
    const names_out = names(state({
        active: { policy: { rules: [
            { name: 'surface_when_drowning', when: { cond: 'drowning', air: 12 },
              do: [{ act: 'go_to_surface' }], interrupts: 'all', pinned: true },
        ] } },
        self: { policy: { rules: [
            // Same trigger, different threshold, one extra follow-up action.
            { name: 'avoid_deep_water', when: { cond: 'drowning', air: 10 },
              do: [{ act: 'go_to_surface' }, { act: 'move_away', distance: 20 }],
              interrupts: 'all', pinned: true },
        ] } },
    }));
    // The self layer outranks the active one (RULE_ORDER), so the agent's own
    // wording is the copy that survives. Which one wins matters less than that
    // only one of them can preempt.
    assert.deepEqual(names_out, ['self:avoid_deep_water']);
});

test('a remedy and its fallback both survive', () => {
    // Both of these are real rules off the live bot. They share a trigger but
    // open differently -- dig_in where there is ground to dig, walk out of the
    // biome where there is not. Collapsing them loses the fallback.
    const cold = (extra) => ({ all: [{ cond: 'is_freezing' }, { not: { cond: 'is_sheltered' } }, ...extra] });
    const names_out = names(state({ active: { policy: { rules: [
        { name: 'dig_in_out_of_the_cold', when: cold([{ cond: 'can_dig_down' }]),
          do: [{ act: 'dig_in' }], interrupts: 'all', pinned: true },
        { name: 'get_out_of_the_cold', when: cold([]),
          do: [{ act: 'move_away', distance: 32 }, { act: 'prompt_self', message: 'find shelter' }],
          interrupts: 'all', pinned: true },
    ] } } }));
    assert.equal(names_out.length, 2, 'different opening actions are different rules');
});

test('idle rules are left alone', () => {
    // An interrupts:'idle' rule preempts nothing, so a duplicate costs a wasted
    // turn rather than a killed action -- not worth dropping one on a guess.
    const names_out = names(state({ active: { policy: { rules: [
        { name: 'gather_wood', when: { cond: 'is_idle' }, do: [{ act: 'collect', type: 'oak_log' }], interrupts: 'idle' },
        { name: 'gather_stone', when: { cond: 'is_idle' }, do: [{ act: 'collect', type: 'stone' }], interrupts: 'idle' },
    ] } } }));
    assert.equal(names_out.length, 2);
});

test('conditions are found inside all/any/not', () => {
    // The trigger set is what identifies the rule, so it has to see through the
    // boolean wrappers the compiler actually emits.
    const nested = { all: [{ cond: 'is_night' }, { not: { cond: 'is_sheltered' } },
                           { any: [{ cond: 'hostile_nearby', range: 14 }] }] };
    const names_out = names(state({ active: { policy: { rules: [
        { name: 'shelter_first', when: nested, do: [{ act: 'dig_in' }], interrupts: 'all' },
        { name: 'shelter_again', when: { all: [{ cond: 'hostile_nearby', range: 20 },
                                               { not: { cond: 'is_sheltered' } }, { cond: 'is_night' }] },
          do: [{ act: 'dig_in' }, { act: 'stay' }], interrupts: 'all' },
    ] } } }));
    assert.deepEqual(names_out, ['active:shelter_first'], 'same conditions, any nesting or order');
});
