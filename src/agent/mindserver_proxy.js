import { io } from 'socket.io-client';
import convoManager from './conversation.js';
import { setSettings } from './settings.js';
import { getFullState } from './library/full_state.js';
import { validatePolicy, LAYERS, loadPolicyState, savePolicyState, clearPolicyState, composePolicy, describePolicyState, setPolicyLocked, isPolicyLocked, generatePolicy, applyPolicyGoal } from './behavior/policy.js';

// agent's individual connection to the mindserver
// always connect to localhost

class MindServerProxy {
    constructor() {
        if (MindServerProxy.instance) {
            return MindServerProxy.instance;
        }
        
        this.socket = null;
        this.connected = false;
        this.agents = [];
        MindServerProxy.instance = this;
    }

    async connect(name, port) {
        if (this.connected) return;
        
        this.name = name;
        // Inherited from the parent mindcraft process when the mindserver
        // requires a token; undefined when it does not.
        this.socket = io(`http://localhost:${port}`, {
            auth: { token: process.env.MINDSERVER_AUTH_TOKEN ?? null }
        });

        await new Promise((resolve, reject) => {
            this.socket.on('connect', resolve);
            this.socket.on('connect_error', (err) => {
                console.error('Connection failed:', err);
                reject(err);
            });
        });

        this.connected = true;
        console.log(name, 'connected to MindServer');

        this.socket.on('disconnect', (reason) => {
            console.log('Disconnected from MindServer:', reason);
            this.connected = false;
            // socket.io reconnects on its own, so a stalled event loop or a
            // momentary blip on a localhost socket should not cost the agent
            // its whole process. Only give up if it is still down later.
            // A server-initiated disconnect does not auto-reconnect.
            if (reason === 'io server disconnect') this.socket.connect();
            clearTimeout(this.reconnect_timer);
            // ponytail: fixed grace period, make it a setting if it ever needs tuning
            this.reconnect_timer = setTimeout(() => {
                if (!this.connected && this.agent) {
                    this.agent.cleanKill('Could not reconnect to MindServer. Killing agent process.');
                }
            }, 30000);
        });

        this.socket.on('connect', () => {
            clearTimeout(this.reconnect_timer);
            // Re-announce on EVERY connect, before the `connected` bookkeeping.
            // It used to return early when this.connected was still true, which
            // meant a reconnect the client did not register as a disconnect
            // never re-announced -- and the server had already dropped the
            // registration, permanently. Both emits are idempotent (the server
            // rebinds by name), so announcing twice costs nothing and never
            // announcing costs the agent its entire control plane.
            this.socket.emit('connect-agent-process', name);
            // login_time is only set once the bot is actually in the world.
            if (this.agent?.login_time) this.socket.emit('login-agent', name, this.agent.aliveMs());
            if (this.connected) return;
            this.connected = true;
            console.log(name, 'reconnected to MindServer');
        });

        this.socket.on('chat-message', (agentName, json) => {
            convoManager.receiveFromBot(agentName, json);
        });

        this.socket.on('agents-status', (agents) => {
            this.agents = agents;
            convoManager.updateAgents(agents);
            if (this.agent?.task) {
                console.log(this.agent.name, 'updating available agents');
                this.agent.task.updateAvailableAgents(agents);
            }
        });

        this.socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            this.agent.cleanKill();
        });
		
        this.socket.on('send-message', async (data) => {
            try {
                // The UI can send a message before the agent has spawned and
                // installed respondFunc. Dropping the user's first message with
                // a TypeError is worse than waiting a few seconds for it.
                for (let i = 0; i < 20 && !this.agent?.respondFunc; i++) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                if (!this.agent?.respondFunc) {
                    console.warn('agent is not ready to receive messages yet, dropping:', data.message);
                    return;
                }
                this.agent.respondFunc(data.from, data.message);
            } catch (error) {
                console.error('Error: ', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            }
        });

        this.socket.on('get-full-state', (callback) => {
            try {
                const state = getFullState(this.agent);
                callback(state);
            } catch (error) {
                console.error('Error getting full state:', error);
                callback(null);
            }
        });

        this.socket.on('get-policy', (callback) => {
            try {
                callback(loadPolicyState(this.agent.name)); // {layers, locked}, empty layers if none
            } catch (error) {
                console.error('Error getting policy:', error);
                callback(null);
            }
        });

        this.socket.on('get-memory', (callback) => {
            callback(this.agent.history.memory ?? '');
        });

        this.socket.on('set-memory', (text, callback) => {
            try {
                this.agent.history.memory = String(text ?? '').slice(0, 500);
                this.agent.history.save().catch(e => console.error('Failed to persist edited memory:', e));
                callback({ success: true });
            } catch (error) {
                console.error('Error setting memory:', error);
                callback({ success: false, error: error.message });
            }
        });

        this.socket.on('set-policy', (data, callback) => {
            try {
                const modes = this.agent.bot?.modes;
                if (!data?.layers || Object.keys(data.layers).length === 0) {
                    modes?.clearPolicy();
                    clearPolicyState(this.agent.name);
                    return callback({ success: true });
                }
                // Keep the locked flag, and keep the compose recipe: hand-editing
                // the generated policy is not abandoning it, and dropping the
                // recipe here would make "regenerate" impossible afterwards.
                const state = loadPolicyState(this.agent.name);
                // A layer the caller did not mention is a layer the caller was
                // not editing, so leave it alone. Wiping every layer first and
                // rebuilding from what arrived meant any client that read the
                // policy badly -- or not at all -- silently destroyed the rules
                // the agent had written for itself. Clearing is still possible,
                // it just has to be said out loud now: send the layer as null.
                for (const layer of LAYERS) {
                    if (!(layer in data.layers)) continue;
                    const l = data.layers[layer];
                    if (l === null) { delete state.layers[layer]; continue; }
                    if (!l?.policy) continue;
                    const err = validatePolicy(l.policy);
                    if (err) return callback({ success: false, error: `${layer}: ${err}` });
                    state.layers[layer] = {
                        profile: l.profile ?? null,
                        source: typeof l.source === 'string' ? [l.source] : (l.source ?? ['edited via web UI']),
                        policy: l.policy,
                    };
                }
                const composed = composePolicy(state);
                if (composed.rules.length === 0 && Object.keys(composed.modes).length === 0)
                    modes?.clearPolicy();
                else
                    modes?.installPolicy(composed, describePolicyState(state));
                savePolicyState(this.agent.name, state);
                this.agent.history.add('system', `Your policy was edited via the web UI. It is now:\n${describePolicyState(state)}`);
                applyPolicyGoal(this.agent, state).catch(err => console.error('Error starting policy goal:', err));
                callback({ success: true });
            } catch (error) {
                console.error('Error setting policy:', error);
                callback({ success: false, error: error.message });
            }
        });

        // Merging a base with its attributes is an LLM call, so this handler can
        // sit for tens of seconds. The server side waits with a long timeout;
        // there is nothing to stream back, the answer is one whole policy.
        this.socket.on('generate-policy', async ({ base, attributes } = {}, callback) => {
            try {
                const state = await generatePolicy(this.agent, base, attributes ?? []);
                const modes = this.agent.bot?.modes;
                const composed = composePolicy(state);
                if (composed.rules.length === 0 && Object.keys(composed.modes).length === 0)
                    modes?.clearPolicy();
                else
                    modes?.installPolicy(composed, describePolicyState(state));
                savePolicyState(this.agent.name, state);
                this.agent.history.add('system', `Your policy was regenerated from the profile library. It is now:\n${describePolicyState(state)}`);
                // The merged profiles may carry a goal, which is the only half of
                // a policy that goes looking for work rather than waiting to be
                // triggered. Starting it is an LLM loop, so it happens after the
                // state is saved and never blocks the reply.
                applyPolicyGoal(this.agent, state).catch(err => console.error('Error starting policy goal:', err));
                callback({ success: true, state });
            } catch (error) {
                console.error('Error generating policy:', error);
                callback({ success: false, error: error.message });
            }
        });

        // The lock is a human's decision about the agent, so it is persisted on
        // disk rather than held in memory: it has to survive a restart the agent
        // itself may have asked for.
        this.socket.on('set-policy-lock', (locked, callback) => {
            try {
                setPolicyLocked(this.agent.name, locked);
                this.agent.history.add('system', locked
                    ? 'Your policy was locked by an admin. You may not load policy profiles until it is unlocked.'
                    : 'Your policy was unlocked by an admin. You may load policy profiles again.');
                callback({ success: true, locked: isPolicyLocked(this.agent.name) });
            } catch (error) {
                console.error('Error setting policy lock:', error);
                callback({ success: false, error: error.message });
            }
        });

        // Request settings and wait for response
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Settings request timed out after 5 seconds'));
            }, 5000);

            this.socket.emit('get-settings', name, (response) => {
                clearTimeout(timeout);
                if (response.error) {
                    return reject(new Error(response.error));
                }
                setSettings(response.settings);
                this.socket.emit('connect-agent-process', name);
                resolve();
            });
        });
    }

    setAgent(agent) {
        this.agent = agent;
    }

    getAgents() {
        return this.agents;
    }

    getNumOtherAgents() {
        return this.agents.length - 1;
    }

    login() {
        this.socket.emit('login-agent', this.agent.name, this.agent.aliveMs());
    }

    reportDeath() {
        this.socket.emit('agent-died', this.agent.name);
    }

    shutdown() {
        this.socket.emit('shutdown');
    }

    getSocket() {
        return this.socket;
    }
}

// Create and export a singleton instance
export const serverProxy = new MindServerProxy();

// for chatting with other bots
export function sendBotChatToServer(agentName, json) {
    serverProxy.getSocket().emit('chat-message', agentName, json);
}

// for sending general output to server for display
export function sendOutputToServer(agentName, message) {
    serverProxy.getSocket().emit('bot-output', agentName, message);
}
