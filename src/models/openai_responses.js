import { OpenAICompletions } from './openai_compatible.js';
import { strictFormat } from '../utils/text.js';
import { createNativeToolResponse } from './native_tools.js';

// OpenClaw-style OpenAI Responses protocol. For native tool calls this class
// uses Responses API function-call items directly instead of the legacy GPT file.
export class OpenAIResponses extends OpenAICompletions {
    static prefix = 'openai-responses';

    async sendRequest(turns, systemMessage, stop_seq='***', tools=null) {
        const model = this.model_name || this.default_model;
        const hasTools = Array.isArray(tools) && tools.length > 0;
        const input = strictFormat(turns).map(message => ({ ...message, content: stop_seq && !hasTools ? message.content + stop_seq : message.content }));
        const request = {
            model,
            instructions: systemMessage,
            input,
            ...stripToolChoiceParams(this.params)
        };
        if (hasTools) {
            request.tools = toResponsesTools(tools);
        }

        try {
            console.log(hasTools
                ? `Awaiting ${this.provider} Responses API with native tool calling (${tools.length} tools) from model ${model}`
                : `Awaiting ${this.provider} Responses API from model ${model}`);
            const response = await this.openai.responses.create(request);
            console.log('Received.');
            const toolCalls = normalizeResponsesToolCalls(response);
            if (toolCalls.length > 0) {
                return createNativeToolResponse(toolCalls, this.provider);
            }
            let res = response.output_text || '';
            const stopSeqIndex = stop_seq ? res.indexOf(stop_seq) : -1;
            return stopSeqIndex !== -1 ? res.slice(0, stopSeqIndex) : res;
        } catch (err) {
            if ((err.message === 'Context length exceeded' || err.code === 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq, tools);
            }
            console.log(err);
            return 'My brain disconnected, try again.';
        }
    }
}

function toResponsesTools(tools = []) {
    return tools.map(tool => ({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters
    }));
}

function normalizeResponsesToolCalls(response) {
    const output = response?.output || [];
    return output
        .filter(item => item?.type === 'function_call')
        .map((item, index) => ({
            id: item.call_id || item.id || `call_${Date.now()}_${index}`,
            type: 'function',
            name: item.name,
            arguments: item.arguments || '{}'
        }))
        .filter(call => call.name);
}

function stripToolChoiceParams(params) {
    const requestParams = { ...(params || {}) };
    delete requestParams.tool_choice;
    delete requestParams.toolChoice;
    return requestParams;
}
