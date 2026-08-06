// Run: node src/utils/unknown_blocks.test.js
// A modded server sends block state ids vanilla data has never heard of. They
// resolve to the patched-in 'unknown' block, and pathfinder walks over one by
// iterating block.shapes -- so 'unknown' must survive prismarine-block's shape
// rebuild with a real shape, or the agent crashes out of an event handler.
import assert from 'assert';
import registryLoader from 'prismarine-registry';
import blockLoader from 'prismarine-block';
import { patchUnknownBlocks, UNKNOWN_BLOCK_ID } from './mcdata.js';

const registry = registryLoader('1.20.1');
patchUnknownBlocks(registry);

// prismarine-block's provider overwrites every block's shapes from
// blockCollisionShapes; a name missing from that table gets undefined.
const Block = blockLoader(registry);
assert.ok(Array.isArray(registry.blocks[UNKNOWN_BLOCK_ID].shapes),
    'the unknown template must still have shapes after the provider rebuild');

const modded = Block.fromStateId(30000, 0);
assert.equal(modded.name, 'unknown', 'an out-of-range state id falls back to unknown');
assert.ok(Array.isArray(modded.shapes), 'shapes must be iterable, not undefined');
assert.doesNotThrow(() => { for (const _ of modded.shapes); }, 'pathfinder iterates this');

console.log('ok: unknown blocks keep an iterable shape through prismarine-block');
process.exit(0);
