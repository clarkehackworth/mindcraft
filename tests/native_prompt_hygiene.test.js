import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { stripVolatileConversationPlaceholders } from '../src/models/prompter.js';

const legacyToolSyntax = /(^|\s)![A-Za-z_][A-Za-z0-9_]*\b|\*used\s+[A-Za-z_][A-Za-z0-9_]*\*/i;

function readPromptRef(value) {
    if (typeof value === 'string') return value;
    if (value?.prompt_file) return readFileSync(value.prompt_file, 'utf8');
    return '';
}

test('default native conversation examples are fixed in markdown instead of JSON', () => {
    const profile = JSON.parse(readFileSync('profiles/defaults/_default.json', 'utf8'));
    const conversing = readFileSync('profiles/defaults/prompts/conversing.md', 'utf8');

    assert.equal('conversation_examples' in profile, false);
    assert.match(conversing, /Fixed examples of how to respond:/);
    assert.match(conversing, /miner_32: Hey! What are you up to\?/);
    assert.match(conversing, /rupert: Let us work together on a small house\./);
});

test('default coding examples are fixed in markdown instead of JSON', () => {
    const profile = JSON.parse(readFileSync('profiles/defaults/_default.json', 'utf8'));
    const coding = readFileSync('profiles/defaults/prompts/coding.md', 'utf8');

    assert.equal('coding_examples' in profile, false);
    assert.match(coding, /Fixed coding examples:/);
    assert.match(coding, /greg: Collect 10 wood/);
    assert.match(coding, /brug: build a dirt house/);
});

test('native prompt markdown rejects text-command and fake tool-call examples in conversation prompt', () => {
    const conversing = readFileSync('profiles/defaults/prompts/conversing.md', 'utf8');
    const botResponder = readFileSync('profiles/defaults/prompts/bot_responder.md', 'utf8');

    assert.match(conversing, /native tools\/function calls/i);
    assert.match(conversing, /Do NOT write legacy text commands/i);
    assert.doesNotMatch(conversing, legacyToolSyntax);
    assert.doesNotMatch(botResponder, legacyToolSyntax);
});


test('conversation system prompt no longer uses dynamic example or command-doc placeholders', () => {
    const conversing = readFileSync('profiles/defaults/prompts/conversing.md', 'utf8');
    const stable = stripVolatileConversationPlaceholders(conversing);

    assert.doesNotMatch(stable, /\$SELF_PROMPT/);
    assert.doesNotMatch(stable, /\$MEMORY/);
    assert.doesNotMatch(stable, /\$STATS/);
    assert.doesNotMatch(stable, /\$INVENTORY/);
    assert.doesNotMatch(stable, /\$COMMAND_DOCS/);
    assert.doesNotMatch(stable, /stale prompt text/i);
});

test('conversation prompt sanitizer strips legacy dynamic context placeholders from task profiles', () => {
    const construction = JSON.parse(readFileSync('profiles/tasks/construction_profile.json', 'utf8'));
    const stable = stripVolatileConversationPlaceholders(readPromptRef(construction.conversing));

    assert.doesNotMatch(stable, /\$SELF_PROMPT/);
    assert.doesNotMatch(stable, /\$MEMORY/);
    assert.doesNotMatch(stable, /\$STATS/);
    assert.doesNotMatch(stable, /\$INVENTORY/);
    assert.doesNotMatch(stable, /\$COMMAND_DOCS/);
    assert.doesNotMatch(stable, /\$EXAMPLES/);
});

test('task profile conversation prompts are native-tool cache-safe', () => {
    const taskDir = 'profiles/tasks';
    const volatile = /\$(SELF_PROMPT|MEMORY|STATS|INVENTORY|COMMAND_DOCS|EXAMPLES)/;

    for (const file of readdirSync(taskDir).filter(name => name.endsWith('.json'))) {
        const profile = JSON.parse(readFileSync(path.join(taskDir, file), 'utf8'));
        if (!profile.conversing) continue;
        const conversing = readPromptRef(profile.conversing);

        assert.equal(profile.conversing.prompt_file, path.join(taskDir, file.replace(/_profile\.json$/, '_prompt.md')));
        assert.doesNotMatch(conversing, volatile, `${file} should not inject dynamic conversation context`);
        assert.doesNotMatch(conversing, legacyToolSyntax, `${file} should not include legacy command examples`);
        assert.match(conversing, /native tools\/function calls/i, `${file} should describe native tools`);
        assert.equal('saving_memory' in profile, false, `${file} should inherit the shared compact prompt`);
    }
});

test('conversation request messages do not append runtime context', async () => {
    const { Prompter } = await import('../src/models/prompter.js');
    const messages = [{ role: 'user', content: 'Steve: what now?' }];
    const result = await Prompter.prototype.buildConversationMessages.call({}, messages);

    assert.equal(result, messages);
    assert.equal(result.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /SYSTEM CONTEXT FOR THE PREVIOUS USER MESSAGE|CURRENT WORLD STATE|CURRENT INVENTORY|SUMMARIZED MEMORY/);
});
