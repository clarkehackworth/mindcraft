// Run: node src/agent/behavior/rule_unresolved.test.js
// flee_ranged_raiders fired 55 times in half an hour while Andy sat at y=24 and
// finished zero goals. Nothing caught it, because nothing was asking the right
// question: flee genuinely works -- the bot really does move 40 blocks -- so
// every step reported success and both the failure counter and the backoff saw
// a healthy rule.
//
// Meanwhile it is interrupts:all on a 6s cooldown and climb_out_of_the_deep is
// interrupts:all on 60s with a blocking action needing ~20s, so the climb was
// preempted before it could ever finish: 19 fires, 0 climbs. Ten times the
// firing rate wins, permanently, and the bot stayed 44 blocks underground.
//
// A rule that runs and leaves its own trigger true has resolved nothing,
// whatever its steps returned.
import assert from 'assert';
import { Rule, ACTIONS } from './policy.js';

const execute = async (_mode, _agent, func) => { try { await func(); } catch {} };
const fakeAgent = () => ({ bot: { interrupt_code: false, output: '', emit: () => {} }, handleMessage: () => {} });

function captureLog(fn) {
    const lines = [];
    const real = console.log;
    console.log = (...args) => { lines.push(args.join(' ')); };
    return fn().finally(() => { console.log = real; }).then(() => lines);
}

const real_move = ACTIONS.move_away.fn;

// A rule whose action succeeds but whose trigger never clears gets named, and
// slowed down so something else can run.
{
    ACTIONS.move_away.fn = async () => true;   // fleeing "works" every time
    const rule = new Rule({
        name: 'flee_ranged_raiders',
        when: { cond: 'is_night' },            // ...and the raider never leaves
        do: [{ act: 'move_away', distance: 40 }],
        cooldown: 0,
    });
    const agent = fakeAgent();
    agent.bot.time = { timeOfDay: 18000 };     // night, and it stays night
    const lines = await captureLog(async () => {
        for (let i = 0; i < 5; i++) await rule.update(agent, execute);
    });

    assert.deepEqual(lines.filter(l => l.includes('rule:unresolved')),
        ['EVT rule:unresolved:flee_ranged_raiders:5'],
        'five fires that changed nothing is one line, naming the rule');
    assert.equal(rule.failures, 0,
        'the action worked, so the FAILURE counter must stay quiet -- these are different questions');
    assert.ok(rule.backoff > 1,
        'and it backs off, so the rule it was starving gets a turn');
}

// A rule whose action actually resolves the trigger is left alone. The action
// clears it inside the same fire, which is what "the flee worked" looks like.
{
    let night = true;
    ACTIONS.move_away.fn = async () => { night = false; return true; };
    const rule = new Rule({
        name: 'flee_that_works',
        when: { cond: 'is_night' },
        do: [{ act: 'move_away', distance: 40 }],
        cooldown: 0,
    });
    const agent = fakeAgent();
    agent.bot.time = { get timeOfDay() { return night ? 18000 : 1000; } };

    await captureLog(async () => { await rule.update(agent, execute); });
    assert.equal(rule.unresolved, 0, 'the trigger cleared, so nothing accumulates');
    assert.equal(rule.backoff, 1, 'and the rule is not slowed down');

    // And a later non-resolving fire starts from zero rather than from a stale
    // count left over from some unrelated episode.
    night = true;
    ACTIONS.move_away.fn = async () => true;
    const lines = await captureLog(async () => {
        for (let i = 0; i < 4; i++) await rule.update(agent, execute);
    });
    assert.equal(lines.filter(l => l.includes('rule:unresolved')).length, 0,
        'four after a success is not yet a pattern');
    assert.equal(rule.unresolved, 4);
}

ACTIONS.move_away.fn = real_move;
console.log('ok: a rule that resolves nothing says so, and yields');

// "always" names no situation, so the question does not apply to it. A standing
// behaviour -- keep torches stocked, keep the chest tidy -- can never make
// `always` false and must not be throttled for it. rule_stuck's own fixture
// caught this the moment the counter went in.
{
    const real = ACTIONS.move_away.fn;
    ACTIONS.move_away.fn = async () => true;
    const rule = new Rule({
        name: 'a_standing_behaviour',
        when: { cond: 'always' },
        do: [{ act: 'move_away', distance: 4 }],
        cooldown: 0,
    });
    const agent = fakeAgent();
    const lines = await captureLog(async () => {
        for (let i = 0; i < 8; i++) await rule.update(agent, execute);
    });
    assert.equal(lines.filter(l => l.includes('rule:unresolved')).length, 0);
    assert.equal(rule.backoff, 1, 'an always-rule is never throttled for not resolving "always"');
    ACTIONS.move_away.fn = real;
}

console.log('ok: "always" is exempt, because it names no situation');
