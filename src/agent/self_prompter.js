// How long stopLoop waits for the loop to notice the interrupt before giving up
// and releasing the flag anyway, and how long one self-prompt turn may take
// before the loop stops waiting on it. Both exist so a single stuck turn cannot
// leave the agent with no goal driver for the rest of the process's life.
const STOP_WAIT_MS = 30 * 1000;
const TURN_TIMEOUT_MS = 5 * 60 * 1000;
const TURN_ABANDONED = Symbol('turn abandoned');

const STOPPED = 0
const ACTIVE = 1
const PAUSED = 2
export class SelfPrompter {
    constructor(agent) {
        this.agent = agent;
        this.state = STOPPED;
        this.loop_active = false;
        this.interrupt = false;
        this.discard_pending = true;
        this.prompt = '';
        // The policy's goal is what the agent is FOR; a !goal is a detour off it.
        // Without somewhere to return to, !endGoal leaves the agent with nothing
        // driving it, so the model never calls it -- it invents more work instead
        // and a finished goal like "get a wooden pickaxe" runs forever.
        this.standing_prompt = '';
        this.idle_time = 0;
        this.cooldown = 2000;
    }

    async start(prompt, standing=false) {
        console.log('Self-prompting started.');
        if (!prompt) {
            if (!this.prompt)
                return 'No prompt specified. Ignoring request.';
            prompt = this.prompt;
        }
        if (standing) this.standing_prompt = prompt;
        this.state = ACTIVE;
        this.prompt = prompt;
        // Interrupt any long-running action (e.g. !stay) so a parked loop
        // iteration returns and the loop re-prompts with the new goal.
        // Without this, setting a new goal mid-action is silently ignored.
        await this.agent.actions.stop();
        this.startLoop();
    }

    isActive() {
        return this.state === ACTIVE;
    }

    isStopped() {
        return this.state === STOPPED;
    }

    isPaused() {
        return this.state === PAUSED;
    }

    async handleLoad(prompt, state) {
        if (state == undefined)
            state = STOPPED;
        this.state = state;
        this.prompt = prompt;
        if (state !== STOPPED && !prompt)
            throw new Error('No prompt loaded when self-prompting is active');
        if (state === ACTIVE) {
            await this.start(prompt);
        }
    }

    setPromptPaused(prompt) {
        this.prompt = prompt;
        this.state = PAUSED;
    }

    async startLoop() {
        if (this.loop_active) {
            console.warn('Self-prompt loop is already active. Ignoring request.');
            return;
        }
        console.log('starting self-prompt loop')
        this.loop_active = true;
        let no_command_count = 0;
        const MAX_NO_COMMAND = 3;
        while (!this.interrupt) {
            const done = this.standing_prompt && this.standing_prompt !== this.prompt
                ? ` If you have already accomplished it, use !endGoal -- you will go back to your standing goal, not stop working.`
                : ` If you have already accomplished it, use !endGoal rather than inventing more work.`;
            const msg = `You are self-prompting with the goal: '${this.prompt}'.${done} Your next response MUST contain a command with this syntax: !commandName. Respond:`;
            
            // One turn must not be able to end the loop permanently. Whatever
            // it is waiting on, the goal loop is the only thing that makes the
            // agent do anything of its own, so it gets to carry on without it.
            // The abandoned turn keeps running; it just stops being load-bearing.
            // The timer is cleared when the turn wins the race, and unref'd so
            // it can never be the reason the process stays alive. Leaving it
            // running leaked one live 5-minute timer per turn -- enough to keep
            // a finished agent (and every test that drives this loop) from ever
            // exiting.
            let timer;
            let used_command = await Promise.race([
                this.agent.handleMessage('system', msg, -1),
                new Promise(r => { timer = setTimeout(() => r(TURN_ABANDONED), TURN_TIMEOUT_MS); timer.unref?.(); }),
            ]).finally(() => clearTimeout(timer));
            if (used_command === TURN_ABANDONED) {
                console.warn(`self-prompt turn exceeded ${TURN_TIMEOUT_MS / 1000}s; carrying on without it.`);
                used_command = true; // not the model's failure to use a command
            }
            if (!used_command) {
                no_command_count++;
                if (no_command_count >= MAX_NO_COMMAND) {
                    let out = `Agent did not use command in the last ${MAX_NO_COMMAND} auto-prompts. Stopping auto-prompting.`;
                    this.agent.openChat(out);
                    console.warn(out);
                    this.state = STOPPED;
                    break;
                }
            }
            else {
                no_command_count = 0;
                await new Promise(r => setTimeout(r, this.cooldown));
            }
        }
        console.log('self prompt loop stopped')
        this.loop_active = false;
        this.interrupt = false;
    }

    update(delta) {
        // automatically restarts loop
        if (this.state === ACTIVE && !this.loop_active && !this.interrupt) {
            if (this.agent.isIdle())
                this.idle_time += delta;
            else
                this.idle_time = 0;

            if (this.idle_time >= this.cooldown) {
                console.log('Restarting self-prompting...');
                this.startLoop();
                this.idle_time = 0;
            }
        }
        else {
            this.idle_time = 0;
        }
    }

    // discard_pending: also throw away a command the model has already decided
    // on but not yet run. True for anything urgent (a user taking over, a safety
    // mode preempting), false for routine housekeeping that merely wants the
    // loop to stop issuing NEW prompts while it runs. Getting this wrong is
    // expensive: every mode used to discard, so an idle-only rule firing on its
    // 10s cooldown while the model was mid-API-call ate the command every time.
    // Andy emitted !searchForBlock("pumpkin", 128) for hours and never once ran it.
    async stopLoop(discard_pending=true) {
        // you can call this without await if you don't need to wait for it to finish
        if (this.interrupt) {
            // A stop is already in flight. Returning here told the caller the
            // loop was stopped when it was still running, and an emergency that
            // believes that goes on to have its action dropped -- the action
            // manager still belongs to the loop. Andy drowned twice on exactly
            // this, at 17:56 six seconds after "did not stop in time" and again
            // at 02:13 nine seconds after it, both times with no surface attempt
            // at all, in windows where the reflex fired fourteen times and
            // surfaced fourteen times for everyone else.
            //
            // So wait for the stop that is already happening, on the same
            // bounded terms, and only then answer.
            const shared = Date.now() + STOP_WAIT_MS;
            while (this.loop_active && Date.now() < shared)
                await new Promise(r => setTimeout(r, 100));
            return;
        }
        console.log('stopping self-prompt loop')
        this.discard_pending = discard_pending;
        this.interrupt = true;
        // Bounded. This used to wait for loop_active forever, and the loop can
        // sit inside a single handleMessage for a long time -- so when that
        // happened, interrupt was never restored to false, and update()'s
        // auto-restart (which requires !interrupt) could never fire again for
        // the life of the process. Andy sat on one block for over an hour with
        // only reflex rules still running: the goal loop was not stopped, it
        // was unrecoverable. Clearing the flag on timeout is the right giving
        // up: the loop re-reads it each iteration, so it simply carries on.
        const deadline = Date.now() + STOP_WAIT_MS;
        while (this.loop_active) {
            if (Date.now() > deadline) {
                console.warn('self-prompt loop did not stop in time; releasing the interrupt so it can recover.');
                break;
            }
            await new Promise(r => setTimeout(r, 500));
        }
        this.interrupt = false;
        this.discard_pending = true;
    }

    // The goal is done. Fall back to the standing goal if there is one to return to.
    async finish() {
        const standing = this.standing_prompt;
        if (!standing || standing === this.prompt) {
            await this.stop();
            return 'Self-prompting stopped.';
        }
        await this.stop();
        await this.start(standing, true);
        return `Goal accomplished. Back to your standing goal: '${standing}'.`;
    }

    async stop(stop_action=true) {
        this.interrupt = true;
        if (stop_action)
            await this.agent.actions.stop();
        this.stopLoop();
        this.state = STOPPED;
    }

    async pause() {
        this.interrupt = true;
        await this.agent.actions.stop();
        this.stopLoop();
        this.state = PAUSED;
    }

    shouldInterrupt(is_self_prompt) { // to be called from handleMessage
        return is_self_prompt && (this.state === ACTIVE || this.state === PAUSED) && this.interrupt && this.discard_pending;
    }

    handleUserPromptedCmd(is_self_prompt, is_action) {
        // if a user messages and the bot responds with an action, stop the self-prompt loop
        if (!is_self_prompt && is_action) {
            this.stopLoop();
            // this stops it from responding from the handlemessage loop and the self-prompt loop at the same time
        }
    }
}