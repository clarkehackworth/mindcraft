// Run: node src/agent/behavior/policy_provenance.test.js
// Andy twice replaced his own survival policy with a note about which planks to
// prefer -- a fact to remember, not a change in how to behave. The second time
// it cost him the night/bed rule, the flee rule and cowardice, and he died 26
// times in 6 minutes respawning into zombies. Standing instructions from a
// person outrank the agent's own.
import assert from 'assert';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { chdir, cwd } from 'process';
import { savePolicy, loadPolicy, isUserPolicy, deletePolicy } from './policy.js';
import { getCommand } from '../commands/index.js';

const original = cwd();
const scratch = mkdtempSync(`${tmpdir()}/policy-provenance-`);
chdir(scratch);

const rules = { rules: [{ name: 'flee', when: { cond: 'hostile_nearby' }, do: [{ act: 'flee' }] }] };

// A person's policy is protected.
savePolicy('Andy', rules, 'flee from mobs', true);
assert.equal(isUserPolicy('Andy'), true, 'a policy set by a person is a user policy');

// The agent's own is not, so it may freely replace its own.
savePolicy('Andy', rules, 'prefer larch planks', false);
assert.equal(isUserPolicy('Andy'), false, 'a policy the agent set itself is not protected');

// Policies written before user_set existed were all set by a person, so a
// missing field must not silently unprotect them.
savePolicy('Andy', rules, 'flee from mobs', true);
const saved = loadPolicy('Andy');
delete saved.user_set;
savePolicy('Andy', saved.policy, saved.source, undefined);
assert.equal(isUserPolicy('Andy'), true, 'a policy with no provenance field is treated as user-set');

// No policy at all is not a user policy -- the agent can still set its first.
deletePolicy('Andy');
assert.equal(existsSync('./bots/Andy/policy.json'), false, 'the policy file is gone');
assert.equal(isUserPolicy('Andy'), false, 'with no policy there is nothing to protect');

// The commands themselves must refuse. Clearing has to be guarded too, or the
// refusal is theatre: the agent would just clear and then set.
const policyCmd = getCommand('!policy');
const clearCmd = getCommand('!clearPolicy');

savePolicy('Andy', rules, 'flee from mobs', true);
const selfAgent = { name: 'Andy', command_self_issued: true };
assert.match(await policyCmd.perform(selfAgent, 'prefer larch planks'), /cannot replace it/,
    'the agent may not replace a policy a person set');
assert.match(await clearCmd.perform(selfAgent), /cannot clear it/,
    'nor clear it, or it would just clear and re-set');
assert.equal(loadPolicy('Andy').source, 'flee from mobs', 'the original policy is untouched');

// Its own policy it may still replace.
savePolicy('Andy', rules, 'prefer larch planks', false);
const cleared = { name: 'Andy', command_self_issued: true, bot: { modes: { clearPolicy: () => {} } } };
assert.match(await clearCmd.perform(cleared), /cleared/, 'the agent can clear a policy it set itself');

chdir(original);
rmSync(scratch, { recursive: true, force: true });
console.log('ok: a policy set by a person is not the agent\'s to replace or clear');
process.exit(0);
