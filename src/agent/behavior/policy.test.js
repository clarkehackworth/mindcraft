// Run: node src/agent/behavior/policy.test.js
// A rule whose only trigger is "nothing is happening" fires forever. Andy got a
// compiled policy that wandered 8 blocks every 3 seconds whenever it was idle
// and safe, so it ping-ponged around one hillside and every command it tried
// was stomped by the next tick. validatePolicy has to reject that shape.
import assert from 'assert';
import { validatePolicy, CONDITIONS, ACTIONS, Rule } from './policy.js';

const idle_and_safe = {
    all: [{ not: { cond: 'hostile_nearby', range: 16 } }, { cond: 'is_idle' }],
};

// The rule that caused the loop, verbatim from bots/Andy/policy.json.
const wander = {
    rules: [{
        name: 'move_freely_when_safe',
        description: 'Move freely when no hostiles and idle',
        when: idle_and_safe,
        do: [{ act: 'move_away', distance: 8 }],
        interrupts: 'idle',
        cooldown: 3,
    }],
};
assert.match(validatePolicy(wander) ?? '', /fires whenever nothing is happening/, 'an idle-only wander rule is rejected');

// Its twin: same trigger, re-prompts the LLM with the same text forever.
const nag = { rules: [{ ...wander.rules[0], name: 'seek_cover', do: [{ act: 'prompt_self', message: 'find cover' }], cooldown: 30 }] };
assert.ok(validatePolicy(nag), 'an idle-only prompt_self rule is rejected too');

// Same trigger is fine once the rule actually makes progress.
const collect = { rules: [{ ...wander.rules[0], name: 'tidy_up', do: [{ act: 'collect', type: 'dirt', num: 1 }] }] };
assert.equal(validatePolicy(collect), null, 'an idle rule that does real work is allowed');

// Reacting to something real is not enough on its own. Andy's next policy had
// avoid_hostile_areas: hostile within 24 -> move_away 16. move_away picks a
// random direction, so it landed back inside the radius and ping-ponged
// between two cave positions for hours. Cowardice already does this properly.
const retreat = { rules: [{ ...wander.rules[0], name: 'back_off', when: { cond: 'hostile_nearby', range: 24 }, interrupts: 'all' }] };
assert.match(validatePolicy(retreat) ?? '', /cowardice mode/, 'a proximity-triggered retreat rule is rejected');

// Same for flee, and for a compound trigger that includes proximity.
const flee_compound = { rules: [{ ...retreat.rules[0], when: { all: [{ cond: 'hostile_nearby', range: 16 }, { cond: 'is_night' }] }, do: [{ act: 'flee', distance: 24 }] }] };
assert.ok(validatePolicy(flee_compound), 'flee on proximity is rejected too');

// But retreating plus doing something cowardice cannot is allowed. (cooldown 5 because
// an interrupts:all rule that fires faster than that cancels everything else forever.)
const retreat_and_report = { rules: [{ ...retreat.rules[0], cooldown: 5, do: [{ act: 'move_away', distance: 16 }, { act: 'say', message: 'mobs here' }] }] };
assert.equal(validatePolicy(retreat_and_report), null, 'a retreat rule that also does real work is allowed');

// And move_away triggered by something other than proximity is fine.
const cramped = { rules: [{ ...retreat.rules[0], cooldown: 5, when: { cond: 'player_nearby', name: 'any', range: 2 } }] };
assert.equal(validatePolicy(cramped), null, 'move_away is fine on a non-proximity trigger');

// stay must carry a parseable "until" exit condition — a stay with no exit
// parks the bot forever (Andy sat at base through two full days).
const camp = { rules: [{ ...wander.rules[0], name: 'night_camp', when: { cond: 'is_night' }, do: [{ act: 'goto', x: 0, y: 64, z: 0 }, { act: 'stay', until: 'not is_night' }] }] };
assert.equal(validatePolicy(camp), null, 'stay with a valid until condition is allowed');
assert.match(validatePolicy({ rules: [{ ...camp.rules[0], do: [{ act: 'stay' }] }] }) ?? '', /until/, 'stay without until is rejected');
assert.match(validatePolicy({ rules: [{ ...camp.rules[0], do: [{ act: 'stay', until: 'is_wednesday' }] }] }) ?? '', /until/, 'stay with an unknown condition is rejected');
assert.equal(validatePolicy({ rules: [{ ...camp.rules[0], do: [{ act: 'stay', until: 'hunger_below 10 or hostile_nearby 8' }] }] }), null, 'stay accepts compound flat conditions');

// The ranged search actions exist so policies can find food without an LLM.
const forage = { rules: [{ ...wander.rules[0], name: 'forage', do: [{ act: 'search_entity', type: 'cow', range: 128 }, { act: 'attack', type: 'cow' }] }] };
assert.equal(validatePolicy(forage), null, 'search_entity is a valid action');
assert.equal(validatePolicy({ rules: [{ ...forage.rules[0], do: [{ act: 'search_block', type: 'sweet_berry_bush' }] }] }), null, 'search_block is a valid action');

// A night rule that only walks somewhere re-fires until morning, because
// arriving does not end the night. Live: go_to_chest_at_night fired 176x/15min.
const night_walk = { rules: [{ name: 'go_to_chest_at_night', when: { cond: 'is_night' }, do: [{ act: 'goto', x: 78, y: 63, z: -124 }], cooldown: 3 }] };
assert.match(validatePolicy(night_walk) ?? '', /re-path|parks/, 'a night rule that only walks is rejected');
assert.equal(validatePolicy({ rules: [{ ...night_walk.rules[0], do: [...night_walk.rules[0].do, { act: 'stay', until: 'not is_night' }] }] }), null, 'the same rule is fine once it parks with stay');
assert.equal(validatePolicy({ rules: [{ ...night_walk.rules[0], when: { not: { cond: 'is_night' } } }] }), null, 'a daytime goto rule is unaffected');


// "underwater" compiled to block_nearby water, true on the shore too, so the
// surface rule fired 8x/90s. The drowning condition keys off oxygen instead.
// cooldown 5 is the floor for interrupts:all, and it is what the shipped drowning
// rule uses: air lasts ~15s underwater, so 5s still gives three attempts.
const drown = { rules: [{ name: 'surface_when_drowning', when: { cond: 'drowning' }, do: [{ act: 'go_to_surface' }], interrupts: 'all', cooldown: 5 }] };
assert.equal(validatePolicy(drown), null, 'drowning + go_to_surface is a valid rule');
// The condition is the air bar and nothing positional. That is not an oversight:
// instrumented during a real drowning on this server, isInWater is false the
// whole time, the block above is air and the eye block is air too, so every
// world test reads "dry" exactly when the bot is dying of water. Head-block
// checks used to be asserted here and had to go; see drowning_on_land.test.js.
//
// What replaced them is a debounce, because a single low reading turned out to
// be a stray packet often enough to interrupt real work. Only the boundaries are
// checked here -- drowning_debounce.test.js covers the windowing.
const submerged = (oxygenLevel) => ({ bot: { oxygenLevel } });
assert.equal(CONDITIONS.drowning.fn(submerged(3), {}), false, 'even critical air waits for a second reading');
assert.equal(CONDITIONS.drowning.fn(submerged(20), {}), false, 'full oxygen is not drowning');
assert.equal(CONDITIONS.drowning.fn(submerged(5), {}), false, 'one low reading alone is a stray packet');

// A rule that fires but accomplishes nothing must back off, or it starves the
// reasoning loop. Live: Andy with no pickaxe ran collect(stone) -> "Don't have
// right tools" a few times a second for a whole in-game day.
const failing = new Rule({ name: 'mine', when: { cond: 'always' }, do: [{ act: 'collect', type: 'stone' }], cooldown: 5 });
const agent = { bot: { interrupt_code: false } };
const exec = async (_r, _a, fn) => await fn();
ACTIONS.collect.fn = async () => false;
await failing.update(agent, exec);
assert.equal(failing.backoff, 2, 'a failing rule doubles its cooldown');
failing.last_fire = failing.last_eval = 0;
await failing.update(agent, exec);
assert.equal(failing.backoff, 4, 'and keeps doubling while it keeps failing');
assert.equal(failing.eligible(agent), false, 'so it is not eligible again for cooldown * backoff');
ACTIONS.collect.fn = async () => true;
failing.last_fire = failing.last_eval = 0;
await failing.update(agent, exec);
assert.equal(failing.backoff, 1, 'one success resets it');

console.log('ok: rules that go nowhere and rules that retreat forever are rejected');
process.exit(0);
