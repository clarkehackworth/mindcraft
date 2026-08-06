import * as skills from './library/skills.js';
import * as world from './library/world.js';
import * as mc from '../utils/mcdata.js';
import settings from './settings.js'
import convoManager from './conversation.js';
import { sendOutputToServer } from './mindserver_proxy.js';

async function say(agent, message) {
    agent.bot.modes.behavior_log += message + '\n';
    if (agent.shut_up || !settings.narrate_behavior) return;
    agent.openChat(message);
}

// a mode is a function that is called every tick to respond immediately to the world
// it has the following fields:
// on: whether 'update' is called every tick
// active: whether an action has been triggered by the mode and hasn't yet finished
// paused: whether the mode is paused by another action that overrides the behavior (eg followplayer implements its own self defense)
// update: the function that is called every tick (if on is true)
// when a mode is active, it will trigger an action to be performed but won't wait for it to return output

// the order of this list matters! first modes will be prioritized
// while update functions are async, they should *not* be awaited longer than ~100ms as it will block the update loop
// to perform longer actions, use the execute function which won't block the update loop
const modes_list = [
    {
        name: 'self_preservation',
        description: 'Respond to drowning, burning, and damage at low health. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        fall_blocks: ['sand', 'gravel', 'concrete_powder'], // includes matching substrings like 'sandstone' and 'red_sand'
        update: async function (agent) {
            const bot = agent.bot;
            let block = bot.blockAt(bot.entity.position);
            // Eye level, not feet+1: mid-swim the feet sit low enough in a block
            // for feet+1 to read air while the head is still buried.
            let blockAbove = bot.blockAt(bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0));
            if (!block) block = {name: 'air'}; // hacky fix when blocks are not loaded
            if (!blockAbove) blockAbove = {name: 'air'};
            // Losing air is the whole definition of drowning, so ask the air
            // bar and nothing else. Testing the head block for name === 'water'
            // meant a head inside kelp or seagrass was "not water": this branch
            // never ran once in Andy's entire log, including the run that
            // killed him in a kelp forest.
            const submerged = !skills.isBreathing(bot);
            // ...but the air bar reads 0 for the tick after a respawn, before the
            // first health packet lands. Andy died 14 times and each death was
            // followed by a phantom "drowning" that interrupted his action and
            // killed the self-prompt loop, logging "Surfaced with 20/20 air left"
            // 17 times. You cannot drown with your head in air; requiring a wet
            // head costs nothing and still covers kelp, seagrass and waterlogged
            // stairs, which are the cases a name === 'water' test missed.
            const head_wet = blockAbove.name !== 'air';
            if (bot.oxygenLevel === undefined || bot.oxygenLevel > 15)
                this._said_drowning = false; // air recovered: next episode announces again
            if (head_wet && bot.oxygenLevel !== undefined && bot.oxygenLevel <= 12) {
                // Actually drowning. Interrupt whatever it was doing -- the bot
                // drowned pathfinding to a block it had found underwater, and
                // the passive branch below never fired because a goal was set.
                // Announce once per episode, not once per tick: six "I'm
                // drowning!" in two minutes is noise, and each one is an LLM
                // interruption.
                if (!this._said_drowning) {
                    say(agent, 'I\'m drowning!');
                    this._said_drowning = true;
                }
                execute(this, agent, async () => {
                    await skills.surface(bot);
                });
            }
            else if (submerged && head_wet) {
                // Head is wet but there is air to spare: nudge upward without
                // interrupting whatever the bot is busy with.
                if (!bot.pathfinder.goal) {
                    bot.setControlState('jump', true);
                }
                else {
                    bot.setControlState('jump', false);
                }
            }
            else if (bot.controlState?.jump && !bot.pathfinder.goal) {
                bot.setControlState('jump', false); // out of the water, stop swimming
            }
            else if (this.fall_blocks.some(name => blockAbove.name.includes(name))) {
                execute(this, agent, async () => {
                    await skills.moveAway(bot, 2);
                });
            }
            else if (block.name === 'lava' || block.name === 'fire' ||
                blockAbove.name === 'lava' || blockAbove.name === 'fire') {
                say(agent, 'I\'m on fire!');
                // if you have a water bucket, use it
                let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                if (waterBucket) {
                    execute(this, agent, async () => {
                        let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                        if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                    });
                }
                else {
                    execute(this, agent, async () => {
                        let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                        if (waterBucket) {
                            let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                            if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                            return;
                        }
                        let nearestWater = world.getNearestBlock(bot, 'water', 20);
                        if (nearestWater) {
                            const pos = nearestWater.position;
                            let success = await skills.goToPosition(bot, pos.x, pos.y, pos.z, 0.2);
                            if (success) say(agent, 'Found some water, ahhhh that\'s better!');
                            return;
                        }
                        await skills.moveAway(bot, 5);
                    });
                }
            }
            else if (Date.now() - bot.lastDamageTime < 3000 && (bot.health < 5 || bot.lastDamageTaken >= bot.health)) {
                say(agent, 'I\'m dying!');
                execute(this, agent, async () => {
                    await skills.moveAway(bot, 20);
                });
            }
            else if (agent.isIdle()) {
                bot.clearControlStates(); // clear jump if not in danger or doing anything else
            }
        }
    },
    {
        name: 'unstuck',
        description: 'Attempt to get unstuck when in the same place for a while. Interrupts some actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        prev_location: null,
        distance: 2,
        stuck_time: 0,
        last_time: Date.now(),
        max_stuck_time: 20,
        prev_dig_block: null,
        update: async function (agent) {
            if (agent.isIdle()) { 
                this.prev_location = null;
                this.stuck_time = 0;
                return; // don't get stuck when idle
            }
            const bot = agent.bot;
            const cur_dig_block = bot.targetDigBlock;
            if (cur_dig_block && !this.prev_dig_block) {
                this.prev_dig_block = cur_dig_block;
            }
            if (this.prev_location && this.prev_location.distanceTo(bot.entity.position) < this.distance && cur_dig_block == this.prev_dig_block) {
                this.stuck_time += (Date.now() - this.last_time) / 1000;
            }
            else {
                this.prev_location = bot.entity.position.clone();
                this.stuck_time = 0;
                this.prev_dig_block = null;
            }
            const max_stuck_time = cur_dig_block?.name === 'obsidian' ? this.max_stuck_time * 2 : this.max_stuck_time;
            if (this.stuck_time > max_stuck_time) {
                say(agent, 'I\'m stuck!');
                this.stuck_time = 0;
                const start_pos = bot.entity.position.clone();
                execute(this, agent, async () => {
                    // ponytail: no process kill here anymore. A restart cannot move the
                    // bot in the world, so killing on positional stuckness just crash-
                    // looped forever. Bounded escape attempt, then hand it to the LLM.
                    const giveUp = setTimeout(() => agent.requestInterrupt(), 10000);
                    // Water first: pathfinder cannot swim, so moveAway is
                    // guaranteed to fail while the bot is floating in a pocket.
                    try {
                        if (!await skills.escapeLiquid(bot)) await skills.moveAway(bot, 5);
                    } catch {}
                    clearTimeout(giveUp);
                    if (bot.entity.position.distanceTo(start_pos) >= this.distance) {
                        say(agent, 'I\'m free.');
                    } else {
                        this.stuck_time = -60; // back off so the LLM gets time to act before we re-fire
                        const p = bot.entity.position;
                        const below = world.getBlockAtPosition(bot, 0, -1, 0)?.name;
                        const legs = world.getBlockAtPosition(bot, 0, 0, 0)?.name;
                        agent.handleMessage('system', `(STUCK) Pathfinding cannot move you: you have been within ${this.distance} blocks of (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}) for a while and an automatic escape attempt failed. You are standing on ${below ?? 'unknown'} with ${legs ?? 'air'} at your feet. Look at your surroundings and free yourself, e.g. collect the blocks you are standing on or place blocks to build a path. Do not repeat the navigation command that got you stuck.`);
                    }
                });
            }
            this.last_time = Date.now();
        },
        unpause: function () {
            this.prev_location = null;
            this.stuck_time = 0;
            this.prev_dig_block = null;
        }
    },
    {
        name: 'cowardice',
        description: 'Run away from enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            const enemy = world.getNearestEntityWhere(agent.bot, entity => mc.isHostile(entity), 16);
            if (enemy && await world.isClearPath(agent.bot, enemy)) {
                say(agent, `Aaa! A ${enemy.name.replace("_", " ")}!`);
                execute(this, agent, async () => {
                    await skills.avoidEnemies(agent.bot, 24);
                });
            }
        }
    },
    {
        name: 'self_defense',
        description: 'Attack nearby enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            const enemy = world.getNearestEntityWhere(agent.bot, entity => mc.isHostile(entity), 8);
            if (enemy && await world.isClearPath(agent.bot, enemy)) {
                say(agent, `Fighting ${enemy.name}!`);
                execute(this, agent, async () => {
                    await skills.defendSelf(agent.bot, 8);
                });
            }
        }
    },
    {
        name: 'hunting',
        description: 'Hunt nearby animals when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        update: async function (agent) {
            const huntable = world.getNearestEntityWhere(agent.bot, entity => mc.isHuntable(entity), 8);
            if (huntable && await world.isClearPath(agent.bot, huntable)) {
                execute(this, agent, async () => {
                    say(agent, `Hunting ${huntable.name}!`);
                    await skills.attackEntity(agent.bot, huntable);
                });
            }
        }
    },
    {
        name: 'item_collecting',
        description: 'Collect nearby items when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,

        wait: 2, // number of seconds to wait after noticing an item to pick it up
        prev_item: null,
        noticed_at: -1,
        update: async function (agent) {
            let item = world.getNearestEntityWhere(agent.bot, entity => entity.name === 'item', 8);
            let empty_inv_slots = agent.bot.inventory.emptySlotCount();
            if (item && item !== this.prev_item && await world.isClearPath(agent.bot, item) && empty_inv_slots > 1) {
                if (this.noticed_at === -1) {
                    this.noticed_at = Date.now();
                }
                if (Date.now() - this.noticed_at > this.wait * 1000) {
                    say(agent, `Picking up item!`);
                    this.prev_item = item;
                    execute(this, agent, async () => {
                        await skills.pickupNearbyItems(agent.bot);
                    });
                    this.noticed_at = -1;
                }
            }
            else {
                this.noticed_at = -1;
            }
        }
    },
    {
        name: 'torch_placing',
        description: 'Place torches when idle and there are no torches nearby.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        cooldown: 5,
        last_place: Date.now(),
        update: function (agent) {
            if (world.shouldPlaceTorch(agent.bot)) {
                if (Date.now() - this.last_place < this.cooldown * 1000) return;
                const pos = agent.bot.entity.position;
                // The agent just broke a block here on purpose (probably to
                // place something) -- re-torching it starts a tug-of-war the
                // agent cannot win. Leave deliberately cleared spots alone.
                if (skills.wasRecentlyCleared(pos.x, pos.y, pos.z)) return;
                execute(this, agent, async () => {
                    await skills.placeBlock(agent.bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
                });
                this.last_place = Date.now();
            }
        }
    },
    {
        name: 'elbow_room',
        description: 'Move away from nearby players when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        distance: 0.5,
        update: async function (agent) {
            const player = world.getNearestEntityWhere(agent.bot, entity => entity.type === 'player', this.distance);
            if (player) {
                execute(this, agent, async () => {
                    // wait a random amount of time to avoid identical movements with other bots
                    const wait_time = Math.random() * 1000;
                    await new Promise(resolve => setTimeout(resolve, wait_time));
                    if (player.position.distanceTo(agent.bot.entity.position) < this.distance) {
                        await skills.moveAwayFromEntity(agent.bot, player, this.distance);
                    }
                });
            }
        }
    },
    {
        name: 'idle_staring',
        description: 'Animation to look around at entities when idle.',
        interrupts: [],
        on: true,
        active: false,

        staring: false,
        last_entity: null,
        next_change: 0,
        update: function (agent) {
            const entity = agent.bot.nearestEntity();
            let entity_in_view = entity && entity.position.distanceTo(agent.bot.entity.position) < 10 && entity.name !== 'enderman';
            if (entity_in_view && entity !== this.last_entity) {
                this.staring = true;
                this.last_entity = entity;
                this.next_change = Date.now() + Math.random() * 1000 + 4000;
            }
            if (entity_in_view && this.staring) {
                let isbaby = entity.type !== 'player' && entity.metadata[16];
                let height = isbaby ? entity.height/2 : entity.height;
                agent.bot.lookAt(entity.position.offset(0, height, 0));
            }
            if (!entity_in_view)
                this.last_entity = null;
            if (Date.now() > this.next_change) {
                // look in random direction
                this.staring = Math.random() < 0.3;
                if (!this.staring) {
                    const yaw = Math.random() * Math.PI * 2;
                    const pitch = (Math.random() * Math.PI/2) - Math.PI/4;
                    agent.bot.look(yaw, pitch, false);
                }
                this.next_change = Date.now() + Math.random() * 10000 + 2000;
            }
        }
    },
    {
        name: 'cheat',
        description: 'Use cheats to instantly place blocks and teleport.',
        interrupts: [],
        on: false,
        active: false,
        update: function (agent) { /* do nothing */ }
    }
];

// ponytail: a mode/rule action with no timeout never armed the watchdog, so a
// stuck pathfinder (e.g. surfacing from drowning against an obstruction) left
// currentActionLabel stuck forever -- the status UI showed "drowning_escape"
// long after oxygen was restored. 2 minutes is generous for a reflex action.
// The modes that exist to keep the agent alive, and so may cancel an action
// that was one block from finishing. Everything else -- hunting, picking items
// up, placing torches, elbow room, staring at the sky -- can wait the moment
// out. A policy rule answers this with its own `urgent` (set from `pinned`).
const URGENT_MODES = ['self_preservation', 'unstuck', 'cowardice', 'self_defense'];
const isUrgentMode = (mode) => mode.urgent ?? URGENT_MODES.includes(mode.name);

// One grep-stable line per behavior fire, to the log and to the mindserver
// bot-output stream. tools/live_test.sh awaits on these, so scenarios assert
// on the behavior itself, not on prose log phrasing that drifts.
function logEvt(agentName, line) {
    console.log(line);
    try { sendOutputToServer(agentName, line); } catch (_) {}
}

async function execute(mode, agent, func, timeout=2) {
    logEvt(agent.name, `EVT mode:fire:${mode.name}`);
    if (agent.self_prompter.isActive())
        // Only a mode that preempts everything gets to throw away a command the
        // model already committed to. An idle-only mode runs *because* nothing
        // else is happening, so it has no business cancelling the next action.
        agent.self_prompter.stopLoop(mode.interrupts.includes('all'));
    let interrupted_action = agent.actions.currentActionLabel;
    mode.active = true;
    let code_return = await agent.actions.runAction(`mode:${mode.name}`, async () => {
        await func();
    }, { timeout, urgent: isUrgentMode(mode) });
    mode.active = false;
    console.log(`Mode ${mode.name} finished executing, code_return: ${code_return.message}`);

    let should_reprompt =
        interrupted_action && // it interrupted a previous action
        !mode.autonomous && // a policy rule already IS the decision; see below
        !agent.actions.resume_func && // there is no resume function
        !agent.self_prompter.isActive() && // self prompting is not on
        !code_return.interrupted; // this mode action was not interrupted by something else

    // The reprompt exists so the model learns why the action it chose got
    // killed. A policy rule needs no such explanation: it fired because the
    // world matched its condition, and it handled the situation itself. Worse,
    // reprompting hands control back to the model at exactly the wrong moment
    // -- Andy's night rule parked at base until dawn, and the reprompt on its
    // completion had the model start collecting pine logs, which kept the agent
    // non-idle so the idle-gated daytime rules could never fire. A policy that
    // genuinely wants the model uses the prompt_self action.

    if (should_reprompt) {
        // auto prompt to respond to the interruption
        let role = convoManager.inConversation() ? agent.last_sender : 'system';
        let logs = agent.bot.modes.flushBehaviorLog();
        agent.handleMessage(role, `(AUTO MESSAGE)Your previous action '${interrupted_action}' was interrupted by ${mode.name}.
        Your behavior log: ${logs}\nRespond accordingly.`);
    }
}

let _agent = null;
const modes_map = {};
for (let mode of modes_list) {
    modes_map[mode.name] = mode;
}

import { Rule, loadPolicyState, composePolicy, describePolicyState, validatePolicy, LAYERS } from './behavior/policy.js';

// Safety reflexes that always outrank user policy rules.
const PRIORITY_ABOVE_POLICY = ['self_preservation', 'unstuck'];

class ModeController {
    /*
    SECURITY WARNING:
    ModesController must be reference isolated. Do not store references to external objects like `agent`.
    This object is accessible by LLM generated code, so any stored references are also accessible.
    This can be used to expose sensitive information by malicious prompters.
    */
    constructor() {
        this.behavior_log = '';
        // User policy rules compiled from natural language. Contain plain
        // spec data only -- no agent references (see security warning).
        this.rules = [];
        this.policy_source = null;
    }

    // Priority-ordered behavior tree roots: safety reflexes, then user
    // policy rules, then the remaining built-in modes.
    _entries() {
        const above = PRIORITY_ABOVE_POLICY.map(n => modes_map[n]);
        const rest = modes_list.filter(m => !PRIORITY_ABOVE_POLICY.includes(m.name));
        return [...above, ...this.rules, ...rest];
    }

    _find(name) {
        return modes_map[name] ?? this.rules.find(r => r.name === name || r.spec.name === name);
    }

    installPolicy(policy, source_text) {
        this.rules = policy.rules.map(spec => new Rule(spec));
        this.policy_source = source_text;
        if (policy.modes) {
            this._pre_policy_modes = this._pre_policy_modes ?? this.getJson();
            for (let m in policy.modes)
                if (this.exists(m)) this.setOn(m, policy.modes[m]);
        }
    }

    clearPolicy() {
        this.rules = [];
        this.policy_source = null;
        if (this._pre_policy_modes) {
            this.loadJson(this._pre_policy_modes);
            this._pre_policy_modes = null;
        }
    }

    exists(mode_name) {
        return this._find(mode_name) != null;
    }

    setOn(mode_name, on) {
        this._find(mode_name).on = on;
    }

    isOn(mode_name) {
        return this._find(mode_name).on;
    }

    pause(mode_name) {
        this._find(mode_name).paused = true;
    }

    unpause(mode_name) {
        const mode = this._find(mode_name);
        //if  unpause func is defined and mode is currently paused
        if (mode.unpause && mode.paused) {
            mode.unpause();
        }
        mode.paused = false;
    }

    unPauseAll() {
        for (let entry of this._entries()) {
            if (entry.paused) console.log(`Unpausing mode ${entry.name}`);
            this.unpause(entry.name);
        }
    }

    getMiniDocs() { // no descriptions
        let res = 'Agent Modes:';
        for (let entry of this._entries()) {
            let on = entry.on ? 'ON' : 'OFF';
            res += `\n- ${entry.name}(${on})`;
        }
        return res;
    }

    getDocs() {
        let res = 'Agent Modes:';
        for (let entry of this._entries()) {
            let on = entry.on ? 'ON' : 'OFF';
            res += `\n- ${entry.name}(${on}): ${entry.description}`;
        }
        if (this.policy_source)
            res += `\n\nActive policy (from: "${this.policy_source}"). Rules run in priority order between unstuck and the remaining modes.`;
        return res;
    }

    async update() {
        if (_agent.isIdle()) {
            this.unPauseAll();
        }
        // Behavior-tree arbiter: walk entries in priority order. Entries
        // before a running one may still fire (preemption); entries after
        // it are skipped, same as the old mode loop.
        for (let entry of this._entries()) {
            let interruptible = entry.interrupts.some(i => i === 'all') || entry.interrupts.some(i => i === _agent.actions.currentActionLabel);
            if (entry.on && !entry.paused && !entry.active && (_agent.isIdle() || interruptible)) {
                // Preemption cancels the running action's pathfinder. Letting
                // the loser fire again the moment the winner finishes just
                // re-triggers the same preemption 300ms later: standing next to
                // a zombie, Andy's self_preservation interrupted self_defense
                // 157 times in a row and his policy's flee rule interrupted
                // cowardice 122 times, every one of them a PathStopped. He
                // never got more than a step from the mob that was killing him.
                // Both entries wanted the same thing; priority order already
                // said which one gets it, so the loser sits out until the
                // situation is over. unPauseAll on idle above is the reset.
                const losing = this._entries().find(e => e.active && e !== entry);
                if (losing) losing.paused = true;
                await entry.update(_agent, execute);
            }
            if (entry.active) break;
        }
    }

    flushBehaviorLog() {
        const log = this.behavior_log;
        this.behavior_log = '';
        return log;
    }

    getJson() {
        let res = {};
        for (let mode of modes_list) {
            res[mode.name] = mode.on;
        }
        return res;
    }

    loadJson(json) {
        for (let mode of modes_list) {
            if (json[mode.name] != undefined) {
                mode.on = json[mode.name];
            }
        }
    }
}

export function initModes(agent) {
    _agent = agent;
    // the mode controller is added to the bot object so it is accessible from anywhere the bot is used
    agent.bot.modes = new ModeController();
    if (agent.task) {
        agent.bot.restrict_to_inventory = agent.task.restrict_to_inventory;
    }
    let modes_json = agent.prompter.getInitModes();
    if (modes_json) {
        agent.bot.modes.loadJson(modes_json);
    }
    const state = loadPolicyState(agent.name);
    // Validate on load, not just on compile: a policy saved before a guard
    // existed outlives every restart. Andy's go_to_chest_at_night re-pathed
    // every 3 seconds all night and came back after each restart. Layers are
    // validated independently so one bad layer does not cost the others.
    for (let layer of LAYERS) {
        const policy = state.layers?.[layer]?.policy;
        if (!policy) continue;
        const err = validatePolicy(policy);
        if (err) {
            console.warn(`Discarding the "${layer}" policy layer for ${agent.name}, it is no longer valid: ${err}`);
            console.warn('Re-issue those instructions to recompile that layer.');
            delete state.layers[layer];
        }
    }
    const composed = composePolicy(state);
    if (composed.rules.length > 0 || Object.keys(composed.modes).length > 0) {
        agent.bot.modes.installPolicy(composed, describePolicyState(state));
        console.log(`Loaded saved policy for ${agent.name}:\n${describePolicyState(state)}`);
    }
}
