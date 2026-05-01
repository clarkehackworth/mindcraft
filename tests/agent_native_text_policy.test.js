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
