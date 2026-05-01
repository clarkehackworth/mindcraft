#!/usr/bin/env node
import assert from 'node:assert/strict';
import { commandToToolDefinition, executeCommandToolCall } from '../../src/agent/commands/tool_adapter.js';
import { createNativeToolResponse, isNativeToolResponse } from '../../src/models/native_tools.js';

const mockCommand = {
    name: '!reportStatus',
    description: 'Report mock tool-loop status.',
    params: {
        status: { type: 'string', description: 'Status text.' }
    },
    perform: async (_agent, status) => `mock status: ${status}`
};

const mockModel = {
    supportsNativeToolCalls: true,
    async sendRequest(_turns, _systemMessage, _stopSeq, tools) {
        assert.equal(tools.length, 1);
        assert.equal(tools[0].function.name, 'reportStatus');
        return createNativeToolResponse([
            {
                id: 'mock_call_1',
                function: {
                    name: 'reportStatus',
                    arguments: JSON.stringify({ status: 'ok' })
                }
            }
        ], 'mock');
    }
};

const tools = [commandToToolDefinition(mockCommand)];
const toolResponse = await mockModel.sendRequest(
    [{ role: 'user', content: 'run mock status report' }],
    'Use native tools.',
    '***',
    tools
);

assert.equal(isNativeToolResponse(toolResponse), true);
const result = await executeCommandToolCall({ blocked_actions: [] }, toolResponse.tool_calls[0], [mockCommand]);
assert.equal(result.ok, true);
assert.equal(result.result, 'mock status: ok');

console.log('Dev native tool-loop passed without Minecraft.');
