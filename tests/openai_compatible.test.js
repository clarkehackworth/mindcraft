import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompletions, OpenAICompatible } from '../src/models/openai_compatible.js';
import { isNativeToolResponse } from '../src/models/native_tools.js';
import { selectAPI, selectEmbeddingAPI, createModel } from '../src/models/_model_map.js';

const tool = {
    type: 'function',
    function: {
        name: 'report_status',
        description: 'Report status',
        parameters: {
            type: 'object',
            properties: { status: { type: 'string' } },
            required: ['status'],
            additionalProperties: false
        }
    }
};

test('openai-completions API format can be selected by profile', () => {
    const profile = selectAPI({
        api: 'openai-completions',
        url: 'https://example.test/v1',
        model: 'provider-model',
        params: { apiKeyName: 'OPENAI_API_KEY', provider: 'example-provider' }
    });
    const model = createModel(profile);
    assert.equal(model.constructor.name, 'OpenAICompletions');
    assert.equal(model.provider, 'example-provider');
    assert.equal(model.supportsNativeToolCalls, true);

    const oldAlias = createModel(selectAPI({
        api: 'openai-compatible',
        url: 'https://example.test/v1',
        model: 'provider-model',
        params: { apiKeyName: 'OPENAI_API_KEY', provider: 'example-provider' }
    }));
    assert.ok(oldAlias instanceof OpenAICompatible);
    assert.ok(model instanceof OpenAICompletions);
});

test('provider registry expands provider shorthand into a concrete transport', () => {
    const profile = selectAPI({
        provider: 'siliconflow',
        model: 'Pro/deepseek-ai/DeepSeek-V3',
        params: { temperature: 0 }
    });

    assert.equal(profile.api, 'openai-completions');
    assert.equal(profile.url, 'https://api.siliconflow.cn/v1');
    assert.equal(profile.model, 'Pro/deepseek-ai/DeepSeek-V3');
    assert.deepEqual(profile.params, {
        apiKeyName: 'SILICONFLOW_API_KEY',
        provider: 'siliconflow',
        temperature: 0
    });

    assert.equal(profile.params.provider, 'siliconflow');
});

test('provider registry supports non OpenAI-compatible transport families', () => {
    assert.equal(selectAPI({ provider: 'codex', model: 'gpt-5.5' }).api, 'codex');
    assert.equal(selectAPI({ provider: 'google', model: 'gemini-3-flash-preview' }).api, 'google-generative-ai');
    assert.equal(selectAPI({ provider: 'azure', model: 'gpt-5-nano' }).api, 'azure-openai-responses');
    assert.equal(selectAPI({ provider: 'mistral', model: 'mistral-small-latest' }).api, 'openai-completions');
});

test('embedding provider registry is separate from chat model providers', () => {
    const qwenEmbedding = selectEmbeddingAPI({ provider: 'qwen_cn' });
    assert.equal(qwenEmbedding.api, 'openai-completions');
    assert.equal(qwenEmbedding.url, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
    assert.equal(qwenEmbedding.model, 'text-embedding-v3');
    assert.equal(qwenEmbedding.params.apiKeyName, 'QWEN_API_KEY');
    assert.equal(qwenEmbedding.params.provider, 'qwen_cn');

    const openaiEmbedding = selectEmbeddingAPI('openai');
    assert.equal(openaiEmbedding.api, 'openai-completions');
    assert.equal(openaiEmbedding.model, 'text-embedding-3-small');
});

test('ollama defaults to cloud OpenAI-compatible endpoint and can be overridden to local', () => {
    const chat = selectAPI({
        provider: 'ollama',
        model: 'gpt-oss:120b-cloud'
    });
    assert.equal(chat.api, 'openai-completions');
    assert.equal(chat.url, 'https://ollama.com/v1');
    assert.equal(chat.params.provider, 'ollama');
    assert.equal(chat.params.apiKeyName, 'OLLAMA_API_KEY');

    const model = createModel(chat);
    assert.equal(model.constructor.name, 'OpenAICompletions');

    const local = selectAPI({
        provider: 'ollama',
        model: 'llama3.1',
        baseUrl: 'http://127.0.0.1:11434/v1',
        params: { apiKeyName: null }
    });
    assert.equal(local.url, 'http://127.0.0.1:11434/v1');
    assert.equal('apiKeyName' in local.params, false);
});

test('profile embedding model can override the provider default embedding name', () => {
    const profile = selectEmbeddingAPI({
        provider: 'qwen_cn',
        model: 'text-embedding-v4',
        params: { dimensions: 1024 }
    });

    assert.equal(profile.api, 'openai-completions');
    assert.equal(profile.model, 'text-embedding-v4');
    assert.deepEqual(profile.params, {
        apiKeyName: 'QWEN_API_KEY',
        provider: 'qwen_cn',
        dimensions: 1024
    });
});

test('provider registry rejects unknown provider ids', () => {
    assert.throws(
        () => selectAPI({ provider: 'missing-provider', model: 'anything' }),
        /Unknown model provider: missing-provider/
    );
});

test('embedding provider registry rejects unknown provider ids independently', () => {
    assert.throws(
        () => selectEmbeddingAPI({ provider: 'missing-embedding', model: 'anything' }),
        /Unknown embedding provider: missing-embedding/
    );
});

test('openai-compatible transport sends Chat Completions tools and normalizes tool calls', async () => {
    const model = new OpenAICompatible('provider-model', 'https://example.test/v1', {
        apiKeyName: 'OPENAI_API_KEY',
        provider: 'example-provider'
    });
    let requestPack;
    model.openai = {
        chat: {
            completions: {
                create: async pack => {
                    requestPack = pack;
                    return {
                        usage: {
                            prompt_tokens: 100,
                            completion_tokens: 12,
                            prompt_tokens_details: { cached_tokens: 70 }
                        },
                        choices: [{
                            message: {
                                reasoning_content: 'I should call report_status.',
                                tool_calls: [{
                                    id: 'call_1',
                                    type: 'function',
                                    function: {
                                        name: 'report_status',
                                        arguments: '{"status":"ok"}'
                                    }
                                }]
                            }
                        }]
                    };
                }
            }
        }
    };

    const response = await model.sendRequest(
        [{ role: 'user', content: 'call tool' }],
        'Use tools.',
        '***',
        [tool]
    );

    assert.equal(requestPack.model, 'provider-model');
    assert.equal(requestPack.messages[0].role, 'system');
    assert.equal(requestPack.messages[1].role, 'user');
    assert.equal(requestPack.tools[0].function.name, 'report_status');
    assert.equal(Object.prototype.hasOwnProperty.call(requestPack, 'tool_choice'), false);
    assert.equal(isNativeToolResponse(response), true);
    assert.equal(response.thinking, 'I should call report_status.');
    assert.equal(response.provider, 'example-provider');
    assert.equal(response.tool_calls[0].name, 'report_status');
    assert.equal(model.lastTokenUsage.input_uncached, 30);
    assert.equal(model.lastTokenUsage.input_cached, 70);
    assert.equal(model.lastTokenUsage.output, 12);
});

test('Kimi OpenAI-compatible transport replays blank reasoning_content when thinking is enabled', async () => {
    const model = new OpenAICompatible('kimi-k2.6', 'https://api.kimi.com/coding/v1', {
        apiKeyName: 'OPENAI_API_KEY',
        provider: 'kimi'
    });
    let requestPack;
    model.openai = {
        chat: {
            completions: {
                create: async pack => {
                    requestPack = pack;
                    return { choices: [{ message: { content: 'ok' } }] };
                }
            }
        }
    };

    await model.sendRequest(
        [{ role: 'assistant', content: 'previous assistant response' }],
        'Use tools.',
        '***',
        []
    );

    assert.equal(requestPack.messages[1].role, 'assistant');
    assert.equal(requestPack.messages[1].reasoning_content, '');
});

test('openai-completions transport strips tool choice even if configured', async () => {
    const model = new OpenAICompatible('provider-model', 'https://example.test/v1', {
        apiKeyName: 'OPENAI_API_KEY',
        provider: 'example-provider',
        tool_choice: { type: 'function', function: { name: 'report_status' } }
    });
    let requestPack;
    model.openai = {
        chat: {
            completions: {
                create: async pack => {
                    requestPack = pack;
                    return { choices: [{ message: { content: 'ok' } }] };
                }
            }
        }
    };

    await model.sendRequest(
        [{ role: 'user', content: 'call tool' }],
        'Use tools.',
        '***',
        [tool]
    );

    assert.equal(requestPack.tools[0].function.name, 'report_status');
    assert.equal(Object.prototype.hasOwnProperty.call(requestPack, 'tool_choice'), false);
});

test('azure provider can use an explicit deployment name separate from model id', () => {
    const model = createModel(selectAPI({
        provider: 'azure',
        model: 'gpt-5-nano',
        params: { deploymentName: 'my-gpt-5-nano-deployment' }
    }));

    assert.equal(model.constructor.name, 'AzureOpenAIResponses');
    assert.equal(model.model_name, 'gpt-5-nano');
    assert.equal(model.deployment, 'my-gpt-5-nano-deployment');
});




test('ollama_local uses local OpenAI-compatible endpoint without an API key', () => {
    const chat = selectAPI({ provider: 'ollama_local', model: 'sweaterdog/andy-4:micro-q8_0' });
    assert.equal(chat.api, 'openai-completions');
    assert.equal(chat.url, 'http://127.0.0.1:11434/v1');
    assert.equal(chat.params.provider, 'ollama_local');
    assert.equal('apiKeyName' in chat.params, false);

    const embedding = selectEmbeddingAPI({ provider: 'ollama_local', model: 'embeddinggemma' });
    assert.equal(embedding.api, 'openai-completions');
    assert.equal(embedding.url, 'http://127.0.0.1:11434/v1');
    assert.equal(embedding.params.provider, 'ollama_local');
});

test('replicate provider is a separate Predictions API protocol with native tool normalization', async () => {
    const profile = selectAPI({ provider: 'replicate', model: 'google/gemini-2.5-flash' });
    assert.equal(profile.api, 'replicate');
    assert.equal(profile.model, 'google/gemini-2.5-flash');
    assert.equal(profile.params.apiKeyName, 'REPLICATE_API_KEY');
    assert.equal(profile.params.provider, 'replicate');

    const prefixed = selectAPI('replicate/google/gemini-2.5-flash');
    assert.equal(prefixed.api, 'replicate');
    assert.equal(prefixed.model, 'google/gemini-2.5-flash');

    const model = createModel(selectAPI({
        api: 'replicate',
        model: 'google/gemini-2.5-flash',
        params: { apiKeyName: 'OPENAI_API_KEY', provider: 'replicate-test' }
    }));
    assert.equal(model.constructor.name, 'ReplicateAPI');
    assert.equal(model.supportsNativeToolCalls, true);

    let runArgs;
    model.replicate = {
        run: async (modelName, args) => {
            runArgs = { modelName, args };
            return {
                tool_calls: [{
                    id: 'call_rep_1',
                    type: 'function',
                    function: {
                        name: 'report_status',
                        arguments: { status: 'ok' }
                    }
                }]
            };
        }
    };

    const response = await model.sendRequest(
        [{ role: 'user', content: 'call tool' }],
        'Use tools.',
        '***',
        [tool]
    );

    assert.equal(runArgs.modelName, 'google/gemini-2.5-flash');
    assert.equal(runArgs.args.input.messages[0].role, 'system');
    assert.equal(runArgs.args.input.tools[0].function.name, 'report_status');
    assert.equal(isNativeToolResponse(response), true);
    assert.equal(response.provider, 'replicate-test');
    assert.equal(response.tool_calls[0].name, 'report_status');
    assert.equal(response.tool_calls[0].arguments, '{"status":"ok"}');
});

test('replicate gemini text requests use run with prompt-shaped input', async () => {
    const model = createModel(selectAPI({
        api: 'replicate',
        model: 'google/gemini-2.5-flash',
        params: { apiKeyName: 'OPENAI_API_KEY', provider: 'replicate-test' }
    }));
    let runArgs;
    let streamCalled = false;
    model.replicate = {
        run: async (modelName, args) => {
            runArgs = { modelName, args };
            return ['ok'];
        },
        stream: async function* () {
            streamCalled = true;
            yield 'bad';
        }
    };

    const response = await model.sendRequest(
        [{ role: 'user', content: 'Reply exactly: ok' }],
        'System instruction.',
        '***'
    );

    assert.equal(response, 'ok');
    assert.equal(streamCalled, false);
    assert.equal(runArgs.modelName, 'google/gemini-2.5-flash');
    assert.match(runArgs.args.input.prompt, /System instruction\./);
    assert.match(runArgs.args.input.prompt, /Reply exactly: ok/);
    assert.equal(runArgs.args.input.system_instruction, 'System instruction.');
    assert.equal(Object.prototype.hasOwnProperty.call(runArgs.args.input, 'system_prompt'), false);
});

test('replicate embeddings use a dedicated embedding model when chat model is configured', async () => {
    const model = createModel(selectAPI({
        api: 'replicate',
        model: 'google/gemini-2.5-flash',
        params: { apiKeyName: 'OPENAI_API_KEY', provider: 'replicate-test' }
    }));
    let runArgs;
    model.replicate = {
        run: async (modelName, args) => {
            runArgs = { modelName, args };
            return { embeddings: [[0.1, 0.2, 0.3]] };
        }
    };

    const embedding = await model.embed('hello');

    assert.deepEqual(embedding, [0.1, 0.2, 0.3]);
    assert.equal(runArgs.modelName, 'mark3labs/embeddings-gte-base');
    assert.deepEqual(runArgs.args.input.text, 'hello');
});

test('replicate embedding provider can be selected separately', () => {
    const embedding = selectEmbeddingAPI({ provider: 'replicate', model: 'mark3labs/embeddings-gte-base' });
    assert.equal(embedding.api, 'replicate');
    assert.equal(embedding.model, 'mark3labs/embeddings-gte-base');
    assert.equal(embedding.params.apiKeyName, 'REPLICATE_API_KEY');
});
