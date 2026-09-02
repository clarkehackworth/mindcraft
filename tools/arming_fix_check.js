// tools/arming_fix_check.js
// Runnable check for the 2026-08-23/24 arming fixes.
//
// Shape mode (default, fast): pins the policy do-list and when-gates.
//   node tools/arming_fix_check.js
//
// Live mode (--live): also SSHes to the host and asserts on live tallies.
//   MC_HOST='jeff@docker.lan' node tools/arming_fix_check.js --live
//
// Live mode is SLOW (agent log is large over SSH); use timeout 180.
// Per AGENTS.md: one runnable check, no new frameworks.
import assert from 'node:assert';
import fs from 'node:fs';

const base = JSON.parse(fs.readFileSync(new URL('../policies/survive_upgrade.json', import.meta.url).pathname, 'utf8'));
const rules = base.policy.rules;
const byName = Object.fromEntries(rules.map((r) => [r.name, r]));
const step = (s) => `${s.act}${s.item ? ':' + s.item : s.type ? ':' + s.type : ''}${s.num ? '#' + s.num : ''}`;

// ── 1. arm_yourself_from_the_chest shape ──────────────────────────────────
const arm = byName['arm_yourself_from_the_chest'];
assert(arm, 'rule arm_yourself_from_the_chest missing');
assert.deepStrictEqual(
  arm.do.map(step),
  ['collect:log#1', 'craft:wooden_sword', 'equip_weapon'],
  'arm do-list must be the trimmed self-sufficient chain (no dead chest-withdraw steps)'
);
assert.strictEqual(arm.pinned, true, 'arm must stay pinned');
assert.strictEqual(arm.interrupts, 'all', 'arm must keep interrupts:all');

// trigger (2026-08-25: water#8 gate removed): unarmed + chest in range + no hostile within 24.
// The 7h base soak proved the not-water#8 gate was permanently false at the one place arming
// should happen (he lives in a base water pocket), so the rule could never fire; drowning
// mid-arming is already covered by surface_when_drowning (air:12, interrupts:all), so the
// collect goto either completes in shallow water or is nudged out by keep_out_of_water and
// retries on the 60s cooldown.
assert.strictEqual(arm.when.all.length, 3, 'arm when-gates changed (expected 3 after water-gate removal)');
assert.strictEqual(arm.when.all[0].not.cond, 'has_item');
assert.strictEqual(arm.when.all[0].not.item, 'weapon');
assert.strictEqual(arm.when.all[1].cond, 'block_nearby');
assert.strictEqual(arm.when.all[1].name, 'chest');
assert.strictEqual(arm.when.all[1].range, 32);
// Threat-level gate (2026-09-01, was P1 hostile_nearby 24): bot not actively being hit in last 10s.
// The graveyard base has permanent ambient revenants that keep hostile_nearby true forever,
// permanently blocking the arm rule. recently_attacked uses lastDamageTime so the gate only
// closes while the bot is actively being hit (devlog #11).
assert.strictEqual(arm.when.all[2].not.cond, 'recently_attacked');
assert.strictEqual(arm.when.all[2].not.seconds, 10);

// arm_gate_closed (P5 telemetry, 2026-08-25): the mirror of the arm rule with the hostile
// gate FLIPPED -- same weapon/chest preconds, hostile WITHIN 24 instead of not-within-24, and
// no water gate (kept in lockstep with the arm rule so the 24h readout stays valid). Count of
// 'EVT rule:fire:arm_gate_closed' vs the arm rule's own fires decides gate vs downstream chain.
const gate = byName['arm_gate_closed'];
assert(gate, 'rule arm_gate_closed missing (telemetry mirror of the arm rule)');
assert.strictEqual(gate.when.all.length, 3, 'gate when-gates changed (expected 3, mirror of arm)');
assert.strictEqual(gate.when.all[0].not.cond, 'has_item');
assert.strictEqual(gate.when.all[0].not.item, 'weapon');
assert.strictEqual(gate.when.all[1].cond, 'block_nearby');
assert.strictEqual(gate.when.all[1].name, 'chest');
assert.strictEqual(gate.when.all[1].range, 32);
assert.strictEqual(gate.when.all[2].cond, 'recently_attacked');   // FLIPPED: was hit in last 10s, not not-hit
assert.strictEqual(gate.when.all[2].seconds, 10);
assert.strictEqual(gate.interrupts, 'idle', 'telemetry must not disrupt the arming chain (interrupts:idle)');

// the collect step is the wood source: family name, exactly enough logs for the
// craft, and placed immediately before the craft so the wood is fresh in hand.
// A wooden_sword = 2 planks (blade) + 1 stick (handle); a stick = 2 planks; so the
// whole sword needs 4 planks = exactly 1 log (1 log -> 4 planks). num:1 is the
// correct minimum -- num:4 was 4x the recipe and 4x the blocking collect window,
// which is what kept getting interrupted/abandoned before the craft (devlog #10).
const collectIdx = arm.do.findIndex(s => s.act === 'collect');
assert.ok(collectIdx >= 0, 'arm do-list must self-source wood (collect log)');
assert.strictEqual(arm.do[collectIdx].type, 'log', 'collect must use the log family name');
assert.strictEqual(arm.do[collectIdx].num, 1, 'collect must fetch exactly 1 log (= 4 planks = 1 wooden_sword; more only widens the blocking interrupt window)');
assert.strictEqual(arm.do[collectIdx + 1].act, 'craft', 'collect must immediately precede the craft');

// ── 2. craft_a_weapon shape ──────────────────────────────────────────────
const craft = byName['craft_a_weapon'];
assert(craft, 'rule craft_a_weapon missing');
assert.deepStrictEqual(
  craft.do.map(step),
  ['craft:wooden_sword', 'equip_weapon'],
  'craft do-list must end with equip_weapon'
);
assert.strictEqual(craft.interrupts, 'all', 'craft must keep interrupts:all');

console.log('arming_fix_check: shape assertions passed');
console.log('  arm_yourself_from_the_chest:', arm.do.map(step).join(' -> '));
const gateStr = (g) => g.cond ? `${g.cond}:${g.name ?? g.item ?? ''}${g.range ? '#' + g.range : g.seconds ? '#' + g.seconds : ''}` : `not ${g.not.cond}:${g.not.name ?? g.not.item ?? ''}${g.not.range ? '#' + g.not.range : g.not.seconds ? '#' + g.not.seconds : ''}`;
console.log('  when-gates:', arm.when.all.map(gateStr).join(' + '));
console.log('  craft_a_weapon:            ', craft.do.map(step).join(' -> '));

// ── 3. Live tally mode (--live) ──────────────────────────────────────────
const live = process.argv.includes('--live');
if (!live) {
  console.log('  (use --live + MC_HOST to check live tallies)');
  process.exit(0);
}

const { execSync } = await import('node:child_process');
const host = process.env.MC_HOST;
if (!host) {
  console.error('MC_HOST not set (export MC_HOST=jeff@docker.lan)');
  process.exit(1);
}
const BOT = process.env.BOT_CONTAINER || 'mindcraft';
const WINDOW = process.env.SOAK_WINDOW || '24h';

function tally(pattern) {
  const cmd = `ssh ${host} "docker logs --since ${WINDOW} ${BOT} 2>&1 | grep -acE '${pattern}'" 2>/dev/null`;
  const raw = execSync(cmd, { timeout: 180000, encoding: 'utf8' }).trim();
  return parseInt(raw, 10) || 0;
}

console.log(`\nLive tallies (${WINDOW} window, host ${host}):`);
const crafted = tally('Crafted 1 wooden_sword|Successfully crafted wooden_sword');
const goalChanged = tally('GoalChanged');
const chestChurn = tally('The chest never opened|Could not find any.*planks.*chests|Failed to withdraw');
const uncaught = tally('Uncaught|FATAL');

console.log(`  crafted wooden_sword: ${crafted}`);
console.log(`  GoalChanged:          ${goalChanged}`);
console.log(`  chest-withdraw churn: ${chestChurn}`);
console.log(`  Uncaught|FATAL:       ${uncaught}`);

// Assertions on live tallies
// After the trim + gate: craft should succeed at least once per 24h window,
// GoalChanged should be well below the pre-fix 79/6h (~316/24h) rate,
// and chest-withdraw churn should be ~0 (the steps are removed).
assert.ok(crafted > 0, `LIVE: expected >0 crafted wooden_sword in ${WINDOW}, got ${crafted} (arming still 0/0)`);
assert.ok(goalChanged < 100, `LIVE: GoalChanged ${goalChanged} in ${WINDOW} exceeds post-fix expectation (<100; pre-fix was ~316/24h)`);
assert.ok(chestChurn < 10, `LIVE: chest-withdraw churn ${chestChurn} in ${WINDOW} — the dead steps should be gone (was 778/6h pre-trim)`);
assert.strictEqual(uncaught, 0, `LIVE: ${uncaught} Uncaught|FATAL lines in ${WINDOW} — contract violation`);

console.log('\narming_fix_check: ALL assertions passed (shape + live)');
