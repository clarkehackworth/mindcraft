// Run: node src/agent/behavior/rule_stuck.test.js
// climb_out_of_the_deep fired 22 times over 44 minutes while Andy starved at
// the bottom of a shaft with one plank to his name. Every fire returned false.
// Nothing in the log said so: the backoff that is supposed to notice a failing
// rule kept getting halved by eligible() each time the trigger blinked off, so
// the cadence stayed at 60s and the rule looked healthy. The entrapment was
// only found by diffing 22 fire timestamps against a death event.
//
// A counter that resets on progress and nothing else survives that.
import assert from 'assert';
import { Rule, ACTIONS } from './policy.js';

function fakeAgent() {
    return {
        bot: { interrupt_code: false, output: '', emit: () => {} },
        handleMessage: () => {},
    };
}

const execute = async (_mode, _agent, func) => { try { await func(); } catch {} };

function captureLog(fn) {
    const lines = [];
    const real = console.log;
    console.log = (...args) => { lines.push(args.join(' ')); };
    return fn().finally(() => { console.log = real; }).then(() => lines);
}

const makeRule = () => new Rule({
    name: 'climb_out_of_the_deep',
    when: { cond: 'always' },
    do: [{ act: 'go_to_surface' }],
    cooldown: 0,
});

const real_climb = ACTIONS.go_to_surface.fn;

// A rule whose action never works says so, and says it once -- not on every
// fire, which would just be the silence problem inverted into noise.
{
    ACTIONS.go_to_surface.fn = async () => false;
    const rule = makeRule();
    const agent = fakeAgent();
    const lines = await captureLog(async () => {
        for (let i = 0; i < 5; i++) await rule.update(agent, execute);
    });
    const stuck = lines.filter(l => l.includes('rule:stuck'));
    assert.deepEqual(stuck, ['EVT rule:stuck:climb_out_of_the_deep:5'],
        'five fires with no progress is one stuck line, naming the rule and the count');
    assert.equal(rule.failures, 5);
}

// The backoff halves whenever the trigger blinks off. This must not, or the
// exact shape of the shaft bug walks straight back in.
{
    ACTIONS.go_to_surface.fn = async () => false;
    const rule = makeRule();
    const agent = fakeAgent();
    await captureLog(async () => {
        for (let i = 0; i < 4; i++) {
            await rule.update(agent, execute);
            rule.backoff = 1;   // what eligible() does when the trigger flaps
        }
    });
    assert.equal(rule.failures, 4, 'a flapping trigger must not forgive failures');
}

// Real progress is what clears it -- and the count starts over, so the next
// stuck line means another N failures, not one more after a lucky success.
{
    const rule = makeRule();
    const agent = fakeAgent();
    await captureLog(async () => {
        ACTIONS.go_to_surface.fn = async () => false;
        for (let i = 0; i < 4; i++) await rule.update(agent, execute);
        ACTIONS.go_to_surface.fn = async () => true;
        await rule.update(agent, execute);
    });
    assert.equal(rule.failures, 0, 'one real climb clears the count');

    const lines = await captureLog(async () => {
        ACTIONS.go_to_surface.fn = async () => false;
        for (let i = 0; i < 4; i++) await rule.update(agent, execute);
    });
    assert.equal(lines.filter(l => l.includes('rule:stuck')).length, 0,
        'four more failures after a success is not yet stuck');
}

ACTIONS.go_to_surface.fn = real_climb;
console.log('rule_stuck: ok');

// A cheap step that succeeds is not the rule working. night_no_weapon_shelter
// fired 57 times in one half-hour window -- the highest count of the whole soak
// -- while Andy stood in one spot, unmoved to twelve decimal places, and the
// counter said nothing. Its first step is equip_weapon: cheap, and it returns
// non-false even when there is no weapon to equip. The blocking steps after it
// are what actually shelter the bot, and those were the ones failing.
{
    const real_equip = ACTIONS.equip_weapon.fn;
    const real_dig = ACTIONS.dig_in.fn;
    ACTIONS.equip_weapon.fn = async () => true;    // cheap, always "works"
    ACTIONS.dig_in.fn = async () => false;         // blocking, never works

    const rule = new Rule({
        name: 'night_no_weapon_shelter',
        when: { cond: 'always' },
        do: [{ act: 'equip_weapon' }, { act: 'dig_in' }],
        cooldown: 0,
    });
    const agent = fakeAgent();
    const lines = await captureLog(async () => {
        for (let i = 0; i < 5; i++) await rule.update(agent, execute);
    });

    assert.deepEqual(lines.filter(l => l.includes('rule:stuck')),
        ['EVT rule:stuck:night_no_weapon_shelter:5'],
        'the cheap step must not hide five useless fires');
    assert.equal(rule.backoff, 1,
        'and the backoff still forgives them, because a cheap step did work');

    // A blocking step that works is what clears it.
    ACTIONS.dig_in.fn = async () => true;
    await captureLog(async () => { await rule.update(agent, execute); });
    assert.equal(rule.failures, 0, 'real shelter resets the count');

    ACTIONS.equip_weapon.fn = real_equip;
    ACTIONS.dig_in.fn = real_dig;
}

console.log('rule_stuck: cheap steps do not count as work');
