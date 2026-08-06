import test from 'node:test';
import assert from 'node:assert';
import { expandBlockName, WOOD_TYPES, WOOL_COLORS } from './mcdata.js';
import { evalCondition } from '../agent/behavior/policy.js';

test('family names expand to every variant', () => {
    assert.deepEqual(expandBlockName('log'), WOOD_TYPES.map(w => `${w}_log`));
    assert.deepEqual(expandBlockName('coal_ore'), ['coal_ore', 'deepslate_coal_ore']);
    assert.deepEqual(expandBlockName('deepslate_coal_ore'), ['deepslate_coal_ore'], 'no double expansion');
});

test('leaves, stripped logs and wool are families too', () => {
    assert.deepEqual(expandBlockName('leaves'), WOOD_TYPES.map(w => `${w}_leaves`));
    assert.deepEqual(expandBlockName('stripped_log'), WOOD_TYPES.map(w => `stripped_${w}_log`));
    assert.deepEqual(expandBlockName('wool'), WOOL_COLORS.map(c => `${c}_wool`));
    assert.deepEqual(expandBlockName('white_wool'), ['white_wool'], 'a stated color is preserved');
    // "Is there a bed here" is a question about sleeping through the night, and
    // it was answered "no" 277 times while a white_bed sat at the base.
    assert.deepEqual(expandBlockName('bed'), WOOL_COLORS.map(c => `${c}_bed`));
    assert.deepEqual(expandBlockName('white_bed'), ['white_bed']);
});

test('exact names stay exact', () => {
    assert.deepEqual(expandBlockName('oak_log'), ['oak_log'], 'stated species is preserved');
    assert.deepEqual(expandBlockName('wheat'), ['wheat']);
    assert.deepEqual(expandBlockName('chest'), ['chest']);
});

test('has_item counts across a family', () => {
    const agent = { bot: { inventory: { slots: [
        { name: 'birch_log', count: 20 },
        { name: 'spruce_log', count: 15 },
        null,
    ] } } };
    assert.ok(evalCondition({ cond: 'has_item', item: 'log', count: 32 }, agent),
        '20 birch + 15 spruce satisfies 32 "log"');
    assert.ok(!evalCondition({ cond: 'has_item', item: 'oak_log', count: 32 }, agent),
        'an exact species does not borrow from siblings');
});
