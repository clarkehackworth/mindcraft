// The bed was the last survival prompt: get_a_bed paid for an LLM turn to look
// up a recipe that turned out to be the ordinary three wool and three planks.
// The three rules that replace it only pay off as a chain -- wool, then craft,
// then place -- and each link has to stop once the bed exists, or the bot spends
// its nights hunting sheep it no longer needs.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import { validatePolicy } from './policy.js';

const policy = JSON.parse(fs.readFileSync('policies/stayin_alive.json', 'utf8')).policy;
const by = Object.fromEntries(policy.rules.map(r => [r.name, r]));

test('the bed chain is present and the prompt it replaces is gone', () => {
    assert.equal(validatePolicy(policy), null);
    for (const name of ['hunt_sheep_for_wool', 'craft_a_bed', 'place_the_bed'])
        assert.ok(by[name], `${name} missing`);
    assert.equal(by.get_a_bed, undefined, 'the paid version is still installed');
});

test('nothing in the chain costs an LLM turn', () => {
    for (const name of ['hunt_sheep_for_wool', 'craft_a_bed', 'place_the_bed'])
        assert.ok(!JSON.stringify(by[name].do).includes('prompt_self'),
            `${name} pays for a turn`);
});

test('every link stops once there is a bed', () => {
    // Owning one or standing next to one both have to silence the whole chain,
    // since a placed bed leaves the inventory empty and vice versa.
    for (const name of ['hunt_sheep_for_wool', 'craft_a_bed']) {
        const when = JSON.stringify(by[name].when);
        assert.match(when, /"not":\{"cond":"has_item","item":"white_bed"/, `${name} crafts a second bed`);
        assert.match(when, /"not":\{"cond":"block_nearby","name":"bed"/, `${name} ignores the bed it placed`);
    }
    assert.match(JSON.stringify(by.place_the_bed.when), /"not":\{"cond":"block_nearby","name":"bed"/,
        'place_the_bed re-places on top of itself');
});

test('sleep_at_night is what the chain feeds', () => {
    // The payoff is this rule firing; if it stopped keying on a nearby bed the
    // chain would be three rules of busywork.
    assert.match(JSON.stringify(by.sleep_at_night.when), /"cond":"block_nearby","name":"bed"/);
});
