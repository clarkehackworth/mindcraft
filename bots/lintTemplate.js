import * as skills from '../../../src/agent/library/skills.js';
import * as world from '../../../src/agent/library/world.js';
import Vec3 from 'vec3';
import pf from 'mineflayer-pathfinder';

const log = skills.log;
// Matches the sandbox in coder.js _stageCode. Keep the two in step, or lint
// passes code the compartment cannot run (or rejects code it can).
const goals = pf.goals;

export async function main(bot) {
    /* CODE HERE */
    log(bot, 'Code finished.');
}