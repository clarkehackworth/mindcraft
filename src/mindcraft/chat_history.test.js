// Run: node --test src/mindcraft/chat_history.test.js
// The dashboard pages backwards through chat history by asking for entries
// older than the oldest one it holds. Ids are monotonic and the ring buffer
// drops from the front, so paging must key off ids, not array indices.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Mirrors recordChat + the 'get-history' handler in mindserver.js.
const CHAT_HISTORY_MAX = 500;
function makeLog() {
    const log = [];
    let seq = 0;
    return {
        log,
        record(message) {
            log.push({ id: ++seq, role: 'bot', from: 'Andy', message, ts: 0 });
            if (log.length > CHAT_HISTORY_MAX) log.splice(0, log.length - CHAT_HISTORY_MAX);
        },
        history(before, limit) {
            const n = Math.min(Math.max(1, limit || 50), CHAT_HISTORY_MAX);
            const end = before == null ? log.length : log.findIndex(e => e.id >= before);
            const stop = end < 0 ? log.length : end;
            return { entries: log.slice(Math.max(0, stop - n), stop), more: stop > n };
        },
    };
}

test('the first page is the newest entries and reports more behind it', () => {
    const c = makeLog();
    for (let i = 1; i <= 120; i++) c.record('m' + i);
    const page = c.history(null, 50);
    assert.equal(page.entries.length, 50);
    assert.equal(page.entries[0].message, 'm71');
    assert.equal(page.entries.at(-1).message, 'm120');
    assert.equal(page.more, true);
});

test('paging back walks contiguously and stops with more=false', () => {
    const c = makeLog();
    for (let i = 1; i <= 120; i++) c.record('m' + i);
    let oldest = c.history(null, 50).entries[0];
    const second = c.history(oldest.id, 50);
    assert.equal(second.entries.at(-1).id, oldest.id - 1); // no gap, no repeat
    assert.equal(second.entries[0].message, 'm21');
    assert.equal(second.more, true);

    const third = c.history(second.entries[0].id, 50);
    assert.equal(third.entries.length, 20);
    assert.equal(third.entries[0].message, 'm1');
    assert.equal(third.more, false);
    assert.deepEqual(c.history(third.entries[0].id, 50).entries, []);
});

test('ids survive the ring buffer dropping the front', () => {
    const c = makeLog();
    for (let i = 1; i <= CHAT_HISTORY_MAX + 30; i++) c.record('m' + i);
    assert.equal(c.log.length, CHAT_HISTORY_MAX);
    assert.equal(c.log[0].message, 'm31');
    // An id the browser still holds but the server has since dropped: paging
    // must not fall through to "return the newest page".
    assert.deepEqual(c.history(5, 50).entries, []);
});

// The rest exercises the real module. It reads ./bots relative to the cwd, so
// the test runs it in a throwaway one.
test('history survives a restart and ids keep climbing', async () => {
    const cwd = process.cwd();
    const dir = mkdtempSync(path.join(tmpdir(), 'chat-hist-'));
    process.chdir(dir);
    try {
        mkdirSync('./bots/Andy', { recursive: true });
        writeFileSync('./bots/Andy/chat.jsonl',
            JSON.stringify({ id: 41, role: 'bot', from: 'Andy', message: 'old' }) + '\n' +
            JSON.stringify({ id: 42, role: 'user', from: 'ADMIN', message: 'older still' }) + '\n' +
            '{"id":43,"role":"bot","mess'); // killed mid-append

        const ms = await import('./mindserver.js');
        const loaded = ms.getChatHistory('Andy');
        assert.deepEqual(loaded.map(e => e.id), [41, 42]); // torn line dropped
        assert.equal(loaded[1].message, 'older still');

        const fresh = ms.recordChatForTest('Andy', 'user', 'ADMIN', 'after restart');
        assert.equal(fresh.id, 43); // resumed past the highest id on disk
        assert.equal(ms.getChatHistory('Andy').length, 3);

        const onDisk = readFileSync('./bots/Andy/chat.jsonl', 'utf8').split('\n').filter(Boolean);
        assert.equal(onDisk.length, 4); // the torn line stays, but on its own
        assert.equal(JSON.parse(onDisk.at(-1)).message, 'after restart');

        // Past 2x the cap the file is compacted down to what is held in memory.
        for (let i = 0; i < 1100; i++) ms.recordChatForTest('Andy', 'bot', 'Andy', 'm' + i);
        const compacted = readFileSync('./bots/Andy/chat.jsonl', 'utf8').split('\n').filter(Boolean);
        assert.ok(compacted.length <= 1000, `file kept growing: ${compacted.length}`);
        assert.equal(ms.getChatHistory('Andy').length, 500);
        assert.equal(JSON.parse(compacted.at(-1)).message, 'm1099');
    } finally {
        process.chdir(cwd);
    }
});
