// A chest is the only thing that survives a death, so "take a weapon out of the
// chest" is the whole re-arming story -- and it was unanswerable, because the
// only definition of "weapon" lived in the policy engine, a module skills.js
// must not import. Sixteen of soak 12's twenty-three deaths were unarmed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemMatcher } from './mcdata.js';

test('"weapon" is a family, and it is the one expandBlockName cannot spell', () => {
    const isWeapon = itemMatcher('weapon');
    assert.ok(isWeapon('wooden_sword'));
    assert.ok(isWeapon('netherite_sword'));
    assert.ok(isWeapon('iron_axe'));
    // The distinction that matters at 3am: a pickaxe is not an axe.
    assert.ok(!isWeapon('wooden_pickaxe'));
    assert.ok(!isWeapon('bread'));
});

test('naming-convention families still match every variant', () => {
    const isLog = itemMatcher('log');
    assert.ok(isLog('spruce_log'));
    assert.ok(isLog('oak_log'));
    assert.ok(!isLog('spruce_planks'));
});

test('an exact name matches itself and nothing else', () => {
    const isSpruce = itemMatcher('spruce_log');
    assert.ok(isSpruce('spruce_log'));
    assert.ok(!isSpruce('oak_log'));
});
