// Clearing a goal does not clear the reason for it. Andy's memory named a base
// 390 blocks west, the self layer's shelter rule kept asking to go there from
// camp, and the pathfinder could not route it -- so the spin restarted the tick
// after every abort: 392 partial searches in eight minutes, all at one block,
// all for the same place. The backstop caps what each attempt costs; only
// remembering the target stops the attempts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteUnreachable, isUnreachable, UNREACHABLE_TTL_MS, UNREACHABLE_RADIUS } from './path_spin.js';

test('a target that spun the pathfinder is refused straight after', () => {
    const bot = {};
    const t = 1000;
    noteUnreachable(bot, -393, 78, 315, t);
    assert.ok(isUnreachable(bot, -393, 78, 315, t + 1));
});

test('near misses count, distant goals do not', () => {
    const bot = {};
    const t = 1000;
    noteUnreachable(bot, 0, 0, 0, t);
    assert.ok(isUnreachable(bot, UNREACHABLE_RADIUS, 0, 0, t + 1), 'inside the box');
    assert.ok(!isUnreachable(bot, UNREACHABLE_RADIUS + 1, 0, 0, t + 1), 'outside it');
});

test('it is a cooldown on a bad idea, not a permanent verdict', () => {
    // Terrain changes and the bot moves: a target that was unroutable from a
    // hole is fine from open ground.
    const bot = {};
    const t = 1000;
    noteUnreachable(bot, 5, 5, 5, t);
    assert.ok(isUnreachable(bot, 5, 5, 5, t + UNREACHABLE_TTL_MS - 1));
    assert.ok(!isUnreachable(bot, 5, 5, 5, t + UNREACHABLE_TTL_MS + 1));
});

test('a goal with no fixed target is not recorded', () => {
    // GoalFollow tracks an entity and has no x/y/z. Recording undefined would
    // blacklist every future goal whose coordinates happened to be NaN-adjacent.
    const bot = {};
    noteUnreachable(bot, undefined, undefined, undefined, 1000);
    assert.equal(bot._unreachable_goals, undefined);
    assert.ok(!isUnreachable(bot, 0, 0, 0, 1001));
});
