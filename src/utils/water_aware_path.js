// Water-aware pathing cost. The pathfinder treats water as a free block to route
// through, which is how Andy kept getting sent into deep pools to reach a goal
// (or to flee) and then stuck bobbing with no dry landing in range and no blocks
// to pillar. This adds a SOFT, state+depth-aware penalty so the bot strongly
// prefers a dry route but can still cross shallow water when no dry route exists
// -- and it is always a no-op once the bot is itself in water, so it can path out.
//
// Mirrors the existing updateLavaAvoidance pattern (state-aware add/remove of an
// avoidance). Deliberately a cost, NOT blocksToAvoid: a hard avoid would make a
// river uncrossable and is exactly the 'can't get across' trap we are fixing.

// A shallow crossing (1 deep) is nearly free; anything deeper is a pool/pit and
// is where the drown deaths concentrate. Two blocks of liquid above the feet is
// the threshold that separates 'a stream I can wade' from 'a hole I can drown in'.
const DEEP_WATER_COST = 40;
const SHALLOW_WATER_COST = 4;

// The flooded cave ring around the verified Base (-29, 63, 89). Every documented
// drown in the last windows is inside it, at the cave layer y=53-58:
//   (-23.5, 57.2, 65.5)  (-23.5, 57, 112.5)  (-27, 56, 91)  (-25, 58, 87)
//   (-33, 54, 87)  (-39, 53, 87)  plus the stuck pocket (-41, 59, 85)
// The soft DEEP_WATER_COST (40) was measured too weak against a goal pull -- he
// was mid gather_wood_for_base when the planner routed him through. A box that
// prices its water near the unbreakable cap makes A* route the long way around
// instead. It stops at y=60: the Base itself and its surface approaches sit at
// y=63 and must stay cheap. Never 100 -- the pathfinder treats 100 as an
// absolute wall, and a bot that is already inside must keep a free way out.
export const DEATH_WATER_COST = 99;
export const DEATH_POCKET_BOX = { xMin: -45, xMax: -15, yMin: 48, yMax: 60, zMin: 60, zMax: 118 };
export function inDeathPocket(pos) {
    if (!pos) return false;
    return pos.x >= DEATH_POCKET_BOX.xMin && pos.x <= DEATH_POCKET_BOX.xMax
        && pos.y >= DEATH_POCKET_BOX.yMin && pos.y <= DEATH_POCKET_BOX.yMax
        && pos.z >= DEATH_POCKET_BOX.zMin && pos.z <= DEATH_POCKET_BOX.zMax;
}

// A pickaxe is the one thing that lets a bot dig OUT of the cave layer. The
// 2026-09-03 starvation death: stuck at y=54 in a water/coal depression, bare
// hands, no way out, starved. The water box prices the pocket at 99 (a strong
// deterrent, but not a veto) for everyone -- that was still enough that a
// tool-less bot got routed down. The wrapper upgrades that 99 to the 100
// unbreakable wall while this is false, so a pickaxe-less route routes the
// long way around; a bot carrying a pickaxe can still descend to mine and can
// always dig itself out. (A shovel does not count: the trap was coal_ore and
// diorite, which only a pickaxe clears.) Shared with the wrapper -- not a
// separate cost, because waterCost already owns the pocket price.
export function hasDigTool(bot) {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function'
        ? bot.inventory.items() : [];
    return items.some(i => i && (i.name || '').includes('pickaxe'));
}

// Liquid names we treat as water for routing purposes (not lava -- lava has its
// own, stronger avoidance in the pathfinder patch).
function isWater(block) {
    return !!block && block.boundingBox === 'empty' && /water/.test(block.name) && !/lava/.test(block.name);
}

// Is this water block 'deep' -- i.e. liquid directly above the feet block (a
// pool you float in) or liquid below it (you'd sink)? A 1-deep stream has air
// above and solid below, so it stays cheap.
export function waterDepth(bot, pos) {
    const here = bot.blockAt(pos);
    if (!isWater(here)) return 0;
    const above = bot.blockAt(pos.offset(0, 1, 0));
    const below = bot.blockAt(pos.offset(0, -1, 0));
    const liquidAbove = above && /water|lava/.test(above.name);
    const liquidBelow = below && /water|lava/.test(below.name);
    return (liquidAbove || liquidBelow) ? 2 : 1;
}

// The soft cost to add for stepping into a water block at `pos`. Zero when the
// bot is already in water (it must be free to path out) or when the water is a
// shallow, wadable stream.
export function waterCost(bot, pos) {
    if (!bot || !pos) return 0;
    // A bot physically INSIDE the pocket keeps a free exit route (its own way
    // out). This is the only escape that overrides the pocket price, and it is
    // keyed on position -- not on isInWater. Keying it on isInWater was the leak:
    // the moment he waded any stream outside the pocket, isInWater flipped true
    // and the whole pocket went free, so the planner routed straight through it.
    if (bot.entity && inDeathPocket(bot.entity.position)) return 0;
    // Documented drown pockets get near-unbreakable pricing while a plain deep
    // pool stays a soft cost. The box is the measured death ring, not a guess.
    if (inDeathPocket(pos)) return DEATH_WATER_COST;
    // Legacy escape for NON-pocket water: if the bot is in water, water is free
    // so the pathfinder can route it back to shore instead of around a river.
    // It no longer wins over the pocket box -- that is what the two in-box
    // drownings exposed.
    if (bot.entity && bot.entity.isInWater) return 0;
    const depth = waterDepth(bot, pos);
    if (depth === 0) return 0;
    return depth >= 2 ? DEEP_WATER_COST : SHALLOW_WATER_COST;
}

// Install the state-aware water cost onto a Movements instance. Sets a cost
// hook the pathfinder's nodeCost/safeOrBreak consults, and exposes
// updateWaterAvoidance() (mirroring updateLavaAvoidance) so the caller can
// refresh the state before each path computation.
export function installWaterAvoidance(movements, bot) {
    if (!movements || !bot) return movements;
    movements._waterCostBot = bot;
    // Install the soft water cost exactly once, guarded by a distinct sentinel.
    // The previous version only wrapped safeOrBreak in the branch that required
    // the saved reference to already exist, so on a fresh Movements (the only
    // case the pathfinder ever gives us) the wrapper was never installed and the
    // water cost was dead code. Save the original, wrap it, done.
    if (movements._waterCostInstalled) return movements;
    const originalSafeOrBreak = movements.safeOrBreak.bind(movements);
    movements._waterCostInstalled = true;
    movements.safeOrBreak = function (block, toBreak) {
        let base;
        try {
            base = originalSafeOrBreak.call(this, block, toBreak);
        } catch (err) {
            // The pathfinder runs in the tick loop where nothing catches; a cost
            // hook must never throw. On any error degrade to the unbreakable cost
            // rather than letting the whole path (and the agent process) die.
            base = 100;
        }
        if (base <= 100 && block && block.position) {
            let extra = 0;
            try {
                extra = waterCost(bot, block.position);
            } catch (err) {
                extra = 0;
            }
            // Starvation fix (2026-09-03, stuck at (-26,54,82) with no
            // pickaxe): waterCost already priced the death pocket at 99 for
            // everyone; upgrade that to the 100 unbreakable wall for a bot that
            // cannot dig itself out, so it is never routed into a hole it
            // cannot get out of. A pickaxe bot keeps the 99 (it can descend to
            // mine and can always dig out), and a bot already INSIDE the pocket
            // got 0 from waterCost itself -- the free exit is preserved.
            if (extra === DEATH_WATER_COST && !hasDigTool(bot)) return 100;
            // Never push a traversable water block over the 100 'unbreakable' cap,
            // or the pathfinder would treat a wadable pool as a wall.
            if (extra && base + extra <= 100) return base + extra;
        }
        return base;
    };
    // Mirror updateLavaAvoidance so callers can (re)arm before each path. The
    // cost is recomputed live in waterCost via bot.entity.isInWater, so this is
    // a no-op marker kept for API symmetry with the lava hook.
    movements.updateWaterAvoidance = function () {};
    return movements;
}

export { DEEP_WATER_COST, SHALLOW_WATER_COST, isWater };
