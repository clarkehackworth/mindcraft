import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeSettingsSpec } from '../src/mindcraft/mindserver.js';

test('New Agent settings spec only inherits hidden runtime LLM provider registry path', () => {
    const spec = buildRuntimeSettingsSpec({
        llm_providers: 'settings_llm_providers.json',
        host: 'example.test',
        profile: { name: 'ignored' }
    });

    assert.equal(spec.llm_providers.default, 'settings_llm_providers.json');
    assert.equal(spec.llm_providers.hidden, true);
    assert.equal(spec.state_snapshot_diff, undefined);
    assert.equal(spec.host.default, '127.0.0.1');
    assert.equal(spec.profile.default, undefined);
});
