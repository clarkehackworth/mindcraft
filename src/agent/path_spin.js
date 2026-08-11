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
// true on the single tick that crosses the limit -- the caller aborts the goal
// there, and the count keeps climbing so this fires once per streak, not once
// per tick after it.
export function notePathFailure(state, x, y, z) {
    const origin = state.path_stuck_origin;
    const inside = origin
        && Math.abs(x - origin.x) <= PATH_SPIN_RADIUS
        && Math.abs(y - origin.y) <= PATH_SPIN_RADIUS
        && Math.abs(z - origin.z) <= PATH_SPIN_RADIUS;
    if (inside) state.path_stuck_count++;
    else { state.path_stuck_origin = { x, y, z }; state.path_stuck_count = 1; }
    return state.path_stuck_count === PATH_SPIN_LIMIT;
}
