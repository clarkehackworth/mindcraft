import test from 'node:test';
import assert from 'node:assert/strict';
import convoManager, { compileQueuedBotMessages } from '../src/agent/conversation.js';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function makeAgent() {
    const calls = [];
    const history = [];
    const promptShouldRespondCalls = [];
    return {
        name: 'tester',
        last_sender: null,
        shut_up: true,
        actions: { currentActionLabel: '' },
        active_message_handlers: 0,
        isIdle: () => true,
        openChat: () => {},
        handleMessage: (source, message) => calls.push({ source, message }),
        history: { add: (source, message) => history.push({ source, message }) },
        self_prompter: {
            isActive: () => false,
            isPaused: () => false,
            pause: async () => {},
            start: () => {},
        },
        prompter: {
            promptShouldRespondToBot: async (message) => {
                promptShouldRespondCalls.push(message);
                return true;
            },
        },
        calls,
        historyCalls: history,
        promptShouldRespondCalls,
    };
}

function resetConversationManager(agent = makeAgent()) {
    for (const convo of Object.values(convoManager.convos)) {
        if (convo.inMessageTimer)
            clearTimeout(convo.inMessageTimer);
    }
    if (convoManager.connection_monitor)
        clearInterval(convoManager.connection_monitor);
    if (convoManager.connection_timeout)
        clearTimeout(convoManager.connection_timeout);

    convoManager.convos = {};
    convoManager.activeConversation = null;
    convoManager.awaiting_response = false;
    convoManager.connection_timeout = null;
    convoManager.connection_monitor = null;
    convoManager.initAgent(agent);
    convoManager.updateAgents([{ name: 'buddy', in_game: true }]);
    return agent;
}

test.afterEach(() => {
    resetConversationManager();
});

test('compileQueuedBotMessages preserves queued bot message boundaries', () => {
    const compiled = compileQueuedBotMessages([
        { message: '*used equip*', start: true, end: false },
        { message: '*used collectBlocks*', start: false, end: false },
        { message: 'State update:\n* action: Idle', start: false, end: true },
    ]);

    assert.equal(compiled.message, '*used equip*\n*used collectBlocks*\nState update:\n* action: Idle');
    assert.equal(compiled.start, true);
    assert.equal(compiled.end, true);
});


test('delivered bot messages include a distinct source marker line', async () => {
    const agent = resetConversationManager();

    await convoManager.receiveFromBot('buddy', { message: 'hi', start: true, end: false });
    await delay(260);

    assert.deepEqual(agent.calls, [{ source: 'buddy', message: '(FROM OTHER BOT)\nhi' }]);
});

test('ending a conversation drops queued messages without stale response flush', async () => {
    const agent = resetConversationManager();

    await convoManager.receiveFromBot('buddy', { message: 'hello', start: true, end: false });
    assert.equal(convoManager.responseScheduledFor('buddy'), true);

    convoManager.endConversation('buddy');
    await delay(260);

    assert.deepEqual(agent.calls, []);
    assert.deepEqual(agent.historyCalls, []);
});

test('reset clears stale timers so old flushes cannot send later queued messages', async () => {
    const agent = resetConversationManager();

    await convoManager.receiveFromBot('buddy', { message: 'old', start: true, end: false });
    const convo = convoManager._getConvo('buddy');
    convo.reset();
    convo.queue({ message: 'new', start: false, end: false });

    await delay(260);

    assert.deepEqual(agent.calls, []);
});

test('empty queued bot message flush does not call handleMessage', async () => {
    const agent = resetConversationManager();

    await convoManager.receiveFromBot('buddy', { message: 'will be removed', start: true, end: false });
    const convo = convoManager._getConvo('buddy');
    convo.in_queue = [];

    await delay(260);

    assert.deepEqual(agent.calls, []);
    assert.equal(convo.inMessageTimer, null);
});

test('busy bot messages stay queued instead of making sidecar botResponder requests', async () => {
    const agent = resetConversationManager();
    agent.isIdle = () => false;
    agent.active_message_handlers = 1;
    agent.actions.currentActionLabel = 'action:collectBlocks';

    await convoManager.receiveFromBot('buddy', { message: '*used collectBlocks*', start: true, end: false });

    assert.equal(convoManager.responseScheduledFor('buddy'), true);
    assert.deepEqual(agent.promptShouldRespondCalls, []);
    assert.deepEqual(agent.calls, []);
});

test('busy normal bot messages are serialized through handleMessage with source marker', async () => {
    const agent = resetConversationManager();
    agent.isIdle = () => false;
    agent.active_message_handlers = 1;
    agent.actions.currentActionLabel = 'action:collectBlocks';

    await convoManager.receiveFromBot('buddy', { message: 'hello while busy', start: true, end: false });
    await delay(260);

    assert.deepEqual(agent.promptShouldRespondCalls, []);
    assert.deepEqual(agent.calls, [{ source: 'buddy', message: '(FROM OTHER BOT)\nhello while busy' }]);
});
