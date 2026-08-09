// Andy was the only agent on the server and spent hours talking to himself: the
// model addressed a message to "Andy", isOtherAgent said yes (agent_names holds
// every agent, including this one), the mindserver relayed it straight back, and
// each round trip was a paid turn carrying the whole growing transcript.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import convoManager from './conversation.js';

convoManager.initAgent({ name: 'Andy', self_prompter: { isActive: () => false, isPaused: () => false } });
convoManager.updateAgents([{ name: 'Andy', in_game: true }, { name: 'Jill', in_game: true }]);

test('an agent is not one of the other agents', () => {
    assert.equal(convoManager.isOtherAgent('Andy'), false);
    assert.equal(convoManager.isOtherAgent('Jill'), true);
    assert.equal(convoManager.isOtherAgent('SomePlayer'), false);
});

test('a message relayed back from itself is dropped', async () => {
    await convoManager.receiveFromBot('Andy', { message: 'hello me', start: true });
    assert.ok(!convoManager.inConversation('Andy'),
        'answering yourself starts a conversation that never ends');
});
