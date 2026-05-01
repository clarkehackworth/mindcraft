import { GoogleGenAI } from '@google/genai';
import { strictFormat } from '../utils/text.js';
import { getKey } from '../utils/keys.js';
import { createNativeToolResponse, normalizeGeminiFunctionCalls, toGeminiFunctionDeclarations } from './native_tools.js';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

function setupGeminiProxy() {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    if (proxyUrl) {
        setGlobalDispatcher(new ProxyAgent(proxyUrl));
    }
}
setupGeminiProxy();

// OpenClaw-style Google Generative AI protocol implementation.
export class GoogleGenerativeAI {
    static prefix = 'google-generative-ai';

    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};
        const apiKeyName = this.params.apiKeyName || this.params.api_key_name || 'GEMINI_API_KEY';
        delete this.params.apiKeyName;
        delete this.params.api_key_name;
        this.safetySettings = [
            { category: 'HARM_CATEGORY_DANGEROUS', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ];

        this.genAI = new GoogleGenAI({ apiKey: getKey(apiKeyName) });
        this.provider = 'google';
        this.supportsNativeToolCalls = true;
    }

    async sendRequest(turns, systemMessage, stop_seq='***', tools=null) {
        console.log(tools?.length ? `Awaiting Google API response with native tool calling (${tools.length} tools)...` : 'Awaiting Google API response...');

        turns = strictFormat(turns);
        const contents = turns.map(turn => ({
            role: turn.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: turn.content }]
        }));

        const requestConfig = {
            model: this.model_name || 'gemini-2.5-flash',
            contents,
            safetySettings: this.safetySettings,
            config: {
                systemInstruction: systemMessage,
                ...(this.params || {})
            }
        };
        if (Array.isArray(tools) && tools.length > 0) {
            requestConfig.config.tools = [{ functionDeclarations: toGeminiFunctionDeclarations(tools) }];
        }
        const result = await this.genAI.models.generateContent(requestConfig);
        const parts = result.candidates?.[0]?.content?.parts || [];
        const toolCalls = normalizeGeminiFunctionCalls(parts);
        if (toolCalls.length > 0) {
            return createNativeToolResponse(toolCalls, this.provider);
        }
        const response = await result.text;

        console.log('Received.');
        return response;
    }

    async sendVisionRequest(turns, systemMessage, imageBuffer) {
        const imagePart = {
            inlineData: {
                data: imageBuffer.toString('base64'),
                mimeType: 'image/jpeg'
            }
        };

        turns = strictFormat(turns);
        const contents = turns.map(turn => ({
            role: turn.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: turn.content }]
        }));
        contents.push({
            role: 'user',
            parts: [{ text: 'SYSTEM: Vision response' }, imagePart]
        });

        let res = null;
        try {
            console.log('Awaiting Google API vision response...');
            const result = await this.genAI.models.generateContent({
                model: this.model_name,
                contents,
                safetySettings: this.safetySettings,
                generationConfig: {
                    ...(this.params || {})
                },
                systemInstruction: systemMessage
            });
            res = await result.text;
            console.log('Received.');
        } catch (err) {
            console.log(err);
            if (err.message.includes('Image input modality is not enabled for models/')) {
                res = 'Vision is only supported by certain models.';
            } else {
                res = 'An unexpected error occurred, please try again.';
            }
        }
        return res;
    }

    async embed(text) {
        const result = await this.genAI.models.embedContent({
            model: this.model_name || 'gemini-embedding-001',
            contents: text,
        });
        return result.embeddings;
    }
}

const sendAudioRequest = async (text, model, voice) => {
    const ai = new GoogleGenAI({ apiKey: getKey('GEMINI_API_KEY') });

    const response = await ai.models.generateContent({
        model,
        contents: [{ parts: [{ text }] }],
        config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: voice },
                },
            },
        },
    });

    const pcmBase64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!pcmBase64) {
        console.warn('Gemini TTS: no audio data returned');
        return null;
    }

    const pcmBuffer = Buffer.from(pcmBase64, 'base64');
    const wavHeader = createWavHeader(pcmBuffer.length, 24000, 1, 16);
    return Buffer.concat([wavHeader, pcmBuffer]).toString('base64');
};

function createWavHeader(dataLength, sampleRate, channels, bitsPerSample) {
    const header = Buffer.alloc(44);
    const byteRate = sampleRate * channels * bitsPerSample / 8;
    const blockAlign = channels * bitsPerSample / 8;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataLength, 40);
    return header;
}

export const TTSConfig = {
    sendAudioRequest,
    baseUrl: undefined,
};
