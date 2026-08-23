import Anthropic from '@anthropic-ai/sdk';
import { strictFormat } from '../utils/text.js';
import { getKey } from '../utils/keys.js';

export class Claude {
    static prefix = 'anthropic';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};

        let config = {};
        if (url)
            config.baseURL = url;
        
        config.apiKey = getKey('ANTHROPIC_API_KEY');

        this.anthropic = new Anthropic(config);
    }

    // Tool calling lives behind its own method rather than an extra argument to
    // sendRequest: every adapter gives that third parameter a different meaning
    // (gpt.js calls it stop_seq), so a positional `tools` would be a live
    // landmine for the next adapter. Prompter feature-detects this method, so
    // an adapter without it simply keeps the text protocol.
    async sendToolRequest(turns, systemMessage, tools) {
        return this.sendRequest(turns, systemMessage, tools);
    }

    async sendRequest(turns, systemMessage, tools = null) {
        const messages = strictFormat(turns);
        let res = null;
        try {
            console.log(`Awaiting anthropic response from ${this.model_name}...`)
            if (!this.params.max_tokens) {
                if (this.params.thinking?.budget_tokens) {
                    this.params.max_tokens = this.params.thinking.budget_tokens + 1000;
                    // max_tokens must be greater than thinking.budget_tokens
                } else {
                    this.params.max_tokens = 4096;
                }
            }
            const resp = await this.anthropic.messages.create({
                model: this.model_name || "claude-sonnet-4-6",
                system: systemMessage,
                messages: messages,
                ...(tools?.length ? { tools } : {}),
                ...(this.params || {})
            });

            console.log('Received.')
            // Reassemble the text protocol: prose stays prose, and the first
            // tool call is serialized back into `!name(...)` so everything
            // downstream (parser, executor, history) is unchanged. The typed
            // schema is what buys correctness -- the model can no longer
            // misquote an arg or invent a command name.
            const textContent = resp.content.find(content => content.type === 'text');
            const toolUse = resp.content.find(content => content.type === 'tool_use');
            if (toolUse) {
                const { serializeToolCall } = await import('../agent/commands/index.js');
                res = `${textContent?.text ?? ''} ${serializeToolCall(toolUse.name, toolUse.input)}`.trim();
            } else if (textContent) {
                res = textContent.text;
            } else {
                console.warn('No text content found in the response.');
                res = 'No response from Claude.';
            }
        }
        catch (err) {
            if (err.message.includes("does not support image input")) {
                res = "Vision is only supported by certain models.";
            } else {
                res = "My brain disconnected, try again.";
            }
            console.log(err);
        }
        return res;
    }

    async sendVisionRequest(turns, systemMessage, imageBuffer) {
        const imageMessages = [...turns];
        imageMessages.push({
            role: "user",
            content: [
                {
                    type: "text",
                    text: systemMessage
                },
                {
                    type: "image",
                    source: {
                        type: "base64",
                        media_type: "image/jpeg",
                        data: imageBuffer.toString('base64')
                    }
                }
            ]
        });

        return this.sendRequest(imageMessages, systemMessage);
    }

    async embed(text) {
        throw new Error('Embeddings are not supported by Claude.');
    }
}
