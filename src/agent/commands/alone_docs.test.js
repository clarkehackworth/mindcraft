// Andy is the only agent on this server, and the command docs told him every
// turn that he could start a conversation with another bot. The only name he
// had was his own, so he used it: the relay handed the message back, he
// answered, and each round trip cost a turn. The receive/send guards stop the
// loop; this stops the message being written at all, which is the half that
// costs money.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { getCommandDocs } from './index.js';
import convoManager from '../conversation.js';

const agent = { name: 'Andy', blocked_actions: [] };
const docsWith = agents => {
    convoManager.initAgent(agent);
    convoManager.updateAgents(agents);
    return getCommandDocs(agent);
};

test('alone on the server, there is nobody to start a conversation with', () => {
    const docs = docsWith([{ name: 'Andy', in_game: true }]);
    assert.ok(!docs.includes('!startConversation'));
    assert.ok(!docs.includes('!endConversation'));
    // Everything else still has to be there -- this is a filter, not a purge.
    assert.ok(docs.includes('!goToCoordinates'));
});

test('another bot in game brings the commands back', () => {
    const docs = docsWith([{ name: 'Andy', in_game: true }, { name: 'Jill', in_game: true }]);
    assert.ok(docs.includes('!startConversation'));
    assert.ok(docs.includes('!endConversation'));
});

test('a bot that is registered but not in game does not count', () => {
    // It cannot receive anything, so advertising the command only invites the
    // model to write a message into the void.
    const docs = docsWith([{ name: 'Andy', in_game: true }, { name: 'Jill', in_game: false }]);
    assert.ok(!docs.includes('!startConversation'));
});
