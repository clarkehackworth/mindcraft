// Run: node src/utils/uptime.test.js
import assert from 'assert';
import { formatDuration } from './text.js';

assert.equal(formatDuration(0), '0s');
assert.equal(formatDuration(45_000), '45s');
assert.equal(formatDuration(59_999), '59s');
assert.equal(formatDuration(60_000), '1m');
assert.equal(formatDuration(90_000), '1m');       // seconds are noise past a minute
assert.equal(formatDuration(59 * 60_000), '59m');
assert.equal(formatDuration(60 * 60_000), '1h 0m'); // not "1h", so the shape is stable
assert.equal(formatDuration(72 * 60_000), '1h 12m');
assert.equal(formatDuration(25 * 60 * 60_000), '25h 0m'); // no days rollover, hours keep counting

// The agent reports elapsed ms, not a timestamp, so the mindserver can rebase it
// onto its own clock. Null (no death on record) means "alive since login".
const rebase = (now, alive_ms) => alive_ms == null ? now : now - alive_ms;
assert.equal(rebase(1_000_000, null), 1_000_000);
assert.equal(rebase(1_000_000, 60_000), 940_000);
assert.equal(formatDuration(1_000_000 - rebase(1_000_000, 60_000)), '1m');

console.log('ok: uptime formatting');
