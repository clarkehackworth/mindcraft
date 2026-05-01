import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sanitizeNativeToolExamples } from '../src/models/prompter.js';

const legacyToolSyntax = /(^|\s)![A-Za-z_][A-Za-z0-9_]*\b|\*used\s+[A-Za-z_][A-Za-z0-9_]*\*/i;

test('default native conversation examples do not teach legacy text tool syntax', () => {
    const profile = JSON.parse(readFileSync('profiles/defaults/_default.json', 'utf8'));
    const legacyTurns = profile.conversation_examples
        .flat()
        .filter(turn => legacyToolSyntax.test(turn.content || ''));

    assert.deepEqual(legacyTurns, []);
});

test('native prompt markdown rejects text-command and fake tool-call examples', () => {
    const conversing = readFileSync('profiles/defaults/prompts/_default/conversing.md', 'utf8');
    const botResponder = readFileSync('profiles/defaults/prompts/_default/bot_responder.md', 'utf8');

    assert.match(conversing, /native tool\/function/i);
    assert.match(conversing, /Do NOT write command text/i);
    assert.match(conversing, /\*used collectBlocks\*/);
    assert.doesNotMatch(botResponder, legacyToolSyntax);
});

test('native example sanitizer drops any profile examples with legacy tool syntax', () => {
    const examples = [
        [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }],
        [{ role: 'user', content: 'collect wood' }, { role: 'assistant', content: '!collectBlocks("oak_log", 3)' }],
        [{ role: 'assistant', content: '*used craftRecipe*' }]
    ];

    assert.deepEqual(sanitizeNativeToolExamples(examples), [examples[0]]);
});
