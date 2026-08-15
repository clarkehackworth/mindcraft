// Run: node src/agent/library/craft_cycle.test.js
// Live bug (soak 14): Prominence 2 crafts stick from pine_branch AND pine_branch
// from stick. getCraftingPlan is depth-capped so each plan terminates, but
// craftRecipe recursed once per plan and nothing remembered the items already
// being expanded:
//     Crafting intermediate items for torch: 2 pine_branch, 4 stick.
//     Crafting intermediate items for pine_branch: 4 stick.
//     Crafting intermediate items for stick: 2 pine_branch.
//     Crafting intermediate items for pine_branch: 4 stick.       ...
//     Rule 'active:craft_torches' step craft failed: Maximum call stack size exceeded
// 102365 chars of log, and the synchronous burn blocked the event loop past
// minecraft-protocol's 60s keepalive. The bot timed out of the server,
// reconnected, resumed the same goal and timed out again -- every 58 seconds for
// 40 minutes, until the soak was reduced to a reconnect loop.
//
// Uses the real mod_data pack, because a synthetic two-item cycle cannot
// reproduce this: the planner bottoms out on inventory at depth 1 and returns a
// single step. It takes the pine_log -> pine_branch <-> stick shape to make
// plan(stick) and plan(pine_branch) each name the other.
import assert from 'assert';
import prismarine_registry from 'prismarine-registry';
import { Vec3 } from 'vec3';
import { loadModDataPacks, applyModDataPacks } from '../../utils/mod_data.js';
import { useRegistry, getCraftingPlan } from '../../utils/mcdata.js';

const registry = prismarine_registry('1.20.1');
const packs = loadModDataPacks('./mod_data');
assert.ok(packs.length, 'this test needs mod_data/prominence2.json');
applyModDataPacks(registry, packs);
useRegistry(registry);

// The inventory Andy actually held: logs and a coal, no sticks.
const INV = { pine_log: 4, coal: 1 };
const intermediates = (item, n) => {
    const plan = getCraftingPlan(item, n, INV);
    return plan.steps.filter(s => s.item !== item).map(s => s.item);
};

// Guard the guard: if the modpack ever stops being cyclic here, this test is
// no longer testing anything and should say so rather than passing quietly.
assert.ok(intermediates('stick', 4).includes('pine_branch'), 'stick still plans via pine_branch');
assert.ok(intermediates('pine_branch', 2).includes('stick'), 'pine_branch still plans via stick');

const { craftRecipe } = await import('./skills.js');

let opened = 0;
const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    world: { getBlockStateId: () => 0, getColumn: () => null },
    inventory: {
        count: () => 0,
        items: () => [],
        slots: Object.entries(INV).map(([name, count]) => ({ name, count })),
        findInventoryItem: () => { opened++; return null; },   // never actually craftable
    },
    registry,
    recipesFor: () => [],           // no vanilla recipe -> the intermediates path
    craft: async () => {},
    findBlocks: () => [],
    blockAt: () => null,
    output: '',
    interrupt_code: false,
    emit: () => {},
    chat: () => {},
    modes: { isOn: () => false },
};

let threw = null, result;
try { result = await craftRecipe(bot, 'torch', 4); }
catch (e) { threw = e; }

assert.equal(threw, null, `a cyclic recipe pair must not blow the stack: ${threw && threw.message}`);
assert.equal(result, false, 'an uncraftable cycle reports failure');
// The live failure emitted 102365 chars before dying. Any bound well under that
// catches a regression; the fixed path emits a handful of lines.
assert.ok(bot.output.length < 4000,
    `output stayed bounded, got ${bot.output.length} chars`);
const expansions = (bot.output.match(/Crafting intermediate items/g) ?? []).length;
assert.ok(expansions <= 3,
    `each item expands at most once per chain, saw ${expansions} expansions`);

console.log('ok: stick <-> pine_branch terminates instead of overflowing the stack');
process.exit(0);
