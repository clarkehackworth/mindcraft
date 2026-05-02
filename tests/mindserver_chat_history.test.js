import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSavedChatHistory } from '../src/mindcraft/mindserver.js';

function withTempProject(fn) {
    const dir = mkdtempSync(path.join(tmpdir(), 'mindcraft-chat-history-'));
    try {
        return fn(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test('saved chat history loads from memory trace when load_memory is true', () => withTempProject((dir) => {
    const botDir = path.join(dir, 'bots', 'tracebot');
    const traceDir = path.join(botDir, 'chat-history');
    mkdirSync(traceDir, { recursive: true });
    const tracePath = path.join(traceDir, 'session.jsonl');
    writeFileSync(tracePath, [
        JSON.stringify({ timestamp: '2026-05-02T00:00:00.000Z', agent: 'tracebot', type: 'llm_request', messages: [] }),
        JSON.stringify({ timestamp: '2026-05-02T00:00:01.000Z', agent: 'tracebot', type: 'llm_response', response: { content: 'ok' } })
    ].join('\n') + '\n');
    writeFileSync(path.join(botDir, 'memory.json'), JSON.stringify({
        chat_history_trace: './bots/tracebot/chat-history/session.jsonl',
        chat_history_latest: './bots/tracebot/chat_history.jsonl'
    }));

    const result = readSavedChatHistory('tracebot', { loadMemory: true, cwd: dir });

    assert.equal(result.loaded, true);
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0].type, 'llm_request');
    assert.equal(result.events[1].response.content, 'ok');
}));

test('saved chat history is intentionally skipped when load_memory is false', () => withTempProject((dir) => {
    const botDir = path.join(dir, 'bots', 'tracebot');
    mkdirSync(botDir, { recursive: true });
    writeFileSync(path.join(botDir, 'chat_history.jsonl'), JSON.stringify({ type: 'llm_request' }) + '\n');

    const result = readSavedChatHistory('tracebot', { loadMemory: false, cwd: dir });

    assert.equal(result.loaded, false);
    assert.equal(result.reason, 'load_memory_disabled');
    assert.deepEqual(result.events, []);
}));

test('saved chat history rejects unsafe agent names', () => withTempProject((dir) => {
    const result = readSavedChatHistory('../tracebot', { loadMemory: true, cwd: dir });

    assert.equal(result.loaded, false);
    assert.equal(result.reason, 'invalid_agent_name');
    assert.deepEqual(result.events, []);
}));

test('saved chat history falls back to memory turns when no trace file exists', () => withTempProject((dir) => {
    const botDir = path.join(dir, 'bots', 'tracebot');
    mkdirSync(botDir, { recursive: true });
    writeFileSync(path.join(botDir, 'memory.json'), JSON.stringify({
        turns: [
            { role: 'user', content: 'Steve: hello' },
            { role: 'assistant', content: 'Hi Steve.' }
        ]
    }));

    const result = readSavedChatHistory('tracebot', { loadMemory: true, cwd: dir });

    assert.equal(result.loaded, true);
    assert.equal(result.restored_from_memory, true);
    assert.equal(result.source, path.join(botDir, 'memory.json'));
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0].type, 'history_turn_added');
    assert.equal(result.events[0].turn.content, 'Steve: hello');
}));
