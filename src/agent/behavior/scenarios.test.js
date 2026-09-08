// Scenario fixtures: a world snapshot in, the rule the arbiter would fire
// first out. Each case is a death class from the devlog, so a rule edit that
// re-opens one fails here in milliseconds instead of in a six-hour soak.
//
// ponytail: conditions are evaluated against a flat "facts" object by the
// small interpreter below, not against a fake mineflayer bot. It tests rule
// gating and ordering, not condition implementations (those have their own
// tests). Item names are literal -- write the rule's spelling into `inv`.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import { CONDITIONS, evalCondition, mergeProfiles, loadProfile } from './policy.js';

const F = {
    hostile_nearby: (f, a) => f.hostile_dist <= (a.range ?? 16),
    recently_attacked: (f, a) => f.attacked_s != null && f.attacked_s < (a.seconds ?? 10),
    entity_nearby: (f, a) => (f.entities?.[a.name] ?? Infinity) <= (a.range ?? 16),
    block_nearby: (f, a) => (f.blocks?.[a.name] ?? Infinity) <= Math.min(a.range ?? 16, 16),
    ranged_hostile_nearby: (f, a) => f.ranged_dist <= (a.range ?? 24),
    animal_nearby: (f, a) => f.animal_dist <= (a.range ?? 16),
    player_nearby: (f, a) => f.player_dist <= (a.range ?? 16),
    health_below: (f, a) => a.pct != null ? f.hp < 20 * (a.pct / 100) : f.hp < (a.value ?? 10),
    hunger_below: (f, a) => f.food < (a.value ?? 10),
    has_item: (f, a) => (f.inv?.[a.item] ?? 0) >= (a.count ?? 1),
    has_food: f => !!f.has_food,
    holding: (f, a) => a.item === 'weapon' ? /sword|axe/.test(f.held ?? '') : f.held === a.item,
    at_death_position: (f, a) => f.death_dist <= (a.range ?? 8),
    at_position: () => false,
    path_stuck: (f, a) => (f.path_stuck ?? 0) >= (a.count ?? 40),
    place_known: (f, a) => !!f.places?.includes(a.name),
    drowning: (f, a) => f.oxygen < (a.air ?? 12),
    far_from_home: (f, a) => f.home_dist > (a.range ?? 96),
    near_respawn: (f, a) => f.respawn_dist <= (a.range ?? 8),
    is_night: (f, a) => !!f.night || (!!a.lead && !!f.dusk),
    is_freezing: f => !!f.freezing,
    can_dig_down: f => f.can_dig ?? true,
    y_below: (f, a) => f.y < (a.y ?? 0),
    y_above: (f, a) => f.y > (a.y ?? 0),
    is_sheltered: f => !!f.sheltered,
    is_idle: f => !!f.idle,
    always: () => true,
};

test('every engine condition has a fixture interpreter', () => {
    for (const k of Object.keys(CONDITIONS)) assert.ok(F[k], `add ${k} to F in scenarios.test.js`);
});
for (const k of Object.keys(CONDITIONS)) CONDITIONS[k].fn = (agent, a) => F[k](agent.facts, a);

const DEFAULTS = { hp: 20, food: 20, y: 70, oxygen: 20, night: false, idle: false, home_dist: 10, respawn_dist: 50, death_dist: 999 };
// Both composes the bot actually runs: the live one (survive_upgrade alone)
// and the base+attributes stack.
const COMPOSES = {
    survive_upgrade: mergeProfiles(loadProfile('survive_upgrade'), []),
    survive_upgrade_b: mergeProfiles(loadProfile('survive_upgrade_b'), []),
    'stayin_alive+food_gathering+mining+leveling_up':
        mergeProfiles(loadProfile('stayin_alive'), ['food_gathering', 'mining', 'leveling_up'].map(loadProfile)),
};
// composePolicy's order for one layer: pinned first, then list order. A rule
// fires if its trigger holds and it either interrupts or the agent is idle.
export function firing(policy, facts) {
    const f = { ...DEFAULTS, ...facts };
    const ordered = [...policy.rules.filter(r => r.pinned), ...policy.rules.filter(r => !r.pinned)];
    return ordered.filter(r => evalCondition(r.when, { facts: f }) && (r.interrupts !== 'idle' || f.idle)).map(r => r.name);
}

// name -> [facts, expected first rule, rules that must NOT fire]
const SCENARIOS = {
    // soak 12: caving at night between y=55 and y=80 was where the arrows were
    night_underground_unsheltered: [{ night: true, y: 50 }, 'surface_when_night_finds_you_underground'],
    // a capped foxhole must not be dragged out of its own roof
    night_underground_in_foxhole: [{ night: true, y: 50, sheltered: true }, null, ['surface_when_night_finds_you_underground']],
    // soak 8: mutant zombie hunting at night, no bed -> dig in, don't stand and prompt
    hunted_at_night_no_bed: [{ night: true, hostile_dist: 6, attacked_s: 2 }, 'dig_in_when_hunted'],
    // 2026-08-14: drowning beats everything, including the night rules
    drowning_at_night_underground: [{ night: true, y: 50, oxygen: 4 }, 'surface_when_drowning'],
    // hungry with food in the bag eats before it goes looking
    hungry_with_food: [{ food: 8, has_food: true }, 'eat_when_hungry'],
    // 4,558 partial searches in one box: give up, do not keep pathing
    stuck_path: [{ path_stuck: 45 }, 'give_up_on_a_stuck_path'],
    // chillager cluster: an illager in daylight is ranged and does not burn
    ranged_raider_by_day: [{ ranged_dist: 12, hostile_dist: 12 }, 'flee_ranged_raiders'],
};

// Candidate-only expectations: [compose, facts, first, never]
const CANDIDATE = [
    // A/B 1, promoted 2026-09-08: night gate + go_find_trees now hold on the base too
    ['survive_upgrade', { night: true, idle: true, blocks: { log: 10 } }, null, ['gather_wood_for_base', 'hunt_sheep_for_wool', 'mine_coal_ore']],
    ['survive_upgrade', { idle: true }, 'go_find_trees'],
    ['survive_upgrade', { idle: true, blocks: { log: 10 } }, 'gather_wood_for_base'],
    // A/B 2: respawned into the night on the spawn tile, zombie adjacent -- the base has no free reflex here
    ['survive_upgrade_b', { night: true, respawn_dist: 2, hostile_dist: 1, attacked_s: 1 }, 'respawned_into_the_night'],
    ['survive_upgrade', { night: true, respawn_dist: 2, hostile_dist: 1, attacked_s: 1 }, null, ['dig_in_when_hunted', 'dig_in_for_the_night', 'respawned_into_the_night']],
    // twelve blocks off the tile the ordinary dig_in takes over
    ['survive_upgrade_b', { night: true, respawn_dist: 12, hostile_dist: 6 }, 'dig_in_when_hunted', ['respawned_into_the_night']],
];
for (const [compose, facts, first, never = []] of CANDIDATE)
    test(`candidate [${compose}]: ${JSON.stringify(facts)}`, () => {
        const fired = firing(COMPOSES[compose], facts);
        if (first) assert.equal(fired[0], first, `fired: ${fired.join(', ') || '(nothing)'}`);
        for (const n of never) assert.ok(!fired.includes(n), `${n} fired: ${fired.join(', ')}`);
    });

for (const [compose, policy] of Object.entries(COMPOSES))
    for (const [name, [facts, first, never = []]] of Object.entries(SCENARIOS))
        test(`scenario [${compose}]: ${name}`, () => {
            const fired = firing(policy, facts);
            if (first) assert.equal(fired[0], first, `fired: ${fired.join(', ') || '(nothing)'}`);
            for (const n of never) assert.ok(!fired.includes(n), `${n} fired: ${fired.join(', ')}`);
        });

if (process.argv.includes('--dump'))
    for (const [compose, policy] of Object.entries(COMPOSES))
        for (const [name, [facts]] of Object.entries(SCENARIOS)) console.log(`[${compose}] ${name} ->`, firing(policy, facts).join(', ') || '(nothing)');
