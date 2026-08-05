// Run: node src/models/prompter_coalesce.test.js
// Every message used to launch its own generation, and the staleness check
// discarded finished responses after they were paid for -- 1177 discarded
// completions in one container's logs, mostly mode-output bursts during mob
// attacks. promptConvo now settles the burst and waits out in-flight
// generations, so superseded calls exit before sending anything.
import assert from 'assert';
import { Prompter } from './prompter.js';

function fakePrompter(requestMs) {
    const p = Object.create(Prompter.prototype);
    p.profile = { conversing: 'x' };
    p.convo_examples = null;
    p.agent = { name: 'Andy' };
    p.checkCooldown = async () => {};
    p.replaceStrings = async () => 'prompt';
    p._saveLog = async () => {};
    p.requests = 0;
    p.chat_model = { sendRequest: async () => {
        p.requests++;
        await new Promise(r => setTimeout(r, requestMs));
        return `response ${p.requests}`;
    }};
    return p;
}

// A burst of 4 messages inside the settle window: one paid request, the last
// caller gets the response, the superseded ones exit with ''.
const burst = fakePrompter(100);
const results = [];
for (let i = 0; i < 4; i++) {
    results.push(burst.promptConvo([]));
    await new Promise(r => setTimeout(r, 50));
}
const burst_out = await Promise.all(results);
assert.equal(burst.requests, 1, 'a burst pays for one generation, not four');
assert.deepEqual(burst_out, ['', '', '', 'response 1'], 'only the freshest call answers');

// A message arriving mid-generation still discards the stale response (that
// one was already paid for), but the newcomer waits it out instead of racing.
const mid = fakePrompter(600);
const a = mid.promptConvo([]);
await new Promise(r => setTimeout(r, 500)); // past the settle window, A in flight
const b = mid.promptConvo([]);
assert.deepEqual(await Promise.all([a, b]), ['', 'response 2'], 'stale response discarded, fresh one kept');
assert.equal(mid.requests, 2, 'the newcomer generates once, after A finishes');

// A system-injected message is not a new turn. Policy prompt_self and the
// "Recent behaviors log" are context added to the conversation the agent is
// already having, and treating them as fresh input discarded finished, paid-for
// responses that were still the right answer to the question being asked.
const injected = fakePrompter(400);
const real_turn = injected.promptConvo([], true);   // a person says something
await new Promise(r => setTimeout(r, 500));         // past the settle window
const policy_prompt = injected.promptConvo([], false); // a rule chimes in mid-generation
assert.deepEqual(await Promise.all([real_turn, policy_prompt]),
    ['response 1', 'response 2'],
    'the system message waits its turn instead of invalidating the answer in flight');

// The other direction is unchanged: a person interrupting still wins.
const person = fakePrompter(400);
const first = person.promptConvo([], true);
await new Promise(r => setTimeout(r, 500));
const second = person.promptConvo([], true);
assert.deepEqual(await Promise.all([first, second]), ['', 'response 2'], 'a real turn still supersedes');

console.log('ok: message bursts coalesce into one generation, and system context does not discard it');
