// "idle" turned out to mean "maybe never": with every gate satisfied,
// craft_a_bed sat unfired for five minutes while only interrupts:all rules got
// turns. The dividing line that came out of that: a rule that acts where it
// stands, and stops itself, should interrupt -- it can only do so once. A rule
// that travels, or that could run all day, stays idle so it cannot drag the
// agent off mid-task.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';

const rules = ['policies/stayin_alive.json', 'policies/food_gathering.json']
    .flatMap(f => JSON.parse(fs.readFileSync(f, 'utf8')).policy.rules);
const by = Object.fromEntries(rules.map(r => [r.name, r]));
const TRAVELS = ['goto', 'goto_place', 'search_block', 'search_entity', 'move_away', 'flee', 'goto_player'];

test('rules that act where they stand interrupt', () => {
    for (const name of ['forage_berries', 'bake_bread', 'cook_raw_meat', 'take_food_from_storage',
                        'craft_a_weapon', 'remember_the_berry_patch', 'stow_surplus_food'])
        assert.equal(by[name].interrupts, 'all', `${name} would wait for an idle that never comes`);
});

test('rules that travel stay idle', () => {
    for (const name of ['hunt_sheep_for_wool', 'berry_run_while_stocked_low', 'walk_the_berry_route',
                        'stock_the_pantry', 'search_out_berries', 'hunt_for_the_larder'])
        assert.equal(by[name].interrupts, 'idle', `${name} can drag the agent across the map mid-task`);
});

test('nothing that pays for an LLM turn interrupts', () => {
    // A prompt cancels the action the model already chose in order to ask the
    // model again. keep_out_of_water is the one interrupting move_away, and it
    // is deliberate -- the bot drowned mid-path while this waited for idle.
    for (const r of rules) {
        if (r.interrupts !== 'all') continue;
        const acts = (r.do ?? []).map(s => s.act);
        // Pinned means the rule is there to stop the agent dying, and paying
        // for a turn beats freezing to death -- get_out_of_the_cold is the one
        // that earns it. Anything unpinned interrupting to ask the model is a
        // paid turn cancelling work the model already chose.
        assert.ok(!acts.includes('prompt_self') || r.pinned === true,
            `${r.name} interrupts to ask the LLM`);
        if (acts.some(a => TRAVELS.includes(a)))
            assert.equal(r.name === 'keep_out_of_water' || r.pinned === true, true,
                `${r.name} interrupts and then walks off`);
    }
});

test('every interrupting rule has a cooldown that can hold it back', () => {
    for (const r of rules)
        if (r.interrupts === 'all')
            assert.ok((r.cooldown ?? 3) >= 5, `${r.name} can re-interrupt every 3 seconds`);
});
