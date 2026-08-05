import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { logoutAgent } from '../mindcraft/mindserver.js';

const init_agent_path = fileURLToPath(new URL('./init_agent.js', import.meta.url));

const MAX_BACKOFF_MS = 5 * 60 * 1000;
// How far back "is it crash-looping?" looks, and how many restarts inside that
// window are free before the backoff engages. Long enough to catch the slow
// cycles the old too-quick-exit test missed entirely.
const CRASH_WINDOW_MS = 30 * 60 * 1000;
const CRASH_FREE_RESTARTS = 3;

// Transient exits (EX_TEMPFAIL) are a different animal: a dropped socket or a
// Mojang auth blip that the very next attempt recovers from. They get a longer
// free run and a much lower ceiling, because escalating to 5-minute waits
// against a server that accepts every connection first try is the failure, not
// the fix. They are still counted -- a link flapping non-stop is a real problem
// -- just gently.
const TEMPFAIL_FREE_RESTARTS = 8;
const MAX_TEMPFAIL_BACKOFF_MS = 60 * 1000;

// How long to wait before restart number `exits.length`. 0 means "right now".
// Exported for the test; there is no other reason to pull it out of the handler.
export function restartDelay(exits, transient = false) {
    const free = transient ? TEMPFAIL_FREE_RESTARTS : CRASH_FREE_RESTARTS;
    const cap = transient ? MAX_TEMPFAIL_BACKOFF_MS : MAX_BACKOFF_MS;
    if (exits.length <= free) return 0;
    return Math.min(5000 * 2 ** (exits.length - free - 1), cap);
}

export function recentExits(exits, now) {
    return exits.filter(t => now - t < CRASH_WINDOW_MS);
}

export class AgentProcess {
    constructor(name, port) {
        this.name = name;
        this.port = port;
        this.exits = [];      // crash restart timestamps inside CRASH_WINDOW_MS
        this.tempfails = []; // transient (EX_TEMPFAIL) restarts, tracked separately
        this.restarts = 0;    // lifetime count, for the [respawn] log line
    }

    start(load_memory=false, init_message=null, count_id=0) {
        this.count_id = count_id;
        this.running = true;

        let args = [init_agent_path, this.name];
        args.push('-n', this.name);
        args.push('-c', count_id);
        if (load_memory)
            args.push('-l', load_memory);
        if (init_message)
            args.push('-m', init_message);
        args.push('-p', this.port);

        const agentProcess = spawn(process.execPath, args, {
            stdio: 'inherit',
            stderr: 'inherit',
        });

        const start_time = Date.now();
        agentProcess.on('exit', (code, signal) => {
            console.log(`Agent process exited with code ${code} and signal ${signal}`);
            this.running = false;
            logoutAgent(this.name);

            // sysexits EX_TEMPFAIL. Something transient upstream (Mojang's auth
            // API is the repeat offender, 45 of 194 crashes in one log) stopped
            // the agent from connecting. Retry soon and do not count it toward
            // the crash backoff -- that would turn a 5-second outage into
            // 5-minute waits. Checked before the task-exit codes below, which it
            // would otherwise be mistaken for. Keep in sync with agent.js.
            if (code === 75) {
                const now = Date.now();
                this.tempfails = recentExits(this.tempfails ?? [], now);
                this.tempfails.push(now);
                const delay = restartDelay(this.tempfails, true);
                console.log(`[respawn] agent ${this.name} transient failure ` +
                    `(${this.tempfails.length} in the last ${CRASH_WINDOW_MS / 60000}m), retrying in ${Math.round(delay / 1000) || 1}s`);
                setTimeout(() => this.start(true, 'Agent process restarted.', count_id), delay || 1000);
                return;
            }

            if (code > 1) {
                console.log(`Ending task`);
                process.exit(code);
            }

            if (code !== 0 && signal !== 'SIGINT') {
                // Backoff used to key off "exited within 10s", and any slower
                // exit reset the counter to zero. A 4-minute crash cycle
                // therefore never reached the backoff branch at all: 222 deaths
                // in one session, restarted at full speed every time. What
                // matters is how often it is dying, not how fast any single
                // death was, so count exits in a rolling window instead.
                const now = Date.now();
                this.exits = recentExits(this.exits ?? [], now);
                this.exits.push(now);
                this.restarts = (this.restarts ?? 0) + 1;
                // A greppable running count. 222 respawns left no signal outside
                // the log that anything was wrong.
                console.log(`[respawn] agent ${this.name} respawn #${this.restarts} ` +
                    `(${this.exits.length} in the last ${CRASH_WINDOW_MS / 60000}m, up ${Math.round((now - start_time) / 1000)}s)`);

                const delay = restartDelay(this.exits);
                if (delay > 0) {
                    console.error(`Agent ${this.name} is crash-looping. Retrying in ${Math.round(delay / 1000)}s...`);
                    setTimeout(() => this.start(true, 'Agent process restarted.', count_id), delay);
                    return;
                }
                console.log('Restarting agent...');
                this.start(true, 'Agent process restarted.', count_id);
            }
        });
    
        agentProcess.on('error', (err) => {
            console.error('Agent process error:', err);
        });

        this.process = agentProcess;
    }

    stop() {
        if (!this.running) return;
        this.process.kill('SIGINT');
    }

    forceRestart() {
        if (this.running && this.process && !this.process.killed) {
            console.log(`Agent process for ${this.name} is still running. Attempting to force restart.`);
            
            const restartTimeout = setTimeout(() => {
                console.warn(`Agent ${this.name} did not stop in time. It might be stuck.`);
            }, 5000); // 5 seconds to exit

            this.process.once('exit', () => {
                 clearTimeout(restartTimeout);
                 console.log(`Stopped hanging agent ${this.name}. Now restarting.`);
                 this.start(true, 'Agent process restarted.', this.count_id);
            });
            this.stop(); // sends SIGINT
        } else {
             this.start(true, 'Agent process restarted.', this.count_id);
        }
    }
}