// Self-check for the behavior policy layer. Run: node tools/policy_check.js
import assert from 'assert';
import { validatePolicy, evalCondition, Rule, describePolicy } from '../src/agent/behavior/policy.js';

const fakeAgent = {
    bot: { health: 5, food: 20, interrupt_code: false, time: { timeOfDay: 14000 }, entity: { position: { distanceTo: () => 2 } } },
    isIdle: () => true,
    messages: [],
    handleMessage(source, msg) { this.messages.push(msg); },
};

// validation
assert.equal(validatePolicy({ rules: [] }), null);
assert.ok(validatePolicy(null));
assert.ok(validatePolicy({ rules: [{ name: 'x' }] }));                       // missing when/do
assert.ok(validatePolicy({ rules: [{ name: 'x', when: { cond: 'nope' }, do: [{ act: 'flee' }] }] })); // bad cond
assert.ok(validatePolicy({ rules: [{ name: 'x', when: { cond: 'always' }, do: [{ act: 'nope' }] }] })); // bad act
const good = {
    modes: { self_defense: false },
    rules: [
        // cooldown 5 is the floor for interrupts:all -- below it a rule cancels
        // everything faster than anything can finish.
        { name: 'panic_eat', when: { all: [{ cond: 'health_below', value: 8 }, { not: { cond: 'is_night' } }] }, do: [{ act: 'consume', item: 'bread' }], interrupts: 'all', cooldown: 5 },
        // triggered by a real condition, not 'always': a prompt_self rule gated on
        // "nothing is happening" fires forever, since doing nothing is the resting state.
        { name: 'ask', when: { cond: 'health_below', value: 8 }, do: [{ act: 'prompt_self', message: 'do something' }], cooldown: 0 },
    ]
};
assert.equal(validatePolicy(good), null);
assert.ok(validatePolicy({ rules: [good.rules[0], good.rules[0]] })); // duplicate names

// condition combinators
assert.equal(evalCondition({ cond: 'health_below', value: 8 }, fakeAgent), true);
assert.equal(evalCondition({ not: { cond: 'health_below', value: 8 } }, fakeAgent), false);
assert.equal(evalCondition({ all: [{ cond: 'always' }, { cond: 'is_night' }] }, fakeAgent), true);
assert.equal(evalCondition({ any: [{ cond: 'hunger_below', value: 5 }, { cond: 'always' }] }, fakeAgent), true);
assert.equal(evalCondition(good.rules[0].when, fakeAgent), false); // is_night true -> not(...) false

// rule runtime: cooldown + prompt_self dispatch, no action steps -> execute not called
const rule = new Rule(good.rules[1]);
let executed = 0;
await rule.update(fakeAgent, async () => { executed++; });
assert.equal(executed, 0);
assert.equal(fakeAgent.messages.length, 1);
assert.ok(fakeAgent.messages[0].includes('do something'));

// rule runtime: action steps go through execute wrapper; cooldown blocks refire
const rule2 = new Rule({ name: 'flee_test', when: { cond: 'always' }, do: [{ act: 'say', message: 'hi' }], cooldown: 60 });
let ran = [];
const fakeExecute = async (mode, agent, fn) => { ran.push(mode.name); await fn(); };
fakeAgent.openChat = (m) => ran.push('chat:' + m);
await rule2.update(fakeAgent, fakeExecute);
await rule2.update(fakeAgent, fakeExecute); // within cooldown, must not refire
assert.deepEqual(ran, ['policy:flee_test', 'chat:hi']);

// describe
assert.ok(describePolicy(good).includes('self_defense=off'));
assert.ok(describePolicy(good).includes('panic_eat'));

console.log('policy_check: all assertions passed');
