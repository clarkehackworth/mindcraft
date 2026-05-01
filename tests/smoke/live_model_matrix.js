#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { selectAPI, createModel } from '../../src/models/_model_map.js';
import { hasCodexChatGPTAuth } from '../../src/models/codex_chatgpt.js';
import { isNativeToolResponse, parseToolArguments } from '../../src/models/native_tools.js';
import { hasKey } from '../../src/utils/keys.js';

const TIMEOUT_MS = Number.parseInt(process.env.LIVE_MODEL_MATRIX_TIMEOUT_MS || '60000', 10);
const CONCURRENCY = Number.parseInt(process.env.LIVE_MODEL_MATRIX_CONCURRENCY || '6', 10);
const OUTPUT_DIR = process.env.LIVE_MODEL_MATRIX_OUTPUT_DIR || 'tests/results';
const OUTPUT_FILE = process.env.LIVE_MODEL_MATRIX_OUTPUT || path.join(OUTPUT_DIR, `live-model-matrix-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
const INCLUDE = process.env.LIVE_MODEL_MATRIX_INCLUDE ? new RegExp(process.env.LIVE_MODEL_MATRIX_INCLUDE, 'i') : null;
const EXCLUDE = process.env.LIVE_MODEL_MATRIX_EXCLUDE ? new RegExp(process.env.LIVE_MODEL_MATRIX_EXCLUDE, 'i') : null;

const providerConfig = JSON.parse(readFileSync('llm_providers.json', 'utf8'));
const profilesDir = path.resolve('profiles');

const tool = {
    type: 'function',
    function: {
        name: 'report_status',
        description: 'Report status for a live model compatibility test.',
        parameters: {
            type: 'object',
            properties: {
                status: { type: 'string', description: 'Use ok if tool calling works.' },
                provider: { type: 'string', description: 'Provider id under test.' }
            },
            required: ['status', 'provider'],
            additionalProperties: false
        }
    }
};

const cases = loadProviderDefaultCases().concat(loadProfileCases());
const selected = cases.filter(testCase => {
    const haystack = `${testCase.profile},${testCase.provider},${testCase.model || ''}`;
    if (INCLUDE && !INCLUDE.test(haystack)) return false;
    if (EXCLUDE && EXCLUDE.test(haystack)) return false;
    return true;
});

const rows = await runWithConcurrency(selected, Math.max(1, CONCURRENCY), runCase);

async function runCase(testCase) {
    const baseRow = {
        profile: testCase.profile,
        provider: testCase.provider || '',
        model: testCase.model || '',
        api_format: providerConfig.models?.[testCase.provider]?.format || '',
        base_url: providerConfig.models?.[testCase.provider]?.baseUrl || '',
        key_name: keyNameFor(testCase.provider),
        available: 'yes',
        chat_status: 'not_run',
        chat_elapsed_ms: '',
        chat_reason: '',
        tool_status: 'not_run',
        tool_elapsed_ms: '',
        tool_reason: '',
        tool_name: '',
        tool_arguments: ''
    };

    const label = `${testCase.profile} | ${testCase.provider} | ${testCase.model}`;
    console.log(`[matrix] start ${label}`);
    const availability = isAvailable(testCase);
    if (!availability.ok) {
        console.log(`[matrix] skip ${label}: ${availability.reason}`);
        return { ...baseRow, available: 'no', chat_status: 'skip', chat_reason: availability.reason, tool_status: 'skip', tool_reason: availability.reason };
    }

    const [chatResult, toolResult] = await Promise.all([
        runChatCheck(testCase),
        runToolCheck(testCase)
    ]);

    const row = {
        ...baseRow,
        chat_status: chatResult.status,
        chat_elapsed_ms: String(chatResult.elapsed_ms),
        chat_reason: chatResult.reason,
        tool_status: toolResult.status,
        tool_elapsed_ms: String(toolResult.elapsed_ms),
        tool_reason: toolResult.reason,
        tool_name: toolResult.tool_name,
        tool_arguments: toolResult.tool_arguments
    };
    console.log(`[matrix] done ${label}: chat=${row.chat_status} tool=${row.tool_status}`);
    return row;
}

async function runChatCheck(testCase) {
    const started = Date.now();
    try {
        const model = createModel(selectAPI(testCase.profileModel));
        const response = await withTimeout(
            model.sendRequest([{ role: 'user', content: 'Reply exactly: ok' }], 'You are running a live chat smoke test.', '***'),
            TIMEOUT_MS
        );
        const text = typeof response === 'string' ? response.trim() : JSON.stringify(response);
        const ok = Boolean(text) && !isKnownFailureText(text) && !isNativeToolResponse(response);
        return {
            status: ok ? 'pass' : 'fail',
            reason: ok ? preview(text, 160) : `bad chat response: ${preview(text, 220)}`,
            elapsed_ms: Date.now() - started
        };
    } catch (error) {
        return { status: 'fail', reason: sanitizeError(error), elapsed_ms: Date.now() - started };
    }
}

async function runToolCheck(testCase) {
    const started = Date.now();
    try {
        const model = createModel(selectAPI(testCase.profileModel));
        const response = await withTimeout(
            model.sendRequest(
                [{ role: 'user', content: `Call report_status with status ok and provider ${testCase.provider || testCase.profile}. Do not answer in text.` }],
                'You are running a live native function-calling smoke test. Use the provided function.',
                '***',
                [tool]
            ),
            TIMEOUT_MS
        );
        if (!isNativeToolResponse(response)) {
            return {
                status: 'fail',
                reason: `no native tool response: ${preview(response, 220)}`,
                elapsed_ms: Date.now() - started,
                tool_name: '',
                tool_arguments: ''
            };
        }
        const call = response.tool_calls?.[0];
        const args = safeParse(call?.arguments);
        const valid = call?.name === 'report_status' && args && typeof args === 'object' && args.status === 'ok';
        return {
            status: valid ? 'pass' : 'fail',
            reason: valid ? '' : 'tool call arguments missing status=ok or wrong tool name',
            elapsed_ms: Date.now() - started,
            tool_name: call?.name || '',
            tool_arguments: typeof args === 'string' ? args : JSON.stringify(args || {})
        };
    } catch (error) {
        return { status: 'fail', reason: sanitizeError(error), elapsed_ms: Date.now() - started, tool_name: '', tool_arguments: '' };
    }
}

async function runWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(OUTPUT_FILE, toCsv(rows));
const summary = summarize(rows);
console.log(JSON.stringify({ output: OUTPUT_FILE, selected: selected.length, summary }, null, 2));

function loadProviderDefaultCases() {
    return Object.entries(providerConfig.models || {})
        .filter(([, config]) => typeof config.defaultModel === 'string' && config.defaultModel.length > 0)
        .map(([provider, config]) => ({
            profile: `@provider-default/${provider}`,
            provider,
            model: config.defaultModel,
            profileModel: { provider, model: config.defaultModel },
            parseError: null
        }));
}

function loadProfileCases() {
    const out = [];
    for (const file of readdirSync(profilesDir).sort()) {
        if (!file.endsWith('.json')) continue;
        const fullPath = path.join(profilesDir, file);
        let profile;
        try {
            profile = JSON.parse(readFileSync(fullPath, 'utf8'));
        } catch (error) {
            out.push({ profile: file, provider: '', model: '', profileModel: {}, parseError: error });
            continue;
        }
        const profileModel = profile.model;
        if (!profileModel) continue;
        let provider = '';
        let model = '';
        if (typeof profileModel === 'object') {
            provider = profileModel.provider || '';
            model = profileModel.model || providerConfig.models?.[provider]?.defaultModel || '';
        } else if (typeof profileModel === 'string') {
            const [maybeProvider, ...rest] = profileModel.split('/');
            provider = providerConfig.models?.[maybeProvider] ? maybeProvider : '';
            model = rest.length > 0 ? rest.join('/') : profileModel;
        }
        out.push({ profile: file, provider, model, profileModel, parseError: null });
    }
    return out;
}

function keyNameFor(provider) {
    return providerConfig.models?.[provider]?.keyName || '';
}

function isAvailable(testCase) {
    if (testCase.parseError) return { ok: false, reason: `parse error: ${testCase.parseError.message}` };
    if (testCase.provider === 'codex') {
        return hasCodexChatGPTAuth() ? { ok: true } : { ok: false, reason: 'Codex auth missing' };
    }
    const keyName = keyNameFor(testCase.provider);
    if (keyName && !hasKey(keyName)) return { ok: false, reason: `${keyName} missing` };
    return { ok: true };
}

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

function isKnownFailureText(text) {
    return [
        'My brain disconnected, try again.',
        'No response received.',
        'No response from Claude.',
        'An unexpected error occurred, please try again.',
        'Azure deployment not found.',
        'Ollama Cloud rejected the request.'
    ].some(marker => text.includes(marker));
}

function sanitizeError(error) {
    const status = error?.status ? `status=${error.status} ` : '';
    const code = error?.code ? `code=${error.code} ` : '';
    const message = error?.error?.message || error?.message || String(error);
    return `${status}${code}${message}`
        .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED_KEY]')
        .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED_TOKEN]')
        .slice(0, 500);
}

function preview(value, max = 180) {
    return String(typeof value === 'string' ? value : JSON.stringify(value)).replace(/\s+/g, ' ').slice(0, max);
}

function toCsv(rows) {
    const headers = ['profile', 'provider', 'model', 'api_format', 'base_url', 'key_name', 'available', 'chat_status', 'chat_elapsed_ms', 'chat_reason', 'tool_status', 'tool_elapsed_ms', 'tool_name', 'tool_arguments', 'tool_reason'];
    return [headers.join(','), ...rows.map(row => headers.map(header => csvCell(row[header] ?? '')).join(','))].join('\n') + '\n';
}

function csvCell(value) {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function summarize(rows) {
    const total = rows.length;
    const bothPass = rows.filter(r => r.chat_status === 'pass' && r.tool_status === 'pass').length;
    const chatPass = rows.filter(r => r.chat_status === 'pass').length;
    const toolPass = rows.filter(r => r.tool_status === 'pass').length;
    const skipped = rows.filter(r => r.available === 'no').length;
    const failed = rows.filter(r => r.available === 'yes' && (r.chat_status !== 'pass' || r.tool_status !== 'pass')).length;
    return { total, bothPass, chatPass, toolPass, skipped, failed };
}
