// Run: node --test src/agent/behavior/stray_keys.test.js
// The compiler emitted night_no_weapon_shelter with a second copy of the rule's
// own control keys nested inside its "when":
//
//   "when": {"any": [...], "do": [...], "interrupts": "all", "cooldown": 6}
//
// The top-level copies were present and correct, so the rule ran and nothing
// complained -- extra keys were nobody's business, so neither the normalizer nor
// the validator objected. One rule in sixty-one, which is exactly often enough
// to never get noticed.
//
// The same silence covers a worse case. "hostile_nearby" with "rnge": 24 is not
// a typo anything downstream can catch: the condition runs at its default range
// and the rule looks like it works.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { normalizeCondition, validateCondition, CONDITIONS } from './policy.js';

const check = (when) => validateCondition(normalizeCondition(when));

test('the rule keys the compiler misnested are stripped, not rejected', () => {
    // Verbatim from Andy's policy.json. The intent is unambiguous and the
    // top-level copies are already correct, so asking the model again would burn
    // a retry to be told the same thing.
    const when = {
        any: [{ all: [{ cond: 'hostile_nearby', range: 16 }, { not: { cond: 'holding', item: 'weapon' } }] }],
        do: [{ act: 'dig_in' }],
        interrupts: 'all',
        cooldown: 6,
        pinned: true,
    };
    const fixed = normalizeCondition(when);
    assert.deepEqual(Object.keys(fixed), ['any'], 'only the condition survives');
    // The repair must not touch the conditions themselves.
    assert.deepEqual(fixed.any[0].all[0], { cond: 'hostile_nearby', range: 16 });

    // This fixture is the whole rule, and it carried a second defect the
    // stripping was never going to reach: the "any" has one arm. It was written
    // from "if is_night or hostile_nearby 16 and not holding weapon" and the
    // night half never made it into the JSON, so a rule named
    // night_no_weapon_shelter waited for a mob instead of sheltering at dusk.
    // Stray keys are still repaired rather than rejected -- that part is
    // unchanged -- but the missing branch is now reported.
    assert.match(validateCondition(fixed), /one branch/);
});

test('stripping leaves a sound condition sound', () => {
    // The same misnesting, over a trigger that did not lose anything: both
    // branches present, so the repair is all that is needed and it validates.
    const when = {
        any: [
            { all: [{ cond: 'is_night', lead: 1500 }, { not: { cond: 'holding', item: 'weapon' } }] },
            { all: [{ cond: 'hostile_nearby', range: 16 }, { not: { cond: 'holding', item: 'weapon' } }] },
        ],
        do: [{ act: 'dig_in' }],
        interrupts: 'all',
        cooldown: 6,
    };
    const fixed = normalizeCondition(when);
    assert.deepEqual(Object.keys(fixed), ['any']);
    assert.equal(validateCondition(fixed), null);
});

test('a vacuous branch list is refused', () => {
    // "all" of nothing is true forever, "any" of nothing never fires.
    assert.match(check({ all: [] }), /always fires/);
    assert.match(check({ any: [] }), /never fire/);
});

test('a misspelled argument is an error, not a silent default', () => {
    const err = check({ cond: 'hostile_nearby', rnge: 24 });
    assert.ok(err, 'a stray argument has to be reported');
    assert.match(err, /rnge/);
    // The message has to say what IS accepted, or the model's retry is a guess.
    assert.match(err, /Valid: .*range/);
});

test('"name" stays an argument, because two conditions take one', () => {
    // It is on no strip list for exactly this reason.
    assert.equal(check({ cond: 'entity_nearby', name: 'stray', range: 24 }), null);
    assert.equal(check({ cond: 'block_nearby', name: 'water', range: 6 }), null);
});

test('a condition list carrying extra keys is rejected', () => {
    // all/any/not take one thing each. Anything else riding along is either
    // misnesting the normalizer already handled or a mistake worth reporting.
    assert.match(check({ all: [{ cond: 'is_night' }], cond: 'is_freezing' }), /"all" takes only a list/);
    assert.match(check({ not: { cond: 'is_night' }, range: 8 }), /"not" takes only a single condition/);
});

test('every argument every condition documents is accepted', () => {
    // The check is only as good as CONDITIONS.args, so a condition whose args
    // list drifts from what its fn reads would start rejecting valid rules.
    for (const [name, def] of Object.entries(CONDITIONS)) {
        const when = { cond: name };
        for (const arg of Object.keys(def.args ?? {})) when[arg] = 1;
        assert.equal(check(when), null, `${name} rejected its own documented args`);
    }
});

test('the shipped policy passes its own validator', () => {
    // It did not. get_out_of_the_cold passed "ticks": 90 to is_freezing, which
    // takes no arguments and reads no meter -- there is no freeze-meter value on
    // this server, which is why it fires on the cause instead. The threshold had
    // been doing nothing since it was written, and nothing said so.
    const policy = JSON.parse(readFileSync(new URL('../../../policies/stayin_alive.json', import.meta.url), 'utf8'));
    const bad = policy.policy.rules
        .map(r => ({ name: r.name, err: check(r.when) }))
        .filter(r => r.err);
    assert.deepEqual(bad, []);
});
