// Run: node --test src/agent/behavior/dig_in_ratchet.test.js
// dig_in digs three blocks down and caps the hole. Doing that once is shelter;
// doing it from inside the hole you just capped is three blocks of descent and
// no extra safety. The agent wrote itself night_no_weapon_shelter -- hostile
// within 16 and no weapon -> dig_in -- with a six second cooldown, interrupts
// all, and no is_sheltered check, so with a hostile parked nearby it re-dug
// every six seconds. One session went y=33 -> 28 -> 14 -> 5, heading for
// bedrock, while climb_out_of_the_deep fired eight times in nine minutes trying
// to undo it and lost.
//
// Every rule in stayin_alive.json gates on "not is_sheltered". Rules are written
// by a model, so the gate has to live where a model cannot forget it.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Vec3 } from 'vec3';
import { ACTIONS } from './policy.js';
import { isSheltered } from '../library/skills.js';

// roof: what sits 2 and 3 blocks above the feet.
function fakeAgent({ roof = 'air' } = {}) {
    const dug = [];
    const bot = {
        entity: { position: new Vec3(-30.5, 14, -5.5) },
        output: '',
        interrupt_code: false,
        inventory: { items: () => [] },
        blockAt: (p) => ({
            name: p.y > 14 ? roof : 'stone',
            boundingBox: (p.y > 14 ? roof : 'stone') === 'air' ? 'empty' : 'block',
        }),
        dig: async (b) => { dug.push(b); },
        digDown: async (n) => { dug.push(n); },
    };
    return { agent: { bot }, bot, dug };
}

test('a bot already under a roof does not dig a second hole', async () => {
    const { agent, bot, dug } = fakeAgent({ roof: 'stone' });
    const start_y = bot.entity.position.y;

    const result = await ACTIONS.dig_in.fn(agent, {});

    assert.equal(result, true, 'the caller wanted shelter and has it -- that is success');
    assert.equal(dug.length, 0, 'nothing was dug');
    assert.equal(bot.entity.position.y, start_y, 'and the bot did not descend');
    assert.match(bot.output, /Already under cover/);
});

test('reporting success matters, not just skipping the dig', () => {
    // Rule.update doubles a rule's backoff whenever a step returns false. A
    // no-op that reported failure would punish the rule for being satisfied,
    // and the rule would then retry more and more slowly when it did matter.
    const src = readFileSync(new URL('./policy.js', import.meta.url), 'utf8');
    const dig_in = src.slice(src.indexOf('    dig_in: {'));
    const guard = dig_in.slice(0, dig_in.indexOf('digDown'));
    assert.match(guard, /isSheltered[\s\S]*return true/,
        'the already-sheltered branch returns true');
});

test('the condition and the action agree on what shelter is', () => {
    // These were two separate copies of the same block check. The action is the
    // thing that acts on the answer, so a drift between them would mean rules
    // gating on "not is_sheltered" and dig_in disagreeing about whether to dig.
    const src = readFileSync(new URL('./policy.js', import.meta.url), 'utf8');
    const cond = src.slice(src.indexOf('    is_sheltered: {'), src.indexOf('    is_idle: {'));
    assert.match(cond, /skills\.isSheltered/, 'is_sheltered delegates to the shared helper');

    const roofed = fakeAgent({ roof: 'stone' });
    const open = fakeAgent({ roof: 'air' });
    assert.equal(isSheltered(roofed.bot), true);
    assert.equal(isSheltered(open.bot), false);
});

test('every dig_in rule in the shipped policy is gated', () => {
    // The action-level guard is the backstop, not the excuse. A rule that fires
    // every six seconds and no-ops is still an interrupts:all rule killing the
    // self-prompt loop every six seconds.
    const policy = JSON.parse(readFileSync(new URL('../../../policies/stayin_alive.json', import.meta.url), 'utf8'));
    const conds = (when) => {
        if (!when || typeof when !== 'object') return [];
        return [
            when.cond,
            ...(when.all ?? []).flatMap(conds),
            ...(when.any ?? []).flatMap(conds),
            ...conds(when.not),
        ].filter(Boolean);
    };
    const ungated = policy.policy.rules
        .filter(r => (r.do ?? []).some(d => d.act === 'dig_in'))
        .filter(r => !conds(r.when).includes('is_sheltered'))
        .map(r => r.name);
    assert.deepEqual(ungated, [], 'these dig_in rules would dig from inside a hole');
});
