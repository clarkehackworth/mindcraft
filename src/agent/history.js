import { writeFileSync, readFileSync, mkdirSync, existsSync, appendFileSync } from 'fs';
import { NPCData } from './npc/data.js';
import settings from './settings.js';
import { createNativeToolCallTurn, createNativeToolResultTurn, hasNativeToolCalls, isNativeToolResultTurn } from '../models/native_tools.js';
import { sendTraceEventToServer } from './mindserver_proxy.js';


export class History {
    constructor(agent) {
        this.agent = agent;
        this.name = agent.name;
        this.memory_fp = `./bots/${this.name}/memory.json`;
        this.full_history_fp = undefined;
        this.chat_history_dir = `./bots/${this.name}/chat-history`;
        this.chat_history_session_fp = undefined;
        this.chat_history_latest_fp = `./bots/${this.name}/chat_history.jsonl`;

        mkdirSync(`./bots/${this.name}/histories`, { recursive: true });
        mkdirSync(this.chat_history_dir, { recursive: true });

        this.turns = [];

        // Latest compact summary retained for backward-compatible persistence.
        // The active model context stores compact summaries as normal history turns.
        this.memory = '';

        // Message-count context window. Compaction uses the active context after the
        // latest compact boundary and summarizes that whole active context.
        this.max_messages = Number.isFinite(settings.max_messages) ? settings.max_messages : Infinity;
        this.compact_message_threshold_percent = normalizePercent(settings.compact_message_threshold_percent, 100);

        if (this.fullTraceEnabled()) {
            this._initChatHistoryTrace();
        }
    }

    getHistory() {
        return JSON.parse(JSON.stringify(getTurnsAfterLastCompactBoundary(this.turns)));
    }

    async compactHistoryIfNeeded() {
        if (!this.shouldCompact()) {
            return false;
        }
        await this.compactHistory();
        return true;
    }

    shouldCompact() {
        if (!Number.isFinite(this.max_messages) || this.max_messages <= 0) {
            return false;
        }
        if (this.hasPendingToolCall()) {
            return false;
        }
        const threshold = Math.max(2, Math.ceil(this.max_messages * (this.compact_message_threshold_percent / 100)));
        if (this.turns.length < threshold) {
            return false;
        }
        return this.turns.some(turn => !turn.compact_boundary && !turn.compact_summary);
    }

    hasPendingToolCall() {
        const pending = new Set();
        for (const turn of this.turns) {
            if (hasNativeToolCalls(turn)) {
                for (const call of turn.native_tool_calls) {
                    pending.add(call.id);
                }
                continue;
            }
            if (isNativeToolResultTurn(turn) && turn.tool_call_id) {
                pending.delete(turn.tool_call_id);
            }
        }
        return pending.size > 0;
    }

    async compactHistory() {
        const turnsToCompact = this.getHistory();
        if (turnsToCompact.length === 0) {
            return;
        }

        console.log('Compacting conversation history...');
        this.traceEvent('memory_compression_started', {
            active_turn_count_before_compression: this.turns.length,
            compacted_turns: turnsToCompact,
            previous_memory: this.memory,
            threshold_percent: this.compact_message_threshold_percent,
            max_messages: this.max_messages
        });

        const previousMemory = this.memory;
        const summary = await this.agent.prompter.promptCompactSummary(turnsToCompact);
        this.memory = String(summary || '').trim();

        const historyFile = await this.appendFullHistory(turnsToCompact);
        this.turns = [
            createCompactBoundaryTurn({
                trigger: 'auto',
                summarized_turn_count: turnsToCompact.length,
                archive_file: historyFile
            }),
            createCompactSummaryTurn(this.memory, historyFile)
        ];

        console.log('Conversation compacted to summary:', this.memory);
        this.traceEvent('memory_compression_completed', {
            previous_memory: previousMemory,
            new_memory: this.memory,
            compacted_turns: turnsToCompact,
            full_history_file: historyFile,
            active_turns: this.turns
        });
        this.traceEvent('history_compacted', {
            summary: this.memory,
            full_history_file: historyFile,
            active_turns: this.turns
        });
    }

    async appendFullHistory(to_store) {
        if (this.full_history_fp === undefined) {
            const string_timestamp = new Date().toLocaleString().replace(/[/:]/g, '-').replace(/ /g, '').replace(/,/g, '_');
            this.full_history_fp = `./bots/${this.name}/histories/${string_timestamp}.json`;
            writeFileSync(this.full_history_fp, '[]', 'utf8');
        }
        try {
            const data = readFileSync(this.full_history_fp, 'utf8');
            let full_history = JSON.parse(data);
            full_history.push(...to_store);
            writeFileSync(this.full_history_fp, JSON.stringify(full_history, null, 4), 'utf8');
            return this.full_history_fp;
        } catch (err) {
            console.error(`Error reading ${this.name}'s full history file: ${err.message}`);
            return null;
        }
    }

    async add(name, content) {
        let role = 'assistant';
        if (name === 'system') {
            role = 'user';
            content = `System: ${content}`;
            if (isDuplicateSelfPromptReminder(this.turns, content)) {
                this.traceEvent('history_turn_deduped', {
                    reason: 'duplicate_self_prompt_reminder',
                    turn: { role, content }
                });
                return false;
            }
        }
        else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }
        await this._pushTurn({role, content});
    }

    async addUserContext(content) {
        const text = String(content || '').trim();
        if (!text) return false;
        await this._pushTurn({ role: 'user', content: text });
        return true;
    }

    async addNativeToolCall(toolCall, content) {
        await this._pushTurn(createNativeToolCallTurn(toolCall, content));
        this.traceEvent('tool_call', {
            tool_call: toolCall,
            content: content || ''
        });
    }

    async addNativeToolResult(toolCall, result) {
        await this._pushTurn(createNativeToolResultTurn(toolCall, result));
        this.traceEvent('tool_result', {
            tool_call: toolCall,
            result
        });
    }

    async _pushTurn(turn) {
        turn = normalizeHistoryTurn(turn);
        this.turns.push(turn);
        this.traceEvent('history_turn_added', {
            turn,
            active_turn_count: this.turns.length
        });

        await this.compactHistoryIfNeeded();
    }

    async save() {
        try {
            const data = {
                memory: this.memory,
                turns: this.turns,
                updated_at: new Date().toISOString(),
                chat_history_trace: this.chat_history_session_fp,
                chat_history_latest: this.chat_history_latest_fp,
                self_prompting_state: this.agent.self_prompter.state,
                self_prompt: this.agent.self_prompter.isStopped() ? null : this.agent.self_prompter.prompt,
                taskStart: this.agent.task.taskStartTime,
                last_sender: this.agent.last_sender
            };
            writeFileSync(this.memory_fp, JSON.stringify(data, null, 2));
            console.log('Saved memory to:', this.memory_fp);
        } catch (error) {
            console.error('Failed to save history:', error);
            throw error;
        }
    }

    load() {
        try {
            if (!existsSync(this.memory_fp)) {
                console.log('No memory file found.');
                return null;
            }
            const data = JSON.parse(readFileSync(this.memory_fp, 'utf8'));
            this.memory = data.memory || '';
            this.turns = Array.isArray(data.turns) ? data.turns.map(normalizeHistoryTurn) : [];
            if (this.memory && !this.turns.some(turn => turn.compact_summary)) {
                this.turns = [
                    createCompactBoundaryTurn({ trigger: 'load', summarized_turn_count: 0 }),
                    createCompactSummaryTurn(this.memory, this.full_history_fp),
                    ...this.turns
                ];
            }
            console.log('Loaded memory:', this.memory);
            return data;
        } catch (error) {
            console.error('Failed to load history:', error);
            throw error;
        }
    }

    clear() {
        this.turns = [];
        this.memory = '';
        this.traceEvent('history_cleared', {});
    }

    traceLLMRequest(tag, model, systemPrompt, messages, tools = null) {
        this.traceEvent('llm_request', {
            tag,
            model: describeModel(model),
            system_prompt: systemPrompt,
            messages,
            tools: Array.isArray(tools) ? tools : null,
            tool_count: Array.isArray(tools) ? tools.length : 0
        });
    }

    traceLLMResponse(tag, model, response) {
        this.traceEvent('llm_response', {
            tag,
            model: describeModel(model),
            response,
            token_usage: model?.lastTokenUsage || null
        });
    }

    traceLLMError(tag, model, error) {
        this.traceEvent('llm_error', {
            tag,
            model: describeModel(model),
            error: {
                name: error?.name,
                message: error?.message || String(error),
                stack: error?.stack
            }
        });
    }

    traceEvent(type, payload = {}) {
        const writeFullTrace = this.fullTraceEnabled();
        const showChatEvent = this.chatDisplayEnabled() && isChatDisplayEvent(type);
        const persistRuntimeEvent = writeFullTrace || showChatEvent;
        if (!persistRuntimeEvent) {
            return;
        }
        if (!this.chat_history_session_fp) {
            this._initChatHistoryTrace();
        }
        const event = {
            timestamp: new Date().toISOString(),
            agent: this.name,
            type,
            ...payload
        };
        const line = safeStringify(event) + '\n';
        try {
            appendFileSync(this.chat_history_session_fp, line, 'utf8');
            appendFileSync(this.chat_history_latest_fp, line, 'utf8');
        } catch (error) {
            console.error(`Failed to write ${this.name}'s chat history trace:`, error);
        }
        if (writeFullTrace || showChatEvent) {
            sendTraceEventToServer(this.name, event);
        }
    }

    _initChatHistoryTrace() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.chat_history_session_fp = `${this.chat_history_dir}/${timestamp}.jsonl`;
        writeFileSync(this.chat_history_session_fp, '', 'utf8');
        writeFileSync(this.chat_history_latest_fp, '', 'utf8');
        this.traceEvent('session_started', {
            session_trace: this.chat_history_session_fp,
            latest_trace: this.chat_history_latest_fp,
            max_messages: this.max_messages,
            compact_message_threshold_percent: this.compact_message_threshold_percent
        });
    }

    fullTraceEnabled() {
        return settings.log_chat_trace === true;
    }

    chatDisplayEnabled() {
        return settings.show_chat_history !== false;
    }
}

function isChatDisplayEvent(type) {
    return [
        'llm_request',
        'llm_response',
        'llm_error',
        'history_turn_added',
        'tool_call',
        'tool_result',
        'history_cleared',
        'history_compacted'
    ].includes(type);
}

function describeModel(model) {
    if (!model || typeof model !== 'object') {
        return null;
    }
    return {
        api: model.constructor?.prefix || model.api || null,
        provider: model.provider || model.params?.provider || null,
        model: model.model_name || model.default_model || null,
        supports_native_tool_calls: Boolean(model.supportsNativeToolCalls)
    };
}

function safeStringify(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return JSON.stringify(makeJsonSafe(value));
    }
}

function makeJsonSafe(value, seen = new WeakSet()) {
    if (value === null || typeof value !== 'object') {
        if (typeof value === 'bigint') return value.toString();
        return value;
    }
    if (seen.has(value)) {
        return '[Circular]';
    }
    seen.add(value);
    if (Array.isArray(value)) {
        return value.map(item => makeJsonSafe(item, seen));
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'function') continue;
        out[key] = makeJsonSafe(item, seen);
    }
    return out;
}


function normalizePercent(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return fallback;
    return Math.min(100, num);
}

function isDuplicateSelfPromptReminder(turns, content) {
    if (typeof content !== 'string' || !content.startsWith('System: Continue working on your current goal:')) {
        return false;
    }
    return getTurnsAfterLastCompactBoundary(turns).some(turn => turn?.role === 'user' && turn?.content === content);
}

function createCompactBoundaryTurn(metadata = {}) {
    return normalizeHistoryTurn({
        role: 'system',
        content: 'Conversation compacted.',
        compact_boundary: true,
        subtype: 'compact_boundary',
        compact_metadata: metadata
    });
}

function createCompactSummaryTurn(summary, archiveFile) {
    const archiveNote = archiveFile ? `\n\nFull archived history before this compact is stored at: ${archiveFile}` : '';
    return {
        role: 'user',
        content: `System: This session is being continued from an earlier conversation that was compacted. The summary below replaces the earlier messages. Recent messages after this summary are preserved verbatim.\n\nSummary:\n${String(summary || '').trim()}${archiveNote}`,
        compact_summary: true,
        is_compact_summary: true,
        archive_file: archiveFile || null
    };
}

function getTurnsAfterLastCompactBoundary(turns = []) {
    const index = turns.findLastIndex(turn => turn?.compact_boundary || turn?.subtype === 'compact_boundary');
    return index === -1 ? turns : turns.slice(index);
}

export function normalizeHistoryTurn(turn) {
    if (!turn || typeof turn !== 'object') {
        return turn;
    }
    if (turn.role !== 'system') {
        return turn;
    }
    return {
        ...turn,
        role: 'user',
        content: `System: ${turn.content || ''}`
    };
}
