// Run: node --test src/agent/empty_output.test.js
// Generated code that never calls skills.log finished with an empty bot.output,
// and the summary was the literal string "Action output:" with nothing after it.
// The model reads that as success: it announced "Great, I'm out" three times in
// a row while standing in the same hole it started in.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { Vec3 } from 'vec3';
import { ActionManager } from './action_manager.js';

function manager({ output = '', pos = new Vec3(10, 64, 10), start = new Vec3(10, 64, 10) } = {}) {
    const m = Object.create(ActionManager.prototype);
    m.timedout = false;
    m.start_pos = start;
    m.agent = { bot: { output, interrupt_code: false, entity: { position: pos }, health: 12, heldItem: { name: 'stone_pickaxe' } } };
    return m;
}

test('an empty output never reads as success', () => {
    const out = manager().getBotOutputSummary();
    assert.notEqual(out.trim(), 'Action output:');
    assert.match(out, /reported nothing/);
    assert.match(out, /where you started/, 'and says it did not move');
});

test('it describes what can actually be observed', () => {
    const out = manager({ pos: new Vec3(40, 64, 10) }).getBotOutputSummary();
    assert.match(out, /10, 64, 10|40, 64, 10/);
    assert.match(out, /30 blocks from where you started/);
    assert.match(out, /health 12/);
    assert.match(out, /holding stone_pickaxe/);
});

test('a real output is left alone', () => {
    assert.match(manager({ output: 'Collected 3 oak_log.' }).getBotOutputSummary(), /^Action output:\nCollected 3 oak_log\./);
});

test('an interruption still gets its own explanation', () => {
    const m = manager();
    m.agent.bot.interrupt_code = true;
    assert.match(m.getBotOutputSummary(), /interrupted before it could do anything/);
});
