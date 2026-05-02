(function attachChatTraceProjector(global) {
    'use strict';

    function callHelper(name, ...args) {
        const helper = global[name];
        if (typeof helper !== 'function') {
            throw new Error(`ChatTraceProjector helper ${name} is not available`);
        }
        return helper(...args);
    }

class ChatTraceProjector {
    constructor(events = []) {
        this.events = Array.isArray(events) ? events : [];
        this.thread = { systemPrompt: null, systemEvent: null, tools: null, toolsEvent: null, instructionContexts: [], turns: [] };
        this.current = null;
        this.previousRequestMessages = [];
    }

    build() {
        this.events.forEach(event => this.addEvent(event));
        return this.thread;
    }

    addEvent(event) {
        if (!event || typeof event !== 'object') return;
        switch (event.type) {
            case 'instruction_context':
                this.addInstructionContext(event);
                break;
            case 'llm_request':
                this.addRequest(event);
                break;
            case 'llm_response':
                this.addResponse(event);
                break;
            case 'history_turn_added':
                this.addHistoryTurn(event);
                break;
            case 'history_compacted':
                this.addCompactEvent(event);
                break;
            case 'tool_call':
                this.addToolCall(event);
                break;
            case 'tool_result':
                this.addToolResult(event);
                break;
            case 'llm_error':
                this.addError(event);
                break;
            default:
                break;
        }
    }

    createTurn(seed = {}) {
        return {
            request: null,
            response: null,
            errors: [],
            historyMessages: [],
            inlineHistoryMessages: [],
            compacted: null,
            toolRuns: [],
            visibleRequestMessages: [],
            requestMessageCount: 0,
            assistantText: '',
            assistantThinking: '',
            assistantToolCalls: [],
            modelLabel: 'model',
            ...seed
        };
    }

    ensureTurn() {
        if (!this.current) {
            this.current = this.createTurn();
            this.thread.turns.push(this.current);
        }
        return this.current;
    }

    addInstructionContext(event) {
        this.thread.instructionContexts.push(event);
    }

    addRequest(event) {
        if (event.tag === 'coding' && this.attachInternalToolEvent(event)) return;
        this.captureThreadContext(event);

        const requestMessages = Array.isArray(event.messages) ? event.messages : [];
        const pendingHistoryMessages = this.takePendingHistoryOnlyTurn();
        this.removeRequestIncludedHistory(this.current, requestMessages);

        this.current = this.createTurn({
            request: event,
            historyMessages: pendingHistoryMessages,
            visibleRequestMessages: callHelper('selectVisibleRequestMessages', requestMessages, this.previousRequestMessages),
            requestMessageCount: requestMessages.length
        });
        this.previousRequestMessages = requestMessages;
        this.updateTurnProjection(this.current);
        this.thread.turns.push(this.current);
    }

    addResponse(event) {
        if (event.tag === 'coding' && this.attachInternalToolEvent(event)) return;
        const turn = this.ensureTurn();
        turn.response = event;
        this.updateTurnProjection(turn);
    }

    addHistoryTurn(event) {
        const turn = this.ensureTurn();
        turn.historyMessages.push(event);
        this.updateTurnProjection(turn);
    }

    addCompactEvent(event) {
        const turn = this.ensureTurn();
        turn.compacted = event;
        this.updateTurnProjection(turn);
        this.current = null;
    }

    addToolCall(event) {
        const turn = this.ensureTurn();
        turn.toolRuns.push({ event, call: event.tool_call, result: null, internalEvents: [] });
        this.updateTurnProjection(turn);
    }

    addToolResult(event) {
        const turn = this.ensureTurn();
        const match = this.findToolRunForResult(turn, event);
        if (match) {
            match.result = event;
        } else {
            turn.toolRuns.push({ event, call: event.tool_call, result: event, internalEvents: [] });
        }
        this.updateTurnProjection(turn);
    }

    addError(event) {
        if (event.tag === 'coding' && this.attachInternalToolEvent(event)) return;
        const turn = this.ensureTurn();
        turn.errors.push(event);
        this.updateTurnProjection(turn);
    }

    captureThreadContext(event) {
        if (!this.thread.systemPrompt && event.system_prompt) {
            this.thread.systemPrompt = event.system_prompt;
            this.thread.systemEvent = event;
        }
        if (!this.thread.tools && Array.isArray(event.tools)) {
            this.thread.tools = event.tools;
            this.thread.toolsEvent = event;
        }
    }

    takePendingHistoryOnlyTurn() {
        if (!isHistoryOnlyProjectionTurn(this.current)) return [];
        const pendingHistoryMessages = this.current.historyMessages;
        this.thread.turns.pop();
        return pendingHistoryMessages;
    }

    removeRequestIncludedHistory(turn, requestMessages) {
        if (!turn?.historyMessages?.length) return;
        turn.historyMessages = turn.historyMessages
            .filter(historyEvent => !callHelper('isHistoryTurnIncludedInRequest', historyEvent.turn, requestMessages));
        this.updateTurnProjection(turn);
    }

    attachInternalToolEvent(event) {
        const item = this.findInternalToolHost(this.current);
        if (!item) return false;
        item.internalEvents = item.internalEvents || [];
        item.internalEvents.push(event);
        this.updateTurnProjection(this.current);
        return true;
    }

    findInternalToolHost(turn) {
        if (!turn?.toolRuns?.length) return null;
        const reversed = turn.toolRuns.slice().reverse();
        return reversed.find(item => callHelper('getToolName', item.call) === 'newAction' && !item.result)
            || reversed.find(item => !item.result)
            || reversed[0];
    }

    findToolRunForResult(turn, event) {
        const resultId = callHelper('getToolCallId', event.tool_call);
        return turn.toolRuns.slice().reverse().find(item => {
            const callId = callHelper('getToolCallId', item.call);
            return callId && resultId ? callId === resultId : callHelper('getToolName', item.call) === callHelper('getToolName', event.tool_call) && !item.result;
        });
    }

    updateTurnProjection(turn) {
        if (!turn) return;
        const requestMessages = Array.isArray(turn.request?.messages) ? turn.request.messages : [];
        const hasToolRuns = turn.toolRuns.length > 0;
        turn.inlineHistoryMessages = turn.historyMessages.filter(event => shouldRenderInlineHistoryEvent(event, requestMessages, hasToolRuns));
        turn.modelLabel = getTurnModelLabel(turn);
        turn.assistantText = callHelper('extractResponseText', turn.response?.response);
        turn.assistantThinking = callHelper('extractResponseThinking', turn.response?.response, turn.response?.thinking);
        const responseCalls = callHelper('extractResponseToolCalls', turn.response?.response);
        turn.assistantToolCalls = hasToolRuns ? [] : responseCalls;
    }
}

function isHistoryOnlyProjectionTurn(turn) {
    return Boolean(turn)
        && !turn.request
        && !turn.response
        && !turn.compacted
        && (!turn.toolRuns || turn.toolRuns.length === 0)
        && (!turn.errors || turn.errors.length === 0)
        && Array.isArray(turn.historyMessages)
        && turn.historyMessages.length > 0;
}

function shouldRenderInlineHistoryEvent(event, requestMessages, hasToolRuns) {
    const role = event?.turn?.role;
    if (callHelper('isHistoryTurnIncludedInRequest', event?.turn, requestMessages)) return false;
    if (!hasToolRuns) return role === 'user';
    return role === 'user' && !String(event?.turn?.content || '').startsWith('System:');
}

function getTurnModelLabel(turn) {
    const request = turn?.request;
    const response = turn?.response;
    return request?.model?.display_label
        || response?.model?.display_label
        || request?.model?.model
        || request?.model?.api
        || response?.model?.model
        || response?.model?.api
        || 'model';
}


    global.ChatTraceProjector = ChatTraceProjector;
    global.buildChatThread = function buildChatThread(events) {
        return new ChatTraceProjector(events).build();
    };
})(window);
