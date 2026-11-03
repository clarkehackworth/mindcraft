// A non-urgent rule must not take the wheel from a drowning rescue.
// 2026-09-11: surface() was restarted ~12 times in 30s, most attempts dying
// "interrupted after 0s", because every policy rule carries interrupts:'all'.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { urgentHolder } from '../modes.js';

const now = 1_000_000;
const rescuing = { name: 'self_preservation', active: true, active_at: now - 5000 };
const rule = { name: 'policy:active:go_find_trees' };
const defense = { name: 'self_defense' };

test('a policy rule yields to an in-flight drowning rescue', () => {
    assert.equal(urgentHolder(rule, [rescuing, rule], now), rescuing);
});

test('an urgent mode still preempts another urgent mode', () => {
    assert.equal(urgentHolder(defense, [rescuing, defense], now), null);
});

test('nothing to yield to when no urgent mode is firing', () => {
    assert.equal(urgentHolder(rule, [{ ...rescuing, active: false }, rule], now), null);
});

test('a wedged urgent mode stops blocking after the hold expires', () => {
    const stuck = { ...rescuing, active_at: now - 61_000 };
    assert.equal(urgentHolder(rule, [stuck, rule], now), null);
});

test('a mode never yields to itself', () => {
    const self = { name: 'self_preservation', active: true, active_at: now };
    assert.equal(urgentHolder(self, [self], now), null);
});
