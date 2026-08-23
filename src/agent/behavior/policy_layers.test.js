// Run: node --test src/agent/behavior/policy_layers.test.js
// Andy twice replaced his own survival policy with a note about which planks to
// prefer -- a fact to remember, not a change in how to behave. The second time
// it cost him the night/bed rule, the flee rule and cowardice, and he died 26
// times in 6 minutes respawning into zombies. Layers make that structural: the
// agent only ever writes the "self" layer, so a person's "active" instructions
// are not there to be overwritten. What a person sets is now generated once, by
// merging a base profile with attribute profiles, instead of stacked at runtime.
import test from 'node:test';
import assert from 'assert';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { chdir, cwd } from 'process';
import {
    loadPolicyState, savePolicyState, composePolicy, appendLayerSource,
    setPolicyLocked, isPolicyLocked, saveProfile, loadProfile, listProfiles,
    SELF_SOURCE_CAP, validatePolicy, buildMergeInstructions, generatePolicy, policyGoal, applyPolicyGoal,
} from './policy.js';
import { getCommand } from '../commands/index.js';

const original = cwd();
const scratch = mkdtempSync(`${tmpdir()}/policy-layers-`);
chdir(scratch);
test.after(() => { chdir(original); rmSync(scratch, { recursive: true, force: true }); });

// act varies with the name: two rules with the same trigger AND the same steps
// are duplicates and compose drops one, which is not what these tests are about.
let rule_seq = 0;
const rule = (name, cond = 'hostile_nearby') =>
    ({ name, when: { cond }, do: [{ act: 'flee', distance: 16 + rule_seq++ }] });

function layered() {
    return {
        layers: {
            active: { profile: null, source: ['gather wood'], policy: { modes: { self_defense: false, hunting: false }, rules: [rule('gather', 'is_idle')] } },
            self: { source: ['stay fed'], policy: { modes: { self_defense: true, item_collecting: true }, rules: [rule('eat', 'hunger_below')] } },
        },
        locked: false,
        compose: null,
    };
}

test('self beats active when both layers set the same mode', () => {
    const { modes } = composePolicy(layered());
    assert.equal(modes.self_defense, true, 'what the agent learned about itself wins');
    assert.equal(modes.hunting, false, 'a mode only active sets survives');
    assert.equal(modes.item_collecting, true, 'a mode only self sets survives');
});

test('rules compose self first, then active', () => {
    const { rules } = composePolicy(layered());
    assert.deepEqual(rules.map(r => r.name), ['self:eat', 'active:gather']);
});

test('rule names carry their layer, so both layers may reuse a name', () => {
    const state = layered();
    state.layers.self.policy.rules = [rule('gather', 'is_idle')];
    const names = composePolicy(state).rules.map(r => r.name);
    assert.deepEqual(names, ['self:gather', 'active:gather']);
    assert.equal(new Set(names).size, names.length, 'no collisions');
});

test('a pinned rule outranks an unpinned rule from either layer', () => {
    const state = layered();
    state.layers.active.policy.rules = [{ ...rule('surface', 'drowning'), pinned: true }, rule('gather', 'is_idle')];
    const names = composePolicy(state).rules.map(r => r.name);
    assert.deepEqual(names, ['active:surface', 'self:eat', 'active:gather']);
});

test('among pinned rules the person leads: an active pin outranks a self pin', () => {
    // A pin is the person saying "not negotiable". Self stays on top of the
    // unpinned contest, but a self-written pin must never bury a human one.
    const state = layered();
    state.layers.self.policy.rules = [{ ...rule('self_pin', 'drowning'), pinned: true }];
    state.layers.active.policy.rules = [{ ...rule('active_pin', 'is_idle'), pinned: true }, rule('gather', 'is_idle')];
    const names = composePolicy(state).rules.map(r => r.name);
    assert.deepEqual(names, ['active:active_pin', 'self:self_pin', 'active:gather']);
});

test('rules keep their authored order within a layer', () => {
    const state = layered();
    state.layers.active.policy.rules = [rule('first', 'is_idle'), rule('second', 'is_idle'), rule('third', 'is_idle')];
    const names = composePolicy(state).rules.filter(r => r.name.startsWith('active:')).map(r => r.name);
    assert.deepEqual(names, ['active:first', 'active:second', 'active:third']);
});

test('the sort key does not leak into the installed rules', () => {
    const state = layered();
    state.layers.self.policy.rules = [{ ...rule('pin', 'drowning'), pinned: true }];
    for (const r of composePolicy(state).rules)
        assert.ok(!('_rank' in r), `${r.name} still carries the internal sort key`);
});

test('pinned must be a boolean', () => {
    // A proximity+flee rule is rejected for other reasons (that is cowardice's
    // job), so pin-check with a rule the validator otherwise accepts.
    const surface = (extra) => ({ rules: [{ name: 'surface', when: { cond: 'drowning' }, do: [{ act: 'go_to_surface' }], ...extra }] });
    assert.equal(validatePolicy(surface({ pinned: true })), null);
    assert.equal(validatePolicy(surface({})), null);
    assert.match(validatePolicy(surface({ pinned: 'yes' })), /must be true or false/);
});

test('composing an empty state is empty, not a crash', () => {
    assert.deepEqual(composePolicy({ layers: {} }), { modes: {}, rules: [] });
    assert.deepEqual(composePolicy(loadPolicyState('NoSuchBot')), { modes: {}, rules: [] });
});

test('an old flat policy set by a person migrates to the active layer', () => {
    const policy = { rules: [rule('flee')] };
    savePolicyState('Andy', { layers: {}, locked: false });
    // Write the pre-layer shape directly: that is what is on disk in the wild.
    writeFileSync('./bots/Andy/policy.json', JSON.stringify({ source: 'flee from mobs', policy, user_set: true }));
    const state = loadPolicyState('Andy');
    assert.deepEqual(state.layers.active.source, ['flee from mobs'], 'the source string becomes a one-element list');
    assert.deepEqual(state.layers.active.policy, policy);
    assert.equal(state.layers.self, undefined);
    assert.equal(state.locked, false);
});

test('an old flat policy with no provenance is treated as a person\'s', () => {
    writeFileSync('./bots/Andy/policy.json', JSON.stringify({ source: 'flee from mobs', policy: { rules: [] } }));
    assert.ok(loadPolicyState('Andy').layers.active, 'a missing user_set must not silently demote it');
});

test('an old flat policy the agent set itself migrates to the self layer', () => {
    writeFileSync('./bots/Andy/policy.json', JSON.stringify({ source: 'prefer larch planks', policy: { rules: [] }, user_set: false }));
    const state = loadPolicyState('Andy');
    assert.deepEqual(state.layers.self.source, ['prefer larch planks']);
    assert.equal(state.layers.active, undefined);
});

test('a lone base layer becomes the active layer', () => {
    const base = { profile: 'pacifist', source: ['never fight'], policy: { rules: [rule('flee')] } };
    writeFileSync('./bots/Andy/policy.json', JSON.stringify({ layers: { base }, locked: false }));
    const state = loadPolicyState('Andy');
    assert.deepEqual(state.layers.active, base, 'the stance is now simply the policy');
    assert.equal(state.layers.base, undefined, 'no layer outside LAYERS survives the load');
});

test('a base layer is dropped when there is already an active one', () => {
    const base = { profile: 'pacifist', source: ['never fight'], policy: { rules: [rule('flee')] } };
    const active = { profile: null, source: ['gather wood'], policy: { rules: [rule('gather', 'is_idle')] } };
    writeFileSync('./bots/Andy/policy.json', JSON.stringify({ layers: { base, active }, locked: false }));
    const state = loadPolicyState('Andy');
    assert.deepEqual(state.layers.active, active, 'the layer that already outranked base is the one kept');
    assert.equal(state.layers.base, undefined);
});

test('the compose recipe survives a round trip, so a regenerate can be repeated', () => {
    const state = layered();
    state.compose = { base: 'stayin_alive', attributes: ['miner', 'pacifist'], generated_at: 1700000000000 };
    savePolicyState('Composer', state);
    assert.deepEqual(loadPolicyState('Composer').compose, state.compose);
    assert.equal(loadPolicyState('Andy').compose, null, 'a state with no recipe reads back as null, not undefined');
});

test('the self layer source is capped, oldest first', () => {
    let state = { layers: {}, locked: false };
    let all_evicted = [];
    for (let i = 0; i < SELF_SOURCE_CAP + 3; i++) {
        const { source, evicted } = appendLayerSource(state, 'self', `note ${i}`);
        state.layers.self = { source };
        all_evicted.push(...evicted);
    }
    assert.equal(state.layers.self.source.length, SELF_SOURCE_CAP);
    assert.equal(state.layers.self.source[0], 'note 3', 'the oldest notes were evicted');
    assert.equal(state.layers.self.source.at(-1), `note ${SELF_SOURCE_CAP + 2}`);
    // What fell off is reported, so the agent can be told it no longer holds.
    assert.deepEqual(all_evicted, ['note 0', 'note 1', 'note 2']);
});

test('a person\'s layer is not capped', () => {
    let state = { layers: {}, locked: false };
    for (let i = 0; i < SELF_SOURCE_CAP + 3; i++) {
        const { source, evicted } = appendLayerSource(state, 'active', `rule ${i}`);
        state.layers.active = { source };
        assert.deepEqual(evicted, [], 'nothing a person set is ever dropped');
    }
    assert.equal(state.layers.active.source.length, SELF_SOURCE_CAP + 3);
});

test('the lock flag survives a round trip and does not disturb the layers', () => {
    savePolicyState('Lockie', layered());
    assert.equal(isPolicyLocked('Lockie'), false);
    setPolicyLocked('Lockie', true);
    assert.equal(isPolicyLocked('Lockie'), true);
    assert.deepEqual(loadPolicyState('Lockie').layers.active.source, ['gather wood'], 'locking kept the layers');
    setPolicyLocked('Lockie', false);
    assert.equal(isPolicyLocked('Lockie'), false);
    assert.equal(isPolicyLocked('NeverSaved'), false, 'an unknown bot is unlocked, not an error');
});

test('profiles round trip through the shared library', () => {
    const policy = { modes: { hunting: false }, rules: [rule('flee')] };
    saveProfile('pacifist', { source: ['never fight'], policy, kind: 'base' });
    const loaded = loadProfile('pacifist');
    assert.deepEqual(loaded.policy, policy);
    assert.equal(loaded.kind, 'base');
    assert.equal(loadProfile('nope'), null);
    assert.equal(loadProfile('../../etc/passwd'), null, 'a profile name is not a path');
    const listed = listProfiles();
    assert.deepEqual(listed.map(p => p.name), ['pacifist']);
    assert.equal(listed[0].kind, 'base');
    assert.match(listed[0].summary, /never fight/);
});

test('an attribute may be nothing but a sentence, a profile with nothing is nothing', () => {
    saveProfile('careful', { source: ['never dig straight down'], kind: 'attribute' });
    const loaded = loadProfile('careful');
    assert.equal(loaded.kind, 'attribute');
    assert.equal(loaded.policy, undefined, 'no rules of its own; the merge writes them');
    assert.deepEqual(loaded.source, ['never dig straight down']);
    writeFileSync('./policies/hollow.json', JSON.stringify({ source: [], kind: 'attribute' }));
    assert.equal(loadProfile('hollow'), null, 'no rules and no words is not a profile');
    rmSync('./policies/hollow.json');
    assert.equal(loadProfile('pacifist').kind, 'base', 'a profile written without a kind is a base');
});

test('the merge instructions carry the base rules, the attributes and their order', () => {
    const base = { name: 'stayin_alive', source: ['just stay alive'], policy: { rules: [{ ...rule('flee'), pinned: true }] } };
    const attrs = [
        { name: 'miner', source: ['mine deep'], policy: { rules: [rule('mine', 'is_idle')] } },
        { name: 'careful', source: ['never dig straight down'] },
    ];
    const text = buildMergeInstructions(base, attrs);
    assert.match(text, /BASE \("stayin_alive"\)/);
    assert.match(text, /just stay alive/);
    assert.ok(text.includes(JSON.stringify(base.policy)), 'the base rules go in as JSON, not as prose');
    assert.ok(text.includes(JSON.stringify(attrs[0].policy)), 'an attribute with rules sends them too');
    assert.match(text, /never dig straight down/, 'an attribute with only words still gets in');
    assert.ok(text.indexOf('"miner"') < text.indexOf('"careful"'), 'attributes stay in the order given');
    assert.match(text, /take priority/, 'the model is told who wins a conflict');
    assert.match(text, /later attribute takes priority/);
    assert.match(text, /Preserve every base rule/);
    assert.match(text, /ONE combined policy/);
});

test('a base with no attributes is used as-is, without paying for an LLM call', async () => {
    const policy = { modes: { hunting: false }, rules: [rule('flee')] };
    saveProfile('solo', { source: ['never fight'], policy, kind: 'base' });
    const agent = { name: 'Gen', prompter: { get chat_model() { throw new Error('the LLM was called'); } } };
    const state = await generatePolicy(agent, 'solo', []);
    assert.deepEqual(state.layers.active.policy, policy);
    assert.deepEqual(state.layers.active.source, ['generated from base "solo"']);
    assert.equal(state.compose.base, 'solo');
    assert.deepEqual(state.compose.attributes, []);
    assert.ok(state.compose.generated_at > 0);
});

test('generating from a missing or attribute-kind base is an error, not a silent empty policy', async () => {
    const agent = { name: 'Gen' };
    await assert.rejects(() => generatePolicy(agent, 'no_such_profile', []), /no policy profile named/);
    await assert.rejects(() => generatePolicy(agent, 'careful', []), /is an attribute, not a base/);
});

test('the agent may clear only its own layer', async () => {
    savePolicyState('Andy', layered());
    const clear = getCommand('!clearPolicy');
    const bot = { modes: { installPolicy: () => {}, clearPolicy: () => {} } };
    const self = { name: 'Andy', command_self_issued: true, bot };

    assert.match(await clear.perform(self, 'active'), /set by a person/);
    assert.match(await clear.perform(self, 'all'), /set by a person/);
    assert.ok(loadPolicyState('Andy').layers.active, 'the refusal left the layer alone');

    await clear.perform(self);
    const after = loadPolicyState('Andy');
    assert.equal(after.layers.self, undefined, 'its own layer is gone');
    assert.ok(after.layers.active, 'a person\'s layer is untouched');

    await clear.perform({ name: 'Andy', command_self_issued: false, bot });
    assert.deepEqual(loadPolicyState('Andy').layers, {}, 'a person can clear everything');
});

test('clearing the active layer forgets what it was generated from', async () => {
    const state = layered();
    state.compose = { base: 'solo', attributes: [], generated_at: Date.now() };
    savePolicyState('Andy', state);
    const bot = { modes: { installPolicy: () => {}, clearPolicy: () => {} } };
    await getCommand('!clearPolicy').perform({ name: 'Andy', command_self_issued: false, bot }, 'active');
    assert.equal(loadPolicyState('Andy').compose, null, 'a stale recipe would let a regenerate undo the clear');
});

test('the agent cannot load a profile while the policy is locked', async () => {
    saveProfile('gather', { source: ['gather wood'], policy: { rules: [rule('gather', 'is_idle')] }, kind: 'base' });
    const load = getCommand('!loadProfile');
    const bot = { modes: { installPolicy: () => {}, clearPolicy: () => {} } };
    const self = { name: 'Locked', command_self_issued: true, bot };

    setPolicyLocked('Locked', true);
    assert.match(await load.perform(self, 'gather'), /locked/);

    setPolicyLocked('Locked', false);
    assert.match(await load.perform(self, 'gather'), /Loaded profile/);
    const state = loadPolicyState('Locked');
    assert.equal(state.layers.active.profile, 'gather', 'the layer records where it came from');
    assert.equal(state.compose.base, 'gather', 'and it is a recipe an attribute can later be added to');
    assert.equal(state.locked, false, 'installing did not drop the lock flag');
});

test('an attribute profile cannot be loaded on its own', async () => {
    const bot = { modes: { installPolicy: () => {}, clearPolicy: () => {} } };
    const res = await getCommand('!loadProfile').perform({ name: 'Andy', bot }, 'careful');
    assert.match(res, /attribute profile/);
});

test('!saveProfile is a person\'s to run', async () => {
    savePolicyState('Andy', layered());
    const save = getCommand('!saveProfile');
    const agent = { name: 'Andy', command_self_issued: true };
    assert.match(await save.perform(agent, 'sneaky', 'active'), /Only a person/);
    assert.equal(loadProfile('sneaky'), null);
    assert.match(await save.perform({ name: 'Andy' }, 'stance', 'active'), /Saved/);
    assert.deepEqual(loadProfile('stance').source, ['gather wood']);
    assert.equal(loadProfile('stance').kind, 'base', 'a saved layer is a base unless it is called an attribute');
    await save.perform({ name: 'Andy' }, 'quirk', 'active', 'attribute');
    assert.equal(loadProfile('quirk').kind, 'attribute');
});

test('!updateProfile grows the library from chat without touching the running policy', async () => {
    const update = getCommand('!updateProfile');
    const agent = { name: 'Andy', command_self_issued: true };

    // no name, nothing running: it has to ask rather than guess
    savePolicyState('Andy', { layers: {}, locked: false, compose: null });
    assert.match(await update.perform(agent, 'mine iron'), /which profile/i);

    // a brand-new attribute is prose-only -- no compile, no LLM, no policy key
    assert.match(await update.perform(agent, 'stay within 100 blocks of the bed', 'homebody'), /Created attribute profile "homebody"/);
    const homebody = loadProfile('homebody');
    assert.equal(homebody.kind, 'attribute');
    assert.equal(homebody.policy, undefined);
    assert.deepEqual(homebody.source, ['stay within 100 blocks of the bed']);

    // appending keeps earlier prose and defaults to the running base by name
    await update.perform(agent, 'and never cross water', 'homebody');
    assert.deepEqual(loadProfile('homebody').source, ['stay within 100 blocks of the bed', 'and never cross water']);

    const state = { layers: {}, locked: false, compose: { base: 'homebase', attributes: ['homebody'], generated_at: 1 } };
    savePolicyState('Andy', state);
    saveProfile('homebase', { source: ['stay alive'], policy: { modes: {}, rules: [rule('flee')] }, kind: 'base' });
    // default target is the compose base; its old rules survive the append
    const compiled = { modes: { hunting: false }, rules: [rule('mine', 'is_idle')] };
    const stub = { name: 'Andy', command_self_issued: true, prompter: { checkCooldown: async () => {}, chat_model: { sendRequest: async () => JSON.stringify(compiled) } } };
    const res = await update.perform(stub, 'mine iron when idle');
    assert.match(res, /"homebase"/);
    assert.match(res, /Regen/, 'a change to a running profile points the person at the Regen button');
    const grown = loadProfile('homebase');
    assert.equal(grown.policy.rules.length, 2, 'old rules kept, new rule appended');
    assert.equal(grown.policy.modes.hunting, false);

    // locked policy shuts the self-issued door
    savePolicyState('Andy', { layers: {}, locked: true, compose: null });
    assert.match(await update.perform(agent, 'anything', 'homebody'), /locked/);
});

// The agent restates the same standing instruction under a new name every time it
// recompiles, and the copies then interrupt each other all night.
test('a rule that repeats one already in force is dropped, whatever it is called', () => {
    const hold = (name) => ({ name, when: { any: [{ cond: 'is_night' }, { cond: 'hostile_nearby', range: 16 }] }, do: [{ act: 'stay' }] });
    const state = { layers: {
        active: { policy: { rules: [rule('flee_mobs')] } },
        self: { policy: { rules: [hold('night_or_hostile_hold_position'), hold('no_mine_if_night_or_hostile')] } },
    } };
    const names = composePolicy(state).rules.map(r => r.name);
    assert.deepEqual(names, ['self:night_or_hostile_hold_position', 'active:flee_mobs']);
});

// Same trigger, different response: both survive. Deleting one on a guess is how
// a person's pinned survival rule silently disappears.
test('rules sharing a trigger but not an action both survive', () => {
    const at_night = (name, act) => ({ name, when: { cond: 'is_night' }, do: [{ act }] });
    const state = { layers: { active: { policy: { rules: [at_night('sleep', 'go_to_bed'), at_night('arm', 'equip_weapon')] } } } };
    assert.equal(composePolicy(state).rules.length, 2);
});

// ---------- goals ----------
// Rules only react; the goal is the half of a policy that goes looking. Profiles
// declare what they are for, and the merge turns those into the one thing the
// agent works towards -- it can only pursue one at a time.

test('a profile keeps its goal across a save and load', () => {
    saveProfile('goal_keeper', { source: ['stay alive'], kind: 'base', goal: 'Survive indefinitely.' });
    assert.equal(loadProfile('goal_keeper').goal, 'Survive indefinitely.');
    saveProfile('goal_keeper', { source: ['stay alive'], kind: 'base', goal: '   ' });
    assert.equal(loadProfile('goal_keeper').goal, undefined, 'blank is no goal at all');
});

test('the merge instructions ask for one goal out of every profile that declares one', () => {
    const base = { name: 'stayin_alive', source: ['just stay alive'], goal: 'Do not die.' };
    const attrs = [{ name: 'food', source: ['eat well'], goal: 'Keep a food surplus.' }];
    const text = buildMergeInstructions(base, attrs);
    assert.match(text, /Its goal: Do not die\./);
    assert.match(text, /Its goal: Keep a food surplus\./);
    assert.match(text, /Combine them into ONE goal/);
    assert.match(text, /"goal" string in the JSON/);
});

test('profiles without goals tell the compiler not to invent one', () => {
    const text = buildMergeInstructions({ name: 'plain', source: ['do stuff'] }, []);
    assert.match(text, /do not invent one/);
    assert.doesNotMatch(text, /Combine them into ONE goal/);
});

test('a base with no attributes carries its own goal through, still without an LLM call', async () => {
    const policy = { modes: {}, rules: [rule('flee')] };
    saveProfile('lone_goal', { source: ['never fight'], policy, kind: 'base', goal: 'Find a quiet valley.' });
    const agent = { name: 'Gen', prompter: { get chat_model() { throw new Error('the LLM was called'); } } };
    const state = await generatePolicy(agent, 'lone_goal', []);
    assert.equal(state.layers.active.policy.goal, 'Find a quiet valley.');
    assert.deepEqual(policy.goal, undefined, 'the profile on disk is not mutated');
});

test('a goal invented by the compiler is dropped when no profile asked for one', async () => {
    saveProfile('no_goal_base', { source: ['just vibes'], kind: 'base' });
    saveProfile('no_goal_attr', { source: ['more vibes'], kind: 'attribute' });
    const agent = { name: 'Gen', prompter: {
        checkCooldown: async () => {},
        chat_model: { sendRequest: async () => JSON.stringify({ modes: {}, rules: [], goal: 'Conquer the server.' }) },
    } };
    const state = await generatePolicy(agent, 'no_goal_base', ['no_goal_attr']);
    assert.equal(state.layers.active.policy.goal, undefined);
});

test('the goal comes from the active layer only -- never the one the agent writes', () => {
    const state = { layers: {
        active: { policy: { rules: [], goal: 'Build a base.' } },
        self: { policy: { rules: [], goal: 'Dig straight down forever.' } },
    } };
    assert.equal(policyGoal(state), 'Build a base.');
    delete state.layers.active;
    assert.equal(policyGoal(state), null, 'the self layer cannot set the goal on its own');
});

test('a policy goal starts the loop, and no goal leaves a running one alone', async () => {
    const started = [];
    const agent = { self_prompter: { prompt: null, start: async (p) => { started.push(p); agent.self_prompter.prompt = p; } } };
    await applyPolicyGoal(agent, { layers: { active: { policy: { rules: [], goal: 'Build a base.' } } } });
    assert.deepEqual(started, ['Build a base.']);
    // same goal again: already running, do not restart the loop
    await applyPolicyGoal(agent, { layers: { active: { policy: { rules: [], goal: 'Build a base.' } } } });
    assert.deepEqual(started, ['Build a base.']);
    // a policy with no goal must not stop what a person set with !goal
    await applyPolicyGoal(agent, { layers: { active: { policy: { rules: [] } } } });
    assert.equal(agent.self_prompter.prompt, 'Build a base.');
});

test('a goal has to be a non-empty string to survive validation', () => {
    assert.equal(validatePolicy({ rules: [], goal: 'Survive.' }), null);
    assert.equal(validatePolicy({ rules: [] }), null);
    assert.match(validatePolicy({ rules: [], goal: '' }), /non-empty string/);
    assert.match(validatePolicy({ rules: [], goal: { text: 'no' } }), /non-empty string/);
});
