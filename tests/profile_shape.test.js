import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const profilesDir = path.resolve('profiles');
const profileFiles = listJsonFiles(profilesDir);
const rootDefaultProfile = path.resolve('andy.json');
const selectableProfileFiles = [
    rootDefaultProfile,
    ...profileFiles.filter(file => path.dirname(file) === profilesDir)
];

test('profiles select providers and model names without transport connection details', () => {
    for (const file of selectableProfileFiles) {
        const profile = JSON.parse(readFileSync(file, 'utf8'));
        const name = path.relative(profilesDir, file);
        for (const key of ['model', 'code_model', 'vision_model', 'embedding']) {
            if (!profile[key] || typeof profile[key] !== 'object') continue;
            assert.equal('api' in profile[key], false, `${name}.${key} must not set api; use provider registry`);
            assert.equal('url' in profile[key], false, `${name}.${key} must not set url; use provider registry`);
            assert.equal('baseUrl' in profile[key], false, `${name}.${key} must not set baseUrl; use provider registry`);
            assert.equal('keyName' in profile[key], false, `${name}.${key} must not set keyName; use provider registry`);
            assert.equal('apiKeyName' in profile[key], false, `${name}.${key} must not set apiKeyName; use provider registry`);
        }
    }
});

test('preset profiles expose inert code and vision model placeholders', () => {
    for (const file of selectableProfileFiles) {
        const profile = JSON.parse(readFileSync(file, 'utf8'));
        const name = path.relative(profilesDir, file);
        assert.ok('code_model' in profile, `${name}.code_model placeholder is required`);
        assert.ok('vision_model' in profile, `${name}.vision_model placeholder is required`);
        assert.equal(typeof profile.code_model, 'object', `${name}.code_model must be a provider/model object placeholder`);
        assert.equal(typeof profile.vision_model, 'object', `${name}.vision_model must be a provider/model object placeholder`);
        assert.equal(profile.code_model.provider, '', `${name}.code_model.provider should be blank until enabled`);
        assert.equal(profile.code_model.model, '', `${name}.code_model.model should be blank until enabled`);
        assert.equal(profile.vision_model.provider, '', `${name}.vision_model.provider should be blank until enabled`);
        assert.equal(profile.vision_model.model, '', `${name}.vision_model.model should be blank until enabled`);
    }
});

test('profile embeddings explicitly select both provider and embedding model name', () => {
    for (const file of selectableProfileFiles) {
        const profile = JSON.parse(readFileSync(file, 'utf8'));
        const name = path.relative(profilesDir, file);
        assert.ok('embedding' in profile, `${name}.embedding placeholder is required`);
        assert.equal(typeof profile.embedding, 'object', `${name}.embedding must be an object`);
        assert.equal(typeof profile.embedding.provider, 'string', `${name}.embedding.provider is required`);
        assert.equal(typeof profile.embedding.model, 'string', `${name}.embedding.model is required`);
        if (profile.embedding.provider === '' || profile.embedding.model === '') {
            assert.equal(profile.embedding.provider, '', `${name}.embedding provider/model placeholders must both be blank`);
            assert.equal(profile.embedding.model, '', `${name}.embedding provider/model placeholders must both be blank`);
        } else {
            assert.ok(profile.embedding.provider.length > 0, `${name}.embedding.provider must not be empty`);
            assert.ok(profile.embedding.model.length > 0, `${name}.embedding.model must not be empty`);
        }
    }
});

test('default and task profile fragments do not carry selectable model placeholders', () => {
    for (const file of profileFiles.filter(file => path.dirname(file) !== profilesDir)) {
        const profile = JSON.parse(readFileSync(file, 'utf8'));
        const name = path.relative(profilesDir, file);
        for (const key of ['embedding', 'code_model', 'vision_model']) {
            assert.equal(key in profile, false, `${name} should not define ${key}`);
        }
    }
});

function listJsonFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) return listJsonFiles(fullPath);
        return entry.name.endsWith('.json') ? [fullPath] : [];
    });
}

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
        if (!embeddingProvider) continue;
        assert.equal(
            modelProvider === embeddingProvider || allowedCrossProviderEmbeddings.has(file),
            true,
            `${file} should not use embedding provider ${embeddingProvider} with model provider ${modelProvider}`
        );
    }
});
