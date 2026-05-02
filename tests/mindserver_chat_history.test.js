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

test('saved chat history merges all session traces instead of only the latest file', () => withTempProject((dir) => {
    const botDir = path.join(dir, 'bots', 'tracebot');
    const traceDir = path.join(botDir, 'chat-history');
    mkdirSync(traceDir, { recursive: true });
    writeFileSync(path.join(traceDir, '2026-05-02T00-00-00-000Z.jsonl'), [
        JSON.stringify({ timestamp: '2026-05-02T00:00:00.000Z', agent: 'tracebot', type: 'llm_request', messages: [{ role: 'user', content: 'first' }] }),
        JSON.stringify({ timestamp: '2026-05-02T00:00:01.000Z', agent: 'tracebot', type: 'llm_response', response: 'one' })
    ].join('\n') + '\n');
    writeFileSync(path.join(traceDir, '2026-05-02T00-01-00-000Z.jsonl'), [
        JSON.stringify({ timestamp: '2026-05-02T00:01:00.000Z', agent: 'tracebot', type: 'llm_request', messages: [{ role: 'user', content: 'second' }] }),
        JSON.stringify({ timestamp: '2026-05-02T00:01:01.000Z', agent: 'tracebot', type: 'llm_response', response: 'two' })
    ].join('\n') + '\n');
    writeFileSync(path.join(botDir, 'memory.json'), JSON.stringify({
        chat_history_trace: './bots/tracebot/chat-history/2026-05-02T00-01-00-000Z.jsonl'
    }));

    const result = readSavedChatHistory('tracebot', { loadMemory: true, cwd: dir });

    assert.equal(result.loaded, true);
    assert.equal(result.events.length, 4);
    assert.equal(result.events[0].messages[0].content, 'first');
    assert.equal(result.events[2].messages[0].content, 'second');
    assert.equal(result.sources.length, 2);
}));

test('saved chat history expands compact archive turns when full trace is not otherwise present', () => withTempProject((dir) => {
    const botDir = path.join(dir, 'bots', 'tracebot');
    const traceDir = path.join(botDir, 'chat-history');
    const archiveDir = path.join(botDir, 'histories');
    mkdirSync(traceDir, { recursive: true });
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, 'archive.json');
    writeFileSync(archivePath, JSON.stringify([
        { role: 'user', content: 'Steve: archived question' },
        { role: 'assistant', content: 'archived answer' }
    ]));
    writeFileSync(path.join(traceDir, 'session.jsonl'), [
        JSON.stringify({
            timestamp: '2026-05-02T00:02:00.000Z',
            agent: 'tracebot',
            type: 'history_compacted',
            summary: 'short summary',
            full_history_file: archivePath
        }),
        JSON.stringify({
            timestamp: '2026-05-02T00:02:01.000Z',
            agent: 'tracebot',
            type: 'llm_request',
            messages: [{ role: 'user', content: 'after compact' }]
        })
    ].join('\n') + '\n');

    const result = readSavedChatHistory('tracebot', { loadMemory: true, cwd: dir });

    assert.equal(result.loaded, true);
    assert.equal(result.events[0].restored_from_archive, true);
    assert.equal(result.events[0].turn.content, 'Steve: archived question');
    assert.equal(result.events[1].turn.content, 'archived answer');
    assert.equal(result.events[2].type, 'history_compacted');
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
