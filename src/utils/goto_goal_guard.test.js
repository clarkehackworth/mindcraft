// Run: node src/utils/goto_goal_guard.test.js
// Live crash, 3 occurrences: generated code wrote
//   await bot.pathfinder.goto(new Vec3(free.x + 0.5, free.y + 1, free.z + 0.5))
// instead of passing a Goal. pathfinder stores the object and only calls
// goal.isValid() on the next physics tick, inside an EventEmitter and outside
// any promise chain -- so the await never rejects, nothing can catch it, and
// the agent process dies with
//   TypeError: stateGoal.isValid is not a function
// The guard has to reject where the caller's try/catch can still see it.
import assert from 'assert';
import { tameMovements } from './mcdata.js';

function fakeBot() {
    const calls = [];
    return {
        calls,
        entity: { position: { x: 0, y: 0, z: 0 } },
        pathfinder: {
            goto: async (goal) => { calls.push(goal); return 'went'; },
            setMovements: () => {},
        },
    };
}

const bot = fakeBot();
tameMovements(bot);

// A Vec3 -- what the model actually wrote.
const vec3ish = { x: 1, y: 2, z: 3 };
let err = null;
try { await bot.pathfinder.goto(vec3ish); } catch (e) { err = e; }

assert.ok(err, 'coordinates must reject, not sail through to the physics tick');
assert.match(err.message, /Goal/, 'the message says what was expected');
assert.match(err.message, /goToPosition/, 'and points at the skill that does this properly');
assert.equal(bot.calls.length, 0, 'the bad goal never reaches pathfinder, so no tick can trip over it');

// A real goal still works untouched.
const goal = { isEnd: () => true, isValid: () => true, heuristic: () => 0 };
assert.equal(await bot.pathfinder.goto(goal), 'went', 'a genuine Goal passes through');
assert.equal(bot.calls.length, 1);
assert.equal(bot.calls[0], goal);

// GoalInvert and friends wrap a goal but are still goals; anything exposing the
// interface is fine. Null must not slip past as "falsy, probably harmless".
for (const bad of [null, undefined, 'base', 42, { isEnd: () => true }]) {
    let threw = false;
    try { await bot.pathfinder.goto(bad); } catch { threw = true; }
    assert.ok(threw, `${JSON.stringify(bad)} is not a goal and must be rejected`);
}

console.log('ok: goto rejects coordinates in the caller instead of killing the process on a physics tick');
process.exit(0);
