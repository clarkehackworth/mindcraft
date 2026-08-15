// Run: node src/agent/library/surface_noop.test.js
// "Surfaced with 20/20 air left." was logged by a bot that was already
// breathing when the action started, and it reads as a phantom detection. It
// cost two rounds of investigation into a drowning condition that turned out to
// be firing correctly: the readings were real, the bot just bobbed to the
// surface on its own between the mode firing and the action getting its turn.
//
// A no-op has to say it did nothing, or the next person reads the log the same
// wrong way.
import assert from 'assert';
import { surface } from './skills.js';

const fakeBot = (oxygenLevel) => {
    const bot = {
        oxygenLevel,
        output: '',
        interrupt_code: false,
        entity: { position: { offset: () => ({}) }, eyeHeight: 1.62 },
        pathfinder: { stop: () => { bot.stopped = true; } },
        clearControlStates: () => {},
        setControlState: (name) => { if (name === 'jump') bot.swam = true; },
        blockAt: () => ({ name: 'air' }),
        canDigBlock: () => false,
        stopped: false,
        swam: false,
        chat: () => {},
        modes: { isOn: () => false },
        emit: () => {},
    };
    return bot;
};

const breathing = fakeBot(20);
assert.equal(await surface(breathing), true, 'a breathing bot is trivially surfaced');
assert.match(breathing.output, /nothing to surface from/i,
    'and it says it did nothing, instead of claiming a successful rescue');
assert.doesNotMatch(breathing.output, /Surfaced with/,
    'the misleading line is not emitted for a no-op');
assert.equal(breathing.swam, false, 'no swimming, no control states touched');

// A bot that really is underwater still does the work and reports the real one.
const drowning = fakeBot(5);
drowning.blockAt = () => ({ name: 'water' });
// Reaches air on the second look.
let looks = 0;
Object.defineProperty(drowning, 'oxygenLevel', { get: () => (++looks > 2 ? 20 : 5) });
assert.equal(await surface(drowning), true);
assert.match(drowning.output, /Surfaced with/, 'a real rescue still reports one');
assert.equal(drowning.swam, true, 'and it actually swam');

console.log('ok: surface() distinguishes a rescue from a no-op');
process.exit(0);
