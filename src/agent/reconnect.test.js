// Run: node --test src/agent/reconnect.test.js
// A dropped socket used to cost a whole process. Measured live: ten drops in
// forty minutes, uptimes 94s to 1426s, every one a clean
// EPIPE/ECONNRESET/disconnect.timeout that the next login recovered from --
// each paying for examples to be re-embedded and 17k blocks of mod data to be
// re-parsed, and each pushing the supervisor's crash backoff higher against a
// server that was accepting every connection first try.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { restartDelay } from '../process/agent_process.js';

const MIN = 60 * 1000;
const stamps = n => Array.from({ length: n }, (_, i) => i * MIN);

test('a flaky link no longer escalates like a crash loop', () => {
    // The live sequence: ten drops inside the window.
    assert.equal(restartDelay(stamps(10), true), 10000, 'transient stays in seconds');
    assert.ok(restartDelay(stamps(10), false) >= 80000, 'a real crash loop still escalates hard');
});

test('transient restarts get a longer free run and a much lower ceiling', () => {
    assert.equal(restartDelay(stamps(8), true), 0, 'eight blips are free');
    assert.equal(restartDelay(stamps(9), true), 5000);
    assert.equal(restartDelay(stamps(40), true), 60000, 'capped at a minute, not five');
    assert.equal(restartDelay(stamps(40), false), 5 * 60 * 1000);
});

test('a link flapping without end is still throttled, just gently', () => {
    assert.ok(restartDelay(stamps(20), true) > 0, 'not a free-for-all');
    assert.ok(restartDelay(stamps(20), true) <= 60000);
});

// The reconnect itself needs a live mineflayer bot to exercise end to end, so
// what is checked here is the wiring that makes it safe to run twice -- every
// one of these guards is a bug that only shows up on the second connection.
const src = readFileSync(new URL('./agent.js', import.meta.url), 'utf8');
// Both anchors occur more than once in the file; take the end marker that
// follows the start, not the first one in the file.
const between = (start, end) => {
    const i = src.indexOf(start);
    assert.notEqual(i, -1, `missing ${start}`);
    return src.slice(i, src.indexOf(end, i));
};

test('the once-per-process work is guarded against a second connection', () => {
    // The browser viewer binds a port; twice is EADDRINUSE.
    assert.match(src, /if \(!this\._connected_once\)\s*\n\s*addBrowserViewer/);
    // A second update loop would tick every mode and rule twice, forever.
    assert.match(src, /if \(this\._loop_started\) return;/);
    // A second greeting, and a replayed startup instruction.
    assert.match(src, /if \(this\._connected_once\) return;/);
});

test('the old bot is fully torn down before the new one', () => {
    const body = between('async _reconnect(', 'checkAllPlayersPresent');
    assert.match(body, /removeAllListeners\(\)/, 'or every handler fires twice on the next chat');
    assert.match(body, /interrupt_code = true/, 'the running action is aimed at a dead socket');
    assert.ok(body.indexOf('removeAllListeners') < body.indexOf('_connect()'), 'teardown precedes reconnect');
});

test('the connection timers are held where a reconnect can clear them', () => {
    // They used to be cleared by a handler on the bot, which removeAllListeners
    // strips -- leaking a watchdog that later kills a healthy connection.
    assert.match(src, /clearTimeout\(this\._spawn_timeout\)/);
    assert.match(src, /clearInterval\(this\._liveness\)/);
    assert.doesNotMatch(src, /const liveness = setInterval/, 'no connection-scoped copy left behind');
});

test('every way the connection can end funnels through one decision', () => {
    for (const ev of ["'end'", "'kicked'"])
        assert.match(src, new RegExp(`this\\.bot\\.on\\(${ev}, \\(reason\\) => this\\._handleDisconnect\\(reason\\)\\)`),
            `${ev} must not take its own exit`);
    // The half-open-socket watchdog too: that is the transient case exactly.
    assert.match(src, /_handleDisconnect\('No server time updates/);
});

test('the update loop survives a bad tick and skips one with no body', () => {
    const body = between('async update(delta)', 'isIdle()');
    assert.match(body, /if \(!this\._ready \|\| !this\.bot\?\.entity\) return;/, 'modes read a world that is not there');
    assert.match(body, /catch \(err\)/, 'one throw used to end the while(true) for the life of the process');
});

// The first live reconnect died here. _connect() returns as soon as the
// handlers are bound, seconds before bot.entity exists, so anything that built
// an LLM prompt in that window ran the !stats query against a bot with no body
// and threw uncaught -- the process the reconnect was meant to save.
test('readiness means spawned, not merely connecting', () => {
    assert.match(src, /this\._ready = true;/, 'set on spawn');
    const spawn_body = between("this.bot.once('spawn'", '_setupEventHandlers');
    assert.match(spawn_body, /this\._ready = true;/, 'and specifically inside the spawn handler');
    // Cleared the moment the connection goes, not when the reconnect starts.
    const disc = between('_handleDisconnect(reason, code = 1)', '_awaitReady');
    assert.match(disc, /this\._ready = false;/);
});

test('an LLM turn waits for a body instead of throwing into the void', () => {
    const body = between('async handleMessage(', 'checkTaskDone');
    assert.match(body, /await this\._awaitReady\(\)/, 'replaceStrings runs !stats while building the prompt');
    assert.match(src, /async _awaitReady\(timeout_ms/, 'and it is bounded, not a forever wait');
});
