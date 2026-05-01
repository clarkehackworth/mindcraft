import test from 'node:test';
import assert from 'node:assert/strict';
import {
    commandToToolDefinition,
    executeCommandToolCall
} from '../src/agent/commands/tool_adapter.js';
import {
    createNativeToolResponse,
    isNativeToolResponse,
    parseToolArguments
} from '../src/models/native_tools.js';
import { containsCommand, parseCommandMessage } from '../src/agent/commands/index.js';

test('human !command parser remains available', () => {
    assert.equal(containsCommand('please !stats'), '!stats');
    assert.deepEqual(parseCommandMessage('!stats'), { commandName: '!stats', args: [] });
});

test('command schema conversion preserves required and optional parameters', () => {
    const tool = commandToToolDefinition({
        name: '!sample',
        description: 'Sample command',
        params: {
            count: { type: 'int', description: 'Count', domain: [1, 5] },
            note: { type: 'string', description: 'Optional note', optional: true }
        }
    });

    assert.equal(tool.type, 'function');
    assert.equal(tool.function.name, 'sample');
    assert.deepEqual(tool.function.parameters.required, ['count']);
    assert.equal(tool.function.parameters.properties.count.type, 'integer');
    assert.equal(tool.function.parameters.properties.count.minimum, 1);
    assert.equal(tool.function.parameters.properties.count.maximum, 5);
});

test('native tool response normalizes and parses OpenAI-compatible tool calls', () => {
    const response = createNativeToolResponse([
        {
            id: 'call_1',
            function: {
                name: 'sample',
                arguments: '{"count":2}'
            }
        }
    ], 'mock');

    assert.equal(isNativeToolResponse(response), true);
    assert.equal(response.tool_calls[0].name, 'sample');
    assert.deepEqual(parseToolArguments(response.tool_calls[0].arguments), { count: 2 });
});

test('native tool argument parser recovers a leading JSON object before provider markers', () => {
    const args = '{"count":2,"note":"brace } inside string"}<provider-tool-marker>';

    assert.deepEqual(parseToolArguments(args), {
        count: 2,
        note: 'brace } inside string'
    });
});

test('tool execution adapter coerces args and calls command implementation', async () => {
    const commands = [{
        name: '!sample',
        description: 'Sample command',
        params: {
            count: { type: 'int', description: 'Count', domain: [1, 5] },
            enabled: { type: 'boolean', description: 'Flag' }
        },
        perform: (_agent, count, enabled) => `count=${count}; enabled=${enabled}`
    }];

    const result = await executeCommandToolCall(
        { blocked_actions: [] },
        { name: 'sample', arguments: '{"count":"3","enabled":"true"}' },
        commands
    );

    assert.equal(result.ok, true);
    assert.equal(result.result, 'count=3; enabled=true');
});
