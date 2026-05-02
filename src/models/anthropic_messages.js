import Anthropic from '@anthropic-ai/sdk';
import https from 'node:https';
import { getKey } from '../utils/keys.js';
import { createNativeToolResponse, normalizeAnthropicToolUse, toAnthropicMessages, toAnthropicTools } from './native_tools.js';
import { setLastTokenUsage } from './token_usage.js';

// Anthropic Messages protocol implementation.
export class AnthropicMessages {
    static prefix = 'anthropic-messages';

    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};

        const config = {};
        if (url) config.baseURL = url;

        const apiKeyName = this.params.apiKeyName || this.params.api_key_name || 'ANTHROPIC_API_KEY';
        delete this.params.apiKeyName;
        delete this.params.api_key_name;
        config.apiKey = getKey(apiKeyName);
        if (this.params.forceIPv4 || this.params.force_ipv4) {
            config.httpAgent = new https.Agent({ family: 4 });
        }
        delete this.params.forceIPv4;
        delete this.params.force_ipv4;

        this.anthropic = new Anthropic(config);
        this.provider = this.params.provider || this.params.providerName || this.params.provider_name || 'anthropic';
        delete this.params.provider;
        delete this.params.providerName;
        delete this.params.provider_name;
        this.supportsNativeToolCalls = true;
    }

    async sendRequest(turns, systemMessage, stop_seq='***', tools=null) {
        this.lastTokenUsage = null;
        const messages = toAnthropicMessages(turns);
        let res = null;
        try {
            console.log(tools?.length ? `Awaiting anthropic response with native tool calling (${tools.length} tools) from ${this.model_name}...` : `Awaiting anthropic response from ${this.model_name}...`);
            if (!this.params.max_tokens) {
                if (this.params.thinking?.budget_tokens) {
                    this.params.max_tokens = this.params.thinking.budget_tokens + 1000;
                } else {
                    this.params.max_tokens = 4096;
                }
            }
            const requestParams = stripToolChoiceParams(this.params);
            const requestConfig = {
                model: this.model_name || 'claude-sonnet-4-6',
                system: systemMessage,
                messages,
                ...requestParams
            };
            if (Array.isArray(tools) && tools.length > 0) {
                requestConfig.tools = toAnthropicTools(tools);
            }
            const resp = await this.anthropic.messages.create(requestConfig);

            console.log('Received.');
            setLastTokenUsage(this, resp?.usage);
            const toolCalls = normalizeAnthropicToolUse(resp.content);
            if (toolCalls.length > 0) {
                return createNativeToolResponse(toolCalls, this.provider);
            }
            const textContent = resp.content.find(content => content.type === 'text');
            res = textContent ? textContent.text : 'No response from Claude.';
        } catch (err) {
            if (err.message?.includes('does not support image input')) {
                res = 'Vision is only supported by certain models.';
            } else {
                res = 'My brain disconnected, try again.';
            }
            console.log(err);
        }
        return res;
    }

    async sendVisionRequest(turns, systemMessage, imageBuffer) {
        const imageMessages = [...turns];
        imageMessages.push({
            role: 'user',
            content: [
                { type: 'text', text: systemMessage },
                {
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: 'image/jpeg',
                        data: imageBuffer.toString('base64')
                    }
                }
            ]
        });

        return this.sendRequest(imageMessages, systemMessage);
    }

    async embed() {
        throw new Error('Embeddings are not supported by Anthropic Messages. Configure an embedding provider separately.');
    }
}

function stripToolChoiceParams(params) {
    const requestParams = { ...(params || {}) };
    delete requestParams.tool_choice;
    delete requestParams.toolChoice;
    return requestParams;
}
