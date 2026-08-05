// Run: node --test src/agent/behavior/prompt_rule.test.js
// Prompt-only rules were unpoliced. Rule.update() splits "do" into steps and
// prompts, and only steps go through execute() -- the arbiter that honours
// "interrupts". So a rule whose whole "do" is prompt_self dispatched straight
// into whatever was running, no matter what it declared, and never backed off
// because backoff was measured from step progress it had none of. Twelve such
// rules said "interrupts": "idle"; one fired 959 times in a session.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { Rule, CONDITIONS } from './policy.js';

function fakeAgent({ idle = true, held = null } = {}) {
    const messages = [];
    return {
        messages,
        isIdle: () => idle,
        handleMessage: (source, msg) => messages.push(msg),
        bot: { interrupt_code: false, heldItem: held ? { name: held } : null },
    };
}

const noExecute = async () => { throw new Error('prompt-only rules must not reach execute()'); };
const promptRule = extra => new Rule({
    name: 'ask_self', description: 'ask', when: { cond: 'always' },
    do: [{ act: 'prompt_self', message: 'think about it' }], cooldown: 0, ...extra,
});

test('an "idle" prompt-only rule waits for idle instead of talking over the action', async () => {
    const busy = fakeAgent({ idle: false });
    await promptRule({ interrupts: 'idle' }).update(busy, noExecute);
    assert.deepEqual(busy.messages, [], 'nothing dispatched while busy');

    const free = fakeAgent({ idle: true });
    await promptRule({ interrupts: 'idle' }).update(free, noExecute);
    assert.equal(free.messages.length, 1, 'dispatches once the agent is free');
});

test('an "all" prompt-only rule still interrupts, as it says it does', async () => {
    const busy = fakeAgent({ idle: false });
    await promptRule({ interrupts: 'all' }).update(busy, noExecute);
    assert.equal(busy.messages.length, 1);
});

test('only one rule may prompt per arbiter tick', async () => {
    const agent = fakeAgent();
    const rules = [1, 2, 3, 4, 5, 6].map(i => promptRule({ name: `ask_${i}`, interrupts: 'all' }));
    for (const r of rules) await r.update(agent, noExecute);
    assert.equal(agent.messages.length, 1, 'the highest-priority rule wins the tick');
    // The losers did not consume their turn either -- no last_fire, so their own
    // cooldown brings them straight back.
    assert.equal(rules[1].last_fire, 0);
});

test('a prompt-only rule backs off while its trigger stays true, and decays when it stops', async () => {
    const agent = fakeAgent();
    const rule = promptRule({ interrupts: 'all' });
    await rule.update(agent, noExecute);
    assert.equal(rule.backoff, 2, 'asking again means the last ask did not work');

    // Same rule on a trigger that goes away: eligible() clears the penalty.
    const gated = new Rule({
        name: 'ask_when_hurt', description: 'ask', when: { cond: 'health_below', value: 10 },
        do: [{ act: 'prompt_self', message: 'ouch' }], interrupts: 'all', cooldown: 0,
    });
    gated.backoff = 64;
    assert.equal(gated.eligible({ bot: { health: 20 } }), false);
    // Halved rather than wiped: see the flapping-trigger test below for why.
    assert.equal(gated.backoff, 32, 'the penalty decays as the trigger stays gone');
});

test('"holding" gates the equip rule that used to re-fire forever', () => {
    const held = name => ({ bot: { heldItem: name ? { name } : null } });
    assert.equal(CONDITIONS.holding.fn(held('stone_sword'), { item: 'weapon' }), true);
    assert.equal(CONDITIONS.holding.fn(held('diamond_axe'), { item: 'weapon' }), true);
    assert.equal(CONDITIONS.holding.fn(held('iron_pickaxe'), { item: 'weapon' }), false, 'a pickaxe is not a weapon');
    assert.equal(CONDITIONS.holding.fn(held(null), { item: 'weapon' }), false, 'empty hands');
    assert.equal(CONDITIONS.holding.fn(held('torch'), { item: 'torch' }), true, 'exact names too');
});

// Two live-found bugs, both about a rule that cannot stop itself.
test('"weapon" works in has_item, because "sword" silently does not', () => {
    // has_item reads world.getInventoryCounts, which walks bot.inventory.slots.
    const agent = items => ({ bot: { inventory: { slots: items.map(name => ({ name, count: 1 })) } } });
    const stone = agent(['stone_sword', 'dirt']);
    const none = agent(['dirt', 'iron_pickaxe']);
    assert.equal(CONDITIONS.has_item.fn(stone, { item: 'weapon' }), true);
    assert.equal(CONDITIONS.has_item.fn(none, { item: 'weapon' }), false, 'a pickaxe is not a weapon');
    // The spelling that looks right and matches nothing -- the reason
    // no_weapon_no_fight fired on every hostile for a whole session.
    assert.equal(CONDITIONS.has_item.fn(stone, { item: 'sword' }), false,
        '"sword" is not a family name; this is why the rule must say "weapon"');
});

test('backoff decays on a flapping trigger instead of resetting', () => {
    const rule = new Rule({
        name: 'flappy', description: 'x', when: { cond: 'hostile_nearby' },
        do: [{ act: 'equip_weapon' }], interrupts: 'all', cooldown: 0,
    });
    // hostile_nearby asks bot.nearestEntity; no mob in range means no match.
    const mobGone = { bot: { nearestEntity: () => null, entity: { position: { distanceTo: () => 99 } } } };
    rule.backoff = 64;
    rule.eligible(mobGone);
    assert.equal(rule.backoff, 32, 'halved, not wiped');
    for (let i = 0; i < 3; i++) { rule.last_eval = 0; rule.eligible(mobGone); }
    assert.equal(rule.backoff, 4, 'a genuinely resolved situation still recovers');
    for (let i = 0; i < 10; i++) { rule.last_eval = 0; rule.eligible(mobGone); }
    assert.equal(rule.backoff, 1, 'and bottoms out at full speed');
});
