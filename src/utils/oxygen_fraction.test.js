// surface_when_drowning is pinned, has a five-second cooldown, and is the
// highest-priority rule in the policy. It fired zero times across four
// drownings in soak 13 -- because it asks whether oxygenLevel is below 12, and
// this modpack's full tank reads 400. Every air check written against vanilla's
// 0-20 scale has been answering "plenty of air" underwater.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oxygenFraction } from './mcdata.js';

test('a vanilla tank reads as a fraction of twenty', () => {
    assert.equal(oxygenFraction({ oxygenLevel: 20 }), 1);
    assert.equal(oxygenFraction({ oxygenLevel: 10 }), 0.5);
});

test('a four-hundred tick tank rescales once it has been seen full', () => {
    // The bot spends most of its life at full air, so the highest value seen
    // is the cap. Before it is seen, 400 simply reads as "more than full".
    assert.ok(oxygenFraction({ oxygenLevel: 400 }) >= 1);
    assert.equal(oxygenFraction({ oxygenLevel: 200 }), 0.5);
    // The number that used to pass the vanilla check while actually drowning.
    assert.ok(oxygenFraction({ oxygenLevel: 40 }) < 12 / 20);
});

test('a bot with no oxygen reading is not treated as drowning', () => {
    assert.equal(oxygenFraction({}), 1);
});
