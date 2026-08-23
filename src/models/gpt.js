import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

// getToolDefs speaks the Anthropic shape ({name, description, input_schema});
// OpenAI wants the same JSON schema wrapped in a function envelope. Exported
// so the shape can be pinned by a test instead of by an API rejection.
export function toOpenAITools(tools) {
    return tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
}

export class GPT {
    static prefix = 'openai';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        this.url = url; // store so that we know whether a custom URL has been set

        let config = {};
        if (url)
            config.baseURL = url;

        if (hasKey('OPENAI_ORG_ID'))
            config.organization = getKey('OPENAI_ORG_ID');

        config.apiKey = getKey('OPENAI_API_KEY');

        this.openai = new OpenAIApi(config);
    }

    // Native tool calling. See the note in claude.js for why this is its own
    // method and not another argument to sendRequest -- here the third
    // parameter is stop_seq, which is exactly the collision that would cause.
    //
    // Always chat.completions, even when no custom url would otherwise send us
    // to the responses endpoint: the two APIs disagree about where a tool's
    // name and parameters live, and one code path that works everywhere beats
    // two that each work half the time.
    async sendToolRequest(turns, systemMessage, tools) {
        const messages = strictFormat([{ role: 'system', content: systemMessage }].concat(turns));
        const model = this.model_name || "gpt-5.4-mini";
        const openai_tools = toOpenAITools(tools);
        try {
            console.log('Awaiting openai api response from model', model, `(${tools.length} tools)`);
            const completion = await this.openai.chat.completions.create({
                model,
                messages,
                tools: openai_tools,
                ...(this.params || {}),
            });
            if (completion.choices[0].finish_reason == 'length')
                throw new Error('Context length exceeded');
            console.log('Received.');
            const choice = completion.choices[0].message;
            const call = choice.tool_calls?.[0];
            if (!call) return choice.content ?? '';
            // Back into the `!name(...)` text the parser already speaks, so
            // nothing downstream of the model has to know tools happened.
            const { serializeToolCall } = await import('../agent/commands/index.js');
            let args = {};
            try { args = JSON.parse(call.function.arguments || '{}'); }
            catch (err) { console.warn('tool arguments were not valid JSON:', call.function.arguments); }
            return `${choice.content ?? ''} ${serializeToolCall(call.function.name, args)}`.trim();
        } catch (err) {
            if ((err.message == 'Context length exceeded' || err.code == 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendToolRequest(turns.slice(1), systemMessage, tools);
            }
            console.log(err);
            return 'My brain disconnected, try again.';
        }
    }

    // extra_params is per-call, for the one caller that needs the reply in a
    // shape rather than in prose. Other providers ignore the argument, which
    // just leaves them where they already were.
    async sendRequest(turns, systemMessage, stop_seq='***', extra_params=null) {
        let messages = strictFormat(turns);
        messages = messages.map(message => {
            message.content += stop_seq;
            return message;
        });
        let model = this.model_name || "gpt-5.4-mini";

        let res = null;

        try {
            console.log('Awaiting openai api response from model', model);
            // if a custom URL is set, use chat.completions
            // because custom "OpenAI-compatible" endpoints likely do not have responses endpoint
            if (this.url) {
                let messages = [{'role': 'system', 'content': systemMessage}].concat(turns);
                messages = strictFormat(messages);
                const pack = {
                    model: model,
                    messages,
                    stop: stop_seq,
                    ...(this.params || {}),
                    ...(extra_params || {})
                };
                if (model.includes('o1') || model.includes('o3') || model.includes('5')) {
                    delete pack.stop;
                }
                let completion = await this.openai.chat.completions.create(pack);
                if (completion.choices[0].finish_reason == 'length')
                    throw new Error('Context length exceeded'); 
                console.log('Received.');
                res = completion.choices[0].message.content;
            } 
            // otherwise, use responses
            else {
                let messages = strictFormat(turns);
                messages = messages.map(message => {
                    message.content += stop_seq;
                    return message;
                });
                const response = await this.openai.responses.create({
                    model: model,
                    instructions: systemMessage,
                    input: messages,
                    ...(this.params || {})
                });
                console.log('Received.');
                res = response.output_text;
                let stop_seq_index = res.indexOf(stop_seq);
                res = stop_seq_index !== -1 ? res.slice(0, stop_seq_index) : res;
            }
        }
        catch (err) {
            if ((err.message == 'Context length exceeded' || err.code == 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
            } else if (err.message.includes('image_url')) {
                console.log(err);
                res = 'Vision is only supported by certain models.';
            } else {
                console.log(err);
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
                { type: "input_text", text: systemMessage },
                {
                    type: "input_image",
                    image_url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
                }
            ]
        });
        
        return this.sendRequest(imageMessages, systemMessage);
    }

    async embed(text) {
        if (text.length > 8191)
            text = text.slice(0, 8191);
        const embedding = await this.openai.embeddings.create({
            model: this.model_name || "text-embedding-3-small",
            input: text,
            encoding_format: "float",
        });
        return embedding.data[0].embedding;
    }

}

const sendAudioRequest = async (text, model, voice, url) => {
    const payload = {
        model: model,
        voice: voice,
        input: text
    }

    let config = {};

    if (url)
        config.baseURL = url;

    if (hasKey('OPENAI_ORG_ID'))
        config.organization = getKey('OPENAI_ORG_ID');

    config.apiKey = getKey('OPENAI_API_KEY');

    const openai = new OpenAIApi(config);

    const mp3 = await openai.audio.speech.create(payload);
    const buffer = Buffer.from(await mp3.arrayBuffer());
    const base64 = buffer.toString("base64");
    return base64;
}

export const TTSConfig = {
    sendAudioRequest: sendAudioRequest,
    baseUrl: 'https://api.openai.com/v1',
}
