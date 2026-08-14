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

// Normally set from bot.registry on login; tests inject a bare registry here.
export function useRegistry(registry) { mcdata = registry; WOOD_TYPES = deriveWoodTypes(registry); minable_items = null; parsed_recipes = new Map(); recipe_ingredients = new Map(); }
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

export const VANILLA_WOOD_TYPES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'];

// A modpack's woods are not the vanilla eight, and hardcoding them made every
// wood-family rule blind to the rest: Andy stood in a frozen pine taiga holding
// pine_log and pine_planks with "has_item log" false, so the rules that gather
// wood, build the base and craft the first tools never fired at all. Derived
// from the registry at login instead; the vanilla list is the fallback for
// tests and anything that runs before there is a registry to ask.
export let WOOD_TYPES = [...VANILLA_WOOD_TYPES];

// Every wood in this world, named the way the family suffixes expect. "_log" is
// the marker because it is the one wood block every tree has; nether stems are
// deliberately left out, since expandBlockName has never covered them.
// "stripped" is checked anywhere in the name, not just as a prefix: vanilla says
// stripped_oak_log but the mod packs say willow_stripped_log, and treating those
// as woods in their own right would make "log" count stripped logs and double
// the list. Namespaced and bare spellings ("betternether:willow", "willow") are
// both kept, because either can come back on an inventory slot.
// A real wood has planks. Requiring them cut 315 derived names to the woods
// that actually exist: the "chipped:" decoration mod alone contributed ~11
// cosmetic blocks ending in _log with nothing to craft from them, and ~300 of
// the expanded plank names matched no block at all. block_nearby {name:"log"}
// scans every one of them, at range 24, on a timer.
function deriveWoodTypes(registry) {
    const blocks = registry?.blocksByName ?? {};
    const woods = Object.keys(blocks)
        .filter(name => name.endsWith('_log') && !name.includes('stripped'))
        .map(name => name.slice(0, -'_log'.length))
        .filter(wood => blocks[`${wood}_planks`]);
    return woods.length ? woods : [...VANILLA_WOOD_TYPES];
}
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
// A policy that says "log" should work in a birch forest, and "coal_ore"
// should still match below y=0. Family names expand to every variant; exact
// names ("oak_log") stay exact so stated intent is preserved.
export function expandBlockName(name) {
    if (typeof name !== 'string') return [name];
    const wood_families = [...MATCHING_WOOD_BLOCKS, 'leaves', 'wood'];
    if (wood_families.includes(name))
        return WOOD_TYPES.map(wood => `${wood}_${name}`);
    const stripped = name.startsWith('stripped_') && name.slice(9);
    if (stripped && wood_families.includes(stripped))
        return WOOD_TYPES.map(wood => `stripped_${wood}_${stripped}`);
    // Beds are dyed the same 16 ways wool is, and "is there a bed here" is a
    // question about sleeping, not about decor. Without this, block_nearby "bed"
    // never matched the white_bed sitting next to it.
    if (name === 'wool' || name === 'bed')
        return WOOL_COLORS.map(color => `${color}_${name}`);
    if (name.endsWith('_ore') && !name.startsWith('deepslate_'))
        return [name, 'deepslate_' + name];
    return [name];
}

// What counts as a weapon, in one place. equipHighestAttack picks from exactly
// this set, so the condition that gates an equip_weapon rule and the action
// that satisfies it can never disagree -- which is how
// hold_weapon_when_threatened ended up firing every few seconds at an empty
// inventory, with nothing it could possibly equip.
//
// It lives here rather than in the policy engine because chests need it too:
// "withdraw a weapon" was unanswerable while the only definition of "weapon"
// sat in a module skills.js must not import.
export const isWeaponName = (name) =>
    !!name && (name.includes('sword') || (name.includes('axe') && !name.includes('pickaxe')));

// One predicate for "does this item satisfy that name", family names included.
// expandBlockName covers the families that are just a naming convention (wood,
// wool, ores); "weapon" is a family only isWeaponName can answer. Callers that
// search a container want to ask once, not open the chest once per candidate
// name -- takeFromChest used to be driven through 60-odd names that way.
export function itemMatcher(query) {
    if (query === 'weapon') return isWeaponName;
    const names = new Set(expandBlockName(query));
    return (name) => names.has(name);
}

// A block name the agent is allowed to use: a real block, or a family name that
// stands for a set of them ("log", "planks", "bed", "iron_ore").
//
// skills.collectBlocks has understood families all along -- the policy engine's
// collect action passes "log" and it works -- but the command-argument check
// only accepted real registry names, so `!collectBlocks("log", 8)` was refused
// as an invalid block type. Worse, the refusal suggested the vanilla logs, and
// on Prominence 2 the wood is pine: the agent was told to go and get oak_log,
// which does not exist in this world, and it did try.
export function isKnownBlockName(name) {
    if (getBlockId(name) != null) return true;
    const expanded = expandBlockName(name);
    return expanded.length > 1 && expanded.some(n => getBlockId(n) != null);
}

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
    // mineflayer + its plugins legitimately register ~11 error listeners,
    // which trips Node's default warning threshold of 10. Not a leak.
    bot.setMaxListeners(20);
    bot._client.setMaxListeners(20);

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

    bot.once('spawn', () => {
        // Anchor for exploration_radius: where the bot came into the world, not
        // the world spawn, since that is the ground it is meant to work.
        bot.spawn_point = bot.entity.position.clone();
        bot.respawn_point = bot.entity.position.clone();
        // loadPlugin defers injection, so bot.pathfinder does not exist until
        // the bot is in the world -- hooking it any earlier throws.
        tameMovements(bot);
    });
    // Where the bot comes back to, refreshed every respawn -- distinct from
    // spawn_point above, which is where it entered the world and anchors the
    // exploration radius. dig_in fires wherever the bot stands, including here,
    // and a shelter dug on the respawn tile becomes a trap the moment it dies
    // in it: it reappears above its own shaft, falls in, and cannot climb out.
    // Seen at two independent spawn points on one night, the second time
    // through ground verified solid two hours earlier -- nine fall deaths at
    // (-242,76,252) after it dug out (-242,118,252) beneath itself.
    bot.on('spawn', () => {
        if (bot.entity?.position) bot.respawn_point = bot.entity.position.clone();
    });
    bot.once('resourcePack', () => {
        bot.acceptResourcePack();
    });

    bot.once('login', () => {
        mc_version = bot.version;
        vanilla_block_states = snapshotBlockStates(bot.registry);
        const mod_packs = loadModDataPacks(settings.mod_data);
        if (!mod_packs.length)
            console.warn(`[mcdata] no mod data packs loaded (mod_data=${JSON.stringify(settings.mod_data)}). On a modded server every block name will be wrong.`);
        applyModDataPacks(bot.registry, mod_packs);
        patchUnknownBlocks(bot.registry);
        // bot.registry is minecraft-data for this version plus whatever the mod
        // data packs added, so everything asking mcdata about blocks and items
        // (nearby block listings, collect targets, crafting lookups) sees the
        // modded registry instead of a vanilla-only one.
        // Same rebuild the tests drive through useRegistry: drop the caches built
        // from vanilla data (minable items, recipes) and re-derive the wood list,
        // which the mod packs above have just widened past the vanilla eight.
        useRegistry(bot.registry);
        Item = prismarine_items(bot.registry);
    });

    return bot;
}

/**
 * Vanilla state id ranges by block name, as they were before the mod data packs
 * were applied.
 *
 * minecraft-data caches its block objects per version and prismarine-registry
 * hands out those very objects, so applying a mod pack rewrites "vanilla" data
 * for the whole process -- asking minecraft-data afterwards gives the modded
 * answer. The render view needs the original ids, because the browser draws
 * chunks with plain vanilla data.
 */
export let vanilla_block_states = null;

function snapshotBlockStates(registry) {
    const states = {};
    for (const block of registry.blocksArray ?? []) {
        if (!Number.isInteger(block.minStateId)) continue;
        states[block.name] = {
            minStateId: block.minStateId,
            maxStateId: block.maxStateId,
            defaultState: block.defaultState,
        };
    }
    return states;
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
// Sprinting and parkour both assume the server keeps up: they commit to a jump
// or a run of momentum and only find out afterwards whether the server agreed.
// If the server stalls mid-move the bot lands somewhere it never saw it go,
// which reads as rubber-banding at best and a failed path at worst. Neither
// buys a bot much, so they stay off rather than being switched on a measured
// tick rate -- see the git history for why measuring it was not worth it.
//
// ponytail: hooked on setMovements rather than fixed at each call site, because
// skills.js builds `new pf.Movements(bot)` in a dozen places and would only
// grow more. Drop the hook if those ever share one constructor.
// A door is the one block nobody places by accident, so it is the cheapest
// honest signal that the surrounding blocks are somebody's build. Blocks within
// this box of a door get priced out of digging; everything else -- caves, hills,
// the mine the bot dug itself -- keeps the default dig cost.
const BUILD_RADIUS = 12;
const BUILD_HEIGHT = 8;
// Back to 64 now that world scans compare state ids instead of building a Block
// per candidate (see world.js findBlockPositions). At 64 with the old scan this
// was 14% of the agent's CPU; the same range now costs a fraction of that, and
// 64 means a door is seen early enough that the bot does not path into
// somebody's build before the next rescan notices it.
const BUILD_SCAN_DISTANCE = 64;
const BUILD_RESCAN_MS = 5000;
// How often to recheck which blocks the bot has a tool for; only changes when
// it gains or loses a tool.
const HARVEST_RECHECK_MS = 5000;
// Slow-but-worth-it vs never: snow 1s, dirt 2.5s, stone 7.5s by hand -- all fine
// when the alternative is being unable to move. Deepslate 15s and obsidian 250s
// are not. Above this, the planner routes around and the dig watchdog aborts.
export const MAX_HAND_DIG_MS = 12000;
// Must stay under 100: pathfinder treats >=100 as unbreakable, and a bot shut
// inside a room with the door closed behind it would then have no path at all.
const BUILD_DIG_PENALTY = 99;

// NOT bot.findBlocks. On a modpack that sends direct-palette chunk sections,
// findBlocks materializes a Block object for all 4096 blocks of every section in
// range just to read its type -- 56.9% of all agent CPU in one profile. At
// maxDistance 64 that is a 128-block cube, and the door scan runs from inside A*
// every 5 seconds. world.getNearestBlocks compares raw state ids and builds
// Blocks only for the handful of hits.
let _world = null;
function defaultDoorScan(bot, names, distance) {
    if (!_world) {
        // Runs inside A*, so it cannot await. Kick the load off and skip this one
        // scan; the module lands in milliseconds and the 5s rescan picks it up.
        import('../agent/library/world.js').then(m => { _world = m; }, () => {});
        return [];
    }
    return _world.getNearestBlocks(bot, names, distance, 16).map(b => b.position);
}

export function tameMovements(bot, scanDoors = null) {
    if (!bot.pathfinder?.setMovements) {
        console.warn('[mcdata] pathfinder missing at spawn, movement taming disabled');
        return;
    }

    let doors = [];
    let scannedAt = -Infinity;
    let doorNames = null;
    // world.js imports this module, so importing it back at module scope is a
    // cycle. Take the scanner as an argument instead -- the caller has no cycle,
    // and it makes the scan mockable without stubbing a whole bot.
    const scan = scanDoors ?? defaultDoorScan;
    // Called from inside A*, so the scan is cached and the check is plain
    // arithmetic over a handful of doors.
    const buildPenalty = (block) => {
        if (!block?.position) return 0;
        const now = Date.now();
        if (now - scannedAt > BUILD_RESCAN_MS) {
            scannedAt = now;
            doorNames ??= (bot.registry?.blocksArray ?? [])
                .filter(b => b.name.endsWith('_door'))
                .map(b => b.name);
            try {
                // NOT bot.findBlocks. On a modpack that sends direct-palette chunk
                // sections, findBlocks materializes a Block object for all 4096
                // blocks of every section in range just to read its type -- 56.9% of
                // all agent CPU in one profile. At maxDistance 64 that is a 128-cube
                // region, and this runs from inside A* every 5 seconds. world's
                // version compares raw state ids and builds Blocks only for hits.
                doors = doorNames.length ? scan(bot, doorNames, BUILD_SCAN_DISTANCE) : [];
            } catch (err) {
                doors = [];  // world not loaded yet; the next path will try again
            }
        }
        for (const door of doors) {
            if (Math.abs(block.position.x - door.x) <= BUILD_RADIUS &&
                Math.abs(block.position.z - door.z) <= BUILD_RADIUS &&
                Math.abs(block.position.y - door.y) <= BUILD_HEIGHT) return BUILD_DIG_PENALTY;
        }
        return 0;
    };

    // Routes through blocks the bot has no tool for. Andy is in a frozen pine
    // taiga, where snow_block needs a shovel he does not have: the planner kept
    // routing through it, and a watchdog in goToPosition aborted the path once
    // digging had already started -- so he re-planned the same impossible route
    // over and over ("Cannot break snow_block with current tools", six times in
    // half an hour, plus the pathfinding timeouts it caused).
    // safeToBreak treats an exclusion cost of 100 as "cannot break", so this
    // makes A* route around the snow instead of into it.
    // ...but "no tool for it" was the wrong test. canHarvest asks whether a block
    // DROPS anything, not whether it can be broken: snow_block yields no snowball
    // without a shovel yet breaks by hand in one second. Excluding it made A*
    // route around every snow block in a biome made of snow, so no path existed
    // anywhere, every goal timed out, and Andy sat in one spot and died 7 times.
    // What is actually worth refusing is TIME -- snow 1s, stone 7s, obsidian 250s.
    let digCost = new Map();
    let harvestStamp = -Infinity;
    const harvestCheck = (block) => {
        if (!block?.type) return 0;
        const now = Date.now();
        // Cached per block type and rechecked periodically, because this runs
        // inside A* for every candidate dig and the answer only changes when
        // the bot picks up or loses a tool.
        if (now - harvestStamp > HARVEST_RECHECK_MS) { digCost.clear(); harvestStamp = now; }
        let cost = digCost.get(block.type);
        if (cost === undefined) {
            try {
                // digTime reflects the tool actually held, which is what the bot
                // will be holding when the planner's route reaches this block.
                const ms = bot.digTime(block);
                cost = ms > MAX_HAND_DIG_MS ? 100 : 0;
            } catch {
                cost = 0;  // unknown block: let the old behaviour handle it
            }
            digCost.set(block.type, cost);
        }
        return cost;
    };

    // A* runs synchronously on the event loop. The default budgets (40s total,
    // 40ms per tick -- and a "tick" stretches much further than 40ms when the
    // exclusion penalties make node expansion slow) let a 147-block
    // destructive-path search starve keepalives until the server dropped the
    // connection ("lost connection: Timed out"). A failed path is recoverable;
    // a disconnect is not, so give up early and think in smaller slices.
    bot.pathfinder.thinkTimeout = 5000;
    // 10ms left A* about a second of compute per goto, and on this modpack that
    // lost roughly 12 goals to "Took to long to decide path" for every one it
    // found. 20ms doubles the budget and is still well under the 50ms tick, so
    // there is headroom before keepalives start slipping -- which is the failure
    // this was originally lowered to prevent, and the reason not to go to 40.
    bot.pathfinder.tickTimeout = 20;

    // pathfinder stores whatever it is handed and only calls goal.isValid() on
    // the next physics tick -- inside an EventEmitter, outside any promise
    // chain. So generated code doing goto(new Vec3(x,y,z)) instead of
    // goto(new GoalNear(...)) does not fail the await, it throws
    // "stateGoal.isValid is not a function" where nothing can catch it and the
    // whole agent process exits 1. Reject it here, synchronously, where the
    // caller's try/catch still works and the model gets told what it did wrong.
    // Every pathfinder entry point that takes a Goal, guarded the same way.
    // Guarding goto and setGoal alone was not enough: goToGoal calls getPathTo
    // FIRST, so passing it a Vec3 died on "goal.heuristic is not a function"
    // before either wrapper saw anything. These are the three methods
    // pathfinder calls on a goal, so anything missing one is not a Goal.
    const isGoal = (g) => !!g && typeof g.isEnd === 'function'
        && typeof g.isValid === 'function' && typeof g.heuristic === 'function';
    const notAGoal = (method) => `bot.pathfinder.${method} needs a pathfinder Goal, not coordinates or a Vec3. ` +
        'Use skills.goToPosition(bot, x, y, z), or build a goal first: ' +
        'new pf.goals.GoalNear(x, y, z, range).';

    const originalGoto = bot.pathfinder.goto?.bind(bot.pathfinder);
    if (originalGoto) bot.pathfinder.goto = function (goal, ...rest) {
        if (!isGoal(goal)) return Promise.reject(new Error(notAGoal('goto')));
        return originalGoto(goal, ...rest);
    };

    // getPathTo is synchronous and returns a result object, so a bad goal here
    // throws straight out of whatever skill called it.
    const originalGetPathTo = bot.pathfinder.getPathTo?.bind(bot.pathfinder);
    if (originalGetPathTo) bot.pathfinder.getPathTo = function (movements, goal, ...rest) {
        if (!isGoal(goal)) throw new Error(notAGoal('getPathTo'));
        return originalGetPathTo(movements, goal, ...rest);
    };

    // setGoal is the worse half of the same hazard: goto at least returns a
    // promise something can reject, while setGoal just stores the object and
    // returns, so the TypeError surfaces on the next physics tick with no
    // caller left to catch it and the process exits 1. Throwing synchronously
    // puts the failure back where the try/catch is. A null goal is how you
    // clear one, so that stays legal.
    const originalSetGoal = bot.pathfinder.setGoal?.bind(bot.pathfinder);
    if (originalSetGoal) bot.pathfinder.setGoal = function (goal, ...rest) {
        // A null goal is how you clear one, so that stays legal.
        if (goal != null && !isGoal(goal)) throw new Error(notAGoal('setGoal'));
        return originalSetGoal(goal, ...rest);
    };

    const originalSetMovements = bot.pathfinder.setMovements.bind(bot.pathfinder);
    bot.pathfinder.setMovements = function (movements) {
        if (movements) {
            movements.allowParkour = false;
            movements.allowSprinting = false;
            // Default true forbids placing any block next to liquid, which
            // made every tower-up move in a flooded shaft illegal -- the bot
            // sat at the bottom of its own wet mine with 64 cobblestone and
            // "path not found". Its shafts keep hitting aquifers; being able
            // to pillar out beats keeping streams tidy.
            movements.dontCreateFlow = false;
            // Digging one block through a wall costs ~2-5 by default, so a door
            // twenty blocks away always loses and the bot tunnels into the base.
            // canOpenDoors is already on; it just needed the walls to be the
            // expensive option. ponytail: a box around each door, not a real
            // structure detector -- upgrade to a flood fill of the enclosed
            // volume if bots start tunnelling through outbuildings 13 blocks out.
            if (Array.isArray(movements.exclusionAreasBreak) &&
                !movements.exclusionAreasBreak.includes(buildPenalty)) {
                movements.exclusionAreasBreak.push(buildPenalty);
            }
            if (Array.isArray(movements.exclusionAreasBreak) &&
                !movements.exclusionAreasBreak.includes(harvestCheck)) {
                movements.exclusionAreasBreak.push(harvestCheck);
            }
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

    // prismarine-block rebuilds every block's `shapes` from blockCollisionShapes
    // when its provider is created, which happens after this patch runs. A name
    // missing from that table gets shapes=undefined, and pathfinder iterates
    // block.shapes unguarded -- one modded block underfoot and `b.shapes is not
    // iterable` crashes the agent out of an event handler. Give 'unknown' the
    // same entry stone has so the rebuild finds a full cube.
    const collision_shapes = registry.blockCollisionShapes;
    if (collision_shapes?.blocks) {
        collision_shapes.blocks['unknown'] = collision_shapes.blocks['stone'];
    }

    // A mod data pack covers the server's palette with no holes, so a state id
    // past the end of it means the server has more block states than the pack
    // knows about: the pack is stale. That is not a local miss -- every id
    // above the first insertion point is shifted, so block names, digging and
    // the render view are all quietly wrong until the pack is re-dumped.
    const max_known_state = registry.blocksArray?.reduce((max, b) => Math.max(max, b.maxStateId ?? 0), 0) ?? 0;
    let warned_stale = false;

    const unknown_states = {};
    registry.blocksByStateId = new Proxy(registry.blocksByStateId, {
        get(target, prop) {
            const known = target[prop];
            if (known !== undefined || typeof prop !== 'string') return known;
            const state_id = Number(prop);
            if (!Number.isInteger(state_id) || state_id < 0) return undefined;
            if (state_id > max_known_state && !warned_stale) {
                warned_stale = true;
                console.warn(`[mcdata] the server sent block state id ${state_id}, past the ${max_known_state} this registry knows. ` +
                    'The mod data pack is missing or does not match the server. Until it is fixed, block names, ' +
                    'digging and the render view are wrong for everything above the first shifted block.');
            }
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

// Does this name mean anything in this world? A rule naming something the
// registry has never heard of does not fail -- it silently never matches, which
// is far worse. Two of those in one session: "has_item sword" (not a family, so
// it stayed exactly "sword" and matched no item on earth) and a chillager rule
// that used the translation key instead of the entity id. Both looked correct
// and both had never once fired.
//
// Returns true when there is no registry to ask, so validation before login and
// in tests stays permissive rather than rejecting everything.
export function isKnownName(name) {
    if (typeof name !== 'string' || !name) return true;
    if (!mcdata?.itemsByName && !mcdata?.blocksByName) return true;
    return expandBlockName(name).some(n =>
        mcdata.itemsByName?.[n] || mcdata.blocksByName?.[n]);
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

// "bed", "wool" and "planks" are all categories, not items -- the real names are
// white_bed, red_wool, oak_planks. Rejecting them with a bare "invalid item type"
// tells the model nothing, so it retries the same category name or gives up on
// the goal. Point it at the real names instead.
export function suggestNames(name, kind='item') {
    const all = kind === 'block' ? getAllBlocks() : getAllItems();
    const needle = String(name).toLowerCase().replace(/^minecraft:/, '');
    const hits = all.filter(e => e.name !== needle && (e.name.endsWith('_' + needle) || e.name.startsWith(needle + '_')));
    if (hits.length === 0) return '';
    // Vanilla first: this modpack has 365 blocks ending in _log, and a plain
    // alphabetical list was 16 mod woods from anchor_tree to bundled_cherry --
    // none of them anywhere near the bot, and oak_log nowhere in sight.
    // ponytail: vanilla-vs-modded, not distance-ranked. Ranking by what is
    // actually nearby needs bot state this has no access to; worth threading
    // through only if the vanilla shortlist turns out to be the wrong one.
    const names = hits.filter(e => !e.mod).map(e => e.name).sort();
    const modded = hits.filter(e => e.mod).map(e => e.name).sort();
    // Alphabetical would cut white_bed -- the one the bot almost always wants --
    // off the end of a truncated list, so show the whole dyed set. 16 colours is
    // cheap; only a modpack's hundred-variant category needs truncating.
    const MAX = 16;
    const shown = (names.length ? names : modded).slice(0, MAX);
    const rest = hits.length - shown.length;
    return ` Did you mean one of: ${shown.join(', ')}${rest > 0 ? `, ... (${rest} more, mostly modded variants)` : ''}?`;
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

// Turning one item's raw recipe variants into {ingredient: count} pairs depends
// only on the registry, never on what the bot is carrying -- but the planner
// re-derived it on every recursive step. Costing a single wooden_pickaxe walked
// the tag-expanded plank list, 522 variants, thousands of times: 7 seconds of
// blocked event loop for one !getCraftingPlan. Minecraft drops a client that
// misses two keepalives, so Andy was timing out mid-plan and the reconnect
// looked like a flaky network. Parse once per item, rank per call.
let parsed_recipes = new Map();
// Every ingredient name that appears anywhere in an item's variants, flattened.
// Also registry-only, so it lives as long as parsed_recipes does.
let recipe_ingredients = new Map();

/**
 * An item's recipe variants as [{ingredient: count}, {craftedCount}] pairs.
 * The entries are shared across every caller -- treat them as read-only;
 * writing to one rewrites that recipe for every later plan.
 */
function parsedRecipes(itemId) {
    let parsed = parsed_recipes.get(itemId);
    if (parsed) return parsed;
    parsed = [];
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
        parsed.push([
            recipe,
            {craftedCount : r.result.count},
            r // raw minecraft-data recipe, kept for manual grid crafting
        ]);
    }
    parsed_recipes.set(itemId, parsed);
    return parsed;
}

/**
 * Could this item be made from something the bot is holding? Answering it by
 * ranking the item's own recipes meant a recursive walk per ingredient name,
 * and a tag-expanded list names ~500 of them: costing one wooden_sword while
 * holding pine_planks took 9.7 seconds and blocked every keepalive with it.
 * Which ingredients an item can be made from does not depend on the inventory,
 * so the set is built once and the question becomes a lookup.
 */
function craftableFrom(itemName) {
    const itemId = getItemId(itemName);
    if (!mcdata.recipes[itemId]) return null;
    let names = recipe_ingredients.get(itemId);
    if (!names) {
        names = new Set();
        for (const [ingredients] of parsedRecipes(itemId))
            for (const name of Object.keys(ingredients)) names.add(name);
        recipe_ingredients.set(itemId, names);
    }
    return names;
}

export function getItemCraftingRecipes(itemName, inventory = null, lookahead = true) {
    let itemId = getItemId(itemName);
    if (!mcdata.recipes[itemId]) {
        return null;
    }

    // Ranking below builds a fresh array, so callers never get this one.
    let recipes = parsedRecipes(itemId);
    // Ranking cannot express "mine it instead of crafting it", and an attempt to
    // add that as a candidate ("prefer mining whenever the item is also a
    // block") was wrong: furnace, piston, beacon and chest are all blocks, so
    // the planner started answering "go find a furnace" instead of "craft one
    // from 8 cobblestone". Being a block does not mean occurring in the world.
    // Rank by what the bot can actually use, falling back to the old bias
    // toward common vanilla materials when no inventory is supplied.
    // That bias used to be the only ranking, and on a modded server it sorts
    // the one usable recipe last: Andy, standing in a spruce/larch forest with
    // larch_planks already craftable, was told a wooden_pickaxe needs an
    // oak_log -- a tree that does not grow in his biome. He spent a day of
    // real time trying to obtain oak.
    const commonItems = ['oak_planks', 'oak_log', 'coal', 'cobblestone'];
    // One level of lookahead, because holding a log is as good as holding the
    // planks. Without it, an inventory of pine_log scores every plank recipe at
    // zero and the tiebreak hands the job back to oak -- and only the top few
    // candidates are ever costed, so pine never gets considered at all.
    const held = (name, count) => Math.min(inventory?.[name] ?? 0, count);
    // Held once, not per ingredient: a tag-expanded list asks about ~500 names.
    const carrying = Object.keys(inventory ?? {}).filter(name => inventory[name] > 0);
    const nearly = new Map();
    const nearlyHeld = (name) => {
        if (!lookahead || !carrying.length) return 0;
        if (!nearly.has(name)) {
            const from = craftableFrom(name);
            nearly.set(name, from && carrying.some(item => from.has(item)) ? 1 : 0);
        }
        return nearly.get(name);
    };
    const haveScore = ([ingredients]) => Object.entries(ingredients)
        .reduce((n, [name, count]) => n + (held(name, count) || nearlyHeld(name)), 0);
    const commonScore = ([ingredients]) => Object.keys(ingredients)
        .filter(key => commonItems.includes(key)).reduce((acc, key) => acc + ingredients[key], 0);
    // Score once per recipe, then sort. Scoring inside the comparator meant
    // O(n log n) scores instead of O(n) -- about 9400 recursive lookups for a
    // 522-variant plank recipe, which stopped pack loading finishing at all.
    const ranked = recipes.map(r => ({ r, have: haveScore(r), common: commonScore(r) }));
    ranked.sort((a, b) => (b.have - a.have) || (b.common - a.common));
    recipes = ranked.map(s => s.r);

    return recipes;
}

/**
 * A recipe the inventory can pay for right now, in the raw shape tableCraft's
 * manual grid clicks consume. bot.recipesFor only knows vanilla ids, so on a
 * modded server a craft from larch or pine resolves to nothing even with every
 * ingredient in hand -- while these recipes (mod packs included) know it fine.
 * The server's result slot stays the arbiter of whether the recipe is real.
 */
export function getCraftableRawRecipe(itemName, inventory = {}) {
    const ranked = getItemCraftingRecipes(itemName, inventory) ?? [];
    for (const [ings, , raw] of ranked) {
        if (!raw) continue;
        if (!Object.entries(ings).every(([name, count]) => (inventory[name] ?? 0) >= count)) continue;
        const wrap = id => ({ id: (id === null || id === undefined) ? -1 : id });
        const inShape = raw.inShape ? raw.inShape.map(row => row.map(wrap)) : undefined;
        const ingredients = raw.ingredients ? raw.ingredients.map(id => ({ id })) : undefined;
        const needsTable = inShape
            ? (inShape.length > 2 || inShape.some(row => row.length > 2))
            : (raw.ingredients?.length ?? 0) > 4;
        return { recipe: { inShape, ingredients, result: raw.result }, needsTable };
    }
    return null;
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

/**
 * Structured crafting plan: {required, steps: [{item, count, ingredients}], leftovers}.
 * steps are bottom-up; the target item is the last step. Returns null for
 * base/unknown items.
 */
export function getCraftingPlan(targetItem, count = 1, current_inventory = {}) {
    initializeLoopingItems();
    if (!targetItem || count <= 0 || !getItemId(targetItem) || isBaseItem(targetItem))
        return null;
    return craftItem(targetItem, count, { ...current_inventory }, {});
}

function isBaseItem(item) {
    return loopingItems.has(item) || getItemCraftingRecipes(item) === null;
}

// How many raw units a plan ends up asking the bot to go find. Cheapest wins.
function planCost(item, count, inventory, leftovers, depth) {
    const scratch = craftItem(item, count, { ...inventory }, { ...leftovers },
        { required: {}, steps: [], leftovers: {} }, depth + 1);
    return Object.values(scratch.required).reduce((a, b) => a + b, 0);
}

// Pick the recipe variant whose ingredients the bot is closest to having, by
// costing each candidate's whole tree in raw units still needed. This is what
// makes a wooden_pickaxe plan use the spruce in the bag instead of the oak that
// happens to sort first.
// ponytail: 4 candidates, depth 6, and it only ranks recipes against each
// other. It deliberately does NOT decide whether mining beats crafting -- see
// getItemCraftingRecipes for why the "is it a block" version of that was wrong.
const MAX_RECIPE_CANDIDATES = 4;
const MAX_PLAN_DEPTH = 6;

// Items you can go and mine, as opposed to items you must assemble. The test is
// "does some OTHER block drop this": stone drops cobblestone, coal_ore drops
// coal, iron_ore drops raw_iron. A furnace, a beacon, a chest and a plank drop
// only from themselves, which is the registry's way of saying the only way to
// have one is to make one.
// An earlier attempt asked merely "is this item a block", and furnace, chest,
// piston and beacon all are -- the planner started answering "go find a
// furnace" instead of "craft one from 8 cobblestone".
let minable_items = null;
export function isMinable(item) {
    if (!mcdata?.blocks) return false;
    if (minable_items === null) {
        minable_items = new Set();
        for (const block of Object.values(mcdata.blocks)) {
            for (const drop of block.drops ?? []) {
                const id = drop?.drop?.id ?? drop?.drop ?? drop;
                const name = getItemName(id);
                if (name && name !== block.name) minable_items.add(name);
            }
        }
    }
    return minable_items.has(item);
}

function chooseRecipe(item, stillNeeded, inventory, leftovers, depth) {
    const recipes = getItemCraftingRecipes(item, inventory);
    if (!recipes || recipes.length === 0) return null;
    if (depth >= MAX_PLAN_DEPTH) return recipes[0];

    // Prominence 2 has a 12 pebble -> 3 cobblestone recipe, so the plan for a
    // stone_pickaxe read "you are missing 12 pebble" instead of "mine 3
    // cobblestone", and Andy went looking for pebbles.
    let best = recipes[0], bestCost = isMinable(item) ? stillNeeded : Infinity;
    if (bestCost < Infinity) best = null;
    for (const recipe of recipes.slice(0, MAX_RECIPE_CANDIDATES)) {
        const [ingredients, result] = recipe;
        const batches = Math.ceil(stillNeeded / result.craftedCount);
        let cost = 0;
        for (const [name, amount] of Object.entries(ingredients))
            cost += planCost(name, amount * batches, inventory, leftovers, depth);
        if (cost < bestCost) { bestCost = cost; best = recipe; }
    }
    return best;
}

function craftItem(item, count, inventory, leftovers, crafted = { required: {}, steps: [], leftovers: {} }, depth = 0) {
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

    // Stop descending and just ask for the item. Recipe graphs have cycles that
    // the loopingItems list does not cover -- with the mod pack's 11736 recipes,
    // costing the alternatives walks into a stick -> planks -> ... -> stick loop
    // that recipes[0] happened to step around, and craftRecipe("stick", 4) died
    // with "Maximum call stack size exceeded" instead of crafting anything.
    if (isBaseItem(item) || depth >= MAX_PLAN_DEPTH) {
        crafted.required[item] = (crafted.required[item] || 0) + stillNeeded;
        return crafted;
    }

    const recipe = chooseRecipe(item, stillNeeded, inventory, leftovers, depth);
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
        craftItem(ingredientName, totalIngredientNeeded, inventory, leftovers, crafted, depth + 1);
    }

    // Add crafting step
    const stepIngredients = {};
    for (const [name, amount] of Object.entries(ingredients))
        stepIngredients[name] = amount * batchCount;
    crafted.steps.push({ item, count: totalProduced, ingredients: stepIngredients });

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
    lines.push(...steps.map(s =>
        `Craft ${Object.entries(s.ingredients).map(([name, amount]) => `${amount} ${name}`).join(' + ')} -> ${s.count} ${s.item}`));

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
