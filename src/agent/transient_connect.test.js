// Run: node --test src/agent/transient_connect.test.js
// Soak 14: restarting the Minecraft server made every connect attempt fail with
// ECONNREFUSED. The agent exited code 1 for each, so the supervisor filed eight
// server-is-down retries as agent crashes:
//     [respawn] agent Andy respawn #8 (3 in the last 30m, up 7s)
//     ... #14 (9 in the last 30m, up 8s)
// The window does not decay, so a deliberate restart later landed on a poisoned
// counter, printed "Andy is crash-looping", and sat out a 300s backoff for a bot
// that had done nothing wrong. The diagnosis was also just wrong: nothing was
// crashing, there was no server to connect to.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { isTransientConnectError } from './agent.js';
import { restartDelay } from '../process/agent_process.js';

test('a server that is down is upstream weather, not an agent crash', () => {
    assert.ok(isTransientConnectError(new Error('connect ECONNREFUSED 192.168.3.87:25565')));
});

test('real faults are still crashes', () => {
    // The keepalive timeout is the agent's own event loop being blocked -- that
    // IS the agent's fault (a cyclic craft did it for 40 minutes), so it must
    // keep counting toward the crash backoff.
    assert.ok(!isTransientConnectError(new Error('client timed out after 60000 milliseconds')));
    assert.ok(!isTransientConnectError(new Error('Duplicate login')));
    assert.ok(!isTransientConnectError(new Error('Cannot read properties of undefined')));
});

test('the live sequence no longer escalates', () => {
    // The eight ECONNREFUSED Andy actually logged, inside four minutes.
    const refusals = Array.from({ length: 8 }, (_, i) => i * 30 * 1000);
    assert.equal(restartDelay(refusals, true), 0,
        'on the transient budget, eight server-down retries are free');
    assert.ok(restartDelay(refusals, false) >= 20000,
        'on the crash budget they were what poisoned the counter');
});
