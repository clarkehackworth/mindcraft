// Run: node src/agent/behavior/rule_step_failure.test.js
// Jeff's shelter_at_night rule is [goto base, stay until dawn]. goToGoal threw
// "No path to the goal" on every attempt, the throw escaped the step loop, and
// the stay -- the step that actually keeps the bot alive -- never ran. Andy
// stood in the open all night, every night, and because no step reported
// progress the rule's backoff doubled until it barely fired at all.
import assert from 'assert';
import { Rule, ACTIONS } from './policy.js';

function fakeAgent() {
    return {
        bot: { interrupt_code: false, output: '', emit: () => {} },
        handleMessage: () => {},
    };
}

// execute() in modes.js just runs the callback; the ActionManager swallows the
// throw, which is why this failed silently in production.
const execute = async (_mode, _agent, func) => { try { await func(); } catch {} };

const rule = new Rule({
    name: 'shelter_at_night',
    when: { cond: 'always' },
    do: [
        { act: 'goto', x: -20, y: 72, z: -10, closeness: 3 },
        { act: 'stay', until: 'not is_night' },
    ],
    cooldown: 0,
});

// Make the goto step throw the way an unreachable goal does, and record whether
// the stay step is reached at all.
let stayed = false;
const real_goto = ACTIONS.goto.fn;
const real_stay = ACTIONS.stay.fn;
ACTIONS.goto.fn = async () => { throw new Error('No path to the goal'); };
ACTIONS.stay.fn = async () => { stayed = true; };

const agent = fakeAgent();
await rule.update(agent, execute);

ACTIONS.goto.fn = real_goto;
ACTIONS.stay.fn = real_stay;

assert.equal(stayed, true, 'a step that throws must not cancel the steps after it');
assert.match(agent.bot.output, /goto failed/, 'and the failure is reported, not swallowed');

console.log('ok: one failing rule step does not cancel the rest of the rule');
process.exit(0);
