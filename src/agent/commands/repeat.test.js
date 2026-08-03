// Run: node src/agent/commands/repeat.test.js
// Andy spent minutes issuing !goToCoordinates(78,63,-124,2) every few seconds
// because each interrupted attempt looked like a fresh one. The third such call
// in a short window has to say so, even with other commands in between.
import assert from 'assert';
import { checkRepeat } from './index.js';

let agent = {};
const goto_base = { commandName: '!goToCoordinates', args: [78, 63, -124, 2] };

assert.equal(checkRepeat(agent, goto_base), '', 'first call is silent');
assert.equal(checkRepeat(agent, goto_base), '', 'second call is silent');
assert.match(checkRepeat(agent, goto_base), /REPEATED COMMAND/, 'third identical call warns');
assert.match(checkRepeat(agent, goto_base), /4 times/, 'the count keeps climbing');

// The loop seen live: other commands in between used to reset the counter.
agent = {};
const search = { commandName: '!searchForBlock', args: ['pine_log', 64] };
checkRepeat(agent, goto_base);
checkRepeat(agent, search);
checkRepeat(agent, goto_base);
checkRepeat(agent, { commandName: '!moveAway', args: [10] });
assert.match(checkRepeat(agent, goto_base), /REPEATED COMMAND/, 'interleaved repeats are caught');

// Different arguments are a different attempt.
agent = {};
checkRepeat(agent, goto_base);
checkRepeat(agent, goto_base);
assert.equal(checkRepeat(agent, { commandName: '!goToCoordinates', args: [78, 63, -125, 2] }), '',
    'different args are not the same command');

// Once the agent moves on, the window empties and the warning stops.
agent = {};
for (let i = 0; i < 3; i++) checkRepeat(agent, goto_base);
for (let i = 0; i < 10; i++) checkRepeat(agent, { commandName: '!stats' + i });
assert.equal(checkRepeat(agent, goto_base), '', 'the window forgets old repeats');

// Argument-less commands work the same way.
agent = {};
const stats = { commandName: '!stats' };
checkRepeat(agent, stats);
checkRepeat(agent, stats);
assert.match(checkRepeat(agent, stats), /REPEATED COMMAND/, 'commands without args are counted too');

console.log('ok: repeated commands are called out, interleaved or not');
process.exit(0);
