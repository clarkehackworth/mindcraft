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

test('native tool execution records structured tool calls and tool results', () => {
    const agentSource = readFileSync('src/agent/agent.js', 'utf8');
    const nativeSection = agentSource.slice(agentSource.indexOf('async _executeNativeToolCalls'));

    assert.ok(nativeSection.includes('this.history.addNativeToolCall(toolCall)'));
    assert.ok(nativeSection.includes('this.history.addNativeToolResult(toolCall, formatNativeToolResultForModel(toolCall, execute_res))'));
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

    assert.ok(html.includes("event.tag === 'coding' && attachInternalToolEvent(current, event)"));
    assert.ok(html.includes('function attachInternalToolEvent(turn, event)'));
    assert.ok(html.includes('function findInternalToolHost(turn)'));
    assert.ok(html.includes("getToolName(item.call) === 'newAction'"));
    assert.ok(html.includes('function renderInternalToolEvents(events)'));
    assert.ok(html.includes('Internal coding requests'));
});

test('chat request role labels preserve provider message role', () => {
    const html = readFileSync('src/mindcraft/public/index.html', 'utf8');
    const roleLabelSection = html.slice(html.indexOf('function getMessageRoleLabel'), html.indexOf('function isCompactCompatibilityMessage'));

    assert.ok(roleLabelSection.includes("return message?.role || 'message';"));
    assert.equal(roleLabelSection.includes("return 'system'"), false);
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

test('agent persists merged state/request context as one append-only user turn', () => {
    const agentSource = readFileSync('src/agent/agent.js', 'utf8');
    const snapshotSource = readFileSync('src/agent/state_snapshot.js', 'utf8');
    const settingsSource = readFileSync('settings.js', 'utf8');
    const settingsSpec = readFileSync('src/mindcraft/public/settings_spec.json', 'utf8');

    assert.ok(agentSource.includes('buildStateSnapshotDiff(this)'));
    assert.ok(agentSource.includes('createTransientRequestMessage(transientParts)'));
    assert.ok(agentSource.includes('pendingPersistedParts.push(createHistoryUserMessageForRequest'));
    assert.ok(agentSource.includes('this.history.addUserContext(pendingPersistedParts.join'));
    assert.ok(agentSource.includes('await this.history.addUserContext(stateDiff)'));
    assert.equal(agentSource.includes('historyBeforeCurrentMessage = this.history.getHistory()'), false);
    assert.equal(agentSource.includes('removeLastMatchingMessage'), false);
    assert.ok(agentSource.includes("join(\'\\n\\n\')"));
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

test('chat UI suppresses history turn duplicated by the following request', () => {
    const html = readFileSync('src/mindcraft/public/index.html', 'utf8');

    assert.ok(html.includes('isPendingHistoryOnlyTurn(current)'));
    assert.ok(html.includes('thread.turns.pop()'));
    assert.ok(html.includes('isHistoryTurnIncludedInRequest(event.turn, requestMessages)'));
    assert.ok(html.includes('.filter(historyEvent => !isHistoryTurnIncludedInRequest(historyEvent.turn, requestMessages))'));
    assert.ok(html.includes('requestText.startsWith(`${content}\\n\\n`)'));
});

test('chat UI renders only request message deltas instead of repeated full history', () => {
    const html = readFileSync('src/mindcraft/public/index.html', 'utf8');

    assert.ok(html.includes('let previousRequestMessages = []'));
    assert.ok(html.includes('event.visible_messages = selectVisibleRequestMessages(event.messages, previousRequestMessages)'));
    assert.ok(html.includes('getCommonRequestPrefixLength(previousMessages, messages)'));
    assert.ok(html.includes('const newMessages = messages.slice(startIndex);'));
    assert.ok(html.includes('getTrailingUserMessages(scope)'));
    assert.ok(html.includes("if (message?.role !== 'user') break;"));
    assert.ok(html.includes('function getMessageRoleLabel(message, preview = formatChatMessagePreview(message))'));
    assert.equal(html.includes("preview.startsWith('Context:')"), false);
    assert.ok(html.includes('replace(/^Context:'));
    assert.ok(html.includes("State update:\\n')"));
    assert.ok(html.includes('class="chat-message-text"'));
});
