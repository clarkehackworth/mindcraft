// Andy tried !craftRecipe("bed") repeatedly and got a bare "Invalid item type:
// bed", which told it nothing -- so it abandoned the bed goal rather than
// guessing white_bed. Category names now come back with the real names.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { suggestNames, useRegistry } from './mcdata.js';
import minecraftData from 'minecraft-data';

useRegistry(minecraftData('1.21.1'));

test('a category name suggests the real item names', () => {
    const s = suggestNames('bed');
    assert.match(s, /white_bed/);
    assert.match(s, /Did you mean/);
});

test('prefixed categories work too', () => {
    assert.match(suggestNames('wool'), /white_wool/);
    assert.match(suggestNames('planks'), /oak_planks/);
});

test('the whole dyed set is shown, so the common colour is never cut off', () => {
    const s = suggestNames('bed');
    assert.ok(!s.includes('total'), 'no truncation for a 16-colour set');
    for (const c of ['white_bed', 'red_bed', 'black_bed']) assert.match(s, new RegExp(c));
});

test('a valid or unrelated name suggests nothing', () => {
    assert.equal(suggestNames('white_bed'), '');
    assert.equal(suggestNames('zzzznotathing'), '');
});

test('blocks are looked up in the block list', () => {
    assert.match(suggestNames('log', 'block'), /_log/);
});

// A modpack put 365 blocks behind "_log", and the alphabetical list came back as
// anchor_tree_log, bundled_cherry_log and friends -- none of them near the bot,
// with oak_log nowhere in it.
test('vanilla names come before modded ones', () => {
    const registry = { blocks: {}, items: {}, recipes: {} };
    let id = 0;
    for (const n of ['oak_log', 'birch_log', 'spruce_log']) registry.blocks[id] = { id: id++, name: n };
    for (const n of ['anchor_tree_log', 'bundled_cherry_log', 'apple_log']) registry.blocks[id] = { id: id++, name: n, mod: true };
    useRegistry(registry);

    const s = suggestNames('log', 'block');
    assert.match(s, /birch_log, oak_log, spruce_log/);
    assert.ok(!s.includes('anchor_tree_log'), 'modded names do not crowd out vanilla ones');
    assert.match(s, /3 more, mostly modded/);

    useRegistry(minecraftData('1.21.1'));
});

test('an all-modded category still suggests something', () => {
    useRegistry({ blocks: { 0: { id: 0, name: 'brimwood_log', mod: true } }, items: {}, recipes: {} });
    assert.match(suggestNames('log', 'block'), /brimwood_log/);
    useRegistry(minecraftData('1.21.1'));
});
