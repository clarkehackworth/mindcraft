import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import * as skills from './library/skills.js';
import { applyPolicyGoal, loadPolicyState, policyGoal } from './behavior/policy.js';
import { initBot, isHostile } from '../utils/mcdata.js';
import { getNearestEntityWhere } from './library/world.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands } from './commands/index.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';
import { notePathFailure, noteUnreachable } from './path_spin.js';

// sysexits EX_TEMPFAIL: "try again shortly, and do not hold it against me".
// agent_process restarts on this without counting it as a crash. Keep in sync
// with the copy there -- one small number, versus importing child_process and
// the mindserver into every agent to share it.
const TEMPFAIL_EXIT = 75;
// How many stuck resets on the SAME block before the bot stops trying and walks
// away. Low enough that a wedge costs seconds rather than half an hour -- 269 of
// 318 resets in one window were a single grave block -- and high enough that
// ordinary terrain the bot clears on the second attempt never trips it.
const STUCK_SAME_SPOT = 8;
// How close something hostile has to be for a pathfinder search to be worth
// abandoning when the bot takes a hit. Melee reach plus a step: far enough to
// catch the zombie already swinging, near enough that an archer across a valley
// does not cancel every path the bot plans.
const HOSTILE_PANIC_RANGE = 6;
// How long a rule action stays protected from a stale self-prompt command
// before it is considered stuck and fresh commands are let through (see P8 in
// handleMessage). One self-prompt turn: long enough that the command the model
// committed to before the rule fired is still suppressed, short enough that a
// move_away wedged in a pit starts yielding to the model's own escape attempts
// instead of swallowing them for the action's full 120s timeout.
const STALE_COMMAND_WINDOW_MS = 60000;

/**
 * Is this connection error upstream weather rather than a broken agent?
 *
 * Mojang's auth API fails transiently, and it accounted for 45 of 194 agent
 * crashes in one log. So does the Minecraft server simply being down: while
 * minecraft-prominence2 restarted during soak 14, every connect attempt came
 * back ECONNREFUSED, and the supervisor filed all eight as crashes. Nothing was
 * wrong with the agent -- there was no server to connect to -- but the counter
 * does not decay, so a deliberate restart twenty minutes later landed on a
 * poisoned counter, got "Andy is crash-looping", and sat out a 300s backoff.
 *
 * Transient exits are still counted, just on their own gentler budget, so a
 * link flapping without end is still throttled.
 */
export function isTransientConnectError(err) {
    const text = String(err);
    return /Failed to obtain profile data|does the account own minecraft/i.test(text)
        || text.includes('ECONNREFUSED');
}

// In-process reconnects before giving up and letting the supervisor start a
// fresh process. Bounded because a reconnect only rebuilds what we know about:
// if something subtler is wrong -- a leaked handler, a wedged pathfinder, a
// corrupt registry -- a new process is the only thing that clears it, and
// retrying forever in here would hide that instead of surfacing it.
const MAX_INPROC_RECONNECTS = 5;
const RECONNECT_DELAY_MS = 5000;
// A connection has to have been genuinely working before a drop counts as a
// blip worth retrying in place. Anything that dies faster than this never got
// going, and repeating it in-process would just spin.
// Spawning IS the evidence that the connection worked -- it means login,
// registry sync and the world handshake all completed -- so this only has to be
// long enough to exclude a connection that spawns and immediately dies. 60s was
// far too generous: measured drops on this server run 59s to 1426s, so the
// threshold sat in the middle of the real distribution and kept rejecting
// sessions that had plainly been playing. Two in a row were refused at 57-59s
// and paid for a whole process restart each.
const HEALTHY_SESSION_MS = 15 * 1000;

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.count_id = count_id;
        this._disconnectHandled = false;

        // Initialize components
        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        console.log(`Initializing agent ${this.name}...`);
        
        // Validate Name Format
        // connection_handler now ensures the message has [LoginGuard] prefix
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }
        
        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.self_prompter = new SelfPrompter(this);
        convoManager.initAgent(this);
        await this.prompter.initExamples();

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        // Everything above is built once per process. Everything below belongs
        // to one connection and is rebuilt each time we reconnect, so it lives
        // in _connect().
        this._save_data = save_data;
        this._init_message = init_message;
        this._count_id = count_id;
        this._load_mem = load_mem;
        this._reconnects = 0;
        this._connected_once = false;
        await this._connect();
    }

    // One connection's worth of setup: a fresh bot object and every handler
    // bound to it. Safe to run more than once -- the pieces that must happen
    // exactly once per process (the browser viewer's port, the NPC controller,
    // the update loop, the greeting) guard themselves on _connected_once.
    async _connect() {
        const save_data = this._save_data;
        const init_message = this._init_message;
        const count_id = this._count_id;
        this._disconnectHandled = false;

        // Not ready until the new bot SPAWNS. _connect returns as soon as the
        // handlers are bound, which is many seconds before bot.entity exists --
        // and every piece of this agent that asks where it is reads
        // bot.entity.position. See _awaitReady.
        this._ready = false;
        // P10: the liveness watchdog below must stay out of the way while the bot is
        // still authenticating. A MSA device-code login produces no server time
        // packets until it is approved, so "silence" there is normal, not a dead
        // connection. The 300s spawn_timeout owns that window; _logged_in flips in
        // the 'login' handler and re-arms the watchdog for real (post-login) drops.
        this._logged_in = false;

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);

        const onDisconnect = (event, reason, code = 1) => this._handleDisconnect(reason, code);
        
        // Bind events
        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        // Mojang's auth API fails transiently, and it accounted for 45 of 194
        // agent crashes in one log. It is not a real "the account does not own
        // minecraft" -- the next attempt logs in fine. Left unrecognised, the
        // connection just never spawns and the agent sits idle for the full
        // spawn_timeout (30s) before exiting anyway, so treat it as the
        // disconnect it is: exit now and let agent_process retry on its
        // existing exponential backoff instead of burning half a minute first.
        this.bot.on('error', (err) => {
            if (isTransientConnectError(err)) {
                // Mojang having a moment, or the server being down. Neither is a
                // broken agent, so exit EX_TEMPFAIL: the parent retries promptly
                // and keeps it off the crash backoff, which would otherwise
                // stretch a short outage into 5-minute waits.
                onDisconnect('Error', err, TEMPFAIL_EXIT);
            } else if (String(err).includes('Duplicate')) {
                 onDisconnect('Error', err);
            } else {
                 log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
            }
        });

        initModes(this);

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            this.login_time = Date.now();
            // P10: we are now authenticated. Silence from here on is suspicious, so
            // re-arm the liveness watchdog and start its clock from this moment -- not
            // from _connect, which can be 300s earlier in the interactive auth flow.
            this._logged_in = true;
            this._livenessLastUpdate = Date.now();
            this.alive_mark = Date.now(); // resume accumulating connected time
            serverProxy.login();
            
            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            if (this.prompter.profile.skin)
                this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
            else
                this.bot.chat(`/skin clear`);
        });
		const spawnTimeoutDuration = settings.spawn_timeout;
        // Both timers belong to the connection, and both used to be cleared by
        // a handler on the bot -- which _reconnect's removeAllListeners strips.
        // Held on `this` and cleared here instead, or every reconnect leaks a
        // watchdog that later kills a perfectly healthy connection.
        clearTimeout(this._spawn_timeout);
        clearInterval(this._liveness);
        this._spawn_timeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        // Liveness watchdog. The game connection can die half-open: the server
        // drops the bot ("lost connection: Timed out") but no 'end' or 'error'
        // ever fires client-side, and the agent sat as a zombie for 2.5 hours.
        // Server time-sync packets arrive every second while the connection is
        // real, so their silence is connection death regardless of what the
        // socket thinks. It routes through the disconnect handler like any
        // other drop, so a half-open socket is now a reconnect rather than a
        // guaranteed process death.
        this._livenessLastUpdate = Date.now();
        this.bot.on('time', () => { this._livenessLastUpdate = Date.now(); });
        this._liveness = setInterval(() => {
            // P10: during the pre-login auth phase there are no server time packets
            // by design, so silence is not a dead connection. Let the 300s
            // spawn_timeout handle an unapproved device code instead of killing the
            // login ~188s in and forcing a rotating new code no one can race.
            if (!this._logged_in) return;
            const silent_ms = Date.now() - this._livenessLastUpdate;
            if (silent_ms <= 180000) return;
            // The watchdog used to clearInterval itself here, before calling the
            // thing it guards. _handleDisconnect early-returns once
            // _disconnectHandled is set, and only _connect() clears that flag --
            // so a reconnect that stalls anywhere before it left no watchdog and
            // no way back. Andy sat exactly there for five hours after a
            // "lost connection: Timed out": process alive, never reconnecting,
            // firing one rule every two hours into a dead socket. The only
            // symptom was an absence of logs, which reads like a quiet bot.
            //
            // So it stays armed. _handleDisconnect is idempotent and does the
            // reconnect; this just keeps asking.
            this._handleDisconnect('No server time updates for 3 minutes: connection is dead but no end event fired.');
            // And if the connection is still dead well past the point any
            // reconnect should have finished, stop guessing which step wedged
            // and hand the whole process back. EX_TEMPFAIL, because a dead link
            // is not a crashing agent and must not spend the crash budget.
            if (silent_ms > 600000) {
                log(this.name, `No server time updates for ${Math.round(silent_ms / 60000)} minutes and still not reconnected. Exiting for the supervisor.`);
                process.exit(TEMPFAIL_EXIT);
            }
        }, 60000);

        this.bot.once('spawn', async () => {
            try {
                clearTimeout(this._spawn_timeout);
                this._spawn_time = Date.now();
                this._ready = true;
                // Binds port 3000+count_id. A reconnect keeps the viewer it
                // already has; calling this twice is EADDRINUSE.
                if (!this._connected_once)
                    addBrowserViewer(this.bot, count_id, this.name);
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                
                console.log(`${this.name} spawned.`);
                this.clearBotLogs();
              
                this._setupEventHandlers(save_data, init_message);
                this.startEvents();
              
                // Task setup is per-process, not per-connection: re-running
                // initBotTask on a reconnect would reset the task the agent is
                // partway through.
                if (!this._connected_once) {
                    if (!this._load_mem) {
                        if (settings.task) {
                            this.task.initBotTask();
                            this.task.setAgentGoal();
                        }
                    } else {
                        // set the goal without initializing the rest of the task
                        if (settings.task) {
                            this.task.setAgentGoal();
                        }
                    }
                }
                this.establishHome();
                this._connected_once = true;

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });
    }

    /**
     * Pin the exploration leash to somewhere durable.
     *
     * bot.spawn_point is set on every process start, so it followed the bot
     * around: restart it 300 blocks out and 300 blocks out becomes the new
     * centre of its world. Anchoring on a remembered place instead means home
     * survives restarts, deaths and reconnects, and the agent can walk back to
     * it by name (goto_place "home") like any other place it knows.
     *
     * Recorded once, on the first spawn that has no home yet, and left alone
     * after that -- an anchor that re-anchors is not an anchor. Moving house is
     * deliberate: !rememberHere("home").
     */
    establishHome() {
        let p = this.memory_bank.recallPlace('home');
        if (!p) {
            const here = this.bot.entity?.position;
            if (!here) return;
            this.memory_bank.rememberPlace('home', here.x, here.y, here.z);
            p = [here.x, here.y, here.z];
            console.log(`EVT home:set:${Math.round(here.x)},${Math.round(here.y)},${Math.round(here.z)}`);
        }
        this.bot.home_point = { x: p[0], y: p[1], z: p[2] };
        console.log(`EVT home:anchor:${Math.round(p[0])},${Math.round(p[1])},${Math.round(p[2])}` +
            `:radius=${settings.exploration_radius}`);
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const respondFunc = async (username, message) => {
            if (!message) return; // mindserver events can arrive with no message at all
            // Ignore our own chat. this.name is the agent's name, which is not
            // necessarily the name we are logged in as -- with Microsoft auth
            // mineflayer uses the account's username -- so check both.
            if (username === this.name || username === this.bot?.username) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??');
                }
                else {
                    let translation = await handleEnglishTranslation(message);
                    this.handleMessage(username, translation);
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        };

		this.respondFunc = respondFunc;

        this.bot.on('whisper', respondFunc);
        
        this.bot.on('chat', (username, message) => {
            if (serverProxy.getNumOtherAgents() > 0) return;
            // only respond to open chat messages when there are no other agents
            respondFunc(username, message);
        });

        // Set up auto-eat
        this.bot.autoEat.options = {
            priority: 'foodPoints',
            startAt: 14,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        };

        // Everything past here is about starting a session, not about having a
        // socket: restoring the self-prompt goal, greeting the world, replaying
        // an init message. A reconnect is the same session continuing, so it
        // rebinds the handlers above and stops here -- otherwise the agent says
        // "Hello world!" and re-reads its startup instructions every blip.
        if (this._connected_once) return;

        if (save_data?.self_prompt) {
            if (init_message) {
                this.history.add('system', init_message);
            }
            // Plan restored after handleLoad: start() clears the plan on a
            // prompt change, and it always looks like one on a fresh process.
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
            if (Array.isArray(save_data.plan))
                this.self_prompter.plan = save_data.plan;
            // The restored goal may be a detour; the policy goal is still what to
            // return to when it is done, so re-establish it without starting it.
            this.self_prompter.standing_prompt = policyGoal(loadPolicyState(this.name)) ?? '';
        }
        // A goal declared by the profile library is what the agent is for, so it
        // outlives a restart the same way its rules do. Only when nothing else
        // holds the loop: a goal set later, by the agent or a person, is more
        // current than the one the profiles were merged with.
        else await applyPolicyGoal(this, loadPolicyState(this.name));
        if (save_data?.last_death_time)
            this.last_death_time = save_data.last_death_time;
        if (save_data?.alive_ms != null)
            this.alive_ms_before = save_data.alive_ms;
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message) {
            await this.handleMessage('system', init_message, 2);
        }
        else {
            this.openChat("Hello world! I am "+this.name);
        }
    }

    // Every way the game connection can end funnels through here: the login
    // guard's error branch, and the runtime 'end'/'kicked' events. They used to
    // take different exits -- one process.exit, one cleanKill -- which is why
    // the runtime disconnects never got the save the login path had.
    _handleDisconnect(reason, code = 1) {
        if (this._disconnectHandled) return;
        this._disconnectHandled = true;
        this._ready = false;

        // handleDisconnection logs to console and the mindserver.
        handleDisconnection(this.name, reason);

        // Save first, whatever happens next.
        try { this.history?.save(); } catch {}

        // A dropped socket is not a crash. Measured on a flaky server: ten
        // drops in forty minutes, uptimes 94s to 1426s, every one a clean
        // EPIPE/ECONNRESET/disconnect.timeout that the very next login attempt
        // recovered from. Each one cost a whole process -- examples re-embedded,
        // 17k blocks and 11.7k recipes of mod data re-parsed, ~25s of dead
        // agent -- and drove the supervisor's crash backoff up until it was
        // waiting minutes to retry a server accepting every connection on the
        // first try.
        if (this._canReconnect()) {
            this._reconnect(reason);
            return;
        }
        // Out of in-process attempts, or this connection never became a healthy
        // session. Hand it back to the supervisor, which can clear state we
        // cannot see from in here. A session that WAS healthy and then dropped
        // is still a transient failure even once the in-process budget is
        // spent, so tell the supervisor that rather than let it read a flaky
        // link as a crash loop.
        if (code === 1 && this._healthySession())
            code = TEMPFAIL_EXIT;
        process.exit(code);
    }

    // Wait for the bot to have a body again. Between a disconnect and the next
    // spawn there is a window -- 5s of backoff plus however long login takes --
    // in which bot.entity is undefined, and everything here that asks where it
    // is goes through bot.entity.position. The update loop can just skip a
    // tick; an LLM turn cannot, because replaceStrings runs the !stats query
    // while building the prompt. That threw uncaught and killed the process on
    // the very first live reconnect. Waiting beats dropping: the message is
    // already in history and deserves its answer.
    async _awaitReady(timeout_ms = 45000) {
        const deadline = Date.now() + timeout_ms;
        while (!this._ready || !this.bot?.entity) {
            if (Date.now() > deadline) return false;
            await new Promise(r => setTimeout(r, 250));
        }
        return true;
    }

    // Did this connection actually work before it dropped? Anything shorter
    // never got going, and repeating it in place would just spin.
    _healthySession() {
        return !!this._spawn_time && Date.now() - this._spawn_time >= HEALTHY_SESSION_MS;
    }

    // Is this drop worth retrying without throwing the process away?
    _canReconnect() {
        if (this._reconnects >= MAX_INPROC_RECONNECTS) {
            console.log(`${this.name}: ${this._reconnects} in-process reconnects already, handing back to the supervisor.`);
            return false;
        }
        if (!this._healthySession()) {
            const up = this._spawn_time ? Math.round((Date.now() - this._spawn_time) / 1000) : 0;
            console.log(`${this.name}: connection lasted ${up}s, too short to call a blip.`);
            return false;
        }
        return true;
    }

    // A deliberate relog (e.g. the furnace inventory refresh) rides the same
    // teardown/reconnect path as a dropped socket, but does not spend the
    // blip budget: it is not evidence the connection is unhealthy.
    async softRelog(reason) {
        this._reconnects--;
        await this._reconnect(reason);
    }

    async _reconnect(reason) {
        this._reconnects++;
        console.log(`[reconnect] ${this.name} attempt ${this._reconnects}/${MAX_INPROC_RECONNECTS} after: ${reason}`);

        // Whatever was running is running against a dead socket. Tell it to stop
        // before the bot goes away, or its next await throws into nothing.
        try {
            this.bot.interrupt_code = true;
            this.actions?.cancelResume();
        } catch (err) {
            console.warn('reconnect: could not stop the running action:', err.message);
        }
        // Drop every handler bound to the old bot. Without this each reconnect
        // leaves a full set behind and they all keep firing on their captured
        // `this.bot` -- which is how you get a chat message answered five times.
        try {
            this.bot.removeAllListeners();
            this.bot.end();
        } catch (err) {
            console.warn('reconnect: teardown was not clean:', err.message);
        }
        this._spawn_time = null;

        await new Promise(r => setTimeout(r, RECONNECT_DELAY_MS));
        try {
            await this._connect();
        } catch (err) {
            console.error('reconnect failed, handing back to the supervisor:', err);
            process.exit(1);
        }
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        // stop() is cooperative too: it only lands when the bot arrives at its
        // next node or the path resets, so the one bot that most needs stopping
        // -- the one that cannot move -- is the one it does not stop, and the
        // goto stays pending until the grace period abandons the whole action.
        // Clearing the goal rejects it now.
        try { this.bot.pathfinder.setGoal(null); } catch (_) {}
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        // ponytail: silence is only silence now. This used to stop the
        // self-prompter as well, which made !stfu a way for the model to answer
        // a prompt it did not feel like answering and then sit inert until a
        // human noticed -- twice in one afternoon it replied to the startup
        // "say hello" with !stfu and did nothing for the next quarter hour.
        // Actually stopping work is still available as !endGoal, and any
        // incoming message clears shut_up.
        convoManager.endAllConversations();
    }

    async handleMessage(source, message, max_responses=null) {
        // Do not build a prompt for a bot that has no body yet; see _awaitReady.
        if (!await this._awaitReady()) {
            console.warn(`${this.name}: dropping message from ${source}, never reconnected.`);
            return false;
        }
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    return false;
                }
                this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    // all user-initiated commands are ignored by the bot except for this one
                    // add the preceding message to the history to give context for newAction
                    this.history.add(source, message);
                }
                let execute_res = await executeCommand(this, message);
                if (execute_res) 
                    this.routeResponse(source, execute_res);
                return true;
            }
        }

        if (from_other_bot)
            this.last_sender = source;

        // Now translate the message
        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);

        // shut_up must not starve self-prompting: routeResponse already
        // suppresses the chat output, and blocking the loop here made !stfu
        // kill an active !goal after 3 silent no-command strikes.
        const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt) || (!self_prompt && this.shut_up) || convoManager.responseScheduledFor(source);
        
        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            await this.history.add('system', behavior_log);
        }

        // Handle other user messages
        await this.history.add(source, message);
        this.history.save();

        if (!self_prompt && this.self_prompter.isActive()) { // message is from user during self-prompting
            max_responses = 1; // force only respond to this message, then let self-prompting take over
            // Otherwise the next self-prompt re-asserts the old goal and the
            // user's instruction gets buried under it.
            await this.history.add('system', `The user's message may change what you should be doing. Your current goal is: '${this.self_prompter.prompt}'. If the user's instruction replaces or changes this goal, you MUST use !goal with the new objective (or !endGoal to stop, or !policy for standing rules) — otherwise you will automatically resume the old goal.`);
        }
        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;
            let history = this.history.getHistory();
            let res = await this.prompter.promptConvo(history, !self_prompt);

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (res.trim().length === 0) {
                console.warn('no response');
                break; // empty response ends loop
            }

            let command_name = containsCommand(res);

            if (command_name) { // contains query or command
                res = truncCommandMessage(res); // everything after the command is ignored
                this.history.add(this.name, res);
                
                if (!commandExists(command_name)) {
                    this.history.add('system', `Command ${command_name} does not exist.`);
                    console.warn('Agent hallucinated command:', command_name);
                    continue;
                }

                if (checkInterrupt()) break;
                // A rule action already under way outranks a command the model
                // settled on before the rule fired. An `interrupts: idle` rule
                // deliberately does NOT discard the pending command (discarding
                // on every fire starved the loop -- see stopLoop), so the stale
                // command arrives mid-collect and cancels the rule's goal:
                // ~30% of policy actions in soak 11 ended "interrupted", and a
                // hand-issued !collectBlocks was killed twice in a row by the
                // loop's own !collectBlocks. The call can only be made here,
                // where we know the rule is still working. The turn is already
                // paid for either way; this only decides who wins.
                //
                // P8: bound that protection to the action's YOUTH. The stale
                // command it guards against lands within one self-prompt turn, so
                // once the mode:action has run longer than
                // STALE_COMMAND_WINDOW_MS it is stuck, not working -- e.g.
                // give_up_on_a_stuck_path's move_away with no route in a pit --
                // and the model's FRESH escape/collect commands are what can break
                // it out. The old unbounded drop swallowed 705 commands and froze
                // the bot for the action's whole 120s lifetime. Past the window a
                // fresh command runs executeCommand -> runAction -> stop(), taking
                // over from the stuck action.
                const mode_age_ms = Date.now() - this.actions.last_action_time;
                if (self_prompt && this.actions.executing && this.actions.currentActionLabel.startsWith('mode:')
                        && mode_age_ms < STALE_COMMAND_WINDOW_MS) {
                    console.log(`self-prompt command ${command_name} dropped: "${this.actions.currentActionLabel}" is still running (${mode_age_ms}ms < ${STALE_COMMAND_WINDOW_MS}ms)`);
                    used_command = true; // a command WAS produced; don't count a no-command strike
                    break;
                }
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (settings.show_command_syntax === "full") {
                    this.routeResponse(source, res);
                }
                else if (settings.show_command_syntax === "shortened") {
                    // show only "used !commandname"
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    this.routeResponse(source, chat_message);
                }
                else {
                    // no command at all
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    if (pre_message.trim().length > 0)
                        this.routeResponse(source, pre_message);
                }

                let execute_res = await executeCommand(this, res, true);

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                used_command = true;

                if (execute_res)
                    this.history.add('system', execute_res);
                else
                    break;
            }
            else { // conversation response
                this.history.add(this.name, res);
                this.routeResponse(source, res);
                break;
            }
            
            this.history.save();
        }

        return used_command;
    }

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            // this is for when the agent is prompted by system while still in conversation
            // so it can respond to events like death but be routed back to the last sender
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // if we're in an ongoing conversation with the other bot, send the response to it
            convoManager.sendToBot(to_player, message);
        }
        else {
            // otherwise, use open chat
            this.openChat(message);
            // note that to_player could be another bot, but if we get here the conversation has ended
        }
    }

    async openChat(message) {
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) { // don't translate the command
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
        }
        else {
            if (settings.speak) {
                speak(to_translate, this.prompter.profile.speak_model);
            }
            if (settings.chat_ingame) {this.bot.chat(message);}
            sendOutputToServer(this.name, message);
        }
    }

    startEvents() {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
                // Being hit while a path is being searched roots the bot in
                // place: A* runs, the bot stands still, and the search restarts
                // every partial. Andy spent his last second at 23,72,-3 doing
                // eleven partial searches from one block -- visited 25, 55, 82,
                // ... 235 -- and was killed by a zombie in the middle of them,
                // unarmed with items0. Two of the five deaths that window were
                // that exact shape.
                //
                // A search that has not produced a route by the time something
                // is biting is not going to save the bot. Dropping it hands the
                // next tick to self_preservation, self_defense and the shelter
                // rules, all of which can act -- where a bot inside a pathfinder
                // search can only wait for it to finish.
                if (this.bot.pathfinder?.goal && this.bot.entity) {
                    const hostile = getNearestEntityWhere(
                        this.bot, e => isHostile(e), HOSTILE_PANIC_RANGE);
                    if (hostile) {
                        console.log(`EVT move:path_dropped_under_attack:${hostile.name}`);
                        this.bot.pathfinder.stop();
                    }
                }
            }
            prev_health = this.bot.health;
        });
        // Food telemetry: every hunger-bar change and every edible item
        // entering or leaving the bag, as EVT lines in the log. Rule fires
        // alone cannot distinguish "found food and ate it" from "never found
        // any" -- this can. grep "EVT food:" for the story.
        let prev_food = this.bot.food;
        this.bot.on('health', () => {
            if (this.bot.food !== prev_food) {
                // No single food restores 10+ at once -- a jump that size is a
                // respawn or a scenario heal, not a meal.
                const delta = this.bot.food - prev_food;
                console.log(`EVT food:level:${prev_food}->${this.bot.food}${delta >= 10 ? ':reset' : delta > 0 ? ':ate' : ''}`);
                prev_food = this.bot.food;
            }
        });
        let prev_food_counts = {};
        const food_watch = setInterval(() => {
            try {
                if (!this.bot?.registry || !this.bot.inventory) return;
                const counts = {};
                for (const i of this.bot.inventory.items())
                    if (this.bot.registry.foods?.[i.type])
                        counts[i.name] = (counts[i.name] ?? 0) + i.count;
                for (const name of new Set([...Object.keys(counts), ...Object.keys(prev_food_counts)])) {
                    const delta = (counts[name] ?? 0) - (prev_food_counts[name] ?? 0);
                    if (delta) console.log(`EVT food:inv:${name}:${delta > 0 ? '+' : ''}${delta}`);
                }
                prev_food_counts = counts;
            } catch (_) {}
        }, 10000);
        food_watch.unref?.();
        // Movement telemetry for pathing analysis: a breadcrumb every 5s while
        // actually moving, and every pathfinder verdict that is not success.
        // grep "EVT move:" for the trail; noPath/timeout lines are the pathing
        // bugs, breadcrumbs with d= near zero during a long goal are the
        // stuck-in-place ones.
        let prev_pos = this.bot.entity.position.clone();
        const move_watch = setInterval(() => {
            try {
                const p = this.bot.entity.position;
                const d = p.distanceTo(prev_pos);
                if (d >= 1)
                    console.log(`EVT move:pos:${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}:d=${d.toFixed(1)}`);
                prev_pos = p.clone();
            } catch (_) {}
        }, 5000);
        move_watch.unref?.();
        this.bot.on('path_update', (r) => {
            if (r?.status && r.status !== 'success') {
                // With the block the bot was standing on. A soak produced 8118
                // of these in six game-days and there was no way to tell one
                // impossible route attempted a thousand times from a thousand
                // unlucky ones -- the count alone says the pathfinder is busy,
                // not where it is stuck.
                const p = this.bot.entity?.position;
                const at = p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : '?';
                console.log(`EVT move:path:${r.status}:visited=${r.visitedNodes?.length ?? r.visitedNodes ?? '?'}:at=${at}`);
                // Failing in the same block over and over is a different problem
                // from failing a lot: one is terrain the bot cannot cross, the
                // other is bad luck. A soak burned 6281 pathfinds on a single
                // block, and another ground out 1106 visited nodes there before
                // the agent dropped off the server entirely. Count the repeats
                // so a rule can decide the route is not happening; the count is
                // the whole state, and leaving the box it started in resets it.
                // The count is also a deadlock detector: see path_spin.js for
                // why a bot that cannot move takes the whole agent down with it.
                // give_up_on_a_stuck_path fires at 40 and moves the bot; this is
                // the backstop for when the arbiter is the thing that is stuck.
                if (p && notePathFailure(this, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) {
                    console.log(`EVT move:path:spin_abort:at=${at}`);
                    // Remember WHERE it was trying to get to, not just where it
                    // was standing: clearing the goal does not clear the reason
                    // for it, and the next tick asks for the same place again.
                    const g = this.bot.pathfinder.goal;
                    if (g) {
                        // "unreachable:undefined,undefined,undefined" said only
                        // that something was stuck, never what wanted it -- and
                        // most of the goals that spin are the coordinate-less
                        // kind, so that was the common case, not the rare one.
                        // Name the goal class and whoever is holding the action.
                        const kind = g.constructor?.name ?? 'Goal';
                        // GoalInvert wraps a target the bot is running AWAY
                        // from, so its coordinates are the bot's own, and
                        // GoalFollow tracks a moving entity. Remembering either
                        // as an unreachable *place* would blacklist the ground
                        // under the bot's feet for every other skill.
                        if (kind !== 'GoalInvert' && !g.entity)
                            noteUnreachable(this.bot, g.x, g.y, g.z);
                        // ...but it still has to say WHERE. GoalInvert keeps its
                        // target in .goal, so reading g.x off the wrapper logged
                        // "undefined,undefined,undefined" for every failed escape
                        // -- drowning, fleeing, moving away -- which is the one
                        // class of failure where the coordinate is the whole
                        // point. Andy drowned twice within two blocks of the same
                        // water and the log could not say so.
                        const at = (kind === 'GoalInvert' ? g.goal : g) ?? {};
                        console.log(`EVT move:path:unreachable:${kind}:${at.x},${at.y},${at.z}:by=${this.actions.currentActionLabel ?? 'none'}`);
                    }
                    // Rejects the pending goto with GoalChanged, which unwinds
                    // whatever was awaiting it and gives the arbiter its loop back.
                    try { this.bot.pathfinder.setGoal(null); } catch (_) {}
                }
            }
        });
        this.bot.on('goal_reached', () => {
            console.log('EVT move:goal_reached');
            this.path_stuck_count = 0;
        });
        this.bot.on('path_reset', (reason) => {
            // "stuck" means the pathfinder gave up on a path the bot was not
            // advancing along -- it is walking into something. That fired 123
            // times in 25 minutes against 24 goals reached, five collisions per
            // goal, and Jeff could see it happening before any counter said so:
            // the agent's own path_stuck rule needs 40 consecutive failures
            // WITHOUT moving, and a bot that bumps, re-plans and shuffles on
            // never reaches 40. So it looked healthy and moved like it was
            // drunk.
            //
            // Which block it is matters more than the count. This server has
            // 17,437 modded blocks and mineflayer only knows the collision
            // shapes of the vanilla ones, so the planner routing through
            // something it thinks is walkable is the obvious suspect -- but
            // "obvious" has been wrong four times tonight, so name the block
            // and let the next window say.
            if (reason !== 'stuck') return console.log(`EVT move:path_reset:${reason}`);
            const p = this.bot.entity?.position;
            const at = p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : '?';
            const nameAt = (dx, dy, dz) => {
                try { return this.bot.blockAt(p.offset(dx, dy, dz))?.name ?? '?'; } catch { return '?'; }
            };
            // Feet and head at the four neighbours: whatever it is walking into
            // is one of these, and the pair tells a step-up from a wall.
            const ring = p
                ? [[1,0],[-1,0],[0,1],[0,-1]].map(([dx, dz]) => `${nameAt(dx,0,dz)}/${nameAt(dx,1,dz)}`).join(' ')
                : '?';
            console.log(`EVT move:path_reset:stuck:at=${at}:on=${nameAt(0,0,0)}:ring=${ring}`);
            // Snow is 12 of every 19 things the bot walks into, and the planner
            // cannot see it: minecraft-data gives the snow LAYER
            // boundingBox 'empty', so A* routes straight through what is really
            // a collision box on the server. Nothing plans to break it because
            // nothing believes it is there.
            //
            // Not blocksToAvoid -- this repo already tried refusing snow and
            // recorded the result: "no path existed anywhere, every goal timed
            // out, and Andy sat in one spot and died 7 times", in a biome made
            // of the stuff. So clear it at execution instead, which is what a
            // player does without thinking. Snow is about a second by hand.
            if (!p) return;
            // Grinding on one block is its own failure, whatever the block is.
            // 269 of 318 stuck resets in one window landed on -26,67,8, which
            // turned out to be a YIGD grave -- the mod drops one at every death
            // site, the items live server-side against a graveId, and claiming
            // it is a right-click the bot has no action for. So it is an
            // obstacle the bot cannot resolve and cannot stop walking into, and
            // it will be there again at the next death.
            //
            // Not broken: `claimed` and `previousState` say the recovery
            // semantics belong to the mod, and guessing wrong there costs the
            // player the inventory it is holding. Walking away is always safe.
            // give_up_on_a_stuck_path does not cover this -- path_stuck counts
            // 40 CONSECUTIVE failures without moving, and a bot bouncing off one
            // block moves a little every time, so it fired 4 times against 318.
            if (at === this._stuck_at) this._stuck_count++;
            else { this._stuck_at = at; this._stuck_count = 1; }
            if (this._stuck_count >= STUCK_SAME_SPOT) {
                // Reset, not "fire once at exactly N". The first version tested
                // `=== STUCK_SAME_SPOT` and then kept counting -- 9, 10, ... 109
                // -- so it escaped once and went straight back to grinding the
                // same block for the rest of the window. 109 stucks, one escape.
                this._stuck_count = 0;
                // A grave is the one obstruction worth removing rather than
                // walking around: it holds the bot's own inventory, breaking it
                // gives that back (confirmed), and the mod leaves another at
                // every death, so walking away just defers it.
                const grave = (() => {
                    for (const dy of [0, 1, -1])
                        for (const [dx, dz] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]) {
                            try {
                                const b = this.bot.blockAt(p.offset(dx, dy, dz));
                                if (b?.name === 'grave') return b;
                            } catch { /* unloaded */ }
                        }
                    return null;
                })();
                if (grave) {
                    console.log(`EVT move:stuck_grave:${at}`);
                    skills.recoverGrave(this.bot, 4).catch(() => {});
                } else {
                    console.log(`EVT move:stuck_giving_up:${at}:after=${STUCK_SAME_SPOT}`);
                    skills.moveAway(this.bot, 16).catch(() => {});
                }
            }
            if (this.bot.targetDigBlock) return;
            // Feet AND head. The first version swept feet level only and cleared
            // 7 blocks while 44 of the obstructions in the same window were at
            // head height -- "dirt/snow_block" and "air/snow_block" both name
            // the head as the snow one. A bot ducking into a gap with snow at
            // eye level is stopped exactly as hard as one walking into a wall,
            // and it was never even looking there.
            const spots = [];
            for (const dy of [0, 1])
                for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[0,0]])
                    spots.push([dx, dy, dz]);
            for (const [dx, dy, dz] of spots) {
                const b = (() => { try { return this.bot.blockAt(p.offset(dx, dy, dz)); } catch { return null; } })();
                // Aimed at the snow LAYER first, on the strength of one window's
                // tally. The next window was 22 of 22 snow_block -- a different
                // block, boundingBox 'block', which the planner does see -- and
                // snow_cleared had fired exactly zero times. Both are soft and
                // both stop the bot, so take the family rather than re-guess
                // which member is fashionable in the current biome.
                if (!b || !/^(snow|snow_block|powder_snow)$/.test(b.name)) continue;
                // Fire and forget: this runs on a pathfinder event, and awaiting
                // a dig here would hold the event loop the same way the air
                // sampler used to be held.
                this.bot.dig(b).catch(() => {});
                console.log(`EVT move:snow_cleared:${Math.floor(b.position.x)},${Math.floor(b.position.y)},${Math.floor(b.position.z)}`);
                break;
            }
        });
        // Logging callbacks
        this.bot.on('error' , (err) => {
            console.error('Error event!', err);
        });
        // Runtime disconnects. These used to cleanKill straight to a process
        // exit; now they take the same route as every other disconnect, which
        // decides between reconnecting in place and handing back to the
        // supervisor. disconnect.timeout arrives here, and it was the single
        // most common way this agent died.
        this.bot.on('end', (reason) => this._handleDisconnect(reason));
        this.bot.on('death', () => {
            this.last_death_time = Date.now();
            this.alive_ms_before = 0;
            this.alive_mark = Date.now();
            serverProxy.reportDeath();
            this.actions.cancelResume();
            this.actions.stop();
            // Cooldowns and no-progress backoff persist across death, so in a
            // respawn-camp spiral (soak 8: 36 deaths at the bed, ~10s apart)
            // every protective rule that fired-and-failed sat silent through
            // the next five deaths. Death resets the world for the bot;
            // it resets the rules too. Pinned (protective) rules only: economy
            // rules rely on backoff to idle in biomes that cannot satisfy them,
            // and resetting those on every death resurrected a berry-search
            // treadmill (30 doomed 128-block walks in 6h) in a bushless biome.
            for (const r of (this.bot.modes?.rules ?? []).filter(r => r.spec?.pinned)) {
                r.last_fire = 0;
                r.last_eval = 0;
                r.backoff = 1;
            }
            console.log('EVT policy:cooldowns_reset:death');
        });
        this.bot.on('kicked', (reason) => this._handleDisconnect(reason));
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            // The death message names the account, which is not necessarily the
            // agent's name: under Microsoft auth mineflayer logs in as the
            // account's username. Missing this means the bot is never told it
            // died and last_death_position is never saved, so it cannot find its
            // own grave.
            const died = message.startsWith(this.name) ||
                (this.bot?.username && message.startsWith(this.bot.username));
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && died) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity.position;
                // Structured so deaths can be counted instead of read. Every
                // fold this loop has made came from noticing a death pattern by
                // eye in the log, which only works while there are few of them.
                // The five fields are the ones that have actually decided a
                // rule: what killed it, where, whether it was night, whether it
                // was carrying a weapon at the time, and how much it owned.
                //
                // The last one was added after a starvation at the bottom of a
                // shaft: "unarmed" said there was no sword, but the fact that
                // decided everything was that the whole inventory was one plank
                // -- nothing to pillar out with, nothing to eat. That took an
                // rcon query to learn, and rcon only knows the living present,
                // so by then the inventory at time of death was gone.
                const items = this.bot.inventory.items();
                const armed = items.some(i => /sword|axe/.test(i.name));
                const evt = `EVT death:${jsonMsg.translate}:${Math.floor(death_pos.x)},${Math.floor(death_pos.y)},${Math.floor(death_pos.z)}`
                    + `:${this.bot.time.timeOfDay >= 13000 ? 'night' : 'day'}:${armed ? 'armed' : 'unarmed'}`
                    + `:items${items.length}`;
                console.log(evt);
                // What the drowning detector could see in its last four seconds.
                // Every previous attempt at this reflex was judged on samples
                // taken when it FIRED; none showed what the signals said while
                // the bot was actually dying, which is why a detector that never
                // fired kept looking merely quiet. Cheap: one line, on death.
                if (/drown/.test(jsonMsg.translate ?? '')) {
                    const seen = this.bot._air_history ?? [];
                    console.log(`EVT death:drown:trace:samples${seen.length}` +
                        `:wet${seen.filter(s => s.submerged).length}` +
                        `:oxy=${seen.map(s => s.oxygen).join(',') || 'none'}`);
                }
                try { sendOutputToServer(this.name, evt); } catch (_) {}
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                // A separate place for the deaths worth walking back to. YIGD
                // only leaves a grave when there was something to put in it, so
                // three of the last four death sites had nothing at all --
                // items0 each -- while the graves holding the bot's actual gear
                // sat at older coordinates it no longer remembered.
                // go_back_for_your_grave chased last_death_position, arrived at
                // empty ground, and came home with nothing three times running.
                //
                // Only a death with items in hand leaves something to fetch, so
                // only that kind updates this. last_death_position keeps meaning
                // "where I died most recently", which is what the rules that
                // avoid the spot want.
                if (items.length > 0)
                    this.memory_bank.rememberPlace('last_grave_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                }
                let dimention = this.bot.game.dimension;
                this.handleMessage('system', `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position'. Whatever killed you is probably still there and your gear is on the ground next to it, so do NOT go back until you are armed and it is daytime -- returning unarmed is how you die twice. Previous actions were stopped and you have respawned. If something about this death will keep happening -- the same mob, the same hazard, running out of food or air -- use !policy to write yourself a standing rule that prevents it, and pin it so the job you are given cannot crowd it out. A rule is worth writing only if it would have saved you here.`);
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            setTimeout(() => {
                // Not isIdle(): a paused action should resume when nothing is
                // running, even if the agent happens to be mid-generation --
                // otherwise this one-shot timer passes and it never resumes.
                if (!this.actions.executing) {
                    this.actions.resumeAction();
                }
            }, 1000);
        });

        this.bot.emit('idle');

        // The handlers above bind to whichever bot object is current, so they
        // are rebound on every reconnect. The two below are per-process: the
        // NPC controller builds its goals once, and a second copy of the update
        // loop would tick every mode and rule twice per interval, forever.
        if (this._loop_started) return;
        this._loop_started = true;

        // Init NPC controller
        this.npc.init();

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);
    }

    async update(delta) {
        // The loop outlives any one connection now, so it can tick while the
        // bot underneath it is a corpse, or a fresh object that has not spawned
        // yet. Every mode and rule reads the world; none of them survive that.
        if (!this._ready || !this.bot?.entity) return;
        try {
            await this.bot.modes.update();
            this.self_prompter.update(delta);
            await this.checkTaskDone();
        } catch (err) {
            // An exception used to end the while(true) that calls this, which
            // stopped every mode and rule for the life of the process without
            // stopping the process. One bad tick is not worth that.
            console.error('update tick failed:', err.message);
        }
    }

    // Thinking is not idling. A 30s LLM call left this true for its whole
    // duration, so every is_idle-gated rule and every idle mode fired straight
    // into the reasoning they were written to wait for. Callers that mean
    // "nothing is running right now" (resuming a paused action) ask
    // actions.executing directly.
    isIdle() {
        return !this.actions.executing && !this.prompter.isBusy();
    }
    

    cleanKill(msg='Killing agent process...', code=1) {
        console.log(`cleanKill (code ${code}): ${msg}\n${new Error().stack}`);
        // Nothing before process.exit may throw: a chat write on a dead socket
        // throwing here left the agent as a zombie -- disconnected in-game but
        // never exiting, so the parent never restarted it.
        try { this.history.add('system', msg); } catch {}
        try { this.bot.chat(code > 1 ? 'Restarting.': 'Exiting.'); } catch {}
        try { this.history.save(); } catch {}
        process.exit(code);
    }
    async checkTaskDone() {
        if (this.task.data) {
            let res = this.task.isDone();
            if (res) {
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 second for save to complete
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    // ms spent *connected* since the last death we know about, or null if we've
    // never seen one. Wall clock since the death would count the hours the bot
    // spent offline as time it survived, which is not what "alive for" means.
    // alive_ms_before carries the earlier sessions through memory.json.
    aliveMs() {
        if (!this.last_death_time) return null;
        return (this.alive_ms_before ?? 0) + (this.alive_mark ? Date.now() - this.alive_mark : 0);
    }

    killAll() {
        serverProxy.shutdown();
    }
}
