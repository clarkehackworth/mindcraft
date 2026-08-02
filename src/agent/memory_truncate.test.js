// Run: node src/agent/memory_truncate.test.js
// A hard slice(0, 500) cut Andy's memory mid-word. He reloaded "...Stuck on
// snow; going undergro" and one summary ended "must prioritize getting
// out...(Memory". The tail is the most recent thing that happened to him,
// which is exactly the part worth keeping intact.
import assert from 'assert';
import { truncateMemory } from './history.js';

const short = 'Died 3x to zombies. No bed yet.';
assert.equal(truncateMemory(short, 500), short, 'a short memory is returned untouched');
assert.equal(truncateMemory('', 500), '', 'empty is fine');
assert.equal(truncateMemory(undefined, 500), undefined, 'undefined is fine');

// Cut on a sentence boundary when there is one.
const sentences = 'Died 18x to zombies. Snow blocks the path north. ' + 'Pine planks work for tools. '.repeat(30);
const cut = truncateMemory(sentences, 200);
assert.ok(cut.length < sentences.length, 'a long memory is shortened');
assert.match(cut, /truncated at 200 chars/, 'it says it was truncated');
const body = cut.slice(0, cut.indexOf(' ...(truncated'));
assert.ok(/[.;!]$/.test(body), `it ends on a sentence, not mid-word: ${JSON.stringify(body.slice(-40))}`);
assert.ok(sentences.startsWith(body), 'and the kept text is a real prefix of the original');

// No sentence break in range: fall back to a word boundary rather than
// slicing through a word.
const runOn = 'wordy '.repeat(200);
const wordCut = truncateMemory(runOn, 100);
const wordBody = wordCut.slice(0, wordCut.indexOf(' ...(truncated'));
assert.ok(!wordBody.endsWith('wor') && !wordBody.endsWith('word'), 'does not split a word');
assert.ok(runOn.startsWith(wordBody), 'still a real prefix');

// A single unbroken token has no good cut point; take the hard limit rather
// than returning nothing.
const blob = 'x'.repeat(400);
const blobCut = truncateMemory(blob, 100);
assert.ok(blobCut.startsWith('x'.repeat(100)), 'an unbreakable blob is cut at the limit');

console.log('ok: memory is truncated on a boundary, not through a word');
process.exit(0);
