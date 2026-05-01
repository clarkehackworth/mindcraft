export function isNativeToolResponse(value) {
    return Boolean(value && typeof value === 'object' && value.type === 'tool_calls' && Array.isArray(value.tool_calls));
}

export function createNativeToolResponse(toolCalls, provider = 'unknown') {
    return {
        type: 'tool_calls',
        provider,
        tool_calls: normalizeOpenAIToolCalls(toolCalls)
    };
}

export function normalizeOpenAIToolCalls(toolCalls = []) {
    return toolCalls.map((call, index) => {
        const fn = call.function || {};
        return {
            id: call.id || `call_${Date.now()}_${index}`,
            type: 'function',
            name: fn.name || call.name,
            arguments: normalizeArguments(fn.arguments ?? call.arguments ?? {})
        };
    }).filter(call => call.name);
}

export function normalizeAnthropicToolUse(content = []) {
    return content
        .filter(item => item?.type === 'tool_use')
        .map((item, index) => ({
            id: item.id || `call_${Date.now()}_${index}`,
            type: 'function',
            name: item.name,
            arguments: normalizeArguments(item.input || {})
        }));
}

export function normalizeGeminiFunctionCalls(parts = []) {
    return parts
        .filter(part => part?.functionCall)
        .map((part, index) => ({
            id: `call_${Date.now()}_${index}`,
            type: 'function',
            name: part.functionCall.name,
            arguments: normalizeArguments(part.functionCall.args || {})
        }));
}

export function normalizeMistralToolCalls(toolCalls = []) {
    return toolCalls.map((call, index) => {
        const fn = call.function || {};
        return {
            id: call.id || `call_${Date.now()}_${index}`,
            type: 'function',
            name: fn.name || call.name,
            arguments: normalizeArguments(fn.arguments ?? call.arguments ?? {})
        };
    }).filter(call => call.name);
}

export function normalizeArguments(args) {
    if (typeof args === 'string') {
        return args;
    }
    return JSON.stringify(args || {});
}

export function parseToolArguments(args) {
    if (args == null || args === '') {
        return {};
    }
    if (typeof args === 'object') {
        return args;
    }
    try {
        return JSON.parse(args);
    } catch (error) {
        const jsonObject = extractFirstJsonObject(args);
        if (jsonObject) {
            try {
                return JSON.parse(jsonObject);
            } catch {
                // Preserve the original parse error below; the extracted object
                // was only a best-effort recovery for providers that append
                // proprietary tool-call markers after valid JSON arguments.
            }
        }
        throw new Error(`Tool arguments must be valid JSON: ${error.message}`);
    }
}

function extractFirstJsonObject(value) {
    if (typeof value !== 'string') return null;
    const start = value.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < value.length; i++) {
        const char = value[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (char === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;
        if (char === '{') depth++;
        if (char === '}') {
            depth--;
            if (depth === 0) {
                return value.slice(start, i + 1);
            }
        }
    }
    return null;
}

export function toAnthropicTools(tools = []) {
    return tools.map(tool => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters
    }));
}

export function toGeminiFunctionDeclarations(tools = []) {
    return tools.map(tool => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: cleanGeminiSchema(tool.function.parameters)
    }));
}

function cleanGeminiSchema(schema) {
    if (!schema || typeof schema !== 'object') {
        return schema;
    }
    if (Array.isArray(schema)) {
        return schema.map(cleanGeminiSchema);
    }
    const out = {};
    for (const [key, value] of Object.entries(schema)) {
        if (['additionalProperties', '$schema'].includes(key)) {
            continue;
        }
        out[key] = cleanGeminiSchema(value);
    }
    return out;
}
