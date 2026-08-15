// Run: node src/agent/transient_auth_exit.test.js
// "Failed to obtain profile data for Andy, does the account own minecraft?" is
// Mojang's auth API blipping, not a real ownership problem -- the next attempt
// logs in fine. It caused 45 of 194 agent crashes in one log. Unrecognised, it
// fell to the else branch that only logs, so the bot never spawned and the
// process sat idle for the full spawn_timeout before exiting anyway. It belongs
// with the other disconnects, which exit immediately and let agent_process
// retry on its existing exponential backoff.
import assert from 'assert';
import { readFileSync } from 'fs';

const src = readFileSync(new URL('./agent.js', import.meta.url), 'utf8');

// The classifier used to be a one-line predicate inside Agent.start, lifted out
// of the source with a regex. It is a named export now (it grew a second case:
// see transient_connect.test.js), so import it and drop the regex.
const { isTransientConnectError } = await import('./agent.js');

const mojang_blip = 'Error: Failed to obtain profile data for Andy, does the account own minecraft?';
assert.ok(isTransientConnectError(mojang_blip), 'the observed Mojang failure is recognised');
assert.ok(isTransientConnectError(new Error('Failed to obtain profile data for Andy')), 'as an Error object too');

// Things that are NOT this, and must keep their existing handling.
for (const other of [
    'Error: write EPIPE',
    'Error: Connection timed out or was lost.',
    'TypeError: stateGoal.isValid is not a function',
    'Error: read ECONNRESET',
]) {
    assert.ok(!isTransientConnectError(other), `${other} must not be misread as an auth blip`);
}

// And it has to actually be wired into the branch that disconnects, not just
// defined -- that was the whole bug.
assert.match(
    src,
    /if \(isTransientConnectError\(err\)\) \{[\s\S]{0,600}?onDisconnect\('Error', err, TEMPFAIL_EXIT\)/,
    'the predicate gates the onDisconnect branch, not the log-only branch');

// And it exits EX_TEMPFAIL, which agent_process retries promptly without
// counting toward the crash backoff. Counted, 45 auth blips would have stretched
// the retry to the 5-minute ceiling over an outage that lasts seconds.
assert.match(src, /const TEMPFAIL_EXIT = 75;/, 'agent.js defines EX_TEMPFAIL');
const parent = readFileSync(new URL('../process/agent_process.js', import.meta.url), 'utf8');
assert.match(parent, /if \(code === 75\)/, 'agent_process recognises EX_TEMPFAIL');
assert.ok(parent.indexOf('code === 75') < parent.indexOf('if (code > 1)'),
    'EX_TEMPFAIL is checked before the task-exit codes, or it ends the whole run');

console.log('ok: a Mojang auth blip exits for a fast retry that does not count as a crash');
process.exit(0);
