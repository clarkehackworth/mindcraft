import pf from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import * as mc from '../../utils/mcdata.js';


export function getNearestFreeSpace(bot, size=1, distance=8) {
    /**
     * Get the nearest empty space with solid blocks beneath it of the given size.
     * @param {Bot} bot - The bot to get the nearest free space for.
     * @param {number} size - The (size x size) of the space to find, default 1.
     * @param {number} distance - The maximum distance to search, default 8.
     * @returns {Vec3} - The south west corner position of the nearest free space.
     * @example
     * let position = world.getNearestFreeSpace(bot, 1, 8);
     **/
    let empty_pos = bot.findBlocks({
        matching: (block) => {
            return block && block.name == 'air';
        },
        maxDistance: distance,
        count: 1000
    });
    for (let i = 0; i < empty_pos.length; i++) {
        let empty = true;
        for (let x = 0; x < size; x++) {
            for (let z = 0; z < size; z++) {
                let top = bot.blockAt(empty_pos[i].offset(x, 0, z));
                let bottom = bot.blockAt(empty_pos[i].offset(x, -1, z));
                if (!top || !top.name == 'air' || !bottom || bottom.drops.length == 0 || !bottom.diggable) {
                    empty = false;
                    break;
                }
            }
            if (!empty) break;
        }
        if (empty) {
            return empty_pos[i];
        }
    }
}


export function getBlockAtPosition(bot, x=0, y=0, z=0) {
     /**
     * Get a block from the bot's relative position 
     * @param {Bot} bot - The bot to get the block for.
     * @param {number} x - The relative x offset to serach, default 0.
     * @param {number} y - The relative y offset to serach, default 0.
     * @param {number} y - The relative z offset to serach, default 0. 
     * @returns {Block} - The nearest block.
     * @example
     * let blockBelow = world.getBlockAtPosition(bot, 0, -1, 0);
     * let blockAbove = world.getBlockAtPosition(bot, 0, 2, 0); since minecraft position is at the feet
     **/
    let block = bot.blockAt(bot.entity.position.offset(x, y, z));
    if (!block) block = {name: 'air'};
       
    return block;
}


export function getSurroundingBlocks(bot) {
    /**
     * Get the surrounding blocks from the bot's environment.
     * @param {Bot} bot - The bot to get the block for.
     * @returns {string[]} - A list of block results as strings.
     * @example
     **/
    // Create a list of block position results that can be unpacked.
    let res = [];
    res.push(`Block Below: ${getBlockAtPosition(bot, 0, -1, 0).name}`);
    res.push(`Block at Legs: ${getBlockAtPosition(bot, 0, 0, 0).name}`);
    res.push(`Block at Head: ${getBlockAtPosition(bot, 0, 1, 0).name}`);

    return res;
}


export function getFirstBlockAboveHead(bot, ignore_types=null, distance=32) {
     /**
     * Searches a column from the bot's position for the first solid block above its head
     * @param {Bot} bot - The bot to get the block for.
     * @param {string[]} ignore_types - The names of the blocks to ignore.
     * @param {number} distance - The maximum distance to search, default 32.
     * @returns {string} - The fist block above head.
     * @example
     * let firstBlockAboveHead = world.getFirstBlockAboveHead(bot, null, 32);
     **/
    // if ignore_types is not a list, make it a list.
    let ignore_blocks = []; 
    if (ignore_types === null) ignore_blocks = ['air', 'cave_air'];
    else {
        if (!Array.isArray(ignore_types))
            ignore_types = [ignore_types];
        for(let ignore_type of ignore_types) {
            if (mc.getBlockId(ignore_type)) ignore_blocks.push(ignore_type);
        }
    }
    // The block above, stops when it finds a solid block .
    let block_above = {name: 'air'};
    let height = 0;
    for (let i = 0; i < distance; i++) {
        let block = bot.blockAt(bot.entity.position.offset(0, i+2, 0));
        if (!block) block = {name: 'air'};
        // Ignore and continue
        if (ignore_blocks.includes(block.name)) continue;
        // Defaults to any block
        block_above = block;
        height = i;
        break;
    }

    if (ignore_blocks.includes(block_above.name)) return 'none';
    
    return `${block_above.name} (${height} blocks up)`;
}


export function getNearestBlocks(bot, block_types=null, distance=8, count=10000) {
    /**
     * Get a list of the nearest blocks of the given types.
     * @param {Bot} bot - The bot to get the nearest block for.
     * @param {string[]} block_types - The names of the blocks to search for.
     * @param {number} distance - The maximum distance to search, default 16.
     * @param {number} count - The maximum number of blocks to find, default 10000.
     * @returns {Block[]} - The nearest blocks of the given type.
     * @example
     * let woodBlocks = world.getNearestBlocks(bot, ['oak_log', 'birch_log'], 16, 1);
     **/
    // if blocktypes is not a list, make it a list
    let block_ids = [];
    if (block_types === null) {
        block_ids = mc.getAllBlockIds(['air']);
    }
    else {
        if (!Array.isArray(block_types))
            block_types = [block_types];
        // Family names ("log", "coal_ore") expand here too, and unknown names
        // are dropped instead of pushing a null id into the scan.
        block_ids = getBlockIdsByName(bot, block_types);
    }
    // Integer state-id scan, not bot.findBlocks: see findBlockPositions.
    return findBlockPositions(bot, block_ids, distance, count)
        .map(pos => bot.blockAt(pos))
        .filter(block => block);
}

// Why this exists instead of bot.findBlocks:
//
// findBlocks skips a chunk section only when section.palette proves the block is
// absent, and it proves it by calling Block.fromStateId on every palette entry.
// Prominence 2 sends 20-bits-per-block sections (see patches/prismarine-chunk),
// which are DIRECT palettes -- section.palette is undefined -- so the check
// gives up and returns "might be in there" for every section. It then builds a
// full Block object, biome and block-entity lookup included, for all 4096 blocks
// of every section in range, just to read its type. A profile of the live agent
// put 56.9% of ALL its CPU in that loop.
//
// A block's identity is already an integer in the section data. So compare
// integers: state ids carry the block type, and a block's states are one
// contiguous [minStateId, maxStateId] range, so matching is a range check. That
// gives a real fast path for all three container shapes rather than just one:
//
//   SingleValueContainer  one comparison rejects the whole section (all the air)
//   IndirectPalette       compare the palette as integers, no Blocks built
//   DirectPalette         read 4096 ints instead of building 4096 Blocks
//
// Blocks are only constructed for the handful of positions actually returned.

// Past this many ranges, walking the list per block costs more than paying for
// a byte per state id up front. getNearestBlocks(bot, null) asks for every block
// in the registry, so both shapes are real.
const SMALL_TARGET_RANGES = 16;

// Above this, keeping the results sorted as we go costs more than one sort at
// the end. Also the ceiling on collectBlock's candidate list.
const BOUNDED_COUNT = 64;

export function getBlockIdsByName(bot, names) {
    /**
     * Resolve block names to type ids using the bot's own (modded) registry.
     * @param {Bot} bot
     * @param {string[]} names
     * @returns {number[]} - ids of the names that exist, unknown names dropped.
     */
    const by_name = bot.registry?.blocksByName ?? {};
    const ids = new Set();
    for (const name of names.flatMap(n => mc.expandBlockName(n))) {
        const id = by_name[name]?.id ?? mc.getBlockId(name);
        if (id !== null && id !== undefined) ids.add(id);
    }
    return [...ids];
}

function stateIdMatcher(bot, block_ids) {
    const blocks = bot.registry?.blocks ?? {};
    const ranges = [];   // flat [lo0, hi0, lo1, hi1, ...], no per-entry objects
    let max_state = 0;
    for (const id of block_ids) {
        const b = blocks[id];
        if (!b) continue;
        const lo = b.minStateId ?? b.defaultState;
        const hi = b.maxStateId ?? b.defaultState;
        if (lo === undefined || hi === undefined) continue;
        ranges.push(lo, hi);
        if (hi > max_state) max_state = hi;
    }
    if (ranges.length === 0) return null;
    if (ranges.length <= SMALL_TARGET_RANGES) {
        return (state) => {
            for (let i = 0; i < ranges.length; i += 2)
                if (state >= ranges[i] && state <= ranges[i + 1]) return true;
            return false;
        };
    }
    const table = new Uint8Array(max_state + 1);
    for (let i = 0; i < ranges.length; i += 2) table.fill(1, ranges[i], ranges[i + 1] + 1);
    return (state) => state <= max_state && table[state] === 1;
}

export function findBlockPositions(bot, block_ids, distance=16, count=1) {
    /**
     * Find positions of blocks of the given type ids without constructing Block
     * objects, nearest first.
     * @param {Bot} bot
     * @param {number[]} block_ids - block type ids to match.
     * @param {number} distance - maximum euclidean distance to search.
     * @param {number} count - maximum number of positions to return.
     * @returns {Vec3[]} - matching positions, nearest first, at most `count`.
     */
    const matches = stateIdMatcher(bot, block_ids);
    if (!matches) return [];

    const origin = bot.entity.position.floored();
    const max2 = distance * distance;
    const chunk_radius = Math.ceil(distance / 16);
    const ox = origin.x, oy = origin.y, oz = origin.z;
    const base_cx = Math.floor(ox / 16), base_cz = Math.floor(oz / 16);

    // Nearest column first, so the early exit below can stop while the far
    // columns are still unread.
    const columns = [];
    for (let dx = -chunk_radius; dx <= chunk_radius; dx++)
        for (let dz = -chunk_radius; dz <= chunk_radius; dz++)
            columns.push([base_cx + dx, base_cz + dz, dx * dx + dz * dz]);
    columns.sort((a, b) => a[2] - b[2]);

    // Small counts keep a sorted top-N, which also gives the pruning below its
    // cutoff. Big counts (getNearestBlocks(bot, null) asks for 10000) would turn
    // that insertion into an O(n^2) sort of the whole neighbourhood, so those
    // collect flat and sort once.
    const bounded = count <= BOUNDED_COUNT;
    const hits = [];
    let worst_d2 = Infinity;
    const offer = (x, y, z, d2) => {
        if (!bounded) { hits.push({ x, y, z, d2 }); return; }
        if (hits.length >= count && d2 >= worst_d2) return;
        let i = hits.length;
        while (i > 0 && hits[i - 1].d2 > d2) i--;
        hits.splice(i, 0, { x, y, z, d2 });
        if (hits.length > count) hits.pop();
        worst_d2 = hits.length >= count ? hits[hits.length - 1].d2 : Infinity;
    };

    for (const [cx, cz, _] of columns) {
        // Closest any block in this column could possibly be. Once that is
        // farther than the worst hit we already hold, no later column can help.
        if (bounded && hits.length >= count) {
            const nx = Math.max(cx * 16, Math.min(ox, cx * 16 + 15));
            const nz = Math.max(cz * 16, Math.min(oz, cz * 16 + 15));
            const dx = nx - ox, dz = nz - oz;
            if (dx * dx + dz * dz > worst_d2) break;
        }
        const column = bot.world?.getColumn?.(cx, cz);
        const sections = column?.sections;
        if (!sections) continue;
        const min_y = column.minY ?? 0;

        for (let si = 0; si < sections.length; si++) {
            const section = sections[si];
            if (!section) continue;
            const container = section.data;
            if (!container?.get) continue;
            const base_y = min_y + si * 16;
            if (base_y + 15 < oy - distance || base_y > oy + distance) continue;

            // Reject the whole section on integers where the shape allows it.
            if (container.palette) {
                let possible = false;
                for (const state of container.palette) { if (matches(state)) { possible = true; break; } }
                if (!possible) continue;
            }
            else if (container.value !== undefined) {
                if (!matches(container.value)) continue;
            }

            for (let y = 0; y < 16; y++) {
                const wy = base_y + y;
                const dy = wy - oy;
                if (dy * dy > max2) continue;
                for (let z = 0; z < 16; z++) {
                    const wz = cz * 16 + z;
                    const dz = wz - oz;
                    const dydz = dy * dy + dz * dz;
                    if (dydz > max2) continue;
                    for (let x = 0; x < 16; x++) {
                        const wx = cx * 16 + x;
                        const dx = wx - ox;
                        const d2 = dydz + dx * dx;
                        if (d2 > max2 || (bounded && hits.length >= count && d2 >= worst_d2)) continue;
                        if (matches(container.get((y << 8) | (z << 4) | x))) offer(wx, wy, wz, d2);
                    }
                }
            }
        }
    }
    if (!bounded) hits.sort((a, b) => a.d2 - b.d2);
    return hits.slice(0, count).map(h => new Vec3(h.x, h.y, h.z));
}

export function getNearestBlocksWhere(bot, predicate, distance=8, count=10000) {
    /**
     * Get a list of the nearest blocks that satisfy the given predicate.
     * @param {Bot} bot - The bot to get the nearest blocks for.
     * @param {function} predicate - The predicate to filter the blocks.
     * @param {number} distance - The maximum distance to search, default 16.
     * @param {number} count - The maximum number of blocks to find, default 10000.
     * @returns {Block[]} - The nearest blocks that satisfy the given predicate.
     * @example
     * let waterBlocks = world.getNearestBlocksWhere(bot, block => block.name === 'water', 16, 10);
     **/
    let positions = bot.findBlocks({matching: predicate, maxDistance: distance, count: count});
    let blocks = positions.map(position => bot.blockAt(position));
    return blocks;
}


export function getNearestBlock(bot, block_type, distance=16) {
     /**
     * Get the nearest block of the given type.
     * @param {Bot} bot - The bot to get the nearest block for.
     * @param {string} block_type - The name of the block to search for.
     * @param {number} distance - The maximum distance to search, default 16.
     * @returns {Block} - The nearest block of the given type.
     * @example
     * let coalBlock = world.getNearestBlock(bot, 'coal_ore', 16);
     **/
    let blocks = getNearestBlocks(bot, block_type, distance, 1);
    if (blocks.length > 0) {
        return blocks[0];
    }
    return null;
}


// Real max health from server attributes. On this server it is 52, not 20;
// reporting "N / 20" had the model judging every fight at 2.6x the real
// danger. Same lookup the policy layer uses (policy.js delegates here).
export function getMaxHealth(bot) {
    const attributes = bot?.entity?.attributes ?? {};
    for (const key of ['minecraft:generic.max_health', 'generic.maxHealth', 'generic.max_health', 'max_health']) {
        const value = attributes[key]?.value ?? attributes[key];
        if (typeof value === 'number' && value > 0) return value;
    }
    return 20;
}

export function getNearbyEntities(bot, maxDistance=16) {
    let entities = [];
    for (const entity of Object.values(bot.entities)) {
        const distance = entity.position.distanceTo(bot.entity.position);
        if (distance > maxDistance) continue;
        entities.push({ entity: entity, distance: distance });
    }
    entities.sort((a, b) => a.distance - b.distance);
    let res = [];
    for (let i = 0; i < entities.length; i++) {
        res.push(entities[i].entity);
    }
    return res;
}

export function getNearestEntityWhere(bot, predicate, maxDistance=16) {
    return bot.nearestEntity(entity => predicate(entity) && bot.entity.position.distanceTo(entity.position) < maxDistance);
}


export function getNearbyPlayers(bot, maxDistance) {
    if (maxDistance == null) maxDistance = 16;
    let players = [];
    for (const entity of Object.values(bot.entities)) {
        const distance = entity.position.distanceTo(bot.entity.position);
        if (distance > maxDistance) continue;
        if (entity.type == 'player' && entity.username != bot.username) {
            players.push({ entity: entity, distance: distance });
        } 
    }
    players.sort((a, b) => a.distance - b.distance);
    let res = [];
    for (let i = 0; i < players.length; i++) {
        res.push(players[i].entity);
    }
    return res;
}

// Helper function to get villager profession from metadata
export function getVillagerProfession(entity) {
    // Villager profession mapping based on metadata
    const professions = {
        0: 'Unemployed',
        1: 'Armorer',
        2: 'Butcher', 
        3: 'Cartographer',
        4: 'Cleric',
        5: 'Farmer',
        6: 'Fisherman',
        7: 'Fletcher',
        8: 'Leatherworker',
        9: 'Librarian',
        10: 'Mason',
        11: 'Nitwit',
        12: 'Shepherd',
        13: 'Toolsmith',
        14: 'Weaponsmith'
    };
    
    if (entity.metadata && entity.metadata[18]) {
        // Check if metadata[18] is an object with villagerProfession property
        if (typeof entity.metadata[18] === 'object' && entity.metadata[18].villagerProfession !== undefined) {
            const professionId = entity.metadata[18].villagerProfession;
            const level = entity.metadata[18].level || 1;
            const professionName = professions[professionId] || 'Unknown';
            return `${professionName} L${level}`;
        }
        // Fallback for direct profession ID
        else if (typeof entity.metadata[18] === 'number') {
            const professionId = entity.metadata[18];
            return professions[professionId] || 'Unknown';
        }
    }
    
    // If we can't determine profession but it's an adult villager
    if (entity.metadata && entity.metadata[16] !== 1) { // Not a baby
        return 'Adult';
    }
    
    return 'Unknown';
}


export function getInventoryCounts(bot) {
    /**
     * Get an object representing the bot's inventory.
     * @param {Bot} bot - The bot to get the inventory for.
     * @returns {object} - An object with item names as keys and counts as values.
     * @example
     * let inventory = world.getInventoryCounts(bot);
     * let oakLogCount = inventory['oak_log'];
     * let hasWoodenPickaxe = inventory['wooden_pickaxe'] > 0;
     **/
    let inventory = {};
    for (const slot of bot.inventory.slots) {
        if (slot != null && slot.name) {
            if (inventory[slot.name] == null) {
                inventory[slot.name] = 0;
            }
            inventory[slot.name] += slot.count;
        }
    }
    return inventory;
}


export function getCraftableItems(bot) {
    /**
     * Get a list of all items that can be crafted with the bot's current inventory.
     * @param {Bot} bot - The bot to get the craftable items for.
     * @returns {string[]} - A list of all items that can be crafted.
     * @example
     * let craftableItems = world.getCraftableItems(bot);
     **/
    let table = getNearestBlock(bot, 'crafting_table');
    if (!table) {
        for (const item of bot.inventory.items()) {
            if (item != null && item.name === 'crafting_table') {
                table = item;
                break;
            }
        }
    }
    // recipesFor is the cheap candidate generator, but on a modded server it
    // waves through recipes whose ingredients the mod dump left unresolvable --
    // Andy was told he could craft coal_ore, id_regex and sixteen table cloths
    // while holding four planks. Re-check each candidate against the inventory
    // using our own recipe data, which is a few dozen checks, not 22000.
    const counts = getInventoryCounts(bot);
    // lookahead off: every variant is scanned anyway, so its only job -- nudging
    // the ranking -- is wasted work here.
    const affordable = (name) => (mc.getItemCraftingRecipes(name, counts, false) ?? [])
        .some(([ingredients]) => Object.entries(ingredients)
            .every(([item, need]) => (counts[item] ?? 0) >= need));
    let res = [];
    for (const item of mc.getAllItems()) {
        let recipes = bot.recipesFor(item.id, null, 1, table);
        if (recipes.length > 0 && affordable(item.name))
            res.push(item.name);
    }
    return res;
}


export function getPosition(bot) {
    /**
     * Get your position in the world (Note that y is vertical).
     * @param {Bot} bot - The bot to get the position for.
     * @returns {Vec3} - An object with x, y, and x attributes representing the position of the bot.
     * @example
     * let position = world.getPosition(bot);
     * let x = position.x;
     **/
    return bot.entity.position;
}


export function getNearbyEntityTypes(bot) {
    /**
     * Get a list of all nearby mob types.
     * @param {Bot} bot - The bot to get nearby mobs for.
     * @returns {string[]} - A list of all nearby mobs.
     * @example
     * let mobs = world.getNearbyEntityTypes(bot);
     **/
    let mobs = getNearbyEntities(bot, 16);
    let found = [];
    for (let i = 0; i < mobs.length; i++) {
        if (!found.includes(mobs[i].name)) {
            found.push(mobs[i].name);
        }
    }
    return found;
}

export function isEntityType(name) {
    /**
     * Check if a given name is a valid entity type.
     * @param {string} name - The name of the entity type to check.
     * @returns {boolean} - True if the name is a valid entity type, false otherwise.
     */
    return mc.getEntityId(name) !== null;
}

export function getNearbyPlayerNames(bot) {
    /**
     * Get a list of all nearby player names.
     * @param {Bot} bot - The bot to get nearby players for.
     * @returns {string[]} - A list of all nearby players.
     * @example
     * let players = world.getNearbyPlayerNames(bot);
     **/
    let players = getNearbyPlayers(bot, 64);
    let found = [];
    for (let i = 0; i < players.length; i++) {
        if (!found.includes(players[i].username) && players[i].username != bot.username) {
            found.push(players[i].username);
        }
    }
    return found;
}


export function getNearbyBlockTypes(bot, distance=16) {
    /**
     * Get a list of all nearby block names.
     * @param {Bot} bot - The bot to get nearby blocks for.
     * @param {number} distance - The maximum distance to search, default 16.
     * @returns {string[]} - A list of all nearby blocks.
     * @example
     * let blocks = world.getNearbyBlockTypes(bot);
     **/
    let blocks = getNearestBlocks(bot, null, distance);
    let found = [];
    for (let i = 0; i < blocks.length; i++) {
        if (!found.includes(blocks[i].name)) {
            found.push(blocks[i].name);
        }
    }
    return found;
}

export async function isClearPath(bot, target) {
    /**
     * Check if there is a path to the target that requires no digging or placing blocks.
     * @param {Bot} bot - The bot to get the path for.
     * @param {Entity} target - The target to path to.
     * @returns {boolean} - True if there is a clear path, false otherwise.
     */
    let movements = new pf.Movements(bot);
    movements.canDig = false;
    movements.canPlaceOn = false;
    movements.canOpenDoors = false;
    let goal = new pf.goals.GoalNear(target.position.x, target.position.y, target.position.z, 1);
    let path = await bot.pathfinder.getPathTo(movements, goal, 100);
    return path.status === 'success';
}

export function shouldPlaceTorch(bot) {
    if (!bot.modes.isOn('torch_placing') || bot.interrupt_code) return false;
    const pos = getPosition(bot);
    // TODO: check light level instead of nearby torches, block.light is broken
    let nearest_torch = getNearestBlock(bot, 'torch', 6);
    if (!nearest_torch)
        nearest_torch = getNearestBlock(bot, 'wall_torch', 6);
    if (!nearest_torch) {
        const block = bot.blockAt(pos);
        let has_torch = bot.inventory.findInventoryItem('torch');
        return has_torch && block?.name === 'air';
    }
    return false;
}

export function getBiomeName(bot, pos = null) {
    /**
     * Get the name of the biome the bot is in, or at a given loaded position.
     * @param {Bot} bot - The bot to get the biome for.
     * @param {Vec3} [pos] - Position to sample. Defaults to the bot's own. Only
     *   meaningful for loaded chunks; unloaded ones report whatever the client
     *   has cached, so this is for where the bot has been, not where it might go.
     * @returns {string} - The name of the biome.
     * @example
     * let biome = world.getBiomeName(bot);
     **/
    const biomeId = bot.world.getBiome(pos ?? bot.entity.position);
    // Prefer the registry the server sent us over minecraft-data's static
    // table: mineflayer populates bot.registry from the login packet's
    // dimension codec, so it knows about modded biomes that minecraft-data
    // has never heard of. Fall back to static data, then to the raw id.
    const biome = bot.registry?.biomes?.[biomeId] ?? mc.getAllBiomes()[biomeId];
    return biome?.name ?? `biome_${biomeId}`;
}

export const NIGHT_START = 13000;

export function isNight(bot, lead = 0) {
    /**
     * Whether hostile mobs spawn on the surface right now. The single source of
     * truth for day vs night -- anything that reports or reacts to the time of
     * day goes through here, so the bot cannot tell itself two different stories.
     * @param {Bot} bot, reference to the minecraft bot.
     * @param {number} lead, ticks before nightfall to start saying yes. Walking
     * home takes time, so a rule that wants to be indoors BY nightfall has to
     * leave before it. Everything else passes 0 and sees the old behaviour.
     * @returns {boolean} true if it is night.
     **/
    // Night runs 13000 to 24000, not 13000 to 23000: sunrise starts at 23000 but
    // it is still dark until the day rolls over. The old upper bound left a
    // 1000-tick hole at dawn where this said day while !stats said night, and
    // the bot was told it was night while its own policy rules disagreed.
    //
    // Ticks, not mineflayer's bot.time.isDay, because isDay cannot express a
    // lead. It is not a second opinion: mineflayer computes isDay as
    // `timeOfDay >= 0 && timeOfDay < 13000` (lib/plugins/time.js), which is this
    // same line, so nothing changes at lead 0.
    const t = bot.time?.timeOfDay;
    if (t == null) return bot.time?.isDay === false;
    if (t < 0) return true; // fixed-time servers send a negative tick count
    return t >= NIGHT_START - lead;
}
