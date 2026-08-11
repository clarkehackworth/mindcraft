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
//
// Failing in the same block is the whole signal: real travel over a partial
// path moves the bot, which resets the count. A hundred searches without one
// block of progress is not bad luck.
//
// ponytail: exact block, so a bot jittering between two of them resets the
// count and slips through. The wedge that cost fifty minutes was 34,360
// failures on a single block, so exact is enough for now; widen to "within N
// blocks of where the streak started" if a jittering one ever shows up.
export const PATH_SPIN_LIMIT = 100;

// Counts consecutive pathfinder failures in one block on `state`, and returns
// true on the single tick that crosses the limit -- the caller aborts the goal
// there, and the count keeps climbing so this fires once per streak, not once
// per tick after it.
export function notePathFailure(state, at) {
    if (at === state.path_stuck_at) state.path_stuck_count++;
    else { state.path_stuck_at = at; state.path_stuck_count = 1; }
    return state.path_stuck_count === PATH_SPIN_LIMIT;
}
