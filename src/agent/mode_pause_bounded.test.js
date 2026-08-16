// Run: node src/agent/mode_pause_bounded.test.js
// Preemption pauses the mode that lost, and unPauseAll only runs when the agent
// is idle. A bot inside a long blocking action is never idle, so a mode that
// lost one preemption stayed off for as long as the bot stayed busy --
// self_preservation included, which switches off the drowning and low-health
// reflexes entirely. Andy drowned at -27,47,27 fourteen seconds after the
// self-prompt loop overran its stop deadline, with no reflex fire before it.
//
// The pause still has to exist: self_preservation and self_defense preempted
// each other 157 times in a row standing next to one zombie. It just has to end
// on its own, the way self_prompter's stop wait does.
import assert from 'assert';

const PAUSE_MAX_MS = 30000;
const PAUSE_MAX_URGENT_MS = 5000;
const URGENT = ['self_preservation', 'unstuck', 'cowardice', 'self_defense'];
const isUrgent = (m) => m.urgent ?? URGENT.includes(m.name);

// The sweep from modes.update(), lifted in shape.
function sweep(entries, now, unpaused = []) {
    for (const entry of entries) {
        const cap = isUrgent(entry) ? PAUSE_MAX_URGENT_MS : PAUSE_MAX_MS;
        if (entry.paused && now - (entry.paused_at ?? 0) > cap) {
            entry.paused = false;
            unpaused.push(entry.name);
        }
    }
    return unpaused;
}

// A safety reflex comes back fast. Drowning runs its whole course in about
// fifteen seconds, so anything slower than that is absent for the emergency.
{
    const selfpres = { name: 'self_preservation', paused: true, paused_at: 0 };
    assert.deepEqual(sweep([selfpres], 4000), [], 'not instantly -- the 157-preemption thrash is real');
    assert.equal(selfpres.paused, true);

    assert.deepEqual(sweep([selfpres], 6000), ['self_preservation'],
        'but back well inside the time a drowning takes');
    assert.equal(selfpres.paused, false);
}

// An ordinary mode may stay parked longer; it is not holding a life-support job.
{
    const idle_mode = { name: 'item_collecting', paused: true, paused_at: 0 };
    assert.deepEqual(sweep([idle_mode], 20000), [], 'ordinary modes wait their turn');
    assert.deepEqual(sweep([idle_mode], 31000), ['item_collecting']);
}

// The bot never going idle is the whole point: this must not depend on it.
{
    const selfpres = { name: 'self_preservation', paused: true, paused_at: 0 };
    // No unPauseAll call anywhere here -- the agent is busy, as it was for the
    // five minutes before the drowning.
    sweep([selfpres], 10000);
    assert.equal(selfpres.paused, false,
        'the pause ends on its own clock, not on the agent becoming idle');
}

// A mode nobody paused is left alone.
{
    const running = { name: 'self_defense', paused: false, paused_at: 0 };
    assert.deepEqual(sweep([running], 999999), []);
}

console.log('ok: a preemption pause expires instead of lasting forever');
