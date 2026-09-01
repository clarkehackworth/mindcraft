// Check: surface_then_climb action registers, validates, and go_to_surface is untouched.
// Run: node tools/surface_then_climb_check.js
// ponytail: policy.js binds skills via `import * as skills` (a read-only ESM
// namespace), so this check verifies the action by source inspection +
// validator round-trip rather than monkey-patching skills.surface/climbOut.
// The behavioral branch (surface true -> return true, surface false ->
// climbOut) is 2 lines and is exercised live by the observation window.
import assert from 'assert';
import { ACTIONS, validatePolicy } from '../src/agent/behavior/policy.js';

// 1. Registered with the right shape
assert.ok(ACTIONS.surface_then_climb, 'surface_then_climb is in ACTIONS');
assert.equal(ACTIONS.surface_then_climb.cost, 'blocking', 'cost is blocking');
assert.ok(ACTIONS.surface_then_climb.clears.includes('drowning'), 'clears drowning');
assert.ok(ACTIONS.surface_then_climb.clears.includes('y_below'), 'clears y_below');
assert.ok(ACTIONS.surface_then_climb.clears.includes('can_dig_down'), 'clears can_dig_down');

// 2. The live rule shape validates
const rule = {
    name: 'surface_when_night_finds_you_underground',
    when: { all: [{ cond: 'is_night' }, { cond: 'y_below', y: 60 }, { not: { cond: 'is_sheltered' } }] },
    do: [{ act: 'surface_then_climb', blocks: 8 }],
    interrupts: 'all',
    cooldown: 60,
    pinned: true,
};
assert.equal(validatePolicy({ rules: [rule] }), null, 'rule with surface_then_climb validates');

// 3. A typo act is rejected
const typoRule = { name: 't', when: { cond: 'is_night' }, do: [{ act: 'surface_then_climbX' }] };
assert.ok(validatePolicy({ rules: [typoRule] }), 'typo act is rejected');

// 4. go_to_surface is untouched: still the single-step drowning reflex, no climbOut
assert.ok(!ACTIONS.go_to_surface.fn.toString().includes('climbOut'), 'go_to_surface does not call climbOut');
assert.ok(ACTIONS.go_to_surface.fn.toString().includes('skills.surface'), 'go_to_surface still calls skills.surface');

// 5. surface_then_climb: surface first, escalate to climbOut only on failure
const src = ACTIONS.surface_then_climb.fn.toString();
assert.ok(src.includes('skills.surface(agent.bot)'), 'calls skills.surface(bot)');
assert.ok(src.includes('skills.climbOut(agent.bot, a.blocks ?? 8)'), 'escalates to skills.climbOut with blocks arg');
assert.ok(src.includes('if (await skills.surface(agent.bot)) return true;'), 'surface success returns true without climbing');

console.log('surface_then_climb: all checks passed');
