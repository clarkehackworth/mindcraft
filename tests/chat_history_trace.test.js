import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { History } from '../src/agent/history.js';

class FakeModel {
    static prefix = 'fake-protocol';

    constructor() {
        this.provider = 'fake-provider';
        this.model_name = 'fake-model';
        this.supportsNativeToolCalls = true;
    }
}

test('chat history trace records prompts, messages, tool calls and tool results', async () => {
    const originalCwd = process.cwd();
    const dir = mkdtempSync(path.join(tmpdir(), 'mindcraft-trace-'));
    try {
        process.chdir(dir);
        const history = new History({
            name: 'tracebot',
            self_prompter: { state: {} },
            task: {}
        });

        const model = new FakeModel();
        const messages = [{ role: 'user', content: 'Steve: check inventory' }];
        const tools = [{ type: 'function', function: { name: 'inventory', parameters: { type: 'object' } } }];
        history.traceLLMRequest('conversation', model, 'system prompt text', messages, tools);
        history.traceLLMResponse('conversation', model, { type: 'tool_calls', tool_calls: [{ name: 'inventory' }] });

        await history.add('Steve', 'check inventory');
        const toolCall = { id: 'call_1', type: 'function', name: 'inventory', arguments: '{}' };
        await history.addNativeToolCall(toolCall);
        await history.addNativeToolResult(toolCall, 'Action output:\nInventory is empty.');

        const events = readFileSync(history.chat_history_latest_fp, 'utf8')
            .trim()
            .split('\n')
            .map(line => JSON.parse(line));

        assert.ok(events.some(event => event.type === 'session_started'));
        const request = events.find(event => event.type === 'llm_request');
        assert.equal(request.system_prompt, 'system prompt text');
        assert.deepEqual(request.messages, messages);
        assert.equal(request.tool_count, 1);
        assert.equal(request.model.api, 'fake-protocol');

        assert.ok(events.some(event => event.type === 'llm_response'));
        assert.ok(events.some(event => event.type === 'history_turn_added' && event.turn.role === 'user'));
        assert.ok(events.some(event => event.type === 'tool_call' && event.tool_call.name === 'inventory'));
        assert.ok(events.some(event => event.type === 'tool_result' && event.result.includes('Inventory is empty')));
    } finally {
        process.chdir(originalCwd);
        rmSync(dir, { recursive: true, force: true });
    }
});
