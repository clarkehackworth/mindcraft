// Run: node src/agent/skill_suggestions.test.js
// The linter told the model "skills.goTo does not exist" and nothing else, so
// it guessed again, and again: four "Code generation failed after 5 attempts"
// in half an hour. These are the names it actually invented, taken from the
// logs, each next to the real function it was reaching for.
import assert from 'assert';
import { nearestSkills } from './coder.js';

const known = new Set([
    'skills.goToPosition', 'skills.goToPlayer', 'skills.goToNearestBlock', 'skills.goToBed',
    'skills.craftRecipe', 'skills.collectBlock', 'skills.placeBlock', 'skills.equip',
    'world.getBlockAtPosition', 'world.getNearestBlock', 'world.getInventoryCounts',
    'world.getNearbyBlockTypes', 'skills.attackNearest', 'skills.surface',
]);

const suggests = (missing, expected) => {
    const got = nearestSkills(missing, known);
    assert.ok(got.includes(expected), `${missing} should suggest ${expected}, got: ${got.join(', ') || '(none)'}`);
};

// Right function, wrong object -- matching on the bare name is what catches these.
suggests('world.getCraftingPlan', 'skills.craftRecipe');
suggests('skills.craft', 'skills.craftRecipe');
// Truncated names.
suggests('skills.goTo', 'skills.goToPosition');
suggests('world.getBlockAt', 'world.getBlockAtPosition');
suggests('skills.collect', 'skills.collectBlock');

// Suggestions are capped and ordered, so the error stays readable.
assert.ok(nearestSkills('skills.goTo', known).length <= 3, 'at most three suggestions');
assert.equal(nearestSkills('skills.goToPosition', known)[0], 'skills.goToPosition',
    'an exact name ranks first');

// Nothing plausible means no suggestion rather than a misleading one.
assert.deepEqual(nearestSkills('skills.zzzzzzzz', known), [], 'no suggestion when nothing is close');

console.log('ok: invented function names are answered with the real ones');
process.exit(0);
