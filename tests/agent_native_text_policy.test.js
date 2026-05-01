import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sanitizeNativeToolHistory } from '../src/models/prompter.js';

test('agent blocks AI text commands in native tool mode without storing the bad response as assistant history', () => {
    const agentSource = readFileSync('src/agent/agent.js', 'utf8');

    assert.ok(agentSource.includes('if (this.prompter.isNativeToolMode())'));
    assert.ok(agentSource.includes('The assistant attempted to write text command ${command_name}, but it was not executed'));
    assert.ok(agentSource.includes('AI actions must use native tool calls'));
    assert.ok(agentSource.includes('continue;'));
    assert.equal(agentSource.includes('this.history.add(this.name, res);\n                    this.history.add(\'system\''), false);
});

test('native tool execution keeps a history marker plus the tool result for continuity', () => {
    const agentSource = readFileSync('src/agent/agent.js', 'utf8');
    const nativeSection = agentSource.slice(agentSource.indexOf('async _executeNativeToolCalls'));

    assert.ok(nativeSection.includes('this.history.add(this.name, display)'));
    assert.ok(nativeSection.includes('Native tool call completed: ${toolCall.name}.'));
    assert.ok(nativeSection.includes('this.history.add(\'system\', execute_res.result)'));
});

test('native prompt history sanitizes legacy tool markers before sending history to the model', () => {
    const sanitized = sanitizeNativeToolHistory([
        { role: 'assistant', content: '*used collectBlocks*' },
        { role: 'system', content: 'Collected 3 oak logs.' },
        { role: 'assistant', content: 'Sure! !craftRecipe("stick", 4)' },
        { role: 'user', content: 'player: thanks' }
    ]);

    assert.deepEqual(sanitized, [
        { role: 'assistant', content: 'Used native tool collectBlocks.' },
        { role: 'system', content: 'Collected 3 oak logs.' },
        { role: 'assistant', content: 'Sure!' },
        { role: 'user', content: 'player: thanks' }
    ]);
});
