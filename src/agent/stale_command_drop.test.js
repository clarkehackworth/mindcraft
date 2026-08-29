// Run: node src/agent/stale_command_drop.test.js
//
// P8: a self-prompt LLM command is dropped while a rule mode:action is still
// YOUNG -- it guards against the one stale command the model committed to
// before the rule fired (see the soak-11 rationale in agent.js). But once the
// action has run past STALE_COMMAND_WINDOW_MS it is stuck, not working (a
// move_away wedged in a pit with no route), and the model's FRESH escape and
// collect commands are exactly what can break it out. The old unbounded drop
// swallowed 705 commands and froze the bot for the action's whole 120s
// lifetime. Past the window a fresh command runs executeCommand -> runAction ->
// stop() and takes over from the stuck action.
//
// The predicate is inline in handleMessage, so this re-implements its shape
// (house pattern, cf. stoploop_concurrent.test.js) but reads the real threshold
// and guard out of agent.js so a regression that drops the bound, or drifts the
// constant, fails here too.
import assert from 'assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'agent.js'), 'utf8');

// The real threshold, from the source, so the check tracks the code.
const m = src.match(/const STALE_COMMAND_WINDOW_MS = (\d+);/);
assert.ok(m, 'STALE_COMMAND_WINDOW_MS must be defined in agent.js');
const STALE_COMMAND_WINDOW_MS = Number(m[1]);
assert.ok(Number.isFinite(STALE_COMMAND_WINDOW_MS) && STALE_COMMAND_WINDOW_MS > 0,
    'STALE_COMMAND_WINDOW_MS must be a positive number');

// The gate must actually be bounded by the action's age (the P8 fix), not just
// by 'is a mode:action executing'.
assert.ok(/mode_age_ms < STALE_COMMAND_WINDOW_MS/.test(src),
    'the self-prompt drop gate must be bounded by mode_age_ms < STALE_COMMAND_WINDOW_MS');
assert.ok(/last_action_time/.test(src),
    'the drop gate must measure action age from actions.last_action_time');

// The exact predicate agent.js applies.
function dropSelfPromptCommand({ self_prompt, executing, label, now = 1000000, last }) {
    const mode_age_ms = now - last;
    return Boolean(self_prompt && executing && String(label).startsWith('mode:'))
        && (mode_age_ms < STALE_COMMAND_WINDOW_MS);
}

const NOW = 1_000_000;
const age = (ms) => NOW - ms;

// A just-fired rule action still swallows the one stale command it was built for.
assert.strictEqual(
    dropSelfPromptCommand({ self_prompt: true, executing: true, label: 'mode:give_up_on_a_stuck_path', last: age(5000) }),
    true,
    'a young mode:action must still drop the stale self-prompt command');

// ...but a stuck one (past the window) lets the model's fresh command through.
assert.strictEqual(
    dropSelfPromptCommand({ self_prompt: true, executing: true, label: 'mode:give_up_on_a_stuck_path', last: age(90000) }),
    false,
    'a mode:action older than the window must NOT keep dropping fresh commands (the P8 fix)');

// The boundary is strict: at exactly the window age it already lets through.
assert.strictEqual(
    dropSelfPromptCommand({ self_prompt: true, executing: true, label: 'mode:collect', last: age(STALE_COMMAND_WINDOW_MS) }),
    false,
    'at exactly STALE_COMMAND_WINDOW_MS the command must be let through (strict <)');

// Non-mode actions, and non-self-prompt commands, are never dropped by this gate.
assert.strictEqual(
    dropSelfPromptCommand({ self_prompt: true, executing: true, label: 'collect:wood', last: age(5000) }),
    false,
    'a non-mode action must not trigger the drop');
assert.strictEqual(
    dropSelfPromptCommand({ self_prompt: false, executing: true, label: 'mode:collect', last: age(5000) }),
    false,
    'a non-self-prompt command must not be dropped by this gate');
assert.strictEqual(
    dropSelfPromptCommand({ self_prompt: true, executing: false, label: 'mode:collect', last: age(5000) }),
    false,
    'nothing executing means nothing to drop against');

// P10 (same file): the liveness watchdog must stay silent pre-login and only
// re-arm on the 'login' event. Guard against a regression that revives the old
// 188s kill during the device-code auth window.
assert.ok(/if \(!this\._logged_in\) return;/.test(src),
    'the liveness watchdog must early-return while !this._logged_in (P10)');
assert.ok(/this\._logged_in = true/.test(src),
    'the login handler must set this._logged_in = true to re-arm the watchdog (P10)');

console.log(`ok: stale self-prompt commands drop only within the ${STALE_COMMAND_WINDOW_MS / 1000}s window; liveness watchdog is auth-aware (P8 + P10)`);
