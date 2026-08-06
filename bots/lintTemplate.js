import * as skills from '../../../src/agent/library/skills.js';
import * as world from '../../../src/agent/library/world.js';
import Vec3 from 'vec3';
import pf from 'mineflayer-pathfinder';

const log = skills.log;
// Matches the sandbox in coder.js _stageCode. Keep the two in step, or lint
// passes code the compartment cannot run (or rejects code it can). pf itself is
// exposed as well as pf.goals: the model writes `new pf.goals.GoalNear(...)`
// about as often as the bare `goals.` form.
const goals = pf.goals;

// __log via a default parameter, matching execTemplate -- see the comment there.
export async function main(bot, __log = log) {
    /* CODE HERE */
    __log(bot, 'Code finished.');
}