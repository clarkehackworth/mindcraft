// Run: node src/agent/behavior/asymmetric_guard.test.js
// night_no_weapon_shelter was written as
//
//   any[ all[is_night, not holding weapon, NOT is_sheltered],
//        all[hostile_nearby 16, not holding weapon] ]          <- no guard
//
// so once the bot dug in, branch one went false and branch two stayed true. A
// sheltered, unarmed bot with a mob outside re-dug every six seconds. It fired
// 126 times in one half-hour window while every other rule in the policy fired
// twice, the bot reached zero goals and did not move a millimetre, and the
// unresolved counter watched it climb past 115 before something briefly cleared
// the trigger and it began again.
import assert from 'assert';
import { validatePolicy, ACTIONS } from './policy.js';
import { readFileSync } from 'fs';

const shelter = (guardBothBranches) => ({
    name: 'night_no_weapon_shelter', description: 'x', interrupts: 'all', cooldown: 20,
    when: { any: [
        { all: [{ cond: 'is_night', lead: 1500 }, { not: { cond: 'holding', item: 'weapon' } },
                { not: { cond: 'is_sheltered' } }] },
        { all: [{ cond: 'hostile_nearby', range: 16 }, { not: { cond: 'holding', item: 'weapon' } },
                ...(guardBothBranches ? [{ not: { cond: 'is_sheltered' } }] : [])] },
    ] },
    do: [{ act: 'equip_weapon' }, { act: 'dig_in' }, { act: 'stay', until: 'not is_night 1500', seconds: 60 }],
});

assert.match(validatePolicy({ rules: [shelter(false)] }) ?? '', /is_sheltered/,
    'the lopsided version is refused, naming the guard that is missing');
assert.equal(validatePolicy({ rules: [shelter(true)] }), null,
    'and the repaired version passes');

// It has to be the negation that matters. hostile_nearby appears in one branch
// only and always will -- night is one situation, a mob is another, which is
// the entire point of an "any". The first version of this check counted those
// too and refused the very rule it was written to repair.
{
    const differentSituations = {
        name: 'two_honest_cases', description: 'x', interrupts: 'all', cooldown: 20,
        when: { any: [
            { all: [{ cond: 'is_night', lead: 1500 }, { not: { cond: 'is_sheltered' } }] },
            { all: [{ cond: 'hostile_nearby', range: 16 }, { not: { cond: 'is_sheltered' } }] },
        ] },
        do: [{ act: 'dig_in' }],
    };
    assert.equal(validatePolicy({ rules: [differentSituations] }), null,
        'positive conditions differing per branch is what "any" is for');
}

// And none of it works unless dig_in admits what it does. It declared
// hostile_nearby, entity_nearby, at_position and is_freezing but not
// is_sheltered -- so the validator could not see that the rule resolves the very
// guard it was missing, and this whole class of bug was invisible to it.
assert.ok(ACTIONS.dig_in.clears.includes('is_sheltered'),
    'digging in is what being sheltered means');

// The shipped policy is clean, which is the measurement that made this check
// worth adding rather than the last one I proposed and threw away.
{
    const seed = JSON.parse(readFileSync(new URL('../../../policies/stayin_alive.json', import.meta.url)));
    assert.equal(validatePolicy(seed.policy), null, 'stayin_alive stays valid');
}

console.log('ok: a guard on one branch belongs on its siblings');
