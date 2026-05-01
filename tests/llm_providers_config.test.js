import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync('llm_providers.json', 'utf8'));
const example = JSON.parse(readFileSync('llm_providers.example.json', 'utf8'));

test('llm provider config uses readable format/baseUrl/keyName schema', () => {
    assert.equal(config.schemaVersion, 1);
    assert.equal('examples' in config, false, 'custom examples should live under models/embeddings in the example file, not a separate top-level field');
    for (const sectionName of ['models', 'embeddings']) {
        const section = config[sectionName];
        assert.equal(typeof section, 'object', `${sectionName} section is required`);
        for (const [id, provider] of Object.entries(section)) {
            assert.equal(typeof provider.format, 'string', `${sectionName}.${id}.format is required`);
            assert.equal('api' in provider, false, `${sectionName}.${id} should use format, not api`);
            assert.equal('name' in provider, false, `${sectionName}.${id} should use the provider id instead of a duplicate name`);
            assert.equal('url' in provider, false, `${sectionName}.${id} should use baseUrl, not url`);
            assert.equal('apiKeyName' in provider, false, `${sectionName}.${id} should use keyName, not apiKeyName`);
            assert.notEqual(provider.format, 'openai-compatible', `${sectionName}.${id} should use OpenClaw protocol names such as openai-completions`);
            assert.notEqual(provider.format, 'openai-chat-completions', `${sectionName}.${id} should use OpenClaw protocol name openai-completions`);
        }
    }
});

test('example config documents custom providers without name mapping', () => {
    assert.equal('examples' in example, false);
    assert.equal(example.models._example_openai_chat_completions.format, 'openai-completions');
    assert.equal(example.models._example_openai_chat_completions.keyName, 'MY_PROVIDER_API_KEY');
    assert.equal(example.models._example_openai_chat_completions.baseUrl, 'https://api.example.com/v1');
    assert.equal('name' in example.models._example_openai_chat_completions, false);

    assert.equal(example.models._example_openai_responses.format, 'openai-responses');
    assert.equal(example.models._example_openai_responses.keyName, 'MY_RESPONSES_API_KEY');

    assert.equal(example.embeddings._example_openai_embeddings.format, 'openai-embeddings');
    assert.equal(example.embeddings._example_openai_embeddings.defaultModel, 'text-embedding-model-name');
    assert.equal(example.embeddings._example_openai_embeddings.keyName, 'MY_EMBEDDING_API_KEY');
});

test('kimi uses the documented Anthropic-compatible coding endpoint', () => {
    assert.deepEqual(config.models.kimi, {
        format: 'anthropic-messages',
        baseUrl: 'https://api.kimi.com/coding/',
        keyName: 'KIMI_API_KEY',
        defaultModel: 'kimi-k2.6',
        params: {
            max_tokens: 32768,
            provider: 'kimi'
        }
    });
});

test('PR 752 OpenAI-compatible providers live in the shared registry', () => {
    const providers = {
        ai21: ['AI21_API_KEY', 'https://api.ai21.com/studio/v1', 'jamba-1.5-large'],
        anyscale: ['ANYSCALE_API_KEY', 'https://api.endpoints.anyscale.com/v1', 'meta-llama/Meta-Llama-3-70B-Instruct'],
        cohere: ['COHERE_API_KEY', 'https://api.cohere.com/v1', 'command-r-plus'],
        deepinfra: ['DEEPINFRA_API_KEY', 'https://api.deepinfra.com/v1/openai', 'meta-llama/Meta-Llama-3-70B-Instruct'],
        fireworks: ['FIREWORKS_API_KEY', 'https://api.fireworks.ai/inference/v1', 'accounts/fireworks/models/llama-v3p1-70b-instruct'],
        nvidia: ['NVIDIA_API_KEY', 'https://integrate.api.nvidia.com/v1', 'meta/llama3-70b-instruct'],
        perplexity: ['PERPLEXITY_API_KEY', 'https://api.perplexity.ai', 'llama-3-sonar-large-32k-online'],
        together: ['TOGETHER_API_KEY', 'https://api.together.xyz/v1', 'meta-llama/Llama-3-70b-chat-hf']
    };

    for (const [id, [keyName, baseUrl, defaultModel]] of Object.entries(providers)) {
        assert.deepEqual(config.models[id], {
            format: 'openai-completions',
            baseUrl,
            keyName,
            defaultModel
        });
        assert.equal(example.models[id].format, 'openai-completions');
        assert.equal(example.models[id].keyName, keyName);
        assert.ok(Object.hasOwn(example.keys, keyName), `example keys must include ${keyName}`);
    }
});

test('remote llm providers explicitly declare which key they use', () => {
    const localOrLogin = new Set(['codex', 'ollama_local', 'vllm']);
    for (const [id, provider] of Object.entries(config.models)) {
        if (localOrLogin.has(id)) continue;
        assert.equal(typeof provider.keyName, 'string', `models.${id}.keyName is required`);
        assert.ok(provider.keyName.length > 0, `models.${id}.keyName must not be empty`);
        assert.ok(Object.hasOwn(config.keys, provider.keyName), `keys.${provider.keyName} must exist for models.${id}`);
    }

    for (const [id, provider] of Object.entries(config.embeddings)) {
        if (localOrLogin.has(id)) continue;
        assert.equal(typeof provider.keyName, 'string', `embeddings.${id}.keyName is required`);
        assert.ok(provider.keyName.length > 0, `embeddings.${id}.keyName must not be empty`);
        assert.ok(Object.hasOwn(config.keys, provider.keyName), `keys.${provider.keyName} must exist for embeddings.${id}`);
    }
});

test('llm provider example mirrors provider ids without real key material', () => {
    assert.deepEqual(
        new Set(Object.keys(example.models).filter(id => !id.startsWith('_example_'))),
        new Set(Object.keys(config.models))
    );
    assert.deepEqual(
        new Set(Object.keys(example.embeddings).filter(id => !id.startsWith('_example_'))),
        new Set(Object.keys(config.embeddings))
    );
    assert.equal(example.keys.XIAOAI_API_KEY, undefined);
    for (const [keyName, value] of Object.entries(example.keys)) {
        if (keyName === 'CODEX_CHATGPT_AUTH') continue;
        assert.equal(value, '', `${keyName} should be blank in the example`);
    }
});


test('codex provider stores auth in the unified project config instead of a fixed user path', () => {
    assert.equal(config.models.codex.format, 'openai-codex-responses');
    assert.equal(config.models.codex.adapter, 'codex');
    assert.equal(config.models.codex.params.keysPath, 'llm_providers.json');
    assert.equal('authPath' in config.models.codex.params, false);
    assert.ok(Object.hasOwn(config.keys, 'CODEX_CHATGPT_AUTH'));

    assert.equal(example.models.codex.params.keysPath, 'llm_providers.json');
    assert.equal('authPath' in example.models.codex.params, false);
    assert.ok(Object.hasOwn(example.keys, 'CODEX_CHATGPT_AUTH'));
});
