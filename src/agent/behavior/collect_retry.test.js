// Run: node src/agent/behavior/collect_retry.test.js
// The arm rule's collect(log, num=1) goto paths out of the base water pocket.
// keep_out_of_water (interrupts:all) or self_preservation (PRIORITY_ABOVE_POLICY)
// changes the pathfinder goal mid-walk, collectBlock's catch breaks the loop on
// interrupt_code, and the single-iteration collect returns false. The 60s rule
// cooldown then pushes the next retry far away, and the do-chain's craft step
// starves: 24 arm fires, 0 crafts, in a 7h window.
//
// collectWithRetry retries on a SET interrupt_code (transient GoalChanged -- the
// fresh re-scan may find a closer tree on a drier path) and bails immediately
// on a CLEARED one (no blocks nearby, no tools -- retrying cannot help).
import assert from 'assert';
import { collectWithRetry } from './policy.js';

const fakeBot = () => ({ interrupt_code: false });

function flakyCollect(bot, behaviors) {
    // behaviors: array of {ok, interrupt} applied in order; last one repeats.
    // Sets bot.interrupt_code to simulate the real pathfinder GoalChanged.
    let calls = 0;
    const fn = async () => {
        const b = behaviors[Math.min(calls, behaviors.length - 1)];
        calls++;
        bot.interrupt_code = b.interrupt ? 'GoalChanged' : false;
        return b.ok;
    };
    fn.calls = () => calls;
    return fn;
}

// 1. Success on the first attempt: one call, no retry, returns true.
{
    const bot = fakeBot();
    const collect = flakyCollect(bot, [{ ok: true, interrupt: false }]);
    const t0 = Date.now();
    const result = await collectWithRetry(bot, collect, 3, 10);
    assert.strictEqual(result, true);
    assert.strictEqual(collect.calls(), 1);
    assert.ok(Date.now() - t0 < 1000, 'no settle wait after success');
}

// 2. Genuine failure (no blocks, no tools): interrupt_code cleared, so a
//    single call and an immediate false. No retry, no settle wait.
{
    const bot = fakeBot();
    const collect = flakyCollect(bot, [{ ok: false, interrupt: false }]);
    const t0 = Date.now();
    const result = await collectWithRetry(bot, collect, 3, 10);
    assert.strictEqual(result, false);
    assert.strictEqual(collect.calls(), 1);
    assert.ok(Date.now() - t0 < 1000, 'no settle wait on a genuine failure');
}

// 3. Transient interrupt then success: retry happens, the second scan wins,
//    and the settle delay between attempts is honored.
{
    const bot = fakeBot();
    const collect = flakyCollect(bot, [
        { ok: false, interrupt: true },
        { ok: true, interrupt: false },
    ]);
    const t0 = Date.now();
    const result = await collectWithRetry(bot, collect, 3, 30);
    assert.strictEqual(result, true);
    assert.strictEqual(collect.calls(), 2);
    assert.ok(Date.now() - t0 >= 30, 'settle wait happened between attempts');
}

// 4. Persistent interrupt: capped at maxAttempts total, returns false, and
//    does NOT settle-wait after the final attempt.
{
    const bot = fakeBot();
    const collect = flakyCollect(bot, [{ ok: false, interrupt: true }]);
    const t0 = Date.now();
    const result = await collectWithRetry(bot, collect, 3, 30);
    assert.strictEqual(result, false);
    assert.strictEqual(collect.calls(), 3, 'capped at maxAttempts, no runaway loop');
    assert.ok(Date.now() - t0 < 200, 'only maxAttempts-1 settle waits, no trailing one');
}

// 5. Custom cap: maxAttempts=1 degrades to the old behavior (one call).
{
    const bot = fakeBot();
    const collect = flakyCollect(bot, [{ ok: false, interrupt: true }]);
    const result = await collectWithRetry(bot, collect, 1, 10);
    assert.strictEqual(result, false);
    assert.strictEqual(collect.calls(), 1);
}

// 6. Defaults: 3 attempts when maxAttempts is omitted.
{
    const bot = fakeBot();
    const collect = flakyCollect(bot, [{ ok: false, interrupt: true }]);
    const t0 = Date.now();
    const result = await collectWithRetry(bot, collect);
    assert.strictEqual(result, false);
    assert.strictEqual(collect.calls(), 3, 'default is 3 attempts total');
    assert.ok(Date.now() - t0 >= 4000, 'default settle is 2s between the 3 attempts');
}

console.log('collect_retry: 6/6 pass');
