// Every interrupted command reported the literal string "undefined" to the model.
// A sheep search cancelled after two stops by a shelter rule looked exactly like
// a sheep search that had covered the world and found nothing, so the model
// concluded the command was broken and went back to mining. Interrupted is not
// the same as finished-with-nothing, and the output has to say which.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { ActionManager } from './action_manager.js';

function managerWith({ output, interrupted }) {
    const agent = { bot: { output, interrupt_code: interrupted }, isIdle: () => true,
        self_prompter: { isActive: () => false } };
    const am = new ActionManager(agent);
    am.timedout = false;
    return am;
}

test('an interrupted action hands back what it managed, marked partial', () => {
    const am = managerWith({ output: 'Swept 2 stops.', interrupted: true });
    const out = am.getBotOutputSummary();
    assert.match(out, /interrupted and did not finish/);
    assert.match(out, /Swept 2 stops\./, 'the partial progress survives');
});

test('an interrupted action with nothing done says so instead of going silent', () => {
    const out = managerWith({ output: '', interrupted: true }).getBotOutputSummary();
    assert.ok(out, 'must not be empty -- empty reaches the model as "undefined"');
    assert.match(out, /interrupted before it could do anything/);
    assert.match(out, /Nothing was ruled out/);
});

// Seen live: "Action was interrupted and did not finish. What it managed before
// being cut short:" followed by nothing at all.
test('whitespace-only output counts as nothing done, not as partial progress', () => {
    const out = managerWith({ output: '\n  \n', interrupted: true }).getBotOutputSummary();
    assert.match(out, /interrupted before it could do anything/);
    assert.ok(!/What it managed/.test(out), 'no dangling "here is what happened" with nothing after it');
});

test('a normal action is unchanged', () => {
    const out = managerWith({ output: 'Collected 6 pine_log.', interrupted: false }).getBotOutputSummary();
    assert.match(out, /Collected 6 pine_log\./);
    assert.ok(!/interrupted/.test(out));
});

test('a timeout is not reported as an interruption', () => {
    const am = managerWith({ output: 'Partial work.', interrupted: true });
    am.timedout = true;
    const out = am.getBotOutputSummary();
    assert.ok(!/interrupted and did not finish/.test(out), 'timeouts have their own wording');
});
