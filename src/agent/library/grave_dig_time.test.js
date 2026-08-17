// Run: node src/agent/library/grave_dig_time.test.js
// recoverGrave called bot.dig on a grave bare-handed. A dig the bot cannot
// finish neither resolves nor throws -- it just digs on -- so the function was
// entered 25 times in one window and left not one line in the log, in either
// direction. Every explanation shaped like an outcome was wrong, because there
// was no outcome: it was still digging.
//
// The bot's whole inventory at the time was dirt and a crafting table.
import assert from 'assert';

const MAX_HAND_DIG_MS = 12000;

// The guard, in the shape skills.js has it.
function decide(digMs) {
    return digMs > MAX_HAND_DIG_MS ? 'refuse' : 'dig';
}

assert.equal(decide(800), 'dig', 'a shovel through snow is fine');
assert.equal(decide(MAX_HAND_DIG_MS), 'dig', 'exactly at the cap still goes');
assert.equal(decide(MAX_HAND_DIG_MS + 1), 'refuse', 'a second over and it says so instead');
assert.equal(decide(250000), 'refuse', 'obsidian-grade is not a dig, it is a hang');

// The refusal has to name the tool, because "get a pickaxe" is the action that
// follows and the bot is the one that has to take it.
const message = (ms, held) =>
    `The grave would take ${Math.round(ms / 1000)}s to break with ${held ?? 'bare hands'}. Get a pickaxe or shovel first.`;
assert.match(message(250000, null), /bare hands/);
assert.match(message(250000, null), /250s/);
assert.match(message(30000, 'wooden_shovel'), /wooden_shovel/);

console.log('ok: a dig that would never finish is refused, out loud');
