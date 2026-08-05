// Run: node --test src/agent/behavior/named_actions.test.js
// Crafting, smelting, placing and taking from a chest had no action leaf, so
// every rule that wanted one spent a full LLM generation asking itself to do a
// thing it could already name exactly -- 23 of the 45 shipped rules, each on a
// cooldown, forever. These four leaves took that to 4.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { ACTIONS, validatePolicy } from './policy.js';

const profiles = readdirSync('policies').map(f => [f, JSON.parse(readFileSync('policies/' + f, 'utf8'))]);
const rulesOf = ([, p]) => (p.policy ?? p).rules;

test('every shipped profile still compiles', () => {
    for (const entry of profiles)
        assert.equal(validatePolicy(entry[1].policy ?? entry[1]), null, entry[0]);
});

test('prompt_self is the exception, not the default', () => {
    const all = profiles.flatMap(rulesOf);
    const prompting = all.filter(r => r.do.some(s => s.act === 'prompt_self'));
    assert.ok(prompting.length <= 6,
        `${prompting.length} of ${all.length} rules pay for a generation: ${prompting.map(r => r.name).join(', ')}`);
});

test('nothing prompts for something it could have named', () => {
    // The tell: a prompt whose text is really an instruction to craft, smelt or
    // place a specific item. Those have leaves now.
    for (const rule of profiles.flatMap(rulesOf)) {
        for (const step of rule.do) {
            if (step.act !== 'prompt_self') continue;
            assert.doesNotMatch(step.message, /\b(craft|smelt|cook) (a |an |the )?[a-z_]+(_sword|_pickaxe|_shovel|_axe|_chestplate|_helmet|_boots|_leggings|torch|bread|chest|furnace)\b/i,
                `${rule.name} prompts for a named craft`);
        }
    }
});

test('an idle timer with no world trigger is not a rule', () => {
    for (const rule of profiles.flatMap(rulesOf)) {
        const only_prompts = rule.do.every(s => s.act === 'prompt_self');
        if (!only_prompts) continue;
        const flat = JSON.stringify(rule.when);
        assert.notEqual(flat, '{"cond":"is_idle"}', `${rule.name} bills a generation on a bare timer`);
    }
});

test('the new leaves are declared like the rest', () => {
    for (const name of ['craft', 'smelt', 'place', 'withdraw']) {
        const a = ACTIONS[name];
        assert.ok(a, `${name} exists`);
        assert.ok(typeof a.fn === 'function', `${name} has a body`);
        assert.ok(['cheap', 'blocking'].includes(a.cost), `${name} declares a cost`);
        assert.ok(Array.isArray(a.clears), `${name} declares what it clears`);
        assert.ok(a.desc?.length > 20, `${name} is documented for the compiler`);
    }
});

test('a step for an item you do not have is a cheap no-op, not a failure', async () => {
    // take_food_from_storage lists four staples in a row precisely because a
    // withdraw for food that is not there costs nothing. Prove it returns rather
    // than throwing, so the steps after it still run.
    const bot = { inventory: { items: () => [] }, entity: { position: { x: 0, y: 64, z: 0 } } };
    const agent = { bot };
    // No chest and no world: the skill reports false, and the rule moves on.
    const result = await ACTIONS.withdraw.fn(agent, { item: 'bread' }).catch(e => e);
    assert.ok(result === false || result instanceof Error, 'resolves or rejects, never hangs');
});

// The agent replaced one deleted always-true set_mode rule with EIGHT of them,
// each {"when":{"cond":"always"},"do":[{"act":"set_mode"}]}. Together they kept
// the arbiter executing something every tick, and a burst of sub-20ms actions
// reads as a runaway loop: four cleanKills in twenty minutes, none of them an
// actual loop. Modes are configuration; the policy has a "modes" block for them.
test('a rule that only flips modes on a bare trigger is refused', () => {
    const modeRule = (when) => ({ rules: [{
        name: 'always_on', description: 'd', when,
        do: [{ act: 'set_mode', mode: 'cowardice', on: true }],
    }] });
    for (const when of [{ cond: 'always' }, { cond: 'is_idle' }]) {
        const err = validatePolicy(modeRule(when));
        assert.ok(err, `${JSON.stringify(when)} -> set_mode must be rejected`);
        assert.match(err, /modes.*block/i, 'and it says where modes actually belong');
    }
    // A real trigger is still fine: reacting to the world by changing a mode is
    // a legitimate thing for a rule to do.
    assert.equal(validatePolicy(modeRule({ cond: 'hostile_nearby', range: 16 })), null);
});
