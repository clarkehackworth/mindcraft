// Run: node src/agent/library/stay.test.js
// Andy parked at dusk with !stay(-1) and was still sitting at base the next
// afternoon, ignoring its "gather food during the day" goal. -1 now ends at dawn.
import assert from 'assert';
import * as skills from './skills.js';

function fakeBot(timeOfDay) {
    return {
        time: { timeOfDay },
        interrupt_code: false,
        output: '',
        modes: { pause: () => {} },
        emit: () => {},
    };
}

// Parked at night, day breaks -> stay ends on its own.
const night = fakeBot(14000);
const parked = skills.stay(night, -1);
setTimeout(() => { night.time.timeOfDay = 1000; }, 600);
assert.equal(await parked, true);
assert.match(night.output, /until day broke/, 'a night stay(-1) ends when the sun comes up');

// Parked in daylight -> -1 still means indefinite, nothing ends it.
const day = fakeBot(1000);
let done = false;
skills.stay(day, -1).then(() => { done = true; });
day.time.timeOfDay = 14000; // night falls
await new Promise(r => setTimeout(r, 1200));
assert.equal(done, false, 'a daytime stay(-1) is not ended by nightfall');
day.interrupt_code = true;

// A finite duration is unaffected by the clock.
const timed = fakeBot(14000);
const start = Date.now();
timed.time.timeOfDay = 1000;
assert.equal(await skills.stay(timed, 1), true);
assert.ok(Date.now() - start >= 900, 'a finite stay waits its full duration');

console.log('ok: stay(-1) ends at dawn, everything else unchanged');

// --- stayUntil: the same condition vocabulary the policy rules use ---
import { parseConditionExpr, evalCondition, describeCondition, conditionDocs } from '../behavior/policy.js';
import { parseCommandMessage } from '../commands/index.js';

const agent = { bot: { health: 6, food: 20, time: { timeOfDay: 14000 } } };

// The condition has to survive the command parser, which accepts no quotes
// inside a string arg. A JSON condition did not, so the model kept emitting a
// bare !stayUntil with no args at all.
const parsed = parseCommandMessage('!stayUntil("not is_night", -1)');
assert.equal(typeof parsed, 'object', 'the command parser accepts the condition as written');
assert.deepEqual(parsed.args, ['not is_night', -1]);

// Expression -> the same spec shape a policy rule uses.
assert.deepEqual(parseConditionExpr('not is_night').spec, { not: { cond: 'is_night' } });
assert.deepEqual(parseConditionExpr('health_below 10').spec, { cond: 'health_below', value: 10 });
assert.deepEqual(parseConditionExpr('has_item bread 5').spec, { cond: 'has_item', item: 'bread', count: 5 });
assert.deepEqual(parseConditionExpr('hostile_nearby').spec, { cond: 'hostile_nearby' }, 'args may be omitted to default');
assert.deepEqual(parseConditionExpr('hostile_nearby 8 and health_below 6').spec,
    { all: [{ cond: 'hostile_nearby', range: 8 }, { cond: 'health_below', value: 6 }] });
assert.deepEqual(parseConditionExpr('is_night or health_below 6').spec,
    { any: [{ cond: 'is_night' }, { cond: 'health_below', value: 6 }] });

assert.match(parseConditionExpr('nonsense').error, /unknown condition/);
// Mixing "and" with "or" used to be refused, which cost an LLM retry every
// time the model wrote the obvious thing. It now parses with "and" binding
// tighter than "or", as everywhere else.
assert.deepEqual(parseConditionExpr('is_night and health_below 6 or has_item bread').spec,
    { any: [
        { all: [{ cond: 'is_night' }, { cond: 'health_below', value: 6 }] },
        { cond: 'has_item', item: 'bread' },
    ] });
assert.match(parseConditionExpr('is_night 1 2 3').error, /at most/);
assert.match(parseConditionExpr('').error, /empty/);
assert.match(conditionDocs(), /is_night/, 'the command docs list the conditions');

// A condition ends the stay as soon as it flips.
const spec = parseConditionExpr('not health_below 10').spec;
const hurt = fakeBot(14000);
const healing = skills.stay(hurt, -1, () => evalCondition(spec, agent), describeCondition(spec));
setTimeout(() => { agent.bot.health = 20; }, 600);
assert.equal(await healing, true);
assert.match(hurt.output, /until not health_below/, 'the stay ends when the condition flips');

// An already-true condition means there is nothing to wait for.
const noop = fakeBot(1000);
await skills.stay(noop, -1, () => true, 'already fine');
assert.match(noop.output, /Not staying/, 'a condition true on arrival does not park the bot');

// The timeout is a real backstop -- a condition that never flips still returns.
const stuck = fakeBot(14000);
assert.equal(await skills.stay(stuck, 1, () => false, 'never'), true);
assert.match(stuck.output, /Gave up waiting/, 'the timeout ends a condition that never comes true');

console.log('ok: stayUntil parses, waits on the policy conditions, and always terminates');

// --- an indefinite park is refused while self-prompting ---
// Andy answered its own "gather food during the day" goal with !stay(-1) and sat
// at base through two full days. Nothing but the goal loop could wake it, and the
// goal loop just re-decided to stay.
import { actionsList } from '../commands/actions.js';

const stayCmd = actionsList.find(c => c.name === '!stay');
const untilCmd = actionsList.find(c => c.name === '!stayUntil');
// runAsAction discards what the action function returns, so anything the bot
// needs to read back has to go through its output, not a bare return.
const fakeAgent = (self_prompting) => ({
    bot: fakeBot(1000),
    self_prompter: { isActive: () => self_prompting },
    actions: { runAction: async (n, fn) => { await fn(); return { message: n.bot?.output }; } },
});

const selfPrompting = fakeAgent(true);
selfPrompting.actions.runAction = async (n, fn) => { await fn(); return { message: selfPrompting.bot.output }; };
assert.match(await stayCmd.perform(selfPrompting, -1) ?? '', /stayUntil/,
    'stay(-1) while self-prompting is refused, and the refusal reaches the bot');

// A finite stay is still fine while self-prompting -- it ends on its own.
selfPrompting.bot.output = '';
await stayCmd.perform(selfPrompting, 1);
assert.match(selfPrompting.bot.output, /Stayed for/, 'a finite stay is allowed while self-prompting');

// A human parking the bot indefinitely is untouched.
const humanDriven = fakeAgent(false);
humanDriven.actions.runAction = async (n, fn) => { await fn(); return { message: humanDriven.bot.output }; };
humanDriven.bot.interrupt_code = true;
assert.doesNotMatch(await humanDriven.actions.runAction('x', () => stayCmd.perform(humanDriven, -1)).then(r => r.message ?? ''), /Refusing/,
    'a human-driven stay(-1) still works');

// A bad stayUntil condition also has to reach the bot, not vanish into the wrapper.
const badCond = fakeAgent(true);
badCond.actions.runAction = async (n, fn) => { await fn(); return { message: badCond.bot.output }; };
assert.match(await untilCmd.perform(badCond, 'nonsense', 10) ?? '', /Bad condition/,
    'an unparseable condition is reported back');

console.log('ok: an unwakeable park is refused only where nothing could wake it');

// --- devlog #7: an explicit indefinite wait that can never resolve is capped ---
// Before the cap, !stay(-1, () => false) parked the bot forever (the do never
// returns), so the rule's own backoff never escalated. The bound is applied the
// moment we commit to waiting -- observable as the 'Bounded' log without waiting
// the full 1200 s -- and a night-wait (no condition) must stay unbounded.
const capped = fakeBot(1000);
const cappedStay = skills.stay(capped, -1, () => false, 'a ghost that never leaves');
setTimeout(() => { capped.interrupt_code = true; }, 600);
assert.equal(await cappedStay, true);
assert.match(capped.output, /Bounded an indefinite wait/, 'an explicit indefinite wait is capped to one day');

const nightUncapped = fakeBot(14000);
const nightUncappedStay = skills.stay(nightUncapped, -1);
setTimeout(() => { nightUncapped.time.timeOfDay = 1000; }, 600);
assert.equal(await nightUncappedStay, true);
assert.doesNotMatch(nightUncapped.output, /Bounded an indefinite wait/, 'a night wait (no condition) is not capped');

console.log('ok: an explicit indefinite stay(-1, cond) is capped to one day; a night wait is not');
