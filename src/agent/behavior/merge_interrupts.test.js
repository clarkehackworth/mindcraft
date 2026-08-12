// A regen merge came back with "interrupts" stripped from all 37 rules. Missing
// means "all" at install, so every opportunistic rule became a reflex and the
// bot spent an hour cancelling its own actions. The profiles still hold the
// declaration, so the merge output gets it back.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { restoreInterruptsForTest } from './policy.js';

const profiles = [
    { policy: { rules: [
        { name: 'dig_in_when_hunted', interrupts: 'all' },
        { name: 'gather_wood_for_base', interrupts: 'idle' },
    ] } },
    { policy: { rules: [{ name: 'walk_the_berry_route', interrupts: 'idle' }] } },
];

test('a merge that dropped interrupts gets the profile declaration back', () => {
    const merged = { rules: [
        { name: 'dig_in_when_hunted' },
        { name: 'gather_wood_for_base' },
        { name: 'walk_the_berry_route' },
    ] };
    restoreInterruptsForTest(merged, profiles);
    assert.deepEqual(merged.rules.map(r => r.interrupts), ['all', 'idle', 'idle']);
});

// climb_out_of_the_deep went into the merge declaring "all" and came out
// declaring "idle" -- the merge compresses descriptions too, and the sentence
// explaining why it interrupts was what it cut. A rewrite looks exactly like a
// considered choice, so the profile wins outright.
test('a merge that rewrote interrupts does not get to keep the rewrite', () => {
    const merged = { rules: [
        { name: 'dig_in_when_hunted', interrupts: 'idle' },
        { name: 'a_rule_the_merge_invented', interrupts: 'idle' },
    ] };
    restoreInterruptsForTest(merged, profiles);
    assert.equal(merged.rules[0].interrupts, 'all');
    // Nothing declared it, so there is nothing to restore and it keeps its own.
    assert.equal(merged.rules[1].interrupts, 'idle');
});

test('profiles with no rules of their own do not throw', () => {
    const merged = { rules: [{ name: 'x' }] };
    restoreInterruptsForTest(merged, [{ source: ['prose only'] }]);
    assert.equal(merged.rules[0].interrupts, undefined);
});
