import { strict as assert } from 'node:assert';
import test from 'node:test';
import { notePathFailure, PATH_SPIN_LIMIT } from './path_spin.js';

const fail = (state, at, times = 1) => {
    let aborts = 0;
    for (let i = 0; i < times; i++) if (notePathFailure(state, at)) aborts++;
    return aborts;
};

test('a hundred failures in one block aborts the goal, once', () => {
    const state = {};
    assert.equal(fail(state, '1,2,3', PATH_SPIN_LIMIT - 1), 0, 'must not fire early');
    assert.equal(fail(state, '1,2,3'), 1, 'fires on the limit');
    assert.equal(fail(state, '1,2,3', 500), 0, 'and not again while the streak runs');
});

test('moving one block resets the streak', () => {
    // The distinction the whole backstop rests on: walking a long partial path
    // fails plenty of searches, but each one is from a different block, and
    // that bot is fine. Only the bot that never moves gets its goal taken away.
    const state = {};
    fail(state, '1,2,3', PATH_SPIN_LIMIT - 1);
    fail(state, '1,2,4');
    assert.equal(state.path_stuck_count, 1);
    assert.equal(fail(state, '1,2,4', PATH_SPIN_LIMIT - 2), 0, 'the old streak does not carry over');
});

test('the rule threshold still comes first', () => {
    // give_up_on_a_stuck_path triggers on path_stuck 40 and walks the bot
    // somewhere else. This only exists for when nothing is left to run it, so
    // it must not pre-empt the rule.
    assert.ok(PATH_SPIN_LIMIT > 40);
});
