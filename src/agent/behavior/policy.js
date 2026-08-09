import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import { writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync, unlinkSync } from 'fs';

// A policy is a set of standing rules compiled from natural-language
// instructions by the LLM. Each rule is a tiny behavior tree: a condition
// subtree (with all/any/not combinators) gating a sequence of action leaves.
// The ModeController arbiter ticks rules alongside the built-in modes,
// in priority order.

// ---------- condition leaves ----------
// (agent, args) => bool.  Must be fast and side-effect free.

// Conditions are evaluated on a timer whether or not anything comes of them, so
// they get a tighter budget than actions. A CPU profile of the live agent put
// 56.9% of ALL its CPU inside getNearestBlocksWhere, 47.3% of that under
// block_nearby below. The cause is upstream: mineflayer skips a chunk section
// only when section.palette proves the block is absent, and Prominence 2 sends
// 20-bits-per-block sections (see patches/prismarine-chunk) that have no
// palette at all -- so every section is fully materialized, one Block object per
// candidate. Until that is fixed properly, keep condition scans small.
// ponytail: a budget, not a fix. The fix is matching raw state ids and never
// constructing Blocks -- worth doing if world scanning stays this hot.
const MAX_COND_SCAN = 16;

// What counts as a weapon, in one place. equipHighestAttack picks from exactly
// this set, so the condition that gates an equip_weapon rule and the action
// that satisfies it can never disagree -- which is how
// hold_weapon_when_threatened ended up firing every few seconds at an empty
// inventory, with nothing it could possibly equip.
export const isWeaponName = (name) =>
    !!name && (name.includes('sword') || (name.includes('axe') && !name.includes('pickaxe')));

// Entity metadata key 7 is ticks_frozen for 1.17+; mineflayer indexes
// entity.metadata by key, so this is where the freeze meter lives.
//
// Andy has died "froze to death" on Prominence 2, has noticed it, and keeps
// writing itself cold-weather rules -- but there was no condition to compile
// them into, so the model substituted is_night or hostile_nearby and landed on
// {"act": "stay"}, which is the worst rule shape available. It arrived there
// because the vocabulary had no word for what it was trying to say.
// A first version of this warned when metadata[7] was absent, on the theory that
// a condition which can never fire is worse than no condition. It fired within a
// minute and was wrong: the server only sends a metadata field once it CHANGES
// from its default, so an absent slot means "not currently freezing", which is
// the normal state. Absence proves nothing, so it says nothing.
//
// What does prove the wiring is a non-zero reading, so that is what gets logged,
// once. Until that line appears in a log this condition is correct-by-the-spec
// but unconfirmed on this server; to force it, stand in powder snow.
// This first read entity metadata key 7, ticks_frozen in the vanilla 1.17+
// layout. That is a specification, not an observation, and the observation
// disagreed: penned in powder snow the bot froze to death three times and the
// condition never fired once. A metadata probe then showed why -- while the bot
// was freezing to death, at health 0, the only non-zero numeric slots were
// 9 (health), 10, 20 and 21. Key 7 is never sent on this server at all.
//
// So freezing is detected from what is actually observable. Powder snow is the
// certain case and the one the pen test can confirm. The biome half is a
// heuristic and labelled as one: Frostiful does ambient cold damage in snowy
// weather, which is how the agent kept dying before anyone placed a block.
const COLD_BIOME = /snow|frozen|ice|glacial|frost|freezing/i;

// Max health is 20 in vanilla and 52 on this server -- confirmed against the
// server itself, not inferred: `attribute clarkhackworth generic.max_health get`
// answers 52.0. Every health threshold written as an absolute number was
// therefore calibrated for a bot with a third of the health it actually has, and
// "flee when health_below 8" meant "flee at 15%", which is not fleeing, it is
// dying slightly later. Hence the pct form on health_below.
//
// The attribute key spelling has changed across protocol versions and mods can
// add their own, so take the first that answers and fall back to vanilla rather
// than reporting a max of zero and making every rule fire forever.
function maxHealth(bot) {
    const attributes = bot?.entity?.attributes ?? {};
    for (const key of ['minecraft:generic.max_health', 'generic.maxHealth', 'generic.max_health', 'max_health']) {
        const value = attributes[key]?.value ?? attributes[key];
        if (typeof value === 'number' && value > 0) return value;
    }
    return 20;
}

function isFreezing(bot) {
    if (!bot?.entity?.position) return false;
    // Standing in powder snow. Certain, immediate, and the half under test.
    for (const dy of [0, 1]) {
        const block = bot.blockAt?.(bot.entity.position.offset(0, dy, 0));
        if (block?.name === 'powder_snow') return true;
    }
    // Ambient cold: snowfall, in a cold biome, with sky above you.
    //
    // The sky check is not decoration, it is what makes this branch honest.
    // move_away declares that it clears is_freezing, which is true of powder
    // snow -- you walk out of the block -- and false of weather: walking ten
    // blocks does not stop it snowing. Without a clearable term this branch
    // re-fires every cooldown for as long as the storm lasts, which is exactly
    // the livelock the validator exists to reject, and it got past the validator
    // on a clear that did not hold for it. Observed doing precisely that,
    // interrupting a goToCoordinates and a newAction.
    //
    // Getting under cover is the thing the rule's own prompt tells the agent to
    // do, and now it is also the thing that makes the condition false.
    if (!bot.isRaining || !COLD_BIOME.test(world.getBiomeName(bot))) return false;
    return hasOpenSky(bot);
}

// Is there sky directly above, within the height weather can reach through?
// A bounded upward scan rather than block.skyLight: sky light is dimmed by time
// of day as well as by cover, so at night it cannot tell a roof from midnight.
const SKY_SCAN = 12;
function hasOpenSky(bot) {
    const base = bot.entity.position;
    for (let dy = 2; dy <= SKY_SCAN; dy++) {
        const block = bot.blockAt?.(base.offset(0, dy, 0));
        // An unloaded chunk reads as null. Treat that as covered rather than
        // exposed: the failure that matters is a pinned rule firing forever, so
        // when in doubt this branch stays quiet.
        if (!block) return false;
        if (block.name !== 'air' && block.boundingBox !== 'empty') return false;
    }
    return true;
}

export const CONDITIONS = {
    hostile_nearby: {
        args: { range: 'number (blocks, default 16)' },
        desc: 'A hostile mob is within range.',
        fn: (agent, a) => !!world.getNearestEntityWhere(agent.bot, e => mc.isHostile(e), a.range ?? 16)
    },
    entity_nearby: {
        args: { name: 'string entity name, e.g. "zombie"', range: 'number (default 16)' },
        desc: 'An entity of the given type is within range.',
        fn: (agent, a) => !!world.getNearestEntityWhere(agent.bot, e => e.name === a.name, a.range ?? 16)
    },
    block_nearby: {
        args: { name: 'string block name, e.g. "wheat"', range: `number (default 16, max ${MAX_COND_SCAN})` },
        desc: 'A block of the given type is within range. Family names match every variant: "log" is any wood\'s log, "planks" any plank, and any "<x>_ore" includes its deepslate form.',
        // Profiled at 47% of all agent CPU: six of these at range 32, in one
        // rule's condition. Scan cost is cubic, so 32 -> 16 is ~8x cheaper, and
        // "is it near me" does not need 32. See MAX_COND_SCAN.
        fn: (agent, a) => !!world.getNearestBlock(agent.bot, a.name, Math.min(a.range ?? 16, MAX_COND_SCAN))
    },
    animal_nearby: {
        args: { range: 'number (default 16)' },
        desc: 'A huntable animal is within range.',
        fn: (agent, a) => !!world.getNearestEntityWhere(agent.bot, e => mc.isHuntable(e), a.range ?? 16)
    },
    player_nearby: {
        args: { name: 'string player name, or "any"', range: 'number (default 16)' },
        desc: 'A player is within range.',
        fn: (agent, a) => !!world.getNearestEntityWhere(agent.bot,
            e => e.type === 'player' && (a.name === 'any' || !a.name || e.username === a.name), a.range ?? 16)
    },
    health_below: {
        // "value" stays first because parseConditionExpr fills args positionally
        // from this order, so the flat form "health_below 6" -- used by
        // !stayUntil and by every stay "until" string -- must keep meaning six
        // health points. Putting pct first silently reinterpreted those as six
        // PERCENT, which a test caught and a live agent would not have.
        args: {
            value: 'absolute health points. Only correct if you know this server\'s maximum; the flat form "health_below 6" means this.',
            pct: 'percent of max health, 0-100. PREFER THIS in a rule, where you can name it.',
        },
        desc: 'Bot health is low. Give "pct" rather than "value": max health is not 20 everywhere -- it is 52 on this server, where the vanilla-looking "value": 8 meant the bot did not react until it was down to 15% and usually died anyway.',
        fn: (agent, a) => a.pct != null
            ? agent.bot.health < maxHealth(agent.bot) * (a.pct / 100)
            : agent.bot.health < (a.value ?? 10),
    },
    hunger_below: {
        args: { value: 'number 0-20' },
        desc: 'Bot food level is below value (max 20).',
        fn: (agent, a) => agent.bot.food < (a.value ?? 10)
    },
    has_item: {
        args: { item: 'string item name', count: 'number (default 1)' },
        desc: 'Bot inventory contains at least count of item. Family names count all variants: "log" is every wood\'s log, "planks" every plank, and "weapon" is any sword or axe. Note that "sword" alone is NOT a family and matches nothing -- use "weapon".',
        fn: (agent, a) => {
            const counts = world.getInventoryCounts(agent.bot);
            // "sword" is not a family name, so expandBlockName returns it
            // unchanged and it matches no real item -- a rule written as
            // "not has_item sword" was therefore true even holding five of
            // them. "weapon" is the spelling that works.
            if (a.item === 'weapon')
                return Object.entries(counts).reduce((sum, [n, c]) => sum + (isWeaponName(n) ? c : 0), 0) >= (a.count ?? 1);
            return mc.expandBlockName(a.item).reduce((sum, name) => sum + (counts[name] ?? 0), 0) >= (a.count ?? 1);
        }
    },
    has_food: {
        args: {},
        desc: 'Bot is carrying something it can actually eat. Use it to gate any rule whose action is "consume" -- a rule that fires on hunger or low health but has no food to eat cannot fix its own trigger, so it re-fires forever and starves every other rule.',
        // Same predicate consume() uses to pick an item, so the gate and the
        // remedy can never disagree about what counts as food.
        fn: (agent) => agent.bot.inventory.items().some(i => agent.bot.registry.foods?.[i.type])
    },
    holding: {
        args: { item: 'string item name, or "weapon" for any sword/axe' },
        desc: 'The named item is in the bot\'s hand. Use "weapon" to gate an equip_weapon rule: without it the rule re-fires forever, because equipping a weapon you already hold changes nothing but still cancels whatever was running.',
        // hold_weapon_when_threatened was interrupts:all on hostile_nearby, so
        // it re-fired for as long as the mob was there -- and every fire after
        // the first was a no-op that still killed a running action. The trigger
        // it wanted was "a mob is near AND my hands are empty".
        // Same predicate equipHighestAttack picks from, so the gate and the
        // remedy cannot disagree about what counts as a weapon.
        fn: (agent, a) => {
            const held = agent.bot.heldItem?.name;
            if (!held) return false;
            if (a.item === 'weapon') return isWeaponName(held);
            return mc.expandBlockName(a.item).includes(held);
        }
    },
    at_death_position: {
        args: { range: 'number (default 8)' },
        desc: 'Bot is near where it last died. False until it has died at least once. Use it to keep away from whatever killed you -- the mob is usually still there and your gear is on the ground beside it.',
        // The death handler already writes last_death_position into the memory bank,
        // so the condition just reads it. Without this the compiler had no way
        // to express "do not go back there" and wrote at_position 0,0,0 --
        // a placeholder that only matches the world origin, which is why
        // never_return_to_death_position never once fired.
        fn: (agent, a) => {
            const p = agent.memory_bank?.recallPlace('last_death_position');
            if (!p || p[0] === undefined) return false;
            return agent.bot.entity.position.distanceTo({ x: p[0], y: p[1], z: p[2] }) <= (a.range ?? 8);
        }
    },
    at_position: {
        args: { x: 'number', y: 'number', z: 'number', range: 'number (default 3)' },
        desc: 'Bot is within range blocks of the position.',
        fn: (agent, a) => agent.bot.entity.position.distanceTo(
            { x: a.x, y: a.y, z: a.z }) <= (a.range ?? 3)
    },
    place_known: {
        args: { name: 'string place name, as given to remember_here' },
        desc: 'A place with this name has been remembered (by remember_here or !rememberHere). Pair it with remember_here under a "not" to record a spot once, and use it positively to gate goto_place so the rule stays quiet until there is somewhere to go.',
        fn: (agent, a) => !!agent.memory_bank?.recallPlace(a.name)
    },
    drowning: {
        args: { air: 'number (default 12), oxygen out of 20 below which this is true' },
        desc: 'Bot is underwater and losing air. Use this for "underwater"/"drowning", not block_nearby water, which is also true standing on the shore.',
        // The air number alone is not enough. This modpack reports 52/20 health,
        // and something in it drops oxygenLevel while the bot is standing in a
        // dry mineshaft -- Andy re-fired the drowning reflex every 5 seconds at
        // y=71 with air blocks at his legs and head, surfacing "successfully"
        // each time because he had never left the surface. A head in air cannot
        // be drowning whatever the number says. Names are only used to rule
        // drowning OUT, never in: kelp, seagrass and waterlogged slabs all drown
        // you without being called water, and all of them fail the air test.
        fn: (agent, a) => {
            if (agent.bot.oxygenLevel === undefined || agent.bot.oxygenLevel > (a.air ?? 12)) return false;
            const head = agent.bot.blockAt(agent.bot.entity.position.offset(0, agent.bot.entity.eyeHeight ?? 1.62, 0));
            return !!head && head.name !== 'air' && head.name !== 'cave_air';
        }
    },
    is_night: {
        args: { lead: 'number of ticks before nightfall to start saying yes (default 0). ~1500 gives the bot time to walk home before mobs are out.' },
        desc: 'It is night time.',
        fn: (agent, a) => world.isNight(agent.bot, a.lead ?? 0)
    },
    is_freezing: {
        args: {},
        desc: 'The bot is freezing: standing in powder snow, or out in snowfall in a cold biome. Freezing kills on this server and there is no freeze-meter reading to be had, so this fires on the cause rather than on damage already taken.',
        fn: (agent) => isFreezing(agent.bot)
    },
    is_sheltered: {
        args: {},
        desc: 'A solid block sits two or three above the bot\'s feet -- it is under a roof (a capped dig_in foxhole, a house, a cave). Gate night-shelter and flee rules on "not is_sheltered" so a bot already under cover does not dig deeper, prompt for shelter it already has, or climb out of a safe hole to flee something that cannot reach it.',
        fn: (agent) => {
            const p = agent.bot.entity.position.floored();
            for (const dy of [2, 3]) {
                const b = agent.bot.blockAt(p.offset(0, dy, 0));
                if (b && b.boundingBox === 'block') return true;
            }
            return false;
        }
    },
    is_idle: {
        args: {},
        desc: 'Bot has no current action or goal in progress.',
        fn: (agent) => agent.isIdle()
    },
    always: {
        args: {},
        desc: 'Always true. Use with is_idle or a cooldown for periodic behavior.',
        fn: () => true
    },
};

// ---------- action leaves ----------
// async (agent, args).  Run inside the ActionManager like any mode action.

export const ACTIONS = {
    flee: {
        cost: 'blocking', clears: ['hostile_nearby', 'entity_nearby', 'animal_nearby', 'player_nearby', 'at_position', 'at_death_position'],
        args: { distance: 'number (default 24)' },
        desc: 'Run away from all nearby enemies.',
        fn: async (agent, a) => await skills.avoidEnemies(agent.bot, a.distance ?? 24)
    },
    fight_back: {
        cost: 'blocking', clears: ['hostile_nearby', 'entity_nearby'],
        args: {},
        desc: 'Attack nearby hostile mobs until they are dead or gone.',
        fn: async (agent) => await skills.defendSelf(agent.bot, 8)
    },
    attack: {
        cost: 'blocking', clears: ['hostile_nearby', 'entity_nearby', 'animal_nearby'],
        args: { type: 'string mob type' },
        desc: 'Attack the nearest entity of the given type.',
        fn: async (agent, a) => await skills.attackNearest(agent.bot, a.type, true)
    },
    goto: {
        cost: 'blocking', clears: ['at_position', 'block_nearby', 'at_death_position'],
        args: { x: 'number', y: 'number', z: 'number', closeness: 'number (default 2)' },
        desc: 'Navigate to a position.',
        fn: async (agent, a) => await skills.goToPosition(agent.bot, a.x, a.y, a.z, a.closeness ?? 2)
    },
    remember_here: {
        cost: 'cheap', clears: ['place_known'],
        args: { name: 'string place name, e.g. "berries" or "herd"' },
        desc: 'Record where the bot is standing under a name, the free half of the remembered-spots loop. The expensive half is finding the spot at all -- a search or a prompt that ranged for minutes -- so a rule that fires this the moment the thing is in sight turns one paid discovery into a route goto_place can walk forever for nothing. Gate it on "not place_known" of the same name or it re-remembers every tick.',
        fn: (agent, a) => {
            const p = agent.bot.entity.position;
            agent.memory_bank.rememberPlace(a.name, p.x, p.y, p.z);
            skills.log(agent.bot, `Remembered this spot as "${a.name}".`);
            return true;
        }
    },
    goto_place: {
        cost: 'blocking', clears: ['at_position', 'block_nearby', 'at_death_position'],
        args: { name: 'string place name, as given to remember_here', closeness: 'number (default 2)' },
        desc: 'Walk to a remembered place. The free alternative to search_block/search_entity once the spot is known: no scanning, no prompt, just a path to a coordinate that paid off before. Gate on place_known -- with no such place this does nothing but log.',
        fn: async (agent, a) => {
            const p = agent.memory_bank.recallPlace(a.name);
            if (!p) {
                skills.log(agent.bot, `No location named "${a.name}" saved.`);
                return false;
            }
            return await skills.goToPosition(agent.bot, p[0], p[1], p[2], a.closeness ?? 2);
        }
    },
    goto_player: {
        cost: 'blocking', clears: ['player_nearby', 'at_position', 'at_death_position'],
        args: { name: 'string player name', closeness: 'number (default 3)' },
        desc: 'Go to a player.',
        fn: async (agent, a) => await skills.goToPlayer(agent.bot, a.name, a.closeness ?? 3)
    },
    follow_player: {
        cost: 'blocking', clears: ['player_nearby', 'at_position', 'at_death_position'],
        args: { name: 'string player name' },
        desc: 'Follow a player until interrupted.',
        fn: async (agent, a) => await skills.followPlayer(agent.bot, a.name, 4)
    },
    move_away: {
        // is_freezing belongs here for the same reason hostile_nearby does on
        // flee: walking out of the powder snow you are standing in, or out from
        // under the blizzard, is the thing that actually empties the freeze
        // meter. Like the others it is a partial clear -- you can walk from one
        // snowfield into another, just as you can flee into a second zombie --
        // but it is real progress rather than waiting, and waiting is the rule
        // shape this vocabulary exists to keep the model away from.
        cost: 'blocking', clears: ['hostile_nearby', 'entity_nearby', 'animal_nearby', 'player_nearby', 'at_position', 'block_nearby', 'at_death_position', 'is_freezing'],
        args: { distance: 'number (default 8)' },
        desc: 'Move away from the current position in any direction. Also the reflex for standing in something that is hurting you, like powder snow.',
        fn: async (agent, a) => await skills.moveAway(agent.bot, a.distance ?? 8)
    },
    stay: {
        cost: 'blocking', clears: ['is_night', 'is_idle'],
        args: { until: 'string flat condition, e.g. "not is_night" or "hunger_below 10 or hostile_nearby 8"', seconds: 'number, give up after (default -1: only the condition ends it)' },
        desc: 'Stay in place until the condition becomes true. Same conditions as "when", written flat with positional args. The cheap way to wait something out.',
        fn: async (agent, a) => {
            const { spec, error } = parseConditionExpr(a.until ?? '');
            if (error) { skills.log(agent.bot, `stay: ${error}`); return; }
            await skills.stay(agent.bot, a.seconds ?? -1, () => evalCondition(spec, agent), describeCondition(spec));
        }
    },
    go_to_surface: {
        cost: 'blocking', clears: ['drowning', 'at_position', 'block_nearby'],
        args: {},
        desc: 'Swim or climb up to the surface. Use for drowning or being stuck underground; never prompt_self for this.',
        // skills.goToSurface pathfinds to the highest block at x,z, which is the
        // wrong tool for a reflex: Andy sat in a one-block water hole for hours
        // logging "Unable to reach 2,71,-11, you are 1 blocks away" because the
        // non-destructive path out did not exist. skills.surface just holds jump
        // and digs the ceiling, which is what getting out of water actually is.
        fn: async (agent) => await skills.surface(agent.bot)
    },
    search_block: {
        cost: 'blocking', clears: ['block_nearby', 'at_position', 'at_death_position'],
        args: { type: 'string block name', range: 'number (default 64, max 512)' },
        desc: 'Find and go to the nearest block of a type, searching farther than collect. Family names ("log", "<x>_ore") match every variant.',
        fn: async (agent, a) => await skills.goToNearestBlock(agent.bot, a.type, 2, Math.min(a.range ?? 64, MAX_BLOCK_SEARCH))
    },
    search_entity: {
        cost: 'blocking', clears: ['entity_nearby', 'animal_nearby', 'at_position', 'at_death_position'],
        args: { type: 'string entity name, e.g. "cow"', range: 'number (default 64, max 512)' },
        desc: 'Find and go to the nearest entity of a type.',
        fn: async (agent, a) => await skills.goToNearestEntity(agent.bot, a.type, 2, Math.min(a.range ?? 64, 512))
    },
    collect: {
        cost: 'blocking', clears: ['has_item', 'block_nearby'],
        args: { type: 'string block name', num: 'number (default 1)' },
        desc: 'Collect blocks of a type within 64 blocks. Family names ("log", "<x>_ore") collect any variant. If none are that close, the rule simply collects nothing -- gate it on block_nearby so it does not retry forever.',
        fn: async (agent, a) => await skills.collectBlock(agent.bot, a.type, a.num ?? 1)
    },
    deposit: {
        cost: 'blocking', clears: ['has_item'],
        args: { item: 'string item name', num: 'number (default all)' },
        desc: 'Put items into the nearest chest (within 32 blocks). Use goto first to reach a specific chest. Family names deposit all variants: "log" is every wood\'s log.',
        fn: async (agent, a) => {
            const counts = world.getInventoryCounts(agent.bot);
            for (const name of mc.expandBlockName(a.item))
                if (counts[name])
                    await skills.putInChest(agent.bot, name, a.num ?? -1);
        }
    },
    // Crafting, smelting, placing and withdrawing had no action leaf, so every
    // rule that needed one had to spend an LLM turn asking itself to do a thing
    // it could already name exactly. That was 15 of the 23 prompt_self rules
    // across the shipped profiles -- each one a full generation, at a cooldown,
    // forever. The skills behind them are the same ones !craftRecipe,
    // !smeltItem, !placeHere and !takeFromChest call.
    craft: {
        cost: 'blocking', clears: ['has_item'],
        args: { item: 'string item name', num: 'number (default 1)' },
        desc: 'Craft an item, gathering intermediate crafts (planks, sticks) and using a nearby table if the recipe needs one. Prefer this over prompt_self for anything you can name: it costs nothing and cannot forget what it was doing.',
        fn: async (agent, a) => await skills.craftRecipe(agent.bot, a.item, a.num ?? 1)
    },
    smelt: {
        cost: 'blocking', clears: ['has_item'],
        args: { item: 'string item name, ores spelled "raw_iron" not "iron_ore"', num: 'number (default 1)' },
        desc: 'Smelt or cook an item in a nearby furnace. Gate on block_nearby furnace, and on having fuel.',
        fn: async (agent, a) => await skills.smeltItem(agent.bot, a.item, a.num ?? 1)
    },
    place: {
        cost: 'blocking', clears: ['block_nearby'],
        args: { block: 'string block name' },
        desc: 'Place one block where you are standing. Single blocks only -- a furnace, a chest, a torch, a crafting table.',
        fn: async (agent, a) => {
            const pos = agent.bot.entity.position;
            return await skills.placeBlock(agent.bot, a.block, pos.x, pos.y, pos.z);
        }
    },
    withdraw: {
        cost: 'blocking', clears: ['has_item', 'has_food'],
        args: { item: 'string item name', num: 'number (default all)' },
        desc: 'Take items out of the nearest chest (within 32 blocks). The mirror of deposit. Family names take all variants.',
        fn: async (agent, a) => {
            for (const name of mc.expandBlockName(a.item))
                if (await skills.takeFromChest(agent.bot, name, a.num ?? -1)) return true;
            return false;
        }
    },
    consume: {
        cost: 'cheap', clears: ['hunger_below', 'health_below', 'has_food', 'has_item'],
        args: { item: 'string item name, or omit to eat whatever food is in the bag' },
        desc: 'Eat or drink an inventory item.',
        fn: async (agent, a) => await skills.consume(agent.bot, a.item ?? '')
    },
    equip: {
        cost: 'cheap', clears: ['holding'],
        args: { item: 'string item name' },
        desc: 'Equip an inventory item.',
        fn: async (agent, a) => await skills.equip(agent.bot, a.item)
    },
    equip_weapon: {
        cost: 'cheap', clears: ['holding'],
        args: {},
        desc: 'Hold the best weapon in the inventory. Does nothing if it is already held, or if there is no weapon.',
        // "equip a weapon" spelled with the equip action needs the rule to name
        // one item, so it named wooden_sword while its guard accepted any of
        // five swords -- holding only a stone_sword it fired and failed every
        // 3 seconds. This picks by attack damage, which also covers the
        // modpack's swords that no hardcoded list would name.
        fn: async (agent) => await skills.equipHighestAttack(agent.bot)
    },
    go_to_bed: {
        cost: 'blocking', clears: ['is_night', 'at_position', 'at_death_position'],
        args: {},
        desc: 'Go to the nearest bed and sleep.',
        fn: async (agent) => await skills.goToBed(agent.bot)
    },
    dig_in: {
        // is_freezing: a capped hole is out of the snowfall, and digging down
        // exits powder snow -- both halves of what freezing means here.
        cost: 'blocking', clears: ['hostile_nearby', 'entity_nearby', 'at_position', 'is_freezing'],
        args: {},
        desc: 'Dig a three-deep foxhole where standing, cap the opening with a carried cover block and place a torch if one is carried. The named-action form of "improvise a shelter for the night" -- pair it with a stay until dawn. It never seals the sides, so breaking the cap overhead is always enough to get out. Reports failure (for the prompt fallback) only when it could not get all the way down.',
        fn: async (agent) => {
            const bot = agent.bot;
            // Three down, not two: after digging two the bot's head is at the
            // old surface level, so the cap spot is surrounded by open air and
            // there is nothing to place it against. At three deep the cap sits
            // where the surface block was, flush with solid ground on every
            // side. digDown already refuses lava, water and drops.
            if (!await skills.digDown(bot, 3)) return false;
            const p = bot.entity.position.floored();
            // ponytail: first carried non-falling cover block wins; no gravel or
            // sand, which would fall into the shaft onto the bot's head.
            const cover = bot.inventory.items().find(i =>
                /^(dirt|cobblestone|cobbled_deepslate|stone|netherrack|snow_block|.*planks|.*log)$/.test(i.name));
            if (cover) {
                try { await skills.placeBlock(bot, cover.name, p.x, p.y + 2, p.z, 'side'); } catch {}
            }
            if (bot.inventory.items().some(i => i.name === 'torch')) {
                try { await skills.placeBlock(bot, 'torch', p.x, p.y, p.z, 'bottom', true); } catch {}
            }
            return true;
        }
    },
    say: {
        cost: 'cheap', clears: [],
        args: { message: 'string' },
        desc: 'Say a message in chat.',
        fn: async (agent, a) => agent.openChat(a.message)
    },
    set_mode: {
        cost: 'cheap', clears: [],
        args: { mode: 'string mode name', on: 'boolean' },
        desc: 'Turn a built-in mode on or off.',
        fn: async (agent, a) => { if (agent.bot.modes.exists(a.mode)) agent.bot.modes.setOn(a.mode, a.on); }
    },
    prompt_self: {
        // NOT clears:'*'. Treating a prompt as able to resolve anything was an
        // escape hatch that let exactly the bug back in: self:shelter_build_if_needed
        // fired every 10s on is_night, and night lasts ~7 minutes, so it cancelled
        // the agent ~40 times a night to re-issue the same instruction -- including
        // interrupting its own attempts to dig out of the shelter it had just been
        // told to build. Asking the LLM to handle something does not change the
        // world; only what the LLM then does can, and the rule cannot promise that.
        cost: 'blocking', clears: [],
        args: { message: 'string instruction to yourself' },
        desc: 'LAST RESORT. Ask your own LLM reasoning to handle a situation no other action can express. Every fire costs a full generation in money and ~30 seconds of latency during which the agent does nothing else, so a rule that fires this on a cooldown is a standing bill. If you can name the item, the block or the place, use craft / smelt / place / collect / goto / withdraw instead -- those cost nothing and cannot forget what they were doing. Use it only where the answer genuinely depends on looking around and deciding: improvising a shelter, working out what is edible in this biome.',
        fn: null // dispatched outside the action wrapper; see Rule.run
    },
};

// ---------- validation & condition building ----------

// Actions that leave the world exactly as they found it. Fine as a reaction to
// something, useless as a standing habit.
// set_mode belongs here too. Modes are configuration, not behaviour: the policy
// has a "modes" block that sets them once, so a RULE that turns one on is a
// no-op repeated forever. Deleting the agent's one always-true set_mode rule
// taught it nothing -- it wrote eight separate ones to replace it, each
// {"when": {"cond": "always"}, "do": [{"act": "set_mode"}]}, and together they
// kept the arbiter executing something every tick. Sub-20ms actions
// back-to-back look exactly like a runaway loop to the ActionManager, which
// shut the agent down four times in twenty minutes.
const AIMLESS_ACTIONS = ['move_away', 'prompt_self', 'say', 'set_mode'];

// Does the trigger say anything about the world, or does it just mean "nothing
// is going on"? Idleness and the *absence* of something are the resting state,
// so a rule gated only on those fires forever. Seen live: "move freely when no
// hostiles are nearby" compiled to move_away(8) every 3 seconds, which walked
// the bot in circles and stomped every action it tried to start.
function hasPositiveTrigger(when, negated = false) {
    if (!when) return false;
    // Runs before validation now, so a malformed branch must not throw.
    if (when.all || when.any) {
        const branches = when.all ?? when.any;
        return Array.isArray(branches) && branches.some(c => hasPositiveTrigger(c, negated));
    }
    if (when.not) return hasPositiveTrigger(when.not, !negated);
    return !negated && !['is_idle', 'always'].includes(when.cond);
}

// Retreating from a mob is the cowardice mode's whole job, and it moves
// *away from* the threat. A rule that answers "hostile within N" with a plain
// move_away picks a random direction, so it can land back inside the same
// radius and fire again on the next tick. Seen live: avoid_hostile_areas
// (hostile within 24 -> move_away 16) walked Andy back and forth between two
// cave positions for hours.
// World scans are still synchronous and still cubic in range, so this stays a
// hard cap -- but it is a much cheaper cube now that matching compares state
// ids instead of building a Block per candidate (world.js findBlockPositions).
// Searching 256 for crops absent from the biome used to pin the process at ~92%
// CPU with no rules, chat or logs; that was the materializing scan, and 128 was
// too slow for the same reason. 128 is affordable now, and it is what makes a
// gathering rule useful in a biome where the food is not right next door.
// ponytail: still a hard cap. Chunk the scan across ticks before going wider.
const MAX_BLOCK_SEARCH = 128;

// The fastest cooldown any hand-written rule uses is the drowning reflex at 5s.
const MIN_INTERRUPT_COOLDOWN = 5;
const RETREAT_ACTIONS = ['move_away', 'flee'];
const PROXIMITY_CONDS = ['hostile_nearby', 'entity_nearby'];

function triggersOnProximity(when) {
    if (!when) return false;
    // Runs before validation now, so a malformed branch must not throw.
    if (when.all || when.any) {
        const branches = when.all ?? when.any;
        return Array.isArray(branches) && branches.some(triggersOnProximity);
    }
    if (when.not) return false; // "no mob nearby" is handled by hasPositiveTrigger
    return PROXIMITY_CONDS.includes(when.cond);
}

// is_night is the one condition no action can change -- you can only wait it
// out. So a rule gated on it re-fires every cooldown until morning, and if all
// it does is walk somewhere, arriving leaves the agent idle at the destination
// with the rule still eligible. Seen live: go_to_chest_at_night (is_night ->
// goto base, cooldown 3) fired 176 times in 15 minutes, flapping the status
// between "stopped" and the rule name. The fix is to park with "stay".
function triggersOnNight(when) {
    if (!when) return false;
    if (when.all || when.any) return (when.all ?? when.any).some(triggersOnNight);
    if (when.not) return false;
    return when.cond === 'is_night';
}

// Largest is_night lead anywhere in a condition tree, or -1 if it mentions none.
function nightLead(spec) {
    if (!spec) return -1;
    if (spec.all || spec.any) return Math.max(...(spec.all ?? spec.any).map(nightLead));
    if (spec.not) return nightLead(spec.not);
    return spec.cond === 'is_night' ? (spec.lead ?? 0) : -1;
}


// Args that name something the world has to actually contain. A rule naming a
// thing the registry has never heard of does not error -- it silently never
// matches -- so this is the one class of mistake the validator has to catch by
// looking things up rather than by reasoning about shape.
// "weapon" is a family this module defines rather than a registry entry, and
// entity names are not items, so both are exempt.
const NAMED_THINGS = {
    has_item: 'item', block_nearby: 'name',
    collect: 'type', deposit: 'item', withdraw: 'item',
    craft: 'item', smelt: 'item', place: 'block', equip: 'item',
    search_block: 'type',
};
const NAME_EXEMPT = new Set(['weapon']);

// Walks a condition tree and a do-list, returning a complaint about the first
// name that means nothing here.
function unknownName(rule) {
    const check = (kind, name) => {
        if (typeof name !== 'string' || NAME_EXEMPT.has(name) || mc.isKnownName(name)) return null;
        return `Rule "${rule.name}": ${kind} names "${name}", which does not exist in this world -- ` +
            'no item or block matches it, so the rule can never fire. Check the spelling against what ' +
            'the server actually calls it (modded names are namespaced, like "frostiful:chillager"), ' +
            'and remember that "sword" is not a family name: use "weapon" for any sword or axe.';
    };
    const walkCond = (spec) => {
        if (!spec || typeof spec !== 'object') return null;
        if (Array.isArray(spec.all)) return spec.all.map(walkCond).find(Boolean) ?? null;
        if (Array.isArray(spec.any)) return spec.any.map(walkCond).find(Boolean) ?? null;
        if (spec.not) return walkCond(spec.not);
        const arg = NAMED_THINGS[spec.cond];
        return arg ? check(spec.cond, spec[arg]) : null;
    };
    const cond_err = walkCond(rule.when);
    if (cond_err) return cond_err;
    for (const step of rule.do ?? []) {
        const arg = NAMED_THINGS[step?.act];
        const err = arg ? check(step.act, step[arg]) : null;
        if (err) return err;
    }
    return null;
}

export function validatePolicy(policy) {
    if (!policy || typeof policy !== 'object') return 'Policy must be a JSON object.';
    if (policy.goal !== undefined && (typeof policy.goal !== 'string' || !policy.goal.trim()))
        return 'A policy "goal" must be a non-empty string.';
    if (policy.modes) {
        for (let m in policy.modes)
            if (typeof policy.modes[m] !== 'boolean') return `modes.${m} must be boolean.`;
    }
    if (!Array.isArray(policy.rules)) return 'Policy must have a "rules" array.';
    const names = new Set();
    for (let rule of policy.rules) {
        if (!rule.name || typeof rule.name !== 'string') return 'Each rule needs a string "name".';
        if (names.has(rule.name)) return `Duplicate rule name "${rule.name}".`;
        names.add(rule.name);
        const condErr = validateCondition(rule.when);
        if (condErr) return `Rule "${rule.name}": ${condErr}`;
        if (!Array.isArray(rule.do) || rule.do.length === 0) return `Rule "${rule.name}" needs a non-empty "do" array.`;
        for (let step of rule.do) {
            if (!step.act || !ACTIONS[step.act])
                return `Rule "${rule.name}": unknown action "${step?.act}". Valid: ${Object.keys(ACTIONS).join(', ')}`;
            if (step.act === 'stay') {
                const { spec, error } = parseConditionExpr(step.until ?? '');
                if (error) return `Rule "${rule.name}": stay needs a valid "until" condition (a stay with no exit parks the bot forever): ${error}`;
                // Trigger at dusk, park until dawn: the two have to agree on
                // where night starts. "is_night 1500" fires at tick 11500, but
                // "until not is_night" is already true at 11500, so the stay
                // ends the tick it begins and the bot wanders back out. The log
                // says "Not staying, not is_night already" and nothing else.
                const lead = nightLead(rule.when), stay_lead = nightLead(spec);
                if (lead > 0 && stay_lead >= 0 && stay_lead < lead)
                    return `Rule "${rule.name}": the trigger says night starts ${lead} ticks early but the stay ` +
                        `uses ${stay_lead}, so "${step.until}" is already true when the rule fires and the stay ` +
                        `ends immediately. Write it as "not is_night ${lead}".`;
            }
        }
        if (rule.interrupts && !['all', 'idle'].includes(rule.interrupts))
            return `Rule "${rule.name}": "interrupts" must be "all" or "idle".`;
        // ponytail: no cap on how many rules a layer pins. If an agent starts
        // pinning everything and starves a person's job rules, cap pinned rules
        // in the self layer where !policy writes it.
        if (rule.pinned !== undefined && typeof rule.pinned !== 'boolean')
            return `Rule "${rule.name}": "pinned" must be true or false.`;
        if (!hasPositiveTrigger(rule.when) && rule.do.every(step => AIMLESS_ACTIONS.includes(step.act)))
            return `Rule "${rule.name}" fires whenever nothing is happening but only does ${rule.do.map(s => s.act).join('/')}. ` +
                'Doing nothing is the agent\'s resting state, so this rule would fire forever and starve every real action. ' +
                'Give it a trigger that is actually about the world, or an action that makes progress.' +
                (rule.do.every(s => s.act === 'set_mode')
                    ? ' Modes are configuration, not a reflex: put them in the policy\'s "modes" block, which sets them once.'
                    : '');
        if (triggersOnNight(rule.when) && rule.do.every(step => step.act === 'goto'))
            return `Rule "${rule.name}" walks somewhere every time it fires and it fires all night, because ` +
                'arriving does not make it stop being night. The agent will re-path to the same spot every ' +
                `${rule.cooldown ?? 3} seconds until morning. Add {"act": "stay", "until": "not is_night"} after ` +
                'the goto so it parks there instead.';
        // "Shelter" that is really standing still in the open until the mob leaves.
        // Waiting cannot make a mob go away, so the stay only ends when the mob
        // wanders off on its own -- and the rule fires again the moment it returns.
        for (const step of rule.do) {
            if (step.act !== 'stay' || typeof step.until !== 'string') continue;
            const waits_out_mobs = /\bnot\s+(hostile_nearby|entity_nearby)\b/.test(step.until);
            if (waits_out_mobs && !rule.do.some(s => RETREAT_ACTIONS.includes(s.act)))
                return `Rule "${rule.name}" waits until no mob is nearby but never moves, so it stands still ` +
                    'in the open until the mob happens to wander off. Standing still does not make a mob leave. ' +
                    'Either add {"act": "flee"} before the stay, or end the stay on something the agent can ' +
                    'actually reach, like "not is_night".';
        }
        // Checked after the more specific diagnoses above, so a rule that is really
        // the cowardice mode is told that rather than being told to slow down.
        // Andy wrote himself a pinned interrupts:all rule with cooldown 1: its
        // trigger was "night OR a mob within 16", so it re-fired every second in
        // broad daylight and cancelled every action he started, the sheep search
        // included. A rule that cancels everything must give what it cancelled time
        // to make progress. 5s is the fastest any hand-written rule here uses --
        // the drowning reflex -- so this rejects runaway rules, not urgent ones.
        if (triggersOnProximity(rule.when) && rule.do.every(step => RETREAT_ACTIONS.includes(step.act)))
            return `Rule "${rule.name}" retreats whenever a mob is nearby, which is exactly what the built-in ` +
                'cowardice mode does, and it does it better: move_away picks a random direction, so the bot can ' +
                'land back inside the same radius and retreat again forever. Set {"cowardice": true} in "modes" ' +
                'instead, and only write a rule here if it does something cowardice cannot.';
        if (rule.interrupts === 'all' && (rule.cooldown ?? 3) < MIN_INTERRUPT_COOLDOWN)
            return `Rule "${rule.name}" cancels whatever the agent is doing and does it every ` +
                `${rule.cooldown ?? 3} seconds. Nothing else can ever finish. An "interrupts": "all" rule needs ` +
                `a cooldown of at least ${MIN_INTERRUPT_COOLDOWN} seconds; use "idle" if it is not urgent enough for that.`;
    }
    for (const rule of policy.rules) {
        const loop = livelockRisk(rule);
        if (loop) return loop;
        const unknown = unknownName(rule);
        if (unknown) return unknown;
    }
    const dupe = findDuplicateRule(policy.rules);
    if (dupe) return dupe;
    return null;
}

// The livelock that kept reappearing, in three disguises: flee+consume with no
// food, go_to_bed with no bed, stay-until-the-mob-leaves. Every one was a rule
// that cancels everything (interrupts: all), runs something long, and cannot
// change the thing that set it off -- so it fires, destroys whatever was running,
// achieves nothing, and fires again on the next cooldown.
//
// Cheap actions are exempt, and that exemption is the whole reason the actions
// carry a "cost". hold_weapon_when_threatened triggers on hostile_nearby and
// equips a weapon, which does not make the mob leave either -- but equipping
// finishes in a tick and re-running it when the weapon is already held does
// nothing, so firing it every 6 seconds costs nothing and interrupts nothing
// real. go_to_bed is a journey: cancelled halfway it has achieved nothing, and a
// journey that restarts every cooldown never arrives.
function livelockRisk(rule) {
    if (rule.interrupts !== 'all') return null;          // idle rules wait their turn by definition
    const blocking = rule.do.filter(s => ACTIONS[s.act]?.cost === 'blocking');
    if (blocking.length === 0) return null;              // cheap prep is free to repeat
    const clears = new Set();
    for (const step of rule.do) {
        const c = ACTIONS[step.act]?.clears;
        if (c === '*') return null;                      // prompt_self delegates to general reasoning
        for (const cond of c ?? []) clears.add(cond);
    }
    const unclearable = [...new Set(unstoppable(rule.when, clears))];
    if (unclearable.length === 0) return null;
    const acts = blocking.map(s => s.act).join(', ');
    return `Rule "${rule.name}" fires on ${unclearable.join(' / ')}, cancels whatever the agent is doing, and ` +
        `runs ${acts} -- none of which can change ${unclearable.length > 1 ? 'those conditions' : 'that condition'}. ` +
        'So it interrupts, achieves nothing, and fires again next cooldown, forever. Either add an action that ' +
        `actually resolves ${unclearable.join(' / ')}, gate the rule on being able to (has_food, has_item), or ` +
        'make it "interrupts": "idle" so it waits for a gap instead of taking one.';
}

// Conditions that can keep this rule firing no matter what it does. Empty means
// the rule can stop itself.
//   any: any single branch re-fires it, so EVERY branch must be answerable.
//   all: needs every branch true, so clearing ONE branch is enough to stop it.
function unstoppable(when, clears) {
    if (!when || typeof when !== 'object') return [];
    if (when.not) return unstoppable(when.not, clears);
    if (Array.isArray(when.any)) return when.any.flatMap(w => unstoppable(w, clears));
    if (Array.isArray(when.all)) {
        const branches = when.all.map(w => unstoppable(w, clears));
        return branches.some(b => b.length === 0) ? [] : branches.flat();
    }
    // is_idle stops the moment the rule acts; always is caught by its own check.
    if (['is_idle', 'always'].includes(when.cond)) return [];
    return clears.has(when.cond) ? [] : [when.cond];
}

// Numbers are tuning, names are meaning. Two rules that watch the same conditions
// and take the same actions are the same rule whether the range is 16 or 20, but
// "deposit cobblestone when you have 128" and "deposit cooked_beef when you have
// 24" are genuinely different jobs. So the signature keeps strings and drops
// numbers -- and keeps "interrupts", which is what separates the emergency
// version of a rule from the opportunistic one (eat_when_starving vs
// eat_before_hungry are both hunger_below -> consume, and both belong).
function ruleShape(node) {
    if (Array.isArray(node)) return node.map(ruleShape);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const k of Object.keys(node).sort()) {
        const v = node[k];
        if (typeof v === 'number' || typeof v === 'boolean') continue;
        out[k] = ruleShape(v);
    }
    return out;
}

// Told to shelter at night, the policy compiler wrote night_mobs_go_to_bed_or_shelter
// AND low_light_shelter_priority: same trigger, same action, ranges 20 and 16.
// Both fired, both cancelled whatever was running, and neither did anything the
// other did not. Rejecting the pair is also the honest answer to "the name says
// night but it fired at noon" -- one rule can be named for what it does.
function findDuplicateRule(rules) {
    const seen = new Map();
    for (const rule of rules) {
        const sig = JSON.stringify({
            interrupts: rule.interrupts ?? 'idle',
            when: ruleShape(rule.when),
            do: ruleShape(rule.do),
        });
        const first = seen.get(sig);
        if (first)
            return `Rules "${first}" and "${rule.name}" are the same rule: same trigger, same actions, ` +
                'differing only in numbers. Both will fire and both will interrupt whatever is running, ' +
                'for no extra effect. Keep one, with whichever thresholds you meant, and delete the other.';
        seen.set(sig, rule.name);
    }
    return null;
}

// "a mob is near, so retreat" is the cowardice mode written out longhand, and
// the compiler kept writing it: a third of every failed compile, three LLM
// attempts each, because the instruction that prompted it ("keep away from
// zombies") really does mean cowardice and the model has nowhere else to put
// it. The rewrite is mechanical and the validator already knows it, so do it
// here rather than spend three round trips asking.
// A third of the compiler's failures were the model losing count of its own
// braces mid-rule -- never truncation, always a stray "}" or an array element
// with nothing opening it. Asking again fixed it only sometimes, because it is
// a sampling accident, not a reasoning error. Handing the backend a schema
// makes the malformed token unreachable instead of merely unwelcome. This
// covers shape only; which conditions and actions exist is validatePolicy's
// job, and keeping that out of here keeps the grammar small.
export const POLICY_SCHEMA = {
    type: 'object',
    properties: {
        modes: { type: 'object' },
        goal: { type: 'string' },
        rules: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    description: { type: 'string' },
                    when: { type: 'object' },
                    do: { type: 'array', items: { type: 'object' } },
                    interrupts: { type: 'string', enum: ['all', 'idle'] },
                    cooldown: { type: 'number' },
                    pinned: { type: 'boolean' }
                },
                required: ['name', 'description', 'when', 'do']
            }
        }
    },
    required: ['rules']
};

export function repairPolicy(policy) {
    if (!Array.isArray(policy?.rules)) return policy;
    const isCowardice = (r) => triggersOnProximity(r?.when)
        && Array.isArray(r.do) && r.do.length > 0
        && r.do.every(step => RETREAT_ACTIONS.includes(step?.act));
    const isAimless = (r) => Array.isArray(r?.do) && r.do.length > 0
        && !hasPositiveTrigger(r.when)
        && r.do.every(step => AIMLESS_ACTIONS.includes(step?.act));
    let cowardice = false, changed = false;
    const rules = [];
    for (let rule of policy.rules) {
        // Before anything else looks at "when": every check below reads the
        // condition tree, so a leaf the model shaped wrong would otherwise make
        // isCowardice/isAimless/livelockRisk quietly answer about a rule that
        // isn't the one the model meant.
        const normalized = normalizeCondition(rule?.when);
        if (JSON.stringify(normalized) !== JSON.stringify(rule?.when)) {
            rule = { ...rule, when: normalized };
            changed = true;
        }
        if (isCowardice(rule)) { cowardice = changed = true; continue; }
        // Nothing here can invent the world-facing trigger this rule needs, and
        // a rule that fires forever on "nothing is happening" starves every real
        // action. Dropping it costs one instruction; keeping it cost the whole
        // policy, since one such rule rejected all the others with it. The agent
        // is told what it ended up with, so the loss is visible rather than silent.
        if (isAimless(rule)) { changed = true; continue; }
        // A rule that cancels everything to run something which cannot end its
        // own trigger is the livelock livelockRisk() describes, and the third
        // fix it offers is the one that needs no judgement: let the rule wait
        // for a gap instead of taking one. That keeps the rule the instruction
        // asked for, where rejecting the policy kept nothing.
        if (Array.isArray(rule.do) && livelockRisk(rule)) {
            rule = { ...rule, interrupts: 'idle' };
            changed = true;
        }
        // An interrupting rule that repeats faster than the floor never lets
        // what it cancelled finish. The floor is the fix and the whole fix.
        if (rule.interrupts === 'all' && (rule.cooldown ?? 3) < MIN_INTERRUPT_COOLDOWN) {
            rule = { ...rule, cooldown: MIN_INTERRUPT_COOLDOWN };
            changed = true;
        }
        rules.push(rule);
    }
    // Same trigger, same actions, different numbers: the second one adds nothing
    // and interrupts as much as the first. Keeping the earlier one matches what
    // findDuplicateRule asks for, and is done last so the repairs above (which
    // can change "interrupts") settle before anything is compared.
    const seen = new Set();
    const deduped = rules.filter(rule => {
        const sig = JSON.stringify({
            interrupts: rule.interrupts ?? 'idle',
            when: ruleShape(rule.when),
            do: ruleShape(rule.do),
        });
        if (seen.has(sig)) { changed = true; return false; }
        seen.add(sig);
        return true;
    });
    if (!changed) return policy;
    return {
        ...policy,
        modes: cowardice ? { ...policy.modes, cowardice: true } : policy.modes,
        rules: deduped,
    };
}

// Four ways the compiler's model malformed a condition leaf, live, repeatedly:
//   {"cond": {"cond": "is_night"}}      -> "unknown condition [object Object]"
//   {"condition": "hostile_nearby"}     -> "unknown condition undefined"
//   {"is_night": {"lead": 1500}}        -> "unknown condition undefined"
//   {"all": {"cond": "..."}}            -> '"all" must be an array'
// None of them is a reasoning error -- the intent is unambiguous in every case
// -- but each cost a full retry, and three of them cost the whole !policy call.
// Rewriting them here is cheaper than asking the model again.
export function normalizeCondition(spec) {
    if (!spec || typeof spec !== 'object') return spec;
    for (const key of ['all', 'any']) {
        if (spec[key] === undefined) continue;
        const branches = Array.isArray(spec[key]) ? spec[key] : [spec[key]];
        return { ...spec, [key]: branches.map(normalizeCondition) };
    }
    if (spec.not !== undefined) return { ...spec, not: normalizeCondition(spec.not) };
    // A leaf that wrapped itself one level too deep.
    if (spec.cond && typeof spec.cond === 'object') return normalizeCondition(spec.cond);
    if (spec.cond) return spec;
    // The name under some other key, or as the key itself.
    for (const alias of ['condition', 'name', 'type']) {
        if (typeof spec[alias] === 'string' && CONDITIONS[spec[alias]]) {
            const { [alias]: _drop, ...rest } = spec;
            return { ...rest, cond: spec[alias] };
        }
    }
    const keys = Object.keys(spec);
    if (keys.length === 1 && CONDITIONS[keys[0]]) {
        const args = spec[keys[0]];
        return { cond: keys[0], ...(args && typeof args === 'object' ? args : {}) };
    }
    return spec;
}

export function validateCondition(spec) {
    if (!spec || typeof spec !== 'object') return 'missing "when" condition.';
    if (spec.all) return Array.isArray(spec.all) ? spec.all.map(validateCondition).find(e => e) ?? null : '"all" must be an array.';
    if (spec.any) return Array.isArray(spec.any) ? spec.any.map(validateCondition).find(e => e) ?? null : '"any" must be an array.';
    if (spec.not) return validateCondition(spec.not);
    if (!spec.cond || !CONDITIONS[spec.cond])
        return `unknown condition "${spec?.cond}". Valid: ${Object.keys(CONDITIONS).join(', ')}`;
    return null;
}

// The command parser only accepts numbers, booleans and quote-free strings, so
// a condition reaching a command cannot be JSON the way a policy rule's is.
// Same vocabulary, written flat: "not is_night", "health_below 10",
// "has_item bread 5", "hostile_nearby 8 and health_below 6". Args are
// positional, in the order CONDITIONS lists them, and may be omitted to default.
export function parseConditionExpr(expr) {
    if (typeof expr !== 'string' || !expr.trim()) return { error: 'empty condition.' };
    // "or" binds loosest, "and" tightest, as everywhere else: "a and b or c"
    // is (a and b) or c. Refusing the mixed form instead was costing three LLM
    // calls a time -- the model writes "not is_night 1500 or not hostile_nearby
    // 8" unprompted, gets told to pick one, and picks the wrong one.
    const orParts = expr.split(/ or /);
    const branches = [];
    for (const orPart of orParts) {
        const terms = orPart.split(/ and /);
        const specs = [];
        for (let term of terms) {
            // Accept the form describeCondition PRINTS -- "entity_nearby(name=stray,
            // range=24)" -- as well as the flat "entity_nearby stray 24".
            //
            // The model kept writing the parenthesised form into stay "until"
            // strings and being told the condition was unknown, three times in
            // one window. It was not inventing a syntax: that is the syntax we
            // show it, in describePolicy output and in every rule description it
            // reads back. Printing one grammar and parsing another is our bug,
            // and the model paid for it one retry at a time.
            const call = term.trim().match(/^(not\s+)?([a-z_]+)\s*\(([^)]*)\)$/i);
            if (call) {
                const [, neg, name, arglist] = call;
                const def = CONDITIONS[name];
                if (!def) return { error: `unknown condition "${name}". Valid: ${Object.keys(CONDITIONS).join(', ')}` };
                const spec = { cond: name };
                for (const pair of arglist.split(',').map(s => s.trim()).filter(Boolean)) {
                    const [key, ...rest] = pair.split('=');
                    const raw = rest.join('=').trim();
                    if (!rest.length) return { error: `"${name}" takes named arguments like (${Object.keys(def.args)[0] ?? 'arg'}=value), got "${pair}".` };
                    const argName = key.trim();
                    if (!(argName in def.args)) return { error: `"${name}" has no argument "${argName}". Valid: ${Object.keys(def.args).join(', ') || 'none'}` };
                    spec[argName] = isNaN(Number(raw)) ? raw : Number(raw);
                }
                specs.push(neg ? { not: spec } : spec);
                continue;
            }
            const words = term.trim().split(/\s+/).filter(Boolean);
            if (!words.length) return { error: 'empty condition.' };
            const negated = words[0] === 'not';
            if (negated) words.shift();
            const name = words.shift();
            const def = CONDITIONS[name];
            if (!def) return { error: `unknown condition "${name}". Valid: ${Object.keys(CONDITIONS).join(', ')}` };
            const argNames = Object.keys(def.args);
            if (words.length > argNames.length)
                return { error: `"${name}" takes at most ${argNames.length} args (${argNames.join(', ')}), got ${words.length}.` };
            const spec = { cond: name };
            words.forEach((w, i) => { spec[argNames[i]] = isNaN(Number(w)) ? w : Number(w); });
            specs.push(negated ? { not: spec } : spec);
        }
        branches.push(specs.length === 1 ? specs[0] : { all: specs });
    }
    return { spec: branches.length === 1 ? branches[0] : { any: branches } };
}

// One line per condition, for command docs.
export function conditionDocs() {
    return Object.entries(CONDITIONS)
        .map(([name, c]) => `${name}${Object.entries(c.args).map(([a, d]) => ` <${a}: ${d}>`).join('')} - ${c.desc}`)
        .join('\n');
}

// Readable form of a condition, for logs the bot reads back to itself.
export function describeCondition(spec) {
    if (spec.all) return spec.all.map(describeCondition).join(' and ');
    if (spec.any) return spec.any.map(describeCondition).join(' or ');
    if (spec.not) return 'not ' + describeCondition(spec.not);
    const args = Object.entries(spec).filter(([k]) => k !== 'cond');
    return spec.cond + (args.length ? `(${args.map(([k, v]) => `${k}=${v}`).join(', ')})` : '');
}

export function evalCondition(spec, agent) {
    if (spec.all) return spec.all.every(c => evalCondition(c, agent));
    if (spec.any) return spec.any.some(c => evalCondition(c, agent));
    if (spec.not) return !evalCondition(spec.not, agent);
    return !!CONDITIONS[spec.cond].fn(agent, spec);
}

// ---------- rule runtime ----------

// A prompt_self costs a whole LLM turn, and six rules could dispatch one in the
// same arbiter pass -- each of them a "new message" that discarded the previous
// one's half-finished answer. The arbiter walks rules in priority order (pinned
// first, then layer), so the first one to ask in a pass gets it and the rest
// wait for their own cooldown to bring them back.
const PROMPT_TICK_MS = 300; // the arbiter's update interval

export class Rule {
    constructor(spec) {
        this.spec = spec;
        this.name = 'policy:' + spec.name;
        this.description = spec.description ?? spec.name;
        this.interrupts = spec.interrupts === 'idle' ? [] : ['all'];
        // Pinned is already how a rule says "this one keeps me alive". Reuse it
        // as the answer to "may this cancel an action that was about to finish?"
        // -- so flee/eat/surface take the slot instantly, while an unpinned rule
        // waits the moment out rather than throwing away a nearly-done collect.
        this.urgent = !!spec.pinned;
        this.on = true;
        this.paused = false;
        this.active = false;
        this.autonomous = true; // completing needs no explanation to the model
        this.cooldown = (spec.cooldown ?? 3) * 1000;
        this.last_fire = 0;
        this.last_eval = 0;
        this.backoff = 1;
    }

    eligible(agent) {
        const now = Date.now();
        if (now - this.last_fire < this.cooldown * this.backoff) return false;
        // Conditions are not free: block_nearby is a synchronous world scan, and
        // the cooldown above only throttles rules that actually FIRE, so a rule
        // whose condition is never satisfied re-scanned the world on every one
        // of the 3.3 ticks per second, forever. Six block_nearby(32) clauses in
        // one unsatisfiable rule pinned the process at 100% CPU and starved
        // everything else. Evaluating faster than we could act is pointless, so
        // the cooldown gates evaluation too.
        if (now - this.last_eval < this.cooldown * this.backoff) return false;
        this.last_eval = now;
        const fires = evalCondition(this.spec.when, agent);
        // Decay, not reset. Resetting to 1 on a single false evaluation looked
        // right -- the situation is over, start fresh -- but it silently undid
        // the backoff for exactly the rules that need it most: the ones whose
        // trigger flaps. hold_weapon_when_threatened fires on a mob being
        // nearby, so the mob stepping out of range for one tick wiped the
        // penalty, and it went on firing every few seconds at an inventory with
        // no weapon in it. Halving recovers a genuinely resolved situation in a
        // few evaluations while a flapping one keeps most of what it earned.
        if (!fires) this.backoff = Math.max(1, this.backoff / 2);
        return fires;
    }

    // Called by the ModeController arbiter via the same execute() path as
    // built-in modes. Runs all steps sequentially as one action; prompt_self
    // steps are collected and dispatched after the action completes so they
    // don't re-enter the ActionManager while it is executing.
    async update(agent, execute) {
        if (!this.eligible(agent)) return;
        const prompts = [];
        const steps = this.spec.do.filter(s => s.act !== 'prompt_self');
        this.spec.do.filter(s => s.act === 'prompt_self').forEach(s => prompts.push(s.message));
        // Only steps go through execute(), the arbiter that honours "interrupts".
        // A rule whose whole "do" is prompt_self has no steps, so its prompts
        // used to dispatch straight into whatever was running -- every one of
        // the 12 prompt-only rules declared "interrupts": "idle" and none of
        // them meant it. Honour it here, where the arbiter cannot.
        if (steps.length === 0 && this.interrupts.length === 0 && !agent.isIdle()) return;
        if (prompts.length > 0) {
            const now = Date.now();
            if (now - (agent._last_prompt_dispatch ?? 0) < PROMPT_TICK_MS) return;
            agent._last_prompt_dispatch = now;
        }
        this.last_fire = Date.now();
        // Step rules also get "EVT mode:fire:policy:<name>" via the arbiter;
        // this line is the one that covers prompt-only rules too.
        console.log(`EVT rule:fire:${this.spec.name}`);
        if (steps.length > 0) {
            // A rule whose condition it cannot change and whose action always
            // fails re-fires forever and keeps the agent busy, which starves the
            // reasoning loop that could actually fix the situation. Seen live:
            // Andy with no pickaxe, standing on stone, running collect(stone) ->
            // "Don't have right tools" a few times a second for an entire day
            // while the goal loop never got a turn to craft the pickaxe.
            // Skills return false when they accomplish nothing, so double the
            // rule's cooldown each time that happens and reset on any success.
            let progress = false;
            // A "stay until dawn" that the 2-minute watchdog kills at 120s is
            // not a night's shelter -- it is a nap. sleep_at_night timed out 431
            // times in one log, re-firing every 60s cooldown, so the bot bounced
            // awake in the open all night. A stay carries its own exit condition,
            // so the rule that contains one gets no watchdog.
            const has_exit = steps.some(s => s.act === 'stay' && s.until);
            await execute(this, agent, async () => {
                for (let step of steps) {
                    if (agent.bot.interrupt_code) return;
                    // A step that throws must not take the rest of the rule with
                    // it. shelter_at_night is [goto base, stay until dawn], and
                    // goto threw "No path to the goal" every single night, so the
                    // stay -- the step that actually keeps the bot alive -- never
                    // ran. Andy stood in the open until something killed him, and
                    // since nothing reported progress the rule's backoff doubled
                    // until it was only trying twice an hour.
                    try {
                        if (await ACTIONS[step.act].fn(agent, step) !== false) progress = true;
                    } catch (err) {
                        skills.log(agent.bot, `Rule '${this.spec.name}' step ${step.act} failed: ${err.message}`);
                    }
                }
            }, has_exit ? 0 : undefined);
            // ponytail: capped at ~17 min so a rule that starts working again is
            // not dead forever. Per-step backoff if one bad step ever masks a
            // good one in the same rule.
            this.backoff = progress ? 1 : Math.min(this.backoff * 2, 200);
        } else {
            // Nothing here reports progress, so the step backoff above never
            // applies and a prompt-only rule repeats at its cooldown forever --
            // one fired 959 times in a session. Asking again while the trigger
            // is still true means the last ask did not work, so slow down.
            // eligible() resets this the moment the trigger goes false.
            this.backoff = Math.min(this.backoff * 2, 200);
        }
        for (let message of prompts)
            agent.handleMessage('system', `(POLICY RULE '${this.spec.name}') ${message}`);
    }
}

// ---------- persistence ----------

function policyPath(agentName) {
    return `./bots/${agentName}/policy.json`;
}

// Standing instructions live in two runtime layers so the agent's own notes can
// never wipe out a person's. It replaced its survival policy with a note about
// preferred planks twice in one hour; the second time it died 26 times in 6
// minutes, respawning into zombies with no rule left telling it to flee or
// shelter. Self-issued writes are still confined to the "self" layer and never
// touch "active", so there is nothing for a note-to-self to overwrite.
//
// "active" is what a person set: one policy generated by merging a base profile
// with any number of attribute profiles (see generatePolicy). "self" is what the
// agent worked out for itself, and it now sits on TOP -- the agent watching its
// own deaths knows things the profile author did not. A person still has the
// last word through pinning: pinned rules outrank unpinned ones from any layer.
// Among pinned rules RULE_ORDER decides, which now means a self pin outranks a
// person's pin; that is accepted, since only survival rules should be pinned.
export const LAYERS = ['active', 'self'];

// Modes later in this list win; rules earlier in the composed list win.
const MODE_ORDER = ['active', 'self'];
const RULE_ORDER = ['self', 'active'];

// The agent appends to its own layer unprompted. Without a cap the joined
// source grows until the compile prompt is mostly stale notes.
export const SELF_SOURCE_CAP = 8;

function emptyState() {
    return { layers: {}, locked: false, compose: null };
}

// The active layer is generated, so remember what it was generated from:
// {base, attributes, generated_at}. Without it "regenerate with one more
// attribute" would mean retyping the whole recipe every time.
function migrateBaseLayer(layers) {
    if (!layers?.base) return layers ?? {};
    const { base, ...rest } = layers;
    // Three layers became two. The old active outranked base, so when both
    // exist the base is what loses; alone, it simply becomes the active policy.
    if (!rest.active) rest.active = base;
    return rest;
}

// Old flat files were {source, policy, user_set}. A person's went to what is
// now the active layer; the agent's own to self. Missing user_set predates the
// field and was always a person's.
function migrateFlat(saved) {
    const state = emptyState();
    const layer = saved.user_set === false ? 'self' : 'active';
    state.layers[layer] = {
        profile: null,
        source: typeof saved.source === 'string' ? [saved.source] : (saved.source ?? []),
        policy: saved.policy,
    };
    return state;
}

export function loadPolicyState(agentName) {
    try {
        if (!existsSync(policyPath(agentName))) return emptyState();
        const saved = JSON.parse(readFileSync(policyPath(agentName), 'utf8'));
        if (saved?.layers) {
            const layers = migrateBaseLayer(saved.layers);
            for (const layer of Object.keys(layers))
                if (!LAYERS.includes(layer)) delete layers[layer];
            return { layers, locked: !!saved.locked, compose: saved.compose ?? null };
        }
        if (saved?.policy) return migrateFlat(saved);
        return emptyState();
    } catch (err) {
        console.error('Failed to load policy:', err);
        return emptyState();
    }
}

// Bumped on every write, so a slow writer can tell whether anything else has
// changed the policy since it started. Nothing reads it for meaning -- only for
// inequality. See the generate-policy handler in mindserver_proxy.js.
export function savePolicyState(agentName, state) {
    mkdirSync(`./bots/${agentName}`, { recursive: true });
    const revision = (policyRevision(agentName) ?? 0) + 1;
    writeFileSync(policyPath(agentName), JSON.stringify({
        layers: state.layers ?? {},
        locked: !!state.locked,
        compose: state.compose ?? null,
        revision,
    }, null, 2));
    return revision;
}

// Current revision, or 0 when there is no policy file yet. Deliberately reads
// the file rather than trusting an in-memory copy: the point is to notice writes
// this process did not make.
export function policyRevision(agentName) {
    try {
        return JSON.parse(readFileSync(policyPath(agentName), 'utf8')).revision ?? 0;
    } catch {
        return 0;
    }
}

export function deletePolicyLayer(state, layer) {
    delete state.layers[layer];
    return state;
}

export function clearPolicyState(agentName) {
    try { unlinkSync(policyPath(agentName)); } catch {}
}

// Appends an instruction to a layer's accumulated source, evicting oldest first
// when the self layer is over its cap.
// Returns the evicted instructions too: an instruction that silently stops
// existing is worse than one that was never added, because the agent goes on
// believing it still holds. The caller tells it what it lost.
export function appendLayerSource(state, layer, instruction) {
    const source = [...(state.layers?.[layer]?.source ?? []), instruction];
    const evicted = layer === 'self' && source.length > SELF_SOURCE_CAP
        ? source.splice(0, source.length - SELF_SOURCE_CAP)
        : [];
    return { source, evicted };
}

// One {modes, rules} for installPolicy. Rule names carry their layer so two
// layers can both name a rule "gather_wood" without colliding in the arbiter.
export function composePolicy(state) {
    const modes = {};
    const rules = [];
    for (let layer of MODE_ORDER)
        Object.assign(modes, state.layers?.[layer]?.policy?.modes ?? {});
    // A pinned rule sorts above every unpinned one, whatever layer it came from:
    // it is how a survival rule the agent wrote for itself survives a job profile
    // loaded into the layer above it. Pinning does not flatten the layers, it
    // just moves the whole priority contest up one level -- among pinned rules
    // the usual active > base > self order still decides, so a person can always
    // pin their own rule to outrank one the agent pinned.
    for (let layer of RULE_ORDER)
        for (let rule of state.layers?.[layer]?.policy?.rules ?? [])
            rules.push({ ...rule, name: `${layer}:${rule.name}`, _rank: RULE_ORDER.indexOf(layer) });
    rules.sort((a, b) => (!!b.pinned - !!a.pinned) || (a._rank - b._rank));
    return { modes, rules: dedupeRules(rules).map(({ _rank, ...rule }) => rule) };
}

// The agent re-states the same standing instruction in different words, and each
// recompile names the result something new. Andy accumulated pinned_night_hostile_shelter,
// night_or_hostile_hold_position, hostile_night_safe_hold, cold_night_shelter_hold...
// all triggered by "night or a mob", all "interrupts": "all". Every one of them
// preempted the others (and the model's own !stayUntil) on its own cooldown, so
// the bot spent the night restarting the same reflex instead of performing it.
//
// Rules are already in priority order here, so of two rules that do the same
// thing on the same trigger the first one keeps it and the rest are dropped --
// including across layers, since a self rule restating an active one is the same
// waste.
// ponytail: signature match only. A reworded trigger ("is_night" vs "is_night
// lead 1500") or a reworded action still slips through; catching those needs the
// compiler to reconcile meaning, which it already tries to do from the joined
// source. Rules that share a trigger but act differently are left alone -- they
// still preempt each other, but that is the arbiter's problem, and deleting a
// person's pinned rule on a guess is worse than the thrash.
function dedupeRules(rules) {
    const seen = new Map(); // signature -> the rule that claimed it
    return rules.filter(rule => {
        const signature = JSON.stringify([rule.when ?? null, rule.do ?? []]);
        const winner = seen.get(signature);
        if (winner) {
            console.log(`policy: dropped rule "${rule.name}" -- identical to "${winner.name}"`);
            return false;
        }
        seen.set(signature, rule);
        return true;
    });
}

export function describePolicyState(state) {
    const parts = [];
    for (let layer of LAYERS) {
        const l = state.layers?.[layer];
        if (!l?.policy) continue;
        const from = l.profile ? ` (profile "${l.profile}")` : '';
        parts.push(`[${layer}]${from} ${l.source?.join(' | ') ?? ''}`);
    }
    if (state.locked) parts.push('(locked: the agent may not load profiles)');
    return parts.length ? parts.join('\n') : 'No policy set.';
}

export function setPolicyLocked(agentName, locked) {
    const state = loadPolicyState(agentName);
    state.locked = !!locked;
    savePolicyState(agentName, state);
    return state.locked;
}

export function isPolicyLocked(agentName) {
    return !!loadPolicyState(agentName).locked;
}

// ---------- shared profile library ----------

// ./profiles holds model configs; the policy library is its own directory.
function profilePath(profileName) {
    if (!/^[\w-]+$/.test(profileName ?? '')) return null;
    return `./policies/${profileName}.json`;
}

// A profile is either the "base" of a policy -- a whole compiled stance the
// agent can run on its own -- or an "attribute" layered on top of one. An
// attribute may be nothing but a sentence ("never dig straight down"); it is
// the merge that turns it into rules, so it does not need a policy of its own.
export function saveProfile(profileName, { source, policy, kind, goal }) {
    const path = profilePath(profileName);
    if (!path) throw new Error(`Invalid profile name "${profileName}". Use letters, numbers, - and _ only.`);
    mkdirSync('./policies', { recursive: true });
    const data = {
        source: Array.isArray(source) ? source : [source],
        policy,
        kind: kind === 'attribute' ? 'attribute' : 'base',
    };
    if (typeof goal === 'string' && goal.trim()) data.goal = goal.trim();
    writeFileSync(path, JSON.stringify(data, null, 2));
}

export function loadProfile(profileName) {
    try {
        const path = profilePath(profileName);
        if (!path || !existsSync(path)) return null;
        const data = JSON.parse(readFileSync(path, 'utf8'));
        // Only a profile with neither rules nor words is nothing at all.
        if (!data?.policy && !data?.source?.length) return null;
        data.kind = data.kind === 'attribute' ? 'attribute' : 'base';
        if (typeof data.source === 'string') data.source = [data.source];
        data.source = data.source ?? [];
        return data;
    } catch (err) {
        console.error('Failed to load policy profile:', err);
        return null;
    }
}

export function listProfiles() {
    try {
        if (!existsSync('./policies')) return [];
        return readdirSync('./policies').filter(f => f.endsWith('.json')).map(f => {
            const name = f.slice(0, -5);
            const data = loadProfile(name);
            if (!data) return null;
            return { name, kind: data.kind, summary: profileSummary(data) };
        }).filter(Boolean);
    } catch (err) {
        console.error('Failed to list policy profiles:', err);
        return [];
    }
}

function profileSummary(data) {
    const text = data.source.join('; ')
        || (data.policy?.rules ?? []).map(r => r.description ?? r.name).join('; ');
    return text.length > 120 ? text.slice(0, 117) + '...' : text;
}

// ---------- LLM compiler ----------

function registryDocs() {
    let docs = 'CONDITIONS (use in "when", combinable with {"all":[...]}, {"any":[...]}, {"not":{...}}):\n';
    for (let name in CONDITIONS)
        docs += `- {"cond": "${name}"${Object.keys(CONDITIONS[name].args).map(a => `, "${a}": <${CONDITIONS[name].args[a]}>`).join('')}} : ${CONDITIONS[name].desc}\n`;
    docs += '\nACTIONS (use in "do" array, executed in order):\n';
    for (let name in ACTIONS)
        docs += `- {"act": "${name}"${Object.keys(ACTIONS[name].args).map(a => `, "${a}": <${ACTIONS[name].args[a]}>`).join('')}} : ${ACTIONS[name].desc}\n`;
    return docs;
}

const COMPILE_PROMPT = `You are a policy compiler for a Minecraft agent. Convert the user's standing instructions into a JSON policy that the agent's behavior tree will evaluate every tick, in rule order (earlier rules have higher priority).

$REGISTRY

Built-in modes that can be toggled with the top-level "modes" object: self_preservation, unstuck, cowardice (flee enemies), self_defense (fight enemies), hunting, item_collecting, torch_placing, elbow_room, idle_staring.
IMPORTANT: if the instructions imply a combat stance (fleeing or fighting), explicitly disable the conflicting built-in mode(s). E.g. "flee from mobs" must set {"self_defense": false, "hunting": false} and may keep cowardice on or express fleeing as a rule.

Rule format:
{"name": "snake_case_id", "description": "short human summary", "when": <condition>, "do": [<actions>], "interrupts": "all"|"idle", "cooldown": <seconds, default 3>, "pinned": <true only for rules that keep the agent alive>}
- "interrupts": "all" = rule fires even while the agent is busy (reflexes: fleeing, eating when dying). "idle" = only fires when the agent has nothing to do (opportunistic: collecting, exploring).
- "pinned": true lifts a rule above every unpinned rule, including ones from higher-priority layers, so a job the agent is given cannot crowd out the reflex that keeps it alive. Pin ONLY rules that prevent death (fleeing a losing fight, eating before starving, surfacing when drowning, avoiding a mob that killed it). Never pin gathering, building, exploring or anything else that is merely useful: pinning everything ranks nothing.
- prompt_self is the most expensive thing you can write. Every fire is a paid LLM generation and ~30 seconds during which the agent does nothing else, repeating on its cooldown for as long as the trigger holds. Before you write one, check whether the instruction names a thing: "craft a sword", "cook the meat", "put down a furnace", "get bread from the chest" are craft / smelt / place / withdraw, and cost nothing. A profile that had 23 prompt_self rules came down to 4 this way with no behaviour lost. Reach for it only when the answer depends on looking around and judging -- working out what is edible in this biome, deciding whether a base site is worth keeping -- and give it the longest cooldown the situation tolerates. "Improvise a shelter for the night" is NOT judgment work: that is the dig_in action followed by a stay until dawn.
- Do not write a rule whose only trigger is is_idle and whose only action is prompt_self ("take stock", "review your situation", "plan ahead"). It has no world trigger, so it fires forever on a timer, and the agent already reasons on its own between actions. That is a bill for nothing.
- A rule must react to something in the world. "when the agent is idle" and "when nothing bad is nearby" are its resting state, so a rule gated only on those fires forever: if it just wanders (move_away) or re-prompts (prompt_self), the agent walks in circles and every real action it starts is interrupted. Vague instructions like "move freely when safe" or "keep a low profile" are not rules -- either drop them or express them as a mode toggle.
- Do NOT write a rule that answers "a mob is nearby" with only flee/move_away. That is the cowardice mode -- set {"cowardice": true} in "modes". A rule that retreats on proximity re-triggers from wherever it lands and loops forever.
- Policies are STANDING behavior only (reflexes, safety, recurring habits). Recurring, condition-gated routines ("at night do X", "keep food stocked") ARE standing behavior; one-off tasks (e.g. "build Y", "go do Z once") are not — those are handled by the separate goal system and would go stale here. If the instructions mix standing behavior with a one-off task, compile only the standing behavior.
- Waiting something out ("stay until morning", "hide until safe") is the "stay" action with an "until" condition, not prompt_self. A rule gated on is_night whose only action is goto is wrong: arriving does not end the night, so it re-paths every cooldown until morning. Follow the goto with a stay.
- A stay's "until" is NOT the JSON condition format. It is a flat string: condition names with positional arguments, joined by a single "and" or "or" (never both), each optionally prefixed with "not". No parentheses, no JSON, no braces. Valid: "not is_night 1500", "hunger_below 10 or hostile_nearby 8", "not is_night 1500 or hostile_nearby 8". Invalid and rejected: parenthesised expressions, a nested JSON condition object, and the empty string (a stay with no exit parks the agent forever).
- An "interrupts": "all" rule must be able to END what set it off. Actions are marked cheap or blocking. A blocking action (goto, go_to_bed, collect, flee, stay, search_*) takes seconds to minutes and achieves nothing if cancelled halfway, so a rule that runs one on a trigger it cannot clear interrupts everything, achieves nothing, and fires again next cooldown forever. Answering "a mob is nearby" with go_to_bed is the mistake; answering it with flee is not. Cheap actions (equip_weapon, say, set_mode, consume) are exempt: they finish in a tick and re-running them changes nothing, which is why "hostile_nearby -> equip_weapon" is fine even though equipping does not remove the mob. With an "any" trigger EVERY branch must be answerable, since any one of them fires the rule alone; with "all", answering one branch is enough. If you cannot answer the trigger, gate the rule (has_food, has_item) or make it "idle".
- An "interrupts": "all" rule cancels whatever the agent is doing every time it fires, so its cooldown must be at least 5 seconds or nothing else ever finishes. A rule written as "night OR a mob nearby", pinned, interrupts all, cooldown 1 fired every second in daylight and cancelled every action the agent started. If it is not urgent enough for a 5 second cooldown, it is an "idle" rule.
- Never end a stay on "not hostile_nearby". Standing still does not make a mob leave, so the agent waits in the open until it wanders off and the rule fires again the moment it comes back. Flee first, then stay on something the agent's own actions can reach ("not is_night"), or break the stay ON the mob ("... or hostile_nearby 8") so it stops waiting and deals with it.
- Name a rule after everything that triggers it. A rule called night_shelter whose trigger is "night OR a mob within 16" fires at noon, and whoever reads the name cannot tell why. If the name only fits half the trigger, either split it into two rules or rename it.
- Storing items in a chest is goto the chest position followed by deposit — goto alone walks there and does nothing.
- "not", "all" and "any" are not conditions, they are the key that does the grouping. Correct: {"not": {"cond": "is_night"}}, {"any": [{"cond": "hostile_nearby", "range": 12}, {"cond": "is_night"}]}, {"all": [...]}. Rejected every time: {"cond": "not", ...}, {"cond": "any", ...}, {"cond": "all", ...}. The word after "cond" is always one of the condition names listed above and never one of these three.
- Resources are often not right next to the agent. A bare collect only reaches 64 blocks, so on empty terrain it harvests nothing every time it fires and the agent looks frozen. Block searches cannot reach past 64 blocks, so a gathering rule for something that is not in this biome will simply collect nothing every time it fires. Gate gathering rules on block_nearby or animal_nearby so they only run when the resource is actually there, and prefer resources you can see over ones you hope exist.
- "underwater" or "drowning" is the "drowning" condition paired with the "go_to_surface" action. Do not use block_nearby water for this: it is also true when standing safely on the shore, so the rule fires over and over.
- "consume" only works on food the player can actually eat (bread, cooked_beef, cooked_porkchop, cooked_chicken, apple, carrot, potato, sweet_berries). Raw materials like wheat, seeds or grass are not edible — do not list them.

Respond ONLY with a JSON object: {"modes": {...}, "rules": [...]}. No explanation, no markdown fences.
Emit it as compact JSON on a single line: no indentation, no line breaks, no space after ":" or ",". A merged policy pretty-printed runs about 40% longer than the same thing minified, which is the difference between fitting in the reply and being truncated mid-rule.

User instructions: $INSTRUCTIONS`;

// One line per rule: enough for the model to recognise "that is already
// handled", not enough to blow the context budget on descriptions written for
// human readers.
export function summarizeRules(policy) {
    return (policy?.rules ?? [])
        .map(r => `- ${r.name}${r.pinned ? ' (pinned)' : ''}: when ${describeCondition(r.when)} -> ` +
            (r.do ?? []).map(s => s.act).join(', '))
        .join('\n');
}

export async function compilePolicy(agent, instructions, activeGoal = null, existing = null) {
    let prompt = COMPILE_PROMPT
        .replace('$REGISTRY', registryDocs())
        .replace('$INSTRUCTIONS', instructions);
    // Without this the agent cannot see what a person already put in place, so
    // it writes it again from scratch every restart. One session produced seven
    // names for "flee illagers" and six for "hold a weapon", all duplicating
    // pinned rules that were already installed -- and its duplicates outranked
    // them, which is how a pinned {"act": "stay"} ended up holding the bot
    // motionless in the open all night.
    const already = summarizeRules(existing);
    if (already)
        prompt += `\n\nThese rules are ALREADY installed and running alongside yours:\n${already}\n`
            + 'Do not restate any of them, however strongly the instructions ask for it -- a rule you add'
            + ' outranks these, so a worse copy of one replaces it. Write only what they do not already'
            + ' cover, and if the instructions are entirely covered above, return an empty "rules" array.';
    if (activeGoal)
        prompt += `\n\nThe agent also has this active goal, which keeps running alongside these rules: "${activeGoal}". Write rules that support it and stay out of its way -- do not try to replace it with standing behavior.`;
    let lastErr = null;
    // 3, not 2: a truncated reply ("Expected double-quoted property name at
    // position 298") is a coin flip, not a reasoning error, and burning the
    // agent's turn on it sent it back to retype the same !policy eight times
    // until the repeated-command blocker cut it off.
    for (let attempt = 0; attempt < 3; attempt++) {
        await agent.prompter.checkCooldown();
        const req = lastErr ? prompt + `\n\nYour previous attempt was invalid: ${lastErr}\nFix it and respond with only the corrected JSON.` : prompt;
        let res = await agent.prompter.chat_model.sendRequest([], req, '***', {
            response_format: { type: 'json_schema', json_schema: { name: 'policy', schema: POLICY_SCHEMA } },
            // The profile's 8000 is sized for a chat turn. A two-profile merge
            // has to re-emit the whole policy -- 39 rules, ~4.5k tokens of JSON
            // before the model writes a word of its own -- and it came back cut
            // off three times running ("Unexpected end of JSON input"), which
            // the retry loop cannot fix because it is a cap, not a mistake.
            max_tokens: 16000
        });
        try {
            const cleaned = res.replace(/```json|```/g, '').trim();
            const policy = repairPolicy(JSON.parse(cleaned.substring(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1)));
            const err = validatePolicy(policy);
            if (!err) return policy;
            lastErr = err;
        } catch (e) {
            // The length matters more than the parser's complaint: a reply that
            // stops mid-object is a token cap, and no amount of retrying fixes
            // that. Three identical failures cost an hour before anyone knew
            // whether the model was confused or simply cut off.
            lastErr = `Response was not valid JSON (${res?.length ?? 0} chars): ` + e.message;
        }
        console.warn('Policy compile attempt failed:', lastErr);
    }
    throw new Error('Could not compile instructions into a valid policy: ' + lastErr);
}

// A stack of layers evaluated at runtime only ever gets one thing right: which
// rule wins a tie. It cannot notice that "never fight" and "hunt cows for food"
// are the same disagreement said twice, so both stay installed and the agent
// oscillates. Merging is where that gets resolved -- once, by the model, into a
// single policy -- so the runtime only has to run rules, not referee them.
export function buildMergeInstructions(base, attributes) {
    let text = 'You are combining one base policy with attribute policies layered on top of it.\n\n';
    text += `BASE ("${base.name}"):\n`;
    if (base.source?.length) text += base.source.map(s => `- ${s}`).join('\n') + '\n';
    if (base.goal) text += `Its goal: ${base.goal}\n`;
    if (base.policy) text += `Its existing rules as JSON:\n${JSON.stringify(base.policy)}\n`;
    for (let i = 0; i < attributes.length; i++) {
        const attr = attributes[i];
        text += `\nATTRIBUTE ${i + 1} ("${attr.name}"):\n`;
        if (attr.source?.length) text += attr.source.map(s => `- ${s}`).join('\n') + '\n';
        if (attr.goal) text += `Its goal: ${attr.goal}\n`;
        if (attr.policy) text += `Its existing rules as JSON:\n${JSON.stringify(attr.policy)}\n`;
    }
    text += '\nProduce ONE combined policy. The attributes are layered on top of the base and'
        + ' take priority wherever they conflict with it, and a later attribute takes priority'
        + ' over an earlier one. Preserve every base rule (including its "pinned" flag) that'
        + ' nothing above it conflicts with. Do not emit two rules that do the same thing:'
        + ' where they overlap, write the single rule the winning layer wants.';
    // Rules only fire when the world pokes them, so a policy made entirely of
    // rules is a policy that does nothing in an empty field: Andy stood in a
    // snowfield at full hunger with every food rule waiting for a carrot within
    // 24 blocks. The goal is the half that goes looking. Each profile says what
    // it is ultimately for, and the merge is where those become one sentence --
    // the agent can only pursue one thing at a time, and handing it "survive"
    // and "gather food" and "mine ores" separately is how it ends up thrashing
    // between them.
    if (base.goal || attributes.some(a => a.goal))
        text += '\n\nThese profiles also declare goals: what the agent should be actively working'
            + ' towards, as opposed to the rules, which only react. Combine them into ONE goal'
            + ' and return it as a "goal" string in the JSON, alongside "modes" and "rules".'
            + ' It must be a single continuing objective written as an instruction to the agent,'
            + ' serving every goal above rather than picking one -- where they compete, the base'
            + ' says what the agent is for and the attributes say how it should go about it.'
            + ' Keep it to a sentence or two: it is re-sent to the agent on every step of an'
            + ' expensive reasoning loop.';
    else
        text += '\n\nNone of these profiles declares a goal, so do not invent one: omit the "goal" field.';
    return text;
}

// The merge keeps "pinned" but routinely drops "interrupts" -- it reads as
// bookkeeping next to the rule's logic. A missing "interrupts" means "all" at
// install time, so every opportunistic rule in the merged policy came back a
// reflex: gather_wood_for_base, walk_the_berry_route and stock_the_pantry
// cancelling whatever the agent was doing, which is how a bot ends up saying
// "I'm stuck" and "I'm looping" 200 times an hour. Copy the declaration back
// from the profile the rule came from. A rule the merge invented has no source
// to copy from and keeps whatever it declared.
function restoreInterrupts(policy, profiles) {
    const declared = new Map();
    for (const p of profiles)
        for (const r of p.policy?.rules ?? [])
            if (r.interrupts) declared.set(r.name, r.interrupts);
    for (const rule of policy.rules ?? [])
        if (!rule.interrupts && declared.has(rule.name)) rule.interrupts = declared.get(rule.name);
}
export const restoreInterruptsForTest = restoreInterrupts;

// Returns the state with a freshly generated "active" layer. It does NOT
// install it -- every caller already has its own install-and-save path, and
// installing here would mean a failed save still changed the running agent.
export async function generatePolicy(agent, baseName, attributeNames = []) {
    const base = loadProfile(baseName);
    if (!base) throw new Error(`There is no policy profile named "${baseName}".`);
    if (base.kind !== 'base') throw new Error(`Profile "${baseName}" is an attribute, not a base policy.`);
    if (!base.policy && !base.source?.length) throw new Error(`Profile "${baseName}" is empty.`);

    const attributes = attributeNames.map(name => {
        const data = loadProfile(name);
        if (!data) throw new Error(`There is no policy profile named "${name}".`);
        return { ...data, name };
    });

    let policy;
    if (attributes.length === 0 && base.policy) {
        // Nothing to reconcile, so nothing to pay an LLM call for.
        policy = { ...base.policy };
        if (base.goal) policy.goal = base.goal;
    } else {
        policy = await compilePolicy(agent, buildMergeInstructions({ ...base, name: baseName }, attributes));
        restoreInterrupts(policy, [base, ...attributes]);
        const err = validatePolicy(policy);
        if (err) throw new Error(`The merged policy is not valid: ${err}`);
        // A goal starts an endless LLM loop, so it takes a profile asking for
        // one. Without this the compiler happily reads "goal" out of the prompt
        // wording and gives an agent an objective nobody chose for it.
        if (!base.goal && !attributes.some(a => a.goal)) delete policy.goal;
    }

    const state = loadPolicyState(agent.name);
    const summary = attributes.length
        ? `generated from base "${baseName}" + attributes: ${attributeNames.join(', ')}`
        : `generated from base "${baseName}"`;
    state.layers.active = { profile: null, source: [summary], policy };
    state.compose = { base: baseName, attributes: [...attributeNames], generated_at: Date.now() };
    return state;
}

// The goal comes from the "active" layer only, never from "self". A person
// choosing a base and its attributes is a person choosing what the agent is for;
// letting the agent's own !policy layer reach this would be letting it rewrite
// its own objective, which is the trick that already cost it four hours of
// standing in a hole (see the removed covers_goal in commands/actions.js).
export function policyGoal(state) {
    const goal = state?.layers?.active?.policy?.goal;
    return typeof goal === 'string' && goal.trim() ? goal.trim() : null;
}

// Applied on install. Only ever STARTS a goal: a policy with no goal leaves a
// running one alone, because a person's !goal outlives a policy regen and a
// silent stop is how an agent ends up idle with nothing driving it.
export async function applyPolicyGoal(agent, state) {
    const goal = policyGoal(state);
    if (!goal) return null;
    // Record it as the standing goal even when it is already running, so a
    // !goal detour started later has somewhere to come back to via !endGoal.
    if (agent.self_prompter) agent.self_prompter.standing_prompt = goal;
    if (agent.self_prompter?.prompt === goal) return null;
    await agent.self_prompter.start(goal, true);
    return goal;
}

export function describePolicy(policy) {
    let res = '';
    if (policy.goal) res += `Goal: ${policy.goal}\n`;
    if (policy.modes && Object.keys(policy.modes).length > 0)
        res += 'Mode overrides: ' + Object.entries(policy.modes).map(([m, on]) => `${m}=${on ? 'on' : 'off'}`).join(', ') + '\n';
    for (let rule of policy.rules)
        res += `- ${rule.name} (${rule.interrupts ?? 'all'}${rule.pinned ? ', pinned' : ''}): ${rule.description ?? JSON.stringify(rule.when)}\n`;
    return res.trim();
}
