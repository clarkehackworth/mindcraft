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
    // A pack dumped after the tag fix says outright what each slot accepts, so
    // expansion is exact. Older packs only ever named one item per slot, and
    // the plank heuristic is the best guess available for those.
    let expanded = 0;
    if (packs.length) {
        expanded = expandChoiceRecipes(registry);
        if (!expanded) expanded = expandPlankRecipes(registry);
    }
    if (packs.length) {
        console.log(`loaded ${packs.length} mod data pack(s): ${added_blocks} blocks, ${added_items} items, ${added_recipes} recipes` +
            (expanded ? `, +${expanded} plank variants` : ''));
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
 * Turn slots that accept a whole tag into concrete recipes.
 *
 * The dumper writes an ingredient slot as {"any": [ids...]} when more than one
 * item fits it -- that is the #minecraft:planks tag and its kind, listed rather
 * than guessed. mineflayer only understands single-item slots, so the choices
 * are resolved here, before anything reads registry.recipes.
 *
 * Slots that accept the SAME set move together: a pickaxe's three plank slots
 * all become pine, all become oak, and so on. Minecraft would also accept one
 * of each, but the bot has no reason to want that and enumerating it is the
 * combinatorial explosion the dumper's old comment rightly refused -- 70 wood
 * types over 3 slots is 70 recipes this way and 343,000 the other.
 *
 * ponytail: capped per recipe. A pathological tag (every dye, every potion)
 * would otherwise bloat the registry that mineflayer linear-scans on every
 * craft. Raise MAX_VARIANTS if a real recipe gets truncated.
 */
const MAX_VARIANTS = 128;

export function expandChoiceRecipes(registry) {
    if (!registry.recipes) return 0;
    const key = (slot) => JSON.stringify(slot.any);
    const pick = (shape, chosen) => shape.map(cell => {
        if (Array.isArray(cell)) return pick(cell, chosen);
        if (cell && typeof cell === 'object' && cell.any)
            return chosen[key(cell)] ?? cell.any[0];
        return cell;
    });

    let added = 0;
    for (const variants of Object.values(registry.recipes)) {
        const grown = [];
        let expanded_any = false;
        for (const variant of variants) {
            const shape = variant.inShape ?? variant.ingredients;
            // Distinct choice-sets in this recipe, each expanded independently
            // against the others' defaults.
            const sets = new Map();
            const walk = (s) => s.forEach(cell => Array.isArray(cell) ? walk(cell)
                : (cell && typeof cell === 'object' && cell.any && sets.set(key(cell), cell.any)));
            if (shape) walk(shape);
            // A variant with nothing to choose is carried through untouched --
            // dropping it would delete every single-item recipe in the pack.
            if (!sets.size) { grown.push(variant); continue; }
            expanded_any = true;
            for (const [k, options] of sets) {
                for (const option of options.slice(0, MAX_VARIANTS)) {
                    const chosen = { [k]: option };
                    const clone = { ...variant };
                    if (variant.inShape) clone.inShape = pick(variant.inShape, chosen);
                    else clone.ingredients = pick(variant.ingredients, chosen);
                    grown.push(clone);
                }
            }
        }
        if (expanded_any) {
            // The originals still carry {"any": ...} cells mineflayer cannot
            // read, so they are replaced rather than appended to.
            added += grown.length - variants.length;
            variants.length = 0;
            variants.push(...grown);
        }
    }
    return added;
}

/**
 * Put back the plank variants the pack's recipe dump collapsed.
 *
 * Minecraft's wooden recipes take the #minecraft:planks TAG, and every mod that
 * adds a wood registers its planks into it. The dump has no tags -- it lists
 * each tag recipe once with a single representative item, always
 * minecraft:oak_planks. So on Prominence 2 the registry claims a wooden_pickaxe
 * needs oak specifically, and since mineflayer's recipesFor() reads the same
 * table, Andy could neither plan nor craft one while standing in a frozen pine
 * taiga holding 20 pine_planks. There is no oak in that biome; he spent days on
 * it and wrote "pine unusable" into his own memory.
 *
 * A plank is any <ns>:<wood>_planks whose <ns>:<wood>_log or <ns>:<wood>_wood
 * also exists. That check is what keeps the decorative lookalikes out: the
 * chipped mod alone adds ~40 items like chipped:versailles_spruce_planks, which
 * are NOT in the tag and would produce recipes the server rejects.
 *
 * ponytail: planks only, because planks are the ones that blocked the bot. The
 * same collapse affects every tag recipe (wool, stone, logs). Generalize by
 * dumping the server's tag table into the pack -- that is the real fix, and it
 * belongs in whatever generates the pack, not here.
 */
export function expandPlankRecipes(registry) {
    if (!registry.recipes || !registry.itemsByName) return 0;
    const planks = new Set();
    for (const name of Object.keys(registry.itemsByName)) {
        const wood = /^(?:(.*):)?(.+)_planks$/.exec(name);
        if (!wood) continue;
        const [, ns, kind] = wood;
        const prefix = ns ? `${ns}:` : '';
        if (registry.itemsByName[`${prefix}${kind}_log`] || registry.itemsByName[`${prefix}${kind}_wood`])
            planks.add(registry.itemsByName[name].id);
    }
    if (planks.size < 2) return 0;

    // Ingredients are ids, nested one level in inShape, and sometimes objects
    // ({id, count}) rather than bare numbers.
    const idOf = cell => (cell && typeof cell === 'object' && !Array.isArray(cell)) ? cell.id : cell;
    const flattenIds = (shape) => shape.flatMap(cell =>
        Array.isArray(cell) ? flattenIds(cell) : [idOf(cell)]);
    const substitute = (shape, from, to) => shape.map(cell => {
        if (Array.isArray(cell)) return substitute(cell, from, to);
        if (cell && typeof cell === 'object') return idOf(cell) === from ? { ...cell, id: to } : cell;
        return cell === from ? to : cell;
    });
    let added = 0;
    for (const [result_id, variants] of Object.entries(registry.recipes)) {
        // A recipe that PRODUCES planks stays put -- expanding it would claim a
        // pine log crafts oak planks.
        if (planks.has(Number(result_id))) continue;
        const grown = [];
        for (const variant of variants) {
            const shape = variant.inShape ?? variant.ingredients;
            if (!shape) continue;
            const ids = new Set(flattenIds(shape));
            const used = [...planks].filter(id => ids.has(id));
            // One plank type per recipe, or substitution is ambiguous.
            if (used.length !== 1) continue;
            for (const plank of planks) {
                if (plank === used[0]) continue;
                const clone = { ...variant };
                if (variant.inShape) clone.inShape = substitute(variant.inShape, used[0], plank);
                else clone.ingredients = substitute(variant.ingredients, used[0], plank);
                grown.push(clone);
            }
        }
        if (grown.length) {
            registry.recipes[result_id] = [...variants, ...grown];
            added += grown.length;
        }
    }
    return added;
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
