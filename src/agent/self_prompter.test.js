// Run: node src/agent/self_prompter.test.js
// Andy emitted !searchForBlock("pumpkin", 128) for hours and never ran it once.
// Every mode execution called stopLoop(), which set interrupt, which made
// handleMessage discard the command the model had just decided on. The
// day_gather_food rule fires on a 10s cooldown whenever the bot is idle --
// exactly when the self-prompt loop is waiting on the API -- so it ate almost
// every command the model produced.
import assert from 'assert';
import { SelfPrompter } from './self_prompter.js';

const ACTIVE = 1;
const sp = () => {
    const p = new SelfPrompter({ actions: { stop: async () => {} }, isIdle: () => true });
    p.state = ACTIVE;
    p.prompt = 'gather food';
    // A loop is in flight -- that is the whole window this bug lives in: the
    // model has been asked for a command and has not answered yet.
    p.loop_active = true;
    return p;
};

// A routine (idle-only) mode pauses the loop but keeps the pending command.
const routine = sp();
routine.stopLoop(false);
assert.equal(routine.interrupt, true, 'the loop still stops issuing new prompts');
assert.equal(routine.shouldInterrupt(true), false,
    'a command already decided on survives an idle-only mode firing');

// An urgent mode (one that interrupts everything) still discards it.
const urgent = sp();
urgent.stopLoop();
assert.equal(urgent.shouldInterrupt(true), true,
    'a preempting mode still cancels the pending command');

// A user taking over discards it too -- handleUserPromptedCmd defaults to true.
const taken_over = sp();
taken_over.handleUserPromptedCmd(false, true);
assert.equal(taken_over.shouldInterrupt(true), true, 'a user command cancels the pending self-prompt command');

// The flag never sticks: once the loop drains, the next stop discards again.
const reset = sp();
reset.stopLoop(false);
assert.equal(reset.shouldInterrupt(true), false);
reset.loop_active = false;              // the loop drains
await new Promise(r => setTimeout(r, 600));
assert.equal(reset.interrupt, false, 'the loop is free to restart');
assert.equal(reset.discard_pending, true, 'discard_pending resets to the safe default');

// And a non-self-prompt message is never affected either way.
assert.equal(urgent.shouldInterrupt(false), false, 'a user-sourced message is not discarded');

// inventoryLine is the authoritative ground truth that stops the model keeping a
// false belief in gear it never made (the 7h base soak: it reported "wood tools" while
// its real inventory was two steaks). It surfaces the real items and must NEVER throw --
// the self-prompt loop runs where nothing catches, so a throw here would take down the agent.
const withBot = new SelfPrompter({ bot: { inventory: { slots: [{ name: 'cooked_beef', count: 2 }, { name: 'wooden_sword', count: 1 }, null] } }, actions: { stop: async () => {} }, isIdle: () => true });
const inv = withBot.inventoryLine();
assert.ok(inv.includes('wooden_sword x1'), 'inventoryLine surfaces the real items');
assert.ok(inv.includes('cooked_beef x2'), 'inventoryLine surfaces the real items');
assert.ok(inv.includes('ACTUAL inventory'), 'inventoryLine labels itself as ground truth');
assert.ok(inv.includes('do not mark it done'), 'inventoryLine tells the model not to false-complete a step it cannot afford');

// The mock agents in this file have no bot -- it degrades to '' so the turn proceeds as before.
assert.equal(sp().inventoryLine(), '', 'no bot -> empty line, never throws');
// A throwing inventory (malformed bot) must not propagate -- tick-path contract.
const bad = new SelfPrompter({ bot: { get inventory() { throw new Error('nope'); } }, actions: { stop: async () => {} }, isIdle: () => true });
assert.equal(bad.inventoryLine(), '', 'a throwing inventory degrades to empty instead of crashing');

// Let the still-parked stopLoop() drains finish so node can exit.
for (const p of [routine, urgent, taken_over]) p.loop_active = false;
await new Promise(r => setTimeout(r, 600));

console.log('ok: routine modes pause the loop, only preempting ones cancel the command');
