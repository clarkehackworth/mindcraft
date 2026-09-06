// Self-check for the descend_perch fix: the getOffPerch skill, the
// descend_perch action, the get_off_the_perch self-layer rule, and the
// forgetPlace hook that stops the 1,740-fire grave loop.
// Run: node tools/descend_perch_check.js
import assert from 'assert';
import fs from 'fs';
import { validatePolicy, evalCondition, ACTIONS } from '../src/agent/behavior/policy.js';
import { MemoryBank } from '../src/agent/memory_bank.js';

// ---------------------------------------------------------------------------
// 1. descend_perch action exists and is wired correctly
// ---------------------------------------------------------------------------
assert.ok(ACTIONS.descend_perch, 'descend_perch action must exist in ACTIONS');
assert.equal(ACTIONS.descend_perch.cost, 'blocking', 'descend_perch must be blocking');
assert.ok(
    ACTIONS.descend_perch.clears.includes('y_above'),
    'descend_perch must clear y_above so the rule is self-stopping'
);
assert.ok(
    ACTIONS.descend_perch.clears.includes('ranged_hostile_nearby'),
    'descend_perch must clear ranged_hostile_nearby'
);
assert.equal(typeof ACTIONS.descend_perch.fn, 'function', 'descend_perch must have a fn');
console.log('PASS: descend_perch action wired correctly');

// ---------------------------------------------------------------------------
// 2. get_off_the_perch rule validates (no livelock, no unknown action/cond)
// ---------------------------------------------------------------------------
const rule = {
    name: 'get_off_the_perch',
    when: {
        all: [
            { cond: 'y_above', y: 67 },
            { cond: 'ranged_hostile_nearby', range: 24 }
        ]
    },
    do: [{ act: 'descend_perch' }],
    pinned: true,
    interrupts: 'all',
    cooldown: 5
};
assert.equal(validatePolicy({ rules: [rule] }), null, 'get_off_the_perch must pass validatePolicy');
console.log('PASS: get_off_the_perch rule validates');

// ---------------------------------------------------------------------------
// 3. The rule is self-stopping: descend_perch clears both trigger conditions
// ---------------------------------------------------------------------------
const clears = new Set(ACTIONS.descend_perch.clears);
assert.ok(clears.has('y_above'), 'descend_perch clears y_above');
assert.ok(clears.has('ranged_hostile_nearby'), 'descend_perch clears ranged_hostile_nearby');
console.log('PASS: rule is self-stopping (action clears all trigger conds)');

// ---------------------------------------------------------------------------
// 4. Condition shapes: y_above reads {y}, ranged_hostile_nearby reads {range}
// ---------------------------------------------------------------------------
const fakeAgentPerched = {
    bot: {
        entity: { position: { y: 71, distanceTo: () => 5 } },
        health: 20, food: 20, interrupt_code: false,
        time: { timeOfDay: 14000 },
        findEntities: () => [{}],
        getEntities: () => [{}]
    },
    memory_bank: new MemoryBank(),
    isIdle: () => true
};
// y_above: feet at 71 > 67 → true
assert.equal(evalCondition({ cond: 'y_above', y: 67 }, fakeAgentPerched), true,
    'y_above 67 should be true when feet are at y=71');
// y_above: feet at 67 → false (not strictly above)
const fakeAgentGround = { ...fakeAgentPerched, bot: { ...fakeAgentPerched.bot, entity: { position: { y: 67, distanceTo: () => 5 } } } };
assert.equal(evalCondition({ cond: 'y_above', y: 67 }, fakeAgentGround), false,
    'y_above 67 should be false when feet are at y=67');
console.log('PASS: condition shapes correct');

// ---------------------------------------------------------------------------
// 5. MemoryBank.forgetPlace works
// ---------------------------------------------------------------------------
const mb = new MemoryBank();
mb.rememberPlace('last_grave_position', -28, 71, 87);
assert.deepEqual(mb.recallPlace('last_grave_position'), [-28, 71, 87]);
mb.forgetPlace('last_grave_position');
assert.equal(mb.recallPlace('last_grave_position'), undefined, 'forgetPlace must clear the place');
assert.equal('last_grave_position' in mb.getJson(), false, 'forgetPlace must remove from json');
// forgetting a non-existent key must not throw
mb.forgetPlace('nonexistent');
console.log('PASS: MemoryBank.forgetPlace works');

// ---------------------------------------------------------------------------
// 6. Live policy: Andy's self layer contains the pinned rule
// ---------------------------------------------------------------------------
const live = JSON.parse(fs.readFileSync('bots/Andy/policy.json', 'utf8'));
const selfRules = (live.layers?.self?.policy?.rules ?? []);
const perchRule = selfRules.find(r => r.name === 'get_off_the_perch');
assert.ok(perchRule, 'Andy self layer must contain get_off_the_perch');
assert.equal(perchRule.pinned, true, 'rule must be pinned');
assert.equal(perchRule.interrupts, 'all', 'rule must interrupt all');
assert.ok(perchRule.cooldown >= 5, 'cooldown must be >= 5 (MIN_INTERRUPT_COOLDOWN)');
console.log('PASS: live policy self layer has the pinned rule');

// ---------------------------------------------------------------------------
// 7. Full live policy validates (both layers composed)
// ---------------------------------------------------------------------------
// Compose the way the runtime does: merge active + self, sort pinned first
const activeRules = (live.layers?.active?.policy?.rules ?? []);
const allRules = [...selfRules.map(r => ({ ...r, _rank: 0 })), ...activeRules.map(r => ({ ...r, _rank: 1 }))];
allRules.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a._rank - b._rank);
const composed = { modes: {}, rules: allRules.map(({ _rank, ...r }) => r) };
const liveErr = validatePolicy(composed);
assert.equal(liveErr, null, `Composed live policy must validate: ${liveErr}`);
console.log('PASS: full composed live policy validates');

console.log('\nAll descend_perch checks passed.');
