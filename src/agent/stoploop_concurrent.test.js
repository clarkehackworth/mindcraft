// Run: node src/agent/stoploop_concurrent.test.js
// stopLoop opened with `if (this.interrupt) return`, so a second caller arriving
// while a stop was already in flight was told the loop had stopped when it was
// still running. An emergency that believes that goes on to have its action
// dropped -- the action manager still belongs to the loop.
//
// Andy drowned twice on it: 17:56, six seconds after "self-prompt loop did not
// stop in time", and 02:13, nine seconds after the same line. Neither death had
// a single surface attempt, in windows where the drowning reflex fired fourteen
// times and surfaced fourteen times for every other caller.
import assert from 'assert';

const STOP_WAIT_MS = 300;

// The two branches of stopLoop, in the shape agent code sees them.
function makePrompter() {
    const p = {
        interrupt: false,
        loop_active: true,
        async stopLoop() {
            if (p.interrupt) {
                const shared = Date.now() + STOP_WAIT_MS;
                while (p.loop_active && Date.now() < shared)
                    await new Promise(r => setTimeout(r, 10));
                return;
            }
            p.interrupt = true;
            const deadline = Date.now() + STOP_WAIT_MS;
            while (p.loop_active) {
                if (Date.now() > deadline) break;
                await new Promise(r => setTimeout(r, 10));
            }
            p.interrupt = false;
        },
    };
    return p;
}

// The second caller does not get a false all-clear while the loop runs on.
{
    const p = makePrompter();
    const first = p.stopLoop();
    await new Promise(r => setTimeout(r, 20));   // a stop is now in flight
    const t0 = Date.now();
    await p.stopLoop();                          // the emergency arrives
    const waited = Date.now() - t0;
    assert.ok(waited >= 50,
        `the second caller must wait for the stop in flight, waited ${waited}ms`);
    await first;
}

// When the loop does stop, the waiter returns promptly rather than sitting out
// the whole deadline.
{
    const p = makePrompter();
    const first = p.stopLoop();
    await new Promise(r => setTimeout(r, 20));
    setTimeout(() => { p.loop_active = false; }, 40);
    const t0 = Date.now();
    await p.stopLoop();
    const waited = Date.now() - t0;
    assert.ok(waited < STOP_WAIT_MS,
        `should return once the loop actually stops, waited ${waited}ms`);
    await first;
}

// And a first caller on an idle loop is not slowed down at all.
{
    const p = makePrompter();
    p.loop_active = false;
    const t0 = Date.now();
    await p.stopLoop();
    assert.ok(Date.now() - t0 < 50, 'nothing to wait for');
}

console.log('ok: a stop already in flight is waited for, not assumed');
