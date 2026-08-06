// Run: node --test src/agent/behavior/is_freezing.test.js
// Andy died "froze to death" on Prominence 2 and kept writing itself cold-weather
// rules, but CONDITIONS had no word for cold -- so the model substituted is_night
// or hostile_nearby and landed on {"act": "stay"}, standing still in the open,
// which is the worst rule shape available and the one the validator exists to
// reject. The condition is the missing vocabulary.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import { evalCondition, validatePolicy } from './policy.js';

// The metadata approach is gone: while the bot was freezing to death on this
// server, key 7 was never sent at all. is_freezing now reads the cause instead.
import { Vec3 } from 'vec3';
const agentIn = ({ foot = 'air', head = 'air', biome = 'plains', raining = false } = {}) => ({
    bot: {
        entity: { position: new Vec3(0, 64, 0) },
        isRaining: raining,
        blockAt: (p) => ({ name: p.y === 64 ? foot : head }),
        world: { getBiome: () => 1 },
        registry: { biomes: { 1: { name: biome } } },
    },
});

test('standing in powder snow is freezing', () => {
    assert.equal(evalCondition({ cond: 'is_freezing' }, agentIn({ foot: 'powder_snow' })), true);
    assert.equal(evalCondition({ cond: 'is_freezing' }, agentIn({ head: 'powder_snow' })), true,
        'sunk in up to the head counts too');
});

test('snowfall in a cold biome is freezing', () => {
    assert.equal(evalCondition({ cond: 'is_freezing' },
        agentIn({ biome: 'snowy_taiga', raining: true })), true);
    assert.equal(evalCondition({ cond: 'is_freezing' },
        agentIn({ biome: 'frozen_peaks', raining: true })), true);
});

test('a cold biome in clear weather is not, and that matters', () => {
    // This agent lives in a snowy forest permanently. Firing on biome alone
    // would mean a pinned interrupts:all rule that never stops firing.
    assert.equal(evalCondition({ cond: 'is_freezing' },
        agentIn({ biome: 'snowy_taiga', raining: false })), false);
});

test('rain somewhere warm is not freezing', () => {
    assert.equal(evalCondition({ cond: 'is_freezing' },
        agentIn({ biome: 'plains', raining: true })), false);
});

test('a modded cold biome name still counts', () => {
    // getBiomeName reads the server registry, so modded names arrive here.
    assert.equal(evalCondition({ cond: 'is_freezing' },
        agentIn({ biome: 'frostiful:glacial_barrens', raining: true })), true);
});

test('a bot with no position does not throw', () => {
    assert.equal(evalCondition({ cond: 'is_freezing' }, { bot: {} }), false);
});

test('the base policy has a rule that answers freezing, and it is valid', () => {
    const p = JSON.parse(fs.readFileSync('policies/stayin_alive.json', 'utf8'));
    assert.equal(validatePolicy(p.policy), null);
    const rule = p.policy.rules.find(r => JSON.stringify(r.when).includes('is_freezing'));
    assert.ok(rule, 'stayin_alive answers freezing itself, so the agent need not invent it');
    // The whole point: whatever it does, it must not be standing still.
    const acts = (rule.do ?? []).map(s => s.act);
    assert.equal(acts.includes('stay'), false, 'waiting does not make you warmer');
});
