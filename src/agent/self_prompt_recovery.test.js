// Run: node --test src/agent/self_prompt_recovery.test.js
// The goal loop is the only thing that makes the agent act on its own; the
// rules are reflexes. Live, it stopped once and never came back: Andy sat on
// one block for over an hour, 0 PathStopped, 0 GoalChanged, while
// hold_weapon_when_threatened fired into an empty inventory every few seconds.
//
// The mechanism: any mode or rule firing calls stopLoop(), which set
// interrupt = true and then waited for loop_active FOREVER. The loop sits
// inside a single handleMessage, so loop_active never cleared, so interrupt was
// never restored -- and update()'s auto-restart requires !interrupt. The loop
// was not stopped, it was unrecoverable.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { SelfPrompter } from './self_prompter.js';

function prompter() {
    const agent = { handleMessage: async () => true, openChat: () => {}, isIdle: () => true, actions: { stop: async () => {} } };
    const sp = new SelfPrompter(agent);
    sp.prompt = 'stay alive';
    sp.cooldown = 10;
    return sp;
}

test('stopLoop releases the interrupt once the loop acknowledges it', async () => {
    const sp = prompter();
    sp.state = 1;            // ACTIVE
    sp.loop_active = true;   // stands in for a turn parked inside handleMessage

    const stopping = sp.stopLoop();
    assert.equal(sp.interrupt, true, 'set while it waits for the loop');
    sp.loop_active = false;  // the loop finally notices
    await stopping;
    assert.equal(sp.interrupt, false, 'released, so update() can restart it');
});

test('a stuck interrupt is exactly what blocks the auto-restart', () => {
    const sp = prompter();
    sp.state = 1;
    sp.loop_active = false;
    sp.idle_time = 0;
    // Stub the restart: what is under test is whether update() REACHES it. A
    // real loop here would outlive the test process.
    let restarted = 0;
    sp.startLoop = () => { restarted++; };

    sp.interrupt = true;
    sp.update(99999);
    assert.equal(restarted, 0, 'interrupt pinned true means no restart, forever');

    sp.interrupt = false;
    sp.update(99999);
    assert.equal(restarted, 1, 'cleared, the loop comes back on the next idle tick');
});

const src = readFileSync(new URL('./self_prompter.js', import.meta.url), 'utf8');

test('one turn cannot own the loop forever', () => {
    // Proving this behaviourally would mean waiting out TURN_TIMEOUT_MS, so
    // assert the guard is wired instead.
    assert.match(src, /Promise\.race\(\[/, 'the turn races a timer');
    assert.match(src, /TURN_ABANDONED/);
    assert.match(src, /used_command = true;/,
        'an abandoned turn must not count as the model failing to use a command -- three of those stop self-prompting outright');
});

test('neither wait is an unbounded loop any more', () => {
    assert.match(src, /const STOP_WAIT_MS/);
    assert.match(src, /const TURN_TIMEOUT_MS/);
    assert.match(src, /Date\.now\(\) > deadline/, 'stopLoop gives up rather than pinning interrupt true');
});
