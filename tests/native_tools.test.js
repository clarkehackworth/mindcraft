import test from 'node:test';
import assert from 'node:assert/strict';
import {
    commandToToolDefinition,
    getCommandToolDefinitions,
    executeCommandToolCall
} from '../src/agent/commands/tool_adapter.js';
import {
    createNativeToolResponse,
    isNativeToolResponse,
    parseToolArguments
} from '../src/models/native_tools.js';
import * as nativeTools from '../src/models/native_tools.js';
import { containsCommand, parseCommandMessage } from '../src/agent/commands/index.js';
import { normalizeGeminiHttpOptions } from '../src/models/google_generative_ai.js';

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

test('native command tool schemas are stable across repeated builds', () => {
    const agent = { blocked_actions: ['!stop', '!stats'] };
    const first = getCommandToolDefinitions(agent);
    const firstJson = JSON.stringify(first);

    for (let i = 0; i < 5; i++) {
        assert.equal(JSON.stringify(getCommandToolDefinitions(agent)), firstJson);
    }

    assert.deepEqual(
        getCommandToolDefinitions({ blocked_actions: ['!stats', '!stop'] }),
        first,
        'blocked action input order must not affect schema order or content'
    );
});

test('blocked native tools preserve source command order as a subsequence', () => {
    const allTools = getCommandToolDefinitions({ blocked_actions: [] });
    const blocked = new Set(['!stats', '!inventory', '!nearbyBlocks']);
    const filteredTools = getCommandToolDefinitions({ blocked_actions: Array.from(blocked) });

    const allNames = allTools.map(tool => tool.function.name);
    const filteredNames = filteredTools.map(tool => tool.function.name);
    const expectedNames = allNames.filter(name => !blocked.has(`!${name}`));

    assert.deepEqual(filteredNames, expectedNames);
});

test('craftRecipe tool asks for output item count', () => {
    const craftTool = getCommandToolDefinitions({ blocked_actions: [] })
        .find(tool => tool.function.name === 'craftRecipe');

    assert.ok(craftTool);
    assert.match(craftTool.function.description, /output items/i);
    assert.match(craftTool.function.parameters.properties.num.description, /output items/i);
    assert.doesNotMatch(craftTool.function.parameters.properties.num.description, /NOT the number of output items/);
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

test('native tool turns serialize to protocol-specific tool result fields', () => {
    const call = {
        id: 'call_1',
        type: 'function',
        name: 'sample',
        arguments: '{"count":2}'
    };
    const turns = [
        { role: 'user', content: 'do it' },
        { role: 'assistant', content: '*used sample*', native_tool_calls: [call] },
        { role: 'tool', tool_call_id: 'call_1', name: 'sample', content: 'count=2' }
    ];

    const openAI = nativeTools.toOpenAIChatMessages(turns, 'system prompt');
    assert.equal(openAI[0].role, 'system');
    assert.deepEqual(openAI[2].tool_calls[0].function, { name: 'sample', arguments: '{"count":2}' });
    assert.equal(openAI[3].role, 'tool');
    assert.equal(openAI[3].tool_call_id, 'call_1');

    const responses = nativeTools.toResponsesInputItems(turns);
    assert.equal(responses[1].type, 'function_call');
    assert.equal(Object.prototype.hasOwnProperty.call(responses[1], 'id'), false);
    assert.equal(responses[2].type, 'function_call_output');
    assert.equal(responses[2].call_id, 'call_1');

    const anthropic = nativeTools.toAnthropicMessages(turns);
    assert.equal(anthropic[1].content[0].type, 'text');
    assert.equal(anthropic[1].content[1].type, 'tool_use');
    assert.equal(anthropic[2].content[0].type, 'tool_result');

    const gemini = nativeTools.toGeminiContents(turns);
    assert.equal(gemini[1].parts[1].functionCall.name, 'sample');
    assert.equal(gemini[2].parts[0].functionResponse.name, 'sample');
});

test('OpenAI chat serialization preserves provider reasoning content for tool-call replay', () => {
    const call = {
        id: 'call_1',
        type: 'function',
        name: 'sample',
        arguments: '{"count":2}'
    };
    const turns = [
        { role: 'assistant', content: '', native_tool_calls: [call], thinking: 'call reasoning', thinking_key: 'reasoning_content' },
        { role: 'tool', tool_call_id: 'call_1', name: 'sample', content: 'count=2' },
        { role: 'assistant', content: 'done' }
    ];

    const messages = nativeTools.toOpenAIChatMessages(turns, 'system prompt', {
        reasoningKey: 'reasoning_content',
        requireReasoningContent: true
    });

    assert.equal(messages[1].reasoning_content, 'call reasoning');
    assert.equal(messages[3].reasoning_content, '');
});

test('Anthropic and Gemini serialization can replay captured thinking blocks', () => {
    const turns = [{
        role: 'assistant',
        content: 'I will act.',
        thinking_blocks: [{ type: 'thinking', thinking: 'signed reasoning', signature: 'sig-1' }]
    }];

    const anthropic = nativeTools.toAnthropicMessages(turns);
    assert.equal(anthropic[1].content[0].type, 'thinking');
    assert.equal(anthropic[1].content[0].thinking, 'signed reasoning');
    assert.equal(anthropic[1].content[0].signature, 'sig-1');

    const gemini = nativeTools.toGeminiContents(turns);
    assert.equal(gemini[0].parts[0].thought, true);
    assert.equal(gemini[0].parts[0].text, 'signed reasoning');
});

test('multimodal message content keeps protocol-specific image payloads', () => {
    const imageUrl = 'data:image/jpeg;base64,abc123';
    const turns = [{
        role: 'user',
        content: [
            { type: 'text', text: 'describe this' },
            { type: 'image_url', image_url: { url: imageUrl } }
        ]
    }];

    const openAI = nativeTools.toOpenAIChatMessages(turns);
    assert.deepEqual(openAI[0].content, turns[0].content);

    const responses = nativeTools.toResponsesInputItems(turns);
    assert.deepEqual(responses[0].content, [
        { type: 'input_text', text: 'describe this' },
        { type: 'input_image', image_url: imageUrl }
    ]);

    const anthropicTurns = [{
        role: 'user',
        content: [
            { type: 'text', text: 'describe this' },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'abc123' } }
        ]
    }];
    const anthropic = nativeTools.toAnthropicMessages(anthropicTurns);
    assert.deepEqual(anthropic[0].content, anthropicTurns[0].content);
});

test('Responses multimodal content converts back to Chat Completions shape', () => {
    const imageUrl = 'data:image/jpeg;base64,abc123';
    const turns = [{
        role: 'user',
        content: [
            { type: 'input_text', text: 'describe this' },
            { type: 'input_image', image_url: imageUrl }
        ]
    }];

    const openAI = nativeTools.toOpenAIChatMessages(turns);
    assert.deepEqual(openAI[0].content, [
        { type: 'text', text: 'describe this' },
        { type: 'image_url', image_url: { url: imageUrl } }
    ]);
});

test('history system turns are downgraded to user messages for provider protocols', () => {
    const turns = [
        { role: 'system', content: 'runtime state changed' },
        { role: 'user', content: 'hello' }
    ];

    const openAI = nativeTools.toOpenAIChatMessages(turns, 'stable system prompt');
    assert.equal(openAI.filter(message => message.role === 'system').length, 1);
    assert.equal(openAI[0].content, 'stable system prompt');
    assert.equal(openAI[1].role, 'user');
    assert.match(openAI[1].content, /^SYSTEM: runtime state changed/);

    const responses = nativeTools.toResponsesInputItems(turns);
    assert.equal(responses[0].role, 'user');
    assert.match(responses[0].content[0].text, /^SYSTEM: runtime state changed/);

    const anthropic = nativeTools.toAnthropicMessages(turns);
    assert.ok(anthropic.every(message => message.role !== 'system'));
    assert.equal(anthropic[0].role, 'user');
    assert.match(anthropic[0].content, /^SYSTEM: runtime state changed/);

    const gemini = nativeTools.toGeminiContents(turns);
    assert.ok(gemini.every(content => content.role !== 'system'));
    assert.equal(gemini[0].role, 'user');
    assert.match(gemini[0].parts[0].text, /^SYSTEM: runtime state changed/);
});

test('native tool turn repair drops orphan results and can synthesize missing results', () => {
    const call = {
        id: 'call_1',
        type: 'function',
        name: 'sample',
        arguments: '{}'
    };
    const turns = [
        { role: 'tool', tool_call_id: 'orphan', name: 'sample', content: 'old orphan' },
        { role: 'assistant', content: '', native_tool_calls: [call] },
        { role: 'user', content: 'next prompt' }
    ];

    const openAI = nativeTools.toOpenAIChatMessages(turns);
    assert.equal(openAI.some(message => message.role === 'tool' && message.tool_call_id === 'orphan'), false);

    const anthropic = nativeTools.toAnthropicMessages(turns);
    assert.equal(anthropic[1].content[0].type, 'tool_use');
    assert.equal(anthropic[2].content[0].type, 'tool_result');
    assert.equal(anthropic[2].content[0].tool_use_id, 'call_1');
});

test('multi-turn native tool replay remains deterministic across protocols', () => {
    const firstCall = { id: 'call_1', type: 'function', name: 'inventory', arguments: '{}' };
    const secondCall = { id: 'call_2', type: 'function', name: 'collectBlocks', arguments: '{"block":"oak_log","count":2}' };
    const turns = [
        { role: 'user', content: 'what do you have?' },
        { role: 'assistant', content: '*used inventory*', native_tool_calls: [firstCall] },
        { role: 'tool', tool_call_id: 'call_1', name: 'inventory', content: '{"oak_log":0}' },
        { role: 'assistant', content: 'I need wood.' },
        { role: 'user', content: 'collect two logs' },
        { role: 'assistant', content: '*used collectBlocks*', native_tool_calls: [secondCall] },
        { role: 'tool', tool_call_id: 'call_2', name: 'collectBlocks', content: 'Collected 2 oak logs.' },
        { role: 'assistant', content: 'Done.' }
    ];

    const openAIFirst = nativeTools.toOpenAIChatMessages(turns, 'system prompt');
    const openAISecond = nativeTools.toOpenAIChatMessages(turns, 'system prompt');
    assert.deepEqual(openAISecond, openAIFirst);
    assert.equal(openAIFirst.filter(message => message.role === 'tool').length, 2);
    assert.deepEqual(
        openAIFirst.filter(message => message.tool_call_id).map(message => message.tool_call_id),
        ['call_1', 'call_2']
    );

    const responsesFirst = nativeTools.toResponsesInputItems(turns);
    const responsesSecond = nativeTools.toResponsesInputItems(turns);
    assert.deepEqual(responsesSecond, responsesFirst);
    assert.deepEqual(
        responsesFirst.filter(item => item.type === 'function_call' || item.type === 'function_call_output').map(item => item.call_id),
        ['call_1', 'call_1', 'call_2', 'call_2']
    );

    const anthropicFirst = nativeTools.toAnthropicMessages(turns);
    const anthropicSecond = nativeTools.toAnthropicMessages(turns);
    assert.deepEqual(anthropicSecond, anthropicFirst);
    assert.equal(JSON.stringify(anthropicFirst).includes('"tool_use"'), true);
    assert.equal(JSON.stringify(anthropicFirst).includes('"tool_result"'), true);

    const geminiFirst = nativeTools.toGeminiContents(turns);
    const geminiSecond = nativeTools.toGeminiContents(turns);
    assert.deepEqual(geminiSecond, geminiFirst);
    assert.equal(JSON.stringify(geminiFirst).includes('"functionCall"'), true);
    assert.equal(JSON.stringify(geminiFirst).includes('"functionResponse"'), true);
});

test('Gemini relay URL normalization keeps only the API root in baseUrl', () => {
    assert.deepEqual(
        normalizeGeminiHttpOptions(
            'https://mydamoxing.cn/v1beta/models/gemini-3.1-pro-preview:generateContent',
            {}
        ).httpOptions,
        {
            baseUrl: 'https://mydamoxing.cn',
            apiVersion: 'v1beta'
        }
    );

    assert.deepEqual(
        normalizeGeminiHttpOptions('https://mydamoxing.cn', { apiVersion: 'v1beta' }).httpOptions,
        {
            baseUrl: 'https://mydamoxing.cn',
            apiVersion: 'v1beta'
        }
    );
});

test('repair inserts missing result before the next assistant tool call', () => {
    const turns = [
        { role: 'assistant', content: '', native_tool_calls: [{ id: 'call_1', type: 'function', name: 'inventory', arguments: '{}' }] },
        { role: 'assistant', content: '', native_tool_calls: [{ id: 'call_2', type: 'function', name: 'collectBlocks', arguments: '{}' }] },
        { role: 'tool', tool_call_id: 'call_2', name: 'collectBlocks', content: 'ok' }
    ];

    const repaired = nativeTools.repairNativeToolTurns(turns, { synthesizeMissingResults: true });
    assert.deepEqual(repaired.map(turn => turn.role), ['assistant', 'tool', 'assistant', 'tool']);
    assert.equal(repaired[1].tool_call_id, 'call_1');
    assert.equal(repaired[3].tool_call_id, 'call_2');
});
