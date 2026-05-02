import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { createNativeToolResponse, toOpenAIChatMessages } from './native_tools.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { setLastTokenUsage } from './token_usage.js';

function getProxyAgent() {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    if (proxyUrl) {
        return new HttpsProxyAgent(proxyUrl);
    }
    return undefined;
}

/**
 * OpenAI Chat Completions protocol implementation.
 *
 * This is the single transport used by OpenAI and OpenAI-compatible hosted
 * providers such as OpenRouter, SiliconFlow, Qwen, DeepSeek, Groq, Mistral,
 * Mercury, Hyperbolic, Novita, HuggingFace router, Ollama /v1, vLLM /v1.
 * Provider identity, baseUrl and keyName live in settings_llm_providers.json; profiles
 * only select provider/model.
 */
export class OpenAICompletions {
    static prefix = 'openai-completions';

    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};
        this.url = url;
        this.provider = 'openai';
        this.default_model = 'gpt-5.4-mini';
        this.supportsNativeToolCalls = true;
        this.initClient();
    }

    initClient() {
        this.params = this.params || {};
        const apiKeyName = this.params.apiKeyName || this.params.api_key_name || 'OPENAI_API_KEY';
        this.provider = this.params.provider || this.params.providerName || this.params.provider_name || inferProviderName(this.url) || 'openai';
        this.default_model = this.params.defaultModel || this.params.default_model || this.default_model || this.model_name;

        delete this.params.apiKeyName;
        delete this.params.api_key_name;
        delete this.params.provider;
        delete this.params.providerName;
        delete this.params.provider_name;
        delete this.params.defaultModel;
        delete this.params.default_model;

        const config = {};
        if (this.url) config.baseURL = this.url;
        if (hasKey('OPENAI_ORG_ID')) config.organization = getKey('OPENAI_ORG_ID');
        config.apiKey = apiKeyName ? getKey(apiKeyName) : 'not-needed';
        const agent = getProxyAgent();
        if (agent) config.httpAgent = agent;
        this.openai = new OpenAIApi(config);
    }

    async sendRequest(turns, systemMessage, stop_seq='***', tools=null) {
        this.lastTokenUsage = null;
        const model = this.model_name || this.default_model;
        const hasTools = Array.isArray(tools) && tools.length > 0;
        let res = null;

        try {
            const messages = toOpenAIChatMessages(turns, systemMessage);
            const pack = {
                model,
                messages,
                ...toOpenAIChatRequestParams(this.params, this.provider)
            };
            if (hasTools) {
                pack.tools = tools;
            } else if (stop_seq) {
                pack.stop = Array.isArray(stop_seq) ? stop_seq : [stop_seq];
            }
            if (model.includes('o1') || model.includes('o3') || model.includes('5') || this.provider === 'xai') {
                delete pack.stop;
            }
            console.log(hasTools
                ? `Awaiting ${this.provider} response with native tool calling (${tools.length} tools) from model ${model}`
                : `Awaiting ${this.provider} api response from model ${model}`);
            const completion = await this.openai.chat.completions.create(pack);
            const choice = completion?.choices?.[0];
            if (!choice) return 'No response received.';
            if (choice.finish_reason === 'length') throw new Error('Context length exceeded');
            console.log('Received.');
            setLastTokenUsage(this, completion?.usage);
            const message = choice.message;
            if (message?.tool_calls?.length) {
                return createNativeToolResponse(message.tool_calls, this.provider);
            }
            res = message?.content || '';
        } catch (err) {
            if ((err.message === 'Context length exceeded' || err.code === 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq, tools);
            } else if (err.message?.includes('image_url')) {
                console.log(err);
                res = 'Vision is only supported by certain models.';
            } else {
                console.log(err);
                res = providerFacingError(err, this.provider);
            }
        }
        return res;
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: 'user',
            content: [
                { type: 'text', text: systemMessage },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}` } }
            ]
        });
        return this.sendRequest(imageMessages, systemMessage);
    }

    async embed(text) {
        if (text.length > 8191) text = text.slice(0, 8191);
        const embedding = await this.openai.embeddings.create({
            model: this.model_name || 'text-embedding-3-small',
            input: text,
            encoding_format: 'float',
            ...toOpenAIChatRequestParams(this.params, this.provider)
        });
        return embedding.data[0].embedding;
    }
}

// Backward-compatible alias for old configs/tests. New configs should use
// the protocol name: openai-completions.
export class OpenAICompatible extends OpenAICompletions {
    static prefix = 'openai-compatible';
}

const sendAudioRequest = async (text, model, voice, url) => {
    const payload = { model, voice, input: text };
    const config = {};
    if (url) config.baseURL = url;
    if (hasKey('OPENAI_ORG_ID')) config.organization = getKey('OPENAI_ORG_ID');
    config.apiKey = getKey('OPENAI_API_KEY');
    const openai = new OpenAIApi(config);
    const mp3 = await openai.audio.speech.create(payload);
    const buffer = Buffer.from(await mp3.arrayBuffer());
    return buffer.toString('base64');
};

export const TTSConfig = {
    sendAudioRequest,
    baseUrl: 'https://api.openai.com/v1',
};


function providerFacingError(err, provider) {
    if (provider === 'azure' && (err?.code === 'DeploymentNotFound' || err?.error?.code === 'DeploymentNotFound')) {
        return 'Azure deployment not found. Check the Azure deployment name configured for this profile.';
    }
    if (provider === 'ollama_cloud' && err?.status === 403) {
        return 'Ollama Cloud rejected the request. Check that OLLAMA_API_KEY has subscription access to the selected cloud model.';
    }
    return 'My brain disconnected, try again.';
}

function toOpenAIChatRequestParams(params, provider) {
    const requestParams = { ...(params || {}) };
    delete requestParams.tool_choice;
    delete requestParams.toolChoice;

    // User-facing config follows OpenAI Responses/Codex shape:
    // { reasoning: { effort: "medium" } }. Chat Completions expects
    // reasoning_effort instead, and rejects the nested reasoning object.
    if (requestParams.reasoning?.effort && provider === 'openai') {
        requestParams.reasoning_effort = requestParams.reasoning.effort;
        delete requestParams.reasoning;
    }
    return requestParams;
}

function inferProviderName(url) {
    if (!url) return null;
    try {
        const host = new URL(url).hostname.replace(/^api\./, '').replace(/^dashscope\./, 'qwen.');
        const first = host.split('.')[0];
        return first || null;
    } catch {
        return null;
    }
}
