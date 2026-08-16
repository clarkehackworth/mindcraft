// Run: node src/agent/liveness_watchdog.test.js
// The server dropped Andy with "lost connection: Timed out" at 06:45 and he was
// still gone five hours later: process alive, four node processes running, zero
// reconnect attempts, one rule firing every two hours into a dead socket. The
// only symptom was missing logs, which looks exactly like a quiet bot.
//
// The watchdog called clearInterval on itself before calling the thing it
// guards. _handleDisconnect early-returns once _disconnectHandled is set, and
// only _connect() clears that flag -- so a reconnect stalling anywhere before
// it left no watchdog armed and no way back.
//
// This models the loop body rather than importing Agent, which needs a whole
// mineflayer bot to construct. The invariants are the two that were missing:
// the timer keeps asking, and something eventually gives up for good.
import assert from 'assert';

const TEMPFAIL_EXIT = 75;

// The body of the interval, lifted verbatim in shape from agent.js.
function makeWatchdog({ now, last_time_update, onDisconnect, onExit, log = () => {} }) {
    return () => {
        const silent_ms = now() - last_time_update();
        if (silent_ms <= 180000) return;
        onDisconnect('No server time updates for 3 minutes');
        if (silent_ms > 600000) {
            log(`No server time updates for ${Math.round(silent_ms / 60000)} minutes`);
            onExit(TEMPFAIL_EXIT);
        }
    };
}

// A connection that goes silent and never comes back gets asked again and
// again, instead of once.
{
    let clock = 0;
    let disconnects = 0, exits = [];
    const tick = makeWatchdog({
        now: () => clock,
        last_time_update: () => 0,
        onDisconnect: () => { disconnects++; },
        onExit: (code) => exits.push(code),
    });

    clock = 60000;  tick();   // 1m silent: too early
    clock = 120000; tick();   // 2m: still too early
    assert.equal(disconnects, 0, 'three minutes is the threshold, not one');

    clock = 240000; tick();   // 4m
    clock = 300000; tick();   // 5m
    clock = 360000; tick();   // 6m
    assert.equal(disconnects, 3,
        'it keeps asking -- the old one disarmed itself after the first ask');
    assert.deepEqual(exits, [], 'and does not give up while a reconnect could still land');
}

// Past the point any reconnect should have finished, hand the process back
// rather than guess which step wedged. Five hours of zombie is the alternative.
{
    let clock = 660000;   // 11 minutes of silence
    const exits = [];
    const logs = [];
    const tick = makeWatchdog({
        now: () => clock,
        last_time_update: () => 0,
        onDisconnect: () => {},
        onExit: (code) => exits.push(code),
        log: (m) => logs.push(m),
    });
    tick();
    assert.deepEqual(exits, [TEMPFAIL_EXIT],
        'a dead link is EX_TEMPFAIL, not a crash: it must not spend the crash budget');
    assert.match(logs[0], /11 minutes/, 'and it says how long it waited');
}

// A healthy connection is never touched.
{
    let clock = 10 * 60000;
    let disconnects = 0;
    const tick = makeWatchdog({
        now: () => clock,
        last_time_update: () => clock - 1000,   // a packet a second ago
        onDisconnect: () => { disconnects++; },
        onExit: () => { throw new Error('exited on a live connection'); },
    });
    tick();
    assert.equal(disconnects, 0);
}

console.log('ok: the liveness watchdog stays armed and eventually gives up');
