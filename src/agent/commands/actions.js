import * as skills from '../library/skills.js';
import settings from '../settings.js';
import convoManager from '../conversation.js';
import { compilePolicy, describePolicy, validatePolicy, applyPolicyGoal, loadPolicyState, savePolicyState, composePolicy, appendLayerSource, SELF_SOURCE_CAP, describePolicyState, isPolicyLocked, saveProfile, loadProfile, listProfiles, LAYERS, parseConditionExpr, evalCondition, conditionDocs, describeCondition } from '../behavior/policy.js';


function runAsAction (actionFn, resume = false, timeout = -1) {
    let actionLabel = null;  // Will be set on first use
    
    const wrappedAction = async function (agent, ...args) {
        // Set actionLabel only once, when the action is first created
        if (!actionLabel) {
            const actionObj = actionsList.find(a => a.perform === wrappedAction);
            actionLabel = actionObj.name.substring(1); // Remove the ! prefix
        }

        const actionFnWithAgent = async () => {
            await actionFn(agent, ...args);
        };
        // A command the model chose is never an emergency -- the emergencies are
        // the pinned rules and the self-preservation modes, and they say so. So
        // a new idea waits a moment rather than throwing away a collect that was
        // one block from done. It only ever costs the model up to 3 seconds.
        const code_return = await agent.actions.runAction(`action:${actionLabel}`, actionFnWithAgent, { timeout, resume, urgent: false });
        // Returning nothing here printed as "undefined" and told the model the
        // command was broken. An interrupted action still has something to say --
        // getBotOutputSummary marks it as partial.
        return code_return.message;
    };

    return wrappedAction;
}

// Recompose all three layers and hand the arbiter one flat policy: the mode
// controller stays layer-unaware.
function applyPolicyState(agent, state) {
    const composed = composePolicy(state);
    if (composed.rules.length === 0 && Object.keys(composed.modes).length === 0)
        agent.bot.modes.clearPolicy();
    else
        agent.bot.modes.installPolicy(composed, describePolicyState(state));
    savePolicyState(agent.name, state);
    // Only the active layer can carry a goal, so the agent writing its own
    // layer never reaches this; a person loading a profile into active does.
    applyPolicyGoal(agent, state).catch(err => console.error('Error starting policy goal:', err));
    return composed;
}

export const actionsList = [
    {
        name: '!newAction',
        description: 'Perform new and unknown custom behaviors that are not available as a command.', 
        params: {
            'prompt': { type: 'string', description: 'A natural language prompt to guide code generation. Make a detailed step-by-step plan.' }
        },
        perform: async function(agent, prompt) {
            // just ignore prompt - it is now in context in chat history
            if (!settings.allow_insecure_coding) { 
                agent.openChat('newAction is disabled. Enable with allow_insecure_coding=true in settings.js');
                return "newAction not allowed! Code writing is disabled in settings. Notify the user.";
            }
            let result = "";
            const actionFn = async () => {
                try {
                    result = await agent.coder.generateCode(agent.history);
                } catch (e) {
                    result = 'Error generating code: ' + e.toString();
                }
            };
            await agent.actions.runAction('action:newAction', actionFn, {timeout: settings.code_timeout_mins, urgent: false});
            return result;
        }
    },
    {
        name: '!stop',
        description: 'Force stop all actions and commands that are currently executing.',
        perform: async function (agent) {
            await agent.actions.stop();
            agent.clearBotLogs();
            agent.actions.cancelResume();
            agent.bot.emit('idle');
            let msg = 'Agent stopped.';
            if (agent.self_prompter.isActive())
                msg += ' Self-prompting still active.';
            return msg;
        }
    },
    {
        name: '!stfu',
        description: 'Stop chatting, but keep working on the current action and goal. Use !endGoal to actually stop working.',
        perform: async function (agent) {
            agent.openChat('Shutting up.');
            agent.shutUp();
            return;
        }
    },
    // ponytail: no !restart. It gave the model a way to answer "I'm stuck" with
    // a process restart instead of a different action, and since memory
    // persists across restarts the habit fed itself -- the summary carried
    // "retry disconnect" forward and a NoPath while chopping a log escalated
    // into a full relaunch. The supervisor already restarts on real failures,
    // so nothing needs this. Reachable again by reverting this hunk.
    {
        name: '!clearChat',
        description: 'Clear the chat history.',
        perform: async function (agent) {
            agent.history.clear();
            return agent.name + "'s chat history was cleared, starting new conversation from scratch.";
        }
    },
    {
        name: '!goToPlayer',
        description: 'Go to the given player.',
        params: {
            'player_name': {type: 'string', description: 'The name of the player to go to.'},
            'closeness': {type: 'float', description: 'How close to get to the player.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, closeness) => {
            await skills.goToPlayer(agent.bot, player_name, closeness);
        }, true)  // resume after interruptions
    },
    {
        name: '!followPlayer',
        description: 'Endlessly follow the given player.',
        params: {
            'player_name': {type: 'string', description: 'name of the player to follow.'},
            'follow_dist': {type: 'float', description: 'The distance to follow from.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, follow_dist) => {
            await skills.followPlayer(agent.bot, player_name, follow_dist);
        }, true)
    },
    {
        name: '!goToCoordinates',
        description: 'Go to the given x, y, z location.',
        params: {
            'x': {type: 'float', description: 'The x coordinate.', domain: [-Infinity, Infinity]},
            'y': {type: 'float', description: 'The y coordinate.', domain: [-64, 320]},
            'z': {type: 'float', description: 'The z coordinate.', domain: [-Infinity, Infinity]},
            'closeness': {type: 'float', description: 'How close to get to the location.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, x, y, z, closeness) => {
            await skills.goToPosition(agent.bot, x, y, z, closeness);
        }, true)  // resume after interruptions
    },
    {
        name: '!searchForBlock',
        description: 'Find and go to the nearest block of a given type in a given range.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the block. Minimum 32.', domain: [10, 512] }
        },
        perform: runAsAction(async (agent, block_type, range) => {
            if (range < 32) {
                skills.log(agent.bot, `Minimum search range is 32.`);
                range = 32;
            }
            await skills.goToNearestBlock(agent.bot, block_type, 4, range);
        }, true)  // resume after interruptions
    },
    {
        name: '!goToSurface',
        description: 'Swim straight up out of water. Use this when you are underwater and running out of air.',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.surface(agent.bot);
        })
    },
    {
        name: '!searchForEntity',
        description: 'Find and go to the nearest entity of a given type, travelling further out to look if none are in sight.',
        params: {
            'type': { type: 'string', description: 'The type of entity to go to.' },
            'search_range': { type: 'float', description: 'How far to travel looking for the entity.', domain: [32, 512] },
            'pattern': { type: 'string', description: '"spiral" (default) sweeps outward covering new ground -- use it to find something. "random" hops blindly, which is slower but gets past terrain a straight line cannot cross.', optional: true }
        },
        perform: runAsAction(async (agent, entity_type, range, pattern) => {
            await skills.searchForEntity(agent.bot, entity_type, range, { pattern: pattern === 'random' ? 'random' : 'spiral' });
        }, true)  // resume after interruptions
    },
    {
        name: '!moveAway',
        description: 'Move away from the current location in any direction by a given distance.',
        params: {'distance': { type: 'float', description: 'The distance to move away.', domain: [0, Infinity] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.moveAway(agent.bot, distance);
        })
    },
    {
        name: '!remember',
        description: 'Permanently save an important fact (a hard-won lesson, a mob\'s behavior, a location\'s danger). Facts survive restarts and are always shown to you, unlike summarized memory.',
        params: {'fact': { type: 'string', description: 'The fact to remember, one short sentence.' }},
        perform: async function (agent, fact) {
            return agent.history.addNote(fact);
        }
    },
    {
        name: '!forget',
        description: 'Delete a saved fact that is wrong or no longer matters. Must match the saved text exactly.',
        params: {'fact': { type: 'string', description: 'The exact saved fact to delete.' }},
        perform: async function (agent, fact) {
            return agent.history.forgetNote(fact);
        }
    },
    {
        name: '!rememberHere',
        description: 'Save the current location with a given name.',
        params: {'name': { type: 'string', description: 'The name to remember the location as.' }},
        perform: async function (agent, name) {
            const pos = agent.bot.entity.position;
            agent.memory_bank.rememberPlace(name, pos.x, pos.y, pos.z);
            return `Location saved as "${name}".`;
        }
    },
    {
        name: '!goToRememberedPlace',
        description: 'Go to a saved location.',
        params: {'name': { type: 'string', description: 'The name of the location to go to.' }},
        perform: runAsAction(async (agent, name) => {
            const pos = agent.memory_bank.recallPlace(name);
            if (!pos) {
            skills.log(agent.bot, `No location named "${name}" saved.`);
            return;
            }
            await skills.goToPosition(agent.bot, pos[0], pos[1], pos[2], 1);
        }, true)  // resume after interruptions
    },
    {
        name: '!givePlayer',
        description: 'Give the specified item to the given player.',
        params: { 
            'player_name': { type: 'string', description: 'The name of the player to give the item to.' }, 
            'item_name': { type: 'ItemName', description: 'The name of the item to give.' },
            'num': { type: 'int', description: 'The number of items to give.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, player_name, item_name, num) => {
            await skills.giveToPlayer(agent.bot, item_name, player_name, num);
        })
    },
    {
        name: '!consume',
        description: 'Eat/drink the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to consume.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.consume(agent.bot, item_name);
        })
    },
    {
        name: '!equip',
        description: 'Equip the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to equip.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.equip(agent.bot, item_name);
        })
    },
    {
        name: '!putInChest',
        description: 'Put the given item in the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to put in the chest.' },
            'num': { type: 'int', description: 'The number of items to put in the chest.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.putInChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!takeFromChest',
        description: 'Take the given items from the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to take.' },
            'num': { type: 'int', description: 'The number of items to take.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.takeFromChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!viewChest',
        description: 'View the items/counts of the nearest chest.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.viewChest(agent.bot);
        })
    },
    {
        name: '!discard',
        description: 'Discard the given item from the inventory.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to discard.' },
            'num': { type: 'int', description: 'The number of items to discard.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            const start_loc = agent.bot.entity.position;
            await skills.moveAway(agent.bot, 5);
            await skills.discard(agent.bot, item_name, num);
            await skills.goToPosition(agent.bot, start_loc.x, start_loc.y, start_loc.z, 0);
        })
    },
    {
        name: '!collectBlocks',
        description: 'Collect the nearest blocks of a given type.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to collect.' },
            'num': { type: 'int', description: 'The number of blocks to collect.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, type, num) => {
            await skills.collectBlock(agent.bot, type, num);
        }, true, 10) // 10 minute timeout
    },
    {
        name: '!craftRecipe',
        description: 'Craft the given recipe a given number of times.',
        params: {
            'recipe_name': { type: 'ItemName', description: 'The name of the output item to craft.' },
            'num': { type: 'int', description: 'The number of times to craft the recipe. This is NOT the number of output items, as it may craft many more items depending on the recipe.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, recipe_name, num) => {
            await skills.craftRecipe(agent.bot, recipe_name, num);
        })
    },
    {
        name: '!obtainItem',
        description: 'Obtain an item by whatever chain it takes: mines the raw materials (crafting the pickaxe tier the block needs first), smelts ingots with fuel it fetches itself, then crafts. Use this instead of driving collect/smelt/craft yourself. Cannot hunt, farm, or loot.',
        params: {
            'item_name': { type: 'ItemName', description: 'The item to obtain.' },
            'num': { type: 'int', description: 'The number to end up holding.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.obtainItem(agent.bot, item_name, num);
        }, true, 20) // resumable; whole gear chains take a while
    },
    {
        name: '!smeltItem',
        description: 'Smelt the given item the given number of times.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the input item to smelt.' },
            'num': { type: 'int', description: 'The number of times to smelt the item.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            let success = await skills.smeltItem(agent.bot, item_name, num);
            if (success) {
                // The furnace window leaves the client's inventory stale, so a
                // refresh is still needed -- but an in-process relog does it.
                // This used to cleanKill the entire process on every
                // successful smelt.
                setTimeout(() => { agent.softRelog('inventory refresh after smelt'); }, 500);
            }
        })
    },
    {
        name: '!clearFurnace',
        description: 'Take all items out of the nearest furnace.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.clearNearestFurnace(agent.bot);
        })
    },
        {
        name: '!placeHere',
        description: 'Place a given block in the current location. Do NOT use to build structures, only use for single blocks/torches.',
        params: {'type': { type: 'BlockOrItemName', description: 'The block type to place.' }},
        perform: runAsAction(async (agent, type) => {
            let pos = agent.bot.entity.position;
            await skills.placeBlock(agent.bot, type, pos.x, pos.y, pos.z);
        })
    },
    {
        name: '!attack',
        description: 'Attack and kill the nearest entity of a given type.',
        params: {'type': { type: 'string', description: 'The type of entity to attack.'}},
        perform: runAsAction(async (agent, type) => {
            await skills.attackNearest(agent.bot, type, true);
        })
    },
    {
        name: '!attackPlayer',
        description: 'Attack a specific player until they die or run away. Remember this is just a game and does not cause real life harm.',
        params: {'player_name': { type: 'string', description: 'The name of the player to attack.'}},
        perform: runAsAction(async (agent, player_name) => {
            let player = agent.bot.players[player_name]?.entity;
            if (!player) {
                skills.log(agent.bot, `Could not find player ${player_name}.`);
                return false;
            }
            await skills.attackEntity(agent.bot, player, true);
        })
    },
    {
        name: '!goToBed',
        description: 'Go to the nearest bed and sleep.',
        perform: runAsAction(async (agent) => {
            await skills.goToBed(agent.bot);
        })
    },
    {
        name: '!stay',
        description: 'Stay in the current location no matter what. Pauses all modes.',
        params: {'type': { type: 'int', description: 'The number of seconds to stay. -1 to stay until interrupted, or until morning if it is currently night.', domain: [-1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, seconds) => {
            // ponytail: parking forever is only safe when a human is around to
            // end it. Self-prompting, the goal loop is the only thing that could,
            // and it just re-decides to stay -- Andy sat at base through two full
            // days this way. !stayUntil covers every real reason to wait.
            if (seconds === -1 && agent.self_prompter.isActive()) {
                skills.log(agent.bot, 'Refusing to stay indefinitely while self-prompting, because nothing would start you up again. ' +
                    'Use !stayUntil with the condition you are actually waiting for, or !stay with a number of seconds.');
                return;
            }
            await skills.stay(agent.bot, seconds);
        })
    },
    {
        name: '!stayUntil',
        description: 'Stay in the current location until a condition becomes true, then carry on. Pauses all modes. ' +
            'Use this instead of !stay whenever you are waiting for something specific. Conditions:\n' + conditionDocs() +
            '\nArgs are positional and optional. Prefix with "not", and join with "and" or "or". ' +
            'e.g. !stayUntil("not is_night", -1) or !stayUntil("health_below 18 or hostile_nearby 8", 120)',
        params: {
            'condition': { type: 'string', description: 'The condition to wait for, e.g. "not is_night" or "has_item bread 5".' },
            'timeout_seconds': { type: 'int', description: 'Give up and stop waiting after this many seconds. -1 to wait indefinitely.', domain: [-1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, condition, timeout_seconds) => {
            const { spec, error } = parseConditionExpr(condition);
            if (error) {
                skills.log(agent.bot, `Bad condition: ${error}`);
                return;
            }
            await skills.stay(agent.bot, timeout_seconds,
                () => evalCondition(spec, agent), describeCondition(spec));
        })
    },
    {
        name: '!setMode',
        description: 'Set a mode to on or off. A mode is an automatic behavior that constantly checks and responds to the environment.',
        params: {
            'mode_name': { type: 'string', description: 'The name of the mode to enable.' },
            'on': { type: 'boolean', description: 'Whether to enable or disable the mode.' }
        },
        perform: async function (agent, mode_name, on) {
            const modes = agent.bot.modes;
            if (!modes.exists(mode_name))
            return `Mode ${mode_name} does not exist.` + modes.getDocs();
            if (modes.isOn(mode_name) === on)
            return `Mode ${mode_name} is already ${on ? 'on' : 'off'}.`;
            modes.setOn(mode_name, on);
            return `Mode ${mode_name} is now ${on ? 'on' : 'off'}.`;
        }
    },
    {
        name: '!goal',
        description: 'Set a goal prompt to endlessly work towards with continuous self-prompting. Expensive: every iteration is an LLM call. For recurring condition-gated behavior ("at night do X", "keep food stocked"), use !policy instead.',
        params: {
            'selfPrompt': { type: 'string', description: 'The goal prompt.' },
        },
        perform: async function (agent, prompt) {
            if (convoManager.inConversation()) {
                agent.self_prompter.setPromptPaused(prompt);
            }
            else {
                await agent.self_prompter.start(prompt);
            }
        }
    },
    {
        name: '!setPlan',
        description: 'Write down the steps for your current goal, separated by ";". The plan is re-shown to you every self-prompt turn, so it survives interruptions. Replaces any existing plan.',
        params: {
            'steps': { type: 'string', description: 'The steps in order, separated by ";". Example: "get wood; craft pickaxe; mine stone"' },
        },
        perform: async function (agent, steps) {
            return agent.self_prompter.setPlan(steps);
        }
    },
    {
        name: '!completeStep',
        description: 'Mark the first unchecked step of your plan as done.',
        perform: async function (agent) {
            return agent.self_prompter.completeStep();
        }
    },
    {
        name: '!endGoal',
        description: 'Call when you have accomplished your goal. It stops the current action and returns you to your standing goal, or stops self-prompting if there is none.',
        perform: async function (agent) {
            return await agent.self_prompter.finish();
        }
    },
    {
        name: '!policy',
        description: 'ADD a standing instruction for how to behave in specific circumstances (e.g. "flee from mobs, and eat when health is low"). It is added to the instructions already in that layer and the whole layer is recompiled into automatic rules checked every tick, in priority order. There are two layers: "active" is what a person set -- normally generated by merging a base profile with attribute profiles -- and "self" holds your own standing rules. Your own !policy calls always go to the "self" layer and never disturb what a person set; you may hold 8 standing instructions there, and adding a ninth drops your oldest. Your layer sits on top, so your own rules win a conflict, but a person can still outrank you by pinning. Pin a rule of your own only when it keeps you alive -- say so ("...and make this a rule that overrides whatever job I am given") when the instruction is about not dying. Notes to yourself ("prefer larch planks", "oak is not in this biome", "zombies killed me here") are NOT policies -- they are facts to remember and belong in your memory, not here. Use !goal for tasks to work towards.',
        params: {
            'instructions': { type: 'string', description: 'Natural language standing instructions describing what to do in which circumstances.' },
            'layer': { type: 'string', description: 'Which layer to add to. Only "active" for a person. Ignored for your own instructions, which always go to "self".', optional: true },
        },
        perform: async function (agent, instructions, layer = null) {
            let note = '';
            if (agent.command_self_issued) {
                if (layer && layer !== 'self')
                    note = `\n(Your own standing instructions always go to the "self" layer; the "${layer}" layer is a person's to set.)`;
                layer = 'self';
            } else {
                layer = layer ?? 'active';
                if (layer !== 'active')
                    return `"${layer}" is not a layer you can write to. Use "active".`;
            }
            const state = loadPolicyState(agent.name);
            const { source, evicted } = appendLayerSource(state, layer, instructions);
            if (evicted.length) {
                // Evicted is not deleted: the 9th thing the bot learned used to
                // silently erase the 1st, and hard-won survival notes died at
                // the cap. The archive costs one append and keeps them findable.
                try {
                    const fs = await import('fs');
                    fs.appendFileSync(`./bots/${agent.name}/policy_archive.txt`,
                        evicted.map(e => `${new Date().toISOString()} [${layer}] ${e}`).join('\n') + '\n');
                } catch (err) { console.warn('policy archive write failed:', err.message); }
                note += `\n(You may hold ${SELF_SOURCE_CAP} standing instructions at once, so your oldest no longer applies: "${evicted.join('", "')}". It was saved to your policy archive; re-add it if you still need it.)`;
            }
            let policy;
            const goal = agent.self_prompter.isActive() ? agent.self_prompter.prompt : null;
            try {
                // The goal is passed for context only. A policy must never stop
                // the self-prompt loop, however well it seems to cover the goal:
                // rules are reflexes that cannot change their own trigger, and
                // the loop is the only thing that can notice the trigger is
                // unreachable. Andy handed "mine nearby ores" to a rule, lost his
                // pickaxe, and spent four hours logging "Don't have right tools"
                // with nothing left running that could decide to craft one.
                // Recompile the whole layer from the joined source so one LLM
                // call reconciles a new instruction against the old ones.
                // ...and the OTHER layer's rules, so it stops re-deriving what a
                // person already installed. Only the other layer: this call
                // rewrites `layer` wholesale from its own source, so showing it
                // its own current rules would tell it not to write them again.
                const other = LAYERS.filter(l => l !== layer)
                    .flatMap(l => state.layers?.[l]?.policy?.rules ?? []);
                policy = await compilePolicy(agent, source.join('. '), goal, { rules: other });
            } catch (err) {
                return `Failed to compile policy: ${err.message}`;
            }
            const err = validatePolicy(policy);
            if (err) return `Failed to compile policy: ${err}`;
            state.layers[layer] = { profile: null, source, policy };
            applyPolicyState(agent, state);
            return `Added to the "${layer}" policy layer:\n${describePolicy(policy)}${note}`;
        }
    },
    {
        name: '!clearPolicy',
        description: 'Remove standing instructions and restore default behavior. Clears one layer ("active" or "self") or all of them. You may only clear your own "self" layer.',
        params: {
            'layer': { type: 'string', description: 'Which layer to clear: "active", "self", or "all".', optional: true },
        },
        perform: async function (agent, layer = null) {
            if (agent.command_self_issued) {
                if (layer && layer !== 'self')
                    return `You can only clear your own "self" layer. The "${layer === 'all' ? 'active' : layer}" instructions were set by a person; ask them if they need to change.`;
                layer = 'self';
            } else {
                layer = layer ?? 'all';
                if (!['all', ...LAYERS].includes(layer))
                    return `"${layer}" is not a layer. Use "active", "self" or "all".`;
            }
            const state = loadPolicyState(agent.name);
            for (let l of layer === 'all' ? LAYERS : [layer]) delete state.layers[l];
            // The recipe describes a layer that is no longer there; keeping it
            // would let a Regen quietly reinstate what was just cleared.
            if (!state.layers.active) state.compose = null;
            applyPolicyState(agent, state);
            return layer === 'all'
                ? 'All policy layers cleared, default behaviors restored.'
                : `The "${layer}" policy layer was cleared.\n${describePolicyState(state)}`;
        }
    },
    {
        name: '!saveProfile',
        description: 'Save the current "active" policy to the shared profile library so any bot can load it later.',
        params: {
            'name': { type: 'string', description: 'Name to save the profile under (letters, numbers, - and _).' },
            'layer': { type: 'string', description: 'Which layer to snapshot. Only "active".', optional: true },
            'kind': { type: 'string', description: 'What kind of profile: "base" (a whole stance, the default) or "attribute" (something layered on top of a base).', optional: true },
        },
        perform: async function (agent, name, layer = 'active', kind = 'base') {
            if (agent.command_self_issued)
                return 'Only a person can save a shared policy profile.';
            if (layer !== 'active')
                return `"${layer}" is not a layer that can be saved. Use "active".`;
            if (!['base', 'attribute'].includes(kind))
                return `"${kind}" is not a profile kind. Use "base" or "attribute".`;
            const state = loadPolicyState(agent.name);
            const l = state.layers?.[layer];
            if (!l?.policy) return `There is no "${layer}" policy layer to save.`;
            try {
                saveProfile(name, { source: l.source, policy: l.policy, kind });
            } catch (err) {
                return `Failed to save profile: ${err.message}`;
            }
            return `Saved the "${layer}" layer as ${kind} profile "${name}".`;
        }
    },
    {
        name: '!loadProfile',
        description: 'Load a saved base policy profile into the "active" layer, replacing whatever it held. Use !listProfiles to see what exists. Attribute profiles are not loaded directly -- they are merged onto a base from the web UI. You may only do this when your policy is not locked.',
        params: {
            'name': { type: 'string', description: 'Name of the profile to load.' },
            'layer': { type: 'string', description: 'Layer to load it into. Only "active".', optional: true },
        },
        perform: async function (agent, name, layer = null) {
            const data = loadProfile(name);
            if (!data) return `There is no policy profile named "${name}". Use !listProfiles to see what exists.`;
            layer = layer ?? 'active';
            if (layer !== 'active')
                return `"${layer}" is not a layer a profile can be loaded into. Use "active".`;
            if (agent.command_self_issued && isPolicyLocked(agent.name))
                return 'Your policy is locked, so you cannot change it yourself. Ask a person to unlock it.';
            if (data.kind !== 'base')
                return `"${name}" is an attribute profile, not a base. Attributes are merged onto a base policy, not loaded on their own.`;
            if (!data.policy)
                return `Profile "${name}" is only natural language with no compiled rules, so it cannot be loaded directly. Merge it onto a base policy instead.`;
            const err = validatePolicy(data.policy);
            if (err) return `Profile "${name}" is not a valid policy: ${err}`;
            const state = loadPolicyState(agent.name);
            state.layers[layer] = { profile: name, source: data.source, policy: data.policy };
            state.compose = { base: name, attributes: [], generated_at: Date.now() };
            applyPolicyState(agent, state);
            return `Loaded profile "${name}" into the "${layer}" layer:\n${describePolicy(data.policy)}`;
        }
    },
    {
        name: '!updateProfile',
        description: 'Create a profile in the shared library, or ADD instructions to an existing one, from natural language. Use when asked to change a base profile or to make/extend an attribute. Does NOT change the running policy -- a person applies it with Regen on the Active tab.',
        params: {
            'instructions': { type: 'string', description: 'The behavior to add, in plain language.' },
            'name': { type: 'string', description: 'Profile to create or extend. Defaults to the base profile the current policy was generated from.', optional: true },
            'kind': { type: 'string', description: 'Only for new profiles: "base" (a whole stance, compiled to rules) or "attribute" (layered on a base; default).', optional: true },
        },
        perform: async function (agent, instructions, name = null, kind = null) {
            if (agent.command_self_issued && isPolicyLocked(agent.name))
                return 'Your policy is locked, so you cannot edit the profile library yourself. Ask a person to unlock it.';
            const state = loadPolicyState(agent.name);
            name = name ?? state.compose?.base;
            if (!name) return 'No profile name given and no base profile is currently in use. Say which profile to update.';
            const existing = loadProfile(name);
            kind = existing?.kind ?? (kind === 'base' ? 'base' : 'attribute');
            const source = [...(existing?.source ?? []), instructions];
            let policy = existing?.policy;
            // Bases must stay runnable on their own, so the new instructions are
            // compiled and laid on top of the rules the profile already had --
            // never recompiled wholesale, which would shred hand-tuned rules.
            // Prose-only attributes stay prose; the Regen merge compiles them.
            if (kind === 'base' || policy) {
                let compiled;
                try {
                    compiled = await compilePolicy(agent, instructions);
                } catch (err) {
                    return `Failed to compile the new instructions: ${err.message}`;
                }
                const err = validatePolicy(compiled);
                if (err) return `Failed to compile the new instructions: ${err}`;
                policy = policy
                    ? { modes: { ...policy.modes, ...compiled.modes }, rules: [...(policy.rules ?? []), ...(compiled.rules ?? [])] }
                    : compiled;
            }
            try {
                saveProfile(name, { source, policy, kind });
            } catch (err) {
                return `Failed to save profile: ${err.message}`;
            }
            const inUse = state.compose?.base === name || state.compose?.attributes?.includes(name);
            return `${existing ? `Added to ${kind} profile` : `Created ${kind} profile`} "${name}".`
                + (inUse ? ' It is part of the running policy, so a person must hit Regen on the Active tab to apply the change.' : '');
        }
    },
    {
        name: '!listProfiles',
        description: 'List the saved policy profiles that can be loaded with !loadProfile.',
        perform: async function () {
            const profiles = listProfiles();
            if (profiles.length === 0) return 'There are no saved policy profiles.';
            return 'Saved policy profiles:\n' +
                profiles.map(p => `- ${p.name} (${p.kind}): ${p.summary}`).join('\n');
        }
    },
    {
        name: '!showVillagerTrades',
        description: 'Show trades of a specified villager.',
        params: {'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' }},
        perform: runAsAction(async (agent, id) => {
            await skills.showVillagerTrades(agent.bot, id);
        })
    },
    {
        name: '!tradeWithVillager',
        description: 'Trade with a specified villager.',
        params: {
            'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' },
            'index': { type: 'int', description: 'The index of the trade you want executed (1-indexed).', domain: [1, Number.MAX_SAFE_INTEGER] },
            'count': { type: 'int', description: 'How many times that trade should be executed.', domain: [1, Number.MAX_SAFE_INTEGER] },
        },
        perform: runAsAction(async (agent, id, index, count) => {
            await skills.tradeWithVillager(agent.bot, id, index, count);
        })
    },
    {
        name: '!startConversation',
        description: 'Start a conversation with a bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to send the message to.' },
            'message': { type: 'string', description: 'The message to send.' },
        },
        perform: async function (agent, player_name, message) {
            if (!convoManager.isOtherAgent(player_name))
                return player_name + ' is not a bot, cannot start conversation.';
            if (convoManager.inConversation() && !convoManager.inConversation(player_name)) 
                convoManager.forceEndCurrentConversation();
            else if (convoManager.inConversation(player_name))
                agent.history.add('system', 'You are already in conversation with ' + player_name + '. Don\'t use this command to talk to them.');
            convoManager.startConversation(player_name, message);
        }
    },
    {
        name: '!endConversation',
        description: 'End the conversation with the given bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to end the conversation with.' }
        },
        perform: async function (agent, player_name) {
            if (!convoManager.inConversation(player_name))
                return `Not in conversation with ${player_name}.`;
            convoManager.endConversation(player_name);
            return `Converstaion with ${player_name} ended.`;
        }
    },
    {
        name: '!lookAtPlayer',
        description: 'Look at a player or look in the same direction as the player.',
        params: {
            'player_name': { type: 'string', description: 'Name of the target player' },
            'direction': {
                type: 'string',
                description: 'How to look ("at": look at the player, "with": look in the same direction as the player)',
            }
        },
        perform: async function(agent, player_name, direction) {
            if (direction !== 'at' && direction !== 'with') {
                return "Invalid direction. Use 'at' or 'with'.";
            }
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPlayer(player_name, direction);
            };
            await agent.actions.runAction('action:lookAtPlayer', actionFn);
            return result;
        }
    },
    {
        name: '!lookAtPosition',
        description: 'Look at specified coordinates.',
        params: {
            'x': { type: 'int', description: 'x coordinate' },
            'y': { type: 'int', description: 'y coordinate' },
            'z': { type: 'int', description: 'z coordinate' }
        },
        perform: async function(agent, x, y, z) {
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPosition(x, y, z);
            };
            await agent.actions.runAction('action:lookAtPosition', actionFn);
            return result;
        }
    },
    {
        name: '!digDown',
        description: 'Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.',
        params: {'distance': { type: 'int', description: 'Distance to dig down', domain: [1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.digDown(agent.bot, distance);
        })
    },
    {
        // Was also registered as !goToSurface, which silently shadowed the
        // swim-up drowning escape above (commandMap is keyed by name, last
        // wins): 17 false "surfaced" reports while the bot sank 56 blocks.
        // Different job, different name.
        name: '!climbToSurface',
        description: 'Pathfind up and out to the open sky (use when underground in a cave or hole). NOT for drowning: use !goToSurface to swim up.',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.goToSurface(agent.bot);
        })
    },
    {
        name: '!useOn',
        description: 'Use (right click) the given tool on the nearest target of the given type.',
        params: {
            'tool_name': { type: 'string', description: 'Name of the tool to use, or "hand" for no tool.' },
            'target': { type: 'string', description: 'The target as an entity type, block type, or "nothing" for no target.' }
        },
        perform: runAsAction(async (agent, tool_name, target) => {
            await skills.useToolOn(agent.bot, tool_name, target);
        })
    },
];
