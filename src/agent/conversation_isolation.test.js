// A/B agents share a mindserver; with !startConversation blocked, a relayed
// message from the other agent must not open a conversation.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import settings from './settings.js';
import convoManager from './conversation.js';

test('a blocked !startConversation also ignores inbound bot messages', async () => {
    convoManager.initAgent({ name: 'Andy', bot: { chat() {} }, isIdle: () => true, handleMessage: async () => {}, openChat() {}, self_prompter: { isActive: () => false, isStopped: () => true, stop: async () => {}, stopLoop: async () => {}, shouldInterrupt: () => false }, actions: { stop: async () => {} } });
    convoManager.updateAgents([{ name: 'Andy', in_game: true }, { name: 'AndyB', in_game: true }]);
    settings.blocked_actions = ['!startConversation'];
    await convoManager.receiveFromBot('AndyB', { message: 'hello', start: true });
    assert.ok(!convoManager.inConversation('AndyB'), 'blocked: no conversation opened');
    // control: with nothing blocked the same message opens one
    settings.blocked_actions = [];
    await convoManager.receiveFromBot('AndyB', { message: 'hello', start: true });
    assert.ok(convoManager.inConversation('AndyB'), 'unblocked: conversation opened');
});
