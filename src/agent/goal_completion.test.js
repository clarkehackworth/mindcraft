// Andy self-prompted on "Get a wooden pickaxe" long after crafting two of them.
// !endGoal was the only way out and it stopped self-prompting dead, leaving
// nothing driving the agent -- so the model never called it and invented more
// work instead. A finished goal now falls back to the standing policy goal.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { SelfPrompter } from './self_prompter.js';

const STANDING = 'Stay alive indefinitely and keep a stocked base.';

function makeSelfPrompter() {
    const p = new SelfPrompter({ actions: { stop: async () => {} }, isIdle: () => true, handleMessage: async () => true });
    p.startLoop = async () => { p.loop_active = false; };  // don't call an LLM in a test
    return p;
}

test('a detour goal returns to the standing goal when finished', async () => {
    const p = makeSelfPrompter();
    await p.start(STANDING, true);
    await p.start('Get a wooden pickaxe');
    assert.equal(p.prompt, 'Get a wooden pickaxe');

    const out = await p.finish();
    assert.equal(p.prompt, STANDING);
    assert.ok(p.isActive(), 'the agent is still working, not parked');
    assert.match(out, /standing goal/);
});

test('finishing the standing goal itself stops, with nothing to fall back to', async () => {
    const p = makeSelfPrompter();
    await p.start(STANDING, true);
    const out = await p.finish();
    assert.ok(p.isStopped());
    assert.match(out, /stopped/);
});

test('with no standing goal, finishing still stops', async () => {
    const p = makeSelfPrompter();
    await p.start('Get a wooden pickaxe');
    await p.finish();
    assert.ok(p.isStopped());
});

test('the self-prompt tells the model how to declare the goal done', async () => {
    const p = makeSelfPrompter();
    const prompts = [];
    p.agent.handleMessage = async (_src, msg) => { prompts.push(msg); p.interrupt = true; return true; };
    delete p.startLoop;  // use the real loop for one pass
    p.state = 1;
    p.prompt = 'Get a wooden pickaxe';
    p.standing_prompt = STANDING;
    p.cooldown = 0;
    await SelfPrompter.prototype.startLoop.call(p);

    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /!endGoal/);
    assert.match(prompts[0], /already accomplished/);
    assert.match(prompts[0], /not stop working/, 'says returning to the standing goal is the outcome');
});
