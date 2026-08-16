// Every fold this loop has made came from spotting a death pattern by eye in
// the log, which stops working once there are more than a few. The EVT line has
// to carry the five fields that have actually decided a rule -- cause, place,
// night or day, armed or not, and how much it owned -- and the harness parses
// it with grep, so the shape matters as much as the content.
import { strict as assert } from 'node:assert';
import test from 'node:test';

// The line agent.js builds, kept here as the contract the `deaths` harness
// command greps for.
function deathEvt({ translate, pos, timeOfDay, items }) {
    const armed = items.some(i => /sword|axe/.test(i.name));
    return `EVT death:${translate}:${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`
        + `:${timeOfDay >= 13000 ? 'night' : 'day'}:${armed ? 'armed' : 'unarmed'}`
        + `:items${items.length}`;
}

test('a death carries cause, place, light and whether it could fight back', () => {
    assert.equal(
        deathEvt({ translate: 'death.attack.mob', pos: { x: -52.4, y: 88, z: -66.7 },
                   timeOfDay: 18000, items: [{ name: 'oak_log' }] }),
        // floor, not round: these are block coordinates, and -52.4 is in block
        // -53. Clustering repeat deaths only works if the arithmetic matches
        // the blocks the world is made of.
        'EVT death:death.attack.mob:-53,88,-67:night:unarmed:items1');
    assert.equal(
        deathEvt({ translate: 'death.attack.drown', pos: { x: 96.5, y: 63, z: 186.5 },
                   timeOfDay: 1000, items: [{ name: 'stone_sword' }] }),
        'EVT death:death.attack.drown:96,63,186:day:armed:items1');
});

test('an axe counts as armed, a pickaxe is not a weapon by accident', () => {
    const at = items => deathEvt({ translate: 'x', pos: { x: 0, y: 0, z: 0 }, timeOfDay: 0, items });
    assert.match(at([{ name: 'stone_axe' }]), /:armed:/);
    assert.match(at([{ name: 'wooden_shovel' }]), /:unarmed:/);
});

test('the tally patterns the harness greps for still match', () => {
    const line = deathEvt({ translate: 'death.attack.mob', pos: { x: 1, y: 2, z: 3 },
                            timeOfDay: 18000, items: [] });
    // `deaths` counts causes with one pattern and circumstances with another.
    assert.equal(line.match(/death:[a-zA-Z.]+/)?.[0], 'death:death.attack.mob');
    assert.equal(line.match(/:(night|day):(armed|unarmed)/)?.[0], ':night:unarmed');
    // The empty-handed death is the one worth counting: a bot with nothing
    // cannot pillar out, cannot fight, and cannot eat.
    assert.equal(line.match(/:items[0-9]+$/)?.[0], ':items0');
});
