// Run: node --test src/process/crash_window.test.js
// The supervisor's backoff keyed off "did it exit within 10 seconds", and every
// slower exit reset the counter to zero. A 4-minute crash cycle therefore never
// reached the backoff branch at all: 222 deaths in one session, every restart at
// full speed. What throttling should watch is how OFTEN it is dying.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { restartDelay, recentExits } from './agent_process.js';

const MIN = 60 * 1000;
const at = (...mins) => mins.map(m => m * MIN);

test('the 4-minute crash cycle the old check missed now throttles', () => {
    // Six deaths, four minutes apart. Every one of them "slow", so the old
    // too-quick-exit test never fired once.
    const exits = at(0, 4, 8, 12, 16, 20);
    assert.ok(restartDelay(exits) > 0, 'a slow crash loop is still a crash loop');
});

test('a handful of restarts stay free, then the backoff doubles to a ceiling', () => {
    assert.equal(restartDelay(at(0)), 0);
    assert.equal(restartDelay(at(0, 1, 2)), 0, 'three restarts are free');
    assert.equal(restartDelay(at(0, 1, 2, 3)), 5000, 'the fourth waits');
    assert.equal(restartDelay(at(0, 1, 2, 3, 4)), 10000);
    assert.equal(restartDelay(Array.from({ length: 40 }, (_, i) => i * MIN)), 5 * 60 * 1000, 'capped at 5m');
});

test('an agent that recovers is not held against it forever', () => {
    const now = 10 * 60 * MIN;
    // Four deaths, but they were hours ago and it has been up since.
    const old = [now - 90 * MIN, now - 80 * MIN, now - 70 * MIN, now - 60 * MIN];
    assert.deepEqual(recentExits(old, now), [], 'the window has moved past them');
    assert.equal(restartDelay(recentExits(old, now)), 0, 'restart immediately');
});
