// The same bug arrived three times wearing different clothes:
//   flee_when_hurt   health_below -> flee + consume, with no food
//   night_shelter    night OR mob -> go_to_bed, with no bed
//   night_shelter    ...then stay until the mob leaves, without moving
// Each fires interrupts:all, runs something long, cannot change what set it off,
// and so cancels every other action forever. One check now covers the class,
// using the cost/clears annotations on the actions.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import { validatePolicy, ACTIONS } from './policy.js';

const rule = extra => ({ name: 'r', description: 'd', interrupts: 'all', cooldown: 30, ...extra });
const check = r => validatePolicy({ rules: [rule(r)] });

test('every action is annotated', () => {
    for (const [name, a] of Object.entries(ACTIONS)) {
        assert.ok(['cheap', 'blocking'].includes(a.cost), `${name} has no cost`);
        assert.ok(a.clears === '*' || Array.isArray(a.clears), `${name} has no clears`);
    }
});

test('go_to_bed cannot answer "a mob is nearby"', () => {
    const err = check({ when: { any: [{ cond: 'is_night' }, { cond: 'hostile_nearby', range: 16 }] }, do: [{ act: 'go_to_bed' }] });
    assert.match(err ?? '', /hostile_nearby/);
    assert.match(err ?? '', /fires again next cooldown/);
});

test('the same rule is fine once it flees first', () => {
    assert.equal(check({ when: { any: [{ cond: 'is_night' }, { cond: 'hostile_nearby', range: 16 }] },
        do: [{ act: 'flee', distance: 24 }, { act: 'go_to_bed' }] }), null);
});

// The exemption the "cost" annotation exists for.
test('cheap prep may repeat forever without clearing its trigger', () => {
    assert.equal(check({ when: { cond: 'hostile_nearby', range: 12 }, do: [{ act: 'equip_weapon' }], cooldown: 6 }), null,
        'hold_weapon_when_threatened is a good rule and must stay legal');
});

test('a long action that cannot clear its trigger is not', () => {
    assert.ok(check({ when: { cond: 'hostile_nearby', range: 12 }, do: [{ act: 'collect', type: 'log' }] }));
});

test('an idle rule is exempt -- it waits for a gap instead of taking one', () => {
    assert.equal(check({ when: { any: [{ cond: 'is_night' }, { cond: 'hostile_nearby' }] },
        do: [{ act: 'go_to_bed' }], interrupts: 'idle' }), null);
});

// "any" fires on one branch, so every branch must be answerable;
// "all" needs them all, so answering one is enough.
test('an all-trigger only needs one branch answerable', () => {
    assert.equal(check({ when: { all: [{ cond: 'health_below', value: 8 }, { cond: 'has_food' }] },
        do: [{ act: 'flee', distance: 32 }, { act: 'consume' }] }), null, 'flee_when_hurt, gated, is legal');
});

test('an any-trigger needs every branch answerable', () => {
    assert.ok(check({ when: { any: [{ cond: 'drowning' }, { cond: 'hostile_nearby' }] }, do: [{ act: 'go_to_surface' }] }),
        'go_to_surface answers drowning but not the mob');
});

test('the real survival rules all still validate', () => {
    const p = JSON.parse(fs.readFileSync('policies/stayin_alive.json', 'utf8'));
    assert.equal(validatePolicy(p.policy), null);
    // and specifically the ones that trigger on something they do not remove
    const flee = p.policy.rules.find(r => r.name === 'flee_when_hurt');
    const weapon = p.policy.rules.find(r => r.name === 'hold_weapon_when_threatened');
    const drown = p.policy.rules.find(r => r.name === 'surface_when_drowning');
    for (const r of [flee, weapon, drown]) assert.equal(validatePolicy({ rules: [r] }), null, r.name);
});

// The escape hatch that let the bug straight back in. Andy's self layer
// regenerated shelter_build_if_needed: interrupts:all, cooldown 10, is_night ->
// prompt_self("build a small enclosed shelter"). Night lasts ~7 minutes, so it
// cancelled the agent ~40 times a night, interrupting its own attempts to dig
// out of the shelter the previous firing had told it to build.
test('a prompt_self rule cannot claim to resolve its own trigger', () => {
    const err = check({ when: { cond: 'is_night', lead: 1500 }, cooldown: 10,
        do: [{ act: 'prompt_self', message: 'Build a small enclosed shelter nearby.' }] });
    assert.match(err ?? '', /is_night/);
    assert.match(err ?? '', /fires again next cooldown/);
});

test('but a prompt_self rule that waits for a gap is fine', () => {
    assert.equal(check({ when: { cond: 'is_night', lead: 1500 }, interrupts: 'idle', cooldown: 10,
        do: [{ act: 'prompt_self', message: 'Consider sheltering.' }] }), null);
});

test('the shipped prompt_self rules are all idle and still validate', () => {
    const p = JSON.parse(fs.readFileSync('policies/stayin_alive.json', 'utf8'));
    const prompts = p.policy.rules.filter(r => (r.do ?? []).some(a => a.act === 'prompt_self'));
    assert.ok(prompts.length >= 3, 'found the prompting rules');
    for (const r of prompts) assert.equal(validatePolicy({ rules: [r] }), null, r.name);
});
