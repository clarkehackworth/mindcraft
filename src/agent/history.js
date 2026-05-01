import { writeFileSync, readFileSync, mkdirSync, existsSync, appendFileSync } from 'fs';
import { NPCData } from './npc/data.js';
import settings from './settings.js';
import { createNativeToolCallTurn, createNativeToolResultTurn } from '../models/native_tools.js';


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

        // Natural language memory as a summary of recent messages + previous memory
        this.memory = '';

        // Maximum number of messages to keep in context before saving chunk to memory
        this.max_messages = settings.max_messages;

        // Number of messages to remove from current history and save into memory
        this.summary_chunk_size = 5; 
        // chunking reduces expensive calls to promptMemSaving and appendFullHistory
        // and improves the quality of the memory summary

        this._initChatHistoryTrace();
    }

    getHistory() { // expects an Examples object
        return JSON.parse(JSON.stringify(this.turns));
    }

    async summarizeMemories(turns) {
        console.log("Storing memories...");
        const previousMemory = this.memory;
        this.memory = await this.agent.prompter.promptMemSaving(turns);

        if (this.memory.length > 500) {
            this.memory = this.memory.slice(0, 500);
            this.memory += '...(Memory truncated to 500 chars. Compress it more next time)';
        }

        console.log("Memory updated to: ", this.memory);
        this.traceEvent('memory_compression_completed', {
            previous_memory: previousMemory,
            new_memory: this.memory,
            compressed_turns: turns
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
            role = 'system';
        }
        else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }
        await this._pushTurn({role, content});
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
        this.turns.push(turn);
        this.traceEvent('history_turn_added', {
            turn,
            active_turn_count: this.turns.length
        });

        if (this.turns.length >= this.max_messages) {
            let chunk = this.turns.splice(0, this.summary_chunk_size);
            while (this.turns.length > 0 && ['assistant', 'tool'].includes(this.turns[0].role))
                chunk.push(this.turns.shift()); // remove until turns starts with system/user message

            this.traceEvent('memory_compression_started', {
                active_turn_count_before_compression: this.turns.length + chunk.length,
                compressed_turns: chunk,
                remaining_turns: this.turns,
                previous_memory: this.memory
            });
            await this.summarizeMemories(chunk);
            const historyFile = await this.appendFullHistory(chunk);
            this.traceEvent('history_chunk_archived', {
                full_history_file: historyFile,
                compressed_turns: chunk
            });
        }
    }

    async save() {
        try {
            const data = {
                memory: this.memory,
                turns: this.turns,
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
            this.turns = data.turns || [];
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
            response
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
            summary_chunk_size: this.summary_chunk_size
        });
    }
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
