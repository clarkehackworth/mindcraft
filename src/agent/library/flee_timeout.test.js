// Run: node --test src/agent/library/flee_timeout.test.js
// back_off_from_endermen fired underground at y=52, on an enderman the bot could
// not get away from -- walls between them, nowhere to run to. avoidEnemies exits
// when no hostile is within `distance`, which was a condition the bot could not
// reach, so it re-armed a dynamic pathfinder goal every 500ms forever:
//
//   46 unreachable:GoalInvert:...:by=mode:policy:active:back_off_from_endermen
//
// 4,653 pathfinder replans on block -27,52,-5 in four minutes, and nothing else
// in the agent ran at all. The spin backstop cleared the goal all 46 times and
// this loop put it straight back within half a second.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { Vec3 } from 'vec3';
import registryFor from 'prismarine-registry';
import { useRegistry } from '../../utils/mcdata.js';
import { avoidEnemies } from './skills.js';

const registry = registryFor('1.20.1');
useRegistry(registry);

function cornered() {
    const goals = [];
    const zombie = { name: 'zombie', position: new Vec3(-19.5, 52, -5.5), type: 'mob' };
    const bot = {
        entity: { position: new Vec3(-27.5, 52, -5.5) },
        interrupt_code: false,
        output: '',
        registry,
        inventory: { items: () => [] },
        modes: { pause: () => {}, isOn: () => false },
        health: 20,
        // Eight blocks away and it stays there whatever the bot does, which is
        // what "walls between them" looks like from inside the loop.
        nearestEntity: (match) => (match(zombie) ? zombie : null),
        pathfinder: {
            setMovements: () => {},
            setGoal: (g) => goals.push(g),
            stop: () => {},
        },
    };
    return { bot, goals };
}

test('a flight that cannot work gives up instead of looping', async () => {
    const { bot, goals } = cornered();
    const started = Date.now();
    const fled = await avoidEnemies(bot, 16, 600);
    const took = Date.now() - started;

    assert.equal(fled, false, 'not getting away is a failure, not a success');
    assert.ok(took < 5000, `returned in ${took}ms rather than never`);
    assert.match(bot.output, /Could not get away from zombie/);
    // The agent has to be told what to try instead, or the rule just fires again
    // on its cooldown and re-enters the same loop.
    assert.match(bot.output, /fighting, digging in, or putting a door/);
    assert.ok(goals.length >= 1, 'it did actually try to run first');
});

test('giving up does not claim it moved away', async () => {
    const { bot } = cornered();
    await avoidEnemies(bot, 16, 600);
    assert.doesNotMatch(bot.output, /Moved 16 away from enemies/);
});

test('an interrupt still wins over the deadline', async () => {
    // The deadline is a backstop for a loop nothing else can stop. It must not
    // become the *only* way out -- interrupts:all rules still need to preempt.
    const { bot } = cornered();
    setTimeout(() => { bot.interrupt_code = true; }, 100);
    const started = Date.now();
    await avoidEnemies(bot, 16, 60000);
    assert.ok(Date.now() - started < 5000, 'interrupted well inside the deadline');
});
