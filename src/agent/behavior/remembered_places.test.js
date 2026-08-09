// The live bot had zero saved places and an empty chest 60 blocks from where it
// forages: every food run started from nothing and every harvest stayed in the
// bag. remember_here/goto_place turn one paid discovery into a free route, but
// only if the remembering rule stops after the first fire and the walking rule
// stays quiet until there is somewhere to walk.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import { evalCondition, ACTIONS, validatePolicy } from './policy.js';
import { MemoryBank } from '../memory_bank.js';

function agentAt(x, y, z) {
    return {
        memory_bank: new MemoryBank(),
        bot: { entity: { position: { x, y, z } }, output: '' },
    };
}

test('place_known follows what was remembered', () => {
    const agent = agentAt(10, 64, -20);
    assert.equal(evalCondition({ cond: 'place_known', name: 'berries' }, agent), false);
    ACTIONS.remember_here.fn(agent, { name: 'berries' });
    assert.equal(evalCondition({ cond: 'place_known', name: 'berries' }, agent), true);
    assert.deepEqual(agent.memory_bank.recallPlace('berries'), [10, 64, -20]);
    // Named separately, so one spot does not answer for another.
    assert.equal(evalCondition({ cond: 'place_known', name: 'pantry' }, agent), false);
});

test('goto_place with nothing remembered fails instead of walking somewhere', async () => {
    const agent = agentAt(0, 64, 0);
    assert.equal(await ACTIONS.goto_place.fn(agent, { name: 'pantry' }), false);
});

test('the remembered-spot rules can stop themselves', () => {
    const p = JSON.parse(fs.readFileSync('policies/food_gathering.json', 'utf8'));
    assert.equal(validatePolicy(p.policy), null);
    const by = Object.fromEntries(p.policy.rules.map(r => [r.name, r]));

    for (const name of ['remember_the_berry_patch', 'remember_the_pantry']) {
        const r = by[name];
        assert.match(JSON.stringify(r.when), /"not":{"cond":"place_known"/,
            `${name} re-remembers the same spot every tick`);
    }
    // Walking to a place nobody has been is a rule that fires forever and moves
    // nowhere, which is exactly the state the live bot was in.
    for (const r of p.policy.rules.filter(r => (r.do ?? []).some(a => a.act === 'goto_place'))) {
        const walked = r.do.filter(a => a.act === 'goto_place').map(a => a.name);
        for (const name of walked)
            assert.match(JSON.stringify(r.when), new RegExp(`"cond":"place_known","name":"${name}"`),
                `${r.name} walks to "${name}" without checking it is known`);
    }
});
