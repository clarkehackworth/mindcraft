import { strict as assert } from 'node:assert';
import test from 'node:test';
import { Agent } from './agent.js';

// "Alive for" is connected time since the last death, not wall clock since it:
// a bot that died, was offline eight hours and just reconnected has been alive
// for seconds, not eight hours.
test('aliveMs counts only connected time since the last death', () => {
    const a = Object.create(Agent.prototype);
    assert.equal(a.aliveMs(), null, 'no death on record');

    const HOUR = 3600_000;
    a.last_death_time = Date.now() - 8 * HOUR;
    a.alive_ms_before = 60_000;          // a minute banked before the restart
    a.alive_mark = Date.now() - 30_000;  // 30s into this session
    const alive = a.aliveMs();
    assert.ok(alive >= 90_000 && alive < 91_000, `expected ~90s, got ${alive}`);
});
