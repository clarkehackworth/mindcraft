import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('action tools provide explicit LLM-visible results even when game output is empty', () => {
    const actionManagerSource = readFileSync('src/agent/action_manager.js', 'utf8');
    const actionsSource = readFileSync('src/agent/commands/actions.js', 'utf8');

    assert.ok(actionManagerSource.includes('Action completed with no additional output.'));
    assert.ok(actionsSource.includes('Action interrupted before completion.'));
    assert.ok(actionsSource.includes('Action completed.'));
});

test('stuck action interruption reports busy state instead of killing the process', () => {
    const actionManagerSource = readFileSync('src/agent/action_manager.js', 'utf8');
    const actionsSource = readFileSync('src/agent/commands/actions.js', 'utf8');

    assert.equal(actionManagerSource.includes('Code execution refused stop after 10 seconds. Killing process.'), false);
    assert.ok(actionManagerSource.includes('could not start'));
    assert.ok(actionManagerSource.includes('leaving current action running'));
    assert.ok(actionsSource.includes('The agent process was kept alive.'));
    assert.ok(actionsSource.includes('code_return.message'));
    assert.ok(actionsSource.includes('newAction did not produce code or a tool result.'));
});

test('conversation action reports status through tool result instead of system history', () => {
    const actionsSource = readFileSync('src/agent/commands/actions.js', 'utf8');
    const startConversationSection = actionsSource.slice(actionsSource.indexOf("name: '!startConversation'"));

    assert.ok(startConversationSection.includes('Conversation with ${player_name} started.'));
    assert.equal(startConversationSection.includes("agent.history.add('system'"), false);
});
