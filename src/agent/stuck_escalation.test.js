// Run: node src/agent/stuck_escalation.test.js
// The first version of this fired once and then never again: it tested
// `++count === STUCK_SAME_SPOT` and kept counting past it, so 109 stuck resets
// on one grave block produced exactly one escape attempt and the bot went back
// to grinding for the rest of the window.
import assert from 'assert';

const STUCK_SAME_SPOT = 8;

// The counter, lifted in shape from agent.js.
function makeCounter(onEscalate) {
    let stuck_at = null, count = 0;
    return (at) => {
        if (at === stuck_at) count++;
        else { stuck_at = at; count = 1; }
        if (count >= STUCK_SAME_SPOT) { count = 0; onEscalate(at); }
    };
}

// Grinding on one block escalates repeatedly, not once.
{
    const fired = [];
    const tick = makeCounter(at => fired.push(at));
    for (let i = 0; i < 24; i++) tick('-26,67,8');
    assert.equal(fired.length, 3, '24 stucks on one block is three escapes, not one');
    assert.deepEqual([...new Set(fired)], ['-26,67,8']);
}

// Moving on resets it: ordinary terrain cleared on the second attempt must
// never trip this.
{
    const fired = [];
    const tick = makeCounter(at => fired.push(at));
    for (let i = 0; i < 7; i++) tick('a');
    tick('b');
    for (let i = 0; i < 7; i++) tick('a');
    assert.deepEqual(fired, [], 'seven, elsewhere, seven again is not a wedge');
}

// And the boundary is the threshold itself.
{
    const fired = [];
    const tick = makeCounter(at => fired.push(at));
    for (let i = 0; i < STUCK_SAME_SPOT - 1; i++) tick('x');
    assert.deepEqual(fired, [], 'one short does nothing');
    tick('x');
    assert.equal(fired.length, 1, 'the eighth acts');
}

console.log('ok: a wedge escalates every N, not once ever');
