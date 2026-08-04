import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import { writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync, unlinkSync } from 'fs';

// A policy is a set of standing rules compiled from natural-language
// instructions by the LLM. Each rule is a tiny behavior tree: a condition
// subtree (with all/any/not combinators) gating a sequence of action leaves.
// The ModeController arbiter ticks rules alongside the built-in modes,
// in priority order.

// ---------- condition leaves ----------
// (agent, args) => bool.  Must be fast and side-effect free.

// Conditions are evaluated on a timer whether or not anything comes of them, so
// they get a tighter budget than actions. A CPU profile of the live agent put
// 56.9% of ALL its CPU inside getNearestBlocksWhere, 47.3% of that under
// block_nearby below. The cause is upstream: mineflayer skips a chunk section
// only when section.palette proves the block is absent, and Prominence 2 sends
// 20-bits-per-block sections (see patches/prismarine-chunk) that have no
// palette at all -- so every section is fully materialized, one Block object per
// candidate. Until that is fixed properly, keep condition scans small.
// ponytail: a budget, not a fix. The fix is matching raw state ids and never
// constructing Blocks -- worth doing if world scanning stays this hot.
const MAX_COND_SCAN = 16;

export const CONDITIONS = {
    hostile_nearby: {
        args: { range: 'number (blocks, default 16)' },
        desc: 'A hostile mob is within range.',
        fn: (agent, a) => !!world.getNearestEntityWhere(agent.bot, e => mc.isHostile(e), a.range ?? 16)
    },
    entity_nearby: {
        args: { name: 'string entity name, e.g. "zombie"', range: 'number (default 16)' },
        desc: 'An entity of the given type is within range.',
        fn: (agent, a) => !!world.getNearestEntityWhere(agent.bot, e => e.name === a.name, a.range ?? 16)
    },
    block_nearby: {
        args: { name: 'string block name, e.g. "wheat"', range: `number (default 16, max ${MAX_COND_SCAN})` },
        desc: 'A block of the given type is within range. Family names match every variant: "log" is any wood\'s log, "planks" any plank, and any "<x>_ore" includes its deepslate form.',
        // Profiled at 47% of all agent CPU: six of these at range 32, in one
        // rule's condition. Scan cost is cubic, so 32 -> 16 is ~8x cheaper, and
        // "is it near me" does not need 32. See MAX_COND_SCAN.
        fn: (agent, a) => !!world.getNearestBlock(agent.bot, a.name, Math.min(a.range ?? 16, MAX_COND_SCAN))
    },
    animal_nearby: {
        args: { range: 'number (default 16)' },
        desc: 'A huntable animal is within range.',
        fn: (agent, a) => !!world.getNearestEntityWhere(agent.bot, e => mc.isHuntable(e), a.range ?? 16)
    },
    player_nearby: {
        args: { name: 'string player name, or "any"', range: 'number (default 16)' },
        desc: 'A player is within range.',
        fn: (agent, a) => !!world.getNearestEntityWhere(agent.bot,
            e => e.type === 'player' && (a.name === 'any' || !a.name || e.username === a.name), a.range ?? 16)
    },
    health_below: {
        args: { value: 'number 0-20' },
        desc: 'Bot health is below value (max 20).',
        fn: (agent, a) => agent.bot.health < (a.value ?? 10)
    },
    hunger_below: {
        args: { value: 'number 0-20' },
        desc: 'Bot food level is below value (max 20).',
        fn: (agent, a) => agent.bot.food < (a.value ?? 10)
    },
    has_item: {
        args: { item: 'string item name', count: 'number (default 1)' },
        desc: 'Bot inventory contains at least count of item. Family names count all variants: "log" is every wood\'s log, "planks" every plank.',
        fn: (agent, a) => {
            const counts = world.getInventoryCounts(agent.bot);
            return mc.expandBlockName(a.item).reduce((sum, name) => sum + (counts[name] ?? 0), 0) >= (a.count ?? 1);
        }
    },
    at_position: {
        args: { x: 'number', y: 'number', z: 'number', range: 'number (default 3)' },
        desc: 'Bot is within range blocks of the position.',
        fn: (agent, a) => agent.bot.entity.position.distanceTo(
            { x: a.x, y: a.y, z: a.z }) <= (a.range ?? 3)
    },
    drowning: {
        args: { air: 'number (default 12), oxygen out of 20 below which this is true' },
        desc: 'Bot is underwater and losing air. Use this for "underwater"/"drowning", not block_nearby water, which is also true standing on the shore.',
        fn: (agent, a) => agent.bot.oxygenLevel !== undefined && agent.bot.oxygenLevel <= (a.air ?? 12)
    },
    is_night: {
        args: { lead: 'number of ticks before nightfall to start saying yes (default 0). ~1500 gives the bot time to walk home before mobs are out.' },
        desc: 'It is night time.',
        fn: (agent, a) => world.isNight(agent.bot, a.lead ?? 0)
    },
    is_idle: {
        args: {},
        desc: 'Bot has no current action or goal in progress.',
        fn: (agent) => agent.isIdle()
    },
    always: {
        args: {},
        desc: 'Always true. Use with is_idle or a cooldown for periodic behavior.',
        fn: () => true
    },
};

// ---------- action leaves ----------
// async (agent, args).  Run inside the ActionManager like any mode action.

export const ACTIONS = {
    flee: {
        args: { distance: 'number (default 24)' },
        desc: 'Run away from all nearby enemies.',
        fn: async (agent, a) => await skills.avoidEnemies(agent.bot, a.distance ?? 24)
    },
    fight_back: {
        args: {},
        desc: 'Attack nearby hostile mobs until they are dead or gone.',
        fn: async (agent) => await skills.defendSelf(agent.bot, 8)
    },
    attack: {
        args: { type: 'string mob type' },
        desc: 'Attack the nearest entity of the given type.',
        fn: async (agent, a) => await skills.attackNearest(agent.bot, a.type, true)
    },
    goto: {
        args: { x: 'number', y: 'number', z: 'number', closeness: 'number (default 2)' },
        desc: 'Navigate to a position.',
        fn: async (agent, a) => await skills.goToPosition(agent.bot, a.x, a.y, a.z, a.closeness ?? 2)
    },
    goto_player: {
        args: { name: 'string player name', closeness: 'number (default 3)' },
        desc: 'Go to a player.',
        fn: async (agent, a) => await skills.goToPlayer(agent.bot, a.name, a.closeness ?? 3)
    },
    follow_player: {
        args: { name: 'string player name' },
        desc: 'Follow a player until interrupted.',
        fn: async (agent, a) => await skills.followPlayer(agent.bot, a.name, 4)
    },
    move_away: {
        args: { distance: 'number (default 8)' },
        desc: 'Move away from the current position in any direction.',
        fn: async (agent, a) => await skills.moveAway(agent.bot, a.distance ?? 8)
    },
    stay: {
        args: { until: 'string flat condition, e.g. "not is_night" or "hunger_below 10 or hostile_nearby 8"', seconds: 'number, give up after (default -1: only the condition ends it)' },
        desc: 'Stay in place until the condition becomes true. Same conditions as "when", written flat with positional args. The cheap way to wait something out.',
        fn: async (agent, a) => {
            const { spec, error } = parseConditionExpr(a.until ?? '');
            if (error) { skills.log(agent.bot, `stay: ${error}`); return; }
            await skills.stay(agent.bot, a.seconds ?? -1, () => evalCondition(spec, agent), describeCondition(spec));
        }
    },
    go_to_surface: {
        args: {},
        desc: 'Swim or climb up to the surface. Use for drowning or being stuck underground; never prompt_self for this.',
        fn: async (agent) => await skills.goToSurface(agent.bot)
    },
    search_block: {
        args: { type: 'string block name', range: 'number (default 64, max 512)' },
        desc: 'Find and go to the nearest block of a type, searching farther than collect. Family names ("log", "<x>_ore") match every variant.',
        fn: async (agent, a) => await skills.goToNearestBlock(agent.bot, a.type, 2, Math.min(a.range ?? 64, MAX_BLOCK_SEARCH))
    },
    search_entity: {
        args: { type: 'string entity name, e.g. "cow"', range: 'number (default 64, max 512)' },
        desc: 'Find and go to the nearest entity of a type.',
        fn: async (agent, a) => await skills.goToNearestEntity(agent.bot, a.type, 2, Math.min(a.range ?? 64, 512))
    },
    collect: {
        args: { type: 'string block name', num: 'number (default 1)' },
        desc: 'Collect blocks of a type within 64 blocks. Family names ("log", "<x>_ore") collect any variant. If none are that close, the rule simply collects nothing -- gate it on block_nearby so it does not retry forever.',
        fn: async (agent, a) => await skills.collectBlock(agent.bot, a.type, a.num ?? 1)
    },
    deposit: {
        args: { item: 'string item name', num: 'number (default all)' },
        desc: 'Put items into the nearest chest (within 32 blocks). Use goto first to reach a specific chest. Family names deposit all variants: "log" is every wood\'s log.',
        fn: async (agent, a) => {
            const counts = world.getInventoryCounts(agent.bot);
            for (const name of mc.expandBlockName(a.item))
                if (counts[name])
                    await skills.putInChest(agent.bot, name, a.num ?? -1);
        }
    },
    consume: {
        args: { item: 'string item name, or omit to eat whatever food is in the bag' },
        desc: 'Eat or drink an inventory item.',
        fn: async (agent, a) => await skills.consume(agent.bot, a.item ?? '')
    },
    equip: {
        args: { item: 'string item name' },
        desc: 'Equip an inventory item.',
        fn: async (agent, a) => await skills.equip(agent.bot, a.item)
    },
    equip_weapon: {
        args: {},
        desc: 'Hold the best weapon in the inventory. Does nothing if it is already held, or if there is no weapon.',
        // "equip a weapon" spelled with the equip action needs the rule to name
        // one item, so it named wooden_sword while its guard accepted any of
        // five swords -- holding only a stone_sword it fired and failed every
        // 3 seconds. This picks by attack damage, which also covers the
        // modpack's swords that no hardcoded list would name.
        fn: async (agent) => await skills.equipHighestAttack(agent.bot)
    },
    go_to_bed: {
        args: {},
        desc: 'Go to the nearest bed and sleep.',
        fn: async (agent) => await skills.goToBed(agent.bot)
    },
    say: {
        args: { message: 'string' },
        desc: 'Say a message in chat.',
        fn: async (agent, a) => agent.openChat(a.message)
    },
    set_mode: {
        args: { mode: 'string mode name', on: 'boolean' },
        desc: 'Turn a built-in mode on or off.',
        fn: async (agent, a) => { if (agent.bot.modes.exists(a.mode)) agent.bot.modes.setOn(a.mode, a.on); }
    },
    prompt_self: {
        args: { message: 'string instruction to yourself' },
        desc: 'Ask your own LLM reasoning to handle a situation the other actions cannot express. Expensive; use sparingly.',
        fn: null // dispatched outside the action wrapper; see Rule.run
    },
};

// ---------- validation & condition building ----------

// Actions that leave the world exactly as they found it. Fine as a reaction to
// something, useless as a standing habit.
const AIMLESS_ACTIONS = ['move_away', 'prompt_self', 'say'];

// Does the trigger say anything about the world, or does it just mean "nothing
// is going on"? Idleness and the *absence* of something are the resting state,
// so a rule gated only on those fires forever. Seen live: "move freely when no
// hostiles are nearby" compiled to move_away(8) every 3 seconds, which walked
// the bot in circles and stomped every action it tried to start.
function hasPositiveTrigger(when, negated = false) {
    if (!when) return false;
    if (when.all || when.any) return (when.all ?? when.any).some(c => hasPositiveTrigger(c, negated));
    if (when.not) return hasPositiveTrigger(when.not, !negated);
    return !negated && !['is_idle', 'always'].includes(when.cond);
}

// Retreating from a mob is the cowardice mode's whole job, and it moves
// *away from* the threat. A rule that answers "hostile within N" with a plain
// move_away picks a random direction, so it can land back inside the same
// radius and fire again on the next tick. Seen live: avoid_hostile_areas
// (hostile within 24 -> move_away 16) walked Andy back and forth between two
// cave positions for hours.
// World scans are still synchronous and still cubic in range, so this stays a
// hard cap -- but it is a much cheaper cube now that matching compares state
// ids instead of building a Block per candidate (world.js findBlockPositions).
// Searching 256 for crops absent from the biome used to pin the process at ~92%
// CPU with no rules, chat or logs; that was the materializing scan, and 128 was
// too slow for the same reason. 128 is affordable now, and it is what makes a
// gathering rule useful in a biome where the food is not right next door.
// ponytail: still a hard cap. Chunk the scan across ticks before going wider.
const MAX_BLOCK_SEARCH = 128;

const RETREAT_ACTIONS = ['move_away', 'flee'];
const PROXIMITY_CONDS = ['hostile_nearby', 'entity_nearby'];

function triggersOnProximity(when) {
    if (!when) return false;
    if (when.all || when.any) return (when.all ?? when.any).some(triggersOnProximity);
    if (when.not) return false; // "no mob nearby" is handled by hasPositiveTrigger
    return PROXIMITY_CONDS.includes(when.cond);
}

// is_night is the one condition no action can change -- you can only wait it
// out. So a rule gated on it re-fires every cooldown until morning, and if all
// it does is walk somewhere, arriving leaves the agent idle at the destination
// with the rule still eligible. Seen live: go_to_chest_at_night (is_night ->
// goto base, cooldown 3) fired 176 times in 15 minutes, flapping the status
// between "stopped" and the rule name. The fix is to park with "stay".
function triggersOnNight(when) {
    if (!when) return false;
    if (when.all || when.any) return (when.all ?? when.any).some(triggersOnNight);
    if (when.not) return false;
    return when.cond === 'is_night';
}

// Largest is_night lead anywhere in a condition tree, or -1 if it mentions none.
function nightLead(spec) {
    if (!spec) return -1;
    if (spec.all || spec.any) return Math.max(...(spec.all ?? spec.any).map(nightLead));
    if (spec.not) return nightLead(spec.not);
    return spec.cond === 'is_night' ? (spec.lead ?? 0) : -1;
}

export function validatePolicy(policy) {
    if (!policy || typeof policy !== 'object') return 'Policy must be a JSON object.';
    if (policy.modes) {
        for (let m in policy.modes)
            if (typeof policy.modes[m] !== 'boolean') return `modes.${m} must be boolean.`;
    }
    if (!Array.isArray(policy.rules)) return 'Policy must have a "rules" array.';
    const names = new Set();
    for (let rule of policy.rules) {
        if (!rule.name || typeof rule.name !== 'string') return 'Each rule needs a string "name".';
        if (names.has(rule.name)) return `Duplicate rule name "${rule.name}".`;
        names.add(rule.name);
        const condErr = validateCondition(rule.when);
        if (condErr) return `Rule "${rule.name}": ${condErr}`;
        if (!Array.isArray(rule.do) || rule.do.length === 0) return `Rule "${rule.name}" needs a non-empty "do" array.`;
        for (let step of rule.do) {
            if (!step.act || !ACTIONS[step.act])
                return `Rule "${rule.name}": unknown action "${step?.act}". Valid: ${Object.keys(ACTIONS).join(', ')}`;
            if (step.act === 'stay') {
                const { spec, error } = parseConditionExpr(step.until ?? '');
                if (error) return `Rule "${rule.name}": stay needs a valid "until" condition (a stay with no exit parks the bot forever): ${error}`;
                // Trigger at dusk, park until dawn: the two have to agree on
                // where night starts. "is_night 1500" fires at tick 11500, but
                // "until not is_night" is already true at 11500, so the stay
                // ends the tick it begins and the bot wanders back out. The log
                // says "Not staying, not is_night already" and nothing else.
                const lead = nightLead(rule.when), stay_lead = nightLead(spec);
                if (lead > 0 && stay_lead >= 0 && stay_lead < lead)
                    return `Rule "${rule.name}": the trigger says night starts ${lead} ticks early but the stay ` +
                        `uses ${stay_lead}, so "${step.until}" is already true when the rule fires and the stay ` +
                        `ends immediately. Write it as "not is_night ${lead}".`;
            }
        }
        if (rule.interrupts && !['all', 'idle'].includes(rule.interrupts))
            return `Rule "${rule.name}": "interrupts" must be "all" or "idle".`;
        // ponytail: no cap on how many rules a layer pins. If an agent starts
        // pinning everything and starves a person's job rules, cap pinned rules
        // in the self layer where !policy writes it.
        if (rule.pinned !== undefined && typeof rule.pinned !== 'boolean')
            return `Rule "${rule.name}": "pinned" must be true or false.`;
        if (!hasPositiveTrigger(rule.when) && rule.do.every(step => AIMLESS_ACTIONS.includes(step.act)))
            return `Rule "${rule.name}" fires whenever nothing is happening but only does ${rule.do.map(s => s.act).join('/')}. ` +
                'Doing nothing is the agent\'s resting state, so this rule would fire forever and starve every real action. ' +
                'Give it a trigger that is actually about the world, or an action that makes progress.';
        if (triggersOnNight(rule.when) && rule.do.every(step => step.act === 'goto'))
            return `Rule "${rule.name}" walks somewhere every time it fires and it fires all night, because ` +
                'arriving does not make it stop being night. The agent will re-path to the same spot every ' +
                `${rule.cooldown ?? 3} seconds until morning. Add {"act": "stay", "until": "not is_night"} after ` +
                'the goto so it parks there instead.';
        if (triggersOnProximity(rule.when) && rule.do.every(step => RETREAT_ACTIONS.includes(step.act)))
            return `Rule "${rule.name}" retreats whenever a mob is nearby, which is exactly what the built-in ` +
                'cowardice mode does, and it does it better: move_away picks a random direction, so the bot can ' +
                'land back inside the same radius and retreat again forever. Set {"cowardice": true} in "modes" ' +
                'instead, and only write a rule here if it does something cowardice cannot.';
    }
    return null;
}

export function validateCondition(spec) {
    if (!spec || typeof spec !== 'object') return 'missing "when" condition.';
    if (spec.all) return Array.isArray(spec.all) ? spec.all.map(validateCondition).find(e => e) ?? null : '"all" must be an array.';
    if (spec.any) return Array.isArray(spec.any) ? spec.any.map(validateCondition).find(e => e) ?? null : '"any" must be an array.';
    if (spec.not) return validateCondition(spec.not);
    if (!spec.cond || !CONDITIONS[spec.cond])
        return `unknown condition "${spec?.cond}". Valid: ${Object.keys(CONDITIONS).join(', ')}`;
    return null;
}

// The command parser only accepts numbers, booleans and quote-free strings, so
// a condition reaching a command cannot be JSON the way a policy rule's is.
// Same vocabulary, written flat: "not is_night", "health_below 10",
// "has_item bread 5", "hostile_nearby 8 and health_below 6". Args are
// positional, in the order CONDITIONS lists them, and may be omitted to default.
export function parseConditionExpr(expr) {
    if (typeof expr !== 'string' || !expr.trim()) return { error: 'empty condition.' };
    const joiner = / and /.test(expr) ? 'all' : / or /.test(expr) ? 'any' : null;
    if (joiner && (/ and /.test(expr) && / or /.test(expr)))
        return { error: 'mixing "and" with "or" is not supported. Use one or the other.' };
    const terms = joiner ? expr.split(joiner === 'all' ? / and / : / or /) : [expr];
    const specs = [];
    for (let term of terms) {
        const words = term.trim().split(/\s+/);
        const negated = words[0] === 'not';
        if (negated) words.shift();
        const name = words.shift();
        const def = CONDITIONS[name];
        if (!def) return { error: `unknown condition "${name}". Valid: ${Object.keys(CONDITIONS).join(', ')}` };
        const argNames = Object.keys(def.args);
        if (words.length > argNames.length)
            return { error: `"${name}" takes at most ${argNames.length} args (${argNames.join(', ')}), got ${words.length}.` };
        const spec = { cond: name };
        words.forEach((w, i) => { spec[argNames[i]] = isNaN(Number(w)) ? w : Number(w); });
        specs.push(negated ? { not: spec } : spec);
    }
    return { spec: specs.length === 1 ? specs[0] : { [joiner]: specs } };
}

// One line per condition, for command docs.
export function conditionDocs() {
    return Object.entries(CONDITIONS)
        .map(([name, c]) => `${name}${Object.entries(c.args).map(([a, d]) => ` <${a}: ${d}>`).join('')} - ${c.desc}`)
        .join('\n');
}

// Readable form of a condition, for logs the bot reads back to itself.
export function describeCondition(spec) {
    if (spec.all) return spec.all.map(describeCondition).join(' and ');
    if (spec.any) return spec.any.map(describeCondition).join(' or ');
    if (spec.not) return 'not ' + describeCondition(spec.not);
    const args = Object.entries(spec).filter(([k]) => k !== 'cond');
    return spec.cond + (args.length ? `(${args.map(([k, v]) => `${k}=${v}`).join(', ')})` : '');
}

export function evalCondition(spec, agent) {
    if (spec.all) return spec.all.every(c => evalCondition(c, agent));
    if (spec.any) return spec.any.some(c => evalCondition(c, agent));
    if (spec.not) return !evalCondition(spec.not, agent);
    return !!CONDITIONS[spec.cond].fn(agent, spec);
}

// ---------- rule runtime ----------

export class Rule {
    constructor(spec) {
        this.spec = spec;
        this.name = 'policy:' + spec.name;
        this.description = spec.description ?? spec.name;
        this.interrupts = spec.interrupts === 'idle' ? [] : ['all'];
        this.on = true;
        this.paused = false;
        this.active = false;
        this.autonomous = true; // completing needs no explanation to the model
        this.cooldown = (spec.cooldown ?? 3) * 1000;
        this.last_fire = 0;
        this.last_eval = 0;
        this.backoff = 1;
    }

    eligible(agent) {
        const now = Date.now();
        if (now - this.last_fire < this.cooldown * this.backoff) return false;
        // Conditions are not free: block_nearby is a synchronous world scan, and
        // the cooldown above only throttles rules that actually FIRE, so a rule
        // whose condition is never satisfied re-scanned the world on every one
        // of the 3.3 ticks per second, forever. Six block_nearby(32) clauses in
        // one unsatisfiable rule pinned the process at 100% CPU and starved
        // everything else. Evaluating faster than we could act is pointless, so
        // the cooldown gates evaluation too.
        if (now - this.last_eval < this.cooldown * this.backoff) return false;
        this.last_eval = now;
        return evalCondition(this.spec.when, agent);
    }

    // Called by the ModeController arbiter via the same execute() path as
    // built-in modes. Runs all steps sequentially as one action; prompt_self
    // steps are collected and dispatched after the action completes so they
    // don't re-enter the ActionManager while it is executing.
    async update(agent, execute) {
        if (!this.eligible(agent)) return;
        this.last_fire = Date.now();
        const prompts = [];
        const steps = this.spec.do.filter(s => s.act !== 'prompt_self');
        this.spec.do.filter(s => s.act === 'prompt_self').forEach(s => prompts.push(s.message));
        if (steps.length > 0) {
            // A rule whose condition it cannot change and whose action always
            // fails re-fires forever and keeps the agent busy, which starves the
            // reasoning loop that could actually fix the situation. Seen live:
            // Andy with no pickaxe, standing on stone, running collect(stone) ->
            // "Don't have right tools" a few times a second for an entire day
            // while the goal loop never got a turn to craft the pickaxe.
            // Skills return false when they accomplish nothing, so double the
            // rule's cooldown each time that happens and reset on any success.
            let progress = false;
            await execute(this, agent, async () => {
                for (let step of steps) {
                    if (agent.bot.interrupt_code) return;
                    // A step that throws must not take the rest of the rule with
                    // it. shelter_at_night is [goto base, stay until dawn], and
                    // goto threw "No path to the goal" every single night, so the
                    // stay -- the step that actually keeps the bot alive -- never
                    // ran. Andy stood in the open until something killed him, and
                    // since nothing reported progress the rule's backoff doubled
                    // until it was only trying twice an hour.
                    try {
                        if (await ACTIONS[step.act].fn(agent, step) !== false) progress = true;
                    } catch (err) {
                        skills.log(agent.bot, `Rule '${this.spec.name}' step ${step.act} failed: ${err.message}`);
                    }
                }
            });
            // ponytail: capped at ~17 min so a rule that starts working again is
            // not dead forever. Per-step backoff if one bad step ever masks a
            // good one in the same rule.
            this.backoff = progress ? 1 : Math.min(this.backoff * 2, 200);
        }
        for (let message of prompts)
            agent.handleMessage('system', `(POLICY RULE '${this.spec.name}') ${message}`);
    }
}

// ---------- persistence ----------

function policyPath(agentName) {
    return `./bots/${agentName}/policy.json`;
}

// Standing instructions live in three layers so the agent's own notes can never
// wipe out a person's. It replaced its survival policy with a note about
// preferred planks twice in one hour; the second time it died 26 times in 6
// minutes, respawning into zombies with no rule left telling it to flee or
// shelter. Self-issued writes are confined to the "self" layer, which is
// composed at the lowest priority and never touches "base" or "active", so
// there is nothing for a note-to-self to overwrite.
export const LAYERS = ['base', 'active', 'self'];

// Modes later in this list win; rules earlier in the composed list win.
const MODE_ORDER = ['self', 'base', 'active'];
const RULE_ORDER = ['active', 'base', 'self'];

// The agent appends to its own layer unprompted. Without a cap the joined
// source grows until the compile prompt is mostly stale notes.
export const SELF_SOURCE_CAP = 8;

function emptyState() {
    return { layers: {}, locked: false };
}

// Old flat files were {source, policy, user_set}. A person's went to what is
// now the active layer; the agent's own to self. Missing user_set predates the
// field and was always a person's.
function migrateFlat(saved) {
    const state = emptyState();
    const layer = saved.user_set === false ? 'self' : 'active';
    state.layers[layer] = {
        profile: null,
        source: typeof saved.source === 'string' ? [saved.source] : (saved.source ?? []),
        policy: saved.policy,
    };
    return state;
}

export function loadPolicyState(agentName) {
    try {
        if (!existsSync(policyPath(agentName))) return emptyState();
        const saved = JSON.parse(readFileSync(policyPath(agentName), 'utf8'));
        if (saved?.layers) return { layers: saved.layers ?? {}, locked: !!saved.locked };
        if (saved?.policy) return migrateFlat(saved);
        return emptyState();
    } catch (err) {
        console.error('Failed to load policy:', err);
        return emptyState();
    }
}

export function savePolicyState(agentName, state) {
    mkdirSync(`./bots/${agentName}`, { recursive: true });
    writeFileSync(policyPath(agentName), JSON.stringify({
        layers: state.layers ?? {},
        locked: !!state.locked,
    }, null, 2));
}

export function deletePolicyLayer(state, layer) {
    delete state.layers[layer];
    return state;
}

export function clearPolicyState(agentName) {
    try { unlinkSync(policyPath(agentName)); } catch {}
}

// Appends an instruction to a layer's accumulated source, evicting oldest first
// when the self layer is over its cap.
// Returns the evicted instructions too: an instruction that silently stops
// existing is worse than one that was never added, because the agent goes on
// believing it still holds. The caller tells it what it lost.
export function appendLayerSource(state, layer, instruction) {
    const source = [...(state.layers?.[layer]?.source ?? []), instruction];
    const evicted = layer === 'self' && source.length > SELF_SOURCE_CAP
        ? source.splice(0, source.length - SELF_SOURCE_CAP)
        : [];
    return { source, evicted };
}

// One {modes, rules} for installPolicy. Rule names carry their layer so two
// layers can both name a rule "gather_wood" without colliding in the arbiter.
export function composePolicy(state) {
    const modes = {};
    const rules = [];
    for (let layer of MODE_ORDER)
        Object.assign(modes, state.layers?.[layer]?.policy?.modes ?? {});
    // A pinned rule sorts above every unpinned one, whatever layer it came from:
    // it is how a survival rule the agent wrote for itself survives a job profile
    // loaded into the layer above it. Pinning does not flatten the layers, it
    // just moves the whole priority contest up one level -- among pinned rules
    // the usual active > base > self order still decides, so a person can always
    // pin their own rule to outrank one the agent pinned.
    for (let layer of RULE_ORDER)
        for (let rule of state.layers?.[layer]?.policy?.rules ?? [])
            rules.push({ ...rule, name: `${layer}:${rule.name}`, _rank: RULE_ORDER.indexOf(layer) });
    rules.sort((a, b) => (!!b.pinned - !!a.pinned) || (a._rank - b._rank));
    return { modes, rules: rules.map(({ _rank, ...rule }) => rule) };
}

export function describePolicyState(state) {
    const parts = [];
    for (let layer of LAYERS) {
        const l = state.layers?.[layer];
        if (!l?.policy) continue;
        const from = l.profile ? ` (profile "${l.profile}")` : '';
        parts.push(`[${layer}]${from} ${l.source?.join(' | ') ?? ''}`);
    }
    if (state.locked) parts.push('(locked: the agent may not load profiles)');
    return parts.length ? parts.join('\n') : 'No policy set.';
}

export function setPolicyLocked(agentName, locked) {
    const state = loadPolicyState(agentName);
    state.locked = !!locked;
    savePolicyState(agentName, state);
    return state.locked;
}

export function isPolicyLocked(agentName) {
    return !!loadPolicyState(agentName).locked;
}

// ---------- shared profile library ----------

// ./profiles holds model configs; the policy library is its own directory.
function profilePath(profileName) {
    if (!/^[\w-]+$/.test(profileName ?? '')) return null;
    return `./policies/${profileName}.json`;
}

export function saveProfile(profileName, { source, policy, layer_hint }) {
    const path = profilePath(profileName);
    if (!path) throw new Error(`Invalid profile name "${profileName}". Use letters, numbers, - and _ only.`);
    mkdirSync('./policies', { recursive: true });
    writeFileSync(path, JSON.stringify({
        source: Array.isArray(source) ? source : [source],
        policy,
        ...(layer_hint ? { layer_hint } : {}),
    }, null, 2));
}

export function loadProfile(profileName) {
    try {
        const path = profilePath(profileName);
        if (!path || !existsSync(path)) return null;
        const data = JSON.parse(readFileSync(path, 'utf8'));
        if (!data?.policy) return null;
        if (typeof data.source === 'string') data.source = [data.source];
        data.source = data.source ?? [];
        return data;
    } catch (err) {
        console.error('Failed to load policy profile:', err);
        return null;
    }
}

export function listProfiles() {
    try {
        if (!existsSync('./policies')) return [];
        return readdirSync('./policies').filter(f => f.endsWith('.json')).map(f => {
            const name = f.slice(0, -5);
            const data = loadProfile(name);
            if (!data) return null;
            return { name, layer_hint: data.layer_hint ?? 'active', summary: profileSummary(data) };
        }).filter(Boolean);
    } catch (err) {
        console.error('Failed to list policy profiles:', err);
        return [];
    }
}

function profileSummary(data) {
    const text = data.source.join('; ')
        || (data.policy.rules ?? []).map(r => r.description ?? r.name).join('; ');
    return text.length > 120 ? text.slice(0, 117) + '...' : text;
}

// ---------- LLM compiler ----------

function registryDocs() {
    let docs = 'CONDITIONS (use in "when", combinable with {"all":[...]}, {"any":[...]}, {"not":{...}}):\n';
    for (let name in CONDITIONS)
        docs += `- {"cond": "${name}"${Object.keys(CONDITIONS[name].args).map(a => `, "${a}": <${CONDITIONS[name].args[a]}>`).join('')}} : ${CONDITIONS[name].desc}\n`;
    docs += '\nACTIONS (use in "do" array, executed in order):\n';
    for (let name in ACTIONS)
        docs += `- {"act": "${name}"${Object.keys(ACTIONS[name].args).map(a => `, "${a}": <${ACTIONS[name].args[a]}>`).join('')}} : ${ACTIONS[name].desc}\n`;
    return docs;
}

const COMPILE_PROMPT = `You are a policy compiler for a Minecraft agent. Convert the user's standing instructions into a JSON policy that the agent's behavior tree will evaluate every tick, in rule order (earlier rules have higher priority).

$REGISTRY

Built-in modes that can be toggled with the top-level "modes" object: self_preservation, unstuck, cowardice (flee enemies), self_defense (fight enemies), hunting, item_collecting, torch_placing, elbow_room, idle_staring.
IMPORTANT: if the instructions imply a combat stance (fleeing or fighting), explicitly disable the conflicting built-in mode(s). E.g. "flee from mobs" must set {"self_defense": false, "hunting": false} and may keep cowardice on or express fleeing as a rule.

Rule format:
{"name": "snake_case_id", "description": "short human summary", "when": <condition>, "do": [<actions>], "interrupts": "all"|"idle", "cooldown": <seconds, default 3>, "pinned": <true only for rules that keep the agent alive>}
- "interrupts": "all" = rule fires even while the agent is busy (reflexes: fleeing, eating when dying). "idle" = only fires when the agent has nothing to do (opportunistic: collecting, exploring).
- "pinned": true lifts a rule above every unpinned rule, including ones from higher-priority layers, so a job the agent is given cannot crowd out the reflex that keeps it alive. Pin ONLY rules that prevent death (fleeing a losing fight, eating before starving, surfacing when drowning, avoiding a mob that killed it). Never pin gathering, building, exploring or anything else that is merely useful: pinning everything ranks nothing.
- Use "prompt_self" only for situations no other action can express.
- A rule must react to something in the world. "when the agent is idle" and "when nothing bad is nearby" are its resting state, so a rule gated only on those fires forever: if it just wanders (move_away) or re-prompts (prompt_self), the agent walks in circles and every real action it starts is interrupted. Vague instructions like "move freely when safe" or "keep a low profile" are not rules -- either drop them or express them as a mode toggle.
- Do NOT write a rule that answers "a mob is nearby" with only flee/move_away. That is the cowardice mode -- set {"cowardice": true} in "modes". A rule that retreats on proximity re-triggers from wherever it lands and loops forever.
- Policies are STANDING behavior only (reflexes, safety, recurring habits). Recurring, condition-gated routines ("at night do X", "keep food stocked") ARE standing behavior; one-off tasks (e.g. "build Y", "go do Z once") are not — those are handled by the separate goal system and would go stale here. If the instructions mix standing behavior with a one-off task, compile only the standing behavior.
- Waiting something out ("stay until morning", "hide until safe") is the "stay" action with an "until" condition, not prompt_self. A rule gated on is_night whose only action is goto is wrong: arriving does not end the night, so it re-paths every cooldown until morning. Follow the goto with a stay.
- Storing items in a chest is goto the chest position followed by deposit — goto alone walks there and does nothing.
- Negation wraps a condition, it is not a condition itself: {"not": {"cond": "is_night"}} is correct, {"cond": "not", ...} is not valid and will be rejected. Same for {"all": [...]} and {"any": [...]}.
- Resources are often not right next to the agent. A bare collect only reaches 64 blocks, so on empty terrain it harvests nothing every time it fires and the agent looks frozen. Block searches cannot reach past 64 blocks, so a gathering rule for something that is not in this biome will simply collect nothing every time it fires. Gate gathering rules on block_nearby or animal_nearby so they only run when the resource is actually there, and prefer resources you can see over ones you hope exist.
- "underwater" or "drowning" is the "drowning" condition paired with the "go_to_surface" action. Do not use block_nearby water for this: it is also true when standing safely on the shore, so the rule fires over and over.
- "consume" only works on food the player can actually eat (bread, cooked_beef, cooked_porkchop, cooked_chicken, apple, carrot, potato, sweet_berries). Raw materials like wheat, seeds or grass are not edible — do not list them.

Respond ONLY with a JSON object: {"modes": {...}, "rules": [...]}. No explanation, no markdown fences.

User instructions: $INSTRUCTIONS`;

export async function compilePolicy(agent, instructions, activeGoal = null) {
    let prompt = COMPILE_PROMPT
        .replace('$REGISTRY', registryDocs())
        .replace('$INSTRUCTIONS', instructions);
    if (activeGoal)
        prompt += `\n\nThe agent also has this active goal, currently driven by an expensive LLM loop: "${activeGoal}". If your rules fully express the goal as standing behavior, add "covers_goal": true to the JSON so the loop can be stopped; if the goal needs ongoing reasoning the rules cannot provide, add "covers_goal": false.`;
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        await agent.prompter.checkCooldown();
        const req = lastErr ? prompt + `\n\nYour previous attempt was invalid: ${lastErr}\nFix it and respond with only the corrected JSON.` : prompt;
        let res = await agent.prompter.chat_model.sendRequest([], req);
        try {
            const cleaned = res.replace(/```json|```/g, '').trim();
            const policy = JSON.parse(cleaned.substring(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1));
            const err = validatePolicy(policy);
            if (!err) return policy;
            lastErr = err;
        } catch (e) {
            lastErr = 'Response was not valid JSON: ' + e.message;
        }
        console.warn('Policy compile attempt failed:', lastErr);
    }
    throw new Error('Could not compile instructions into a valid policy: ' + lastErr);
}

export function describePolicy(policy) {
    let res = '';
    if (policy.modes && Object.keys(policy.modes).length > 0)
        res += 'Mode overrides: ' + Object.entries(policy.modes).map(([m, on]) => `${m}=${on ? 'on' : 'off'}`).join(', ') + '\n';
    for (let rule of policy.rules)
        res += `- ${rule.name} (${rule.interrupts ?? 'all'}${rule.pinned ? ', pinned' : ''}): ${rule.description ?? JSON.stringify(rule.when)}\n`;
    return res.trim();
}
