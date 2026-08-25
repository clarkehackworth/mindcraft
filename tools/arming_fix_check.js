// tools/arming_fix_check.js
// Runnable check for the 2026-08-23 arming fixes (devlog/2026-08-23-arming-fix.md,
// devlog/2026-08-23-arming-collect-wood.md).
//
// Fix 1 (09:49): 26/46 deaths were daytime modded-chillager arrows, 41/46 while
// Andy was unarmed; the chest fallback withdrew planks/sticks to craft a starter
// sword, and craft_a_weapon left the crafted sword in the bag (has_item counts
// inventory, not the hand).
//
// Fix 2 (14:47): the 6h audit showed arm_yourself_from_the_chest fired 29x and
// got stuck 40x, and 11/14 fresh deaths were empty-handed. The live log proved
// the do-list starves: the mod's chest GUI will not open ("The chest never
// opened") and the chest is empty or out of range ("Could not find any
// pine_planks in the 4 nearest chests"), so the bot reaches
// craft wooden_sword empty-handed ("no resources to craft a wooden_sword") and
// every step no-ops. The fix makes the rule self-sufficient: collect log from a
// nearby tree before the craft. collect is a blocking action (resets the stuck
// counter), the "log" family name reaches the modpack's pine_log, and it
// degrades to a logged false if no tree is within 64 -- no regression. With a
// log in hand, craftRecipe walks log -> planks -> stick -> sword, including the
// modded raw-recipe path that substitutes same-suffix wood (proven live:
// "Crafted 1 wooden_sword" from a world-sourced log).
//
// This check pins both fixes. No new framework - assert-based.
// Usage: node tools/arming_fix_check.js
import assert from 'node:assert';
import fs from 'node:fs';

const base = JSON.parse(fs.readFileSync(new URL('../policies/survive_upgrade.json', import.meta.url).pathname, 'utf8'));
const rules = base.policy.rules;
const byName = Object.fromEntries(rules.map((r) => [r.name, r]));
const step = (s) => `${s.act}${s.item ? ':' + s.item : s.type ? ':' + s.type : ''}${s.num ? '#' + s.num : ''}`;

// 1. arm_yourself_from_the_chest: withdraw a stored weapon/planks/stick if the
//    chest will open, otherwise self-source wood, then craft + equip a starter
//    sword. The collect step is the self-sufficient fallback for a broken or
//    empty chest.
const arm = byName['arm_yourself_from_the_chest'];
assert(arm, 'rule arm_yourself_from_the_chest missing');
assert.deepStrictEqual(
  arm.do.map(step),
  ['collect:log#4', 'craft:wooden_sword', 'equip_weapon'],
  'arm do-list must be the trimmed self-sufficient chain (no dead chest-withdraw steps)'
);
assert.strictEqual(arm.pinned, true, 'arm must stay pinned');
assert.strictEqual(arm.interrupts, 'all', 'arm must keep interrupts:all');
// trigger unchanged: fires only when unarmed with a chest in range
assert.strictEqual(arm.when.all.length, 2, 'arm when-gates changed');
assert.strictEqual(arm.when.all[0].not.cond, 'has_item');
assert.strictEqual(arm.when.all[0].not.item, 'weapon');
assert.strictEqual(arm.when.all[1].cond, 'block_nearby');
assert.strictEqual(arm.when.all[1].name, 'chest');
// the collect step is the wood source: family name, enough logs for planks +
// stick, and placed immediately before the craft so the wood is fresh in hand
const collectIdx = arm.do.findIndex(s => s.act === 'collect');
assert.ok(collectIdx >= 0, 'arm do-list must self-source wood (collect log)');
assert.strictEqual(arm.do[collectIdx].type, 'log', 'collect must use the log family name');
assert.ok(arm.do[collectIdx].num >= 3, 'collect must fetch enough logs for planks + stick');
assert.strictEqual(arm.do[collectIdx + 1].act, 'craft', 'collect must immediately precede the craft');

// 2. craft_a_weapon: the crafted sword must be equipped (has_item counts the bag, not the hand).
const craft = byName['craft_a_weapon'];
assert(craft, 'rule craft_a_weapon missing');
assert.deepStrictEqual(
  craft.do.map(step),
  ['craft:wooden_sword', 'equip_weapon'],
  'craft do-list must end with equip_weapon'
);
assert.strictEqual(craft.interrupts, 'all', 'craft must keep interrupts:all');

console.log('arming_fix_check: all assertions passed');
console.log('  arm_yourself_from_the_chest:', arm.do.map(step).join(' -> '));
console.log('  craft_a_weapon:            ', craft.do.map(step).join(' -> '));
