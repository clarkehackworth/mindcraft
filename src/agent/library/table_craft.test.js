// Run: node src/agent/library/table_craft.test.js
// mineflayer's bot.craft fabricates the crafting result client-side, so on
// this server (VisualWorkbench rebroadcasts the result slot every tick and
// silently ignores stale clicks) Andy "crafted" pickaxes for days that never
// existed. tableCraft treats server packets as the only truth.
import assert from 'assert';
import { tableCraft } from './skills.js';

// A crafting window whose server half we script: place-clicks always apply;
// the result appears after the grid is full; the first `ignoreTakes` takes are
// silently swallowed, then re-asserted, like VisualWorkbench does.
function fakeCraftWindow(ignoreTakes) {
    const slots = new Array(46).fill(null);
    slots[10] = { type: 5, count: 8, slot: 10, name: 'planks' };
    slots[11] = { type: 7, count: 8, slot: 11, name: 'stick' };
    const win = {
        slots,
        selectedItem: null,
        findInventoryItem: (id) => slots.slice(10).find(s => s?.type === id) ?? null,
        taken: 0,
        ignoreTakes,
    };
    win.click = (slot, button, mode) => {
        if (mode === 1 && slot === 0) { // shift-click the result
            if (win.ignoreTakes > 0) { win.ignoreTakes--; return; } // swallowed; re-asserted below
            if (win.slots[0]) {
                win.taken++;
                win.slots[0] = null;
                for (let s = 1; s <= 9; s++) win.slots[s] = null; // grid consumed
            }
            return;
        }
        if (mode === 1 && slot >= 1) { // withdraw from grid
            win.slots[slot] = null;
            return;
        }
        if (mode === 0) { // pick up / put down
            if (win.selectedItem && slot >= 1 && slot <= 9) { // drop one in the grid
                win.slots[slot] = { type: win.selectedItem.type, count: 1, slot };
                win.selectedItem.count--;
                if (win.selectedItem.count <= 0) win.selectedItem = null;
            } else if (win.selectedItem) { // put the stack back
                win.slots[slot] = win.selectedItem;
                win.selectedItem = null;
            } else if (win.slots[slot]) { // pick up the stack
                win.selectedItem = win.slots[slot];
                win.slots[slot] = null;
            }
        }
        // Server offers the result once the grid matches; re-asserts while it does.
        const placed = win.slots.slice(1, 10).filter(Boolean).length;
        if (placed === 5) win.slots[0] = { type: 779, count: 1, slot: 0 };
    };
    return win;
}

function fakeBot(win) {
    return {
        interrupt_code: false,
        openBlock: async () => win,
        clickWindow: async (s, b, m) => win.click(s, b, m),
        closeWindow: () => { win.closed = true; },
    };
}

// wooden pickaxe: 3 planks over 2 sticks
const RECIPE = { inShape: [
    [{ id: 5 }, { id: 5 }, { id: 5 }],
    [{ id: -1 }, { id: 7 }, { id: -1 }],
    [{ id: -1 }, { id: 7 }, { id: -1 }],
] };

// Vanilla-style: takes apply immediately.
const vanilla = fakeCraftWindow(0);
assert.equal(await tableCraft(fakeBot(vanilla), RECIPE, 1, {}), 1, 'a vanilla table crafts first try');
assert.equal(vanilla.taken, 1);
assert.ok(vanilla.closed, 'the window is closed afterwards');

// VisualWorkbench-style: first two takes silently ignored, then accepted.
const vw = fakeCraftWindow(2);
assert.equal(await tableCraft(fakeBot(vw), RECIPE, 1, {}), 1, 'ignored takes are retried until the grid empties');
assert.equal(vw.taken, 1, 'exactly one real result is taken, no phantoms');

// Server never accepts: report zero crafts and withdraw the grid.
const dead = fakeCraftWindow(Infinity);
assert.equal(await tableCraft(fakeBot(dead), RECIPE, 1, {}), 0, 'a dead table reports zero, not success');
assert.ok(dead.slots.slice(1, 10).every(s => !s), 'stuck ingredients are withdrawn, not stranded');

console.log('ok: tableCraft trusts only the server, retries ignored takes, never fabricates results');
