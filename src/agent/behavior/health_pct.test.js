// Run: node --test src/agent/behavior/health_pct.test.js
// Max health is 20 in vanilla and 52 on Prominence 2 -- confirmed against the
// server, not inferred. So "flee when health_below 8", which reads like 40% and
// is what stayin_alive said, actually meant 15%: the bot did not react until it
// was nearly dead, and usually died. Thresholds are percentages now.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import { evalCondition, validatePolicy, parseConditionExpr } from './policy.js';

const agentWith = (health, max) => ({
    bot: {
        health,
        entity: max === undefined ? {} : { attributes: { 'minecraft:generic.max_health': { value: max } } },
    },
});

test('pct is measured against this server max, not vanilla', () => {
    // 20 of 52 is 38%, so a 40% rule fires. The same 20 hit points on a vanilla
    // bot would be full health.
    assert.equal(evalCondition({ cond: 'health_below', pct: 40 }, agentWith(20, 52)), true);
    assert.equal(evalCondition({ cond: 'health_below', pct: 40 }, agentWith(20, 20)), false);
});

test('the old absolute form still means exactly what it did', () => {
    assert.equal(evalCondition({ cond: 'health_below', value: 8 }, agentWith(7, 52)), true);
    assert.equal(evalCondition({ cond: 'health_below', value: 8 }, agentWith(9, 52)), false);
});

test('pct wins when both are given', () => {
    assert.equal(evalCondition({ cond: 'health_below', pct: 40, value: 8 }, agentWith(20, 52)), true);
});

test('the flat expression form still means health POINTS', () => {
    // parseConditionExpr fills args positionally from the declared order, so
    // listing pct first silently turned every "health_below 6" in a stay-until
    // string into six percent. The arg order is load-bearing.
    const { spec } = parseConditionExpr('health_below 6');
    assert.deepEqual(spec, { cond: 'health_below', value: 6 });
});

test('an unknown max falls back to vanilla rather than to zero', () => {
    // Falling back to 0 would make every pct rule fire forever, which is worse
    // than being wrong in the safe direction.
    assert.equal(evalCondition({ cond: 'health_below', pct: 50 }, agentWith(9)), true);
    assert.equal(evalCondition({ cond: 'health_below', pct: 50 }, agentWith(11)), false);
});

test('alternative attribute spellings are accepted', () => {
    const bot = { health: 20, entity: { attributes: { 'generic.maxHealth': { value: 52 } } } };
    assert.equal(evalCondition({ cond: 'health_below', pct: 40 }, { bot }), true);
});

test('the shipped policies express health as a percentage', () => {
    // An absolute threshold in a profile is a threshold that is wrong on any
    // server whose maximum is not 20, silently and in the dangerous direction.
    for (const name of ['stayin_alive', 'mining']) {
        const p = JSON.parse(fs.readFileSync(`policies/${name}.json`, 'utf8'));
        assert.equal(validatePolicy(p.policy), null);
        const text = JSON.stringify(p.policy);
        const absolute = text.match(/"cond":"health_below","value"/g) ?? [];
        assert.equal(absolute.length, 0, `${name} still has an absolute health threshold`);
        assert.ok(text.includes('"health_below"'), `${name} should still react to being hurt`);
    }
});
