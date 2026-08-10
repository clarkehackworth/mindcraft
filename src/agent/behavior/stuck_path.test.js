// Two soaks ended the same way: the pathfinder failing over and over from one
// block. 6281 attempts in a single 16-block box in one game-day, and a grind to
// 1106 visited nodes at one block right before the agent dropped off the server.
// A count of failures says pathing is hard, which it always is. A count of
// failures *from the same block* says this route is not happening.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import { evalCondition, validatePolicy, ACTIONS } from './policy.js';

test('path_stuck counts repeats, not failures', () => {
    const at = count => ({ path_stuck_count: count });
    assert.equal(evalCondition({ cond: 'path_stuck' }, at(39)), false);
    assert.equal(evalCondition({ cond: 'path_stuck' }, at(40)), true);
    assert.equal(evalCondition({ cond: 'path_stuck', count: 100 }, at(40)), false);
    // An agent that has never pathed at all must not look stuck.
    assert.equal(evalCondition({ cond: 'path_stuck' }, {}), false);
});

test('moving is what clears it', () => {
    assert.ok(ACTIONS.move_away.clears.includes('path_stuck'),
        'a rule that answers path_stuck by moving must be able to stop itself');
});

test('the profile answers path_stuck by going somewhere else', () => {
    const policy = JSON.parse(fs.readFileSync('policies/stayin_alive.json', 'utf8')).policy;
    assert.equal(validatePolicy(policy), null);
    const r = policy.rules.find(x => x.name === 'give_up_on_a_stuck_path');
    assert.ok(r, 'give_up_on_a_stuck_path missing');
    assert.equal(r.interrupts, 'all', 'a bot wedged against terrain is not going to go idle and ask');
    assert.deepEqual(r.do.map(s => s.act), ['move_away']);
});

test('a rule that only talks about its problem is rejected', () => {
    // mine_only_with_proper_tool, written by the agent, said "Waiting for a
    // proper pickaxe before mining stone" 103 times in four game-days.
    const err = validatePolicy({ rules: [{
        name: 'mine_only_with_proper_tool',
        when: { all: [{ cond: 'block_nearby', name: 'stone', range: 8 },
                      { not: { cond: 'holding', item: 'pickaxe' } }] },
        do: [{ act: 'say', message: 'Waiting for a proper pickaxe before mining stone.' }],
    }] });
    assert.match(err ?? '', /only says something/);
});
