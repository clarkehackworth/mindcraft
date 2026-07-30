import settings from '../agent/settings.js';
import { loadModDataPacks, applyModDataPacks } from './mod_data.js';
import { createBot } from 'mineflayer';
import prismarine_items from 'prismarine-item';
import { pathfinder } from 'mineflayer-pathfinder';
import { plugin as pvp } from 'mineflayer-pvp';
import { plugin as collectblock } from 'mineflayer-collectblock';
import { plugin as autoEat } from 'mineflayer-auto-eat';
import plugin from 'mineflayer-armor-manager';
const armorManager = plugin;
let mc_version = settings.minecraft_version;
let mcdata = null;
let Item = null;

// How often "summary" packet_error_logging emits a rollup count.
const PACKET_ERROR_ROLLUP_MINS = 5;

// Mods that re-skin a vanilla station register their own MenuType, which lands
// past the vanilla protocol ids prismarine-windows knows. It then has no layout
// for the window and returns null, which mineflayer dereferences -- killing the
// agent process. The layouts are identical though, so the window is recovered
// by its title: VisualWorkbench (in Prominence 2) sends the crafting table's
// own "container.crafting" title, and craftRecipe works once it resolves.
// Keyed by the title's translate key -> prismarine-windows layout key, which
// createWindow accepts by name, so this needs no per-version id arithmetic.
// Add an entry here if another re-skinned station shows up in the
// "declining unsupported window type" warning.
const WINDOW_TITLE_TO_TYPE = {
    'container.crafting': 'minecraft:crafting',
};

/**
 * Rewrite a modded menu type back to the vanilla layout its title identifies.
 * Mutates the packet in place; leaves it alone when the title is unrecognized.
 */
function remapModdedWindow(bot, packet) {
    let title = packet.windowTitle;
    if (typeof title === 'string') {
        // 1.20.1 sends the title as a JSON chat component string; older
        // versions and some mods send a plain string that won't parse.
        try { title = JSON.parse(title); } catch { /* not JSON */ }
    }
    const type = WINDOW_TITLE_TO_TYPE[title?.translate];
    if (!type || packet.inventoryType === type) return;
    if (!bot._remapped_window_types?.has(type)) {
        (bot._remapped_window_types ??= new Set()).add(type);
        console.warn(`[mcdata] window type ${packet.inventoryType} ("${title.translate}") is a modded re-skin, treating it as ${type}`);
    }
    packet.inventoryType = type;
}

/**
 * @typedef {string} ItemName
 * @typedef {string} BlockName
*/

export const WOOD_TYPES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'];
export const MATCHING_WOOD_BLOCKS = [
    'log',
    'planks',
    'sign',
    'boat',
    'fence_gate',
    'door',
    'fence',
    'slab',
    'stairs',
    'button',
    'pressure_plate',
    'trapdoor'
]
export const WOOL_COLORS = [
    'white',
    'orange',
    'magenta',
    'light_blue',
    'yellow',
    'lime',
    'pink',
    'gray',
    'light_gray',
    'cyan',
    'purple',
    'blue',
    'brown',
    'green',
    'red',
    'black'
]


export function initBot(username) {
    const options = {
        username: username,
        host: settings.host,
        port: settings.port,
        auth: settings.auth,
        version: mc_version,
        checkTimeoutInterval: 60000,  // 60s keep-alive check (default 30s) — reduces disconnects on slow servers
    }
    if (!mc_version || mc_version === "auto") {
        delete options.version;
    }

    const bot = createBot(options);

    // Throttle position packets to avoid kicks on Paper/Spigot servers
    // Paper enforces stricter packet rate limits than vanilla, causing ECONNRESET
    // when mineflayer sends position updates faster than 50ms apart
    let lastPositionUpdate = 0;
    let pendingPositionPacket = null;
    const POSITION_THROTTLE_MS = 50;
    // A move packet with NaN in any field is an instant kick: the server checks
    // for non-finite values before anything else and drops the connection with
    // "Invalid move player packet received"
    // (multiplayer.disconnect.invalid_player_movement). It is not the
    // moved-too-quickly check, which only warns.
    //
    // The usual source is generated code doing bot.lookAt(new Vec3(block.x,
    // block.y, block.z)) -- a prismarine Block keeps its coords in .position, so
    // block.x is undefined, the Vec3 is all-NaN, and lookAt's atan2 hands NaN to
    // bot.entity.yaw. Every later packet then carries the NaN too, so this
    // repairs bot.entity rather than only the packet: dropping alone would leave
    // the bot silently frozen until the server timed it out.
    const lastGoodMove = {};
    const MOVE_FIELDS = ['x', 'y', 'z', 'yaw', 'pitch'];
    const originalWrite = bot._client.write.bind(bot._client);
    bot._client.write = function(name, data) {
        if (name === 'position' || name === 'position_look' || name === 'look') {
            for (const f of MOVE_FIELDS) {
                if (data?.[f] === undefined) continue;
                if (Number.isFinite(data[f])) {
                    lastGoodMove[f] = data[f];
                    continue;
                }
                if (lastGoodMove[f] === undefined) return; // nothing sane to fall back to yet
                console.warn(`[mcdata] move packet field ${f} was ${data[f]}, restoring ${lastGoodMove[f]} (bad Vec3 in generated code?)`);
                data[f] = lastGoodMove[f];
                if (f === 'x' || f === 'y' || f === 'z') bot.entity.position[f] = lastGoodMove[f];
                else bot.entity[f] = lastGoodMove[f];
            }
            const now = Date.now();
            if (now - lastPositionUpdate < POSITION_THROTTLE_MS) {
                // Queue this packet so the last position update is never lost
                if (!pendingPositionPacket) {
                    pendingPositionPacket = setTimeout(() => {
                        pendingPositionPacket = null;
                        lastPositionUpdate = Date.now();
                        originalWrite(name, data);
                    }, POSITION_THROTTLE_MS - (now - lastPositionUpdate));
                }
                return;
            }
            lastPositionUpdate = now;
            if (pendingPositionPacket) {
                clearTimeout(pendingPositionPacket);
                pendingPositionPacket = null;
            }
        }
        return originalWrite(name, data);
    };

    // Packets the protocol library cannot parse.
    //
    // Paper sends a few (scoreboard, resource_pack, custom_payload); modded
    // servers send many, because mods add packet ids and payloads that have no
    // vanilla schema and so can never be parsed no matter what we do.
    //
    // Dropping them is the correct handling rather than a workaround: framing
    // is length-prefixed, so an unparseable body cannot desync the stream, and
    // node-minecraft-protocol re-pipes the deserializer after every error. They
    // are only fatal because the error propagates. What is worth configuring is
    // how loudly we report them.
    //
    // Caveat worth knowing: client.hideErrors is read by both setSerializer()
    // and createDecompressor(), so "summary" and "off" also silence
    // decompression warnings, which would signal genuine stream corruption
    // rather than a mod. That is the diagnostic traded for the quiet.
    const packet_error_logging = settings.packet_error_logging ?? 'full';
    if (packet_error_logging !== 'full') {
        // Stops protodef logging each error itself. The error is still emitted,
        // so the handler below still sees and counts it.
        bot._client.hideErrors = true;
    }

    let suppressed_packet_errors = 0;
    let logged_first_packet_error = false;
    const originalEmit = bot._client.emit.bind(bot._client);
    bot._client.emit = function(event, ...args) {
        if (event === 'error' && args[0]) {
            const err = args[0];
            const errStr = err instanceof Error ? err.message : String(err);
            // 'PartialReadError' is the error's name, not part of its message
            // -- node-minecraft-protocol rewrites the message to "Read error
            // for <field> : ..." (or "Parse error for ..." once client.js has
            // annotated it), so matching the message alone never fires.
            if (errStr.includes('PartialReadError')
                || err?.name === 'PartialReadError'
                || errStr.includes('Read error for')
                || errStr.includes('Parse error for')) {
                suppressed_packet_errors++;
                if (packet_error_logging === 'summary' && !logged_first_packet_error) {
                    logged_first_packet_error = true;
                    console.warn('[mcdata] Unparseable packet, most likely a modded packet with no vanilla schema:', errStr.substring(0, 160));
                    console.warn(`[mcdata] Further packet errors will be summarized every ${PACKET_ERROR_ROLLUP_MINS}m. Set packet_error_logging to "full" for detail.`);
                }
                // Swallowed either way: an unparseable packet is not actionable,
                // and letting it through kills the agent process.
                // In "full" mode protodef has already logged the detail, so
                // logging again here would only duplicate it.
                return true;
            }
        }
        if (event === 'open_window' && args[0]) {
            remapModdedWindow(bot, args[0]);
            // A modded menu type has no vanilla window layout, and the 1.20.1
            // open_window packet carries no slot count, so prismarine-windows
            // returns null and mineflayer dereferences it -- killing the agent
            // process. If the remap above didn't recognize it, decline the
            // window rather than die: tell the server it's closed, carry on.
            try {
                return originalEmit(event, ...args);
            } catch (err) {
                console.warn(`[mcdata] declining unsupported window type ${args[0].inventoryType} (title ${JSON.stringify(args[0].windowTitle)}): ${err.message}`);
                bot.currentWindow = null;
                try {
                    bot._client.write('close_window', { windowId: args[0].windowId });
                } catch { /* socket already gone */ }
                return true;
            }
        }
        return originalEmit(event, ...args);
    };

    if (packet_error_logging === 'summary') {
        const rollup = setInterval(() => {
            if (suppressed_packet_errors > 0) {
                console.warn(`[mcdata] suppressed ${suppressed_packet_errors} unparseable packet(s) in the last ${PACKET_ERROR_ROLLUP_MINS}m`);
                suppressed_packet_errors = 0;
            }
        }, PACKET_ERROR_ROLLUP_MINS * 60 * 1000);
        // Don't hold the event loop open on an otherwise idle process.
        rollup.unref?.();
        bot.once('end', () => clearInterval(rollup));
    }

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(pvp);
    bot.loadPlugin(collectblock);
    bot.loadPlugin(autoEat);
    bot.loadPlugin(armorManager); // auto equip armor

    trackServerTps(bot);
    bot.once('spawn', () => {
        // Anchor for exploration_radius: where the bot came into the world, not
        // the world spawn, since that is the ground it is meant to work.
        bot.spawn_point = bot.entity.position.clone();
        // loadPlugin defers injection, so bot.pathfinder does not exist until
        // the bot is in the world -- hooking it any earlier throws.
        tameMovementsForLag(bot);
    });
    bot.once('resourcePack', () => {
        bot.acceptResourcePack();
    });

    bot.once('login', () => {
        mc_version = bot.version;
        applyModDataPacks(bot.registry, loadModDataPacks(settings.mod_data));
        patchUnknownBlocks(bot.registry);
        // bot.registry is minecraft-data for this version plus whatever the mod
        // data packs added, so everything asking mcdata about blocks and items
        // (nearby block listings, collect targets, crafting lookups) sees the
        // modded registry instead of a vanilla-only one.
        mcdata = bot.registry;
        Item = prismarine_items(bot.registry);
    });

    return bot;
}

// Block id every unknown (modded) block state is reported as. Well above the
// vanilla range so it can never collide with a real block id.
export const UNKNOWN_BLOCK_ID = 65535;

/**
 * Make modded blocks solid and diggable instead of invisible.
 *
 * Modded servers append their blocks to the end of the block state palette, so
 * every modded block arrives with a state id minecraft-data has never heard of.
 * prismarine-block's fallback for an unknown state id is name '', boundingBox
 * 'empty', diggable false -- so the bot sees modded logs and leaves as air it
 * cannot break: pathfinder routes straight through a canopy, the bot collides
 * with a block it believes isn't there, and there is no dig move to get out.
 *
 * Reporting unknown states as a plain solid diggable block is much closer to
 * the truth and lets pathfinder either walk around them or mine through.
 *
 * ponytail: one generic block stands in for every modded block, so the bot can
 * move through modded terrain but still can't name or target it (no "chop that
 * redwood"). The real fix is generating a minecraft-data dataset from the
 * modded server so modded blocks get their actual names.
 */
// View distance is the biggest lever the bot has over how much work it costs the
// server: every chunk in its window has to be kept loaded, and walking into
// terrain that was never generated makes the server generate it mid-tick. A bot
// that roams is therefore a chunk-generation engine, and on a heavy modpack that
// alone is enough to stall the server it is trying to walk across.
//
// Server ticks are the honest feedback signal for that, so the window follows
// them. bot.time.age counts world ticks and update_time carries it every 20, so
// the wall clock and the tick clock can be compared without asking the server
// anything. Radii are in chunks; even the smallest is 96 blocks, well past what
// pathfinding searches, so shrinking costs the bot little.
//
// What is measured is stalls, not average tps. This server does not run slow, it
// freezes: healthy ticks either side of a two second pause every minute or two.
// Averaged over any useful window that is ~19.5 tps, which reads as healthy and
// leaves the window wide open, and an average short enough to notice the pause
// sits right on the threshold and oscillates across it. Counting the pauses
// measures the thing that actually breaks pathing.
const STALL_LOST_MS = 1000;      // tick time lost in one interval to count as a stall
const STALL_WINDOW_MS = 300000;  // rolling window the rate is measured over
const STALL_MIN_OBSERVED_MS = 60000; // don't extrapolate a rate from a few seconds
const STALL_TIERS = [
    { max_per_min: 0.1, view: 'far' },       // 12 chunks -- quiet, roam freely
    { max_per_min: 0.5, view: 'normal' },    // 10
    { max_per_min: 1.5, view: 'short' },     // 8
    { max_per_min: Infinity, view: 'tiny' }, // 6 -- stuttering, stop making it worse
];
// Asymmetric on purpose: shrink as soon as the server complains, but earn the
// way back. Growing again is what caused the last round of flapping.
const SHRINK_SETTLE_MS = 60000;
const GROW_SETTLE_MS = 300000;
const TPS_SMOOTHING = 0.3;       // EMA weight, for the log line only

/**
 * Count server stalls over a rolling window.
 * A stall is an interval where the wall clock ran well ahead of the tick clock,
 * which is what a server freeze looks like from the client.
 */
export function createStallTracker() {
    const stalls = [];
    let started_at = null;
    return {
        /** Feed one update_time interval. Returns the tick time lost, in ms. */
        sample(ticks, elapsed_ms, now) {
            if (started_at === null) started_at = now;
            if (!(elapsed_ms > 0)) return 0;
            const lost = elapsed_ms - ticks * 50;
            if (lost >= STALL_LOST_MS) stalls.push(now);
            return lost;
        },
        /** Stalls per minute over the window so far. */
        ratePerMin(now) {
            while (stalls.length && now - stalls[0] > STALL_WINDOW_MS) stalls.shift();
            if (started_at === null) return 0;
            const observed = Math.max(Math.min(now - started_at, STALL_WINDOW_MS), STALL_MIN_OBSERVED_MS);
            return stalls.length / (observed / 60000);
        },
    };
}

/**
 * Pick a view distance for a stall rate. Returns the new view distance, or null
 * to leave it alone. Stateful across calls -- one picker per bot.
 */
export function createViewDistancePicker() {
    let current = null, last_change = 0, wants = null, wants_since = 0;
    const commit = (idx, now) => {
        current = idx; last_change = now; wants = null; wants_since = 0;
        return STALL_TIERS[idx].view;
    };
    return function pick(stalls_per_min, now) {
        const idx = STALL_TIERS.findIndex(t => stalls_per_min <= t.max_per_min);
        if (current === null) return commit(idx, now);
        if (idx === current) { wants = null; wants_since = 0; return null; }
        if (idx > current) {
            // Shrinking: the server is complaining, react without much delay.
            return now - last_change < SHRINK_SETTLE_MS ? null : commit(idx, now);
        }
        // Growing: only after the quieter rate has held for a while.
        if (wants !== idx) { wants = idx; wants_since = now; return null; }
        return now - wants_since < GROW_SETTLE_MS ? null : commit(idx, now);
    };
}

/**
 * Fold one measurement into a smoothed tick rate, ignoring impossible samples.
 * A resume after a pause reports thousands of ticks in a second; that is not a
 * fast server, it is a gap, and reading it as health would undo the shrinking
 * exactly when the server is worst.
 */
export function smoothTps(previous, ticks, elapsed_ms) {
    if (!(elapsed_ms > 0)) return previous;
    const sample = ticks / (elapsed_ms / 1000);
    if (!(sample > 0) || sample > 20.5) return previous;
    return previous * (1 - TPS_SMOOTHING) + sample * TPS_SMOOTHING;
}

function trackServerTps(bot) {
    bot.server_tps = 20;
    if (settings.view_distance !== 'auto') {
        // Pinned by config: still measure, but leave the window alone.
        if (settings.view_distance) bot.once('login', () => bot.setSettings({ viewDistance: settings.view_distance }));
    }
    let last_age = null, last_at = 0;
    const pick = createViewDistancePicker();
    const stalls = createStallTracker();
    bot.server_stalls_per_min = 0;
    bot._client.on('update_time', () => {
        const age = bot.time?.age, now = Date.now();
        if (age == null) return;
        if (last_age !== null) {
            const ticks = age - last_age;
            bot.server_tps = smoothTps(bot.server_tps, ticks, now - last_at);
            stalls.sample(ticks, now - last_at, now);
        }
        last_age = age; last_at = now;
        bot.server_stalls_per_min = stalls.ratePerMin(now);

        if (settings.view_distance !== 'auto') return;
        const view = pick(bot.server_stalls_per_min, now);
        if (!view) return;
        console.log(`[mcdata] server stalling ${bot.server_stalls_per_min.toFixed(2)}/min (~${bot.server_tps.toFixed(1)} tps), view distance -> ${view}`);
        try { bot.setSettings({ viewDistance: view }); } catch (err) { console.warn(`[mcdata] could not set view distance: ${err.message}`); }
    });
}

// Sprinting and parkour both assume the server keeps up: they commit to a jump
// or a run of momentum and only find out afterwards whether the server agreed.
// Across a stall the bot lands somewhere the server never saw it go, which reads
// as rubber-banding at best and a failed path at worst. Neither is worth much on
// a server that freezes for two seconds at a time.
//
// ponytail: hooked on setMovements rather than fixed at each call site, because
// skills.js builds `new pf.Movements(bot)` in a dozen places and would only
// grow more. Drop the hook if those ever share one constructor.
export function tameMovementsForLag(bot) {
    if (!bot.pathfinder?.setMovements) {
        console.warn('[mcdata] pathfinder missing at spawn, movement taming disabled');
        return;
    }
    const originalSetMovements = bot.pathfinder.setMovements.bind(bot.pathfinder);
    bot.pathfinder.setMovements = function (movements) {
        // Keyed on stalls, not average tps, for the same reason the view
        // distance is: a server that freezes for two seconds still averages
        // ~19.5 tps, and a jump that lands across the freeze is the failure.
        if (movements && bot.server_stalls_per_min > STALL_TIERS[0].max_per_min) {
            movements.allowParkour = false;
            movements.allowSprinting = false;
        }
        return originalSetMovements(movements);
    };
}

export function patchUnknownBlocks(registry) {
    if (!registry?.blocksByStateId) return;
    const template = {
        id: UNKNOWN_BLOCK_ID,
        name: 'unknown',
        displayName: 'Unknown Block',
        hardness: 2,
        resistance: 2,
        stackSize: 64,
        diggable: true,
        material: 'default',
        transparent: false,
        emitLight: 0,
        filterLight: 15,
        boundingBox: 'block',
        states: [],
        shapes: [[0, 0, 0, 1, 1, 1]],
        drops: [],
    };
    registry.blocks[UNKNOWN_BLOCK_ID] = template;
    registry.blocksByName['unknown'] = template;

    const unknown_states = {};
    registry.blocksByStateId = new Proxy(registry.blocksByStateId, {
        get(target, prop) {
            const known = target[prop];
            if (known !== undefined || typeof prop !== 'string') return known;
            const state_id = Number(prop);
            if (!Number.isInteger(state_id) || state_id < 0) return undefined;
            // minStateId/maxStateId are what prismarine-block subtracts to get
            // metadata; pinning them to the state id keeps metadata at 0.
            return unknown_states[state_id] ??= { ...template, minStateId: state_id, maxStateId: state_id };
        }
    });
}

export function isHuntable(mob) {
    if (!mob || !mob.name) return false;
    const animals = ['chicken', 'cow', 'llama', 'mooshroom', 'pig', 'rabbit', 'sheep'];
    return animals.includes(mob.name.toLowerCase()) && !mob.metadata[16]; // metadata 16 is not baby
}

export function isHostile(mob) {
    if (!mob || !mob.name) return false;
    return  (mob.type === 'mob' || mob.type === 'hostile') && mob.name !== 'iron_golem' && mob.name !== 'snow_golem';
}

// blocks that don't work with collectBlock, need to be manually collected
export function mustCollectManually(blockName) {
    // all crops (that aren't normal blocks), torches, buttons, levers, redstone,
    const full_names = ['wheat', 'carrots', 'potatoes', 'beetroots', 'nether_wart', 'cocoa', 'sugar_cane', 'kelp', 'short_grass', 'fern', 'tall_grass', 'bamboo',
        'poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'lilac', 'wither_rose', 'lily_of_the_valley', 'wither_rose',
        'lever', 'redstone_wire', 'lantern']
    const partial_names = ['sapling', 'torch', 'button', 'carpet', 'pressure_plate', 'mushroom', 'tulip', 'bush', 'vines', 'fern']
    return full_names.includes(blockName.toLowerCase()) || partial_names.some(partial => blockName.toLowerCase().includes(partial));
}

export function getItemId(itemName) {
    let item = mcdata.itemsByName[itemName];
    if (item) {
        return item.id;
    }
    return null;
}

export function getItemName(itemId) {
    let item = mcdata.items[itemId]
    if (item) {
        return item.name;
    }
    return null;
}

export function getBlockId(blockName) {
    let block = mcdata.blocksByName[blockName];
    if (block) {
        return block.id;
    }
    return null;
}

export function getBlockName(blockId) {
    let block = mcdata.blocks[blockId]
    if (block) {
        return block.name;
    }
    return null;
}

export function getEntityId(entityName) {
    let entity = mcdata.entitiesByName[entityName];
    if (entity) {
        return entity.id;
    }
    return null;
}

export function getAllItems(ignore) {
    if (!ignore) {
        ignore = [];
    }
    let items = []
    for (const itemId in mcdata.items) {
        const item = mcdata.items[itemId];
        // A modpack adds tens of thousands of items; the ones with no recipe are
        // dead weight for callers scanning every item (what can I craft?).
        if (item.mod && !mcdata.recipes?.[item.id]) continue;
        if (!ignore.includes(item.name)) {
            items.push(item);
        }
    }
    return items;
}

export function getAllItemIds(ignore) {
    const items = getAllItems(ignore);
    let itemIds = [];
    for (const item of items) {
        itemIds.push(item.id);
    }
    return itemIds;
}

export function getAllBlocks(ignore) {
    if (!ignore) {
        ignore = [];
    }
    let blocks = []
    for (const blockId in mcdata.blocks) {
        const block = mcdata.blocks[blockId];
        if (!ignore.includes(block.name)) {
            blocks.push(block);
        }
    }
    return blocks;
}

export function getAllBlockIds(ignore) {
    const blocks = getAllBlocks(ignore);
    let blockIds = [];
    for (const block of blocks) {
        blockIds.push(block.id);
    }
    return blockIds;
}

export function getAllBiomes() {
    return mcdata.biomes;
}

export function getItemCraftingRecipes(itemName) {
    let itemId = getItemId(itemName);
    if (!mcdata.recipes[itemId]) {
        return null;
    }

    let recipes = [];
    for (let r of mcdata.recipes[itemId]) {
        let recipe = {};
        let ingredients = [];
        if (r.ingredients) {
            ingredients = r.ingredients;
        } else if (r.inShape) {
            ingredients = r.inShape.flat();
        }
        for (let ingredient of ingredients) {
            let ingredientName = getItemName(ingredient);
            if (ingredientName === null) continue;
            if (!recipe[ingredientName])
                recipe[ingredientName] = 0;
            recipe[ingredientName]++;
        }
        recipes.push([
            recipe,
            {craftedCount : r.result.count}
        ]);
    }
    // sort recipes by if their ingredients include common items
    const commonItems = ['oak_planks', 'oak_log', 'coal', 'cobblestone'];
    recipes.sort((a, b) => {
        let commonCountA = Object.keys(a[0]).filter(key => commonItems.includes(key)).reduce((acc, key) => acc + a[0][key], 0);
        let commonCountB = Object.keys(b[0]).filter(key => commonItems.includes(key)).reduce((acc, key) => acc + b[0][key], 0);
        return commonCountB - commonCountA;
    });

    return recipes;
}

export function isSmeltable(itemName) {
    const misc_smeltables = ['beef', 'chicken', 'cod', 'mutton', 'porkchop', 'rabbit', 'salmon', 'tropical_fish', 'potato', 'kelp', 'sand', 'cobblestone', 'clay_ball'];
    return itemName.includes('raw') || itemName.includes('log') || misc_smeltables.includes(itemName);
}

export function getSmeltingFuel(bot) {
    let fuel = bot.inventory.items().find(i => i.name === 'coal' || i.name === 'charcoal' || i.name === 'blaze_rod')
    if (fuel)
        return fuel;
    fuel = bot.inventory.items().find(i => i.name.includes('log') || i.name.includes('planks'))
    if (fuel)
        return fuel;
    return bot.inventory.items().find(i => i.name === 'coal_block' || i.name === 'lava_bucket');
}

export function getFuelSmeltOutput(fuelName) {
    if (fuelName === 'coal' || fuelName === 'charcoal')
        return 8;
    if (fuelName === 'blaze_rod')
        return 12;
    if (fuelName.includes('log') || fuelName.includes('planks'))
        return 1.5
    if (fuelName === 'coal_block')
        return 80;
    if (fuelName === 'lava_bucket')
        return 100;
    return 0;
}

export function getItemSmeltingIngredient(itemName) {
    return {    
        baked_potato: 'potato',
        steak: 'raw_beef',
        cooked_chicken: 'raw_chicken',
        cooked_cod: 'raw_cod',
        cooked_mutton: 'raw_mutton',
        cooked_porkchop: 'raw_porkchop',
        cooked_rabbit: 'raw_rabbit',
        cooked_salmon: 'raw_salmon',
        dried_kelp: 'kelp',
        iron_ingot: 'raw_iron',
        gold_ingot: 'raw_gold',
        copper_ingot: 'raw_copper',
        glass: 'sand'
    }[itemName];
}

export function getItemBlockSources(itemName) {
    let itemId = getItemId(itemName);
    let sources = [];
    for (let block of getAllBlocks()) {
        if (block.drops.includes(itemId)) {
            sources.push(block.name);
        }
    }
    return sources;
}

export function getItemAnimalSource(itemName) {
    return {    
        raw_beef: 'cow',
        raw_chicken: 'chicken',
        raw_cod: 'cod',
        raw_mutton: 'sheep',
        raw_porkchop: 'pig',
        raw_rabbit: 'rabbit',
        raw_salmon: 'salmon',
        leather: 'cow',
        wool: 'sheep'
    }[itemName];
}

export function getBlockTool(blockName) {
    let block = mcdata.blocksByName[blockName];
    if (!block || !block.harvestTools) {
        return null;
    }
    return getItemName(Object.keys(block.harvestTools)[0]);  // Double check first tool is always simplest
}

export function makeItem(name, amount=1) {
    return new Item(getItemId(name), amount);
}

/**
 * Returns the number of ingredients required to use the recipe once.
 * 
 * @param {Recipe} recipe
 * @returns {Object<mc.ItemName, number>} an object describing the number of each ingredient.
 */
export function ingredientsFromPrismarineRecipe(recipe) {
    let requiredIngedients = {};
    if (recipe.inShape)
        for (const ingredient of recipe.inShape.flat()) {
            if(ingredient.id<0) continue; //prismarine-recipe uses id -1 as an empty crafting slot
            const ingredientName = getItemName(ingredient.id);
            requiredIngedients[ingredientName] ??=0;
            requiredIngedients[ingredientName] += ingredient.count;
        }
    if (recipe.ingredients)
        for (const ingredient of recipe.ingredients) {
            if(ingredient.id<0) continue;
            const ingredientName = getItemName(ingredient.id);
            requiredIngedients[ingredientName] ??=0;
            requiredIngedients[ingredientName] -= ingredient.count;
            //Yes, the `-=` is intended.
            //prismarine-recipe uses positive numbers for the shaped ingredients but negative for unshaped.
            //Why this is the case is beyond my understanding.
        }
    return requiredIngedients;
}

/**
 * Calculates the number of times an action, such as a crafing recipe, can be completed before running out of resources.
 * @template T - doesn't have to be an item. This could be any resource.
 * @param {Object.<T, number>} availableItems - The resources available; e.g, `{'cobble_stone': 7, 'stick': 10}`
 * @param {Object.<T, number>} requiredItems - The resources required to complete the action once; e.g, `{'cobble_stone': 3, 'stick': 2}`
 * @param {boolean} discrete - Is the action discrete?
 * @returns {{num: number, limitingResource: (T | null)}} the number of times the action can be completed and the limmiting resource; e.g `{num: 2, limitingResource: 'cobble_stone'}`
 */
export function calculateLimitingResource(availableItems, requiredItems, discrete=true) {
    let limitingResource = null;
    let num = Infinity;
    for (const itemType in requiredItems) {
        if (availableItems[itemType] < requiredItems[itemType] * num) {
            limitingResource = itemType;
            num = availableItems[itemType] / requiredItems[itemType];
        }
    }
    if(discrete) num = Math.floor(num);
    return {num, limitingResource}
}

let loopingItems = new Set();

export function initializeLoopingItems() {

    loopingItems = new Set(['coal',
        'wheat',
        'bone_meal',
        'diamond',
        'emerald',
        'raw_iron',
        'raw_gold',
        'redstone',
        'blue_wool',
        'packed_mud',
        'raw_copper',
        'iron_ingot',
        'dried_kelp',
        'gold_ingot',
        'slime_ball',
        'black_wool',
        'quartz_slab',
        'copper_ingot',
        'lapis_lazuli',
        'honey_bottle',
        'rib_armor_trim_smithing_template',
        'eye_armor_trim_smithing_template',
        'vex_armor_trim_smithing_template',
        'dune_armor_trim_smithing_template',
        'host_armor_trim_smithing_template',
        'tide_armor_trim_smithing_template',
        'wild_armor_trim_smithing_template',
        'ward_armor_trim_smithing_template',
        'coast_armor_trim_smithing_template',
        'spire_armor_trim_smithing_template',
        'snout_armor_trim_smithing_template',
        'shaper_armor_trim_smithing_template',
        'netherite_upgrade_smithing_template',
        'raiser_armor_trim_smithing_template',
        'sentry_armor_trim_smithing_template',
        'silence_armor_trim_smithing_template',
        'wayfinder_armor_trim_smithing_template']);
}


/**
 * Gets a detailed plan for crafting an item considering current inventory
 */
export function getDetailedCraftingPlan(targetItem, count = 1, current_inventory = {}) {
    initializeLoopingItems();
    if (!targetItem || count <= 0 || !getItemId(targetItem)) {
        return "Invalid input. Please provide a valid item name and positive count.";
    }

    if (isBaseItem(targetItem)) {
        const available = current_inventory[targetItem] || 0;
        if (available >= count) return "You have all required items already in your inventory!";
        return `${targetItem} is a base item, you need to find ${count - available} more in the world`;
    }

    const inventory = { ...current_inventory };
    const leftovers = {};
    const plan = craftItem(targetItem, count, inventory, leftovers);
    return formatPlan(targetItem, plan);
}

function isBaseItem(item) {
    return loopingItems.has(item) || getItemCraftingRecipes(item) === null;
}

function craftItem(item, count, inventory, leftovers, crafted = { required: {}, steps: [], leftovers: {} }) {
    // Check available inventory and leftovers first
    const availableInv = inventory[item] || 0;
    const availableLeft = leftovers[item] || 0;
    const totalAvailable = availableInv + availableLeft;

    if (totalAvailable >= count) {
        // Use leftovers first, then inventory
        const useFromLeft = Math.min(availableLeft, count);
        leftovers[item] = availableLeft - useFromLeft;
        
        const remainingNeeded = count - useFromLeft;
        if (remainingNeeded > 0) {
            inventory[item] = availableInv - remainingNeeded;
        }
        return crafted;
    }

    // Use whatever is available
    const stillNeeded = count - totalAvailable;
    if (availableLeft > 0) leftovers[item] = 0;
    if (availableInv > 0) inventory[item] = 0;

    if (isBaseItem(item)) {
        crafted.required[item] = (crafted.required[item] || 0) + stillNeeded;
        return crafted;
    }

    const recipe = getItemCraftingRecipes(item)?.[0];
    if (!recipe) {
        crafted.required[item] = stillNeeded;
        return crafted;
    }

    const [ingredients, result] = recipe;
    const craftedPerRecipe = result.craftedCount;
    const batchCount = Math.ceil(stillNeeded / craftedPerRecipe);
    const totalProduced = batchCount * craftedPerRecipe;

    // Add excess to leftovers
    if (totalProduced > stillNeeded) {
        leftovers[item] = (leftovers[item] || 0) + (totalProduced - stillNeeded);
    }

    // Process each ingredient
    for (const [ingredientName, ingredientCount] of Object.entries(ingredients)) {
        const totalIngredientNeeded = ingredientCount * batchCount;
        craftItem(ingredientName, totalIngredientNeeded, inventory, leftovers, crafted);
    }

    // Add crafting step
    const stepIngredients = Object.entries(ingredients)
        .map(([name, amount]) => `${amount * batchCount} ${name}`)
        .join(' + ');
    crafted.steps.push(`Craft ${stepIngredients} -> ${totalProduced} ${item}`);

    return crafted;
}

function formatPlan(targetItem, { required, steps, leftovers }) {
    const lines = [];

    if (Object.keys(required).length > 0) {
        lines.push('You are missing the following items:');
        Object.entries(required).forEach(([item, count]) => 
            lines.push(`- ${count} ${item}`));
        lines.push('\nOnce you have these items, here\'s your crafting plan:');
    } else {
        lines.push('You have all items required to craft this item!');
        lines.push('Here\'s your crafting plan:');
    }

    lines.push('');
    lines.push(...steps);

    if (Object.keys(required).some(item => item.includes('oak')) && !targetItem.includes('oak')) {
        lines.push('Note: Any varient of wood can be used for this recipe.');
    }

    if (Object.keys(leftovers).length > 0) {
        lines.push('\nYou will have leftover:');
        Object.entries(leftovers).forEach(([item, count]) => 
            lines.push(`- ${count} ${item}`));
    }

    return lines.join('\n');
}
