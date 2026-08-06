// Run: node src/agent/library/block_scan.test.js
// findBlockPositions replaces bot.findBlocks, which spent 56.9% of the live
// agent's CPU building a Block object per candidate because Prominence 2's
// direct-palette sections give its palette check nothing to reject on. These
// tests pin the two things that matter: it finds the same blocks, and it
// rejects whole sections without reading them.
import assert from 'assert';
import { Vec3 } from 'vec3';
import { findBlockPositions } from './world.js';

const WHEAT = { id: 183, minStateId: 4278, maxStateId: 4285 };
const WHEAT_STATE = 4280;
const STONE_STATE = 1;
const idx = (x, y, z) => (y << 8) | (z << 4) | x;

// A section reports how many blocks were actually read, so "skipped the whole
// section" is an assertion rather than a hope.
function section(container) {
    let reads = 0;
    const wrapped = { ...container, get(i) { reads++; return container.get(i); } };
    return { data: wrapped, reads: () => reads };
}
const directSection = (entries) => {
    const m = new Map();
    for (const e of entries) m.set(idx(e.x, e.y, e.z), e.state);
    return section({ get: i => m.get(i) ?? 0 });          // no palette, no value
};
const indirectSection = (palette) => section({ palette, get: () => palette[0] });
const singleValueSection = (value) => section({ value, get: () => value });

function makeBot(columns, pos = new Vec3(0.5, 4, 0.5)) {
    return {
        entity: { position: pos },
        registry: { blocks: { [WHEAT.id]: WHEAT } },
        world: { getColumn: (cx, cz) => columns[`${cx},${cz}`] ?? null },
    };
}
const col = (...sections) => ({ minY: 0, sections });

// 1. The modded case: a direct-palette section, which is the one mineflayer
//    cannot reject and therefore fully materializes.
{
    const s = directSection([{ x: 2, y: 4, z: 3, state: WHEAT_STATE }]);
    const found = findBlockPositions(makeBot({ '0,0': col(s) }), [WHEAT.id], 16, 1);
    assert.equal(found.length, 1, 'wheat in a direct-palette section is found');
    assert.ok(found[0].equals(new Vec3(2, 4, 3)), 'at the right position');
}

// 2. An all-air section is one integer comparison, not 4096 reads. This is the
//    case mineflayer gets worst: no palette means it scans every block of it.
{
    const air = singleValueSection(0);
    const found = findBlockPositions(makeBot({ '0,0': col(air) }), [WHEAT.id], 16, 1);
    assert.equal(found.length, 0, 'nothing found in an air section');
    assert.equal(air.reads(), 0, 'an all-air section is rejected without reading a single block');
}

// 3. An indirect palette that cannot contain wheat is rejected on the palette,
//    and crucially without building a Block per palette entry.
{
    const stone = indirectSection([STONE_STATE]);
    const found = findBlockPositions(makeBot({ '0,0': col(stone) }), [WHEAT.id], 16, 1);
    assert.equal(found.length, 0, 'nothing found in a stone section');
    assert.equal(stone.reads(), 0, 'a palette that lacks the target is rejected without reading blocks');
}

// 4. An indirect palette that DOES contain the target is scanned.
{
    const s = section({ palette: [WHEAT_STATE], get: () => WHEAT_STATE });
    const found = findBlockPositions(makeBot({ '0,0': col(s) }), [WHEAT.id], 16, 1);
    assert.equal(found.length, 1, 'a matching palette is not skipped');
}

// 5. Nearest first, and count is respected.
{
    const s = directSection([
        { x: 10, y: 4, z: 0, state: WHEAT_STATE },   // 10 away
        { x: 2, y: 4, z: 3, state: WHEAT_STATE },    // ~3.6 away
    ]);
    const bot = makeBot({ '0,0': col(s) });
    const one = findBlockPositions(bot, [WHEAT.id], 16, 1);
    assert.ok(one[0].equals(new Vec3(2, 4, 3)), 'returns the nearest match first');
    const two = findBlockPositions(bot, [WHEAT.id], 16, 2);
    assert.equal(two.length, 2, 'returns up to count matches');
    assert.ok(two[0].equals(new Vec3(2, 4, 3)) && two[1].equals(new Vec3(10, 4, 0)), 'sorted by distance');
    assert.equal(findBlockPositions(bot, [WHEAT.id], 5, 5).length, 1, 'blocks past the distance are excluded');
}

// 6. An unknown block id matches nothing rather than everything.
{
    const s = directSection([{ x: 1, y: 4, z: 1, state: WHEAT_STATE }]);
    assert.equal(findBlockPositions(makeBot({ '0,0': col(s) }), [99999], 16, 1).length, 0, 'an id absent from the registry matches nothing');
    assert.equal(findBlockPositions(makeBot({ '0,0': col(s) }), [], 16, 1).length, 0, 'no ids matches nothing');
}

// 7. The many-targets path (getNearestBlocks(bot, null) asks for every block in
//    the registry) switches to a lookup table, and must still be exact.
{
    const MANY = {};
    const ids = [];
    for (let i = 0; i < 40; i++) { MANY[i] = { minStateId: 100 + i * 10, maxStateId: 109 + i * 10 }; ids.push(i); }
    const target = MANY[7].minStateId + 4;                       // inside block 7's range
    const gap = MANY[39].maxStateId + 1;                         // past every range
    const s = directSection([{ x: 1, y: 4, z: 1, state: target }, { x: 3, y: 4, z: 1, state: gap }]);
    const bot = { entity: { position: new Vec3(0.5, 4, 0.5) }, registry: { blocks: MANY },
                  world: { getColumn: (cx, cz) => (cx === 0 && cz === 0 ? col(s) : null) } };
    const found = findBlockPositions(bot, ids, 16, 5);
    assert.equal(found.length, 1, 'the lookup-table path matches exactly the states in range');
    assert.ok(found[0].equals(new Vec3(1, 4, 1)), 'and finds the right one');
}

// 8. Missing chunks and empty section slots are skipped, not crashed on.
{
    const bot = makeBot({ '0,0': col(null, undefined) });
    assert.equal(findBlockPositions(bot, [WHEAT.id], 16, 1).length, 0, 'unloaded chunks and empty sections are survivable');
}

console.log('ok: state-id scan finds blocks and rejects whole sections without reading them');
process.exit(0);
