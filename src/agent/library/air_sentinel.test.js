// Run: node src/agent/library/air_sentinel.test.js
// Andy stood at -8,77,3 -- dry land, air above his head, isInWater false --
// jumping straight up for 20 seconds at a time, on a loop, for minutes. Every
// cycle was self_preservation's drowning branch preempting everything else with
// an interrupts:all mode, so the self-prompt loop was dropped over and over:
//
//   Could not reach the surface within 20 seconds at -8,77,3 with -1/20 air
//   EVT selfpres:drown:oxygen=-1:above=air:inwater=false
//
// The air bar is 0..20. -1 is the server declining to answer, and the reflex
// read it as "below empty, drowning". A real drowning here reports exactly 0:
// measured 26 times against 2 of these.
import assert from 'assert';
import { lowAirPersists, recordAir, isBreathing } from './skills.js';

const bot = (oxygen) => ({
    oxygenLevel: oxygen,
    entity: { position: { offset: () => ({}) }, eyeHeight: 1.62 },
    blockAt: () => ({ name: 'air' }),
});

// A sentinel cannot fill the window, however many of them arrive.
const b = bot(-1);
for (let i = 0; i < 40; i++) { recordAir(b); }
assert.equal((b._air_history ?? []).length, 0, 'out-of-range readings are not stored');
assert.equal(lowAirPersists(b), false, 'and never amount to a drowning');

// It also must not read as "not breathing", which is what kept surface()
// jumping for the full timeout instead of returning immediately.
assert.equal(isBreathing(b), true, 'no reading falls back to the block at the head');

// Empty is still empty: 0 is a real drowning and must survive the change.
const empty = bot(0);
for (let i = 0; i < 10; i++) { empty._air_history = (empty._air_history ?? []); recordAir(empty); }
assert.ok((empty._air_history ?? []).length > 0, '0 is a real reading and is stored');
assert.equal(isBreathing(empty), false, 'and an empty bar is not breathing');

console.log('ok: a negative air reading is no reading, not an emergency');
