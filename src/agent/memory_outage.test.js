// Run: node src/agent/memory_outage.test.js
// Soak 7 days 5 and 6 were an OpenAI outage. The summarizer failed like
// everything else, and its canned "My brain disconnected, try again." was
// written into the bot's memory as though it were a summary -- so the run's
// accumulated base coordinates, chest contents and death lessons were replaced
// by an error message, and stayed replaced after the API came back.
import assert from 'assert';
import { History } from './history.js';

const KEPT = 'Base(39,71,-44). Chest: 12 pine_log, 1 wooden_sword. Avoid the cliff at -53,88.';

function historyWith(summary) {
    const history = new History({
        name: 'test',
        prompter: { promptMemSaving: async () => summary },
    });
    history.memory = KEPT;
    return history;
}

for (const failure of ['My brain disconnected, try again.', '', '   ', null, undefined]) {
    const history = historyWith(failure);
    await history.summarizeMemories([]);
    assert.equal(history.memory, KEPT, `a failed summary (${JSON.stringify(failure)}) must not erase memory`);
}

const good = historyWith('Base(39,71,-44). Found a bed. Sheep to the north.');
await good.summarizeMemories([]);
assert.equal(good.memory, 'Base(39,71,-44). Found a bed. Sheep to the north.', 'a real summary still lands');

console.log('ok: an outage cannot overwrite the bot\'s memory');
process.exit(0);
