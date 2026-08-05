// Run: node --test src/mindcraft/stale_socket.test.js
// The agent went on playing while the mindserver believed it was gone: the UI
// showed it offline and every relayed command answered "Agent not connected".
// It blocked a policy regeneration for half an hour with the bot alive and
// running rules the whole time, and the only trace was a lone
// "Agent Andy disconnected" with no matching agent exit.
//
// The proxy reconnects by NAME, so after a blip the server's connection holds
// socket B while socket A is still pending cleanup -- and A's disconnect
// handler nulled out B. Nothing ever restored it, because the client had
// already re-announced and would not do so again.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('./mindserver.js', import.meta.url), 'utf8');
const proxy = readFileSync(new URL('../agent/mindserver_proxy.js', import.meta.url), 'utf8');

// The server-side half, modelled: a connection rebound by name, then the old
// socket's disconnect arriving late.
function connection() {
    return { socket: null, in_game: false, login_time: null };
}
function onDisconnect(conn, socket) {
    // Mirrors the guarded handler.
    if (conn && conn.socket === socket) {
        conn.in_game = false;
        conn.login_time = null;
        conn.socket = null;
        return 'cleared';
    }
    return 'ignored';
}

test('a late disconnect from a replaced socket does not deregister the live one', () => {
    const conn = connection();
    const A = { id: 'A' }, B = { id: 'B' };

    conn.socket = A; conn.in_game = true;          // agent registers on A
    conn.socket = B;                                // blip: proxy re-announces on B

    assert.equal(onDisconnect(conn, A), 'ignored', 'A is stale, its cleanup is not B\'s business');
    assert.equal(conn.socket, B, 'the live socket survives');
    assert.equal(conn.in_game, true, 'and the agent is still in game');

    assert.equal(onDisconnect(conn, B), 'cleared', 'the real socket closing still deregisters');
    assert.equal(conn.socket, null);
});

test('the server guards on socket identity, not just on the name', () => {
    assert.match(server, /conn\.socket === socket/,
        'keying cleanup on curAgentName alone is what let a stale socket clobber a live one');
});

test('the proxy re-announces on every connect', () => {
    // The other half of the wedge: the client returned early when it still
    // believed it was connected, so a reconnect it had not registered as a
    // disconnect never re-announced -- and the registration was already gone.
    const body = proxy.slice(proxy.indexOf("this.socket.on('connect'"), proxy.indexOf("chat-message"));
    const announce = body.indexOf("emit('connect-agent-process'");
    const bail = body.indexOf('if (this.connected) return;');
    assert.ok(announce !== -1 && bail !== -1, 'both still present');
    assert.ok(announce < bail, 're-announce must happen before the early return, or it never happens at all');
});
