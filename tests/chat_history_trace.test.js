import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { History } from '../src/agent/history.js';
import { setSettings } from '../src/agent/settings.js';

class FakeModel {
    static prefix = 'fake-protocol';

    constructor() {
        this.provider = 'fake-provider';
        this.model_name = 'fake-model';
        this.supportsNativeToolCalls = true;
    }
}

test('runtime chat history persists when Runtime is enabled without full trace logging', async () => {
    const originalCwd = process.cwd();
    const dir = mkdtempSync(path.join(tmpdir(), 'mindcraft-trace-'));
    try {
        process.chdir(dir);
        setSettings({ show_chat_history: true, log_chat_trace: false });
        const history = new History({
            name: 'tracebot',
            self_prompter: { state: {} },
            task: {}
        });

        const model = new FakeModel();
        model.lastThinking = 'I should inspect inventory.';
        model.lastTokenUsage = {
            input_total: 42,
            input_uncached: 10,
            input_cached: 32,
            output: 7,
            total: 49
        };
        const messages = [{ role: 'user', content: 'Steve: check inventory' }];
        const tools = [{ type: 'function', function: { name: 'inventory', parameters: { type: 'object' } } }];
        history.traceInstructionContext('AGENTS.md instructions', 'Follow repo-local AGENTS.md guidance.', { source: 'AGENTS.md' });
        history.traceLLMRequest('conversation', model, 'system prompt text', messages, tools);
        history.traceLLMResponse('conversation', model, { type: 'tool_calls', tool_calls: [{ name: 'inventory' }] });

        await history.add('Steve', 'check inventory');
        await history.add('system', 'Action was interrupted by unstuck.');
        const toolCall = { id: 'call_1', type: 'function', name: 'inventory', arguments: '{}' };
        await history.addNativeToolCall(toolCall, undefined, { thinking: 'I should inspect inventory.', thinking_key: 'reasoning_content' });
        await history.addNativeToolResult(toolCall, 'Action output:\nInventory is empty.');

        assert.ok(history.chat_history_session_fp);
        assert.ok(existsSync(history.chat_history_session_fp));
        assert.ok(existsSync(history.chat_history_latest_fp));
        const events = readFileSync(history.chat_history_latest_fp, 'utf8')
            .trim()
            .split('\n')
            .map(line => JSON.parse(line));
        assert.ok(events.some(event => event.type === 'instruction_context'));
        assert.ok(events.some(event => event.type === 'llm_request'));
        assert.ok(events.some(event => event.type === 'llm_response'));
        assert.ok(events.some(event => event.type === 'llm_response' && event.thinking === 'I should inspect inventory.'));
        assert.ok(events.some(event => event.type === 'history_turn_added'));
        assert.ok(events.some(event => event.type === 'tool_call'));
        assert.ok(events.some(event => event.type === 'tool_result'));
        assert.equal(history.turns.length, 4);
    } finally {
        setSettings({});
        process.chdir(originalCwd);
        rmSync(dir, { recursive: true, force: true });
    }
});

test('chat history trace records prompts, messages, tool calls and tool results when enabled', async () => {
    const originalCwd = process.cwd();
    const dir = mkdtempSync(path.join(tmpdir(), 'mindcraft-trace-'));
    try {
        process.chdir(dir);
        setSettings({ show_chat_history: true, log_chat_trace: true });
        const history = new History({
            name: 'tracebot',
            self_prompter: { state: {} },
            task: {}
        });

        const model = new FakeModel();
        model.lastThinking = 'I should inspect inventory.';
        model.lastTokenUsage = {
            input_total: 42,
            input_uncached: 10,
            input_cached: 32,
            output: 7,
            total: 49
        };
        const messages = [{ role: 'user', content: 'Steve: check inventory' }];
        const tools = [{ type: 'function', function: { name: 'inventory', parameters: { type: 'object' } } }];
        history.traceInstructionContext('AGENTS.md instructions', 'Follow repo-local AGENTS.md guidance.', { source: 'AGENTS.md' });
        history.traceLLMRequest('conversation', model, 'system prompt text', messages, tools);
        history.traceLLMResponse('conversation', model, { type: 'tool_calls', tool_calls: [{ name: 'inventory' }] });

        await history.add('Steve', 'check inventory');
        await history.add('system', 'Action was interrupted by unstuck.');
        const toolCall = { id: 'call_1', type: 'function', name: 'inventory', arguments: '{}' };
        await history.addNativeToolCall(toolCall, undefined, { thinking: 'I should inspect inventory.', thinking_key: 'reasoning_content' });
        await history.addNativeToolResult(toolCall, 'Action output:\nInventory is empty.');

        const events = readFileSync(history.chat_history_latest_fp, 'utf8')
            .trim()
            .split('\n')
            .map(line => JSON.parse(line));

        assert.ok(events.some(event => event.type === 'session_started'));
        const instructions = events.find(event => event.type === 'instruction_context');
        assert.equal(instructions.title, 'AGENTS.md instructions');
        assert.equal(instructions.content, 'Follow repo-local AGENTS.md guidance.');
        assert.deepEqual(instructions.metadata, { source: 'AGENTS.md' });
        const request = events.find(event => event.type === 'llm_request');
        assert.equal(request.system_prompt, 'system prompt text');
        assert.deepEqual(request.messages, messages);
        assert.equal(request.tool_count, 1);
        assert.equal(request.model.api, 'fake-protocol');
        assert.equal(request.request_fingerprint.message_count, 1);
        assert.equal(request.request_fingerprint.tool_count, 1);
        assert.ok(request.request_fingerprint.system_prompt_hash);
        assert.ok(request.request_fingerprint.messages_hash);
        assert.ok(request.request_fingerprint.tools_hash);

        assert.ok(events.some(event => event.type === 'llm_response'));
        const response = events.find(event => event.type === 'llm_response');
        assert.deepEqual(response.token_usage, model.lastTokenUsage);
        assert.ok(events.some(event => event.type === 'history_turn_added' && event.turn.role === 'user'));
        assert.ok(events.some(event => event.type === 'history_turn_added' && event.turn.role === 'user' && event.turn.content.startsWith('System: Action was interrupted')));
        assert.ok(!events.some(event => event.type === 'history_turn_added' && event.turn.role === 'system'));
        assert.ok(events.some(event => event.type === 'tool_call' && event.tool_call.name === 'inventory' && event.thinking === 'I should inspect inventory.'));
        assert.ok(events.some(event => event.type === 'tool_result' && event.result.includes('Inventory is empty')));
        assert.ok(history.turns.some(turn => turn.role === 'assistant' && turn.thinking === 'I should inspect inventory.'));
    } finally {
        setSettings({});
        process.chdir(originalCwd);
        rmSync(dir, { recursive: true, force: true });
    }
});



test('chat history trace records configured instruction contexts at session start', async () => {
    const originalCwd = process.cwd();
    const dir = mkdtempSync(path.join(tmpdir(), 'mindcraft-trace-instructions-'));
    try {
        process.chdir(dir);
        setSettings({
            show_chat_history: true,
            log_chat_trace: true,
            trace_instruction_contexts: [
                {
                    title: 'AGENTS.md instructions',
                    content: 'Follow repo-local AGENTS.md guidance.',
                    metadata: { source: 'runtime-test' }
                }
            ]
        });
        const history = new History({
            name: 'tracebot',
            self_prompter: { state: {} },
            task: {}
        });

        const events = readFileSync(history.chat_history_latest_fp, 'utf8')
            .trim()
            .split('\n')
            .map(line => JSON.parse(line));
        const instructions = events.find(event => event.type === 'instruction_context');
        assert.equal(instructions.title, 'AGENTS.md instructions');
        assert.equal(instructions.content, 'Follow repo-local AGENTS.md guidance.');
        assert.deepEqual(instructions.metadata, { source: 'runtime-test' });
    } finally {
        setSettings({});
        process.chdir(originalCwd);
        rmSync(dir, { recursive: true, force: true });
    }
});

test('history dedupes repeated self-prompt reminders from active context', async () => {
    const originalCwd = process.cwd();
    const dir = mkdtempSync(path.join(tmpdir(), 'mindcraft-selfprompt-'));
    try {
        process.chdir(dir);
        setSettings({ show_chat_history: true, log_chat_trace: true });
        const history = new History({
            name: 'tracebot',
            self_prompter: { state: {} },
            task: {}
        });

        const reminder = 'Continue working on your current goal: "mine". Decide the next useful step and proceed. If the goal is complete, finish the goal.';
        await history.add('system', reminder);
        await history.addNativeToolCall({ id: 'call_1', type: 'function', name: 'inventory', arguments: '{}' });
        await history.addNativeToolResult({ id: 'call_1', type: 'function', name: 'inventory', arguments: '{}' }, 'Action output:\nempty');
        await history.add('system', reminder);

        const selfPromptTurns = history.turns.filter(turn => turn.content === `System: ${reminder}`);
        assert.equal(selfPromptTurns.length, 1);

        const events = readFileSync(history.chat_history_latest_fp, 'utf8')
            .trim()
            .split('\n')
            .map(line => JSON.parse(line));
        assert.ok(events.some(event => event.type === 'history_turn_deduped' && event.reason === 'duplicate_self_prompt_reminder'));
    } finally {
        setSettings({});
        process.chdir(originalCwd);
        rmSync(dir, { recursive: true, force: true });
    }
});



test('history compaction replaces active context with boundary and summary', async () => {
    const originalCwd = process.cwd();
    const dir = mkdtempSync(path.join(tmpdir(), 'mindcraft-compact-'));
    try {
        process.chdir(dir);
        setSettings({
            show_chat_history: false,
            log_chat_trace: false,
            max_messages: 4,
            compact_message_threshold_percent: 100
        });
        const summarized = [];
        const history = new History({
            name: 'compactbot',
            prompter: {
                promptCompactSummary: async turns => {
                    summarized.push(turns.map(t => t.content || t.name).join('|'));
                    return `summary of ${turns.length} turns`;
                }
            },
            self_prompter: { state: {} },
            task: {}
        });

        await history.add('Steve', 'one');
        await history.add('compactbot', 'two');
        await history.add('Steve', 'three');
        await history.add('compactbot', 'four');

        assert.equal(summarized.length, 1);
        assert.equal(history.memory, 'summary of 4 turns');
        assert.equal(history.turns.length, 2);
        assert.equal(history.turns[0].compact_boundary, true);
        assert.equal(history.turns[1].compact_summary, true);
        assert.match(history.turns[1].content, /summary of 4 turns/);
        assert.deepEqual(history.getHistory(), [history.turns[1]]);
        assert.ok(history.full_history_fp);
        assert.ok(existsSync(history.full_history_fp));
    } finally {
        setSettings({});
        process.chdir(originalCwd);
        rmSync(dir, { recursive: true, force: true });
    }
});

test('history compaction counts only new turns after the latest compact summary', async () => {
    const originalCwd = process.cwd();
    const dir = mkdtempSync(path.join(tmpdir(), 'mindcraft-compact-budget-'));
    try {
        process.chdir(dir);
        setSettings({
            show_chat_history: false,
            log_chat_trace: false,
            max_messages: 4,
            compact_message_threshold_percent: 100
        });
        const summarized = [];
        const history = new History({
            name: 'compactbot',
            prompter: {
                promptCompactSummary: async turns => {
                    summarized.push(turns.map(t => t.content || t.name).join('|'));
                    return `summary pass ${summarized.length}`;
                }
            },
            self_prompter: { state: {} },
            task: {}
        });

        await history.add('Steve', 'one');
        await history.add('compactbot', 'two');
        await history.add('Steve', 'three');
        await history.add('compactbot', 'four');
        assert.equal(summarized.length, 1);

        await history.add('Steve', 'five');
        await history.add('compactbot', 'six');
        assert.equal(summarized.length, 1);

        await history.add('Steve', 'seven');
        await history.add('compactbot', 'eight');
        assert.equal(summarized.length, 2);
        assert.doesNotMatch(summarized[1], /Conversation compacted/);
        assert.match(summarized[1], /summary pass 1/);
        assert.match(summarized[1], /Steve: five/);
        assert.match(summarized[1], /six/);
    } finally {
        setSettings({});
        process.chdir(originalCwd);
        rmSync(dir, { recursive: true, force: true });
    }
});

test('history compaction waits for native tool results before compacting', async () => {
    const originalCwd = process.cwd();
    const dir = mkdtempSync(path.join(tmpdir(), 'mindcraft-compact-tools-'));
    try {
        process.chdir(dir);
        setSettings({
            show_chat_history: false,
            log_chat_trace: false,
            max_messages: 2,
            compact_message_threshold_percent: 100
        });
        let summaries = 0;
        const history = new History({
            name: 'compactbot',
            prompter: {
                promptCompactSummary: async turns => {
                    summaries += 1;
                    return `summary after ${turns.length}`;
                }
            },
            self_prompter: { state: {} },
            task: {}
        });

        const toolCall = { id: 'call_1', type: 'function', name: 'inventory', arguments: '{}' };
        await history.add('Steve', 'check inventory');
        await history.addNativeToolCall(toolCall);
        assert.equal(summaries, 0);
        assert.equal(history.turns.length, 2);

        await history.addNativeToolResult(toolCall, 'empty');
        assert.equal(summaries, 1);
        assert.equal(history.turns[0].compact_boundary, true);
        assert.equal(history.turns[1].compact_summary, true);
    } finally {
        setSettings({});
        process.chdir(originalCwd);
        rmSync(dir, { recursive: true, force: true });
    }
});
