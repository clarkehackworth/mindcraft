import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../settings.js";
import { isUnreachable } from '../path_spin.js';

// How many blocks collectBlocks may break before it stops to pick the drops up,
// when nothing is arriving in the bag on its own. See the sweep in collectBlocks.
// ponytail: a fixed stride. If drop loss and dig aborts trade off differently on
// another server, this is the knob -- lower picks up more, higher digs faster.
const SWEEP_STRIDE = 4;

// How far pickupNearbyItems will go for a dropped item. Named because the
// lost-drop diagnostic reports distances against it, and a bare 8 in two places
// that must agree is how those two drift apart.
const PICKUP_RADIUS = 8;

// The last-resort sweep reaches further than the in-loop one. Felling a tree
// leaves the bot up the trunk while the logs land at the bottom, and the
// diagnostic measured that gap repeatedly: 8.4 away (dy -7), then 14.1 (dy
// -10.6), both "beyond the sweep's 8-block reach". Widening the in-loop sweep to
// match would mean walking that far between digs, which is how a dig gets
// aborted -- but the recovery sweep runs once, after the last block, with
// nothing left to interrupt.
const RECOVERY_PICKUP_RADIUS = 24;

const blockPlaceDelay = settings.block_place_delay == null ? 0 : settings.block_place_delay;
const useDelay = blockPlaceDelay > 0;

export function log(bot, message) {
    bot.output += message + '\n';
}

// "I am `done` of `total` through this." Read by ActionManager to decide whether
// a non-urgent interrupter should wait a moment rather than throw the work away.
// It lives on the bot because that is the only object a skill is given.
// Reporting is optional: an action that says nothing is never nearly-finished.
export function reportProgress(bot, done, total) {
    bot.action_progress = total > 0 ? { done, total } : null;
}

/**
 * Whether a destination is inside the bot's leash.
 * Horizontal distance only -- capping y would stop it mining or climbing.
 * ponytail: enforced in goToPosition, the funnel every travel skill and every
 * generated codeblock goes through. A skill that drives bot.pathfinder itself
 * still escapes; move this into the pathfinder goal if that becomes a problem.
 */
export function explorationAnchor(bot) {
    // home_point is the remembered "home" place and survives restarts;
    // spawn_point is wherever this process happened to log in, which after a
    // restart 300 blocks from base is 300 blocks from base. Prefer the one that
    // means something.
    return bot.home_point ?? bot.spawn_point;
}

export function withinExplorationRadius(bot, x, z) {
    const radius = settings.exploration_radius;
    const anchor = explorationAnchor(bot);
    if (!radius || radius <= 0 || !anchor) return true;
    return Math.hypot(x - anchor.x, z - anchor.z) <= radius;
}

async function autoLight(bot) {
    if (world.shouldPlaceTorch(bot)) {
        try {
            const pos = world.getPosition(bot);
            return await placeBlock(bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
        } catch (err) {return false;}
    }
    return false;
}

export async function equipHighestAttack(bot) {
    let weapons = bot.inventory.items().filter(item => item.name.includes('sword') || (item.name.includes('axe') && !item.name.includes('pickaxe')));
    if (weapons.length === 0)
        weapons = bot.inventory.items().filter(item => item.name.includes('pickaxe') || item.name.includes('shovel'));
    if (weapons.length === 0)
        return false;
    weapons.sort((a, b) => b.attackDamage - a.attackDamage);
    let weapon = weapons[0];
    if (!weapon) return false;
    // Re-equipping what is already in hand is work that accomplishes nothing,
    // and a policy rule that "succeeds" every time never backs off: Andy's
    // equip-a-weapon rule fired 156 times in 12 minutes holding the same sword.
    if (bot.heldItem?.name === weapon.name) return false;
    await bot.equip(weapon, 'hand');
    return true;
}

// mineflayer's bot.craft simulates the entire table transaction client-side --
// its grabResult() literally fabricates the result item into the window
// without asking the server -- so on servers where a mod changes container
// timing (VisualWorkbench rebroadcasts the result slot every tick, making
// naive clicks stale-on-arrival), it pockets phantom items while the real
// ingredients sit in the table. This crafts at a table treating server packets
// as the only truth: place ingredients, wait for the server to OFFER the
// result in slot 0, shift-click it, and confirm the take by watching the grid
// empty -- an ignored take gets re-asserted by the server within a tick.
// Works identically on vanilla servers. Returns the number of completed
// crafts. ponytail: assumes 1 item per grid slot, true of every vanilla-style
// recipe; teach it counts if a mod recipe ever needs stacks in the grid.
// openWithRetry's retry path referenced this before it existed: sleep was a
// local inside tableCraft, so the one branch that needed it -- the second
// attempt at a window that did not open -- threw "sleep is not defined" instead
// of retrying. Live: "Rule 'active:build_a_furnace_for_cooking' step craft
// failed: sleep is not defined". Module scope, where both callers can see it.
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// mineflayer waits 20 seconds for the server's windowOpen packet and then
// throws; 23 of those in one session, each a 20-second stall ending in a stack
// trace whose real cause is mundane -- the block drifted out of reach after the
// pathfind, or a mod replaced its menu. One retry covers the race; after that,
// say something the model can act on instead of throwing.
async function openWithRetry(bot, block, open) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try { return await open(block); }
        catch (err) {
            if (!/windowOpen/i.test(String(err?.message ?? err))) throw err;
            await sleep(500);
        }
    }
    log(bot, `The ${block.name} never opened. Stand right next to it and try again; if a mod replaced its menu it cannot be used this way.`);
    return null;
}

export async function tableCraft(bot, recipe, count, craftingTable) {
    // Without a table this drives the player inventory's own 2x2 grid: same
    // click dance, slots 1-4 two wide instead of 1-9 three wide.
    const width = craftingTable ? 3 : 2;
    const gridEnd = craftingTable ? 10 : 5;
    const gridSlot = (x, y) => 1 + x + width * y;
    const gridEmpty = (window) => window.slots.slice(1, gridEnd).every(s => !s);

    // One craft's worth of [grid slot, item id] placements.
    const placements = [];
    if (recipe.inShape) {
        for (let y = 0; y < recipe.inShape.length; y++)
            for (let x = 0; x < recipe.inShape[y].length; x++)
                if (recipe.inShape[y][x].id !== -1)
                    placements.push([gridSlot(x, y), recipe.inShape[y][x].id]);
    }
    if (recipe.ingredients) { // shapeless: fill unused slots from the top left
        const used = new Set(placements.map(p => p[0]));
        let s = 1;
        for (const ing of recipe.ingredients) {
            while (used.has(s)) s++;
            used.add(s);
            placements.push([s, ing.id]);
        }
    }

    const window = craftingTable
        ? await openWithRetry(bot, craftingTable, b => bot.openBlock(b))
        : bot.inventory;
    if (!window) return 0;
    // Tag recipes (#planks) accept any family member, but the recipe object
    // names one concrete id -- oak_planks in a larch forest. If the named item
    // is absent, offer any same-suffix item and let the result slot judge.
    const familyAlt = (id) => {
        const want = bot.registry.items[id]?.name ?? '';
        const m = want.match(/^[a-z0-9]+(_[a-z_]+)$/);
        if (!m) return null;
        return window.slots.find((s, i) => s && i >= gridEnd && s.name !== want && s.name.endsWith(m[1])) ?? null;
    };
    let done = 0;
    let missing = null;
    try {
        await sleep(300); // authoritative window_items, plus a VW sync tick
        for (let i = 0; i < count && !bot.interrupt_code; i++) {
            for (const [dest, id] of placements) {
                if (window.slots[dest]) continue; // already there (left by an earlier attempt)
                let source = window.findInventoryItem(id, null) ?? familyAlt(id);
                // Running out of an ingredient partway through a batch is a
                // normal outcome, not an exception. Thrown, it escaped as
                // "Error: Error: missing ingredient" 51 times in one session
                // and told the model nothing it could act on; returning the
                // count made so far does, and the grid still gets emptied below.
                if (!source) { missing = bot.registry.items[id]?.name ?? `item ${id}`; break; }
                await bot.clickWindow(source.slot, 0, 0); // pick up the stack
                await bot.clickWindow(dest, 1, 0);        // drop one in the grid
                if (window.selectedItem)
                    await bot.clickWindow(source.slot, 0, 0); // put the rest back
            }
            if (missing) break;
            // The result slot filling is the server's word that it recognizes
            // the recipe; the client never predicts it.
            let offered = false;
            for (let t = 0; t < 10 && !offered; t++) {
                await sleep(200);
                offered = !!window.slots[0];
            }
            if (!offered) break;
            let took = false;
            for (let attempt = 0; attempt < 5 && !took; attempt++) {
                try { await bot.clickWindow(0, 0, 1); } catch {} // shift-click result to inventory
                await sleep(350); // an ignored take is re-asserted by the next sync tick
                if (!window.slots[0] && gridEmpty(window)) took = true;
            }
            if (!took) break;
            done++;
        }
        // Withdraw anything left in the grid so nothing is stranded in the table.
        for (let s = 1; s < gridEnd; s++) {
            if (!window.slots[s]) continue;
            try { await bot.clickWindow(s, 0, 1); } catch {}
            await sleep(120);
        }
    } finally {
        if (craftingTable) bot.closeWindow(window);
    }
    if (missing && done === 0) log(bot, `Ran out of ${missing} before crafting anything.`);
    return done;
}

// What the bot could put its hands on right now: held items, plus one of every
// block type in sight. Only for ranking recipe variants -- a block in sight is
// not a block in the inventory, so never feed this to a crafting plan.
// ponytail: flat count of 1 per nearby type, not an actual block census. The
// ranking only asks "is this material around at all"; count a vein properly if
// something ever needs to choose between two materials that are both present.
function reachableCounts(bot) {
    const counts = {};
    for (const name of world.getNearbyBlockTypes(bot)) counts[name] = 1;
    return {...counts, ...world.getInventoryCounts(bot)};
}

export async function craftRecipe(bot, itemName, num=1, expanding=new Set()) {
    /**
     * Attempt to craft the given item name from a recipe. May craft many items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to craft.
     * @param {Set<string>} expanding, items already being crafted as intermediates
     *   further up this recursion -- cycle guard, callers leave it alone.
     * @returns {Promise<boolean>} true if the recipe was crafted, false otherwise.
     * @example
     * await skills.craftRecipe(bot, "stick");
     **/

    if ((mc.getItemCraftingRecipes(itemName) ?? []).length == 0) {
        log(bot, `${itemName} is either not an item, or it does not have a crafting recipe!`);
        return false;
    }

    // get recipes that don't require a crafting table
    let recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, null);
    let craftingTable = null;
    let needsTable = false;
    const craftingTableRange = 16;
    placeTable: if (!recipes || recipes.length === 0) {
        // Nothing craftable in the 2x2 grid: from here on, a table is mandatory.
        needsTable = true;
        recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, true);
        if(!recipes || recipes.length === 0) break placeTable; //Don't bother going to the table if we don't have the required resources.

        // Look for crafting table
        craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
        if (craftingTable === null){

            // Try to place a crafting table, crafting one first if needed.
            // (crafting_table itself is table-free, so this can't recurse here.)
            let hasTable = world.getInventoryCounts(bot)['crafting_table'] > 0
                || await craftRecipe(bot, 'crafting_table', 1);
            if (hasTable) {
                let pos = world.getNearestFreeSpace(bot, 1, 6);
                await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);
                // placeBlock returns before the block reliably shows up in the
                // world cache, so a single lookup here reads null on a table the
                // bot just watched itself place. Seen live at (9,52,5): placed,
                // not found, fell through to a table-less craft, threw.
                for (let i = 0; i < 10 && !craftingTable; i++) {
                    craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
                    if (!craftingTable) await new Promise(r => setTimeout(r, 200));
                }
                if (craftingTable) {
                    recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
                }
            }
            else {
                log(bot, `Crafting ${itemName} requires a crafting table.`)
                return false;
            }
        }
        else {
            recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
        }
    }
    if (!recipes || recipes.length === 0) {
        // Missing ingredients may themselves be craftable (log -> planks -> sticks).
        // The recipe graph is known, so walk it in code instead of burning an LLM
        // roundtrip per intermediate craft.
        const plan = mc.getCraftingPlan(itemName, num, world.getInventoryCounts(bot));
        const intermediates = plan ? plan.steps.filter(s => s.item !== itemName) : [];
        // Each plan is depth-capped, but plans across recursive calls are not:
        // the mod pack crafts stick from pine_branch and pine_branch from stick,
        // so plan(stick) says "make pine_branch" and plan(pine_branch) says
        // "make stick" forever. Live, craft_torches rode that pair down to
        // "Maximum call stack size exceeded" after 102KB of log, blocking the
        // event loop past the 60s keepalive -- the bot timed out of the server
        // every 58s for 40 minutes. Expand each item at most once per chain.
        if (plan && Object.keys(plan.required).length === 0 && intermediates.length > 0
            && !expanding.has(itemName)) {
            const chain = new Set(expanding).add(itemName);
            log(bot, `Crafting intermediate items for ${itemName}: ${intermediates.map(s => `${s.count} ${s.item}`).join(', ')}.`);
            for (const step of intermediates) {
                if (bot.interrupt_code) return false;
                if (!await craftRecipe(bot, step.item, step.count, chain)) return false;
            }
            // itemName is in `chain`, so this retry skips straight past planning
            // to the actual craft instead of re-deriving the same intermediates.
            return await craftRecipe(bot, itemName, num, chain);
        }
        // bot.recipesFor only knows vanilla ids: a craft from larch or pine
        // resolves to no recipe even with every ingredient in hand, which left
        // Andy unarmed through 41 deaths in one soak. Our own recipe data has
        // the mod packs; drive the grid clicks manually and let the server's
        // result slot judge whether the recipe is real.
        const modded = mc.getCraftableRawRecipe(itemName, world.getInventoryCounts(bot));
        if (modded) {
            let table = craftingTable;
            if (modded.needsTable && !table) {
                if (world.getInventoryCounts(bot)['crafting_table'] > 0) {
                    const p = bot.entity.position;
                    await placeBlock(bot, 'crafting_table', p.x, p.y, p.z);
                    for (let i = 0; i < 10 && !table; i++) {
                        table = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
                        if (!table) await new Promise(r => setTimeout(r, 200));
                    }
                } else if (mc.getCraftableRawRecipe('crafting_table', world.getInventoryCounts(bot)) && itemName !== 'crafting_table') {
                    // The table itself is 2x2-craftable from the same modded planks.
                    if (await craftRecipe(bot, 'crafting_table', 1))
                        return await craftRecipe(bot, itemName, num);
                }
                if (!table) {
                    log(bot, `Crafting ${itemName} needs a crafting table and there is none within ${craftingTableRange} blocks.`);
                    return false;
                }
            }
            if (table && bot.entity.position.distanceTo(table.position) > 4)
                await goToNearestBlock(bot, 'crafting_table', 4, craftingTableRange);
            const before = world.getInventoryCounts(bot)[itemName] ?? 0;
            const done = await tableCraft(bot, modded.recipe, num, modded.needsTable ? table : null);
            if (done > 0) {
                log(bot, `Successfully crafted ${itemName}, you now have ${before + done * (modded.recipe.result?.count ?? 1)} ${itemName}.`);
                return true;
            }
            log(bot, `Tried to craft ${itemName} from a modded recipe but the server offered no result.`);
            return false;
        }
        // Ranked against what the bot is holding, so the message names the wood
        // it actually has instead of always naming oak. Holding none of it, rank
        // against what is standing within sight too: empty-handed in a pine
        // forest the tiebreak used to name oak_planks, and Andy spent a day of
        // real time hunting an oak tree that does not grow in this biome.
        const req = mc.getItemCraftingRecipes(itemName, reachableCounts(bot))?.[0]?.[0];
        log(bot, `You do not have the resources to craft a ${itemName}.` + (req ? ` It requires: ${Object.entries(req).map(([key, value]) => `${key}: ${value}`).join(', ')}.` : ''));
        return false;
    }
    
    // The recipe needs a table and we never got hold of one. Falling through
    // here calls bot.craft(recipe, n, null), which throws a raw mineflayer
    // "Recipe requires craftingTable, but one was not supplied" -- the agent
    // sees a stack trace, retries the identical command, and grinds into the
    // repeated-command blocker. Say what is wrong instead.
    if (needsTable && !craftingTable) {
        log(bot, `Crafting ${itemName} needs a crafting table and none was found within ${craftingTableRange} blocks. Place one where you are standing, then craft again.`);
        return false;
    }

    if (craftingTable && bot.entity.position.distanceTo(craftingTable.position) > 4) {
        await goToNearestBlock(bot, 'crafting_table', 4, craftingTableRange);
    }

    const recipe = recipes[0];
    console.log('crafting...');
    //Check that the agent has sufficient items to use the recipe `num` times.
    const inventory = world.getInventoryCounts(bot); //Items in the agents inventory
    const requiredIngredients = mc.ingredientsFromPrismarineRecipe(recipe); //Items required to use the recipe once.
    const craftLimit = mc.calculateLimitingResource(inventory, requiredIngredients);
    
    // bot.craft simulates the window clicks client-side and "succeeds" even
    // when the server rejected every one of them. Seen live: VisualWorkbench
    // replaces the crafting-table menu, mineflayer clicks a grid that is not
    // there, the server destroys the ingredients, and the LLM is told
    // "Successfully crafted" -- it then plans around a pickaxe it does not
    // have. Verify against the post-close resync before reporting anything.
    const count_before_craft = world.getInventoryCounts(bot)[itemName] ?? 0;
    if (craftingTable) {
        const done = await tableCraft(bot, recipe, Math.min(craftLimit.num, num), craftingTable);
        if (done === 0) {
            log(bot, `Crafting ${itemName} FAILED: the crafting table never produced the result. If ingredients are stuck inside the table (VisualWorkbench stores them), break the table to recover them.`);
            return false;
        }
    } else {
        try {
            await bot.craft(recipe, Math.min(craftLimit.num, num), null);
        } catch (err) {
            // Vanilla recipe objects name concrete ids (#planks -> oak_planks),
            // so holding only modded planks makes bot.craft throw "missing
            // ingredient" on a recipe the server would accept. Re-drive it
            // through the grid clicks, which substitute same-family items.
            if (!String(err).includes('missing ingredient')) throw err;
            const shape = recipe.inShape ?? [];
            const fits2x2 = shape.length > 0 && shape.length <= 2 && shape.every(r => r.length <= 2);
            let table = fits2x2 ? null : world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
            if (!fits2x2 && !table) {
                if (itemName !== 'crafting_table' && await craftRecipe(bot, 'crafting_table', 1)) {
                    const p = bot.entity.position;
                    await placeBlock(bot, 'crafting_table', p.x, p.y, p.z);
                    return await craftRecipe(bot, itemName, num);
                }
                throw err;
            }
            if (table && bot.entity.position.distanceTo(table.position) > 4)
                await goToNearestBlock(bot, 'crafting_table', 4, craftingTableRange);
            await tableCraft(bot, recipe, Math.min(craftLimit.num, num), table);
        }
    }
    // Report what was actually gained: "crafted 6" used to mean 6 crafting
    // operations at 4 planks each, and the "you now have N" total hid it.
    const total_after_craft = world.getInventoryCounts(bot)[itemName] ?? 0;
    const gained_from_craft = total_after_craft - count_before_craft;
    if(craftLimit.num<num) log(bot, `Not enough ${craftLimit.limitingResource} for ${num} crafts, made ${gained_from_craft} ${itemName}. You now have ${total_after_craft} ${itemName}.`);
    else log(bot, `Crafted ${gained_from_craft} ${itemName}, you now have ${total_after_craft} ${itemName}.`);

    //Equip any armor the bot may have crafted.
    //There is probablly a more efficient method than checking the entire inventory but this is all mineflayer-armor-manager provides. :P
    bot.armorManager.equipAll(); 

    return true;
}

export async function wait(bot, milliseconds) {
    /**
     * Waits for the given number of milliseconds.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} milliseconds, the number of milliseconds to wait.
     * @returns {Promise<boolean>} true if the wait was successful, false otherwise.
     * @example
     * await skills.wait(bot, 1000);
     **/
    // setTimeout is disabled to prevent unawaited code, so this is a safe alternative that enables interrupts
    let timeLeft = milliseconds;
    let startTime = Date.now();
    
    while (timeLeft > 0) {
        if (bot.interrupt_code) return false;
        
        let waitTime = Math.min(2000, timeLeft);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        let elapsed = Date.now() - startTime;
        timeLeft = milliseconds - elapsed;
    }
    return true;
}

export async function smeltItem(bot, itemName, num=1) {
    /**
     * Puts 1 coal in furnace and smelts the given item name, waits until the furnace runs out of fuel or input items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to smelt. Ores must contain "raw" like raw_iron.
     * @param {number} num, the number of items to smelt. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was smelted, false otherwise. Fail
     * @example
     * await skills.smeltItem(bot, "raw_iron");
     * await skills.smeltItem(bot, "beef");
     **/

    // "log" is a family, not an item. has_item resolves families and smeltItem
    // did not, so the torch chain's smelt step asked the furnace for something
    // called "log" and answered "You do not have enough log to smelt" seven
    // times over while the bot stood there holding larch. Resolve to the wood
    // actually in the bag before anything else reads the name.
    const variants = mc.expandBlockName(itemName);
    if (variants.length > 1) {
        const counts = world.getInventoryCounts(bot);
        itemName = variants.find(n => (counts[n] ?? 0) >= num)
            ?? variants.find(n => (counts[n] ?? 0) > 0)
            ?? itemName;
    }

    if (!mc.isSmeltable(itemName)) {
        log(bot, `Cannot smelt ${itemName}. Hint: make sure you are smelting the 'raw' item.`);
        return false;
    }

    let placedFurnace = false;
    let furnaceBlock = undefined;
    const furnaceRange = 16;
    furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
    if (!furnaceBlock){
        // Try to place furnace
        let hasFurnace = world.getInventoryCounts(bot)['furnace'] > 0;
        if (hasFurnace) {
            let pos = world.getNearestFreeSpace(bot, 1, furnaceRange);
            await placeBlock(bot, 'furnace', pos.x, pos.y, pos.z);
            furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
            placedFurnace = true;
        }
    }
    if (!furnaceBlock){
        log(bot, `There is no furnace nearby and you have no furnace.`)
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, furnaceRange);
    }
    bot.modes.pause('unstuck');
    await bot.lookAt(furnaceBlock.position);

    console.log('smelting...');
    const furnace = await bot.openFurnace(furnaceBlock);
    // check if the furnace is already smelting something
    let input_item = furnace.inputItem();
    if (input_item && input_item.type !== mc.getItemId(itemName) && input_item.count > 0) {
        // TODO: check if furnace is currently burning fuel. furnace.fuel is always null, I think there is a bug.
        // This only checks if the furnace has an input item, but it may not be smelting it and should be cleared.
        log(bot, `The furnace is currently smelting ${mc.getItemName(input_item.type)}.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }
    // check if the bot has enough items to smelt
    let inv_counts = world.getInventoryCounts(bot);
    if (!inv_counts[itemName] || inv_counts[itemName] < num) {
        log(bot, `You do not have enough ${itemName} to smelt.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }

    // fuel the furnace
    if (!furnace.fuelItem()) {
        let fuel = mc.getSmeltingFuel(bot);
        if (!fuel) {
            log(bot, `You have no fuel to smelt ${itemName}, you need coal, charcoal, or wood.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        log(bot, `Using ${fuel.name} as fuel.`);

        const put_fuel = Math.ceil(num / mc.getFuelSmeltOutput(fuel.name));

        if (fuel.count < put_fuel) {
            log(bot, `You don't have enough ${fuel.name} to smelt ${num} ${itemName}; you need ${put_fuel}.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        await furnace.putFuel(fuel.type, null, put_fuel);
        log(bot, `Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`);
        console.log(`Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`)
    }
    // put the items in the furnace
    const inv_before_smelt = world.getInventoryCounts(bot);
    await furnace.putInput(mc.getItemId(itemName), null, num);
    // wait for the items to smelt
    let total = 0;
    let smelted_item = null;
    await new Promise(resolve => setTimeout(resolve, 200));
    let last_collected = Date.now();
    while (total < num) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (furnace.outputItem()) {
            smelted_item = await furnace.takeOutput();
            if (smelted_item) {
                total += smelted_item.count;
                last_collected = Date.now();
            }
        }
        if (Date.now() - last_collected > 11000) {
            break; // if nothing has been collected in 11 seconds, stop
        }
        if (bot.interrupt_code) {
            break;
        }
    }
    // take all remaining in input/fuel slots
    if (furnace.inputItem()) {
        await furnace.takeInput();
    }
    if (furnace.fuelItem()) {
        await furnace.takeFuel();
    }

    await bot.closeWindow(furnace);

    if (placedFurnace) {
        await collectBlock(bot, 'furnace', 1);
    }
    if (total === 0) {
        log(bot, `Failed to smelt ${itemName}.`);
        return false;
    }
    if (total < num) {
        log(bot, `Only smelted ${total} ${mc.getItemName(smelted_item.type)}.`);
        return false;
    }
    // Trust inventory over the window: takeOutput counts what the client
    // believes it took, and modded containers have lied about that before
    // (see craftRecipe). Report the verified amount.
    const product = mc.getItemName(smelted_item.type);
    const gained = (world.getInventoryCounts(bot)[product] ?? 0) - (inv_before_smelt[product] ?? 0);
    if (gained < total) {
        log(bot, `Smelting reported ${total} ${product} but only ${gained} arrived in your inventory -- the furnace may be desynced. Check !inventory before smelting more.`);
        return gained > 0;
    }
    log(bot, `Successfully smelted ${itemName}, got ${total} ${product}.`);
    return true;
}

export async function clearNearestFurnace(bot) {
    /**
     * Clears the nearest furnace of all items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the furnace was cleared, false otherwise.
     * @example
     * await skills.clearNearestFurnace(bot);
     **/
    let furnaceBlock = world.getNearestBlock(bot, 'furnace', 32);
    if (!furnaceBlock) {
        log(bot, `No furnace nearby to clear.`);
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, 32);
    }

    console.log('clearing furnace...');
    const furnace = await bot.openFurnace(furnaceBlock);
    console.log('opened furnace...')
    // take the items out of the furnace
    let smelted_item, intput_item, fuel_item;
    if (furnace.outputItem())
        smelted_item = await furnace.takeOutput();
    if (furnace.inputItem())
        intput_item = await furnace.takeInput();
    if (furnace.fuelItem())
        fuel_item = await furnace.takeFuel();
    console.log(smelted_item, intput_item, fuel_item)
    let smelted_name = smelted_item ? `${smelted_item.count} ${smelted_item.name}` : `0 smelted items`;
    let input_name = intput_item ? `${intput_item.count} ${intput_item.name}` : `0 input items`;
    let fuel_name = fuel_item ? `${fuel_item.count} ${fuel_item.name}` : `0 fuel items`;
    log(bot, `Cleared furnace, received ${smelted_name}, ${input_name}, and ${fuel_name}.`);
    return true;

}


export async function attackNearest(bot, mobType, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} mobType, the type of mob to attack.
     * @param {boolean} kill, whether or not to continue attacking until the mob is dead. Defaults to true.
     * @returns {Promise<boolean>} true if the mob was attacked, false if the mob type was not found.
     * @example
     * await skills.attackNearest(bot, "zombie", true);
     **/
    bot.modes.pause('cowardice');
    if (mobType === 'drowned' || mobType === 'cod' || mobType === 'salmon' || mobType === 'tropical_fish' || mobType === 'squid')
        bot.modes.pause('self_preservation'); // so it can go underwater. TODO: have an drowning mode so we don't turn off all self_preservation
    const mob = world.getNearbyEntities(bot, 24).find(entity => entity.name === mobType);
    if (mob) {
        return await attackEntity(bot, mob, kill);
    }
    log(bot, 'Could not find any '+mobType+' to attack.');
    return false;
}

export async function attackEntity(bot, entity, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to attack.
     * @returns {Promise<boolean>} true if the entity was attacked, false if interrupted
     * @example
     * await skills.attackEntity(bot, entity);
     **/

    let pos = entity.position;
    await equipHighestAttack(bot)

    if (!kill) {
        if (bot.entity.position.distanceTo(pos) > 5) {
            console.log('moving to mob...')
            await goToPosition(bot, pos.x, pos.y, pos.z);
        }
        console.log('attacking mob...')
        await bot.attack(entity);
    }
    else {
        bot.pvp.attack(entity);
        while (world.getNearbyEntities(bot, 24).includes(entity)) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (bot.interrupt_code) {
                bot.pvp.stop();
                return false;
            }
        }
        log(bot, `Successfully killed ${entity.name}.`);
        await pickupNearbyItems(bot);
        return true;
    }
}

export async function defendSelf(bot, range=9) {
    /**
     * Defend yourself from all nearby hostile mobs until there are no more.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} range, the range to look for mobs. Defaults to 8.
     * @returns {Promise<boolean>} true if the bot found any enemies and has killed them, false if no entities were found.
     * @example
     * await skills.defendSelf(bot);
     * **/
    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let attacked = false;
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
    while (enemy) {
        await equipHighestAttack(bot);
        // Substring, not equality: a modded server names its mobs things like
        // 'mutant_creeper', which failed both equality checks, so the bot closed
        // to 3.5 blocks and charged one. It blew up on him.
        if (bot.entity.position.distanceTo(enemy.position) >= 4 && !enemy.name.includes('creeper') && !enemy.name.includes('phantom')) {
            try {
                bot.pathfinder.setMovements(new pf.Movements(bot));
                await bot.pathfinder.goto(new pf.goals.GoalFollow(enemy, 3.5), true);
            } catch (err) {/* might error if entity dies, ignore */}
        }
        if (bot.entity.position.distanceTo(enemy.position) <= 2) {
            try {
                bot.pathfinder.setMovements(new pf.Movements(bot));
                let inverted_goal = new pf.goals.GoalInvert(new pf.goals.GoalFollow(enemy, 2));
                await bot.pathfinder.goto(inverted_goal, true);
            } catch (err) {/* might error if entity dies, ignore */}
        }
        bot.pvp.attack(enemy);
        attacked = true;
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
        if (bot.interrupt_code) {
            bot.pvp.stop();
            return false;
        }
    }
    bot.pvp.stop();
    if (attacked)
        log(bot, `Successfully defended self.`);
    else
        log(bot, `No enemies nearby to defend self from.`);
    return attacked;
}



export async function collectBlock(bot, blockType, num=1, exclude=null) {
    /**
     * Collect one of the given block type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to collect.
     * @param {number} num, the number of blocks to collect. Defaults to 1.
     * @param {list} exclude, a list of positions to exclude from the search. Defaults to null.
     * @returns {Promise<boolean>} true if the block was collected, false if the block type was not found.
     * @example
     * await skills.collectBlock(bot, "oak_log");
     **/
    if (num < 1) {
        log(bot, `Invalid number of blocks to collect: ${num}.`);
        return false;
    }
    let blocktypes = [blockType];
    if (blockType === 'coal' || blockType === 'diamond' || blockType === 'emerald' || blockType === 'iron' || blockType === 'gold' || blockType === 'lapis_lazuli' || blockType === 'redstone')
        blocktypes.push(blockType+'_ore');
    if (blockType.endsWith('ore'))
        blocktypes.push('deepslate_'+blockType);
    if (blockType === 'dirt')
        blocktypes.push('grass_block');
    if (blockType === 'cobblestone')
        blocktypes.push('stone');
    const isLiquid = blockType === 'lava' || blockType === 'water';

    let collected = 0;
    // Total item count, not per-item names: what a block drops (stone ->
    // cobblestone, ore -> raw metal) is a mapping this check does not need.
    const items_before_collect = bankedCount(bot);
    // Watermark for the in-loop pickup sweep below: what was in the bag the last
    // time we looked. It only moves forward, so a sweep that recovers nothing
    // does not make the next block think progress was made.
    let banked_at_last_sweep = items_before_collect;
    let since_sweep = 0;

    const movements = new pf.Movements(bot);
    movements.dontMineUnderFallingBlock = false;
    movements.dontCreateFlow = true;

    // Blocks to ignore safety for, usually next to lava/water
    const unsafeBlocks = ['obsidian'];

    // Two phases, because the old single predicate scan built a full Block for
    // every block within 64 just to read its name, which profiled at half the
    // agent's CPU. Phase one narrows to the right block type on integers; phase
    // two builds Blocks only for those candidates, since safeToBreak needs one.
    const block_ids = world.getBlockIdsByName(bot, blocktypes);
    const isExcluded = (block) => exclude?.some(p =>
        block.position.x === p.x && block.position.y === p.y && block.position.z === p.z);
    const isCollectable = (block) => isLiquid
        ? block.metadata === 0                                   // source blocks only
        : movements.safeToBreak(block) || unsafeBlocks.includes(block.name);

    for (let i=0; i<num; i++) {
        // CANDIDATES nearest blocks of the right type, then the first that is
        // actually collectable. Enough that "all of them are unsafe" does not
        // happen in practice; the old scan would have kept looking to 64.
        const CANDIDATES = 64;
        let blocks = [];
        for (const pos of world.findBlockPositions(bot, block_ids, 64, CANDIDATES)) {
            const block = bot.blockAt(pos);
            if (!block || isExcluded(block) || !isCollectable(block)) continue;
            blocks = [block];
            break;
        }

        if (blocks.length === 0) {
            if (collected === 0)
                log(bot, `No ${blockType} nearby to collect.`);
            else
                log(bot, `No more ${blockType} nearby to collect.`);
            break;
        }
        const block = blocks[0];
        await bot.tool.equipForBlock(block);
        if (isLiquid) {
            const bucket = bot.inventory.findInventoryItem('bucket');
            if (!bucket) {
                log(bot, `Don't have bucket to harvest ${blockType}.`);
                return false;
            }
            await bot.equip(bucket, 'hand');
        }
        const itemId = bot.heldItem ? bot.heldItem.type : null
        if (!block.canHarvest(itemId)) {
            log(bot, `Don't have right tools to harvest ${blockType}.`);
            return false;
        }
        try {
            let success = false;
            if (isLiquid) {
                success = await useToolOnBlock(bot, 'bucket', block);
            }
            else if (mc.mustCollectManually(blockType)) {
                await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2);
                if (wouldMaroon(bot, block.position)) {
                    log(bot, `Skipping ${blockType} at ${block.position}: breaking it would strand you on a pillar.`);
                    continue;
                }
                await bot.dig(block);
                await pickupNearbyItems(bot);
                success = true;
            }
            else {
                await bot.collectBlock.collect(block);
                // collectBlock breaks the block but only walks to the drop if
                // minecraft-data's drop table told it what to expect, which for
                // a modded block it did not. Sweeping once at the end is not
                // enough: a 20-log run walks the bot across the grove, and
                // pickupNearbyItems looks 8 blocks out, so the earlier drops are
                // long out of range by the time it runs -- "Broke 20 pine_log
                // but nothing entered your inventory", repeatedly, live.
                // So sweep as we go, and only when nothing arrived on its own:
                // on a vanilla server collectBlock banks the item itself and
                // this never fires.
                // Every SWEEP_STRIDE blocks, not every block: the sweep walks
                // the bot to each drop, and walking between digs is how
                // "Digging aborted" happens. Four is enough to keep the drops
                // inside pickupNearbyItems' 8-block reach on a normal tree,
                // while costing a quarter of the movement.
                if (++since_sweep >= SWEEP_STRIDE && bankedCount(bot) <= banked_at_last_sweep) {
                    await pickupNearbyItems(bot);
                    since_sweep = 0;
                }
                else if (bankedCount(bot) > banked_at_last_sweep) since_sweep = 0;
                banked_at_last_sweep = bankedCount(bot);
                success = true;
            }
            if (success)
                collected++;
            // Cancelling this at block 14 of 16 threw away the whole trip, and
            // what usually cancelled it was the model starting a new idea. Say
            // how far along we are so that kind of interrupter waits.
            reportProgress(bot, collected, num);
            await autoLight(bot);
        }
        catch (err) {
            if (err.name === 'NoChests') {
                log(bot, `Failed to collect ${blockType}: Inventory full, no place to deposit.`);
                break;
            }
            // An interrupt aborts the dig in progress, and every dig after it,
            // so `continue` here walked the rest of the block list logging
            // "Digging aborted" once per block -- twenty identical lines in one
            // action output, and the action ignoring the interrupt long enough
            // to be abandoned by force ten seconds later. The interrupt check at
            // the bottom of the loop never ran, because `continue` skips it.
            if (bot.interrupt_code) break;
            log(bot, `Failed to collect ${blockType}: ${err}.`);
            continue;
        }
        
        if (bot.interrupt_code)
            break;  
    }
    // The counter counts blocks broken, not items banked. Drops can fall into
    // holes, burn, or despawn ("Got 8 pine logs" with an empty inventory sent
    // the LLM planning around wood it did not have). Only claim success the
    // inventory can back up.
    const banked = await bankedAnything(bot, items_before_collect, collected, blockType);
    if (banked !== true) {
        // Three different stories, and telling the wrong one has a cost: every
        // one of these used to read "the drops were lost or are out of reach",
        // which is how the agent learned that the trees here are unobtainable
        // and then acted on it for hours. Two of the three cases are not even
        // about the drops.
        log(bot, {
            // Cut off before it could pick anything up. bankedAnything bails
            // early rather than pathfind past the grace period, so it never
            // looked -- this is not evidence about the drops in either direction.
            interrupted: `Broke ${collected} ${blockType}, but was interrupted before the drops could be picked up. They are probably still on the ground where you were. This says nothing about whether ${blockType} is collectable here.`,
            // The block broke and no item ever existed. Note that the tool check
            // before the dig cannot catch this: prismarine-block's canHarvest
            // returns true whenever harvestTools is undefined, which is every
            // block minecraft-data has never heard of -- so on a modded server
            // it always passes and protects nothing.
            no_drop: `Broke ${collected} ${blockType} but no dropped item ever appeared, so nothing was banked. This happens intermittently here and the same block type does work other times, so it is not proof that ${blockType} is uncollectable -- check !inventory, and if you need more, try again from a different spot rather than concluding it cannot be had.`,
            // The drops exist and the bot could not get to them.
            unreachable: `Broke ${collected} ${blockType} but could not reach the drops -- they are nearby and out of reach. Check !inventory before planning around them.`,
        }[banked] ?? `Broke ${collected} ${blockType} but nothing entered your inventory. Check !inventory before planning around them.`);
        return false;
    }
    log(bot, `Collected ${collected} ${blockType}.`);
    return collected > 0;
}

// Did the collect actually put anything in the bag, and if not, is that because
// the drops are still lying where they fell?
//
// mineflayer's collectBlock walks to a drop only if it recognises it, and it
// works that out from minecraft-data's drop table -- which has no entry for a
// modded block. On Prominence 2 the whole pine_log line therefore broke fine and
// was never picked up: seventeen "nothing entered your inventory" in six hours,
// so no wood, no planks, no sword, and twenty deaths holding nothing. The
// manual-collect branch in collectBlocks already sweeps after digging; this is
// the same sweep for the branch that does not.
//
// Separate and exported so the "swept, then re-checked" order is testable
// without standing up a chunk to break blocks in.
// The nearest dropped item, by any of the names mineflayer has called one.
// `entity.name === 'item'` alone is what the sweep used to check, and a drop
// entity a modded server registers under another name is invisible to it -- the
// sweep then walks nowhere and reports "picked up 0" while the log lies on the
// ground in front of the bot.
function getNearestDrop(bot, distance) {
    return bot.nearestEntity(e =>
        (e.name === 'item' || e.objectType === 'Item' || e.displayName === 'Item' || e.entityType === 'item')
        && bot.entity.position.distanceTo(e.position) < distance);
}

// How many items are in the bag, counting stacks. "Did that actually work" is
// asked of the inventory rather than of a counter, because the counter counts
// blocks broken and the drops can be lost.
export function bankedCount(bot) {
    return bot.inventory.items().reduce((sum, i) => sum + i.count, 0);
}

// Returns true if anything reached the bag, or one of 'interrupted' /
// 'no_drop' / 'unreachable' saying why not. The caller needs the distinction:
// all three used to be reported to the agent as "the drops were lost or are out
// of reach", and two of those were false statements that taught it the trees
// here are unobtainable.
export async function bankedAnything(bot, items_before, collected, blockType = 'the block') {
    const banked = () => bankedCount(bot);
    if (collected <= 0 || banked() > items_before) return true;
    // The sweep pathfinds once per item, so skipping it on an interrupt is not
    // an optimisation -- it stops the action being held open past its grace
    // period, which pickupNearbyItems already carries a comment about.
    if (bot.interrupt_code) return 'interrupted';
    // Let the drop exist before looking for it. The item entity arrives a tick
    // or two after the block break, and this check runs immediately after --
    // so a one-block collect swept an empty world, reported "picked up 0", and
    // declared the log lost while it was still spawning. Losses clustered on
    // small collects, which is what pointed at a race rather than at distance:
    // a long collect gets its later blocks swept anyway.
    await new Promise(resolve => setTimeout(resolve, 400));
    if (banked() > items_before) return true;
    await pickupNearbyItems(bot, RECOVERY_PICKUP_RADIUS);
    if (banked() > items_before) return true;
    return describeLostDrops(bot, blockType);
}

// Diagnostic for the losses that survive the sweep. Two explanations remain and
// they want opposite fixes, so guessing between them is how you ship the wrong
// one: either the drops are out of pickupNearbyItems' 8-block reach (felling a
// tall pine leaves the bot in the canopy while the logs fall to the forest
// floor), or there is no drop entity at all and the server consumed the block.
// One line each time says which. console, not log(), so it stays out of the
// action output the model reads.
function describeLostDrops(bot, blockType) {
    const held = bot.heldItem ? bot.heldItem.name : 'nothing';
    const near = getNearestDrop(bot, 64);
    if (!near) {
        // canHarvest already gated this break and said yes, so minecraft-data
        // believes the held item is sufficient. The server disagreed. That is
        // the usual shape of a modded block whose real tool requirement is not
        // in the vanilla registry -- so record what was actually in hand, which
        // is the one thing needed to tell that from a block that legitimately
        // drops nothing.
        // The tool theory is dead: this agent has never owned an axe and has
        // still banked 15 logs in one go, so logs plainly drop bare-handed here
        // and the failures are intermittent rather than categorical.
        //
        // What is left is whether the drop exists at all. mineflayer only tracks
        // entities it could parse, so a modded item entity it choked on would be
        // invisible to getNearestDrop while being perfectly real on the server --
        // which would explain the intermittency exactly (the bot banks them only
        // when it happens to walk over one). So list what IS nearby: if there are
        // entities here with names we do not recognise, that is the answer.
        const near_all = Object.values(bot.entities ?? {})
            .filter(e => e?.position && bot.entity.position.distanceTo(e.position) < 16)
            .map(e => e.name ?? e.displayName ?? `type:${e.type}`);
        console.log(`[lost drops] broke ${blockType} holding ${held}; no item entity within 64. `
            + `Entities within 16: ${near_all.length ? near_all.join(', ') : '(none at all)'}`);
        return 'no_drop';
    }
    const me = bot.entity.position;
    const dist = me.distanceTo(near.position);
    // Report the measurement, not a theory about it. The first version of this
    // line ended "but the sweep only reaches 8" unconditionally, and then
    // printed a distance of 5.6 -- asserting a cause the number contradicts.
    console.log(`[lost drops] nearest item is ${dist.toFixed(1)} away (dy ${(near.position.y - me.y).toFixed(1)}), `
        + `bot y=${me.y.toFixed(1)}, drop y=${near.position.y.toFixed(1)}. `
        + (dist >= RECOVERY_PICKUP_RADIUS ? `Beyond the recovery sweep's ${RECOVERY_PICKUP_RADIUS}-block reach.`
            : 'Within reach, so the sweep saw it and still could not get to it.'));
    return 'unreachable';
}

export async function pickupNearbyItems(bot, radius = PICKUP_RADIUS) {
    /**
     * Pick up all nearby items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the items were picked up, false otherwise.
     * @example
     * await skills.pickupNearbyItems(bot);
     **/
    let nearestItem = getNearestDrop(bot, radius);
    let pickedUp = 0;
    // Same shape as the sleep loop below: one pathfind per item, and nothing
    // watching the interrupt flag, so a pile of drops holds the action open past
    // the grace period.
    while (nearestItem && !bot.interrupt_code) {
        let movements = new pf.Movements(bot);
        // Logs do not always fall to the ground. Measured live: a drop 5.6 away
        // and 5 blocks ABOVE the bot -- resting on the leaves of the tree it had
        // just felled, well inside the sweep's reach, seen, and unreachable,
        // because canDig:false leaves no way up through a canopy. That was the
        // last unexplained source of "nothing entered your inventory".
        //
        // Digging is allowed only to reach a drop the bot already owns the work
        // for. It cannot wander: the goal is one specific item within
        // PICKUP_RADIUS, and scaffolding stays off, so the worst case is a few
        // leaf blocks broken in a tree that is already half gone.
        movements.canDig = true;
        movements.allow1by1towers = false;
        bot.pathfinder.setMovements(movements);
        // goToGoal throws on an unreachable goal, by design. A drop that fell
        // somewhere the bot cannot walk to is an ordinary outcome here -- logs
        // roll off into ravines and under trees -- and it must not take the
        // whole collect down with it. Give up on that one item and stop.
        try {
            await goToGoal(bot, new pf.goals.GoalFollow(nearestItem, 1));
        } catch (err) {
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
        let prev = nearestItem;
        nearestItem = getNearestDrop(bot, radius);
        if (prev === nearestItem) {
            break;
        }
        pickedUp++;
    }
    log(bot, `Picked up ${pickedUp} items.`);
    return true;
}


// Every break is locally harmless, but enough of them around the bot's own feet
// and it is standing on a 1x1 pillar over a void with nothing to bridge with --
// pathfinder then correctly reports no path from anywhere to anywhere, and the
// agent burns API calls retrying forever. Andy spent five hours like that at
// (7,80,3), having mined out everything within four blocks of himself.
//
// Marooned means every horizontal neighbour of the bot, at foot level and the
// level below, is air: nothing to step onto and nothing to dig into. A bot in a
// 1x1 shaft is enclosed, not marooned, so ordinary mining and digDown are
// untouched -- this only fires on the break that removes the last foothold.
//
// ponytail: one ring, no reachability search. Upgrade to a small flood fill if
// bots start stranding themselves two blocks out instead of one.
// Blocks the bot deliberately broke, so convenience modes do not undo the
// work: torch_placing kept re-torching the exact spot placeBlock had just
// cleared for a crafting table, and the two fought forever while the LLM
// wandered around the mine placing nothing.
const recently_cleared = new Map();
export function markCleared(x, y, z) {
    recently_cleared.set(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`, Date.now());
}
export function wasRecentlyCleared(x, y, z, ms = 60000) {
    const at = recently_cleared.get(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`);
    return at !== undefined && Date.now() - at < ms;
}

const FOOTHOLD_RING = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
export function wouldMaroon(bot, pos) {
    const feet = bot.entity?.position?.floored();
    if (!feet) return false;
    // Only the ground plane can strand the bot; a wall or a ceiling is never a
    // foothold, so breaking one cannot take the last one away.
    if (pos.y !== feet.y && pos.y !== feet.y - 1) return false;
    for (const [dx, dz] of FOOTHOLD_RING) {
        for (const dy of [0, -1]) {
            const p = feet.offset(dx, dy, dz);
            if (p.equals(pos)) continue;  // this one is about to become air
            const block = bot.blockAt(p);
            if (block && block.boundingBox === 'block') return false;
        }
    }
    return true;
}

export async function breakBlockAt(bot, x, y, z, allowNoDrop = false) {
    /**
     * Break the block at the given position. Will use the bot's equipped item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate of the block to break.
     * @param {number} y, the y coordinate of the block to break.
     * @param {number} z, the z coordinate of the block to break.
     * @returns {Promise<boolean>} true if the block was broken, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.breakBlockAt(bot, position.x, position.y - 1, position.x);
     **/
    if (x == null || y == null || z == null) throw new Error('Invalid position to break block at.');
    let block = bot.blockAt(Vec3(x, y, z));
    if (block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
        if (bot.modes.isOn('cheat')) {
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' air';
            bot.chat(msg);
            log(bot, `Used /setblock to break block at ${x}, ${y}, ${z}.`);
            return true;
        }

        if (bot.entity.position.distanceTo(block.position) > 4.5) {
            let pos = block.position;
            let movements = new pf.Movements(bot);
            movements.canPlaceOn = false;
            movements.allow1by1towers = false;
            bot.pathfinder.setMovements(movements);
            await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
        }
        if (bot.game.gameMode !== 'creative') {
            await bot.tool.equipForBlock(block);
            const itemId = bot.heldItem ? bot.heldItem.type : null
            if (!block.canHarvest(itemId)) {
                // canHarvest answers "will it drop", not "can it be cleared".
                // For descent and shelter digging the drop is irrelevant -- a
                // snow_block breaks barehanded in under a second and drops
                // nothing, and refusing it left the bot standing in the open
                // all night. Callers that only need the block GONE pass
                // allowNoDrop; the dig-time cap keeps bare-handed obsidian and
                // friends out.
                if (!allowNoDrop || bot.digTime(block) > 10000) {
                    log(bot, `Don't have right tools to break ${block.name}.`);
                    return false;
                }
            }
        }
        if (wouldMaroon(bot, block.position)) {
            log(bot, `Not breaking ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}: it is the last block you could step onto, and removing it would strand you on a pillar. Move somewhere else first, or place a block to stand on.`);
            return false;
        }
        await bot.dig(block, true);
        markCleared(x, y, z);
        log(bot, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    else {
        log(bot, `Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} because it is ${block.name}.`);
        return false;
    }
    return true;
}


export async function placeBlock(bot, blockType, x, y, z, placeOn='bottom', dontCheat=false) {
    /**
     * Place the given block type at the given position. It will build off from any adjacent blocks. Will fail if there is a block in the way or nothing to build off of.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to place, which can be a block or item name.
     * @param {number} x, the x coordinate of the block to place.
     * @param {number} y, the y coordinate of the block to place.
     * @param {number} z, the z coordinate of the block to place.
     * @param {string} placeOn, the preferred side of the block to place on. Can be 'top', 'bottom', 'north', 'south', 'east', 'west', or 'side'. Defaults to bottom. Will place on first available side if not possible.
     * @param {boolean} dontCheat, overrides cheat mode to place the block normally. Defaults to false.
     * @returns {Promise<boolean>} true if the block was placed, false otherwise.
     * @example
     * let p = world.getPosition(bot);
     * await skills.placeBlock(bot, "oak_log", p.x + 2, p.y, p.x);
     * await skills.placeBlock(bot, "torch", p.x + 1, p.y, p.x, 'side');
     **/
    const target_dest = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));

    if (blockType === 'air') {
        log(bot, `Placing air (removing block) at ${target_dest}.`);
        return await breakBlockAt(bot, x, y, z);
    }

    if (bot.modes.isOn('cheat') && !dontCheat) {
        if (bot.restrict_to_inventory) {
            let block = bot.inventory.findInventoryItem(blockType);
            if (!block) {
                log(bot, `Cannot place ${blockType}, you are restricted to your current inventory.`);
                return false;
            }
        }

        // invert the facing direction
        let face = placeOn === 'north' ? 'south' : placeOn === 'south' ? 'north' : placeOn === 'east' ? 'west' : 'east';
        if (blockType.includes('torch') && placeOn !== 'bottom') {
            // insert wall_ before torch
            blockType = blockType.replace('torch', 'wall_torch');
            if (placeOn !== 'side' && placeOn !== 'top') {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType.includes('button') || blockType === 'lever') {
            if (placeOn === 'top') {
                blockType += `[face=ceiling]`;
            }
            else if (placeOn === 'bottom') {
                blockType += `[face=floor]`;
            }
            else {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType === 'ladder' || blockType === 'repeater' || blockType === 'comparator') {
            blockType += `[facing=${face}]`;
        }
        if (blockType.includes('stairs')) {
            blockType += `[facing=${face}]`;
        }
        if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
        let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' ' + blockType;
        bot.chat(msg);
        if (blockType.includes('door'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y+1) + ' ' + Math.floor(z) + ' ' + blockType + '[half=upper]');
        if (blockType.includes('bed'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z-1) + ' ' + blockType + '[part=head]');
        log(bot, `Used /setblock to place ${blockType} at ${target_dest}.`);
        return true;
    }

    let item_name = blockType;
    if (item_name == "redstone_wire")
        item_name = "redstone";
    else if (item_name === 'water') {
        item_name = 'water_bucket';
    }
    else if (item_name === 'lava') {
        item_name = 'lava_bucket';
    }
    let block_item = bot.inventory.findInventoryItem(item_name);
    if (!block_item && bot.game.gameMode === 'creative' && !bot.restrict_to_inventory) {
        await bot.creative.setInventorySlot(36, mc.makeItem(item_name, 1)); // 36 is first hotbar slot
        block_item = bot.inventory.findInventoryItem(item_name);
    }
    if (!block_item) {
        log(bot, `Don't have any ${item_name} to place.`);
        return false;
    }

    const targetBlock = bot.blockAt(target_dest);
    if (targetBlock.name === blockType || (targetBlock.name === 'grass_block' && blockType === 'dirt')) {
        log(bot, `${blockType} already at ${targetBlock.position}.`);
        return false;
    }
    const empty_blocks = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern'];
    if (!empty_blocks.includes(targetBlock.name)) {
        log(bot, `${targetBlock.name} in the way at ${targetBlock.position}.`);
        const removed = await breakBlockAt(bot, x, y, z);
        if (!removed) {
            log(bot, `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 200)); // wait for block to break
    }
    // get the buildoffblock and facevec based on whichever adjacent block is not empty
    let buildOffBlock = null;
    let faceVec = null;
    const dir_map = {
        'top': Vec3(0, 1, 0),
        'bottom': Vec3(0, -1, 0),
        'north': Vec3(0, 0, -1),
        'south': Vec3(0, 0, 1),
        'east': Vec3(1, 0, 0),
        'west': Vec3(-1, 0, 0),
    }
    let dirs = [];
    if (placeOn === 'side') {
        dirs.push(dir_map['north'], dir_map['south'], dir_map['east'], dir_map['west']);
    }
    else if (dir_map[placeOn] !== undefined) {
        dirs.push(dir_map[placeOn]);
    }
    else {
        dirs.push(dir_map['bottom']);
        log(bot, `Unknown placeOn value "${placeOn}". Defaulting to bottom.`);
    }
    dirs.push(...Object.values(dir_map).filter(d => !dirs.includes(d)));

    for (let d of dirs) {
        const block = bot.blockAt(target_dest.plus(d));
        if (!empty_blocks.includes(block.name)) {
            buildOffBlock = block;
            faceVec = new Vec3(-d.x, -d.y, -d.z); // invert
            break;
        }
    }
    if (!buildOffBlock) {
        log(bot, `Cannot place ${blockType} at ${targetBlock.position}: nothing to place on.`);
        return false;
    }

    const pos = bot.entity.position;
    const pos_above = pos.plus(Vec3(0,1,0));
    const dont_move_for = ['torch', 'redstone_torch', 'redstone', 'lever', 'button', 'rail', 'detector_rail', 
        'powered_rail', 'activator_rail', 'tripwire_hook', 'tripwire', 'water_bucket', 'string'];
    if (!dont_move_for.includes(item_name) && (pos.distanceTo(targetBlock.position) < 1.1 || pos_above.distanceTo(targetBlock.position) < 1.1)) {
        // too close
        let goal = new pf.goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2);
        let inverted_goal = new pf.goals.GoalInvert(goal);
        bot.pathfinder.setMovements(new pf.Movements(bot));
        // Every other failure in this function logs a sentence and returns false.
        // These two threw the raw mineflayer NoPath instead, so !placeHere("furnace")
        // handed the agent a pathfinder stack trace it could do nothing with.
        try {
            await bot.pathfinder.goto(inverted_goal);
        } catch (err) {
            log(bot, `Cannot place ${blockType} at ${targetBlock.position}: you are standing on the spot and there is nowhere to step back to. Move somewhere more open and try again.`);
            return false;
        }
    }
    if (bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
        // too far
        let pos = targetBlock.position;
        let movements = new pf.Movements(bot);
        bot.pathfinder.setMovements(movements);
        try {
            await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
        } catch (err) {
            log(bot, `Cannot place ${blockType} at ${targetBlock.position}: no path to get within reach of it. Pick a spot closer to you.`);
            return false;
        }
    }

    // will throw error if an entity is in the way, and sometimes even if the block was placed
    try {
        if (item_name.includes('bucket')) {
            await useToolOnBlock(bot, item_name, buildOffBlock);
        }
        else {
            await bot.equip(block_item, 'hand');
            await bot.lookAt(buildOffBlock.position.offset(0.5, 0.5, 0.5));
            await bot.placeBlock(buildOffBlock, faceVec);
            log(bot, `Placed ${blockType} at ${target_dest}.`);
            await new Promise(resolve => setTimeout(resolve, 200));
            return true;
        }
    } catch (err) {
        log(bot, `Failed to place ${blockType} at ${target_dest}.`);
        return false;
    }
}

export async function equip(bot, itemName) {
    /**
     * Equip the given item to the proper body part, like tools or armor.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to equip.
     * @returns {Promise<boolean>} true if the item was equipped, false otherwise.
     * @example
     * await skills.equip(bot, "iron_pickaxe");
     **/
    if (itemName === 'hand') {
        await bot.unequip('hand');
        log(bot, `Unequipped hand.`);
        return true;
    }
    let item = bot.inventory.slots.find(slot => slot && slot.name === itemName);
    if (!item) {
        if (bot.game.gameMode === "creative") {
            await bot.creative.setInventorySlot(36, mc.makeItem(itemName, 1));
            item = bot.inventory.findInventoryItem(itemName);
        }
        else {
            log(bot, `You do not have any ${itemName} to equip.`);
            return false;
        }
    }
    if (itemName.includes('leggings')) {
        await bot.equip(item, 'legs');
    }
    else if (itemName.includes('boots')) {
        await bot.equip(item, 'feet');
    }
    else if (itemName.includes('helmet')) {
        await bot.equip(item, 'head');
    }
    else if (itemName.includes('chestplate') || itemName.includes('elytra')) {
        await bot.equip(item, 'torso');
    }
    else if (itemName.includes('shield')) {
        await bot.equip(item, 'off-hand');
    }
    else {
        await bot.equip(item, 'hand');
    }
    log(bot, `Equipped ${itemName}.`);
    return true;
}

export async function discard(bot, itemName, num=-1) {
    /**
     * Discard the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to discard.
     * @param {number} num, the number of items to discard. Defaults to -1, which discards all items.
     * @returns {Promise<boolean>} true if the item was discarded, false otherwise.
     * @example
     * await skills.discard(bot, "oak_log");
     **/
    let discarded = 0;
    while (true) {
        let item = bot.inventory.findInventoryItem(itemName);
        if (!item) {
            break;
        }
        let to_discard = num === -1 ? item.count : Math.min(num - discarded, item.count);
        await bot.toss(item.type, null, to_discard);
        discarded += to_discard;
        if (num !== -1 && discarded >= num) {
            break;
        }
    }
    if (discarded === 0) {
        log(bot, `You do not have any ${itemName} to discard.`);
        return false;
    }
    log(bot, `Discarded ${discarded} ${itemName}.`);
    return true;
}

export async function putInChest(bot, itemName, num=-1) {
    /**
     * Put the given item in the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to put in the chest.
     * @param {number} num, the number of items to put in the chest. Defaults to -1, which puts all items.
     * @returns {Promise<boolean>} true if the item was put in the chest, false otherwise.
     * @example
     * await skills.putInChest(bot, "oak_log");
     **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    const matches = mc.itemMatcher(itemName);
    let item = bot.inventory.items().find(i => matches(i.name));
    if (!item) {
        log(bot, `You do not have any ${itemName} to put in the chest.`);
        return false;
    }
    let to_put = num === -1 ? item.count : Math.min(num, item.count);
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await openWithRetry(bot, chest, b => bot.openContainer(b));
    if (!chestContainer) return false;
    await chestContainer.deposit(item.type, null, to_put);
    await chestContainer.close();
    log(bot, `Successfully put ${to_put} ${itemName} in the chest.`);
    return true;
}

export async function takeFromChest(bot, itemName, num=-1) {
    /**
     * Take the given item from the nearest chest, potentially from multiple slots.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to take from the chest.
     * @param {number} num, the number of items to take from the chest. Defaults to -1, which takes all items.
     * @returns {Promise<boolean>} true if the item was taken from the chest, false otherwise.
     * @example
     * await skills.takeFromChest(bot, "oak_log");
     * **/
    // The nearest chest is not the chest with the thing in it. Andy has built
    // twenty chests across this world, and arm_yourself_from_the_chest kept
    // opening whichever empty one it happened to be standing near and
    // reporting "Could not find any weapon in the chest" while a sword sat in
    // the camp chest -- through nine deaths in one night. Walk the nearest few
    // until one actually holds it.
    const chests = world.getNearestBlocks(bot, ['chest'], 32, 4);
    if (chests.length === 0) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    // Family names included: "weapon" is the only definition of a weapon
    // anywhere, and a rule that re-arms after death has nothing else to ask for.
    const matches = mc.itemMatcher(itemName);
    let chestContainer = null;
    let matchingItems = [];
    for (const chest of chests) {
        await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
        const opened = await openWithRetry(bot, chest, b => bot.openContainer(b));
        if (!opened) continue;
        const found = opened.containerItems().filter(item => matches(item.name));
        if (found.length > 0) { chestContainer = opened; matchingItems = found; break; }
        await opened.close();
    }
    if (!chestContainer) {
        log(bot, `Could not find any ${itemName} in the ${chests.length} nearest chests.`);
        return false;
    }
    
    let totalAvailable = matchingItems.reduce((sum, item) => sum + item.count, 0);
    let remaining = num === -1 ? totalAvailable : Math.min(num, totalAvailable);
    let totalTaken = 0;
    
    // Take items from each slot until we've taken enough or run out
    for (const item of matchingItems) {
        if (remaining <= 0) break;
        
        let toTakeFromSlot = Math.min(remaining, item.count);
        await chestContainer.withdraw(item.type, null, toTakeFromSlot);
        
        totalTaken += toTakeFromSlot;
        remaining -= toTakeFromSlot;
    }
    
    await chestContainer.close();
    log(bot, `Successfully took ${totalTaken} ${itemName} from the chest.`);
    return totalTaken > 0;
}

export async function viewChest(bot) {
    /**
     * View the contents of the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the chest was viewed, false otherwise.
     * @example
     * await skills.viewChest(bot);
     * **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await openWithRetry(bot, chest, b => bot.openContainer(b));
    if (!chestContainer) return false;
    let items = chestContainer.containerItems();
    if (items.length === 0) {
        log(bot, `The chest is empty.`);
    }
    else {
        log(bot, `The chest contains:`);
        for (let item of items) {
            log(bot, `${item.count} ${item.name}`);
        }
    }
    await chestContainer.close();
    return true;
}

export async function consume(bot, itemName="") {
    /**
     * Eat/drink the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item to eat/drink.
     * @returns {Promise<boolean>} true if the item was eaten, false otherwise.
     * @example
     * await skills.eat(bot, "apple");
     **/
    let item, name;
    if (itemName) {
        item = bot.inventory.findInventoryItem(itemName);
        name = itemName;
    }
    else {
        // The `if (itemName)` above always implied an else that was never
        // written, so consume() with no argument could only ever log "You do not
        // have any undefined to eat". Eating whatever food is in the bag is the
        // only thing a no-argument call can sensibly mean, and it lets one
        // policy rule cover hunger without naming every food in the game.
        item = bot.inventory.items().find(i => bot.registry.foods?.[i.type]);
        name = 'food';
    }
    if (!item) {
        log(bot, `You do not have any ${name} to eat.`);
        return false;
    }
    await bot.equip(item, 'hand');
    await bot.consume();
    log(bot, `Consumed ${item.name}.`);
    return true;
}


export async function giveToPlayer(bot, itemType, username, num=1) {
    /**
     * Give one of the specified item to the specified player
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemType, the name of the item to give.
     * @param {string} username, the username of the player to give the item to.
     * @param {number} num, the number of items to give. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was given, false otherwise.
     * @example
     * await skills.giveToPlayer(bot, "oak_log", "player1");
     **/
    if (bot.username === username) {
        log(bot, `You cannot give items to yourself.`);
        return false;
    }
    let player = bot.players[username].entity
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }
    await goToPlayer(bot, username, 3);
    // if we are 2 below the player
    log(bot, bot.entity.position.y, player.position.y);
    if (bot.entity.position.y < player.position.y - 1) {
        await goToPlayer(bot, username, 1);
    }
    // if we are too close, make some distance
    if (bot.entity.position.distanceTo(player.position) < 2) {
        let too_close = true;
        let start_moving_away = Date.now();
        await moveAwayFromEntity(bot, player, 2);
        while (too_close && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            too_close = bot.entity.position.distanceTo(player.position) < 5;
            if (too_close) {
                await moveAwayFromEntity(bot, player, 5);
            }
            if (Date.now() - start_moving_away > 3000) {
                break;
            }
        }
        if (too_close) {
            log(bot, `Failed to give ${itemType} to ${username}, too close.`);
            return false;
        }
    }

    await bot.lookAt(player.position);
    if (await discard(bot, itemType, num)) {
        let given = false;
        bot.once('playerCollect', (collector, collected) => {
            console.log(collected.name);
            if (collector.username === username) {
                log(bot, `${username} received ${itemType}.`);
                given = true;
            }
        });
        let start = Date.now();
        while (!given && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (given) {
                return true;
            }
            if (Date.now() - start > 3000) {
                break;
            }
        }
    }
    log(bot, `Failed to give ${itemType} to ${username}, it was never received.`);
    return false;
}

export async function goToGoal(bot, goal) {
    /**
     * Navigate to the given goal. Use doors and attempt minimally destructive movements.
     * Takes a pathfinder Goal OBJECT, not a position -- passing a Vec3 dies inside
     * getPathTo on "goal.heuristic is not a function". If you have coordinates,
     * call goToPosition(bot, x, y, z) instead; it builds the goal for you.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {pf.goals.Goal} goal, e.g. new pf.goals.GoalNear(x, y, z, range).
     **/

    // A target that just spun the pathfinder into the ground is not worth
    // walking at again a tick later. Fail the same way a walled-off goal fails,
    // so callers that already handle "no path" pick something else instead.
    if (isUnreachable(bot, goal.x, goal.y, goal.z))
        throw new Error('No path to the goal: it was unreachable moments ago');

    const nonDestructiveMovements = new pf.Movements(bot);
    const dontBreakBlocks = ['glass', 'glass_pane'];
    for (let block of dontBreakBlocks) {
        nonDestructiveMovements.blocksCantBreak.add(mc.getBlockId(block));
    }
    nonDestructiveMovements.placeCost = 2;
    nonDestructiveMovements.digCost = 10;

    const destructiveMovements = new pf.Movements(bot);

    let final_movements = destructiveMovements;

    // 1s was too short for goals a few dozen blocks out: reachable targets kept
    // probing as "no path" and fell into the walk-anyway branch below.
    const pathfind_timeout = 3000;
    const non_destructive = bot.pathfinder.getPathTo(nonDestructiveMovements, goal, pathfind_timeout).status;
    const destructive = non_destructive === 'success' ? null
        : bot.pathfinder.getPathTo(destructiveMovements, goal, pathfind_timeout).status;

    if (non_destructive === 'success') {
        final_movements = nonDestructiveMovements;
        log(bot, `Found non-destructive path.`);
    }
    else if (destructive === 'success') {
        log(bot, `Found destructive path.`);
    }
    else if (non_destructive === 'noPath' && destructive === 'noPath') {
        // Walking at an unreachable goal anyway just makes the bot thrash against
        // whatever is in the way until something else interrupts it. Fail fast so
        // the LLM sees "no path" and picks a different target.
        throw new Error('No path to the goal');
    }
    else {
        // 'timeout'/'partial' means the search ran out of budget, not that the
        // goal is walled off. On a modded server (17k block types) every probe
        // to Andy's own base 30 blocks away timed out, so goToGoal threw before
        // taking a step -- fourteen straight refusals to walk home, while
        // moveAway, which hands the goal straight to pathfinder, moved him every
        // time. pathfinder.goto replans as it walks and gets there.
        log(bot, `Path search ran long; heading that way and replanning as I go.`);
    }

    const doorCheckInterval = startDoorInterval(bot);

    bot.pathfinder.setMovements(final_movements);
    try {
        await bot.pathfinder.goto(goal);
        clearInterval(doorCheckInterval);
        return true;
    } catch (err) {
        clearInterval(doorCheckInterval);
        // we need to catch so we can clean up the door check interval, then rethrow the error
        throw err;
    }
}

let _doorInterval = null;
function startDoorInterval(bot) {
    /**
     * Start helper interval that opens nearby doors if the bot is stuck.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {number} the interval id.
     **/
    if (_doorInterval) {
        clearInterval(_doorInterval);
    }
    let prev_pos = bot.entity.position.clone();
    let prev_check = Date.now();
    let stuck_time = 0;


    const doorCheckInterval = setInterval(() => {
        const now = Date.now();
        if (bot.entity.position.distanceTo(prev_pos) >= 0.1) {
            stuck_time = 0;
        } else {
            stuck_time += now - prev_check;
        }
        
        if (stuck_time > 1200) {
            // shuffle positions so we're not always opening the same door
            const positions = [
                bot.entity.position.clone(),
                bot.entity.position.offset(0, 0, 1),
                bot.entity.position.offset(0, 0, -1), 
                bot.entity.position.offset(1, 0, 0),
                bot.entity.position.offset(-1, 0, 0),
            ]
            let elevated_positions = positions.map(position => position.offset(0, 1, 0));
            positions.push(...elevated_positions);
            positions.push(bot.entity.position.offset(0, 2, 0)); // above head
            positions.push(bot.entity.position.offset(0, -1, 0)); // below feet
            
            let currentIndex = positions.length;
            while (currentIndex != 0) {
                let randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;
                [positions[currentIndex], positions[randomIndex]] = [
                positions[randomIndex], positions[currentIndex]];
            }
            
            for (let position of positions) {
                let block = bot.blockAt(position);
                if (block && block.name &&
                    !block.name.includes('iron') &&
                    (block.name.includes('door') ||
                     block.name.includes('fence_gate') ||
                     block.name.includes('trapdoor'))) 
                {
                    bot.activateBlock(block);
                    break;
                }
            }
            stuck_time = 0;
        }
        prev_pos = bot.entity.position.clone();
        prev_check = now;
    }, 200);
    _doorInterval = doorCheckInterval;
    return doorCheckInterval;
}

export async function goToPosition(bot, x, y, z, min_distance=2) {
    /**
     * Navigate to the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to navigate to. If null, the bot's current x coordinate will be used.
     * @param {number} y, the y coordinate to navigate to. If null, the bot's current y coordinate will be used.
     * @param {number} z, the z coordinate to navigate to. If null, the bot's current z coordinate will be used.
     * @param {number} distance, the distance to keep from the position. Defaults to 2.
     * @returns {Promise<boolean>} true if the position was reached, false otherwise.
     * @example
     * let position = world.getNearestBlock(bot, "oak_log", 64).position;
     * await skills.goToPosition(bot, position.x, position.y, position.z);
     **/
    if (x == null || y == null || z == null) {
        log(bot, `Missing coordinates, given x:${x} y:${y} z:${z}`);
        return false;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        log(bot, `Invalid coordinates, given x:${x} y:${y} z:${z}. Block coordinates live on block.position, not on the block itself.`);
        return false;
    }
    if (!withinExplorationRadius(bot, x, z)) {
        log(bot, `${Math.round(Math.hypot(x - explorationAnchor(bot).x, z - explorationAnchor(bot).z))} blocks from home is outside the ${settings.exploration_radius} block exploration radius. Work closer to home.`);
        return false;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
        log(bot, `Teleported to ${x}, ${y}, ${z}.`);
        return true;
    }
    
    const checkDigProgress = () => {
        if (bot.targetDigBlock) {
            const targetBlock = bot.targetDigBlock;
            // canHarvest asks whether the block DROPS anything, not whether it can
            // be broken -- mineflayer's own canDigBlock does not consult tools at
            // all. Aborting on it stopped the bot digging snow, which takes a
            // second by hand and merely yields no snowball. That abort caused
            // replanning loops, the fix for those made the planner treat all snow
            // as impassable, and in a frozen taiga that left no route anywhere.
            // Time is the thing worth refusing: snow is 1s by hand, obsidian 250s.
            const ms = bot.digTime?.(targetBlock) ?? 0;
            if (ms > mc.MAX_HAND_DIG_MS) {
                log(bot, `Pathfinding stopped: ${targetBlock.name} would take ${Math.round(ms / 1000)}s to break with what you are holding.`);
                bot.pathfinder.stop();
                bot.stopDigging();
            }
        }
    };
    
    const progressInterval = setInterval(checkDigProgress, 1000);
    
    try {
        await goToGoal(bot, new pf.goals.GoalNear(x, y, z, min_distance));
        clearInterval(progressInterval);
        const distance = bot.entity.position.distanceTo(new Vec3(x, y, z));
        if (distance <= min_distance+1) {
            log(bot, `You have reached at ${x}, ${y}, ${z}.`);
            return true;
        }
        else {
            log(bot, `Unable to reach ${x}, ${y}, ${z}, you are ${Math.round(distance)} blocks away.`);
            return false;
        }
    } catch (err) {
        log(bot, `Pathfinding stopped: ${err.message}.`);
        clearInterval(progressInterval);
        return false;
    }
}

export async function goToNearestBlock(bot, blockType,  min_distance=2, range=64) {
    /**
     * Navigate to the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to navigate to.
     * @param {number} min_distance, the distance to keep from the block. Defaults to 2.
     * @param {number} range, the range to look for the block. Defaults to 64.
     * @returns {Promise<boolean>} true if the block was reached, false otherwise.
     * @example
     * await skills.goToNearestBlock(bot, "oak_log", 64, 2);
     * **/
    const MAX_RANGE = 512;
    if (range > MAX_RANGE) {
        log(bot, `Maximum search range capped at ${MAX_RANGE}. `);
        range = MAX_RANGE;
    }
    let block = null;
    if (blockType === 'water' || blockType === 'lava') {
        let blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType && block.metadata === 0, range, 1);
        if (blocks.length === 0) {
            log(bot, `Could not find any source ${blockType} in ${range} blocks, looking for uncollectable flowing instead...`);
            blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType, range, 1);
        }
        block = blocks[0];
    }
    else {
        block = world.getNearestBlock(bot, blockType, range);
    }
    if (!block) {
        log(bot, `Could not find any ${blockType} in ${range} blocks.`);
        return false;
    }
    log(bot, `Found ${blockType} at ${block.position}. Navigating...`);
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, min_distance);
    return true;
}

export async function goToNearestEntity(bot, entityType, min_distance=2, range=64) {
    /**
     * Navigate to the nearest entity of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} entityType, the type of entity to navigate to.
     * @param {number} min_distance, the distance to keep from the entity. Defaults to 2.
     * @param {number} range, the range to look for the entity. Defaults to 64.
     * @returns {Promise<boolean>} true if the entity was reached, false otherwise.
     **/
    let entity = world.getNearestEntityWhere(bot, entity => entity.name === entityType, range);
    if (!entity) {
        log(bot, `Could not find any ${entityType} in ${range} blocks.`);
        return false;
    }
    let distance = bot.entity.position.distanceTo(entity.position);
    log(bot, `Found ${entityType} ${distance} blocks away.`);
    await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, min_distance);
    return true;
}

// The server only sends entities inside its tracking range, so bot.entities can
// never answer "is there a sheep 400 blocks away". Saying "could not find any
// sheep in 500 blocks" told the LLM a 500-block radius was verified empty, and
// it correctly concluded travelling was pointless and went mining instead.
export const ENTITY_VIEW_RANGE = 96;

const HOP = 64;
const MAX_STOPS = 16;

/**
 * Waypoints along an Archimedean spiral out from the origin, one HOP of arc apart
 * and gaining one HOP of radius per turn. Every leg is a HOP, because a goal 200
 * blocks out just makes the pathfinder time out ("Took to long to decide path")
 * and the bot never leaves the spot it started from.
 * @returns {{x: number, z: number}[]} waypoints, nearest first.
 */
export function spiralWaypoints(origin, radius, stops, step=HOP) {
    const pts = [];
    let r = step, theta = 0;
    for (let k = 0; k < stops && r <= radius; k++) {
        pts.push({ x: Math.round(origin.x + r * Math.cos(theta)), z: Math.round(origin.z + r * Math.sin(theta)) });
        const dtheta = step / r;
        theta += dtheta;
        r += step * dtheta / (2 * Math.PI);
    }
    return pts;
}

export async function goToXZ(bot, x, z, closeness=8) {
    /**
     * Travel to a column, at whatever height the ground happens to be.
     * @returns {Promise<boolean>} true if it arrived.
     **/
    // A sweep waypoint is "go over there and look around", which has no business
    // naming a Y. Passing the starting Y made every waypoint on hilly taiga a
    // point buried in a hillside or hanging in mid-air, and A* spent its whole
    // budget failing to reach it -- "Took to long to decide path to goal!" on a
    // 64-block hop across open snow. GoalNearXZ asks for the column instead.
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    if (!withinExplorationRadius(bot, x, z)) {
        log(bot, `${Math.round(Math.hypot(x - explorationAnchor(bot).x, z - explorationAnchor(bot).z))} blocks from home is outside the ${settings.exploration_radius} block exploration radius. Work closer to home.`);
        return false;
    }
    try {
        await goToGoal(bot, new pf.goals.GoalNearXZ(x, z, closeness));
        return true;
    } catch (err) {
        log(bot, `Could not reach ${x}, ${z}: ${err.message}`);
        return false;
    }
}

export async function searchForEntity(bot, entityType, range=64, opts={}) {
    /**
     * Look for the nearest entity of the given type, travelling further out when the
     * loaded area has none, and navigate to it.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} entityType, the type of entity to find.
     * @param {number} range, how far to be willing to travel looking for it.
     * @param {object} opts, {pattern: 'spiral'|'random'}. Spiral sweeps a disc around
     *   the start and covers new ground; random hops blindly but never gets stuck on
     *   terrain a straight line cannot cross.
     * @returns {Promise<boolean>} true if the entity was reached, false otherwise.
     **/
    const pattern = opts.pattern ?? 'spiral';
    const travel = opts.travel ?? moveAway;
    const goTo = opts.goTo ?? ((b, x, _y, z, close) => goToXZ(b, x, z, close));
    const seen = () => world.getNearestEntityWhere(bot, e => e.name === entityType, ENTITY_VIEW_RANGE);

    if (seen()) return await goToNearestEntity(bot, entityType, 4, ENTITY_VIEW_RANGE);

    // Enough stops to sweep the disc at one view-radius per stop, capped so a big
    // range is a long walk rather than an unbounded one.
    const stops = Math.min(Math.max(Math.ceil((range - ENTITY_VIEW_RANGE) / HOP), 0), MAX_STOPS);
    const origin = bot.entity.position.clone ? bot.entity.position.clone() : { ...bot.entity.position };
    const route = pattern === 'spiral' ? spiralWaypoints(origin, range, stops) : null;
    // Biomes are only readable where the bot has been, so this steers as it goes:
    // arriving somewhere that looks like the last place means the sweep has not
    // reached new terrain, and the next waypoint gets skipped to break out faster.
    const biomes = new Set();
    let last_biome = null;
    // One unreachable waypoint is a wall in one direction, not a failed search --
    // the next waypoint points ~137 degrees elsewhere. Only give up once several
    // in a row fail, which means the bot cannot go anywhere at all.
    const MAX_BLOCKED = 3;
    let blocked = 0, arrived = 0;

    for (let i = 0; i < (route ? route.length : stops); i++) {
        // Returning silently here reported as "undefined", which the model read as
        // the search being broken -- it gave up on sheep and went back to mining.
        // An interrupted search is unfinished, not a negative result.
        if (bot.interrupt_code) {
            log(bot, `Search for ${entityType} was interrupted after ${arrived} stop(s), before it could cover any ground. Nothing was ruled out -- deal with whatever interrupted you, then search again.`);
            return false;
        }
        const here = bot.entity.position.clone ? bot.entity.position.clone() : { ...bot.entity.position };
        let moved;
        if (route) {
            const wp = route[i];
            log(bot, `No ${entityType} in sight; sweeping outward to ${wp.x}, ${wp.z}.`);
            moved = await goTo(bot, wp.x, origin.y, wp.z, 8);
            if (!moved) {
                // A* is superlinear in distance and this terrain is expensive to
                // search: in a frozen taiga every snow block costs a shovel the bot
                // does not have, so the planner has to route around all of it and
                // runs out of budget. Half as far is far less than half the search,
                // and it keeps the same heading -- better than giving up on the
                // direction entirely, and better than a random hop.
                const half = { x: Math.round((here.x + wp.x) / 2), z: Math.round((here.z + wp.z) / 2) };
                moved = await goTo(bot, half.x, origin.y, half.z, 8);
            }
            if (!moved) moved = await travel(bot, HOP);  // blocked: hop and rejoin the spiral
        }
        else {
            log(bot, `No ${entityType} in sight; travelling to look further.`);
            moved = await travel(bot, HOP);
        }
        // Ground covered is the only thing that matters here, so judge on distance,
        // not on what the call returned. Both directions of that are load-bearing:
        // moveAway reports success for a shuffle of one block, and pathfinder.goto
        // walks while it replans, so a goal that ends in "Took to long to decide
        // path" has often carried the bot most of the way there first. Counting
        // that as a failure is what kept reporting "you never left where you are
        // standing" after the bot had crossed 40 blocks of taiga.
        const travelled = here.distanceTo ? here.distanceTo(bot.entity.position) : Math.hypot(bot.entity.position.x - here.x, bot.entity.position.z - here.z);
        if (travelled < HOP / 4) {
            if (++blocked >= MAX_BLOCKED) break;
            continue;
        }
        blocked = 0;
        arrived++;
        if (seen()) return await goToNearestEntity(bot, entityType, 4, ENTITY_VIEW_RANGE);

        const biome = safeBiome(bot);
        if (biome) biomes.add(biome);
        if (route && biome && biome === last_biome) i++;
        last_biome = biome;
    }

    // "No sheep here" and "could not walk anywhere" are opposite conclusions. Saying
    // the first when the second happened is what sent the bot off to mine instead.
    if (arrived === 0) {
        log(bot, `Could not search for ${entityType}: every attempt to travel failed, so you never left where you are standing. You are probably walled in or on terrain the pathfinder cannot cross -- dig or build your way out to open ground first, then search again.`);
        return false;
    }
    const covered = biomes.size ? ` Terrain covered: ${[...biomes].join(', ')}.` : '';
    log(bot, `Could not find any ${entityType} within ${ENTITY_VIEW_RANGE} blocks of the ${arrived} place(s) reached.${covered} Only entities near you are visible, so keep travelling and searching -- an empty result does not mean this world has no ${entityType}.`);
    return false;
}

function safeBiome(bot) {
    try { return world.getBiomeName(bot); }
    catch { return null; }  // unloaded chunk or a modded biome id: not worth failing a search over
}

export async function goToPlayer(bot, username, distance=3) {
    /**
     * Navigate to the given player.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to navigate to.
     * @param {number} distance, the goal distance to the player.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.goToPlayer(bot, "player");
     **/
    if (bot.username === username) {
        log(bot, `You are already at ${username}.`);
        return true;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + username);
        log(bot, `Teleported to ${username}.`);
        return true;
    }

    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let player = bot.players[username].entity
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }

    distance = Math.max(distance, 0.5);
    const goal = new pf.goals.GoalFollow(player, distance);

    await goToGoal(bot, goal, true);

    log(bot, `You have reached ${username}.`);
}


export async function followPlayer(bot, username, distance=4) {
    /**
     * Follow the given player endlessly. Will not return until the code is manually stopped.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to follow.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.followPlayer(bot, "player");
     **/
    let player = bot.players[username].entity
    if (!player)
        return false;

    const move = new pf.Movements(bot);
    move.digCost = 10;
    bot.pathfinder.setMovements(move);
    let doorCheckInterval = startDoorInterval(bot);

    bot.pathfinder.setGoal(new pf.goals.GoalFollow(player, distance), true);
    log(bot, `You are now actively following player ${username}.`);


    while (!bot.interrupt_code) {
        await new Promise(resolve => setTimeout(resolve, 500));
        // in cheat mode, if the distance is too far, teleport to the player
        const distance_from_player = bot.entity.position.distanceTo(player.position);

        const teleport_distance = 100;
        const ignore_modes_distance = 30; 
        const nearby_distance = distance + 2;

        if (distance_from_player > teleport_distance && bot.modes.isOn('cheat')) {
            // teleport with cheat mode
            await goToPlayer(bot, username);
        }
        else if (distance_from_player > ignore_modes_distance) {
            // these modes slow down the bot, and we want to catch up
            bot.modes.pause('item_collecting');
            bot.modes.pause('hunting');
            bot.modes.pause('torch_placing');
        }
        else if (distance_from_player <= ignore_modes_distance) {
            bot.modes.unpause('item_collecting');
            bot.modes.unpause('hunting');
            bot.modes.unpause('torch_placing');
        }

        if (distance_from_player <= nearby_distance) {
            clearInterval(doorCheckInterval);
            doorCheckInterval = null;
            bot.modes.pause('unstuck');
            bot.modes.pause('elbow_room');
        }
        else {
            if (!doorCheckInterval) {
                doorCheckInterval = startDoorInterval(bot);
            }
            bot.modes.unpause('unstuck');
            bot.modes.unpause('elbow_room');
        }
    }
    clearInterval(doorCheckInterval);
    return true;
}


export function isBreathing(bot) {
    /**
     * Is the bot's head out of water? Oxygen only falls while the head is
     * submerged, so a full bar means air -- no matter what the block is called.
     * Block names cannot answer this: water, kelp, seagrass and any waterlogged
     * stair or slab all drown you, and only the first is named 'water'.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {boolean} true if the bot has full air.
     **/
    // ponytail: falls back to the old name check only if the server never sends
    // oxygen. Refill is ~5 ticks from empty, so waiting for a full bar costs a
    // quarter second and removes every false "surfaced".
    if (bot.oxygenLevel === undefined) {
        const head = bot.blockAt(bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0));
        return !head || head.name === 'air';
    }
    return bot.oxygenLevel >= 20;
}

// The air bar is sampled once per mode tick (300ms), so a 4s window holds about
// thirteen samples. A real drowning fills it; noise on this server manages one
// or two. Five is the line between them.
const AIR_WINDOW_MS = 4000;
const AIR_MIN_SAMPLES = 5;

/**
 * One air-bar sample, on the caller's clock. Called once per mode tick (300ms).
 *
 * The history lives on the bot, not on whoever asks, because the readers run at
 * different cadences: the self_preservation mode sees every tick, while a policy
 * condition is only evaluated every `cooldown` seconds. When each kept its own
 * samples, "two low readings within four seconds" meant something different to
 * each of them, and for surface_when_drowning (cooldown 5) it meant something
 * impossible -- its samples arrived 5s apart and could never both land inside a
 * 4s window, so the rule could not fire at all.
 */
export function recordAir(bot, window_ms=AIR_WINDOW_MS) {
    if (!bot) return;
    const now = Date.now();
    const seen = (bot._air_history ??= []);
    if (!seen.length || now - seen[seen.length - 1].t > 100)
        seen.push({ t: now, oxygen: bot.oxygenLevel });
    while (seen.length && now - seen[0].t > window_ms) seen.shift();
}

/**
 * Has the air bar been low for long enough to believe it?
 *
 * Not one reading: this server emits isolated low samples on a bot that is
 * breathing normally -- measured at oxygen=2 and oxygen=4 with nothing around
 * them. Not two either, which is what this asked for first: standing in a dry
 * cave with water somewhere nearby, the bar dipped past 12 twice inside four
 * seconds often enough to fire self_preservation 46 times in 20 minutes, 38 of
 * them finding full air by the time the action ran. Each was an interrupts:all
 * that killed the self-prompt loop, so the bot spent the period being rescued
 * from nothing.
 *
 * A real drowning fills the whole window -- measured seen=14 of a possible ~13
 * samples, oxygen 9,7,7,8,6,6,4 and falling. Noise manages one or two. Five
 * separates them with room to spare and costs 1.5s of a drowning that lasts
 * about fifteen.
 */
export function lowAirPersists(bot, air=12, min_samples=AIR_MIN_SAMPLES) {
    if (!bot || bot.oxygenLevel === undefined) return false;
    // Low NOW, not merely low recently: without this the verdict outlives the
    // emergency by a whole window, which had surface() dispatched at oxygen=20.
    if (bot.oxygenLevel > air) return false;
    const seen = bot._air_history ?? [];
    return seen.filter(s => s.oxygen !== undefined && s.oxygen <= air).length >= min_samples;
}

export async function surface(bot, timeout_seconds=20) {
    /**
     * Swim straight up until the bot's head is out of water. Abandons any
     * pathfinder goal first -- drowning outranks wherever it was going.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} timeout_seconds, give up after this long, so a bot sealed
     *      under a ceiling does not hold the action forever.
     * @returns {Promise<boolean>} true if the bot reached air.
     * @example
     * await skills.surface(bot);
     **/
    // ponytail: air is up. No pathfinder search for a reachable surface -- that
    // is what failed here in the first place, and it costs seconds the bot's
    // oxygen does not have. Straight up handles open water, which is where
    // bots actually drown; a ceiling overhead (ice over a lake, most often --
    // Andy drowned pinned under one) gets punched through rather than waited out.
    // Say so when there was nothing to do. "Surfaced with 20/20 air left" on a
    // bot that was already breathing reads as a phantom detection, and it sent
    // me chasing one twice: the readings that triggered this were real, the bot
    // just bobbed up on its own before the action got its turn to run.
    if (isBreathing(bot)) {
        log(bot, 'Already breathing by the time I got here; nothing to surface from.');
        return true;
    }
    bot.pathfinder.stop();
    bot.clearControlStates();
    bot.setControlState('jump', true);
    const start = Date.now();
    try {
        while (!bot.interrupt_code && Date.now() - start < timeout_seconds*1000) {
            const eye = bot.entity.eyeHeight ?? 1.62;
            const head = bot.blockAt(bot.entity.position.offset(0, eye, 0));
            // Air, not block names. A head inside kelp or seagrass drowns you
            // exactly like open water, but the block is named 'kelp' -- so the
            // old name !== 'water' test returned true on the first tick and the
            // log cheerfully reported "Surfaced with -1/20 air left" while Andy
            // died in a kelp forest. Oxygen is the server's own answer to the
            // only question being asked, and it costs nothing to read.
            if (isBreathing(bot)) {
                log(bot, `Surfaced with ${bot.oxygenLevel}/20 air left.`);
                return true;
            }
            // Pinned under a solid ceiling: swimming up does nothing, dig it out.
            const ceiling = bot.blockAt(bot.entity.position.offset(0, eye + 1, 0));
            if (ceiling && ceiling.name !== 'water' && ceiling.name !== 'air' && bot.canDigBlock(ceiling)) {
                try { await bot.dig(ceiling); } catch {}
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    } finally {
        bot.setControlState('jump', false);
    }
    log(bot, `Could not reach the surface within ${timeout_seconds} seconds.`);
    return false;
}

// A bot at the bottom of a shaft it dug itself has nowhere to path *to*. Every
// route out needs a climb the pathfinder will not plan from inside a one-wide
// hole, so it returns partial paths forever. Measured live: 1,607 pathfinder
// replans in four minutes, all from -24,65,-6, after a shelter rule dug down
// three blocks and then found no torch to place. give_up_on_a_stuck_path fired
// three times and every time called move_away, which is pathfinder-based and
// failed exactly the same way -- every escape route the agent has runs through
// the thing that is broken.
//
// A one-block-up goal is a search the pathfinder always solves. goToSurface
// already leans on that to get out from under a deep roof; this is the same
// trick scoped to climbing out of a pit rather than going all the way up, so a
// bot that dug in for the night does not get dragged into the open to fix it.
export async function climbOut(bot, blocks=3) {
    /**
     * Climb straight up out of a hole, one block at a time.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} blocks, how many blocks to climb at most.
     * @returns {Promise<boolean>} true if the bot gained any height.
     **/
    const start_y = bot.entity.position.y;
    for (let i = 0; i < blocks; i++) {
        if (bot.interrupt_code) break;
        const from = bot.entity.position.floored();
        try {
            await goToGoal(bot, new pf.goals.GoalBlock(from.x, from.y + 1, from.z));
        } catch (err) {
            break;
        }
        // No height gained means the next try will not fare better either: out
        // of blocks to pillar with, or out of pickaxe.
        if (bot.entity.position.y <= from.y) break;
    }
    const climbed = bot.entity.position.y - start_y;
    if (climbed < 1) return false;
    log(bot, `Climbed ${Math.round(climbed)} blocks up out of the hole.`);
    return true;
}

export async function moveAway(bot, distance) {
    /**
     * Move away from current position in any direction.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.moveAway(bot, 8);
     **/
    // Clone: bot.entity.position is mutated in place as the bot walks, so
    // holding the reference makes the "from" in the log follow the bot and
    // every move read as a no-op.
    const pos = bot.entity.position.clone();
    let goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(new pf.Movements(bot));

    if (bot.modes.isOn('cheat')) {
        const move = new pf.Movements(bot);
        const path = await bot.pathfinder.getPathTo(move, inverted_goal, 10000);
        let last_move = path.path[path.path.length-1];
        if (last_move) {
            let x = Math.floor(last_move.x);
            let y = Math.floor(last_move.y);
            let z = Math.floor(last_move.z);
            bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
            return true;
        }
    }

    // Not goToGoal: its up-front getPathTo probe reports 'noPath' for an
    // inverted goal (GoalInvert negates the heuristic, so A* cannot bound the
    // search) and goToGoal then throws before the bot takes a step. That is why
    // every escape in Andy's log said "nowhere to go" while standing on open
    // grass. pathfinder.goto walks the best partial path it finds instead.
    try {
        await bot.pathfinder.goto(inverted_goal);
    } catch (err) { /* handled by the distance check below */ }
    // Horizontal only. Getting away from something is a thing you do on the map,
    // and once climbOut was in the picture the bot could satisfy a 3-D distance
    // check by going straight up: it climbed two blocks, reported "Moved away
    // from (-30,14,-5) to (-30,16,-5)", fell back down, and reported that as a
    // move too. Measured at y=14 for ten minutes -- 14,15,16,17,16,15,14 over the
    // same column -- with every bounce logged as an escape, which cleared
    // path_stuck and kept anything else from escalating.
    const awayFrom = (p) => Math.hypot(p.x - pos.x, p.z - pos.z);
    let new_pos = bot.entity.position;
    // Stranded almost always means down a hole, and telling the agent to "try
    // digging out" only helps if it is getting turns -- which it is not, because
    // the pathfinder spin is what is eating them. Climb out here and retry: from
    // open ground the same inverted goal routes fine. The climb is setup, not
    // progress, which is exactly why it must not count toward the distance.
    if (awayFrom(new_pos) < 1 && await climbOut(bot)) {
        try {
            await bot.pathfinder.goto(inverted_goal);
        } catch (err) { /* handled by the distance check below */ }
        new_pos = bot.entity.position;
    }
    // goToGoal can also resolve without the bot getting anywhere, so a stranded
    // bot (pillar with no reachable neighbour, empty inventory) used to be told
    // it had moved and would try the same escape forever. Say it failed instead.
    if (awayFrom(new_pos) < 1) {
        log(bot, `Could not move away from ${pos.floored()}: nowhere to go. You may be stranded; try placing a block to walk on or digging out.`);
        return false;
    }
    log(bot, `Moved away from ${pos.floored()} to ${new_pos.floored()}.`);
    return true;
}

export async function moveAwayFromEntity(bot, entity, distance=16) {
    /**
     * Move away from the given entity.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to move away from.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     **/
    let goal = new pf.goals.GoalFollow(entity, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(new pf.Movements(bot));
    await bot.pathfinder.goto(inverted_goal);
    return true;
}

// Long enough to outrun anything worth outrunning -- twenty seconds of sprinting
// is the better part of a hundred blocks, and nothing calls this with a distance
// over about thirty.
export const FLEE_TIMEOUT_MS = 20000;

export async function avoidEnemies(bot, distance=16, timeout_ms=FLEE_TIMEOUT_MS) {
    /**
     * Move a given distance away from all nearby enemy mobs.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.avoidEnemies(bot, 8);
     **/
    bot.modes.pause('self_preservation'); // prevents damage-on-low-health from interrupting the bot
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
    // A flight that is not working has to end. The exit condition here was "no
    // hostile within `distance`", which is a condition the bot cannot always
    // reach: Andy met an enderman underground at y=52 with walls between them,
    // could not increase the gap, and re-armed a dynamic pathfinder goal every
    // 500ms forever. The spin backstop cleared that goal 46 times and this loop
    // put it straight back, so 4,653 pathfinder replans landed on one block in
    // four minutes and nothing else in the agent ran at all -- including
    // self_preservation, which this function pauses on the way in.
    //
    // Giving up is a real outcome and gets logged as one, so the agent reads
    // "running did not work" and can pick something else, rather than being told
    // it fled successfully or being told nothing at all.
    const deadline = Date.now() + timeout_ms;
    let gave_up = false;
    while (enemy) {
        if (Date.now() > deadline) {
            log(bot, `Could not get away from ${enemy.name ?? 'the mob'} in ${Math.round(timeout_ms/1000)}s -- it is still within ${distance} blocks. Running is not working here; try fighting, digging in, or putting a door between you.`);
            gave_up = true;
            break;
        }
        const follow = new pf.goals.GoalFollow(enemy, distance+1); // move a little further away
        const inverted_goal = new pf.goals.GoalInvert(follow);
        bot.pathfinder.setMovements(new pf.Movements(bot));
        bot.pathfinder.setGoal(inverted_goal, true);
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
        if (bot.interrupt_code) {
            break;
        }
        if (enemy && bot.entity.position.distanceTo(enemy.position) < 3) {
            await attackEntity(bot, enemy, false);
        }
    }
    bot.pathfinder.stop();
    if (gave_up) return false;
    log(bot, `Moved ${distance} away from enemies.`);
    return true;
}

export async function stay(bot, seconds=30, until=null, until_desc='') {
    /**
     * Stay in the current position until interrupted. Disables all modes.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} seconds, the number of seconds to stay. Defaults to 30. -1 for indefinite.
     * @param {function} until, optional zero-arg predicate; the stay ends as soon as it returns true.
     * @param {string} until_desc, human-readable description of `until`, used in the log.
     * @returns {Promise<boolean>} true if the bot stayed, false otherwise.
     * @example
     * await skills.stay(bot);
     * await skills.stay(bot, -1, () => bot.health >= 20, 'health is full');
     **/
    bot.modes.pause('self_preservation');
    bot.modes.pause('unstuck');
    bot.modes.pause('cowardice');
    bot.modes.pause('self_defense');
    bot.modes.pause('hunting');
    bot.modes.pause('torch_placing');
    bot.modes.pause('item_collecting');
    // ponytail: with no condition given, the only reason to park a bot
    // indefinitely is to wait out the night, so -1 means "until morning" rather
    // than "until heat death". Andy parked at dusk with !stay(-1) and was still
    // sitting at base the next afternoon ignoring its gathering goal.
    if (!until && seconds === -1 && world.isNight(bot)) {
        until = () => !world.isNight(bot);
        until_desc = 'day broke';
    }
    // A condition already true when we arrive means there is nothing to wait for.
    if (until && until()) {
        log(bot, `Not staying, ${until_desc || 'the condition'} already.`);
        return true;
    }
    let start = Date.now();
    while (!bot.interrupt_code && (seconds === -1 || Date.now() - start < seconds*1000)) {
        if (until && until()) {
            log(bot, `Stayed ${Math.round((Date.now() - start)/1000)} seconds, until ${until_desc || 'the condition was met'}.`);
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (until && !bot.interrupt_code)
        log(bot, `Gave up waiting for ${until_desc || 'the condition'} after ${seconds} seconds.`);
    else
        log(bot, `Stayed for ${(Date.now() - start)/1000} seconds.`);
    return true;
}

export async function useDoor(bot, door_pos=null) {
    /**
     * Use the door at the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Vec3} door_pos, the position of the door to use. If null, the nearest door will be used.
     * @returns {Promise<boolean>} true if the door was used, false otherwise.
     * @example
     * let door = world.getNearestBlock(bot, "oak_door", 16).position;
     * await skills.useDoor(bot, door);
     **/
    if (!door_pos) {
        for (let door_type of ['oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
                               'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door']) {
            door_pos = world.getNearestBlock(bot, door_type, 16).position;
            if (door_pos) break;
        }
    } else {
        door_pos = Vec3(door_pos.x, door_pos.y, door_pos.z);
    }
    if (!door_pos) {
        log(bot, `Could not find a door to use.`);
        return false;
    }

    bot.pathfinder.setGoal(new pf.goals.GoalNear(door_pos.x, door_pos.y, door_pos.z, 1));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    while (bot.pathfinder.isMoving()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    
    let door_block = bot.blockAt(door_pos);
    await bot.lookAt(door_pos);
    if (!door_block._properties.open)
        await bot.activateBlock(door_block);
    
    bot.setControlState("forward", true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    bot.setControlState("forward", false);
    await bot.activateBlock(door_block);

    log(bot, `Used door at ${door_pos}.`);
    return true;
}

export async function goToBed(bot) {
    /**
     * Sleep in the nearest bed.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bed was found, false otherwise.
     * @example
     * await skills.goToBed(bot);
     **/
    const beds = bot.findBlocks({
        matching: (block) => {
            return block.name.includes('bed');
        },
        maxDistance: 32,
        count: 1
    });
    if (beds.length === 0) {
        log(bot, `Could not find a bed to sleep in.`);
        return false;
    }
    let loc = beds[0];
    await goToPosition(bot, loc.x, loc.y, loc.z);
    const bed = bot.blockAt(loc);
    await bot.sleep(bed);
    log(bot, `You are in bed.`);
    bot.modes.pause('unstuck');
    while (bot.isSleeping) {
        // Sleeping lasts until morning -- minutes, not seconds -- and this loop
        // checked nothing, so the ActionManager's 10s grace period expired and
        // it abandoned the action every time: `action "mode:policy:
        // shelter_at_night" ignored the interrupt for 10s, abandoning it`.
        // Get out of bed on the way out, or everything that runs next is trying
        // to move a sleeping bot.
        if (bot.interrupt_code) {
            try { await bot.wake(); } catch { /* already awake, or the bed is gone */ }
            log(bot, `Woke up early.`);
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `You have woken up.`);
    return true;
}

export async function tillAndSow(bot, x, y, z, seedType=null) {
    /**
     * Till the ground at the given position and plant the given seed type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to till.
     * @param {number} y, the y coordinate to till.
     * @param {number} z, the z coordinate to till.
     * @param {string} plantType, the type of plant to plant. Defaults to none, which will only till the ground.
     * @returns {Promise<boolean>} true if the ground was tilled, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.tillAndSow(bot, position.x, position.y - 1, position.x, "wheat");
     **/
    let pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    let block = bot.blockAt(pos);
    log(bot, `Planting ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);

    if (bot.modes.isOn('cheat')) {
        let to_remove = ['_seed', '_seeds'];
        for (let remove of to_remove) {
            if (seedType.endsWith(remove)) {
                seedType = seedType.replace(remove, '');
            }
        }
        placeBlock(bot, 'farmland', x, y, z);
        placeBlock(bot, seedType, x, y+1, z);
        return true;
    }

    if (block.name !== 'grass_block' && block.name !== 'dirt' && block.name !== 'farmland') {
        log(bot, `Cannot till ${block.name}, must be grass_block or dirt.`);
        return false;
    }
    let above = bot.blockAt(new Vec3(x, y+1, z));
    if (above.name !== 'air') {
        if (block.name === 'farmland') {
            log(bot, `Land is already farmed with ${above.name}.`);
            return true;
        }
        let broken = await breakBlockAt(bot, x, y+1, z);
        if (!broken) {
            log(bot, `Cannot cannot break above block to till.`);
            return false;
        }
    }
    // if distance is too far, move to the block
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    if (block.name !== 'farmland') {
        let hoe = bot.inventory.items().find(item => item.name.includes('hoe'));
        let to_equip = hoe?.name || 'diamond_hoe';
        if (!await equip(bot, to_equip)) {
            log(bot, `Cannot till, no hoes.`);
            return false;
        }
        await bot.activateBlock(block);
        log(bot, `Tilled block x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    
    if (seedType) {
        if (seedType.endsWith('seed') && !seedType.endsWith('seeds'))
            seedType += 's'; // fixes common mistake
        let equipped_seeds = await equip(bot, seedType);
        if (!equipped_seeds) {
            log(bot, `No ${seedType} to plant.`);
            return false;
        }

        await bot.activateBlock(block);
        log(bot, `Planted ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    return true;
}

export async function activateNearestBlock(bot, type) {
    /**
     * Activate the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} type, the type of block to activate.
     * @returns {Promise<boolean>} true if the block was activated, false otherwise.
     * @example
     * await skills.activateNearestBlock(bot, "lever");
     * **/
    let block = world.getNearestBlock(bot, type, 16);
    if (!block) {
        log(bot, `Could not find any ${type} to activate.`);
        return false;
    }
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    await bot.activateBlock(block);
    log(bot, `Activated ${type} at x:${block.position.x.toFixed(1)}, y:${block.position.y.toFixed(1)}, z:${block.position.z.toFixed(1)}.`);
    return true;
}

/**
 * Helper function to find and navigate to a villager for trading
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager
 * @returns {Promise<Object|null>} the villager entity if found and reachable, null otherwise
 */
async function findAndGoToVillager(bot, id) {
    id = id+"";
    const entity = bot.entities[id];
    
    if (!entity) {
        log(bot, `Cannot find villager with id ${id}`);
        let entities = world.getNearbyEntities(bot, 16);
        let villager_list = "Available villagers:\n";
        for (let entity of entities) {
            if (entity.name === 'villager') {
                if (entity.metadata && entity.metadata[16] === 1) {
                    villager_list += `${entity.id}: baby villager\n`;
                } else {
                    const profession = world.getVillagerProfession(entity);
                    villager_list += `${entity.id}: ${profession}\n`;
                }
            }
        }
        if (villager_list === "Available villagers:\n") {
            log(bot, "No villagers found nearby.");
            return null;
        }
        log(bot, villager_list);
        return null;
    }
    
    if (entity.entityType !== bot.registry.entitiesByName.villager.id) {
        log(bot, 'Entity is not a villager');
        return null;
    }
    
    if (entity.metadata && entity.metadata[16] === 1) {
        log(bot, 'This is either a baby villager or a villager with no job - neither can trade');
        return null;
    }
    
    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance > 4) {
        log(bot, `Villager is ${distance.toFixed(1)} blocks away, moving closer...`);
        try {
            bot.modes.pause('unstuck');
            const goal = new pf.goals.GoalFollow(entity, 2);
            await goToGoal(bot, goal);
            
            
            log(bot, 'Successfully reached villager');
        } catch (err) {
            log(bot, 'Failed to reach villager - pathfinding error or villager moved');
            console.log(err);
            return null;
        } finally {
            bot.modes.unpause('unstuck');
        }
    }
    
    return entity;
}

/**
 * Show available trades for a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to show trades for
 * @returns {Promise<boolean>} true if trades were shown successfully, false otherwise
 * @example
 * await skills.showVillagerTrades(bot, "123");
 */
export async function showVillagerTrades(bot, id) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        log(bot, `Villager has ${villager.trades.length} available trades:`);
        stringifyTrades(bot, villager.trades).forEach((trade, i) => {
            const tradeInfo = `${i + 1}: ${trade}`;
            console.log(tradeInfo);
            log(bot, tradeInfo);
        });
        
        villager.close();
        return true;
    } catch (err) {
        log(bot, 'Failed to open villager trading interface - they might be sleeping, a baby, or jobless');
        console.log('Villager trading error:', err.message);
        return false;
    }
}

/**
 * Trade with a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to trade with
 * @param {number} index - the index (1-based) of the trade to execute
 * @param {number} count - how many times to execute the trade (optional)
 * @returns {Promise<boolean>} true if trade was successful, false otherwise
 * @example
 * await skills.tradeWithVillager(bot, "123", "1", "2");
 */
export async function tradeWithVillager(bot, id, index, count) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        const tradeIndex = parseInt(index) - 1; // Convert to 0-based index
        const trade = villager.trades[tradeIndex];
        
        if (!trade) {
            log(bot, `Trade ${index} not found. This villager has ${villager.trades.length} trades available.`);
            villager.close();
            return false;
        }
        
        if (trade.disabled) {
            log(bot, `Trade ${index} is currently disabled`);
            villager.close();
            return false;
        }

        const item_2 = trade.inputItem2 ? stringifyItem(bot, trade.inputItem2)+' ' : '';
        log(bot, `Trading ${stringifyItem(bot, trade.inputItem1)} ${item_2}for ${stringifyItem(bot, trade.outputItem)}...`);
        
        const maxPossibleTrades = trade.maximumNbTradeUses - trade.nbTradeUses;
        const requestedCount = count;
        const actualCount = Math.min(requestedCount, maxPossibleTrades);
        
        if (actualCount <= 0) {
            log(bot, `Trade ${index} has been used to its maximum limit`);
            villager.close();
            return false;
        }
        
        if (!hasResources(villager.slots, trade, actualCount)) {
            log(bot, `Don't have enough resources to execute trade ${index} ${actualCount} time(s)`);
            villager.close();
            return false;
        }
        
        log(bot, `Executing trade ${index} ${actualCount} time(s)...`);
        
        try {
            await bot.trade(villager, tradeIndex, actualCount);
            log(bot, `Successfully traded ${actualCount} time(s)`);
            villager.close();
            return true;
        } catch (tradeErr) {
            log(bot, 'An error occurred while trying to execute the trade');
            console.log('Trade execution error:', tradeErr.message);
            villager.close();
            return false;
        }
    } catch (err) {
        log(bot, 'Failed to open villager trading interface');
        console.log('Villager interface error:', err.message);
        return false;
    }
}

function hasResources(window, trade, count) {
    const first = enough(trade.inputItem1, count);
    const second = !trade.inputItem2 || enough(trade.inputItem2, count);
    return first && second;

    function enough(item, count) {
        let c = 0;
        window.forEach((element) => {
            if (element && element.type === item.type && element.metadata === item.metadata) {
                c += element.count;
            }
        });
        return c >= item.count * count;
    }
}

function stringifyTrades(bot, trades) {
    return trades.map((trade) => {
        let text = stringifyItem(bot, trade.inputItem1);
        if (trade.inputItem2) text += ` & ${stringifyItem(bot, trade.inputItem2)}`;
        if (trade.disabled) text += ' x '; else text += ' » ';
        text += stringifyItem(bot, trade.outputItem);
        return `(${trade.nbTradeUses}/${trade.maximumNbTradeUses}) ${text}`;
    });
}

function stringifyItem(bot, item) {
    if (!item) return 'nothing';
    let text = `${item.count} ${item.displayName}`;
    if (item.nbt && item.nbt.value) {
        const ench = item.nbt.value.ench;
        const StoredEnchantments = item.nbt.value.StoredEnchantments;
        const Potion = item.nbt.value.Potion;
        const display = item.nbt.value.display;

        if (Potion) text += ` of ${Potion.value.replace(/_/g, ' ').split(':')[1] || 'unknown type'}`;
        if (display) text += ` named ${display.value.Name.value}`;
        if (ench || StoredEnchantments) {
            text += ` enchanted with ${(ench || StoredEnchantments).value.value.map((e) => {
                const lvl = e.lvl.value;
                const id = e.id.value;
                return bot.registry.enchantments[id].displayName + ' ' + lvl;
            }).join(' ')}`;
        }
    }
    return text;
}

export async function digDown(bot, distance = 10) {
    /**
     * Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {int} distance, distance to dig down.
     * @returns {Promise<boolean>} true if successfully dug all the way down.
     * @example
     * await skills.digDown(bot, 10);
     **/

    let start_block_pos = bot.blockAt(bot.entity.position).position;
    for (let i = 1; i <= distance; i++) {
        const targetBlock = bot.blockAt(start_block_pos.offset(0, -i, 0));
        let belowBlock = bot.blockAt(start_block_pos.offset(0, -i-1, 0));

        if (!targetBlock || !belowBlock) {
            log(bot, `Dug down ${i-1} blocks, but reached the end of the world.`);
            return true;
        }

        // Check for lava, water
        if (targetBlock.name === 'lava' || targetBlock.name === 'water' || 
            belowBlock.name === 'lava' || belowBlock.name === 'water') {
            log(bot, `Dug down ${i-1} blocks, but reached ${belowBlock ? belowBlock.name : '(lava/water)'}`)
            return false;
        }

        const MAX_FALL_BLOCKS = 2;
        let num_fall_blocks = 0;
        for (let j = 0; j <= MAX_FALL_BLOCKS; j++) {
            if (!belowBlock || (belowBlock.name !== 'air' && belowBlock.name !== 'cave_air')) {
                break;
            }
            num_fall_blocks++;
            belowBlock = bot.blockAt(belowBlock.position.offset(0, -1, 0));
        }
        if (num_fall_blocks > MAX_FALL_BLOCKS) {
            log(bot, `Dug down ${i-1} blocks, but reached a drop below the next block.`);
            return false;
        }

        if (targetBlock.name === 'air' || targetBlock.name === 'cave_air') {
            log(bot, 'Skipping air block');
            console.log(targetBlock.position);
            continue;
        }

        let dug = await breakBlockAt(bot, targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, true);
        if (!dug) {
            log(bot, 'Failed to dig block at position:' + targetBlock.position);
            return false;
        }
    }
    log(bot, `Dug down ${distance} blocks.`);
    return true;
}

// mineflayer-pathfinder has no swim move, so a bot that falls into water with
// walls around it cannot path out even when dry land is one block away -- every
// goal reports "path not found" and the LLM is left improvising. Andy bobbed in
// a 2-block flooded pocket at (81,60,-124) doing exactly that, and teleporting
// him to the lip of the hole just let him walk back in.
//
// Steer out by hand instead: hold jump to float up, walk at the nearest dry
// landing. ponytail: straight-line steering, no obstacle avoidance. It only has
// to clear the puddle -- once the bot is on land pathfinder works again.
const LIQUIDS = ['water', 'lava', 'flowing_water', 'flowing_lava'];
const ESCAPE_RADIUS = 8;
const ESCAPE_TIMEOUT_MS = 10000;

export function isInLiquid(bot) {
    const feet = bot.blockAt(bot.entity.position.floored());
    return !!feet && LIQUIDS.includes(feet.name);
}

// Water's boundingBox is 'empty' like air's, so standing room has to be checked
// by name as well as by shape.
function isFreeSpace(block) {
    return !!block && block.boundingBox === 'empty' && !LIQUIDS.includes(block.name);
}

function nearestDryLanding(bot) {
    const feet = bot.entity.position.floored();
    let best = null;
    let best_dist = Infinity;
    for (let dx = -ESCAPE_RADIUS; dx <= ESCAPE_RADIUS; dx++) {
        for (let dz = -ESCAPE_RADIUS; dz <= ESCAPE_RADIUS; dz++) {
            for (let dy = -2; dy <= 4; dy++) {
                const p = feet.offset(dx, dy, dz);
                if (bot.blockAt(p.offset(0, -1, 0))?.boundingBox !== 'block') continue;
                if (!isFreeSpace(bot.blockAt(p))) continue;
                if (!isFreeSpace(bot.blockAt(p.offset(0, 1, 0)))) continue;
                const dist = p.distanceTo(feet);
                if (dist < best_dist) { best_dist = dist; best = p; }
            }
        }
    }
    return best;
}

export async function escapeLiquid(bot) {
    /**
     * Swim to the nearest dry standing spot. Pathfinder cannot do this.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bot reached dry land, false if it
     * was never in liquid or could not get clear.
     **/
    if (!isInLiquid(bot)) return false;
    const target = nearestDryLanding(bot);
    if (!target) {
        log(bot, `You are in liquid and there is no dry ground within ${ESCAPE_RADIUS} blocks. Break the blocks around you or place blocks to climb out.`);
        return false;
    }
    const aim = target.offset(0.5, 0, 0.5);
    const deadline = Date.now() + ESCAPE_TIMEOUT_MS;
    bot.setControlState('jump', true);  // swim up instead of sinking
    bot.setControlState('forward', true);
    try {
        while (Date.now() < deadline && !bot.interrupt_code) {
            await bot.lookAt(aim, true);
            if (!isInLiquid(bot) && bot.entity.position.distanceTo(aim) < 1.5) break;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    } finally {
        bot.setControlState('jump', false);
        bot.setControlState('forward', false);
    }
    const escaped = !isInLiquid(bot);
    log(bot, escaped
        ? `Swam out of the liquid onto ${target}.`
        : `Could not swim clear of the liquid; still at ${bot.entity.position.floored()}.`);
    return escaped;
}

// Things that sit on top of the ground rather than being it. Taking the first
// solid block down from the sky put the surface goal on top of a pine tree, and
// "stand exactly here, 20 blocks up a trunk" is a search that fails -- which is
// how a bot sealed under stone in a taiga concluded there was no surface at all.
const NOT_GROUND = ['leaves', 'log', '_wood', 'sapling', 'vine', 'snow', 'bamboo', 'sugar_cane', 'cactus', 'mushroom'];

// How far sideways to look for a dry column when the shaft runs into an
// aquifer. Cave pools are usually a few blocks across, and every block of
// detour is a block to tunnel through. ponytail: a flat square scan of the two
// blocks we are about to break, not a survey of the whole water body -- if
// bots start ping-ponging along the edge of a lake, follow the shoreline
// instead of picking the nearest dry spot.
const DETOUR_RADIUS = 4;

function isLiquid(block) {
    return !!block && (block.name.includes('water') || block.name.includes('lava'));
}

// The nearest column we have not already stood in whose next two blocks up are
// dry, or null if we are under open water in every direction.
function dryColumnNear(bot, from, visited) {
    let best = null;
    for (let dx = -DETOUR_RADIUS; dx <= DETOUR_RADIUS; dx++) {
        for (let dz = -DETOUR_RADIUS; dz <= DETOUR_RADIUS; dz++) {
            if (dx === 0 && dz === 0) continue;
            const x = from.x + dx, z = from.z + dz;
            if (visited.has(`${x},${z}`)) continue;
            if (isLiquid(bot.blockAt(new Vec3(x, from.y + 2, z)))) continue;
            if (isLiquid(bot.blockAt(new Vec3(x, from.y + 3, z)))) continue;
            const dist = dx * dx + dz * dz;
            if (!best || dist < best.dist) best = { x, z, dist };
        }
    }
    return best;
}

export async function goToSurface(bot) {
    /**
     * Navigate to the surface (highest ground block at current x,z), digging up if walled in.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the surface was reached, false otherwise.
     **/
    const pos = bot.entity.position;
    let ground = null;
    for (let y = 360; y > -64; y--) { // probably not the best way to find the surface but it works
        const block = bot.blockAt(new Vec3(pos.x, y, pos.z));
        if (!block || block.name === 'air' || block.name === 'cave_air') continue;
        if (NOT_GROUND.some(n => block.name.includes(n))) continue;
        ground = block.position;
        break;
    }
    if (!ground) return false;
    const surface_y = ground.y + 1;
    if (Math.floor(pos.y) >= surface_y) {
        log(bot, `Already at the surface at y=${Math.floor(pos.y)}.`);
        return true;
    }

    // Report whether we actually got there. Swallowing the failure made a
    // pinned "interrupts: all" drowning rule look like it was making
    // progress, so it never backed off and re-fired every cooldown for
    // hours, starving every other rule and the unstuck mode with it.
    if (await goToPosition(bot, ground.x, surface_y, ground.z, 1)) {
        log(bot, `Going to the surface at y=${surface_y}.`);
        return true;
    }

    // Sealed in. Pathfinder digs and pillars perfectly well, but only along a
    // route it can see end to end, and under a deep roof that search comes back
    // noPath -- which is how a bot holding 75 cobblestone and a pickaxe spent
    // hours reporting it could not climb. A one-block-up goal is a search it
    // always solves, so take the roof off a layer at a time.
    log(bot, `No path to the surface; digging straight up from y=${Math.floor(bot.entity.position.y)}.`);
    const flooded = new Set();
    while (bot.entity.position.y < surface_y) {
        if (bot.interrupt_code) return false;
        const from = bot.entity.position.floored();
        // Breaking into an aquifer floods the shaft you are standing in the
        // bottom of, and the first climb out of a cave ended in drowning. Slide
        // the shaft over to a dry column and keep climbing from there. Every
        // wet column is remembered, so a detour can never pick its way back
        // into one it already fled and loop.
        const ceiling = bot.blockAt(from.offset(0, 2, 0));
        if (isLiquid(ceiling)) {
            flooded.add(`${from.x},${from.z}`);
            const dry = dryColumnNear(bot, from, flooded);
            if (!dry) {
                log(bot, `There is ${ceiling.name} above y=${from.y} and no dry column within ${DETOUR_RADIUS} blocks. Move somewhere else and try again.`);
                return false;
            }
            log(bot, `There is ${ceiling.name} above y=${from.y}; moving the shaft to ${dry.x}, ${dry.z}.`);
            try {
                await goToGoal(bot, new pf.goals.GoalBlock(dry.x, from.y, dry.z));
            } catch (err) {
                log(bot, `Could not dig sideways clear of the ${ceiling.name}: ${err.message}.`);
                return false;
            }
            continue;
        }
        try {
            await goToGoal(bot, new pf.goals.GoalBlock(from.x, from.y + 1, from.z));
        } catch (err) {
            log(bot, `Could not dig up past y=${from.y}: ${err.message}.`);
            return false;
        }
        // No height gained means the next attempt will not fare better either:
        // out of blocks to pillar with, or out of pickaxe.
        if (bot.entity.position.y <= from.y) {
            log(bot, `Stuck at y=${from.y}, cannot climb any higher. Check that you have a pickaxe and blocks to build with.`);
            return false;
        }
    }
    log(bot, `Dug up to the surface at y=${Math.floor(bot.entity.position.y)}.`);
    return true;
}

export async function useToolOn(bot, toolName, targetName) {
    /**
     * Equip a tool and use it on the nearest target.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {string} targetName - entity type, block type, or "nothing" for no target
     * @returns {Promise<boolean>} true if action succeeded
     */
    if (!bot.inventory.slots.find(slot => slot && slot.name === toolName) && !bot.game.gameMode === 'creative') {
        log(bot, `You do not have any ${toolName} to use.`);
        return false;
    }

    targetName = targetName.toLowerCase();
    if (targetName === 'nothing') {
        const equipped = await equip(bot, toolName);
        if (!equipped) {
            return false;
        }
        await bot.activateItem();
        log(bot, `Used ${toolName}.`);
    } else if (world.isEntityType(targetName)) {
        const entity = world.getNearestEntityWhere(bot, e => e.name === targetName, 64);
        if (!entity) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z);
        if (toolName === 'hand') {
            await bot.unequip('hand');
        }
        else {
            const equipped = await equip(bot, toolName);
            if (!equipped) return false;
        }
        await bot.useOn(entity);
        log(bot, `Used ${toolName} on ${targetName}.`);
    } else {
        let block = null;
        if (targetName === 'water' || targetName === 'lava') {
            // we want to get liquid source blocks, not flowing blocks
            // so search for blocks with metadata 0 (not flowing)
            let blocks = world.getNearestBlocksWhere(bot, block => block.name === targetName && block.metadata === 0, 64, 1);
            if (blocks.length === 0) {
                log(bot, `Could not find any source ${targetName}.`);
                return false;
            }
            block = blocks[0];
        }
        else {
            block = world.getNearestBlock(bot, targetName, 64);
        }
        if (!block) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        return await useToolOnBlock(bot, toolName, block);
    }

    return true;
 }

 export async function useToolOnBlock(bot, toolName, block) {
    /**
     * Use a tool on a specific block.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {Block} block - the block reference to use the tool on.
     * @returns {Promise<boolean>} true if action succeeded
     */

    const distance = toolName === 'water_bucket' && block.name !== 'lava' ? 1.5 : 2;
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, distance);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));

    // if block in view is closer than the target block, it is in our way. try to move closer
    const viewBlocked = () => {
        const blockInView = bot.blockAtCursor(5);
        const headPos = bot.entity.position.offset(0, bot.entity.height, 0);
        return blockInView && 
            !blockInView.position.equals(block.position) && 
            blockInView.position.distanceTo(headPos) < block.position.distanceTo(headPos);
    }
    const blockInView = bot.blockAtCursor(5);
    if (viewBlocked()) {
        log(bot, `Block ${blockInView.name} is in the way, moving closer...`);
        // choose random block next to target block, go to it
        const nearbyPos = block.position.offset(Math.random() * 2 - 1, 0, Math.random() * 2 - 1);
        await goToPosition(bot, nearbyPos.x, nearbyPos.y, nearbyPos.z, 1);
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
        if (viewBlocked()) {
            const blockInView = bot.blockAtCursor(5);
            log(bot, `Block ${blockInView.name} is in the way, not using ${toolName}.`);
            return false;
        }
    }

    const equipped = await equip(bot, toolName);

    if (!equipped) {
        log(bot, `Could not equip ${toolName}.`);
        return false;
    }
    if (toolName.includes('bucket')) {
        await bot.activateItem();
    }
    else {
        await bot.activateBlock(block);
    }
    log(bot, `Used ${toolName} on ${block.name}.`);
    return true;
 }
