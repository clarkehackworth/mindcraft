import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const profilesDir = path.resolve('profiles');

test('profiles select providers and model names without transport connection details', () => {
    for (const file of readdirSync(profilesDir)) {
        if (!file.endsWith('.json')) continue;
        const profile = JSON.parse(readFileSync(path.join(profilesDir, file), 'utf8'));
        for (const key of ['model', 'code_model', 'vision_model', 'embedding']) {
            if (!profile[key] || typeof profile[key] !== 'object') continue;
            assert.equal('api' in profile[key], false, `${file}.${key} must not set api; use provider registry`);
            assert.equal('url' in profile[key], false, `${file}.${key} must not set url; use provider registry`);
            assert.equal('baseUrl' in profile[key], false, `${file}.${key} must not set baseUrl; use provider registry`);
            assert.equal('keyName' in profile[key], false, `${file}.${key} must not set keyName; use provider registry`);
            assert.equal('apiKeyName' in profile[key], false, `${file}.${key} must not set apiKeyName; use provider registry`);
        }
    }
});

test('profile embeddings explicitly select both provider and embedding model name', () => {
    for (const file of readdirSync(profilesDir)) {
        if (!file.endsWith('.json')) continue;
        const profile = JSON.parse(readFileSync(path.join(profilesDir, file), 'utf8'));
        if (!profile.embedding) continue;
        assert.equal(typeof profile.embedding, 'object', `${file}.embedding must be an object`);
        assert.equal(typeof profile.embedding.provider, 'string', `${file}.embedding.provider is required`);
        assert.equal(typeof profile.embedding.model, 'string', `${file}.embedding.model is required`);
        assert.ok(profile.embedding.provider.length > 0, `${file}.embedding.provider must not be empty`);
        assert.ok(profile.embedding.model.length > 0, `${file}.embedding.model must not be empty`);
    }
});

test('preset profiles do not silently depend on another provider for embeddings', () => {
    const allowedCrossProviderEmbeddings = new Set([
        // Add explicit exceptions here only when a provider has no embedding API and the profile name makes that choice obvious.
    ]);
    for (const file of readdirSync(profilesDir)) {
        if (!file.endsWith('.json')) continue;
        const profile = JSON.parse(readFileSync(path.join(profilesDir, file), 'utf8'));
        if (!profile.embedding || typeof profile.model !== 'object') continue;
        const modelProvider = profile.model.provider;
        const embeddingProvider = profile.embedding.provider;
        assert.equal(
            modelProvider === embeddingProvider || allowedCrossProviderEmbeddings.has(file),
            true,
            `${file} should not use embedding provider ${embeddingProvider} with model provider ${modelProvider}`
        );
    }
});
