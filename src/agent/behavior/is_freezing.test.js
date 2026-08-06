// Run: node --test src/agent/behavior/is_freezing.test.js
// Andy died "froze to death" on Prominence 2 and kept writing itself cold-weather
// rules, but CONDITIONS had no word for cold -- so the model substituted is_night
// or hostile_nearby and landed on {"act": "stay"}, standing still in the open,
// which is the worst rule shape available and the one the validator exists to
// reject. The condition is the missing vocabulary.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import { evalCondition, validatePolicy } from './policy.js';

// Entity metadata key 7 is ticks_frozen in 1.17+.
const botFrozen = (ticks) => ({ bot: { entity: { metadata: ticks === undefined ? [] : { 7: ticks } } } });

test('is_freezing fires once the freeze meter is filling', () => {
    assert.equal(evalCondition({ cond: 'is_freezing' }, botFrozen(120)), true);
});

test('is_freezing is false when the meter is empty or barely started', () => {
    assert.equal(evalCondition({ cond: 'is_freezing' }, botFrozen(0)), false);
    assert.equal(evalCondition({ cond: 'is_freezing' }, botFrozen(10)), false);
});

test('it fires before the damage starts, not after', () => {
    // Vanilla begins dealing freeze damage at 140 ticks. A condition that only
    // fired then would be telling the agent about a problem it is already losing
    // health to.
    assert.equal(evalCondition({ cond: 'is_freezing' }, botFrozen(100)), true,
        'default threshold is below the 140-tick damage point');
});

test('the threshold is tunable', () => {
    assert.equal(evalCondition({ cond: 'is_freezing', ticks: 140 }, botFrozen(120)), false);
    assert.equal(evalCondition({ cond: 'is_freezing', ticks: 30 }, botFrozen(50)), true);
});

test('a server that never sends the field answers false rather than throwing', () => {
    assert.equal(evalCondition({ cond: 'is_freezing' }, botFrozen(undefined)), false);
    assert.equal(evalCondition({ cond: 'is_freezing' }, { bot: {} }), false);
    assert.equal(evalCondition({ cond: 'is_freezing' }, { bot: { entity: {} } }), false);
});

test('the base policy has a rule that answers freezing, and it is valid', () => {
    const p = JSON.parse(fs.readFileSync('policies/stayin_alive.json', 'utf8'));
    assert.equal(validatePolicy(p.policy), null);
    const rule = p.policy.rules.find(r => JSON.stringify(r.when).includes('is_freezing'));
    assert.ok(rule, 'stayin_alive answers freezing itself, so the agent need not invent it');
    // The whole point: whatever it does, it must not be standing still.
    const acts = (rule.do ?? []).map(s => s.act);
    assert.equal(acts.includes('stay'), false, 'waiting does not make you warmer');
});
