import { writeFileSync, readFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { NPCData } from './npc/data.js';
import settings from './settings.js';


/**
 * Trim a memory summary to a length the model will not choke on, ending on a
 * sentence rather than wherever the character count ran out.
 *
 * A hard slice cut Andy's memory mid-word -- he loaded back "...Stuck on snow;
 * going undergro" and one summary ended mid-sentence on "resurfacing after
 * drowning; must prioritize getting out...(Memory". The lost tail is the most
 * recent thing that happened to him, which is the part worth keeping.
 */
export function truncateMemory(memory, limit) {
    if (!memory || memory.length <= limit) return memory;
    const head = memory.slice(0, limit);
    // Prefer a sentence end, settle for a word boundary, and only butcher the
    // text if it contains neither.
    const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; '), head.lastIndexOf('! '));
    const cut = sentence > limit / 2 ? sentence + 1 : (head.lastIndexOf(' ') > 0 ? head.lastIndexOf(' ') : limit);
    return head.slice(0, cut).trimEnd() +
        ` ...(truncated at ${limit} chars, keep it shorter and the rest survives)`;
}

export class History {
    constructor(agent) {
        this.agent = agent;
        this.name = agent.name;
        this.memory_fp = `./bots/${this.name}/memory.json`;
        this.full_history_fp = undefined;

        mkdirSync(`./bots/${this.name}/histories`, { recursive: true });

        this.turns = [];

        // Natural language memory as a summary of recent messages + previous memory
        this.memory = '';

        // Maximum number of messages to keep in context before saving chunk to memory
        this.max_messages = settings.max_messages;

        // Number of messages to remove from current history and save into memory.
        // Bigger chunks = fewer LLM compression calls; 10 halved Andy's memory
        // traffic (was ~28% of all LLM calls) with no observed recall loss.
        this.summary_chunk_size = 10;
        // chunking reduces expensive calls to promptMemSaving and appendFullHistory
        // and improves the quality of the memory summary
    }

    getHistory() { // expects an Examples object
        return JSON.parse(JSON.stringify(this.turns));
    }

    async summarizeMemories(turns) {
        console.log("Storing memories...");
        this.memory = await this.agent.prompter.promptMemSaving(turns);

        this.memory = truncateMemory(this.memory, 500);

        console.log("Memory updated to: ", this.memory);
    }

    // Append-only, one JSON object per line. This used to read, parse, push,
    // pretty-print and rewrite the entire file synchronously on every batch --
    // quadratic in session length, on the main thread, and the files reached
    // 562 KB. JSONL is the same data with none of that; read it back with
    // .split('\n').filter(Boolean).map(JSON.parse).
    async appendFullHistory(to_store) {
        if (this.full_history_fp === undefined) {
            const string_timestamp = new Date().toLocaleString().replace(/[/:]/g, '-').replace(/ /g, '').replace(/,/g, '_');
            this.full_history_fp = `./bots/${this.name}/histories/${string_timestamp}.jsonl`;
        }
        try {
            appendFileSync(this.full_history_fp, to_store.map(t => JSON.stringify(t) + '\n').join(''), 'utf8');
        } catch (err) {
            console.error(`Error writing ${this.name}'s full history file: ${err.message}`);
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
        this.turns.push({role, content});

        if (this.turns.length >= this.max_messages) {
            let chunk = this.turns.splice(0, this.summary_chunk_size);
            while (this.turns.length > 0 && this.turns[0].role === 'assistant')
                chunk.push(this.turns.shift()); // remove until turns starts with system/user message

            await this.summarizeMemories(chunk);
            await this.appendFullHistory(chunk);
        }
    }

    async save() {
        try {
            const data = {
                memory: this.memory,
                turns: this.turns,
                self_prompting_state: this.agent.self_prompter.state,
                self_prompt: this.agent.self_prompter.isStopped() ? null : this.agent.self_prompter.prompt,
                taskStart: this.agent.task.taskStartTime,
                last_sender: this.agent.last_sender,
                last_death_time: this.agent.last_death_time,
                alive_ms: this.agent.aliveMs()
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
            // A truncated or corrupt memory file (a wipe, or a crash mid-write)
            // used to rethrow here, which kills the agent on every start --
            // a crash loop that can only be broken by hand. Starting fresh is
            // strictly better: the file is about to be overwritten anyway.
            console.error('Failed to load memory, starting fresh:', error.message);
            this.memory = '';
            this.turns = [];
            return null;
        }
    }

    clear() {
        this.turns = [];
        this.memory = '';
    }
}