// Run: node src/agent/behavior/stay_no_watchdog.test.js
// sleep_at_night is [go_to_bed, stay until dawn], and every mode/rule action ran
// under a 2-minute watchdog. The log has 431 "Code execution timed out after 2
// minutes" followed by "Stayed for 120.112 seconds": the stay never once reached
// morning. With a 60s cooldown the rule just re-fired, so the bot bounced awake
// in the open all night and 605 of its 892 deaths were zombies.
import assert from 'assert';
import { Rule, ACTIONS } from './policy.js';

function fakeAgent() {
    return {
        bot: { interrupt_code: false, output: '', emit: () => {} },
        handleMessage: () => {},
    };
}

// Stand in for modes.js execute(mode, agent, func, timeout=2) and record the
// timeout the rule asked for.
let seen;
const execute = async (_mode, _agent, func, timeout) => { seen = timeout; await func(); };

const real_stay = ACTIONS.stay.fn, real_flee = ACTIONS.flee.fn;
ACTIONS.stay.fn = async () => {};
ACTIONS.flee.fn = async () => {};

const sleep = new Rule({
    name: 'sleep_at_night',
    when: { cond: 'always' },
    do: [{ act: 'stay', until: 'not is_night 1500' }],
    cooldown: 0,
});
await sleep.update(fakeAgent(), execute);
// This asked for 0 -- no watchdog at all -- and that went too far the other way:
// flee_ranged_raiders then spun for 85 minutes at the bottom of a shaft, because
// avoidEnemies looped as long as any hostile was in range and only a LoginGuard
// kick broke it. f28f404 put a 20-minute leash on the exemption. Night is about
// 11 real minutes, so 20 covers every legitimate stay-until-dawn with room to
// spare, and the watchdog's interrupt_code is honoured inside the skill loops so
// it cancels cleanly and the rule re-fires after its cooldown.
//
// That 85-minute spin has since been fixed at the source -- avoidEnemies carries
// its own deadline now -- but the leash stays. It is the backstop for every
// blocking step a stay-rule might contain, not just that one.
assert.equal(seen, 20, 'a stay gets a long leash, not no leash');

// Everything else still gets the watchdog: a stuck pathfinder has no exit.
seen = 'unset';
const flee = new Rule({ name: 'flee_when_hurt', when: { cond: 'always' }, do: [{ act: 'flee' }], cooldown: 0 });
await flee.update(fakeAgent(), execute);
assert.equal(seen, undefined, 'a rule with no stay keeps the default 2-minute watchdog');

ACTIONS.stay.fn = real_stay;
ACTIONS.flee.fn = real_flee;
console.log('ok: a stay-until rule runs unwatched; everything else keeps the watchdog');
process.exit(0);
