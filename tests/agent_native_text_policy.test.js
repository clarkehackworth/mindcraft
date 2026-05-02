import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('agent contains explicit AI text-command block in native tool mode', () => {
    const agentSource = readFileSync('src/agent/agent.js', 'utf8');

    assert.ok(agentSource.includes('if (this.prompter.isNativeToolMode())'));
    assert.ok(agentSource.includes('Text command ${command_name} was not executed'));
    assert.ok(agentSource.includes('AI actions must use native tool calls'));
    assert.ok(agentSource.includes('continue;'));
});



test('interrupted native tool responses are closed with synthetic tool results before next request', async () => {
    const { Agent } = await import('../src/agent/agent.js');
    const turns = [];
    const toolEvents = [];
    let interruptChecks = 0;
    let executed = false;
    const agent = Object.create(Agent.prototype);
    agent.name = 'bot';
    agent.shut_up = false;
    agent.last_sender = null;
    agent.checkTaskDone = async () => {};
    agent.self_prompter = {
        shouldInterrupt: () => ++interruptChecks > 1,
        isActive: () => false,
        handleUserPromptedCmd: () => { executed = true; }
    };
    agent.bot = { modes: { flushBehaviorLog: () => '' } };
    agent.history = {
        addUserContext: async content => turns.push({ role: 'user', content }),
        addNativeToolCall: async toolCall => {
            toolEvents.push({ type: 'call', toolCall });
            turns.push({ role: 'assistant', content: '', native_tool_calls: [toolCall] });
        },
        addNativeToolResult: async (toolCall, result) => {
            toolEvents.push({ type: 'result', toolCall, result });
            turns.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
        },
        save: () => {},
        getHistory: () => turns.map(turn => ({ ...turn }))
    };
    agent.prompter = {
        promptConvo: async () => ({
            type: 'tool_calls',
            tool_calls: [{ id: 'call_interrupted', type: 'function', name: 'collectBlocks', arguments: '{"type":"oak_log","num":1}' }]
        })
    };
    agent.routeResponse = () => {};

    const usedCommand = await agent._handleMessageImpl('Steve', 'collect one oak log', 1);

    assert.equal(usedCommand, true);
    assert.equal(executed, false);
    assert.deepEqual(toolEvents.map(event => event.type), ['call', 'result']);
    assert.equal(toolEvents[1].toolCall.id, 'call_interrupted');
    assert.match(toolEvents[1].result, /interrupted before execution/);
    assert.deepEqual(turns.slice(-2).map(turn => turn.role), ['assistant', 'tool']);
});

test('human message queue drains all pending messages as one request', async () => {
    const { Agent } = await import('../src/agent/agent.js');
    const turns = [];
    const requests = [];
    const agent = Object.create(Agent.prototype);
    agent.name = 'bot';
    agent.shut_up = false;
    agent.last_sender = null;
    agent.active_message_handlers = 0;
    agent.active_native_tool_calls = new Map();
    agent.message_interrupt_epoch = 0;
    agent.human_message_queue = [];
    agent.human_message_interrupt_promise = Promise.resolve();
    agent.checkTaskDone = async () => {};
    agent.self_prompter = {
        shouldInterrupt: () => false,
        isActive: () => false,
        handleUserPromptedCmd: () => {}
    };
    agent.bot = { modes: { flushBehaviorLog: () => '' } };
    agent.history = {
        addUserContext: async content => turns.push({ role: 'user', content }),
        add: async (name, content) => turns.push(name === agent.name ? { role: 'assistant', content } : { role: 'user', content: `${name}: ${content}` }),
        save: () => {},
        getHistory: () => turns.map(turn => ({ ...turn }))
    };
    agent.prompter = {
        promptConvo: async messages => {
            requests.push(messages.map(turn => ({ ...turn })));
            return 'reply';
        },
        consumeLastConversationResponseMetadata: () => ({})
    };
    agent.routeResponse = () => {};

    const first = agent.handleMessage('Steve', 'first', 1);
    const second = agent.handleMessage('Steve', 'second', 1);
    await Promise.all([first, second]);

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].map(turn => turn.content), ['Steve: first\nsecond']);
    assert.deepEqual(turns.map(turn => turn.content), ['Steve: first\nsecond', 'reply']);
});

test('new human message interrupts and drops a stale pending LLM response', async () => {
    const { Agent } = await import('../src/agent/agent.js');
    const turns = [];
    const requests = [];
    const signals = [];
    let releaseFirst;
    const firstPromptStarted = new Promise(resolve => {
        releaseFirst = resolve;
    });
    let promptCount = 0;
    const agent = Object.create(Agent.prototype);
    agent.name = 'bot';
    agent.shut_up = false;
    agent.last_sender = null;
    agent.active_message_handlers = 0;
    agent.active_native_tool_calls = new Map();
    agent.message_interrupt_epoch = 0;
    agent.human_message_queue = [];
    agent.human_message_interrupt_promise = Promise.resolve();
    agent.checkTaskDone = async () => {};
    agent.self_prompter = {
        shouldInterrupt: () => false,
        isActive: () => false,
        handleUserPromptedCmd: () => {}
    };
    agent.bot = { modes: { flushBehaviorLog: () => '' } };
    agent.history = {
        addUserContext: async content => turns.push({ role: 'user', content }),
        add: async (name, content) => turns.push(name === agent.name ? { role: 'assistant', content } : { role: 'user', content: `${name}: ${content}` }),
        save: () => {},
        getHistory: () => turns.map(turn => ({ ...turn }))
    };
    agent.prompter = {
        promptConvo: async (messages, options = {}) => {
            const currentPrompt = ++promptCount;
            signals.push(options.signal);
            requests.push(messages.map(turn => ({ ...turn })));
            if (currentPrompt === 1) {
                await firstPromptStarted;
            }
            return `reply ${currentPrompt}`;
        },
        consumeLastConversationResponseMetadata: () => ({})
    };
    agent.routeResponse = () => {};

    const first = agent.handleMessage('Steve', 'first', 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = agent.handleMessage('Steve', 'second', 1);
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.equal(requests.length, 1);
    assert.equal(signals[0].aborted, true);
    releaseFirst();
    await Promise.all([first, second]);

    assert.equal(requests.length, 2);
    assert.equal(signals[1].aborted, false);
    assert.deepEqual(requests[1].map(turn => turn.content), ['Steve: first', 'Steve: second']);
    assert.deepEqual(turns.map(turn => turn.content), ['Steve: first', 'Steve: second', 'reply 2']);
});

test('new human message skips stale queued self prompt before consuming a ReAct turn', async () => {
    const { Agent } = await import('../src/agent/agent.js');
    const turns = [];
    const requests = [];
    const turnStateKeys = [];
    let releaseQueue;
    const blockedQueue = new Promise(resolve => {
        releaseQueue = resolve;
    });
    const agent = Object.create(Agent.prototype);
    agent.name = 'bot';
    agent.shut_up = false;
    agent.last_sender = null;
    agent.active_message_handlers = 0;
    agent.active_native_tool_calls = new Map();
    agent.message_interrupt_epoch = 0;
    agent.message_handler_queue = blockedQueue;
    agent.human_message_queue = [];
    agent.human_message_interrupt_promise = Promise.resolve();
    agent.checkTaskDone = async () => {};
    agent.self_prompter = {
        shouldInterrupt: () => false,
        isActive: () => false,
        handleUserPromptedCmd: () => {}
    };
    agent.bot = { modes: { flushBehaviorLog: () => '' } };
    agent.history = {
        addUserContext: async content => turns.push({ role: 'user', content }),
        add: async (name, content) => turns.push(name === agent.name ? { role: 'assistant', content } : { role: 'user', content: `${name}: ${content}` }),
        save: () => {},
        getHistory: () => turns.map(turn => ({ ...turn }))
    };
    agent.prompter = {
        promptConvo: async (messages, options = {}) => {
            requests.push(messages.map(turn => ({ ...turn })));
            turnStateKeys.push(options.turnStateKey);
            return 'reply';
        },
        consumeLastConversationResponseMetadata: () => ({})
    };
    agent.routeResponse = () => {};

    const staleSelfPrompt = agent.handleMessage('system', 'continue old goal', 1, { transient: true });
    const humanMessage = agent.handleMessage('Steve', 'new request', 1);
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.equal(requests.length, 0);
    releaseQueue();
    await Promise.all([staleSelfPrompt, humanMessage]);

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].map(turn => turn.content), ['Steve: new request']);
    assert.deepEqual(turnStateKeys, ['react-1']);
    assert.deepEqual(turns.map(turn => turn.content), ['Steve: new request', 'reply']);
});



test('user stop closes an executing native tool exactly once', async () => {
    const { Agent } = await import('../src/agent/agent.js');
    const toolCall = { id: 'call_running', type: 'function', name: 'collectBlocks', arguments: '{"type":"oak_log","num":1}' };
    const results = [];
    const agent = Object.create(Agent.prototype);
    agent.active_native_tool_calls = new Map();
    agent.history = {
        addNativeToolResult: async (call, result) => results.push({ call, result }),
        save: () => { results.push({ saved: true }); }
    };

    agent._trackActiveNativeToolCall(toolCall);
    const interrupted = await agent.finishInterruptedNativeToolCalls('Tool interrupted by user !stop command.');
    const lateCompletion = await agent._completeActiveNativeToolCall(toolCall, 'Action output arrived after stop.');

    assert.equal(interrupted, 1);
    assert.equal(lateCompletion, false);
    assert.equal(results.filter(item => item.result).length, 1);
    assert.equal(results[0].call.id, 'call_running');
    assert.equal(results[0].result, 'Tool interrupted by user !stop command.');
    assert.deepEqual(results[1], { saved: true });
});

test('human stop closes active native tool calls before waiting on action stop', () => {
    const actionsSource = readFileSync('src/agent/commands/actions.js', 'utf8');
    const stopSection = actionsSource.slice(actionsSource.indexOf("name: '!stop'"), actionsSource.indexOf("name: '!stfu'"));

    assert.ok(stopSection.includes('finishInterruptedNativeToolCalls'));
    assert.ok(stopSection.indexOf('finishInterruptedNativeToolCalls') < stopSection.indexOf('agent.actions.stop()'));
});

test('web disconnect targets only the selected agent socket before process fallback', () => {
    const serverSource = readFileSync('src/mindcraft/mindserver.js', 'utf8');
    const stopSection = serverSource.slice(serverSource.indexOf("socket.on('stop-agent'"), serverSource.indexOf("socket.on('start-agent'"));
    const proxySource = readFileSync('src/agent/mindserver_proxy.js', 'utf8');

    assert.ok(stopSection.includes('agent_connections[agentName]'));
    assert.ok(stopSection.includes("agent.socket.emit('stop-agent')"));
    assert.ok(stopSection.includes('mindcraft.stopAgent(agentName)'));
    assert.ok(proxySource.includes("this.socket.on('stop-agent'"));
    assert.ok(proxySource.includes("this.agent.cleanKill('Stopped by MindServer.', 0)"));
});

test('native tool execution records structured tool calls and tool results', () => {
    const agentSource = readFileSync('src/agent/agent.js', 'utf8');
    const nativeSection = agentSource.slice(agentSource.indexOf('async _executeNativeToolCalls'));

    assert.ok(nativeSection.includes('this.history.addNativeToolCall(toolCall, undefined, metadata)'));
    assert.ok(nativeSection.includes('this._trackActiveNativeToolCall(toolCall)'));
    assert.ok(nativeSection.includes('this._completeActiveNativeToolCall(toolCall, formatNativeToolResultForModel(toolCall, execute_res))'));
});

test('native tool execution sends visible progress without storing display text in history', () => {
    const agentSource = readFileSync('src/agent/agent.js', 'utf8');
    const nativeSection = agentSource.slice(agentSource.indexOf('async _executeNativeToolCalls'));

    assert.ok(nativeSection.includes('const display = `*used ${toolCall.name}*`'));
    assert.ok(nativeSection.includes('this.routeResponse(source, display)'));
    assert.equal(nativeSection.includes('addNativeToolCall(toolCall, display)'), false);
});

test('native tool execution always returns a tool result to the model', () => {
    const agentSource = readFileSync('src/agent/agent.js', 'utf8');

    assert.ok(agentSource.includes('function formatNativeToolResultForModel'));
    assert.ok(agentSource.includes('return `Tool ${name} completed.`'));
    assert.ok(agentSource.includes('await this.history.addNativeToolResult(toolCall, msg)'));
});

test('speech does not truncate normal exclamation text as an unknown command', () => {
    const agentSource = readFileSync('src/agent/agent.js', 'utf8');

    assert.ok(agentSource.includes('prepareChatMessageForOutput(message)'));
    assert.ok(agentSource.includes('if (command_name && !commandExists(command_name))'));
    assert.ok(agentSource.includes('command_name = null;'));
    assert.ok(agentSource.includes('speak(spokenMessage, this.prompter.profile.speak_model);'));
});


test('system TTS uses argv-based say/espeak invocation for full text', () => {
    const speakSource = readFileSync('src/agent/speak.js', 'utf8');

    assert.ok(speakSource.includes('buildSystemTTSInvocation(txt, process.platform)'));
    assert.ok(speakSource.includes('args: [txt]'));
    assert.equal(speakSource.includes('? `say "${txt'), false);
    assert.equal(speakSource.includes(': `espeak "${txt'), false);
});

test('chat output preparation preserves normal full speech text', async () => {
    const { prepareChatMessageForOutput } = await import('../src/agent/agent.js');

    assert.equal(prepareChatMessageForOutput('hello world, codex').spokenMessage, 'hello world, codex');
    assert.equal(prepareChatMessageForOutput('Hello world!I am codex').spokenMessage, 'Hello world!I am codex');
    assert.equal(prepareChatMessageForOutput('hello !stats').spokenMessage, 'hello ');
});

test('minecraft command echoes are filtered without blocking normal human chat', async () => {
    const { isMinecraftCommandEchoMessage } = await import('../src/agent/agent.js');

    assert.equal(isMinecraftCommandEchoMessage('Removed 10 item(s) from 2 players]'), true);
    assert.equal(isMinecraftCommandEchoMessage('Gave 64 oak_log to Ninot_Quyi'), true);
    assert.equal(isMinecraftCommandEchoMessage('/clear @a'), true);
    assert.equal(isMinecraftCommandEchoMessage('Ninot_Quyi: 给我做个石头镐子'), false);
    assert.equal(isMinecraftCommandEchoMessage('给我做个石头镐子'), false);
    assert.equal(isMinecraftCommandEchoMessage('I removed 10 items from a chest'), false);
});

test('system TTS invocation passes full text as one macOS say argument', async () => {
    const { buildSystemTTSInvocation } = await import('../src/agent/speak.js');
    const text = 'hello world, codex';
    const excited = 'Hello world! I am codex';

    assert.deepEqual(buildSystemTTSInvocation(text, 'darwin'), {
        mode: 'spawn',
        command: 'say',
        args: [text]
    });
    assert.deepEqual(buildSystemTTSInvocation(excited, 'darwin').args, [excited]);
    assert.deepEqual(buildSystemTTSInvocation(text, 'linux'), {
        mode: 'spawn',
        command: 'espeak',
        args: [text]
    });
});

test('init message is not resent when memory already restored conversation history', () => {
    const agentSource = readFileSync('src/agent/agent.js', 'utf8');

    assert.ok(agentSource.includes('init_message && !hasLoadedConversation(save_data)'));
    assert.ok(agentSource.includes('function hasLoadedConversation(saveData)'));
    assert.ok(agentSource.includes('Array.isArray(saveData.turns) && saveData.turns.length > 0'));
});

test('self-prompt continuation is transient and not persisted as history', async () => {
    const { Agent } = await import('../src/agent/agent.js');
    const capturedRequests = [];
    const persisted = [];
    const turns = [];
    const agent = Object.create(Agent.prototype);
    agent.name = 'bot';
    agent.shut_up = false;
    agent.last_sender = null;
    agent.checkTaskDone = async () => {};
    agent.self_prompter = {
        shouldInterrupt: () => false,
        isActive: () => false,
        handleUserPromptedCmd: () => {}
    };
    agent.bot = { modes: { flushBehaviorLog: () => '' } };
    agent.history = {
        add: async (source, message) => persisted.push({ source, message }),
        save: () => {},
        getHistory: () => [{ role: 'user', content: 'Steve: ready' }]
    };
    agent.prompter = {
        promptConvo: async messages => {
            capturedRequests.push(messages);
            return '';
        }
    };

    await agent._handleMessageImpl('system', 'Continue working on your current goal: "mine".', 1, { transient: true });

    assert.deepEqual(persisted, []);
    assert.equal(capturedRequests.length, 1);
    assert.deepEqual(capturedRequests[0], [
        { role: 'user', content: 'Steve: ready' },
        { role: 'user', content: 'System: Continue working on your current goal: "mine".' }
    ]);
});

test('starting a goal during native tool execution defers the self-prompt loop', async () => {
    const { SelfPrompter } = await import('../src/agent/self_prompter.js');
    let handleSelfPromptCalls = 0;
    const agent = {
        isHandlingMessage: () => true,
        isIdle: () => true,
        handleSelfPrompt: async () => {
            handleSelfPromptCalls++;
            return false;
        }
    };
    const selfPrompter = new SelfPrompter(agent);

    selfPrompter.start('mine iron');

    assert.equal(selfPrompter.isActive(), true);
    assert.equal(selfPrompter.loop_active, false);
    assert.equal(selfPrompter.prompt, 'mine iron');
    assert.equal(handleSelfPromptCalls, 0);
});

test('newAction code generation uses an isolated tool-internal prompt', async () => {
    const { createCodeGenerationMessages } = await import('../src/agent/coder.js');
    const coderSource = readFileSync('src/agent/coder.js', 'utf8');
    const actionsSource = readFileSync('src/agent/commands/actions.js', 'utf8');
    const prompterSource = readFileSync('src/models/prompter.js', 'utf8');
    const messages = createCodeGenerationMessages('build a tower');

    assert.deepEqual(messages, [{
        role: 'user',
        content: 'Code generation task:\nbuild a tower\n\nWrite the implementation as a JavaScript code block.'
    }]);
    assert.ok(actionsSource.includes('agent.coder.generateCode(prompt)'));
    assert.equal(actionsSource.includes('agent.coder.generateCode(agent.history)'), false);
    assert.equal(coderSource.includes('agent_history.getHistory()'), false);
    assert.equal(messages.some(message => message.content.includes('Code generation started')), false);
    assert.ok(prompterSource.includes('extractCodeTaskContent(messages)'));
    assert.ok(prompterSource.includes("msg.content.startsWith('Code generation task:')"));
});



test('chat UI projects instruction context trace events', () => {
    const html = readFileSync('src/mindcraft/public/index.html', 'utf8');
    const projector = readFileSync('src/mindcraft/public/chat_trace_projector.js', 'utf8');

    assert.ok(projector.includes("case 'instruction_context':"));
    assert.ok(projector.includes('addInstructionContext(event)'));
    assert.ok(projector.includes('instructionContexts: []'));
    assert.ok(html.includes('function renderInstructionContext(event)'));
    assert.ok(html.includes('Instruction payload'));
});

test('chat UI adds copy controls to expanded JSON payloads', () => {
    const html = readFileSync('src/mindcraft/public/index.html', 'utf8');

    assert.ok(html.includes('function enableChatCopyButtons(panel)'));
    assert.ok(html.includes('enableChatCopyButtons(panel);'));
    assert.ok(html.includes('class="chat-copy-btn"'));
    assert.ok(html.includes('navigator.clipboard?.writeText'));
    assert.ok(html.includes("document.execCommand('copy')"));
});

test('chat UI nests coding requests under the active tool instead of top-level turns', () => {
    const html = readFileSync('src/mindcraft/public/index.html', 'utf8');
    const projector = readFileSync('src/mindcraft/public/chat_trace_projector.js', 'utf8');

    assert.ok(html.includes('/chat_trace_projector.js'));
    assert.ok(projector.includes('class ChatTraceProjector'));
    assert.ok(projector.includes("event.tag === 'coding' && this.attachInternalToolEvent(event)"));
    assert.ok(projector.includes('attachInternalToolEvent(event)'));
    assert.ok(projector.includes('findInternalToolHost(turn)'));
    assert.ok(projector.includes("callHelper('getToolName', item.call) === 'newAction'"));
    assert.ok(html.includes('function renderInternalToolEvents(events)'));
    assert.ok(html.includes('Internal coding requests'));
});

test('chat UI and trace projection render model thinking separately', () => {
    const html = readFileSync('src/mindcraft/public/index.html', 'utf8');
    const projector = readFileSync('src/mindcraft/public/chat_trace_projector.js', 'utf8');

    assert.ok(projector.includes('assistantThinking'));
    assert.ok(projector.includes("callHelper('extractResponseThinking'"));
    assert.ok(html.includes('function extractResponseThinking'));
    assert.ok(html.includes('function renderThinking'));
    assert.ok(html.includes('class="chat-thinking"'));
    assert.ok(html.includes('class="chat-thinking-preview"'));
    assert.ok(html.includes('-webkit-line-clamp: 2'));
    assert.ok(html.includes('turn.assistantThinking'));
    assert.equal(html.includes('renderThinking(item.event?.thinking)'), false);
});

test('chat trace projection can show reasoning effort in the model label', () => {
    const projector = readFileSync('src/mindcraft/public/chat_trace_projector.js', 'utf8');

    assert.ok(projector.includes('display_label'));
    assert.ok(projector.includes("request?.model?.display_label"));
});

test('chat request cards avoid duplicate per-message role labels', () => {
    const html = readFileSync('src/mindcraft/public/index.html', 'utf8');
    const renderRequestMessagesSection = html.slice(html.indexOf('function renderRequestMessages'), html.indexOf('function selectVisibleRequestMessages'));

    assert.ok(renderRequestMessagesSection.includes('class="chat-message-row"'));
    assert.ok(renderRequestMessagesSection.includes('class="chat-message-text"'));
    assert.equal(renderRequestMessagesSection.includes('getMessageRoleLabel'), false);
    assert.equal(renderRequestMessagesSection.includes('roleLabel'), false);
    assert.equal(renderRequestMessagesSection.includes('<div class="chat-muted">'), false);
});


test('behavior logs are persisted with the outbound user turn for append-only cache stability', async () => {
    const { Agent } = await import('../src/agent/agent.js');
    const capturedRequests = [];
    const persisted = [];
    const turns = [];
    const agent = Object.create(Agent.prototype);
    agent.name = 'bot';
    agent.shut_up = false;
    agent.last_sender = null;
    agent.checkTaskDone = async () => {};
    agent.self_prompter = {
        shouldInterrupt: () => false,
        isActive: () => false,
        handleUserPromptedCmd: () => {}
    };
    agent.bot = { modes: { flushBehaviorLog: () => "I'm stuck! I'm free." } };
    agent.history = {
        add: async (source, message) => {
            persisted.push({ source, message });
            turns.push({ role: 'user', content: `${source}: ${message}` });
        },
        addUserContext: async content => {
            persisted.push({ source: 'user_context', message: content });
            turns.push({ role: 'user', content });
        },
        save: () => {},
        getHistory: () => turns.map(turn => ({ ...turn }))
    };
    agent.prompter = {
        promptConvo: async messages => {
            capturedRequests.push(messages);
            return '';
        }
    };

    await agent._handleMessageImpl('Steve', 'hello', 1);

    assert.deepEqual(persisted, [{
        source: 'user_context',
        message: "Steve: hello\n\nSystem: Recent behaviors log: \nI'm stuck! I'm free."
    }]);
    assert.deepEqual(capturedRequests[0], [
        { role: 'user', content: "Steve: hello\n\nSystem: Recent behaviors log: \nI'm stuck! I'm free." }
    ]);
    assert.deepEqual(turns, [{ role: 'user', content: "Steve: hello\n\nSystem: Recent behaviors log: \nI'm stuck! I'm free." }]);
});


test('chat UI does not render redundant tool argument expanders', () => {
    const html = readFileSync('src/mindcraft/public/index.html', 'utf8');

    assert.equal(html.includes("renderDetails('Tool arguments'"), false);
    assert.equal(html.includes('Tool arguments'), false);
});

test('New Agent forms hide hidden settings and keep profile upload separate', () => {
    const html = readFileSync('src/mindcraft/public/index.html', 'utf8');

    assert.ok(html.includes('Profile: Not uploaded'));
    assert.ok(html.includes('id="uploadProfileBtn"'));
    assert.ok(html.includes('function isEditableSetting(key'));
    assert.ok(html.includes('!cfg?.hidden'));
    assert.ok(html.includes("cfg?.ui !== 'hidden'"));
    assert.ok(html.includes('if (!isEditableSetting(key, cfg)) return; // profile handled via upload; hidden settings use server defaults'));
    assert.ok(html.includes('if (!isEditableSetting(key, cfg)) return; // profile and hidden settings are not edited here'));
});

test('agent delegates ReAct request assembly to a single message manager', () => {
    const agentSource = readFileSync('src/agent/agent.js', 'utf8');
    const managerSource = readFileSync('src/agent/react_message_manager.js', 'utf8');
    const snapshotSource = readFileSync('src/agent/state_snapshot.js', 'utf8');
    const settingsSource = readFileSync('settings.js', 'utf8');
    const settingsSpec = readFileSync('src/mindcraft/public/settings_spec.json', 'utf8');

    assert.ok(agentSource.includes('new ReactMessageManager(this)'));
    assert.ok(agentSource.includes('const reactTurn = this.react_messages.startTurn({ source, message, options, behaviorLog })'));
    assert.ok(agentSource.includes('await reactTurn.buildRequestMessages()'));
    assert.equal(agentSource.includes('await this.react_messages.buildRequestMessages()'), false);
    assert.equal(agentSource.includes('buildStateSnapshotDiff(this)'), false);
    assert.equal(agentSource.includes('pendingPersistedParts'), false);
    assert.equal(agentSource.includes('createTransientRequestMessage(transientParts)'), false);
    assert.equal(agentSource.includes('historyBeforeCurrentMessage = this.history.getHistory()'), false);
    assert.equal(agentSource.includes('removeLastMatchingMessage'), false);

    assert.ok(managerSource.includes('class ReactMessageManager'));
    assert.ok(managerSource.includes('return new ReactMessageTurn'));
    assert.ok(managerSource.includes('buildStateSnapshotDiff(this.agent)'));
    assert.ok(managerSource.includes('this.pendingPersistedParts.join'));
    assert.ok(managerSource.includes('await this.agent.history.addUserContext(content)'));
    assert.ok(managerSource.includes('createTransientRequestMessage(requestTransientParts)'));

    assert.ok(snapshotSource.includes('State update:\\n'));
    assert.ok(snapshotSource.includes('`* inventory: ${formatMap(snapshot.inventory)'));
    assert.ok(snapshotSource.includes('lines.push(`* ${label}:'));
    assert.equal(snapshotSource.includes('lines.push(`- ${label}:'), false);
    assert.equal(snapshotSource.includes('Current state:'), false);
    assert.equal(snapshotSource.includes('State changes:'), false);
    assert.equal(snapshotSource.includes('Use this instead of re-checking unchanged state'), false);
    assert.equal(settingsSource.includes('state_snapshot_diff'), false);
    assert.equal(settingsSpec.includes('state_snapshot_diff'), false);
});

test('system prompts carry state snapshot usage guidance', () => {
    const prompt = readFileSync('profiles/defaults/prompts/conversing.md', 'utf8');

    assert.ok(prompt.includes('Use transient state snapshots/diffs as your current baseline'));
});

test('chat UI projection suppresses history turns duplicated by the following request', () => {
    const projector = readFileSync('src/mindcraft/public/chat_trace_projector.js', 'utf8');

    assert.ok(projector.includes('class ChatTraceProjector'));
    assert.ok(projector.includes('takePendingHistoryOnlyTurn()'));
    assert.ok(projector.includes('isHistoryOnlyProjectionTurn(this.current)'));
    assert.ok(projector.includes('this.thread.turns.pop()'));
    assert.ok(projector.includes('removeRequestIncludedHistory(turn, requestMessages)'));
    assert.ok(projector.includes("callHelper('isHistoryTurnIncludedInRequest', historyEvent.turn, requestMessages)"));
    const html = readFileSync('src/mindcraft/public/index.html', 'utf8');
    assert.ok(html.includes('requestText.startsWith(`${content}'));
});

test('chat UI projection renders only request message deltas instead of repeated full history', () => {
    const html = readFileSync('src/mindcraft/public/index.html', 'utf8');
    const projector = readFileSync('src/mindcraft/public/chat_trace_projector.js', 'utf8');

    assert.ok(projector.includes('this.previousRequestMessages = []'));
    assert.ok(projector.includes("visibleRequestMessages: callHelper('selectVisibleRequestMessages', requestMessages, this.previousRequestMessages)"));
    assert.ok(projector.includes('this.previousRequestMessages = requestMessages'));
    assert.ok(html.includes('getCommonRequestPrefixLength(previousMessages, messages)'));
    assert.ok(html.includes('const newMessages = messages.slice(startIndex);'));
    assert.ok(html.includes('getTrailingUserMessages(scope)'));
    assert.ok(html.includes("if (message?.role !== 'user') break;"));
    assert.equal(html.includes("preview.startsWith('Context:')"), false);
    assert.ok(html.includes('replace(/^Context:'));
    assert.ok(html.includes('State update:'));
    assert.ok(html.includes('class="chat-message-text"'));
});

test('chat trace projector is display-only and cannot mutate model history or requests', () => {
    const projector = readFileSync('src/mindcraft/public/chat_trace_projector.js', 'utf8');

    assert.equal(projector.includes('addUserContext'), false);
    assert.equal(projector.includes('.addNativeTool'), false);
    assert.equal(projector.includes('.add('), false);
    assert.equal(projector.includes('.save('), false);
    assert.equal(projector.includes('sendRequest'), false);
    assert.equal(projector.includes('promptConvo'), false);
    assert.equal(projector.includes('traceLLM'), false);
});

test('conversation and coding requests use separate prompt cache scopes', () => {
    const prompterSource = readFileSync('src/models/prompter.js', 'utf8');

    assert.ok(prompterSource.includes("cacheScope: 'conversation'"));
    assert.ok(prompterSource.includes("cacheScope: 'coding'"));
    assert.ok(prompterSource.includes("cacheScope: 'compactSummary'"));
    assert.ok(prompterSource.includes("cacheScope: 'botResponder'"));
    assert.ok(prompterSource.includes("cacheScope: 'vision'"));
    assert.ok(prompterSource.includes("cacheScope: 'goalSetting'"));
});
