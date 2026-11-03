#!/usr/bin/env node
// Turn a death incident file into a scenarios.test.js fixture line.
//   node tools/incident_to_fixture.js /tmp/incidents-Andy/<ts>.json [compose]
// Prints the facts the arbiter would have seen and the rule it fires first
// under the CURRENT policy, as a ready-to-paste CANDIDATE entry. Fill in the
// rule that SHOULD have fired, paste, watch it fail, fix the policy.
// ponytail: hostile/ranged detection is a name regex, not mcdata -- good enough
// to seed a fixture a human reads before committing.
import fs from 'node:fs';
import { CONDITIONS, evalCondition, mergeProfiles, loadProfile } from '../src/agent/behavior/policy.js';

const [file, compose = 'survive_upgrade'] = process.argv.slice(2);
if (!file) { console.error('usage: incident_to_fixture.js <incident.json> [compose]'); process.exit(2); }
const i = JSON.parse(fs.readFileSync(file, 'utf8'));

const HOSTILE = /zombie|skeleton|spider|creeper|drowned|husk|stray|pillager|vindicator|ravager|illusioner|witch|phantom|enderman|chillager|kobold|mutant|graveyard|blaze|slime|goblin/i;
const RANGED = /skeleton|stray|pillager|illusioner|chillager|witch|blaze/i;
const near = i.nearby ?? [];
const dist = re => Math.min(...near.filter(e => re.test(e.name)).map(e => e.d), Infinity);
const inv = {};
for (const it of i.inventory ?? []) { const m = /^(.*?)x(\d+)$/.exec(it); if (m) inv[m[1]] = +m[2]; }

const facts = {
    night: !!i.night, y: i.pos?.[1], food: i.food, oxygen: i.oxygen ?? 20,
    hostile_dist: dist(HOSTILE), ranged_dist: dist(RANGED), attacked_s: /attack/.test(i.cause) ? 1 : undefined,
    held: i.held || undefined, inv, has_food: Object.keys(inv).some(k => /berr|bread|meat|beef|pork|steak|chicken|apple|carrot|potato/.test(k)),
    idle: !i.action || i.action === '-',
};
for (const k of Object.keys(facts)) if (facts[k] === undefined || facts[k] === Infinity) delete facts[k];

// Same flat interpreter as scenarios.test.js, kept in sync by its
// "every engine condition has a fixture interpreter" test.
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
for (const k of Object.keys(CONDITIONS)) CONDITIONS[k].fn = (agent, a) => (F[k] ?? (() => false))(agent.facts, a);
const DEFAULTS = { hp: 20, food: 20, y: 70, oxygen: 20, night: false, idle: false, home_dist: 10, respawn_dist: 50, death_dist: 999 };
const policy = mergeProfiles(loadProfile(compose), []);
const f = { ...DEFAULTS, ...facts };
const ordered = [...policy.rules.filter(r => r.pinned), ...policy.rules.filter(r => !r.pinned)];
const fired = ordered.filter(r => evalCondition(r.when, { facts: f }) && (r.interrupts !== 'idle' || f.idle)).map(r => r.name);

console.log(`// ${i.ts ?? file}: ${i.cause} at ${(i.pos ?? []).join(',')} ${i.night ? 'night' : 'day'} ${i.armed ? 'armed' : 'unarmed'} action=${i.action ?? '-'}${i.prompt_in_flight ? ' PROMPT-IN-FLIGHT' : ''}`);
console.log(`// fires now: ${fired.join(', ') || '(nothing)'}`);
console.log(`['${compose}', ${JSON.stringify(facts)}, '${fired[0] ?? 'RULE_THAT_SHOULD_HAVE_FIRED'}'],`);
