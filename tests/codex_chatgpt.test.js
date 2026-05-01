import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    CodexChatGPT,
    buildAuthorizeUrl,
    ensureCodexChatGPTAuth,
    hasCodexChatGPTAuth,
    parseCodexResponsesSse,
    readCodexChatGPTAuth,
    runCodexBrowserLogin,
    toCodexResponseItem,
    toCodexResponsesTools,
    writeKeysCodexAuth
} from '../src/models/codex_chatgpt.js';
import { isNativeToolResponse } from '../src/models/native_tools.js';

const tool = {
    type: 'function',
    function: {
        name: 'report_status',
        description: 'Report status',
        parameters: {
            type: 'object',
            properties: { status: { type: 'string' } },
            required: ['status'],
            additionalProperties: false
        }
    }
};

test('Codex adapter converts OpenAI-style tools to Responses API shape', () => {
    assert.deepEqual(toCodexResponsesTools([tool]), [{
        type: 'function',
        name: 'report_status',
        description: 'Report status',
        strict: false,
        parameters: tool.function.parameters
    }]);
});

test('Codex adapter converts chat messages to protocol ResponseItems', () => {
    assert.deepEqual(toCodexResponseItem({ role: 'user', content: 'hi' }), {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hi' }]
    });
    assert.deepEqual(toCodexResponseItem({ role: 'assistant', content: 'hello' }), {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello' }]
    });
});

test('Codex SSE parser extracts Responses function_call events', async () => {
    const sse = [
        'event: response.output_item.done',
        'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"report_status","arguments":"{\\"status\\":\\"ok\\"}"}}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_1"}}',
        ''
    ].join('\n');

    const parsed = await parseCodexResponsesSse(sse);
    assert.equal(parsed.toolCalls[0].function.name, 'report_status');
    assert.equal(parsed.toolCalls[0].function.arguments, '{"status":"ok"}');
});

test('Codex SSE parser prefers text deltas over final message to avoid duplicate text', async () => {
    const sse = [
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"Hi "}',
        '',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"there"}',
        '',
        'event: response.output_item.done',
        'data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hi there"}]}}',
        ''
    ].join('\n');

    const parsed = await parseCodexResponsesSse(sse);
    assert.equal(parsed.text, 'Hi there');
});


test('Codex browser login builds the same authorize URL shape as Codex CLI', () => {
    const url = new URL(buildAuthorizeUrl({
        issuer: 'https://auth.openai.com',
        clientId: 'client-test',
        redirectUri: 'http://localhost:1455/auth/callback',
        pkce: { code_challenge: 'challenge-test' },
        state: 'state-test',
        forcedChatgptWorkspaceId: 'workspace-test',
        originator: 'codex_cli_rs'
    }));

    assert.equal(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), 'client-test');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');
    assert.equal(url.searchParams.get('scope'), 'openid profile email offline_access api.connectors.read api.connectors.invoke');
    assert.equal(url.searchParams.get('code_challenge'), 'challenge-test');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('id_token_add_organizations'), 'true');
    assert.equal(url.searchParams.get('codex_cli_simplified_flow'), 'true');
    assert.equal(url.searchParams.get('state'), 'state-test');
    assert.equal(url.searchParams.get('originator'), 'codex_cli_rs');
    assert.equal(url.searchParams.get('allowed_workspace_id'), 'workspace-test');
});

test('Codex browser login callback exchanges code and persists project keys auth', async () => {
    const { keysPath, cleanup } = writeTempKeys({ includeAuth: false });
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const logs = [];
    const tokenRequests = [];
    globalThis.fetch = async (url, init) => {
        if (String(url).startsWith('http://localhost:')) {
            return originalFetch(url, init);
        }
        tokenRequests.push({ url, init, body: new URLSearchParams(init.body) });
        assert.equal(String(url), 'https://issuer.test/oauth/token');
        assert.equal(tokenRequests[0].body.get('grant_type'), 'authorization_code');
        assert.equal(tokenRequests[0].body.get('code'), 'auth-code-test');
        assert.equal(tokenRequests[0].body.get('client_id'), 'client-test');
        assert.match(tokenRequests[0].body.get('redirect_uri'), /^http:\/\/localhost:\d+\/auth\/callback$/);
        assert.ok(tokenRequests[0].body.get('code_verifier'));
        return new Response(JSON.stringify({
            id_token: 'id-token-test',
            access_token: 'access-token-test',
            refresh_token: 'refresh-token-test',
            account_id: 'account-id-test'
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    console.log = (...args) => { logs.push(args.join(' ')); };

    try {
        const login = runCodexBrowserLogin({
            keysPath,
            issuer: 'https://issuer.test',
            clientId: 'client-test',
            port: 0,
            openBrowser: false
        });
        const authUrl = await waitFor(() => {
            const match = logs.join('\n').match(/https:\/\/issuer\.test\/oauth\/authorize\?\S+/);
            return match?.[0];
        });
        const parsedAuthUrl = new URL(authUrl);
        const redirectUri = parsedAuthUrl.searchParams.get('redirect_uri');
        const state = parsedAuthUrl.searchParams.get('state');
        const callback = await fetch(`${redirectUri}?code=auth-code-test&state=${encodeURIComponent(state)}`);
        assert.equal(callback.status, 200);

        const authJson = await login;
        assert.equal(authJson.tokens.access_token, 'access-token-test');
        assert.equal(readCodexChatGPTAuth(keysPath).accessToken, 'access-token-test');
        assert.equal(tokenRequests.length, 1);
    } finally {
        globalThis.fetch = originalFetch;
        console.log = originalLog;
        cleanup();
    }
});

test('Codex adapter reads ChatGPT login auth from Codex auth.json shape', () => {
    const { keysPath, cleanup } = writeTempKeys();
    try {
        const auth = readCodexChatGPTAuth(keysPath);
        assert.equal(auth.accessToken, 'access-token-test');
        assert.equal(auth.accountId, 'account-id-test');
        assert.equal(hasCodexChatGPTAuth(keysPath), true);
    } finally {
        cleanup();
    }
});

test('Codex adapter can still read raw auth.json style files when explicitly configured', () => {
    const { authPath, cleanup } = writeTempRawAuth();
    try {
        const auth = readCodexChatGPTAuth(authPath);
        assert.equal(auth.accessToken, 'access-token-test');
        assert.equal(auth.accountId, 'account-id-test');
        assert.equal(hasCodexChatGPTAuth(authPath), true);
    } finally {
        cleanup();
    }
});

test('Codex adapter still supports legacy unified llm_providers.json auth storage', () => {
    const { keysPath, dir, cleanup } = writeTempKeys({ includeAuth: false });
    try {
        writeKeysCodexAuth(keysPath, authFixture());
        assert.equal(existsSync(path.join(dir, '.mindcraft')), false);
        const auth = readCodexChatGPTAuth(keysPath);
        assert.equal(auth.accessToken, 'access-token-test');
    } finally {
        cleanup();
    }
});


test('Codex adapter defaults to project llm_providers.json instead of ~/.codex auth', () => {
    const model = new CodexChatGPT('gpt-5.5', 'https://example.test/backend-api/codex', {});
    assert.equal(model.authPath, 'llm_providers.json');
    assert.equal(model.keysPath, 'llm_providers.json');
});

test('Codex adapter starts local login runner when configured auth path is missing', async () => {
    const { keysPath, cleanup } = writeTempKeys({ includeAuth: false });
    let called = false;
    try {
        const auth = await ensureCodexChatGPTAuth({
            keysPath,
            allowLogin: true,
            loginRunner: async ({ keysPath: loginKeysPath }) => {
                called = loginKeysPath === keysPath;
                return authFixture();
            }
        });
        assert.equal(called, true);
        assert.equal(auth.accessToken, 'access-token-test');
        assert.equal(readCodexChatGPTAuth(keysPath).accountId, 'account-id-test');
    } finally {
        cleanup();
    }
});

test('Codex adapter sends native-login Responses request and normalizes tool call', async () => {
    const { keysPath, cleanup } = writeTempKeys();
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, init) => {
        requests.push({ url, init, body: JSON.parse(init.body) });
        return new Response([
            'event: response.output_item.done',
            'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"report_status","arguments":"{\\"status\\":\\"ok\\"}"}}',
            '',
            'event: response.completed',
            'data: {"type":"response.completed","response":{"id":"resp_1"}}',
            ''
        ].join('\n'), {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
        });
    };

    try {
        const model = new CodexChatGPT('gpt-5.5', 'https://example.test/backend-api/codex', { keysPath, sessionId: 'session-test' });
        const response = await model.sendRequest(
            [{ role: 'user', content: 'call the tool' }],
            'Use the function.',
            '***',
            [tool]
        );
        assert.equal(isNativeToolResponse(response), true);
        assert.equal(response.tool_calls[0].name, 'report_status');
        assert.equal(requests[0].url, 'https://example.test/backend-api/codex/responses');
        assert.equal(requests[0].init.headers.Authorization, 'Bearer access-token-test');
        assert.equal(requests[0].init.headers['ChatGPT-Account-ID'], 'account-id-test');
        assert.equal(requests[0].init.headers.originator, 'codex_cli_rs');
        assert.equal(requests[0].body.tools[0].name, 'report_status');
        assert.equal(Object.prototype.hasOwnProperty.call(requests[0].body, 'tool_choice'), false);
        assert.equal(requests[0].body.stream, true);
    } finally {
        globalThis.fetch = originalFetch;
        cleanup();
    }
});

test('Codex adapter keeps prompt cache key stable across multi-turn tool replay', () => {
    const model = new CodexChatGPT('gpt-5.5', 'https://example.test/backend-api/codex', {
        keysPath: 'llm_providers.json',
        sessionId: 'stable-cache-session'
    });
    const turns = [
        { role: 'user', content: 'inspect inventory' },
        {
            role: 'assistant',
            content: '*used inventory*',
            native_tool_calls: [{ id: 'call_1', type: 'function', name: 'inventory', arguments: '{}' }]
        },
        { role: 'tool', tool_call_id: 'call_1', name: 'inventory', content: '{"oak_log":0}' },
        { role: 'user', content: 'collect wood' },
        {
            role: 'assistant',
            content: '*used collectBlocks*',
            native_tool_calls: [{ id: 'call_2', type: 'function', name: 'collectBlocks', arguments: '{"block":"oak_log","count":2}' }]
        },
        { role: 'tool', tool_call_id: 'call_2', name: 'collectBlocks', content: 'Collected 2 oak logs.' }
    ];

    const first = model.buildRequestBody('gpt-5.5', turns, 'Use tools.', [tool]);
    const second = model.buildRequestBody('gpt-5.5', turns, 'Use tools.', [tool]);

    assert.equal(first.prompt_cache_key, 'stable-cache-session');
    assert.equal(second.prompt_cache_key, 'stable-cache-session');
    assert.deepEqual(second.input, first.input);
    assert.deepEqual(
        first.input.filter(item => item.type === 'function_call' || item.type === 'function_call_output').map(item => item.call_id),
        ['call_1', 'call_1', 'call_2', 'call_2']
    );
});

async function waitFor(fn, timeoutMs = 1000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const value = fn();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for condition');
}

function writeTempKeys({ includeAuth = true } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'codex-keys-test-'));
    const keysPath = path.join(dir, 'llm_providers.json');
    const keys = { OPENAI_API_KEY: '' };
    if (includeAuth) keys.CODEX_CHATGPT_AUTH = authFixture();
    writeFileSync(keysPath, JSON.stringify(keys));
    return {
        dir,
        keysPath,
        cleanup: () => rmSync(dir, { recursive: true, force: true })
    };
}

function writeTempRawAuth() {
    const dir = mkdtempSync(path.join(tmpdir(), 'codex-auth-test-'));
    const authPath = path.join(dir, 'auth.json');
    writeFileSync(authPath, JSON.stringify(authFixture()));
    return {
        dir,
        authPath,
        cleanup: () => rmSync(dir, { recursive: true, force: true })
    };
}

function authFixture() {
    return {
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
            id_token: 'id-token-test',
            access_token: 'access-token-test',
            refresh_token: 'refresh-token-test',
            account_id: 'account-id-test'
        },
        last_refresh: '2026-04-30T00:00:00Z'
    };
}
