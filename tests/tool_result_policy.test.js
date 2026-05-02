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

test('uninterruptible actions still restart as a last-resort fallback', () => {
    const actionManagerSource = readFileSync('src/agent/action_manager.js', 'utf8');
    const actionsSource = readFileSync('src/agent/commands/actions.js', 'utf8');

    assert.ok(actionManagerSource.includes('Code execution refused stop after ${timeoutMs}ms. Killing process.'));
    assert.ok(actionManagerSource.includes('this.agent.cleanKill'));
    assert.equal(actionManagerSource.includes('could not start'), false);
    assert.equal(actionManagerSource.includes('leaving current action running'), false);
    assert.equal(actionsSource.includes('The agent process was kept alive.'), false);
    assert.ok(actionsSource.includes('code_return.message'));
    assert.ok(actionsSource.includes('newAction did not produce code or a tool result.'));
});


test('collect block actions can resolve gracefully on interrupt', () => {
    const skillsSource = readFileSync('src/agent/library/skills.js', 'utf8');
    const agentSource = readFileSync('src/agent/agent.js', 'utf8');

    assert.ok(agentSource.includes("this.bot.emit('mindcraft_interrupt')"));
    assert.ok(agentSource.includes('this.collectBlockCancelPromise'));
    assert.ok(skillsSource.includes('waitForInterruptOrResult(bot, bot.collectBlock.collect(block)'));
    assert.ok(skillsSource.includes("bot.once('mindcraft_interrupt', interrupt)"));
});



test('place block failures include the underlying action error', () => {
    const skillsSource = readFileSync('src/agent/library/skills.js', 'utf8');

    assert.ok(skillsSource.includes('const MAX_ACTION_ERROR_LENGTH = 300;'));
    assert.ok(skillsSource.includes('function formatActionError'));
    assert.ok(skillsSource.includes('text.slice(0, MAX_ACTION_ERROR_LENGTH)'));
    assert.ok(skillsSource.includes('Failed to place ${blockType} at ${target_dest}: ${formatActionError(err)}.'));
});

test('torch placing mode does not interrupt active self prompting or actions', () => {
    const modesSource = readFileSync('src/agent/modes.js', 'utf8');
    const torchSection = modesSource.slice(modesSource.indexOf("name: 'torch_placing'"), modesSource.indexOf("name: 'elbow_room'"));

    assert.ok(torchSection.includes('!agent.isIdle()'));
    assert.ok(torchSection.includes('agent.self_prompter.isActive()'));
    assert.ok(torchSection.includes('this.active'));
});

test('conversation action reports status through tool result instead of system history', () => {
    const actionsSource = readFileSync('src/agent/commands/actions.js', 'utf8');
    const startConversationSection = actionsSource.slice(actionsSource.indexOf("name: '!startConversation'"));

    assert.ok(startConversationSection.includes('Conversation with ${player_name} started.'));
    assert.equal(startConversationSection.includes("agent.history.add('system'"), false);
});
