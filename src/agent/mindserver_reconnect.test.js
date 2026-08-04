import { strict as assert } from 'node:assert';
import test from 'node:test';

// A blip on the localhost socket used to kill the whole agent process. It must
// now survive as long as socket.io gets back within the grace period.
// Mirrors the handlers in mindserver_proxy.js connect().

function makeProxy() {
    const handlers = {};
    const emitted = [];
    const proxy = {
        connected: true,
        agent: { name: 'Andy', login_time: 1, killed: null,
                 cleanKill(msg) { this.killed = msg; } },
        socket: {
            on: (ev, fn) => { (handlers[ev] ??= []).push(fn); },
            emit: (...a) => emitted.push(a),
            connect: () => fire('connect'),
        },
    };
    const fire = (ev, ...args) => (handlers[ev] ?? []).forEach(fn => fn(...args));

    proxy.socket.on('disconnect', (reason) => {
        proxy.connected = false;
        if (reason === 'io server disconnect') proxy.socket.connect();
        clearTimeout(proxy.reconnect_timer);
        proxy.reconnect_timer = setTimeout(() => {
            if (!proxy.connected && proxy.agent) {
                proxy.agent.cleanKill('Could not reconnect to MindServer. Killing agent process.');
            }
        }, 30);
    });
    proxy.socket.on('connect', () => {
        clearTimeout(proxy.reconnect_timer);
        if (proxy.connected) return;
        proxy.connected = true;
        proxy.socket.emit('connect-agent-process', 'Andy');
        if (proxy.agent?.login_time) proxy.socket.emit('login-agent', 'Andy');
    });

    return { proxy, fire, emitted };
}

const wait = ms => new Promise(r => setTimeout(r, ms));

test('reconnecting in time keeps the agent alive and re-registers it', async () => {
    const { proxy, fire, emitted } = makeProxy();
    fire('disconnect', 'transport close');
    await wait(10);
    fire('connect');
    await wait(40);

    assert.equal(proxy.agent.killed, null, 'agent was killed despite reconnecting');
    assert.equal(proxy.connected, true);
    assert.deepEqual(emitted, [['connect-agent-process', 'Andy'], ['login-agent', 'Andy']]);
});

test('staying down past the grace period still kills the agent', async () => {
    const { proxy, fire } = makeProxy();
    fire('disconnect', 'transport close');
    await wait(50);

    assert.match(proxy.agent.killed ?? '', /Could not reconnect/);
});

test('a server-initiated disconnect reconnects explicitly', async () => {
    const { proxy, fire } = makeProxy();
    fire('disconnect', 'io server disconnect');
    await wait(40);

    assert.equal(proxy.agent.killed, null);
    assert.equal(proxy.connected, true);
});

test('a bot that never entered the world does not claim to be logged in', async () => {
    const { proxy, fire, emitted } = makeProxy();
    proxy.agent.login_time = null;
    fire('disconnect', 'transport close');
    await wait(10);
    fire('connect');
    await wait(40);

    assert.deepEqual(emitted, [['connect-agent-process', 'Andy']]);
});
