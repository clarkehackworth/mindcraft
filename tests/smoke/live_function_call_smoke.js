#!/usr/bin/env node
import { selectAPI, createModel } from '../../src/models/_model_map.js';
import { hasCodexChatGPTAuth } from '../../src/models/codex_chatgpt.js';
import { isNativeToolResponse, parseToolArguments } from '../../src/models/native_tools.js';
import { hasKey } from '../../src/utils/keys.js';

const TIMEOUT_MS = Number.parseInt(process.env.LIVE_FUNCTION_CALL_TIMEOUT_MS || '45000', 10);

const tools = [{
    type: 'function',
    function: {
        name: 'report_status',
        description: 'Report a short status for a live native function-calling smoke test.',
        parameters: {
            type: 'object',
            properties: {
                status: { type: 'string', description: 'Use ok if function calling works.' },
                provider: { type: 'string', description: 'The provider or route under test.' }
            },
            required: ['status', 'provider'],
            additionalProperties: false
        }
    }
}];


function providerCase(name, key, provider, model, params = undefined, available = undefined) {
    return {
        name,
        key,
        ...(available ? { available } : {}),
        create: () => createModel(selectAPI({
            provider,
            model,
            ...(params ? { params } : {})
        }))
    };
}

const cases = [
    {
        name: 'codex-chatgpt:gpt-5.5',
        key: 'CODEX_CHATGPT_AUTH',
        available: () => hasCodexChatGPTAuth(),
        create: () => createModel(selectAPI({ provider: 'codex', model: 'gpt-5.5' }))
    },
    providerCase('openai:gpt-5.5', 'OPENAI_API_KEY', 'openai', 'gpt-5.5', { reasoning: { effort: 'medium' } }),
    providerCase('siliconflow:deepseek-ai/DeepSeek-V4-Flash', 'SILICONFLOW_API_KEY', 'siliconflow', 'deepseek-ai/DeepSeek-V4-Flash'),
    providerCase('siliconflow:Pro/deepseek-ai/DeepSeek-R1', 'SILICONFLOW_API_KEY', 'siliconflow', 'Pro/deepseek-ai/DeepSeek-R1'),
    providerCase('siliconflow:THUDM/GLM-Z1-32B-0414', 'SILICONFLOW_API_KEY', 'siliconflow', 'THUDM/GLM-Z1-32B-0414'),
    providerCase('qwen_cn:qwen-max', 'QWEN_API_KEY', 'qwen_cn', 'qwen-max'),
    providerCase('deepseek:deepseek-v4-pro', 'DEEPSEEK_API_KEY', 'deepseek', 'deepseek-v4-pro'),
    providerCase('openrouter:openai/gpt-5.5', 'OPENROUTER_API_KEY', 'openrouter', 'openai/gpt-5.5'),
    providerCase('xai:grok-4-fast-reasoning', 'XAI_API_KEY', 'xai', 'grok-4-fast-reasoning'),
    providerCase('minimax_cn:MiniMax-M2.7', 'MINIMAX_CN_API_KEY', 'minimax_cn', 'MiniMax-M2.7'),
    providerCase('kimi:kimi-k2.6', 'KIMI_API_KEY', 'kimi', 'kimi-k2.6'),
    providerCase('hyperbolic:Qwen/Qwen3-Coder-480B-A35B-Instruct', 'HYPERBOLIC_API_KEY', 'hyperbolic', 'Qwen/Qwen3-Coder-480B-A35B-Instruct'),
    providerCase('huggingface:meta-llama/Llama-3.3-70B-Instruct', 'HUGGINGFACE_API_KEY', 'huggingface', 'meta-llama/Llama-3.3-70B-Instruct:novita'),
    providerCase('novita:deepseek/deepseek-v4-flash', 'NOVITA_API_KEY', 'novita', 'deepseek/deepseek-v4-flash'),
    providerCase('mercury:mercury-coder-small', 'MERCURY_API_KEY', 'mercury', 'mercury-coder-small'),
    providerCase('groq:qwen/qwen3-32b', 'GROQCLOUD_API_KEY', 'groq', 'qwen/qwen3-32b'),
    providerCase('cerebras:qwen-3-235b-a22b-instruct-2507', 'CEREBRAS_API_KEY', 'cerebras', 'qwen-3-235b-a22b-instruct-2507'),
    providerCase('mistral:mistral-small-latest', 'MISTRAL_API_KEY', 'mistral', 'mistral-small-latest'),
    providerCase('gemini:gemini-3-flash-preview', 'GEMINI_API_KEY', 'google', 'gemini-3-flash-preview')
];

const includeRegex = process.env.LIVE_FUNCTION_CALL_INCLUDE ? new RegExp(process.env.LIVE_FUNCTION_CALL_INCLUDE, 'i') : null;
const excludeRegex = process.env.LIVE_FUNCTION_CALL_EXCLUDE ? new RegExp(process.env.LIVE_FUNCTION_CALL_EXCLUDE, 'i') : null;
const selectedCases = cases.filter(testCase => {
    if (includeRegex && !includeRegex.test(testCase.name)) return false;
    if (excludeRegex && excludeRegex.test(testCase.name)) return false;
    return true;
});

const results = [];

for (const testCase of selectedCases) {
    if (typeof testCase.available === 'function' && !testCase.available()) {
        results.push({ name: testCase.name, status: 'skip', reason: `${testCase.key} missing` });
        continue;
    }
    if (!testCase.available && !hasKey(testCase.key)) {
        results.push({ name: testCase.name, status: 'skip', reason: `${testCase.key} missing` });
        continue;
    }

    const started = Date.now();
    try {
        const model = testCase.create();
        const response = await withTimeout(
            model.sendRequest(
                [{ role: 'user', content: `Call report_status with status ok and provider ${testCase.name}. Do not answer in text.` }],
                'You are running a live function-calling smoke test. Use the provided function.',
                '***',
                tools
            ),
            TIMEOUT_MS
        );
        if (!isNativeToolResponse(response)) {
            results.push({
                name: testCase.name,
                status: 'fail',
                reason: `no native tool response: ${preview(response)}`,
                elapsed_ms: Date.now() - started
            });
            continue;
        }
        const call = response.tool_calls[0];
        const parsedArgs = safeParse(call?.arguments);
        const validArgs = parsedArgs && typeof parsedArgs === 'object' && parsedArgs.status === 'ok';
        results.push({
            name: testCase.name,
            status: call?.name === 'report_status' && validArgs ? 'pass' : 'fail',
            tool_name: call?.name,
            arguments: parsedArgs,
            reason: validArgs ? undefined : 'tool call arguments were missing, malformed, or did not include status=ok',
            elapsed_ms: Date.now() - started
        });
    } catch (error) {
        results.push({
            name: testCase.name,
            status: 'fail',
            reason: sanitizeError(error),
            elapsed_ms: Date.now() - started
        });
    }
}

const summary = {
    totals: {
        pass: results.filter(result => result.status === 'pass').length,
        fail: results.filter(result => result.status === 'fail').length,
        skip: results.filter(result => result.status === 'skip').length
    },
    selected: selectedCases.length,
    results
};

console.log(JSON.stringify(summary, null, 2));
if (summary.totals.fail > 0) {
    process.exit(1);
}
process.exit(0);

function withTimeout(promise, timeoutMs) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs))
    ]);
}

function safeParse(value) {
    try {
        return parseToolArguments(value);
    } catch {
        return value;
    }
}

function preview(value) {
    return String(typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 180);
}

function sanitizeError(error) {
    const status = error?.status ? `status=${error.status} ` : '';
    const code = error?.code ? `code=${error.code} ` : '';
    const message = error?.error?.message || error?.message || String(error);
    return `${status}${code}${message}`.replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED_KEY]').slice(0, 300);
}
