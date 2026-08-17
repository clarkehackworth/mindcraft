// Run: node src/agent/path_drop_under_attack.test.js
// Andy spent his last second at 23,72,-3 doing eleven pathfinder partial
// searches from one block -- visited 25, 55, 82, ... 235 -- and a zombie killed
// him in the middle of them, unarmed with items0. Two of the five deaths that
// window were that shape. Being hit while a path is being searched roots the
// bot: A* runs, the bot stands still, and every partial restarts the wait.
//
// A search that has not produced a route by the time something is biting is not
// going to save anybody. Dropping it hands the next tick to self_preservation,
// self_defense and the shelter rules, which can act.
import assert from 'assert';

const HOSTILE_PANIC_RANGE = 6;

// The handler body, in the shape agent.js has it.
function makeHandler({ nearestHostile }) {
    const bot = { health: 20, pathfinder: { goal: {}, stopped: false, stop() { this.stopped = true; } }, entity: {} };
    const onHealth = (next) => {
        const hurt = next < bot.health;
        bot.health = next;
        if (!hurt) return;
        if (bot.pathfinder?.goal && bot.entity && nearestHostile(HOSTILE_PANIC_RANGE)) bot.pathfinder.stop();
    };
    return { bot, onHealth };
}

// Bitten mid-search: the search goes.
{
    const { bot, onHealth } = makeHandler({ nearestHostile: () => ({ name: 'zombie' }) });
    onHealth(16);
    assert.equal(bot.pathfinder.stopped, true, 'the path is dropped so something else can act');
}

// Hurt with nothing close -- fall damage, starvation, an archer far off -- keeps
// its path. Cancelling every route on every scratch would strand the bot.
{
    const { bot, onHealth } = makeHandler({ nearestHostile: () => null });
    onHealth(16);
    assert.equal(bot.pathfinder.stopped, false, 'no hostile in reach, no reason to abandon the route');
}

// Healing is not being attacked.
{
    const { bot, onHealth } = makeHandler({ nearestHostile: () => ({ name: 'zombie' }) });
    bot.health = 10;
    onHealth(14);
    assert.equal(bot.pathfinder.stopped, false, 'regeneration must not cancel paths');
}

// And with no path running there is nothing to drop.
{
    const { bot, onHealth } = makeHandler({ nearestHostile: () => ({ name: 'zombie' }) });
    bot.pathfinder.goal = null;
    onHealth(16);
    assert.equal(bot.pathfinder.stopped, false);
}

console.log('ok: a path being searched is dropped when something is biting');
