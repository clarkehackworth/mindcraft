// Run: node --test src/agent/library/surface_drown.test.js
//
// The fatal trace, replayed: samples14: wet0: oxy=0,0,0,0,0,0,0,0,0,0,0,0,0,0
//
// Fourteen air samples, the head block dry on ALL of them, the bar empty on
// ALL of them, and a real drowning death. The head-block veto in lowAirPersists
// is absolute and runs first, so the oxygen channel -- which had everything it
// needed -- never got a vote. The block lies in two places: a bot floating at
// the waterline with its head just above the surface reads 'air', and an
// unloaded chunk reads nothing at all. Neither case has any head to be wet.
//
// The physics engine's entity status does not have that failure: isInWater is
// set by the server whether or not the chunk loaded. The fix keys the veto on
// it -- lifted, and only lifted, when isInWater is AFFIRMATIVELY true. This
// file pins that split: the surface-drown fires, and every phantom the veto
// was built to stop (measured: eleven fires on a bot standing in air with the
// bar stuck at 0) keeps being stopped.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { recordAir, lowAirPersists, isBreathing } from './skills.js';

// head: block name at the eye position, or null for an unloaded chunk.
// inwater: entity.isInWater as the physics engine last reported it.
const bot = (head, inwater, oxygen) => ({
    oxygenLevel: oxygen,
    _air_history: [],
    entity: {
        position: { offset: () => ({}) },
        eyeHeight: 1.62,
        isInWater: inwater,
    },
    blockAt: () => (head === null ? null : { name: head }),
});

// 14 samples at the mode tick's 300ms cadence, oldest first, all inside the
// 4s window -- the shape of the fatal trace.
const fourteen = (oxygen, submerged, inwater) => {
    const now = Date.now();
    return Array.from({ length: 14 }, (_, i) => ({
        t: now - (13 - i) * 300,
        oxygen,
        submerged,
        inwater,
    }));
};

test('the fatal trace: body in water, head reads air, bar empty fires', () => {
    const b = bot('air', true, 0);
    b._air_history = fourteen(0, false, true);
    assert.equal(lowAirPersists(b), true,
        'affirmative isInWater lifts the head-block veto; the empty bar decides');
});

test('unloaded chunk while in water still fires', () => {
    const b = bot(null, true, 0);
    b._air_history = fourteen(0, false, true);
    assert.equal(lowAirPersists(b), true,
        'a null head is the other block lie; the engine status covers it');
});

test('the classic wet-head drowning still fires', () => {
    const b = bot('water', true, 0);
    b._air_history = fourteen(0, true, true);
    assert.equal(lowAirPersists(b), true, 'unchanged path');
});

test('dry-land phantom with a stuck bar stays vetoed', () => {
    // The measured regression: post-respawn, the bar stuck at 0 and the oxygen
    // channel fired eleven times on a bot standing in air. inwater=false is
    // the side of the split the veto exists for.
    const b = bot('air', false, 0);
    b._air_history = fourteen(0, false, false);
    assert.equal(lowAirPersists(b), false, 'head in air, body not in water: no vote');
});

test('unloaded chunk on dry land stays vetoed', () => {
    const b = bot(null, false, 0);
    b._air_history = fourteen(0, false, false);
    assert.equal(lowAirPersists(b), false, 'no engine confirmation, no vote');
});

test('a refilled bar never fires, wet head or not', () => {
    const b = bot('water', true, 20);
    b._air_history = fourteen(20, true, true);
    assert.equal(lowAirPersists(b), false, 'low NOW, not just low recently');
});

test('isBreathing: in water, head reads air, bar empty -- not breathing', () => {
    // surface() early-returns when isBreathing is true. Answering "breathing"
    // here is the one case the rescue was built to handle, so the bar decides.
    const b = bot('air', true, 0);
    assert.equal(isBreathing(b), false);
});

test('isBreathing: in water, head reads air, bar refilled -- breathing', () => {
    const b = bot('air', true, 20);
    assert.equal(isBreathing(b), true);
});

test('isBreathing: dry land with a stuck bar still answers breathing', () => {
    // The regression this function exists to avoid: the bar stuck at 0 for the
    // rest of a session on a bot standing in a field. On dry land the bar is
    // never consulted.
    const b = bot('air', false, 0);
    assert.equal(isBreathing(b), true);
});

test('isBreathing: head in water never breathes', () => {
    const b = bot('water', true, 20);
    assert.equal(isBreathing(b), false, 'the block channel is unchanged');
});

test('isBreathing: no bar or a broken packet falls back to the block', () => {
    assert.equal(isBreathing(bot('air', true, undefined)), true);
    assert.equal(isBreathing(bot('air', true, -1)), true);
});

test('recordAir captures inwater from the engine status', () => {
    const b = bot('air', true, 0);
    recordAir(b);
    assert.equal(b._air_history.at(-1).inwater, true);
    b.entity.isInWater = false;
    b._air_history.at(-1).t = Date.now() - 5000; // past the 100ms dedupe
    recordAir(b);
    assert.equal(b._air_history.at(-1).inwater, false);
});
