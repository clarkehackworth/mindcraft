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
    // Never penalise the escape route: if the bot is in water, water is free so
    // the pathfinder can route it back to the shore instead of around it.
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
