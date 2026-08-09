#!/usr/bin/env node
// Talk to the live mindserver over socket.io instead of grepping docker logs.
// Instant, structured, and can inject !commands that bypass the LLM entirely.
//
// Usage (normally called via tools/live_test.sh, which supplies the token):
//   node tools/drive.js say "<message>" [waitSecs]   chat to the agent, stream its output
//   node tools/drive.js listen [pattern] [secs]      stream bot-output; exit 0 on regex match
//   node tools/drive.js restart|stop|start           agent process control
//   node tools/drive.js policy                       dump the agent's composed policy state
//   node tools/drive.js regen <base> [attrs...]      regenerate active layer from profiles
//
// Env: MINDSERVER_URL (default http://docker.lan:8080), MINDSERVER_TOKEN,
//      AGENT (default Andy), FROM (default clarkhackworth)

import { io } from 'socket.io-client';

const URL = process.env.MINDSERVER_URL || 'http://docker.lan:8080';
const AGENT = process.env.AGENT || 'Andy';
// NOT the bot's own MC account name (clarkhackworth) -- the agent treats that
// sender as itself and stays silent. 'ADMIN' is what the web UI sends as.
const FROM = process.env.FROM || 'ADMIN';

const [cmd, ...rest] = process.argv.slice(2);

function die(msg, code = 1) { console.error(msg); process.exit(code); }
if (!cmd) die('usage: drive.js say|listen|restart|stop|start ...');

const socket = io(URL, { auth: { token: process.env.MINDSERVER_TOKEN || null } });
socket.on('connect_error', e => die(`cannot connect to ${URL}: ${e.message}`));

function listen(pattern, secs) {
    const re = pattern ? new RegExp(pattern) : null;
    socket.emit('listen-to-agents');
    socket.on('bot-output', (name, msg) => {
        console.log(`[${name}] ${msg}`);
        if (re && re.test(msg)) { console.log(`FOUND: ${pattern}`); process.exit(0); }
    });
    // A missed pattern is a failed scenario, not a pass.
    setTimeout(() => re ? die(`NOT SEEN in ${secs}s: ${pattern}`) : process.exit(0), secs * 1000);
}

socket.on('connect', () => {
    switch (cmd) {
        case 'say': {
            const [message, wait = '75'] = rest; // LLM replies take 30s+; !commands are instant
            if (!message) die('usage: drive.js say "<message>" [waitSecs]');
            socket.emit('send-message', AGENT, { from: FROM, message });
            console.log(`sent to ${AGENT}: ${message}`);
            listen(null, Number(wait));
            break;
        }
        case 'listen': {
            const [pattern, secs = '90'] = rest;
            listen(pattern || null, Number(secs));
            break;
        }
        case 'policy':
            socket.emit('get-policy', AGENT, res => {
                console.log(JSON.stringify(res, null, 2));
                process.exit(res ? 0 : 1);
            });
            break;
        case 'regen': {
            // Regenerate the active layer from the profile library. With
            // attributes this is one LLM merge on the agent's side, so be
            // patient rather than time out under it.
            const [base, ...attributes] = rest;
            if (!base) die('usage: drive.js regen <base> [attributes...]');
            console.log(`regenerating ${AGENT} from base "${base}"${attributes.length ? ` + ${attributes.join(', ')}` : ''}...`);
            socket.emit('generate-policy', AGENT, { base, attributes }, res => {
                if (!res?.success) die(`regen failed: ${res?.error ?? 'no reply from agent'}`);
                console.log('regen OK');
                process.exit(0);
            });
            break;
        }
        case 'lock': case 'unlock':
            // Gates only the agent's SELF-issued !policy writes; UI and regen
            // paths ignore it. Held around a regen so the bot cannot bump the
            // policy revision mid-merge and get the merge discarded.
            socket.emit('set-policy-lock', AGENT, cmd === 'lock', res => {
                if (!res?.success) die(`${cmd} failed: ${res?.error ?? 'no reply'}`);
                console.log(`policy ${cmd}ed`);
                process.exit(0);
            });
            break;
        case 'clearlayer': {
            // Delete one policy layer (usually "self": the agent's own
            // accumulated rules, which can grow stale and fight the active
            // layer). set-policy leaves unmentioned layers alone, so sending
            // {layer: null} is the explicit way to clear one.
            const [layer] = rest;
            if (!layer) die('usage: drive.js clearlayer <self|active>');
            socket.emit('set-policy', AGENT, { layers: { [layer]: null } }, res => {
                if (!res?.success) die(`clearlayer failed: ${res?.error ?? 'no reply'}`);
                console.log(`layer "${layer}" cleared`);
                process.exit(0);
            });
            break;
        }
        case 'restart': case 'stop': case 'start':
            socket.emit(`${cmd}-agent`, AGENT);
            console.log(`${cmd} sent to ${AGENT}`);
            setTimeout(() => process.exit(0), 500);
            break;
        default:
            die(`unknown command: ${cmd}`);
    }
});
