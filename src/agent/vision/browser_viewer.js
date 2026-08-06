import settings from '../settings.js';
import prismarineViewer from 'prismarine-viewer';
import { vanilla_block_states } from '../../utils/mcdata.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { WorldView } = require('prismarine-viewer/viewer');
const BitArray = require('prismarine-chunk/src/pc/common/BitArray');
const mineflayerViewer = prismarineViewer.mineflayer;

// The prefix must match the path the mindserver proxies from, so the client's
// relative asset and socket.io paths resolve through the proxy.
export function viewerPrefix(name) {
    return '/viewer/' + encodeURIComponent(name);
}

// Stand-ins for modded blocks the browser has no model for, first match wins.
// ponytail: a handful of regexes, not a real material mapping -- the point is
// that a modded forest reads as a forest, not that the species is right.
const STAND_INS = [
    [/leaves|leaf/, 'oak_leaves'],
    [/log|stem|wood|trunk|branch/, 'oak_log'],
    [/planks/, 'oak_planks'],
    [/grass/, 'grass_block'],
    [/dirt|mud|soil|loam/, 'dirt'],
    [/sand/, 'sand'],
    [/water/, 'water'],
    [/lava|magma/, 'lava'],
    [/glass/, 'glass'],
];

function standIn(block, vanilla) {
    if (block.boundingBox === 'empty') return 0; // air
    for (const [pattern, name] of STAND_INS)
        if (pattern.test(block.name)) return vanilla[name].defaultState;
    return vanilla.stone.defaultState;
}

/**
 * Map every state id the bot's registry knows to the vanilla state id that
 * looks closest, indexed by state id (gaps stay 0, which is air).
 *
 * Mods do not just append blocks: they add block states to vanilla blocks too,
 * which shifts every vanilla state id after them. On Prominence 2 that moves
 * 920 vanilla blocks, so spruce leaves arrive as the id vanilla assigned to
 * birch leaves and the render view draws the wrong block nearly everywhere.
 */
export function buildStateMap(registry, vanilla) {
    if (!registry?.blocksArray || !vanilla) return null;
    const blocks = registry.blocksArray.filter(b => Number.isInteger(b.minStateId));
    const map = new Int32Array(blocks.reduce((max, b) => Math.max(max, b.maxStateId), 0) + 1);
    for (const block of blocks) {
        const known = vanilla[block.name];
        const fallback = known ? 0 : standIn(block, vanilla);
        for (let id = block.minStateId; id <= block.maxStateId; id++) {
            // A modded block state past the end of the vanilla range (a mod
            // adding a property to a vanilla block) clamps to the last one.
            map[id] = known
                ? known.minStateId + Math.min(id - block.minStateId, known.maxStateId - known.minStateId)
                : fallback;
        }
    }
    return map;
}

export function translateChunk(chunk_json, translate) {
    const column = JSON.parse(chunk_json);
    column.sections = column.sections.map(section_json => {
        const section = JSON.parse(section_json);
        const container = JSON.parse(section.data);
        if (container.type === 'single') {
            container.value = translate(container.value);
        } else if (container.type === 'indirect') {
            container.palette = container.palette.map(id => translate(id));
        } else if (container.type === 'direct') {
            // No palette to rewrite: every entry is a state id. Widths stay as
            // they are -- vanilla ids are never wider than the modded ones.
            const bits = BitArray.fromJson(container.data);
            for (let i = 0; i < bits.capacity; i++) bits.set(i, translate(bits.get(i)));
            container.data = bits.toJson();
        }
        section.data = JSON.stringify(container);
        return JSON.stringify(section);
    });
    return JSON.stringify(column);
}

function wrapEmitter(emitter, translate) {
    return new Proxy(emitter, {
        get(target, prop) {
            const value = Reflect.get(target, prop);
            if (typeof value !== 'function') return value;
            if (prop !== 'emit') return value.bind(target);
            return (event, payload, ...rest) => {
                if (event === 'loadChunk')
                    payload = { ...payload, chunk: translateChunk(payload.chunk, translate) };
                else if (event === 'blockUpdate')
                    payload = { ...payload, stateId: translate(payload.stateId) };
                return value.call(target, event, payload, ...rest);
            };
        }
    });
}

// prismarine-viewer serialises the bot's world with the bot's registry, but the
// browser decodes it with plain minecraft-data for the same version, so modded
// state ids land on whatever vanilla block happens to sit at that id. Translate
// on the way out.
//
// ponytail: hooked on WorldView's `emitter` property because that is the only
// seam prismarine-viewer leaves -- it constructs the WorldView itself, and both
// chunks and block updates go out through that one object.
let translation_installed = false;
export function installStateTranslation(registry, vanilla) {
    if (translation_installed) return;
    const map = buildStateMap(registry, vanilla);
    if (!map) {
        console.warn('[viewer] no registry to build a state map from, render view may show wrong blocks');
        return;
    }
    translation_installed = true;
    // An id past the end of the map is a block nothing here knows (a stale mod
    // data pack, mostly). Draw it as stone: a hole in the ground reads as a
    // rendering failure, a stone block just reads as boring.
    const unknown = vanilla.stone?.defaultState ?? 1;
    const translate = (id) => (id <= 0 ? 0 : id < map.length ? map[id] : unknown);
    Object.defineProperty(WorldView.prototype, 'emitter', {
        configurable: true,
        get() { return this._emitter; },
        set(emitter) { this._emitter = emitter === this ? emitter : wrapEmitter(emitter, translate); }
    });
}

export function addBrowserViewer(bot, count_id, name) {
    if (!settings.render_bot_view) return;
    installStateTranslation(bot.registry, vanilla_block_states);
    mineflayerViewer(bot, { port: 3000+count_id, firstPerson: true, prefix: viewerPrefix(name) });
}
