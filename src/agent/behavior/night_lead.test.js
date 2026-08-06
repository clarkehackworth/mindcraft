// Run: node src/agent/behavior/night_lead.test.js
// "is_night 1500" fires at tick 11500 so the bot can walk home before mobs are
// out. The stay that parks it there has to agree on where night starts, or the
// rule ends the tick it begins.
import assert from 'assert';
import { validatePolicy, parseConditionExpr } from './policy.js';

const rule = (when, until) => ({
    rules: [{ name: 'shelter_at_night', when, do: [{ act: 'goto', x: 0, y: 72, z: 0 }, { act: 'stay', until }] }],
});

// The lead is positional in the flat form, and omitting it still parses.
assert.deepEqual(parseConditionExpr('not is_night 1500').spec, { not: { cond: 'is_night', lead: 1500 } });
assert.deepEqual(parseConditionExpr('not is_night').spec, { not: { cond: 'is_night' } });

// Trigger and stay agree: this is the rule we actually want.
assert.equal(validatePolicy(rule({ cond: 'is_night', lead: 1500 }, 'not is_night 1500')), null);

// Trigger leads, stay does not: the stay is already satisfied at 11500.
assert.match(
    validatePolicy(rule({ cond: 'is_night', lead: 1500 }, 'not is_night')),
    /ends immediately.*not is_night 1500/s,
    'the mismatch is caught when the policy is written, not at dusk'
);

// No lead anywhere: unchanged, still valid.
assert.equal(validatePolicy(rule({ cond: 'is_night' }, 'not is_night')), null);

// A stay on something unrelated is none of this check's business.
assert.equal(validatePolicy(rule({ cond: 'is_night', lead: 1500 }, 'health_below 10')), null);

console.log('ok: a dusk trigger and its stay agree on where night starts');
