// Run: node --test src/agent/behavior/policy_revision.test.js
// The policy merge is an LLM call that can outrun the 600s relay timeout. When
// it does, the caller is told it failed -- and then the abandoned merge lands
// anyway and silently overwrites whatever was set in the meantime. Seen live: a
// raider rule installed by hand reverted to an older version minutes later, with
// nothing in the log to say why.
//
// The revision is how a slow writer can tell that happened.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import { savePolicyState, loadPolicyState, policyRevision } from './policy.js';

const AGENT = '__revision_test__';
const cleanup = () => fs.rmSync(`./bots/${AGENT}`, { recursive: true, force: true });

test('revision starts at zero and increases on every write', (t) => {
    t.after(cleanup);
    cleanup();
    assert.equal(policyRevision(AGENT), 0, 'no policy file yet');

    savePolicyState(AGENT, { layers: { active: { policy: { rules: [] } } } });
    const first = policyRevision(AGENT);
    assert.ok(first > 0);

    savePolicyState(AGENT, { layers: { active: { policy: { rules: [] } } } });
    assert.ok(policyRevision(AGENT) > first, 'a second write is distinguishable from the first');
});

test('an identical write still bumps the revision', (t) => {
    t.after(cleanup);
    cleanup();
    const state = { layers: { self: { policy: { rules: [] } } } };
    savePolicyState(AGENT, state);
    const before = policyRevision(AGENT);
    savePolicyState(AGENT, state);
    // Content-equality is not the question. "Did anyone else write?" is, and a
    // caller that rewrote the same thing still had its turn.
    assert.notEqual(policyRevision(AGENT), before);
});

test('the revision survives a load/save round trip', (t) => {
    t.after(cleanup);
    cleanup();
    savePolicyState(AGENT, { layers: {}, locked: true });
    const before = policyRevision(AGENT);
    const state = loadPolicyState(AGENT);
    savePolicyState(AGENT, state);
    assert.ok(policyRevision(AGENT) > before,
        'loading and re-saving must not reset the counter, or the guard silently stops working');
});

test('policyRevision does not throw on a missing or corrupt file', (t) => {
    t.after(cleanup);
    cleanup();
    assert.equal(policyRevision(AGENT), 0);
    fs.mkdirSync(`./bots/${AGENT}`, { recursive: true });
    fs.writeFileSync(`./bots/${AGENT}/policy.json`, 'not json at all');
    assert.equal(policyRevision(AGENT), 0, 'a corrupt file reads as 0 rather than crashing the merge');
});
