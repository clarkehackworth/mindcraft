// mineflayer-pathfinder recomputes a *partial* path on every physics tick and
// pathfinder.goto() never settles for one: no goal_reached, no noPath, no
// timeout, so the promise stays pending forever. That promise is usually being
// awaited by a mode or a rule, which the arbiter awaits, which the agent's tick
// loop awaits -- so one bot in one hole stops every mode and every rule in the
// process. Measured live: Andy dug down 3, got interrupted mid-dig, and spun
// 35,685 failed searches on block 173,54,-61 in fifty minutes. Zero rule fires
// in that window, including give_up_on_a_stuck_path, which exists for exactly
// this and never got a turn to look. Upstream is 2.4.5 and last published in
// 2023, so the stop has to come from here.
export const PATH_SPIN_LIMIT = 100;

// Going nowhere is the signal, and "nowhere" is a small box, not a block.
// Soak 5 day 4 burned 8,321 searches with 5,942 of them inside one 16-cube and
// never tripped either counter, because the bot jittered between neighbouring
// blocks and every step reset the streak to 1. It pathed in place for most of a
// game-day and made ten paid turns.
//
// The box is anchored where the streak started and never follows the bot, so a
// bot actually travelling leaves it within a step or two and starts clean --
// only a bot orbiting one spot keeps landing back inside.
export const PATH_SPIN_RADIUS = 2;

// Counts consecutive pathfinder failures inside one box on `state`, and returns
// true every time the count reaches a multiple of the limit -- not once per
// tick, but not once per streak either.
//
// Strict equality was the bug. Aborting the goal does not stop the goal loop
// from immediately re-targeting the same unreachable thing, and once the count
// has passed 100 it never equals 100 again, so the streak got exactly one
// rescue and then spun unrescued forever. Watched live: 4,558 partial paths in
// six minutes, all inside one box, with the bot oscillating between two blocks
// and looking, to anyone in the world, like it was standing still.
export function notePathFailure(state, x, y, z) {
    const origin = state.path_stuck_origin;
    const inside = origin
        && Math.abs(x - origin.x) <= PATH_SPIN_RADIUS
        && Math.abs(y - origin.y) <= PATH_SPIN_RADIUS
        && Math.abs(z - origin.z) <= PATH_SPIN_RADIUS;
    if (inside) state.path_stuck_count++;
    else { state.path_stuck_origin = { x, y, z }; state.path_stuck_count = 1; }
    return state.path_stuck_count % PATH_SPIN_LIMIT === 0;
}

// Aborting the goal does not remove the reason the bot wanted it. Andy's memory
// named a base 390 blocks west; the self layer's shelter rule kept asking to go
// there from camp, the pathfinder could not route it, and the spin restarted the
// moment the backstop cleared it -- 392 partial searches in eight minutes, all
// at one block, all for the same unreachable place. The backstop caps the cost
// of each attempt; only remembering the target stops the attempts.
//
// Short-lived on purpose. Terrain changes, the bot moves, and a target that was
// unroutable from a hole is fine from open ground -- so this is a cooldown on a
// bad idea, not a permanent verdict.
export const UNREACHABLE_TTL_MS = 5 * 60 * 1000;
export const UNREACHABLE_RADIUS = 4;

export function noteUnreachable(bot, x, y, z, now = Date.now()) {
    if (![x, y, z].every(Number.isFinite)) return; // GoalFollow and friends have no fixed target
    (bot._unreachable_goals ??= []).push({ x, y, z, until: now + UNREACHABLE_TTL_MS });
}

export function isUnreachable(bot, x, y, z, now = Date.now()) {
    const list = bot._unreachable_goals;
    if (!list?.length) return false;
    bot._unreachable_goals = list.filter(g => g.until > now);
    return bot._unreachable_goals.some(g =>
        Math.abs(x - g.x) <= UNREACHABLE_RADIUS &&
        Math.abs(y - g.y) <= UNREACHABLE_RADIUS &&
        Math.abs(z - g.z) <= UNREACHABLE_RADIUS);
}
