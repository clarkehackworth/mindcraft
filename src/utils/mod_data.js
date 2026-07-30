import fs from 'fs';
import path from 'path';

/**
 * Mod data packs: block/item/entity registries dumped from a modded server.
 *
 * minecraft-data only knows vanilla, so on a modded server every modded block
 * arrives with a block state id nothing can resolve, and mineflayer reports it
 * as nameless, shapeless, undiggable air. A pack is the missing half of the
 * registry, dumped from the server itself by tools/mod-data-dumper, and merged
 * into the bot's registry at login.
 *
 * A pack is a JSON file shaped like minecraft-data:
 *   { minecraft_version, blocks: [...], items: [...], entities: [...] }
 * Block entries carry the state id ranges the server actually assigned, which
 * is the part no static dataset can know.
 */

const FULL_CUBE = [[0, 0, 0, 1, 1, 1]];

/**
 * Read packs from a directory of .json files, a single file, or a list of either.
 * Missing paths are skipped: running vanilla with mod_data configured is not an error.
 */
export function loadModDataPacks(sources) {
    if (!sources) return [];
    if (!Array.isArray(sources)) sources = [sources];
    const packs = [];
    for (const source of sources) {
        for (const file of resolvePackFiles(source)) {
            try {
                const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (!pack.blocks?.length) {
                    console.warn(`mod data pack ${file} has no blocks, skipping`);
                    continue;
                }
                pack.file = file;
                packs.push(pack);
            } catch (err) {
                console.error(`failed to read mod data pack ${file}: ${err.message}`);
            }
        }
    }
    return packs;
}

function resolvePackFiles(source) {
    if (!fs.existsSync(source)) return [];
    if (!fs.statSync(source).isDirectory()) return [source];
    return fs.readdirSync(source)
        .filter(name => name.endsWith('.json'))
        .map(name => path.join(source, name));
}

/**
 * Merge packs into a prismarine-registry (bot.registry).
 *
 * Modded blocks and items are appended past the end of the vanilla registries,
 * so their ids never collide with vanilla and can be inserted as-is. Vanilla
 * entries are left alone except for their state id ranges, which a modpack can
 * in principle shift; if that has happened the ranges are corrected in place
 * rather than replacing minecraft-data's better vanilla data.
 */
export function applyModDataPacks(registry, packs) {
    let added_blocks = 0, added_items = 0, moved_vanilla = 0, added_recipes = 0;
    for (const pack of packs) {
        if (pack.minecraft_version && registry.version?.minecraftVersion &&
            pack.minecraft_version !== registry.version.minecraftVersion) {
            console.warn(`mod data pack ${pack.file} is for ${pack.minecraft_version}, server is ${registry.version.minecraftVersion}`);
        }
        const shapes = pack.shapes || [];
        for (const block of pack.blocks) {
            if (addBlock(registry, block, shapes)) added_blocks++;
            else if (fixVanillaStateIds(registry, block, shapes)) moved_vanilla++;
        }
        for (const item of pack.items || []) {
            if (addItem(registry, item)) added_items++;
        }
        for (const entity of pack.entities || []) {
            addEntity(registry, entity);
        }
        added_recipes += addRecipes(registry, pack.recipes);
    }
    if (packs.length) {
        console.log(`loaded ${packs.length} mod data pack(s): ${added_blocks} blocks, ${added_items} items, ${added_recipes} recipes`);
        if (moved_vanilla) {
            console.log(`corrected block state ids for ${moved_vanilla} vanilla blocks`);
        }
    }
    return { added_blocks, added_items, moved_vanilla, added_recipes };
}

/**
 * The server's recipe list wins for anything it defines: modpacks rewrite
 * vanilla recipes as freely as they add their own.
 */
function addRecipes(registry, recipes) {
    if (!recipes || !registry.recipes) return 0;
    let count = 0;
    for (const [result_id, variants] of Object.entries(recipes)) {
        registry.recipes[result_id] = variants;
        count += variants.length;
    }
    return count;
}

/**
 * Expand the pack's shape table back into the per-state collision boxes
 * prismarine-block and the physics engine read. The table exists because a
 * modpack has hundreds of thousands of block states and a few thousand
 * distinct shapes between them.
 */
function expandShapes(dumped, shapes) {
    if (!dumped.stateShapeIds || !shapes.length) return null;
    return dumped.stateShapeIds.map(id => shapes[id] || FULL_CUBE);
}

function addBlock(registry, dumped, shapes) {
    const name = stripNamespace(dumped.name);
    if (isVanilla(dumped.name)) return false;

    const state_shapes = expandShapes(dumped, shapes);
    const block = {
        ...dumped,
        name,
        mod: true,
        shapes: state_shapes ? state_shapes[dumped.defaultState - dumped.minStateId]
            : (dumped.boundingBox === 'empty' ? [] : FULL_CUBE),
        drops: dumped.drops || [],
    };
    // Pathfinder plans routes from boundingBox while the physics engine collides
    // with shapes, so the two disagreeing is worse than either being wrong: the
    // bot walks confidently into a wall it believes is air. Blocks with a
    // dynamic shape report boundingBox 'empty' while colliding like a full cube
    // -- TreeChop's chopped_log, left behind by every tree the bot chops, is
    // one. The shapes are the truth; a block that collides in any state is solid.
    if (state_shapes) {
        block.boundingBox = state_shapes.some(shape => shape.length) ? 'block' : 'empty';
    }
    // Per-state shapes only if the pack has them; an empty stateShapes array
    // would leave prismarine-block with no shape at all for the block.
    if (state_shapes) block.stateShapes = state_shapes;
    delete block.stateShapeIds;

    registry.blocks[block.id] = block;
    // Always reachable by full name; the short name only when nothing vanilla
    // (or an earlier pack) already claims it.
    registry.blocksByName[dumped.name] = block;
    if (!(name in registry.blocksByName)) registry.blocksByName[name] = block;
    registry.blocksArray?.push(block);
    indexStates(registry, block);
    return true;
}

/**
 * Put a vanilla block back where the modded server actually put it.
 *
 * Mods don't only append: one that adds a property to vanilla leaves doubles
 * their state count, and every vanilla block registered after them slides up
 * the palette. Unfixed, the bot reads spruce leaves as birch leaves and so on
 * for most of the vanilla registry -- which is why even vanilla trees behave
 * strangely on a heavily modded server.
 */
function fixVanillaStateIds(registry, dumped, shapes) {
    const known = registry.blocksByName[stripNamespace(dumped.name)];
    if (!known || (known.minStateId === dumped.minStateId && known.maxStateId === dumped.maxStateId)) return false;
    // A different number of states means a mod changed the block itself, so its
    // properties and shapes come from the server too.
    if (known.maxStateId - known.minStateId !== dumped.maxStateId - dumped.minStateId) {
        known.states = dumped.states;
        const state_shapes = expandShapes(dumped, shapes);
        if (state_shapes) known.stateShapes = state_shapes;
        else delete known.stateShapes;
    }
    known.minStateId = dumped.minStateId;
    known.maxStateId = dumped.maxStateId;
    known.defaultState = dumped.defaultState;
    indexStates(registry, known);
    return true;
}

function indexStates(registry, block) {
    for (let state_id = block.minStateId; state_id <= block.maxStateId; state_id++) {
        registry.blocksByStateId[state_id] = block;
    }
}

function addItem(registry, dumped) {
    if (isVanilla(dumped.name)) return false;
    const name = stripNamespace(dumped.name);
    const item = { ...dumped, name, mod: true, stackSize: dumped.stackSize ?? 64 };
    registry.items[item.id] = item;
    registry.itemsByName[dumped.name] = item;
    if (!(name in registry.itemsByName)) registry.itemsByName[name] = item;
    registry.itemsArray?.push(item);
    return true;
}

/**
 * mineflayer exposes the entity's `type`, and mindcraft attacks anything typed
 * 'mob'. That has to be right: the server kicks a client that swings at an
 * item, an experience orb or an arrow ("invalid_entity_attacked"), and mods
 * register projectiles under living mob categories often enough that the
 * category alone is not safe to trust -- Frostiful's frost_tipped_arrow is a
 * MobCategory.CREATURE. The dump answers it from the entity class instead.
 *
 * Packs generated before that flag existed leave every modded entity 'other':
 * a bot that ignores modded mobs is better than one that gets kicked.
 */
function addEntity(registry, dumped) {
    if (isVanilla(dumped.name)) return false;
    const name = stripNamespace(dumped.name);
    const entity = { ...dumped, name, type: dumped.attackable ? 'mob' : 'other' };
    registry.entities[entity.id] = entity;
    registry.entitiesByName[dumped.name] = entity;
    if (!(name in registry.entitiesByName)) registry.entitiesByName[name] = entity;
    registry.entitiesArray?.push(entity);
    return true;
}

function isVanilla(name) {
    return !name.includes(':') || name.startsWith('minecraft:');
}

function stripNamespace(name) {
    return name.includes(':') ? name.split(':')[1] : name;
}
