// Three classes of compiler churn seen live on 2026-08-05, all of them costing
// a full LLM retry (and often the whole !policy call, which is three) for a
// mistake with exactly one sensible reading.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { parseConditionExpr, normalizeCondition, repairPolicy, summarizeRules, describeCondition } from './policy.js';

test('a stay "until" may mix and with or, and binds tighter', () => {
    // "Rule night_no_weapon_no_bed_stay_shelter: stay needs a valid until
    // condition: mixing and with or is not supported" -- three times in one
    // session, from an agent that had just been told to write a simpler rule.
    const { spec, error } = parseConditionExpr('not is_night 1500 and has_food or health_below 6');
    assert.equal(error, undefined);
    assert.deepEqual(spec, { any: [
        { all: [{ not: { cond: 'is_night', lead: 1500 } }, { cond: 'has_food' }] },
        { cond: 'health_below', value: 6 },
    ] });
});

test('the un-mixed forms still parse the way they always did', () => {
    assert.deepEqual(parseConditionExpr('not is_night 1500').spec, { not: { cond: 'is_night', lead: 1500 } });
    assert.deepEqual(parseConditionExpr('is_night or hostile_nearby 8').spec,
        { any: [{ cond: 'is_night' }, { cond: 'hostile_nearby', range: 8 }] });
    assert.deepEqual(parseConditionExpr('is_night and hostile_nearby 8').spec,
        { all: [{ cond: 'is_night' }, { cond: 'hostile_nearby', range: 8 }] });
});

test('an unknown condition is still an error, mixed or not', () => {
    assert.match(parseConditionExpr('is_night and nope').error, /unknown condition "nope"/);
    assert.match(parseConditionExpr('nope or is_night').error, /unknown condition "nope"/);
});

test('normalizeCondition repairs the four shapes the model actually emits', () => {
    // "unknown condition [object Object]"
    assert.deepEqual(normalizeCondition({ cond: { cond: 'is_night', lead: 1500 } }),
        { cond: 'is_night', lead: 1500 });
    // "unknown condition undefined", name under the wrong key
    assert.deepEqual(normalizeCondition({ condition: 'hostile_nearby', range: 8 }),
        { cond: 'hostile_nearby', range: 8 });
    // "unknown condition undefined", name as the key
    assert.deepEqual(normalizeCondition({ is_night: { lead: 1500 } }),
        { cond: 'is_night', lead: 1500 });
    // '"all" must be an array'
    assert.deepEqual(normalizeCondition({ all: { cond: 'has_food' } }),
        { all: [{ cond: 'has_food' }] });
});

test('normalizeCondition recurses and leaves good trees alone', () => {
    const good = { all: [{ cond: 'is_night', lead: 1500 }, { not: { cond: 'holding', item: 'weapon' } }] };
    assert.deepEqual(normalizeCondition(good), good);
    assert.deepEqual(normalizeCondition({ any: [{ not: { condition: 'has_food' } }] }),
        { any: [{ not: { cond: 'has_food' } }] });
});

test('normalizeCondition does not invent a condition it cannot recognise', () => {
    // A leaf naming something that is not a condition stays broken, so the
    // validator still reports it rather than this silently guessing.
    assert.deepEqual(normalizeCondition({ nope: { range: 8 } }), { nope: { range: 8 } });
});

test('repairPolicy normalizes before it judges a rule', () => {
    // The malformed leaf here is a hostile-proximity trigger. If repairPolicy
    // judged the rule before fixing it, triggersOnProximity would read nothing,
    // the cowardice check would not fire, and a duplicate-of-cowardice rule
    // would survive on a technicality.
    const out = repairPolicy({ rules: [{
        name: 'x',
        when: { condition: 'hostile_nearby', range: 8 },
        do: [{ act: 'flee', distance: 16 }],
    }] });
    assert.equal(out.rules.length, 0, 'recognised as cowardice once the leaf was readable');
    assert.equal(out.modes?.cowardice, true);
});

test('summarizeRules gives the compiler one readable line per installed rule', () => {
    const text = summarizeRules({ rules: [
        { name: 'flee_ranged_raiders', pinned: true, when: { cond: 'entity_nearby', name: 'stray', range: 24 },
          do: [{ act: 'flee', distance: 40 }, { act: 'stay', until: 'not is_night 1500' }] },
    ] });
    assert.match(text, /flee_ranged_raiders \(pinned\)/);
    assert.match(text, /flee, stay/);
    assert.equal(text.split('\n').length, 1, 'one line per rule, not the full JSON');
});

test('the parser accepts the syntax describeCondition prints', () => {
    // Live, three times in one window: "stay needs a valid until condition:
    // unknown condition entity_nearby(name=illusioner,range=16)". The model was
    // not inventing that -- it is exactly what describeCondition emits, and what
    // it reads back in every rule description. Printing one grammar and parsing
    // another is our bug.
    assert.deepEqual(parseConditionExpr('entity_nearby(name=illusioner, range=16)').spec,
        { cond: 'entity_nearby', name: 'illusioner', range: 16 });
    assert.deepEqual(parseConditionExpr('is_night(lead=1500)').spec,
        { cond: 'is_night', lead: 1500 });
    assert.deepEqual(parseConditionExpr('not hostile_nearby(range=8)').spec,
        { not: { cond: 'hostile_nearby', range: 8 } });
});

test('a printed condition round-trips back through the parser', () => {
    // The property that should have held all along.
    for (const spec of [
        { cond: 'entity_nearby', name: 'stray', range: 24 },
        { cond: 'is_night', lead: 1500 },
        { cond: 'health_below', value: 6 },
    ]) {
        const printed = describeCondition(spec);
        assert.deepEqual(parseConditionExpr(printed).spec, spec, `round trip failed for ${printed}`);
    }
});

test('the printed form mixes with and/or like the flat form', () => {
    assert.deepEqual(parseConditionExpr('not is_night(lead=1500) or hostile_nearby(range=8)').spec,
        { any: [{ not: { cond: 'is_night', lead: 1500 } }, { cond: 'hostile_nearby', range: 8 }] });
});

test('a bad argument name in the printed form is still an error', () => {
    assert.match(parseConditionExpr('is_night(nope=1)').error, /no argument "nope"/);
    assert.match(parseConditionExpr('not_a_condition(x=1)').error, /unknown condition/);
});
