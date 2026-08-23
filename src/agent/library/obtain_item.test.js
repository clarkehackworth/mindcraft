// Run: node src/agent/library/obtain_item.test.js
// obtainItem is the middle tier between one-shot skills and the LLM: plan the
// whole gather -> smelt -> craft chain in code. These tests pin the decision
// logic that needs no live server: recognising "already done", reasoning
// through a smelt source, and failing honestly on things it cannot source
// (mob drops) instead of pathfinding after nothing.
import assert from 'assert';
import registryLoader from 'prismarine-registry';
import { useRegistry } from '../../utils/mcdata.js';
import * as skills from './skills.js';

const registry = registryLoader('1.20.1');
useRegistry(registry);

function fakeBot(items = {}) {
    return {
        registry,
        output: '',
        interrupt_code: false,
        inventory: {
            slots: Object.entries(items).map(([name, count]) =>
                ({ name, count, type: registry.itemsByName[name]?.id })),
            items: () => Object.entries(items).map(([name, count]) =>
                ({ name, count, type: registry.itemsByName[name]?.id })),
        },
    };
}

// Already holding enough: no skills fire, immediate success.
{
    const bot = fakeBot({ iron_pickaxe: 1 });
    assert.equal(await skills.obtainItem(bot, 'iron_pickaxe', 1), true);
    assert.match(bot.output, /Already have/);
}
console.log('ok: obtainItem recognises a satisfied goal without moving');

// A mob drop: not craftable, not mineable, no smelt source. The honest answer
// is "I cannot source this", not a pathfinder search for a block that does
// not exist.
{
    const bot = fakeBot({});
    assert.equal(await skills.obtainItem(bot, 'ender_pearl', 1), false);
    assert.match(bot.output, /hunting, farming, or looting/);
}
console.log('ok: unsourceable items fail honestly instead of wandering');

// cooked_beef reasons through the furnace: the smelt source is beef, beef is
// a mob drop, so the chain fails at the input with the honest message -- it
// must NOT claim the cooked item itself is unknown.
{
    const bot = fakeBot({});
    assert.equal(await skills.obtainItem(bot, 'cooked_beef', 1), false);
    assert.match(bot.output, /beef/);
    assert.match(bot.output, /hunting, farming, or looting/);
}
console.log('ok: smeltables trace back to their raw input before giving up');

// The depth cap is a guard, not a behavior: a chain deeper than the cap says
// so rather than recursing forever.
{
    const bot = fakeBot({});
    assert.equal(await skills.obtainItem(bot, 'iron_pickaxe', 1, 99), false);
    assert.match(bot.output, /deeper than/);
}
console.log('ok: the recursion cap fails loud, not deep');
