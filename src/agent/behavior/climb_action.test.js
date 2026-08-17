// Run: node src/agent/behavior/climb_action.test.js
// climb_out_of_the_deep triggers on y_below 45 and called go_to_surface, which
// is skills.surface -- the DROWNING escape. Its first line is:
//
//     if (isBreathing(bot)) { log('Already breathing...'); return true; }
//
// So 47 blocks underground in open air it did nothing and returned SUCCESS. It
// logged that line 17 times in one window and 9 in the next, every fire looking
// healthy to the failure counter and to the backoff, while Andy sank from y=68
// to y=12 over eight hours. Only the unresolved counter caught it, at 25
// consecutive fires that settled nothing.
//
// climbOut -- the function that pillars and digs upward, and the first thing
// fixed in this whole soak -- had no action at all. It was reachable only from
// inside moveAway, so no rule could ask for it.
import assert from 'assert';
import { ACTIONS, validatePolicy } from './policy.js';
import { readFileSync } from 'fs';

// The action exists, is blocking, and clears the condition the rule fires on --
// which is what stops it looping forever once it works.
{
    assert.ok(ACTIONS.climb_out, 'a rule can ask to climb out');
    assert.equal(ACTIONS.climb_out.cost, 'blocking', 'it walks and digs');
    assert.ok(ACTIONS.climb_out.clears.includes('y_below'),
        'gaining height is what ends "I am too deep"');
}

// The descriptions have to tell these two apart, because a model picks actions
// by reading them and picking wrong here costs eight hours.
{
    assert.match(ACTIONS.climb_out.desc, /drowning/i,
        'climb_out says which one go_to_surface is');
    assert.match(ACTIONS.go_to_surface.desc, /drowning|water|swim/i,
        'and go_to_surface says it is about water');
}

// The shipped rule asks for the climb, not the swim.
{
    const seed = JSON.parse(readFileSync(new URL('../../../policies/stayin_alive.json', import.meta.url)));
    const rule = seed.policy.rules.find(r => r.name === 'climb_out_of_the_deep');
    assert.deepEqual(rule.do.map(s => s.act), ['climb_out'],
        'the rule about being underground uses the underground action');
    assert.equal(validatePolicy(seed.policy), null, 'and the policy still validates');
}

console.log('ok: being stuck underground is not a drowning');
