// Run: node --test src/utils/family_block_name.test.js
// !collectBlocks("log", 8) was refused as "Invalid block type: log", even though
// skills.collectBlocks has always understood family names -- the policy engine's
// collect action passes "log" and it works. The refusal then suggested the
// vanilla logs, so on a pine-forest modded server the agent was sent after
// oak_log, which does not exist in that world. It spent a long time looking.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import prismarine_registry from 'prismarine-registry';
import * as mc from '../utils/mcdata.js';

mc.useRegistry(prismarine_registry('1.20.1'));

test('a real block name is known', () => {
    assert.equal(mc.isKnownBlockName('oak_log'), true);
    assert.equal(mc.isKnownBlockName('stone'), true);
});

test('a family name is known, because the skills accept one', () => {
    for (const family of ['log', 'planks', 'leaves', 'bed', 'wool'])
        assert.equal(mc.isKnownBlockName(family), true, `"${family}" is a family the skills expand`);
});

test('an ore family covers its deepslate form', () => {
    assert.equal(mc.isKnownBlockName('iron_ore'), true);
    assert.deepEqual(mc.expandBlockName('iron_ore'), ['iron_ore', 'deepslate_iron_ore']);
});

test('a name that is neither is still rejected', () => {
    // The whole point of the check: a name the world has never heard of must
    // still fail loudly rather than silently matching nothing at runtime.
    assert.equal(mc.isKnownBlockName('unobtainium'), false);
    assert.equal(mc.isKnownBlockName('sword'), false, '"sword" is not a block family -- it matches nothing');
});

test('expansion that resolves to nothing real is not a free pass', () => {
    // expandBlockName is happy to build names from a family template; only the
    // ones the registry actually has may count.
    assert.equal(mc.isKnownBlockName('not_a_family'), false);
});
