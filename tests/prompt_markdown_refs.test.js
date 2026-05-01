import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const defaultsDir = path.resolve('profiles/defaults');
const promptKeys = ['conversing', 'coding', 'saving_memory', 'bot_responder', 'image_analysis'];

test('default profile keeps editable prompt text in markdown files', () => {
    const profile = JSON.parse(readFileSync(path.join(defaultsDir, '_default.json'), 'utf8'));
    for (const key of promptKeys) {
        assert.equal(typeof profile[key], 'object', `${key} should be a prompt reference object`);
        assert.equal(typeof profile[key].prompt_file, 'string', `${key} should reference a markdown file`);
        assert.match(profile[key].prompt_file, /\.md$/);
        const markdown = readFileSync(path.join(defaultsDir, profile[key].prompt_file), 'utf8');
        assert.ok(markdown.trim().length > 0, `${key} markdown should not be empty`);
    }
});
