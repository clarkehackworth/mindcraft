// Run: node src/agent/behavior/self_layer_adopted.test.js
// The self layer is what the bot writes for itself, and it lives only in
// bots/<name>/policy.json -- no seed file backs it. Two rules had been there
// long enough to prove themselves and were one regeneration away from being
// lost, so they are in the seed now.
import assert from 'assert';
import { validatePolicy } from './policy.js';
import { readFileSync } from 'fs';

const seed = JSON.parse(readFileSync(new URL('../../../policies/stayin_alive.json', import.meta.url)));
const by = Object.fromEntries(seed.policy.rules.map(r => [r.name, r]));

// avoid_water_deeply had surface_when_drowning's exact trigger and cooldown plus
// one extra step, so it merged instead of landing as a second rule on the same
// trigger. Surfacing leaves the bot floating in the water it just escaped; the
// step away is what ends the episode.
{
    const acts = by['surface_when_drowning'].do.map(s => s.act);
    assert.deepEqual(acts, ['go_to_surface', 'move_away'], 'surface, then leave the water');
    assert.ok(!by['avoid_water_deeply'], 'and no duplicate rule on the same trigger');
}

// night_no_weapon_shelter is a real addition: the three night rules already in
// the seed gate on beds and on being able to dig, never on having nothing to
// fight with.
{
    const r = by['night_no_weapon_shelter'];
    assert.ok(r, 'the unarmed-at-night case is covered');
    const others = ['shelter_when_night_and_no_bed', 'dig_in_for_the_night', 'wait_out_the_night_under_cover'];
    for (const n of others)
        assert.doesNotMatch(JSON.stringify(by[n].when), /holding/,
            `${n} does not consider whether the bot is armed, which is why the new rule earns its place`);

    // Both branches guarded. Without it on the second, a sheltered unarmed bot
    // with a mob outside re-dug every six seconds: 126 fires in one window while
    // every other rule fired twice.
    for (const [i, branch] of r.when.any.entries())
        assert.match(JSON.stringify(branch), /is_sheltered/,
            `branch ${i} must not fire at a bot that is already under cover`);

    // Bounded stay: "not is_night" is already true in daylight and the mob
    // branch fires at any hour, so an unbounded wait is a no-op that lets the
    // rule re-arm instantly.
    const stay = r.do.find(s => s.act === 'stay');
    assert.ok(stay.seconds > 0, 'the wait is bounded, not -1');
}

assert.equal(validatePolicy(seed.policy), null, 'and the whole policy still validates');
console.log('ok: what the bot taught itself is written down');
