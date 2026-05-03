import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { createServer } from 'http';
import { createHash, randomBytes, randomUUID } from 'crypto';
import WebSocket from 'ws';
import open from 'open';
import { createNativeToolResponse, normalizeThinkingText, toResponsesInputItems } from './native_tools.js';
import { setLastTokenUsage } from './token_usage.js';

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_KEYS_PATH = 'settings_llm_providers.json';
const CODEX_REFRESH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_ISSUER = 'https://auth.openai.com';
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_AUTH_KEY = 'CODEX_CHATGPT_AUTH';
const DEFAULT_ORIGINATOR = 'codex_cli_rs';
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_LOGIN_PORT = 1455;
const DEFAULT_FETCH = globalThis.fetch;
const RESPONSES_WEBSOCKET_BETA_HEADER_VALUE = 'responses_websockets=2026-02-06';
const DEFAULT_WEBSOCKET_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const CONTINUITY_BASELINE_INPUT = Symbol('codexContinuityBaselineInput');

export class CodexChatGPT {
    static prefix = 'codex';

    constructor(model_name, url, params = {}) {
        this.model_name = model_name;
        this.url = trimTrailingSlash(url || params?.baseUrl || params?.base_url || DEFAULT_CODEX_BASE_URL);
        this.params = { ...(params || {}) };
        delete this.params.baseUrl;
        delete this.params.base_url;
        this.provider = 'codex-chatgpt';
        this.default_model = 'gpt-5.5';
        this.supportsNativeToolCalls = true;
        this.authPath = expandHomePath(
            this.params.authPath ||
            this.params.auth_path ||
            this.params.codexAuthPath ||
            this.params.codex_auth_path ||
            this.params.keysPath ||
            this.params.keys_path ||
            DEFAULT_KEYS_PATH
        );
        this.keysPath = this.authPath;
        this.allowLogin = this.params.allowLogin ?? this.params.allow_login ?? true;
        this.loginRunner = this.params.loginRunner;
        this.issuer = this.params.issuer || CODEX_ISSUER;
        this.clientId = this.params.clientId || this.params.client_id || CODEX_OAUTH_CLIENT_ID;
        this.loginPort = Number.parseInt(this.params.loginPort || this.params.login_port || DEFAULT_LOGIN_PORT, 10);
        this.openBrowser = this.params.openBrowser ?? this.params.open_browser ?? true;
        this.forcedChatgptWorkspaceId = this.params.forcedChatgptWorkspaceId || this.params.forced_chatgpt_workspace_id;
        delete this.params.keysPath;
        delete this.params.keys_path;
        delete this.params.authPath;
        delete this.params.auth_path;
        delete this.params.codexAuthPath;
        delete this.params.codex_auth_path;
        delete this.params.allowLogin;
        delete this.params.allow_login;
        delete this.params.loginRunner;
        delete this.params.issuer;
        delete this.params.clientId;
        delete this.params.client_id;
        delete this.params.loginPort;
        delete this.params.login_port;
        delete this.params.openBrowser;
        delete this.params.open_browser;
        delete this.params.forcedChatgptWorkspaceId;
        delete this.params.forced_chatgpt_workspace_id;
        this.sessionIdWasExplicit = Boolean(this.params.sessionId || this.params.session_id);
        this.sessionId = this.params.sessionId || this.params.session_id || randomUUID();
        delete this.params.sessionId;
        delete this.params.session_id;
        this.originator = this.params.originator || process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || DEFAULT_ORIGINATOR;
        delete this.params.originator;
        const transport = String(this.params.transport || this.params.codexTransport || this.params.codex_transport || '').toLowerCase();
        const webSocketParam = this.params.responsesWebSocket ?? this.params.responses_websocket ?? this.params.useResponsesWebSocket ?? this.params.use_responses_websocket;
        this.useResponsesWebSocket = webSocketParam ?? (transport ? transport === 'websocket' || transport === 'ws' : isChatGptCodexUrl(this.url));
        this.responsesWebSocketDisabled = transport === 'http' || transport === 'https';
        this.responsesWebSocket = null;
        this.responsesWebSocketHeaders = null;
        this.responsesWebSocketIdleTimeoutMs = Number.parseInt(this.params.responsesWebSocketIdleTimeoutMs || this.params.responses_websocket_idle_timeout_ms || DEFAULT_WEBSOCKET_IDLE_TIMEOUT_MS, 10);
        delete this.params.transport;
        delete this.params.codexTransport;
        delete this.params.codex_transport;
        delete this.params.responsesWebSocket;
        delete this.params.responses_websocket;
        delete this.params.useResponsesWebSocket;
        delete this.params.use_responses_websocket;
        delete this.params.responsesWebSocketIdleTimeoutMs;
        delete this.params.responses_websocket_idle_timeout_ms;
        this.enablePreviousResponseId = Boolean(this.params.enablePreviousResponseId || this.params.enable_previous_response_id);
        delete this.params.enablePreviousResponseId;
        delete this.params.enable_previous_response_id;
        this.turnStateByKey = new Map();
        this.responseContinuityByKey = new Map();
        this.lastRequestCacheTrace = null;
    }

    setSessionIdentity(identity) {
        if (this.sessionIdWasExplicit) return;
        const value = String(identity || '').trim();
        if (value) this.sessionId = value;
    }

    async sendRequest(turns, systemMessage, stop_seq='***', tools=null, options = {}) {
        this.lastTokenUsage = null;
        this.lastThinking = '';
        const model = this.model_name || this.default_model;
        const hasTools = Array.isArray(tools) && tools.length > 0;
        const body = this.buildRequestBody(model, turns, systemMessage, tools, options);
        const endpoint = `${this.url}/responses`;

        console.log(hasTools
            ? `Awaiting Codex ChatGPT native-login response with tool calling (${tools.length} tools) from model ${model}`
            : `Awaiting Codex ChatGPT native-login response from model ${model}`);

        try {
            let auth = await ensureCodexChatGPTAuth({
                authPath: this.authPath,
                allowLogin: this.allowLogin,
                loginRunner: this.loginRunner,
                issuer: this.issuer,
                clientId: this.clientId,
                port: this.loginPort,
                openBrowser: this.openBrowser,
                forcedChatgptWorkspaceId: this.forcedChatgptWorkspaceId,
                originator: this.originator
            });
            let response = await this.fetchResponses(endpoint, body, auth, options);
            if (response.status === 401 && auth.refreshToken) {
                auth = await refreshCodexChatGPTAuth(auth, this.authPath, this.originator);
                response = await this.fetchResponses(endpoint, body, auth, options);
            }
            if (!response.ok) {
                throw await codexHttpError(response);
            }
            this.rememberTurnState(options, response);

            const parsed = await parseCodexResponsesSse(await response.text());
            this.rememberResponseContinuity(this.lastSentResponsesOptions || options, this.lastSentResponsesBody || body, parsed);
            console.log('Received.');
            setLastTokenUsage(this, parsed.usage);
            this.lastThinking = parsed.thinking || '';
            if (parsed.toolCalls.length > 0) {
                return createNativeToolResponse(parsed.toolCalls, this.provider, { thinking: this.lastThinking });
            }
            let text = parsed.text;
            if (stop_seq && text.includes(stop_seq)) {
                text = text.slice(0, text.indexOf(stop_seq));
            }
            return text || 'No response received.';
        } catch (err) {
            if (isAbortError(err)) {
                console.log('Codex ChatGPT request aborted.');
                throw err;
            }
            console.log(sanitizeCodexError(err));
            return 'My brain disconnected, try again.';
        }
    }

    async sendVisionRequest(turns, systemMessage, imageBuffer, options = {}) {
        const imageMessages = [...(turns || [])];
        imageMessages.push({
            role: 'user',
            content: [
                { type: 'input_text', text: '<image>' },
                { type: 'input_image', image_url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}` },
                { type: 'input_text', text: `</image>\n${systemMessage || 'Describe the image.'}` }
            ]
        });
        return this.sendRequest(imageMessages, systemMessage, '***', null, options);
    }

    buildRequestBody(model, turns, systemMessage, tools=null, options = {}) {
        const promptCacheKey = buildScopedPromptCacheKey(this.sessionId, options?.cacheScope);
        const reasoning = buildCodexReasoning(this.params.reasoning);
        const include = buildCodexInclude(this.params.include, reasoning);
        const body = {
            model,
            instructions: systemMessage || '',
            input: toResponsesInputItems(turns || []),
            tools: toCodexResponsesTools(tools || []),
            parallel_tool_calls: this.params.parallel_tool_calls ?? true,
            reasoning,
            store: false,
            stream: true,
            include,
            prompt_cache_key: promptCacheKey
        };

        for (const [key, value] of Object.entries(this.params)) {
            if (!['tool_choice', 'toolChoice', 'apiKeyName', 'api_key_name', 'defaultModel', 'default_model', 'parallel_tool_calls', 'reasoning', 'include'].includes(key)) {
                body[key] = value;
            }
        }
        this.applyPreviousResponseContinuity(options, body);
        return body;
    }

    getCacheTraceMetadata(options = {}) {
        const scopedSessionId = buildScopedPromptCacheKey(this.sessionId, options?.cacheScope);
        const responseContinuityKey = this.getResponseContinuityKey(options);
        const responseContinuityEntries = responseContinuityKey
            ? this.responseContinuityByKey.get(responseContinuityKey)
            : null;
        return {
            cache_scope: options?.cacheScope || null,
            turn_state_key: options?.turnStateKey || null,
            transport_cache: {
                protocol: 'openai-codex-responses',
                prompt_cache_key: scopedSessionId,
                session_id: scopedSessionId,
                turn_state_present: Boolean(this.getTurnState(options)),
                previous_response_id_available: Boolean(responseContinuityEntries?.some(entry => entry.responseId))
            }
        };
    }

    consumeLastRequestCacheTrace() {
        const value = this.lastRequestCacheTrace;
        this.lastRequestCacheTrace = null;
        return value || null;
    }

    async fetchResponses(endpoint, body, auth, options = {}) {
        this.lastSentResponsesBody = body;
        this.lastSentResponsesOptions = options;
        if (this.useResponsesWebSocket && !this.responsesWebSocketDisabled) {
            try {
                return await this.fetchResponsesWebSocket(endpoint, body, auth, options);
            } catch (err) {
                if (isAbortError(err)) throw err;
                this.closeResponsesWebSocket();
                this.responsesWebSocketDisabled = true;
                console.log(`Codex Responses WebSocket failed; falling back to HTTP. ${sanitizeCodexError(err)}`);
            }
        }
        const httpBody = expandContinuityRequestBody(body);
        if (httpBody !== body && this.lastRequestCacheTrace?.incremental_reuse) {
            this.lastRequestCacheTrace = {
                ...this.lastRequestCacheTrace,
                previous_response_id: null,
                incremental_input_items: null,
                full_input_items: Array.isArray(httpBody.input) ? httpBody.input.length : this.lastRequestCacheTrace.full_input_items,
                incremental_reuse: false,
                incremental_reuse_reason: 'http_previous_response_unsupported'
            };
        }
        this.lastSentResponsesBody = httpBody;
        this.lastSentResponsesOptions = options;
        return await codexFetch(endpoint, {
            method: 'POST',
            headers: this.buildHeaders(auth, options),
            body: JSON.stringify(httpBody),
            signal: options?.signal
        });
    }

    async fetchResponsesWebSocket(endpoint, body, auth, options = {}) {
        const wsOptions = {
            ...(options || {}),
            transportSupportsPreviousResponseId: true,
            responseContinuityLatestOnly: true
        };
        const wsBody = structuredCloneSafe(expandContinuityRequestBody(body));
        this.applyPreviousResponseContinuity(wsOptions, wsBody);
        this.lastSentResponsesBody = wsBody;
        this.lastSentResponsesOptions = wsOptions;
        const ws = await this.ensureResponsesWebSocket(endpoint, auth, options);
        const responseText = await streamCodexResponsesWebSocket(ws, toResponseCreateWebSocketRequest(wsBody), {
            signal: options?.signal,
            idleTimeoutMs: this.responsesWebSocketIdleTimeoutMs,
            onClosed: () => {
                this.responsesWebSocket = null;
                this.responsesWebSocketHeaders = null;
            }
        });
        return new Response(responseText, {
            status: 200,
            headers: this.responsesWebSocketHeaders || {}
        });
    }

    async ensureResponsesWebSocket(endpoint, auth, options = {}) {
        if (this.responsesWebSocket?.readyState === WebSocket.OPEN) {
            return this.responsesWebSocket;
        }
        this.closeResponsesWebSocket();
        const headers = this.buildWebSocketHeaders(auth, options);
        const { ws, headers: responseHeaders } = await connectCodexResponsesWebSocket(toWebSocketUrl(endpoint), headers, {
            signal: options?.signal,
            timeoutMs: this.responsesWebSocketIdleTimeoutMs
        });
        this.responsesWebSocket = ws;
        this.responsesWebSocketHeaders = responseHeaders;
        ws.once('close', () => {
            if (this.responsesWebSocket === ws) {
                this.responsesWebSocket = null;
                this.responsesWebSocketHeaders = null;
            }
        });
        return ws;
    }

    closeResponsesWebSocket() {
        if (this.responsesWebSocket) {
            try {
                this.responsesWebSocket.close();
            } catch {
                // Best-effort cleanup.
            }
        }
        this.responsesWebSocket = null;
        this.responsesWebSocketHeaders = null;
    }

    buildWebSocketHeaders(auth, options = {}) {
        const headers = { ...this.buildHeaders(auth, options) };
        delete headers['Content-Type'];
        headers['OpenAI-Beta'] = RESPONSES_WEBSOCKET_BETA_HEADER_VALUE;
        return headers;
    }

    buildHeaders(auth, options = {}) {
        const scopedSessionId = buildScopedPromptCacheKey(this.sessionId, options?.cacheScope);
        const headers = {
            'Authorization': `Bearer ${auth.accessToken}`,
            'ChatGPT-Account-ID': auth.accountId,
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'originator': this.originator,
            'session_id': scopedSessionId,
            'x-client-request-id': scopedSessionId,
            'User-Agent': `${this.originator}/mindcraft-native-tool`
        };
        if (!auth.accountId) {
            delete headers['ChatGPT-Account-ID'];
        }
        const turnState = this.getTurnState(options);
        if (turnState) {
            headers['x-codex-turn-state'] = turnState;
        }
        return headers;
    }

    getTurnState(options = {}) {
        const key = this.getTurnStateKey(options);
        return key ? this.turnStateByKey.get(key) : null;
    }

    rememberTurnState(options = {}, response) {
        const key = this.getTurnStateKey(options);
        const value = response?.headers?.get?.('x-codex-turn-state');
        if (!key || !value) return;
        this.turnStateByKey.set(key, value);
        if (this.turnStateByKey.size > 64) {
            const oldestKey = this.turnStateByKey.keys().next().value;
            this.turnStateByKey.delete(oldestKey);
        }
    }

    getTurnStateKey(options = {}) {
        // Match Codex CLI's turn-scoped sticky-routing contract. The backend may
        // return x-codex-turn-state during a ReAct turn; replay it only for
        // follow-up requests in that same turn. Leaking it into the next inbound
        // bot/user message can route an otherwise cacheable prompt to the wrong
        // backend state and cause full prompt-cache misses.
        return this.getTurnScopedContinuityKey(options);
    }

    getResponseContinuityKey(options = {}) {
        // The ChatGPT Codex HTTP endpoint rejects previous_response_id; Codex
        // CLI uses that field only on its websocket transport. Keep the
        // branch-aware continuity machinery behind an explicit transport opt-in
        // so the default HTTP path relies on prompt_cache_key and never 400s.
        if (!this.enablePreviousResponseId && !options?.transportSupportsPreviousResponseId) return null;
        return buildScopedPromptCacheKey(this.sessionId, options?.cacheScope);
    }

    getTurnScopedContinuityKey(options = {}) {
        const turnStateKey = String(options?.turnStateKey || '').trim();
        if (!turnStateKey) return null;
        const scopedSessionId = buildScopedPromptCacheKey(this.sessionId, options?.cacheScope);
        return buildScopedPromptCacheKey(scopedSessionId, `turn:${turnStateKey}`);
    }

    applyPreviousResponseContinuity(options = {}, body) {
        const key = this.getResponseContinuityKey(options);
        const previousEntries = key ? this.responseContinuityByKey.get(key) : null;
        const baseTrace = {
            protocol: 'openai-codex-responses',
            prompt_cache_key: body.prompt_cache_key,
            session_id: buildScopedPromptCacheKey(this.sessionId, options?.cacheScope),
            turn_state_present: Boolean(this.getTurnState(options)),
            previous_response_id: null,
            incremental_input_items: null,
            full_input_items: Array.isArray(body.input) ? body.input.length : 0,
            incremental_reuse: false,
            incremental_reuse_reason: 'no_previous_response'
        };

        if (!previousEntries?.length) {
            this.lastRequestCacheTrace = baseTrace;
            return;
        }

        const requestSignature = codexRequestSignature(body);
        const candidateEntries = options?.responseContinuityLatestOnly
            ? previousEntries.slice(0, 1)
            : previousEntries;
        let sawMatchingSignature = false;
        let bestMatch = null;
        for (const entry of candidateEntries) {
            if (requestSignature !== entry.requestSignature) continue;
            sawMatchingSignature = true;
            const delta = getIncrementalResponsesInput(body.input, entry.baselineInput);
            if (!delta) continue;
            if (!bestMatch || entry.baselineInput.length > bestMatch.entry.baselineInput.length) {
                bestMatch = { entry, delta };
            }
        }

        if (!sawMatchingSignature) {
            this.lastRequestCacheTrace = {
                ...baseTrace,
                incremental_reuse_reason: 'non_input_fields_changed'
            };
            return;
        }

        if (!bestMatch) {
            this.lastRequestCacheTrace = {
                ...baseTrace,
                incremental_reuse_reason: 'input_not_previous_prefix'
            };
            return;
        }

        body.previous_response_id = bestMatch.entry.responseId;
        body.input = bestMatch.delta;
        body[CONTINUITY_BASELINE_INPUT] = bestMatch.entry.baselineInput;
        this.lastRequestCacheTrace = {
            ...baseTrace,
            previous_response_id: bestMatch.entry.responseId,
            incremental_input_items: bestMatch.delta.length,
            incremental_reuse: true,
            incremental_reuse_reason: 'prefix_reused'
        };
    }

    rememberResponseContinuity(options = {}, body, parsed = {}) {
        const responseId = parsed.responseId;
        if (!responseId) return;
        const key = this.getResponseContinuityKey(options);
        if (!key) return;
        const sentInput = body.previous_response_id
            ? [
                ...(body[CONTINUITY_BASELINE_INPUT] || []),
                ...(body.input || [])
            ]
            : (body.input || []);
        const outputItems = synthesizeCodexOutputItems(parsed);
        const entries = this.responseContinuityByKey.get(key) || [];
        entries.unshift({
            responseId,
            requestSignature: codexRequestSignature(body),
            baselineInput: normalizeResponsesItemsForContinuity([
                ...sentInput,
                ...outputItems
            ])
        });
        entries.length = Math.min(entries.length, 32);
        this.responseContinuityByKey.set(key, entries);
        if (this.responseContinuityByKey.size > 64) {
            const oldestKey = this.responseContinuityByKey.keys().next().value;
            this.responseContinuityByKey.delete(oldestKey);
        }
    }

    async embed() {
        throw new Error('Codex ChatGPT native-login adapter does not support embeddings. Configure an embedding provider separately.');
    }
}

export function hasCodexChatGPTAuth(authPath = DEFAULT_KEYS_PATH) {
    return canReadCodexChatGPTAuth(expandHomePath(authPath));
}

export async function ensureCodexChatGPTAuth({
    authPath,
    keysPath,
    allowLogin = true,
    loginRunner = runCodexBrowserLogin,
    issuer = CODEX_ISSUER,
    clientId = CODEX_OAUTH_CLIENT_ID,
    port = DEFAULT_LOGIN_PORT,
    openBrowser = true,
    forcedChatgptWorkspaceId = null,
    originator = DEFAULT_ORIGINATOR
} = {}) {
    const resolvedAuthPath = expandHomePath(authPath || keysPath || DEFAULT_KEYS_PATH);
    if (canReadCodexChatGPTAuth(resolvedAuthPath)) {
        return readCodexChatGPTAuth(resolvedAuthPath);
    }
    if (allowLogin && (isInteractiveTerminal() || loginRunner !== runCodexBrowserLogin)) {
        const authJson = await loginRunner({ authPath: resolvedAuthPath, keysPath: resolvedAuthPath, issuer, clientId, port, openBrowser, forcedChatgptWorkspaceId, originator });
        if (authJson) {
            writeKeysCodexAuth(resolvedAuthPath, authJson);
        }
        return readCodexChatGPTAuth(resolvedAuthPath);
    }
    throw new Error(`Codex ChatGPT auth is missing in ${resolvedAuthPath}. Start with an interactive terminal and choose the codex profile to login here.`);
}

export function readCodexChatGPTAuth(authPath = DEFAULT_KEYS_PATH) {
    const resolvedAuthPath = expandHomePath(authPath);
    const config = readJsonFile(resolvedAuthPath);
    const authJson = extractCodexAuth(config);
    if (!authJson || typeof authJson !== 'object') {
        throw new Error(`Missing Codex ChatGPT auth in ${resolvedAuthPath}.`);
    }
    return normalizeCodexAuth(authJson, resolvedAuthPath);
}

export async function refreshCodexChatGPTAuth(auth, authPath = auth.authPath || DEFAULT_KEYS_PATH, originator = DEFAULT_ORIGINATOR) {
    if (!auth.refreshToken) {
        throw new Error('Codex ChatGPT auth has no refresh token. Login again from this project.');
    }
    const response = await codexFetch(CODEX_REFRESH_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'originator': originator,
            'User-Agent': `${originator}/mindcraft-native-tool`
        },
        body: JSON.stringify({
            client_id: CODEX_OAUTH_CLIENT_ID,
            grant_type: 'refresh_token',
            refresh_token: auth.refreshToken
        })
    });

    if (!response.ok) {
        throw await codexHttpError(response);
    }
    const refreshed = await response.json();
    const next = structuredClone(auth.raw || {});
    next.tokens = next.tokens || {};
    if (refreshed.id_token) next.tokens.id_token = refreshed.id_token;
    if (refreshed.access_token) next.tokens.access_token = refreshed.access_token;
    if (refreshed.refresh_token) next.tokens.refresh_token = refreshed.refresh_token;
    next.last_refresh = new Date().toISOString();
    writeKeysCodexAuth(authPath, next);
    return readCodexChatGPTAuth(authPath);
}

export async function runCodexBrowserLogin({
    authPath,
    keysPath,
    issuer = CODEX_ISSUER,
    clientId = CODEX_OAUTH_CLIENT_ID,
    port = DEFAULT_LOGIN_PORT,
    openBrowser = true,
    forcedChatgptWorkspaceId = null,
    originator = DEFAULT_ORIGINATOR
} = {}) {
    const resolvedAuthPath = expandHomePath(authPath || keysPath || DEFAULT_KEYS_PATH);
    const baseUrl = trimTrailingSlash(issuer);
    const pkce = generatePkce();
    const state = generateState();
    const requestedPort = port === 0 ? 0 : Number.parseInt(port || DEFAULT_LOGIN_PORT, 10);
    const server = await startCallbackServer(requestedPort);
    const redirectUri = `http://localhost:${server.port}/auth/callback`;
    const authUrl = buildAuthorizeUrl({
        issuer: baseUrl,
        clientId,
        redirectUri,
        pkce,
        state,
        forcedChatgptWorkspaceId,
        originator
    });

    try {
        printBrowserLoginPrompt(authUrl, redirectUri);
        if (openBrowser) {
            open(authUrl).catch(err => {
                console.log(`Could not open browser automatically: ${sanitizeCodexError(err)}`);
            });
        }
        const code = await waitForOAuthCallback(server, state);
        const tokens = await exchangeAuthorizationCodeForTokens(baseUrl, clientId, redirectUri, pkce, code);
        const authJson = toCodexAuthJson(tokens);
        writeKeysCodexAuth(resolvedAuthPath, authJson);
        return authJson;
    } finally {
        await closeServer(server.server);
    }
}

// Compatibility helper for explicit tests/dev flows. The default login path intentionally
// uses the local browser callback flow above, matching `codex login` rather than
// `codex login --device-auth`.
export async function runCodexDeviceLogin({ authPath, keysPath, issuer = CODEX_ISSUER, clientId = CODEX_OAUTH_CLIENT_ID } = {}) {
    const resolvedAuthPath = expandHomePath(authPath || keysPath || DEFAULT_KEYS_PATH);
    const baseUrl = trimTrailingSlash(issuer);
    const device = await requestDeviceCode(baseUrl, clientId);
    printDeviceCodePrompt(device.verification_url, device.user_code);
    const code = await pollDeviceAuthorization(baseUrl, device);
    const tokens = await exchangeAuthorizationCodeForTokens(baseUrl, clientId, `${baseUrl}/deviceauth/callback`, { code_verifier: code.code_verifier }, code.authorization_code);
    const authJson = toCodexAuthJson(tokens);
    writeKeysCodexAuth(resolvedAuthPath, authJson);
    return authJson;
}

export function writeKeysCodexAuth(authPath, authJson) {
    const resolvedAuthPath = expandHomePath(authPath);
    const normalized = toCodexAuthJson(authJson);
    const existing = existsSync(resolvedAuthPath) ? readJsonFile(resolvedAuthPath) : {};
    if (looksLikeUnifiedKeysConfig(existing) || Object.prototype.hasOwnProperty.call(existing, CODEX_AUTH_KEY)) {
        const section = getKeysSection(existing, true);
        section[CODEX_AUTH_KEY] = normalized;
        writeFileSync(resolvedAuthPath, `${JSON.stringify(existing, null, 4)}\n`, { mode: 0o600 });
        console.log(`Saved Codex ChatGPT auth to ${resolvedAuthPath} at keys.${CODEX_AUTH_KEY}`);
        return;
    }
    writeFileSync(resolvedAuthPath, `${JSON.stringify(normalized, null, 4)}\n`, { mode: 0o600 });
    console.log(`Saved Codex ChatGPT auth to ${resolvedAuthPath}`);
}

function extractCodexAuth(config) {
    if (config?.tokens?.access_token) {
        return config;
    }
    const section = getKeysSection(config);
    return section?.[CODEX_AUTH_KEY];
}

function looksLikeUnifiedKeysConfig(config) {
    return Boolean(config?.keys || config?.models || config?.embeddings);
}

function getKeysSection(config, create = false) {
    if (config?.keys && typeof config.keys === 'object') {
        return config.keys;
    }
    if (create && (config.models || config.embeddings)) {
        config.keys = {};
        return config.keys;
    }
    return config;
}

export function toCodexResponsesTools(tools = []) {
    return tools.map(tool => {
        const fn = tool.function || tool;
        return {
            type: 'function',
            name: fn.name,
            description: fn.description || '',
            strict: Boolean(fn.strict),
            parameters: fn.parameters || { type: 'object', properties: {} }
        };
    }).filter(tool => tool.name);
}

export function buildScopedPromptCacheKey(baseKey, cacheScope) {
    const base = String(baseKey || '').trim();
    const scope = String(cacheScope || '').trim();
    if (!scope) return base;
    return `${base}:${scope}`;
}

function toResponseCreateWebSocketRequest(body = {}) {
    return {
        type: 'response.create',
        ...body,
        tool_choice: body.tool_choice || 'auto'
    };
}

function expandContinuityRequestBody(body = {}) {
    if (!body?.previous_response_id) return body;
    const expanded = {
        ...body,
        input: [
            ...(body[CONTINUITY_BASELINE_INPUT] || []),
            ...(body.input || [])
        ]
    };
    delete expanded.previous_response_id;
    return expanded;
}

function toWebSocketUrl(endpoint) {
    const url = new URL(endpoint);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol === 'http:') url.protocol = 'ws:';
    return url.toString();
}

function isChatGptCodexUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.hostname === 'chatgpt.com' && parsed.pathname.includes('/backend-api/codex');
    } catch {
        return false;
    }
}

async function connectCodexResponsesWebSocket(url, headers, { signal, timeoutMs = DEFAULT_WEBSOCKET_IDLE_TIMEOUT_MS } = {}) {
    if (signal?.aborted) throw abortError();
    return await new Promise((resolve, reject) => {
        let settled = false;
        let responseHeaders = {};
        const ws = new WebSocket(url, {
            headers,
            perMessageDeflate: true,
            family: 4,
            handshakeTimeout: Math.min(Math.max(timeoutMs, 1000), 30000)
        });

        const cleanup = () => {
            ws.off('open', onOpen);
            ws.off('upgrade', onUpgrade);
            ws.off('unexpected-response', onUnexpectedResponse);
            ws.off('error', onError);
            signal?.removeEventListener?.('abort', onAbort);
        };
        const fail = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            try {
                ws.close();
            } catch {
                // Best-effort cleanup.
            }
            reject(error);
        };
        const onAbort = () => fail(abortError());
        const onUpgrade = response => {
            responseHeaders = normalizeNodeHeaders(response?.headers || {});
        };
        const onOpen = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({ ws, headers: responseHeaders });
        };
        const onUnexpectedResponse = (_request, response) => {
            const chunks = [];
            response.on('data', chunk => chunks.push(Buffer.from(chunk)));
            response.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                const error = new Error(`WebSocket upgrade failed with status=${response.statusCode} ${body.slice(0, 300)}`);
                error.status = response.statusCode;
                fail(error);
            });
            response.on('error', fail);
        };
        const onError = error => fail(error);

        ws.once('open', onOpen);
        ws.once('upgrade', onUpgrade);
        ws.once('unexpected-response', onUnexpectedResponse);
        ws.once('error', onError);
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

async function streamCodexResponsesWebSocket(ws, payload, { signal, idleTimeoutMs = DEFAULT_WEBSOCKET_IDLE_TIMEOUT_MS, onClosed } = {}) {
    if (signal?.aborted) throw abortError();
    return await new Promise((resolve, reject) => {
        let settled = false;
        const chunks = [];
        const timeout = setTimeout(() => {
            fail(new Error('idle timeout waiting for Codex Responses WebSocket'));
        }, Math.max(1000, idleTimeoutMs));

        const cleanup = () => {
            clearTimeout(timeout);
            ws.off('message', onMessage);
            ws.off('error', onError);
            ws.off('close', onClose);
            signal?.removeEventListener?.('abort', onAbort);
        };
        const fail = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        const finish = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(chunks.join(''));
        };
        const onAbort = () => {
            try {
                ws.close();
            } catch {
                // Best-effort cleanup.
            }
            fail(abortError());
        };
        const onError = error => fail(error);
        const onClose = () => {
            onClosed?.();
            fail(new Error('websocket closed before response.completed'));
        };
        const onMessage = data => {
            const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
            let event = null;
            try {
                event = JSON.parse(text);
            } catch {
                return;
            }
            if (event?.type === 'error') {
                const message = event.error?.message || event.message || text;
                const error = new Error(message);
                error.status = event.status || event.status_code;
                fail(error);
                return;
            }
            chunks.push(`data: ${text}\n\n`);
            if (event?.type === 'response.failed') {
                const error = new Error(event.response?.error?.message || 'Codex Responses WebSocket failed');
                error.status = event.response?.status;
                fail(error);
                return;
            }
            if (event?.type === 'response.completed') {
                finish();
            }
        };

        ws.on('message', onMessage);
        ws.once('error', onError);
        ws.once('close', onClose);
        signal?.addEventListener?.('abort', onAbort, { once: true });
        ws.send(JSON.stringify(payload), error => {
            if (error) fail(error);
        });
    });
}

function normalizeNodeHeaders(headers = {}) {
    const normalized = {};
    for (const [key, value] of Object.entries(headers)) {
        normalized[key] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return normalized;
}

function abortError() {
    const error = new Error('aborted');
    error.name = 'AbortError';
    return error;
}

function codexRequestSignature(body = {}) {
    const copy = { ...(body || {}) };
    delete copy.input;
    delete copy.previous_response_id;
    return stableJson(copy);
}

function getIncrementalResponsesInput(input = [], previousBaseline = []) {
    const normalizedInput = normalizeResponsesItemsForContinuity(input);
    const normalizedBaseline = normalizeResponsesItemsForContinuity(previousBaseline);
    if (normalizedBaseline.length > normalizedInput.length) return null;
    for (let i = 0; i < normalizedBaseline.length; i++) {
        if (stableJson(normalizedInput[i]) !== stableJson(normalizedBaseline[i])) {
            return null;
        }
    }
    return input.slice(normalizedBaseline.length);
}

function normalizeResponsesItemsForContinuity(items = []) {
    return (items || []).map(normalizeResponsesItemForContinuity);
}

function normalizeResponsesItemForContinuity(item) {
    if (!item || typeof item !== 'object') return item;
    const clone = structuredCloneSafe(item);
    stripVolatileResponsesFields(clone);
    return clone;
}

function stripVolatileResponsesFields(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        for (const item of value) stripVolatileResponsesFields(item);
        return;
    }
    delete value.id;
    delete value.status;
    delete value.object;
    for (const item of Object.values(value)) {
        stripVolatileResponsesFields(item);
    }
}

function synthesizeCodexOutputItems(parsed = {}) {
    if (parsed.toolCalls?.length) {
        return parsed.toolCalls.map(call => ({
            type: 'function_call',
            call_id: call.id,
            name: call.function?.name || call.name,
            arguments: call.function?.arguments || call.arguments || '{}'
        })).filter(item => item.call_id && item.name);
    }
    if (parsed.text) {
        return [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: parsed.text }]
        }];
    }
    return [];
}

function structuredCloneSafe(value) {
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            // Fall through to JSON clone.
        }
    }
    return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
    return JSON.stringify(sortJsonKeys(value));
}

function sortJsonKeys(value) {
    if (Array.isArray(value)) return value.map(sortJsonKeys);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((out, key) => {
        out[key] = sortJsonKeys(value[key]);
        return out;
    }, {});
}

export function toCodexResponseItem(message) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    return {
        type: 'message',
        role,
        content: [{
            type: role === 'assistant' ? 'output_text' : 'input_text',
            text: stringifyContent(message.content)
        }]
    };
}

export async function parseCodexResponsesSse(sseText) {
    const toolCalls = [];
    const textDeltas = [];
    const messageTexts = [];
    const thinkingDeltas = [];
    const reasoningItems = [];
    const outputItems = [];
    let responseId = null;
    let usage = null;
    const events = sseText.split(/\n\n+/);
    for (const eventBlock of events) {
        const dataLines = eventBlock
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart());
        if (dataLines.length === 0) continue;
        const data = dataLines.join('\n');
        if (data === '[DONE]') continue;
        let event;
        try {
            event = JSON.parse(data);
        } catch {
            continue;
        }
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
            textDeltas.push(event.delta);
        }
        if (typeof event.type === 'string' && event.type.includes('reasoning') && typeof event.delta === 'string') {
            thinkingDeltas.push(event.delta);
        }
        const item = event.item;
        if (event.type === 'response.output_item.done' && item) {
            outputItems.push(item);
        }
        if (event.type === 'response.output_item.done' && item?.type === 'function_call') {
            toolCalls.push({
                id: item.call_id,
                type: 'function',
                function: {
                    name: item.name,
                    arguments: item.arguments || '{}'
                }
            });
        }
        if (event.type === 'response.output_item.done' && item?.type === 'message') {
            messageTexts.push(extractMessageText(item));
        }
        if (event.type === 'response.output_item.done' && item?.type === 'reasoning') {
            reasoningItems.push(extractReasoningText(item));
        }
        if (event.response?.usage) {
            usage = event.response.usage;
        } else if (event.usage) {
            usage = event.usage;
        }
        if (event.response?.id) {
            responseId = event.response.id;
        }
        if (event.response_id) {
            responseId = event.response_id;
        }
        if (event.type === 'response.failed') {
            const message = event.response?.error?.message || 'Codex Responses stream failed';
            throw new Error(message);
        }
    }
    const text = textDeltas.length > 0 ? textDeltas.join('') : messageTexts.join('');
    const thinking = thinkingDeltas.length > 0
        ? normalizeThinkingText(thinkingDeltas.join(''))
        : normalizeThinkingText(reasoningItems);
    return { text, toolCalls, usage, thinking, responseId, outputItems };
}

async function requestDeviceCode(baseUrl, clientId) {
    const response = await codexFetch(`${baseUrl}/api/accounts/deviceauth/usercode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId })
    });
    if (!response.ok) {
        throw await codexHttpError(response);
    }
    const body = await response.json();
    return {
        verification_url: `${baseUrl}/codex/device`,
        user_code: body.user_code || body.usercode,
        device_auth_id: body.device_auth_id,
        interval: Number.parseInt(body.interval || '5', 10)
    };
}

async function pollDeviceAuthorization(baseUrl, device) {
    const started = Date.now();
    while (Date.now() - started < LOGIN_TIMEOUT_MS) {
        const response = await codexFetch(`${baseUrl}/api/accounts/deviceauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device_auth_id: device.device_auth_id,
                user_code: device.user_code
            })
        });
        if (response.ok) {
            return await response.json();
        }
        if (![403, 404].includes(response.status)) {
            throw await codexHttpError(response);
        }
        await sleep(Math.max(1, device.interval) * 1000);
    }
    throw new Error('Codex device login timed out after 15 minutes.');
}

async function exchangeAuthorizationCodeForTokens(baseUrl, clientId, redirectUri, pkce, authorizationCode) {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: authorizationCode,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: pkce.code_verifier
    });
    const response = await codexFetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });
    if (!response.ok) {
        throw await codexHttpError(response);
    }
    return await response.json();
}

export function buildAuthorizeUrl({
    issuer = CODEX_ISSUER,
    clientId = CODEX_OAUTH_CLIENT_ID,
    redirectUri,
    pkce,
    state,
    forcedChatgptWorkspaceId = null,
    originator = DEFAULT_ORIGINATOR
}) {
    const query = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
        code_challenge: pkce.code_challenge,
        code_challenge_method: 'S256',
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        state,
        originator
    });
    if (forcedChatgptWorkspaceId) {
        query.set('allowed_workspace_id', forcedChatgptWorkspaceId);
    }
    return `${trimTrailingSlash(issuer)}/oauth/authorize?${query.toString()}`;
}

function generatePkce() {
    const codeVerifier = base64Url(randomBytes(64));
    const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());
    return { code_verifier: codeVerifier, code_challenge: codeChallenge };
}

function generateState() {
    return base64Url(randomBytes(32));
}

function base64Url(buffer) {
    return Buffer.from(buffer).toString('base64url');
}

async function startCallbackServer(preferredPort) {
    return await new Promise((resolve, reject) => {
        const server = createServer();
        let settled = false;
        const finish = (err, result) => {
            if (settled) return;
            settled = true;
            err ? reject(err) : resolve(result);
        };
        server.once('error', async err => {
            if (err?.code === 'EADDRINUSE' && preferredPort !== 0) {
                try {
                    await sendCancelRequest(preferredPort);
                    setTimeout(() => {
                        startCallbackServer(preferredPort).then(resolve, reject);
                    }, 200);
                } catch {
                    finish(err);
                }
                return;
            }
            finish(err);
        });
        server.listen(preferredPort || 0, '127.0.0.1', () => {
            const address = server.address();
            finish(null, { server, port: address.port });
        });
    });
}

function sendCancelRequest(port) {
    return new Promise((resolve, reject) => {
        const req = globalThis.fetch(`http://127.0.0.1:${port}/cancel`, { signal: AbortSignal.timeout(2000) });
        req.then(() => resolve(), reject);
    });
}

function waitForOAuthCallback(serverInfo, expectedState) {
    const { server } = serverInfo;
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Codex browser login timed out after 15 minutes.'));
        }, LOGIN_TIMEOUT_MS);

        const cleanup = () => {
            clearTimeout(timeout);
            server.removeListener('request', onRequest);
        };

        const finish = (res, status, body, done, headers = {}) => {
            res.writeHead(status, {
                'Content-Type': 'text/html; charset=utf-8',
                'Connection': 'close',
                ...headers
            });
            res.end(body);
            cleanup();
            done();
        };

        const onRequest = (req, res) => {
            const parsed = new URL(req.url || '/', 'http://localhost');
            if (parsed.pathname === '/cancel') {
                finish(res, 200, 'Login cancelled', () => reject(new Error('Codex browser login cancelled.')));
                return;
            }
            if (parsed.pathname !== '/auth/callback') {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Not Found');
                return;
            }
            const state = parsed.searchParams.get('state');
            if (state !== expectedState) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Connection': 'close' });
                res.end('<h1>Codex login ignored</h1><p>State mismatch. Return to the newest login tab or retry the latest URL.</p>');
                console.log('Ignored Codex browser login callback with mismatched state; still waiting for the current login.');
                return;
            }
            const error = parsed.searchParams.get('error');
            if (error) {
                const description = parsed.searchParams.get('error_description') || error;
                finish(res, 400, `<h1>Codex login failed</h1><p>${escapeHtml(description)}</p>`, () => reject(new Error(`Codex browser login failed: ${description}`)));
                return;
            }
            const code = parsed.searchParams.get('code');
            if (!code) {
                finish(res, 400, '<h1>Codex login failed</h1><p>Missing authorization code.</p>', () => reject(new Error('Codex browser login callback did not include an authorization code.')));
                return;
            }
            finish(res, 200, codexLoginClosePage(), () => resolve(code));
        };

        server.on('request', onRequest);
    });
}

function closeServer(server) {
    return new Promise(resolve => {
        server.close(() => resolve());
    });
}

function canReadCodexChatGPTAuth(authPath) {
    try {
        readCodexChatGPTAuth(authPath);
        return true;
    } catch {
        return false;
    }
}

function normalizeCodexAuth(authJson, keysPath) {
    const tokens = authJson.tokens || {};
    const accessToken = tokens.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
        throw new Error(`Codex ChatGPT auth is missing tokens.access_token in ${keysPath}.`);
    }
    return {
        authPath: keysPath,
        raw: authJson,
        accessToken,
        refreshToken: tokens.refresh_token,
        accountId: tokens.account_id || parseJwtPayload(tokens.id_token)?.chatgpt_account_id
    };
}

function toCodexAuthJson(input) {
    const tokens = input.tokens || input;
    const idToken = tokens.id_token;
    const payload = parseJwtPayload(idToken) || {};
    return {
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
            id_token: idToken,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            account_id: tokens.account_id || payload.chatgpt_account_id
        },
        last_refresh: input.last_refresh || new Date().toISOString()
    };
}

function parseJwtPayload(jwt) {
    if (typeof jwt !== 'string') return null;
    const part = jwt.split('.')[1];
    if (!part) return null;
    try {
        return JSON.parse(Buffer.from(base64UrlToBase64(part), 'base64').toString('utf8'));
    } catch {
        return null;
    }
}

function base64UrlToBase64(value) {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    return padded + '='.repeat((4 - padded.length % 4) % 4);
}

function expandHomePath(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        return filePath;
    }
    return filePath === '~' || filePath.startsWith('~/')
        ? path.join(process.env.HOME || '', filePath.slice(2))
        : filePath;
}

function readJsonFile(filePath) {
    return JSON.parse(readFileSync(expandHomePath(filePath), 'utf8'));
}

function printBrowserLoginPrompt(authUrl) {
    console.log(`
Login to ChatGPT is required to enable Codex native account capabilities.

Please open this login link in your browser:
${authUrl}

You will be redirected back to Mindcraft after login; waiting for login to complete...
`);
}


function codexLoginClosePage() {
    return '<!doctype html>'
        + '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>Codex login complete</title>'
        + '<style>'
        + ':root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 10%,#f7fbff 0,#f8fafc 45%,#e8edf3 100%);font-family:"OpenAI Sans",Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111827;overflow:hidden}'
        + '.card{position:relative;z-index:3;width:min(440px,calc(100vw - 40px));text-align:center;background:rgba(255,255,255,.9);border:1px solid rgba(148,163,184,.32);border-radius:22px;padding:34px 32px;box-shadow:0 22px 70px rgba(15,23,42,.14);backdrop-filter:blur(10px)}'
        + '.mark{width:56px;height:56px;margin:0 auto 18px;border-radius:17px;display:grid;place-items:center;background:#111827;color:white;font-size:29px;box-shadow:0 12px 30px rgba(15,23,42,.18)}h1{font-size:26px;line-height:1.2;margin:0 0 10px;font-weight:650;letter-spacing:-.03em}p{margin:6px 0;color:#475569;font-size:15px;letter-spacing:-.01em}.hint{margin-top:18px;font-size:13px;color:#64748b}'
        + '.confetti{position:fixed;bottom:18px;width:5px;height:9px;border-radius:1.5px;opacity:0;z-index:4;animation:confettiFly 2.7s cubic-bezier(.16,.82,.22,1) both;will-change:transform,opacity;pointer-events:none}.confetti.left{left:38px}.confetti.right{right:38px}@keyframes confettiFly{0%{opacity:0;transform:translate(0,0) rotate(0deg) scale(.7)}6%{opacity:.95}58%{opacity:.9}78%{opacity:.18}100%{opacity:0;transform:translate(var(--x),var(--y)) rotate(var(--r)) scale(.9)}}'
        + '@media (prefers-color-scheme:dark){body{background:radial-gradient(circle at 50% 10%,#172033 0,#0f172a 48%,#020617 100%);color:#f8fafc}.card{background:rgba(15,23,42,.78);border-color:rgba(148,163,184,.22)}.mark{background:#f8fafc;color:#111827}p{color:#cbd5e1}.hint{color:#94a3b8}}'
        + '</style>'
        + '<body><div class="card"><div class="mark">✓</div><h1>Codex login complete</h1><p>Mindcraft is connected to ChatGPT/Codex.</p><p class="hint">You can close this page and return to the terminal.</p></div>'
        + '<script>'
        + '(function(){'
        + 'var colors=["#ef4444","#f59e0b","#10b981","#3b82f6","#8b5cf6","#ec4899"];'
        + 'function piece(side,i){var el=document.createElement("i");el.className="confetti "+side;var dir=side==="left"?1:-1;var spread=(i%12-5.5)*7;var distance=200+Math.random()*240;el.style.background=colors[i%colors.length];el.style.setProperty("--x",(dir*(distance+Math.random()*70))+"px");el.style.setProperty("--y",(-210-Math.random()*260+spread)+"px");el.style.setProperty("--r",(dir*(180+Math.random()*520))+"deg");el.style.animationDelay=(Math.random()*0.28)+"s";el.style.animationDuration=(2.15+Math.random()*0.45)+"s";document.body.appendChild(el);} '
        + 'for(var i=0;i<72;i++){piece("left",i);piece("right",i+72);}'
        + 'function closeTab(){try{window.open("","_self");window.close();}catch(e){}}'
        + 'setTimeout(closeTab,1400);setTimeout(closeTab,2600);'
        + '})();'
        + '</script></body>';
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function printDeviceCodePrompt(verificationUrl, code) {
    console.log(`\nCodex ChatGPT login required for this project.\nOpen this URL and sign in:\n\n  ${verificationUrl}\n\nEnter this one-time code:\n\n  ${code}\n\nWaiting for login to complete...\n`);
}


async function codexFetch(url, init = {}) {
    if (shouldUseFetch(url)) {
        return await fetch(url, init);
    }
    try {
        return await curlFetch(url, init);
    } catch (curlError) {
        console.warn(`System curl transport failed for Codex HTTP request; retrying with Node fetch: ${sanitizeCodexError(curlError)}`);
        return await fetch(url, init);
    }
}

function shouldUseFetch(url) {
    if (globalThis.fetch !== DEFAULT_FETCH) {
        return true;
    }
    try {
        const { hostname } = new URL(String(url));
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    } catch {
        return false;
    }
}

function isFetchTransportError(error) {
    return error?.message === 'fetch failed' || error?.cause?.code || Array.isArray(error?.cause?.errors);
}

async function curlFetch(url, init = {}) {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mindcraft-codex-curl-'));
    const headersPath = path.join(tempDir, 'headers.txt');
    const bodyPath = path.join(tempDir, 'body.bin');
    const requestBodyPath = path.join(tempDir, 'request-body.bin');
    const configPath = path.join(tempDir, 'curl.conf');
    try {
        const method = init.method || (init.body ? 'POST' : 'GET');
        const config = [
            `url = ${curlQuote(String(url))}`,
            `request = ${curlQuote(method)}`,
            `dump-header = ${curlQuote(headersPath)}`,
            `output = ${curlQuote(bodyPath)}`,
            'silent',
            'show-error',
            'location',
            'max-time = 300'
        ];

        for (const [name, value] of headerEntries(init.headers)) {
            config.push(`header = ${curlQuote(`${name}: ${value}`)}`);
        }

        if (init.body !== undefined && init.body !== null) {
            writeFileSync(requestBodyPath, bodyToString(init.body));
            config.push(`data-binary = ${curlQuote(`@${requestBodyPath}`)}`);
        }

        writeFileSync(configPath, `${config.join('\n')}\n`, { mode: 0o600 });
        await runCurl(configPath);
        const headersText = readFileSync(headersPath, 'utf8');
        const body = readFileSync(bodyPath);
        const { status, headers } = parseCurlHeaders(headersText);
        return new Response(body, { status, headers });
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

function runCurl(configPath) {
    return new Promise((resolve, reject) => {
        const child = spawn('curl', ['--config', configPath], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', chunk => {
            stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`curl exited with code ${code}: ${stderr.trim()}`));
            }
        });
    });
}

function headerEntries(headers = {}) {
    if (headers instanceof Headers) {
        return Array.from(headers.entries());
    }
    if (Array.isArray(headers)) {
        return headers;
    }
    return Object.entries(headers || {});
}

function bodyToString(body) {
    if (body instanceof URLSearchParams) {
        return body.toString();
    }
    if (Buffer.isBuffer(body)) {
        return body;
    }
    return String(body);
}

function curlQuote(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function parseCurlHeaders(headersText) {
    const blocks = headersText.trim().split(/\r?\n\r?\n/).filter(Boolean);
    const block = blocks[blocks.length - 1] || '';
    const lines = block.split(/\r?\n/);
    const statusMatch = lines.shift()?.match(/^HTTP\/\S+\s+(\d+)/);
    const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : 0;
    const headers = new Headers();
    for (const line of lines) {
        const idx = line.indexOf(':');
        if (idx > 0) {
            headers.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
        }
    }
    return { status, headers };
}

function formatFetchError(error) {
    const cause = error?.cause;
    const nestedCodes = Array.isArray(cause?.errors)
        ? cause.errors.map(item => item.code).filter(Boolean).join(',')
        : '';
    return [error?.message || String(error), cause?.code, nestedCodes, cause?.message]
        .filter(Boolean)
        .join(' | ');
}

function isInteractiveTerminal() {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function extractMessageText(item) {
    return (item.content || [])
        .filter(content => content?.type === 'output_text' || content?.type === 'text')
        .map(content => content.text || '')
        .join('');
}

function extractReasoningText(item) {
    const chunks = [];
    chunks.push(item?.text, item?.reasoning, item?.reasoning_content, item?.thinking);
    if (Array.isArray(item?.summary)) {
        chunks.push(...item.summary.map(part => part?.text || part?.summary_text || part?.content || ''));
    }
    if (Array.isArray(item?.content)) {
        chunks.push(...item.content.map(part => part?.text || part?.content || part?.reasoning || part?.thinking || ''));
    }
    return normalizeThinkingText(chunks);
}

function stringifyContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => part?.text || part?.content || JSON.stringify(part)).join('\n');
    }
    return String(content ?? '');
}

async function codexHttpError(response) {
    const body = await response.text().catch(() => '');
    const message = extractErrorMessage(body) || response.statusText || 'Codex ChatGPT request failed';
    const error = new Error(`status=${response.status} ${message}`);
    error.status = response.status;
    return error;
}

function extractErrorMessage(body) {
    try {
        const parsed = JSON.parse(body);
        return parsed?.error?.message || parsed?.message || body;
    } catch {
        return body.slice(0, 300);
    }
}

function buildCodexReasoning(reasoning) {
    if (reasoning === false || reasoning === null) return null;
    if (typeof reasoning === 'string') {
        return { effort: reasoning, summary: 'auto' };
    }
    if (!reasoning || typeof reasoning !== 'object') return null;
    const result = { ...reasoning };
    if (result.effort && result.summary === undefined) {
        result.summary = 'auto';
    }
    return Object.keys(result).length > 0 ? result : null;
}

function buildCodexInclude(include, reasoning) {
    const values = Array.isArray(include) ? [...include] : [];
    if (reasoning && !values.includes('reasoning.encrypted_content')) {
        values.push('reasoning.encrypted_content');
    }
    return values;
}

function isAbortError(err) {
    return err?.name === 'AbortError' || String(err?.message || err || '').includes('aborted');
}

function sanitizeCodexError(error) {
    return formatFetchError(error)
        .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED_TOKEN]')
        .replace(/(access_token|refresh_token|id_token)":"[^"]+"/g, '$1":"[REDACTED_TOKEN]"')
        .slice(0, 500);
}

function trimTrailingSlash(value) {
    return String(value).replace(/\/+$/, '');
}
