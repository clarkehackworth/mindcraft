// Run: node src/agent/vision/viewer_blocks.test.js
// A modded server shifts vanilla block state ids and appends its own. The bot's
// registry knows the new ids; the browser render view only knows vanilla, so
// chunks have to be translated back before they go out over the socket.
import assert from 'assert';
import registryLoader from 'prismarine-registry';
import ChunkLoader from 'prismarine-chunk';
import { createRequire } from 'module';
import { buildStateMap, translateChunk, installStateTranslation } from './browser_viewer.js';

const registry = registryLoader('1.20.1');

// The same snapshot mcdata.js takes before applying a mod pack. It has to come
// first: prismarine-registry hands out minecraft-data's cached block objects,
// so mutating the registry rewrites "vanilla" for the whole process.
const vanilla = {};
for (const block of registry.blocksArray)
    vanilla[block.name] = { minStateId: block.minStateId, maxStateId: block.maxStateId, defaultState: block.defaultState };

// Pretend a mod added states below birch_leaves (shifting everything after it)
// and appended a block of its own, the way Prominence 2 does.
const SHIFT = 56;
const vanilla_leaves_state = vanilla.birch_leaves.minStateId;
for (const block of registry.blocksArray) {
    if (block.minStateId >= vanilla_leaves_state) {
        block.minStateId += SHIFT;
        block.maxStateId += SHIFT;
        block.defaultState += SHIFT;
    }
}
const modded_state = 618000;
registry.blocksArray.push({ name: 'redwood_log', minStateId: modded_state, maxStateId: modded_state, boundingBox: 'block' });

const map = buildStateMap(registry, vanilla);
const translate = (id) => (id > 0 && id < map.length ? map[id] : 0);

assert.equal(translate(vanilla_leaves_state + SHIFT), vanilla_leaves_state, 'a shifted vanilla block maps back to its vanilla state');
assert.equal(translate(modded_state), vanilla.oak_log.defaultState, 'a modded log renders as a log');
assert.equal(translate(0), 0, 'air stays air');

// Round trip a chunk the way the viewer does: serialise with the modded ids,
// translate, then decode with vanilla data like the browser does.
const ModdedChunk = ChunkLoader(registry);
const VanillaChunk = ChunkLoader('1.20.1');
const column = new ModdedChunk({ minY: -64, worldHeight: 384 });
column.setBlockStateId({ x: 1, y: 5, z: 2 }, vanilla_leaves_state + SHIFT);
column.setBlockStateId({ x: 3, y: 5, z: 4 }, modded_state);

const decoded = VanillaChunk.fromJson(translateChunk(column.toJson(), translate));
assert.equal(decoded.getBlockStateId({ x: 1, y: 5, z: 2 }), vanilla_leaves_state, 'the browser sees birch leaves, not whatever sits at the shifted id');
assert.equal(decoded.getBlockStateId({ x: 3, y: 5, z: 4 }), vanilla.oak_log.defaultState, 'the browser sees a stand-in, not an unrenderable id');

// The translation only reaches the browser if the hook on WorldView's emitter
// takes -- that is the one seam prismarine-viewer leaves.
const { WorldView } = createRequire(import.meta.url)('prismarine-viewer/viewer');
installStateTranslation(registry, vanilla);
const sent = [];
const view = new WorldView({}, 1, undefined, { emit: (event, payload) => sent.push([event, payload]), on: () => {} });
view.emitter.emit('blockUpdate', { stateId: vanilla_leaves_state + SHIFT });
assert.deepEqual(sent.at(-1), ['blockUpdate', { stateId: vanilla_leaves_state }], 'block updates go out translated');

console.log('ok: modded state ids are translated for the render view');
process.exit(0);
