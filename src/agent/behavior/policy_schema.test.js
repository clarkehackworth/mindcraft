// Run: node --test src/agent/behavior/policy_schema.test.js
// "when" was {type: 'object'} and "do" was an array of bare objects, so the
// schema said nothing about the two places the model actually writes. That is
// where night_no_weapon_shelter got a second copy of the rule's own control keys
// nested inside its condition:
//
//   "when": {"any": [...], "do": [...], "interrupts": "all", "cooldown": 6}
//
// The decoder had no reason to stop it. Probed against this server's backend
// before relying on any of this: asked outright to nest those keys under an
// additionalProperties:false "when", it could not, and recursive $ref resolves,
// so the whole tree can be constrained rather than just its first level.
//
// These assert the schema's shape directly rather than running a JSON Schema
// validator -- ajv is only a transitive dependency here, and the contract worth
// pinning is "the condition tree cannot hold rule keys", which is a fact about
// the object.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { POLICY_SCHEMA, CONDITIONS, ACTIONS } from './policy.js';

const rule = POLICY_SCHEMA.properties.rules.items;
const condition = POLICY_SCHEMA.$defs.condition;
const action = rule.properties.do.items;

test('a condition cannot carry the rule keys the compiler misnested', () => {
    assert.equal(condition.additionalProperties, false);
    for (const key of ['do', 'interrupts', 'cooldown', 'pinned', 'description'])
        assert.equal(condition.properties[key], undefined, `"${key}" must not be writable inside a condition`);
});

test('the constraint reaches the whole tree, not just the top', () => {
    // A one-level schema would leave every nested clause as free-form. The
    // backend resolves $ref, which is what makes the recursion expressible.
    assert.deepEqual(rule.properties.when, { $ref: '#/$defs/condition' });
    assert.deepEqual(condition.properties.not, { $ref: '#/$defs/condition' });
    for (const key of ['all', 'any'])
        assert.deepEqual(condition.properties[key].items, { $ref: '#/$defs/condition' });
});

test('argument values are scalars, so they cannot pose as nested conditions', () => {
    // Left untyped, {"item": <anything>} accepted an object, and the model
    // promptly used it as a fake condition: {"all": [{"item": {"is_night":
    // true}}]}. Every arg in both registries is a string, number or boolean.
    for (const [name, def] of Object.entries(CONDITIONS))
        for (const arg of Object.keys(def.args ?? {})) {
            const schema = condition.properties[arg];
            assert.ok(schema, `${name}'s "${arg}" is not writable at all`);
            assert.ok(!schema.type.includes('object') && !schema.type.includes('array'),
                `${name}'s "${arg}" accepts a nested structure`);
        }
});

test('the vocabulary is the registry, so an invented name cannot be emitted', () => {
    assert.deepEqual(condition.properties.cond.enum, Object.keys(CONDITIONS));
    assert.deepEqual(action.properties.act.enum, Object.keys(ACTIONS));
    assert.equal(action.additionalProperties, false);
    assert.equal(rule.additionalProperties, false);
});

test('every rule the shipped policy already contains stays writable', () => {
    // The real risk of tightening a schema is not laxness, it is making a
    // legitimate rule impossible -- that breaks compilation outright, where a
    // loose schema costs one retry. So the schema has to admit what already ships.
    const policy = JSON.parse(readFileSync(new URL('../../../policies/stayin_alive.json', import.meta.url), 'utf8'));
    const walk = (when, path) => {
        if (!when || typeof when !== 'object') return;
        for (const [key, value] of Object.entries(when)) {
            assert.ok(key in condition.properties, `${path}: "${key}" is not writable under the schema`);
            if (key === 'not') walk(value, path);
            else if (key === 'all' || key === 'any') value.forEach(v => walk(v, path));
            else if (key === 'cond') assert.ok(CONDITIONS[value], `${path}: unknown condition "${value}"`);
        }
    };
    for (const r of policy.policy.rules) {
        for (const key of Object.keys(r))
            assert.ok(key in rule.properties, `${r.name}: rule key "${key}" is not writable`);
        walk(r.when, r.name);
        for (const step of r.do) {
            assert.ok(ACTIONS[step.act], `${r.name}: unknown action "${step.act}"`);
            for (const key of Object.keys(step))
                assert.ok(key in action.properties, `${r.name}: action arg "${key}" is not writable`);
        }
    }
});
