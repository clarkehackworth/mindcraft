import { strict as assert } from 'node:assert';
import test from 'node:test';
import { notePathFailure, PATH_SPIN_LIMIT, PATH_SPIN_RADIUS } from './path_spin.js';

const fail = (state, [x, y, z], times = 1) => {
    let aborts = 0;
    for (let i = 0; i < times; i++) if (notePathFailure(state, x, y, z)) aborts++;
    return aborts;
};

test('a hundred failures in one place aborts the goal, and keeps aborting', () => {
    // It used to fire once per streak, on strict equality with the limit. But
    // aborting the goal does not stop the goal loop from re-targeting the same
    // unreachable thing a tick later, and past 100 the count never equals 100
    // again -- so a streak got exactly one rescue and then spun forever.
    // Watched live: 4,558 partial paths in six minutes inside one box, the bot
    // oscillating between two blocks, looking like it was standing still.
    const state = {};
    assert.equal(fail(state, [1, 2, 3], PATH_SPIN_LIMIT - 1), 0, 'must not fire early');
    assert.equal(fail(state, [1, 2, 3]), 1, 'fires on the limit');
    assert.equal(fail(state, [1, 2, 3], PATH_SPIN_LIMIT - 1), 0, 'not every tick after');
    assert.equal(fail(state, [1, 2, 3]), 1, 'but again on the next hundred');
    assert.equal(fail(state, [1, 2, 3], PATH_SPIN_LIMIT * 5), 5, 'and every hundred after that');
});

test('jittering between neighbouring blocks still counts', () => {
    // Soak 5 day 4: 5,942 failures inside one 16-cube, zero aborts, because the
    // bot never failed twice from the same block. It was as stuck as a bot that
    // never moved at all.
    const state = {};
    let aborts = 0;
    for (let i = 0; i < PATH_SPIN_LIMIT; i++) {
        aborts += fail(state, [1 + (i % 2), 2, 3 - (i % 3)]);
    }
    assert.equal(aborts, 1, 'a bot orbiting one spot is stuck');
});

test('travelling resets the streak', () => {
    // The distinction the whole backstop rests on: walking a long partial path
    // fails plenty of searches, but the bot leaves the box, and that bot is
    // fine. Only the bot that goes nowhere gets its goal taken away.
    const state = {};
    fail(state, [0, 0, 0], PATH_SPIN_LIMIT - 1);
    fail(state, [0, 0, PATH_SPIN_RADIUS + 1]);
    assert.equal(state.path_stuck_count, 1, 'left the box, start over');
    assert.equal(fail(state, [0, 0, PATH_SPIN_RADIUS + 1], PATH_SPIN_LIMIT - 2), 0,
        'the old streak does not carry over');
});

test('the box does not follow the bot', () => {
    // Anchored at the start, not re-centred on each failure -- otherwise a bot
    // walking two blocks per search drags its own box across the world and
    // never resets.
    const state = {};
    let aborts = 0;
    for (let i = 0; i < PATH_SPIN_LIMIT * 2; i++) aborts += fail(state, [i * PATH_SPIN_RADIUS, 0, 0]);
    // Walking exactly the radius lands each failure on the edge of the last
    // box, so the count flickers 1,2,1,2 and never builds. Anything faster
    // resets outright.
    assert.equal(aborts, 0, 'a bot making progress is never aborted');
    assert.ok(state.path_stuck_count <= 2, `count crept to ${state.path_stuck_count}`);
});

test('the rule threshold still comes first', () => {
    // give_up_on_a_stuck_path triggers on path_stuck 40 and walks the bot
    // somewhere else. This only exists for when nothing is left to run it, so
    // it must not pre-empt the rule.
    assert.ok(PATH_SPIN_LIMIT > 40);
});
