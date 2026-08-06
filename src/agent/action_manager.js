// How long an action gets to notice the interrupt before it is abandoned.
const STOP_GRACE_MS = 10000;

// How long a nearly-finished action may keep running before a NON-urgent
// interrupter takes the slot, and how far along it has to be to earn that.
//
// Cancelling a 16-log collect at block 14 threw away the whole trip: the drops
// are only banked as they are picked up, the agent read "Collected 0" and
// concluded the trees were unreachable, and the thing that cancelled it was
// usually the model starting some new idea rather than anything dangerous.
//
// Three seconds, and only past three-quarters done, so this can never hold up a
// reflex: urgency is decided by the interrupter, not by this, and everything
// that keeps the agent alive declares itself urgent (see runAction).
const FINISH_GRACE_MS = 3000;
const FINISH_GRACE_FRACTION = 0.75;

export class ActionManager {
    constructor(agent) {
        this.agent = agent;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = false;
        this.resume_func = null;
        this.resume_name = '';
        this.last_action_time = 0;
        this.recent_action_counter = 0;
        this.last_action_label = null;
        // Bumped for every action. An action that was interrupted and later
        // returns anyway sees a newer generation and skips its own cleanup,
        // so it cannot clobber the state of whatever replaced it.
        this.generation = 0;
    }

    // {done, total} for the running action, when it bothers to say. It lives on
    // the bot because that is the only object a skill is handed -- see
    // reportProgress in skills.js. An action that never reports is simply never
    // nearly-finished, which is the safe answer.
    _nearlyFinished() {
        const p = this.agent?.bot?.action_progress;
        return !!p && p.total > 0 && p.done / p.total >= FINISH_GRACE_FRACTION;
    }

    async resumeAction(actionFn, timeout) {
        return this._executeResume(actionFn, timeout);
    }

    // urgent: may this interrupt a nearly-finished action immediately? Defaults
    // to true, so a caller that has not thought about it behaves exactly as
    // before -- the grace is opt-in, and nothing that keeps the agent alive has
    // to remember to opt out of it.
    async runAction(actionLabel, actionFn, { timeout, resume = false, urgent = true } = {}) {
        if (resume) {
            return this._executeResume(actionLabel, actionFn, timeout);
        } else {
            return this._executeAction(actionLabel, actionFn, timeout, urgent);
        }
    }

    async stop(urgent = true) {
        if (!this.executing) return;
        // Let an action that is about to finish actually finish, when whatever
        // wants the slot is not an emergency. Nothing is interrupted during this
        // window -- requestInterrupt is not called -- so the action either lands
        // or the window closes and the normal cooperative stop below proceeds.
        if (!urgent) {
            const finish_by = Date.now() + FINISH_GRACE_MS;
            while (this.executing && this._nearlyFinished() && Date.now() < finish_by)
                await new Promise(resolve => setTimeout(resolve, 100));
            if (!this.executing) return;
        }
        // ponytail: cooperative interrupt only. Generated code runs in this
        // process, so there is no way to actually cancel it -- we set
        // interrupt_code, stop pathfinder/digging/pvp, and hope the action
        // checks the flag. It may never. This used to kill the whole process
        // when it didn't, which turned "a mob hit us mid-path" into a full
        // relaunch. Now we wait a bounded grace period and abandon it instead;
        // the generation counter keeps an abandoned action from corrupting the
        // one that replaces it. Ceiling: an abandoned action is still running
        // and can still touch the bot. Move insecure code to a worker thread
        // if one is ever seen doing damage after being abandoned.
        const deadline = Date.now() + STOP_GRACE_MS;
        while (this.executing && Date.now() < deadline) {
            this.agent.requestInterrupt();
            console.log('waiting for code to finish executing...');
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        if (this.executing) {
            console.warn(`action "${this.currentActionLabel}" ignored the interrupt for ${STOP_GRACE_MS / 1000}s, abandoning it`);
            this.executing = false;
        }
    }

    cancelResume() {
        this.resume_func = null;
        this.resume_name = null;
    }

    async _executeResume(actionLabel = null, actionFn = null, timeout = 10) {
        const new_resume = actionFn != null;
        if (new_resume) { // start new resume
            this.resume_func = actionFn;
            assert(actionLabel != null, 'actionLabel is required for new resume');
            this.resume_name = actionLabel;
        }
        // executing, not isIdle(): resuming is about the action slot being free.
        // isIdle() is also false while the LLM is generating, and a resume that
        // waits for that is a resume that never happens -- nothing retries it.
        if (this.resume_func != null && (!this.executing || new_resume) && (!this.agent.self_prompter.isActive() || new_resume)) {
            this.currentActionLabel = this.resume_name;
            let res = await this._executeAction(this.resume_name, this.resume_func, timeout);
            this.currentActionLabel = '';
            return res;
        } else {
            return { success: false, message: null, interrupted: false, timedout: false };
        }
    }

    async _executeAction(actionLabel, actionFn, timeout = 10, urgent = true) {
        let TIMEOUT;
        let gen; // set once this action owns the manager; the catch needs it too
        try {
            if (this.last_action_time > 0) {
                let time_diff = Date.now() - this.last_action_time;
                // A loop is the SAME action repeating, not different actions
                // happening quickly. Counting any two fast actions together
                // meant a burst of distinct cheap rules -- set_mode, equip,
                // consume, each finishing in well under 20ms -- read as a
                // runaway loop and shut the agent down: four kills in twenty
                // minutes, none of them an actual loop. Comparing the label
                // keeps the guard aimed at what it was written for, a resume
                // re-triggering itself forever.
                if (time_diff < 20 && actionLabel === this.last_action_label) {
                    this.recent_action_counter++;
                }
                else {
                    this.recent_action_counter = 0;
                }
                this.last_action_label = actionLabel;
                if (this.recent_action_counter > 3) {
                    console.warn('Fast action loop detected, cancelling resume.');
                    this.cancelResume(); // likely cause of repetition
                }
                if (this.recent_action_counter > 5) {
                    console.error('Infinite action loop detected, shutting down.');
                    this.agent.cleanKill('Infinite action loop detected, shutting down.');
                    return { success: false, message: 'Infinite action loop detected, shutting down.', interrupted: false, timedout: false };
                }
            }
            this.last_action_time = Date.now();
            console.log('executing code...\n');

            // await current action to finish (executing=false), with 10 seconds timeout
            // also tell agent.bot to stop various actions
            if (this.executing) {
                console.log(`action "${actionLabel}" trying to interrupt current action "${this.currentActionLabel}"`
                    + (!urgent && this._nearlyFinished() ? ' (letting it finish first)' : ''));
            }
            await this.stop(urgent);
            // Whatever the previous action reported is meaningless now, and a
            // stale value would make the NEXT interrupter think this action was
            // nearly done before it had started.
            if (this.agent?.bot) this.agent.bot.action_progress = null;

            // clear bot logs and reset interrupt code
            this.agent.clearBotLogs();

            gen = ++this.generation;
            this.executing = true;
            this.timedout = false;
            this.currentActionLabel = actionLabel;
            this.currentActionFn = actionFn;
            this.start_pos = this.agent.bot.entity?.position?.clone?.() ?? null;

            // timeout in minutes
            if (timeout > 0) {
                TIMEOUT = this._startTimeout(timeout, gen);
            }

            // start the action
            await actionFn();

            // An abandoned action landing here would otherwise clear the
            // executing flag and bot logs belonging to its replacement.
            if (gen !== this.generation) {
                clearTimeout(TIMEOUT);
                return { success: false, message: '', interrupted: true, timedout: false };
            }

            // mark action as finished + cleanup
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            clearTimeout(TIMEOUT);

            // get bot activity summary
            let output = this.getBotOutputSummary();
            let interrupted = this.agent.bot.interrupt_code;
            let timedout = this.timedout;
            this.agent.clearBotLogs();

            // if not interrupted and not generating, emit idle event
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }

            // return action status report
            return { success: true, message: output, interrupted, timedout };
        } catch (err) {
            console.error("Code execution triggered catch:", err);
            // Log the full stack trace
            console.error(err.stack);
            // An abandoned action throwing late must not tear down its
            // replacement -- report the failure, touch nothing else.
            if (gen !== undefined && gen !== this.generation) {
                clearTimeout(TIMEOUT);
                return { success: false, message: '', interrupted: true, timedout: false };
            }
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            clearTimeout(TIMEOUT);
            this.cancelResume();
            await this.stop();
            // Read the stack BEFORE flattening to a string: this was
            // err.toString() first and err.stack second, so every stack trace
            // ever logged said "undefined".
            const stack = err?.stack ?? '(no stack)';
            // PathStopped is not a failure, it is the pathfinder acknowledging
            // that something interrupted it -- usually us, via a mode that
            // interrupts all. Reporting it as a thrown exception put 25 "!!Code
            // threw exception!!" blocks in half an hour of logs and buried the
            // errors that mattered.
            const stopped = err?.name === 'PathStopped';
            err = err.toString();

            let message = this.getBotOutputSummary() + (stopped
                ? `Pathfinding stopped before reaching the goal: ${err}\n`
                : '!!Code threw exception!!\n' +
                  'Error: ' + err + '\n' +
                  'Stack trace:\n' + stack + '\n');

            let interrupted = this.agent.bot.interrupt_code;
            this.agent.clearBotLogs();
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }
            return { success: false, message, interrupted, timedout: false };
        }
    }

    getBotOutputSummary() {
        const { bot } = this.agent;
        // An interrupted action used to report nothing at all, which reached the
        // model as the literal string "undefined". It read that as the command
        // being broken rather than cut short: a sheep search cancelled by a
        // shelter rule looked identical to a sheep search that found nothing, so
        // it stopped searching and went mining. Hand back what did happen, and
        // say plainly that it is partial.
        const interrupted = bot.interrupt_code && !this.timedout;
        if (interrupted && !bot.output?.trim()) {
            return 'Action was interrupted before it could do anything. Nothing was ruled out -- ' +
                'deal with whatever interrupted you, then try again.';
        }
        // Generated code that never calls skills.log finishes with an empty
        // output, and "Action output:" followed by nothing reads to the model as
        // success. It announced "Great, I'm out" three times in a row without
        // having moved a block. Nothing observed the code, but the world can
        // still be described, so describe it and say plainly that it is not a
        // report of success.
        if (!bot.output?.trim()) {
            const p = bot.entity?.position;
            const moved = p && this.start_pos ? this.start_pos.distanceTo(p) : null;
            bot.output = '';
            return 'The code ran and reported nothing, so nothing here says it worked. Observed instead: ' +
                (p ? `you are at ${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}` : 'position unknown') +
                (moved === null ? '' : `, ${moved < 1 ? 'which is where you started' : `${moved.toFixed(0)} blocks from where you started`}`) +
                `, health ${bot.health?.toFixed(0) ?? '?'}, holding ${bot.heldItem?.name ?? 'nothing'}. ` +
                'Check whether the thing you meant to do actually happened before saying it did.';
        }
        let output = bot.output;
        const MAX_OUT = 500;
        if (output.length > MAX_OUT) {
            output = `Action output is very long (${output.length} chars) and has been shortened.\n
          First outputs:\n${output.substring(0, MAX_OUT / 2)}\n...skipping many lines.\nFinal outputs:\n ${output.substring(output.length - MAX_OUT / 2)}`;
        }
        else {
            output = 'Action output:\n' + output.toString();
        }
        if (interrupted)
            output = 'Action was interrupted and did not finish. What it managed before being cut short:\n' + output;
        bot.output = '';
        return output;
    }

    _startTimeout(TIMEOUT_MINS = 10, gen) {
        return setTimeout(async () => {
            // An abandoned action never clears its timeout, so without this the
            // stale timer fires later and stops whatever is running by then.
            if (gen !== undefined && gen !== this.generation) return;
            console.warn(`Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            this.timedout = true;
            this.agent.history.add('system', `Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            await this.stop(); // last attempt to stop
        }, TIMEOUT_MINS * 60 * 1000);
    }

}