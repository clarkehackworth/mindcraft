#!/usr/bin/env node
// Talk to the live mindserver over socket.io instead of grepping docker logs.
// Instant, structured, and can inject !commands that bypass the LLM entirely.
//
// Usage (normally called via tools/live_test.sh, which supplies the token):
//   node tools/drive.js say "<message>" [waitSecs]   chat to the agent, stream its output
//   node tools/drive.js listen [pattern] [secs]      stream bot-output; exit 0 on regex match
//   node tools/drive.js restart|stop|start           agent process control
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
        case 'restart': case 'stop': case 'start':
            socket.emit(`${cmd}-agent`, AGENT);
            console.log(`${cmd} sent to ${AGENT}`);
            setTimeout(() => process.exit(0), 500);
            break;
        default:
            die(`unknown command: ${cmd}`);
    }
});
