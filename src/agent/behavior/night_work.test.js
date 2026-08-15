// Run: node --test src/agent/behavior/night_work.test.js
// "Not going outside because it is night" must not mean "doing nothing". The
// night rules park the bot with `stay until not is_night`, and a stay is a
// blocking action that owns the ActionManager for the rest of the night. The
// only thing that can take it back is a rule with interrupts:"all" --
// _executeAction calls stop() on the running action before starting the new one,
// while an interrupts:"idle" rule waits for a gap that a stay never gives.
//
// So every job that can be done standing at camp has to be interrupts:"all", or
// it is unreachable between dusk and dawn. This is the same invariant
// idle_priority.test.js enforces from the other side (things that travel must
// NOT interrupt); the two together are what decide what the bot may do at night.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';

const rules = ['policies/stayin_alive.json', 'policies/food_gathering.json']
    .flatMap(f => JSON.parse(fs.readFileSync(f, 'utf8')).policy.rules);
const by = Object.fromEntries(rules.map(r => [r.name, r]));

// Work that happens where the bot stands, with a table/furnace/chest in reach.
const INDOOR_WORK = [
    'keep_a_crafting_table_at_camp', 'build_a_furnace', 'smelt_logs_for_torch_fuel',
    'craft_torches', 'light_the_camp', 'craft_a_weapon', 'craft_a_pickaxe',
    'craft_a_bed', 'place_the_bed', 'cook_raw_meat', 'bake_bread',
    'stow_bulk_at_base', 'stow_surplus_food', 'arm_yourself_from_the_chest',
];

test('camp work can preempt the night stay', () => {
    for (const name of INDOOR_WORK) {
        assert.ok(by[name], `${name} is missing from the policy`);
        assert.equal(by[name].interrupts, 'all',
            `${name} is idle-gated, so it can never run while the night stay holds the agent`);
    }
});

test('the night park rules park, and let go at morning', () => {
    for (const name of ['dig_in_for_the_night', 'wait_out_the_night_under_cover']) {
        const stay = by[name].do.find(s => s.act === 'stay');
        assert.ok(stay, `${name} should park with stay rather than re-path all night`);
        assert.match(stay.until, /not is_night/,
            `${name} must end at morning, not on some condition that may never come`);
    }
});

test('nothing parks the bot without a way out', () => {
    // A stay with no exit is the whole night, and then the next one too.
    for (const r of rules)
        for (const step of r.do ?? [])
            if (step.act === 'stay')
                assert.ok(typeof step.until === 'string' && step.until.trim(),
                    `${r.name} parks with no exit condition`);
});

test('coming home is reachable from both idle and mid-task', () => {
    // head_home_before_dark interrupts because being caught out after dark is
    // what every death so far has had in common; come_home_when_far waits for a
    // gap because drifting is not an emergency.
    assert.equal(by['head_home_before_dark'].interrupts, 'all');
    assert.equal(by['head_home_before_dark'].pinned, true);
    assert.equal(by['come_home_when_far'].interrupts, 'idle');
    // Ordering matters more than it looks: rules are walked in order and the
    // first idle rule claims the idleness, so a homing rule below the foraging
    // rules would never see a gap.
    const idle = rules.filter(r => r.interrupts === 'idle').map(r => r.name);
    assert.equal(idle[0], 'come_home_when_far',
        `come_home_when_far must be the first idle rule, but ${idle[0]} is`);
});
