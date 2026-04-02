import OpenAIApi from 'openai';
import { getKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

export class Perplexity {
    static prefix = 'perplexity';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.url = url;
        this.params = params;

        let config = {};
        if (url)
            config.baseURL = url;
        else
            config.baseURL = "https://api.perplexity.ai";

        config.apiKey = getKey('PERPLEXITY_API_KEY');

        this.openai = new OpenAIApi(config);
    }

    async sendRequest(turns, systemMessage) {
        let messages = [{'role': 'system', 'content': systemMessage}].concat(turns);
        messages = strictFormat(messages);

        const pack = {
            model: this.model_name || "llama-3-sonar-large-32k-online",
            messages,
            ...(this.params || {})
        };

        let res = null;
        try {
            let completion = await this.openai.chat.completions.create(pack);
            if (completion.choices[0].finish_reason == 'length')
                throw new Error('Context length exceeded'); 
            res = completion.choices[0].message.content;
        }
        catch (err) {
            if ((err.message == 'Context length exceeded' || err.code == 'context_length_exceeded') && turns.length > 1) {
                return await this.sendRequest(turns.slice(1), systemMessage);
            } else {
                res = 'My brain disconnected, try again.';
            }
        }
        return res;
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: "user",
            content: [
                { type: "text", text: systemMessage },
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
                    }
                }
            ]
        });
        return this.sendRequest(imageMessages, systemMessage);
    }
    
    async embed(text) {
        throw new Error('Embeddings are not supported by Perplexity.');
    }
}