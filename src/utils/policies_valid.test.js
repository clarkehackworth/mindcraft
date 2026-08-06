// Run: node --test src/utils/policies_valid.test.js
// The starter profiles in ./policies are loaded straight into a live agent, so a
// typo in one of them is a rule that silently never fires -- or a policy the
// agent rejects at load time with nothing left telling it to eat or flee.
// validatePolicy is the same gate a compiled policy goes through; every shipped
// profile has to pass it here, before anyone connects a bot.
import test from 'node:test';
import assert from 'assert';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validatePolicy } from '../agent/behavior/policy.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../policies');
const files = readdirSync(dir).filter(f => f.endsWith('.json'));

test('there are starter profiles to check', () => {
    assert.ok(files.length > 0, `no .json profiles found in ${dir}`);
});

for (const file of files) {
    test(`policies/${file}`, () => {
        const raw = readFileSync(path.join(dir, file), 'utf8');
        let profile;
        assert.doesNotThrow(() => { profile = JSON.parse(raw); }, `${file} is not valid JSON`);

        assert.ok(Array.isArray(profile.source), `${file}: "source" must be an array`);
        assert.ok(profile.source.length > 0, `${file}: "source" must not be empty`);
        for (const s of profile.source)
            assert.equal(typeof s, 'string', `${file}: every "source" entry must be a string`);

        if (profile.kind !== undefined)
            assert.ok(['base', 'attribute'].includes(profile.kind),
                `${file}: "kind" must be "base" or "attribute", got ${JSON.stringify(profile.kind)}`);

        // An attribute is allowed to be nothing but sentences; the merge is what
        // turns it into rules. A base has to stand on its own.
        if (profile.kind === 'attribute' && !profile.policy) return;

        assert.equal(validatePolicy(profile.policy), null, `${file}: ${validatePolicy(profile.policy)}`);

        // A profile with no rules is a profile that does nothing; validatePolicy
        // accepts it, we don't.
        assert.ok(profile.policy.rules.length > 0, `${file}: needs at least one rule`);
    });
}
