import { Server } from 'socket.io';
import express from 'express';
import http from 'http';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import * as mindcraft from './mindcraft.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mindserver is:
// - central hub for communication between all agent processes
// - api to control from other languages and remote users
// - host for webapp

let io;
let server;
const agent_connections = {};
const agent_listeners = [];

const settings_spec = JSON.parse(readFileSync(path.join(__dirname, 'public/settings_spec.json'), 'utf8'));

// Settings changed via the UI live only in this in-memory AgentConnection
// unless saved here too, so a mindserver restart reverts everyone to
// settings.js. profile and task aren't included: profile is identity (comes
// from the profile file), and re-running a one-off task on every reboot
// would be wrong.
const PERSIST_EXCLUDE = new Set(['profile', 'task']);

function overridesPath(agentName) {
    return `./bots/${agentName}/settings.json`;
}

function saveSettingsOverrides(agentName, settings) {
    const overrides = {};
    for (const key in settings) {
        if (!PERSIST_EXCLUDE.has(key)) overrides[key] = settings[key];
    }
    mkdirSync(`./bots/${agentName}`, { recursive: true });
    writeFileSync(overridesPath(agentName), JSON.stringify(overrides, null, 2));
}

// The policy lock is owned by the agent (behavior/policy.js writes it), but the
// UI needs it before any agent is running, so it is read straight off disk here.
// Files written before the lock existed, or by an agent that never had one, just
// don't have the field.
function isPolicyLocked(agentName) {
    try {
        return !!JSON.parse(readFileSync(`./bots/${agentName}/policy.json`, 'utf8')).locked;
    } catch {
        return false;
    }
}

// Profiles are plain JSON in ./policies, shared by every bot. They are read and
// written here with fs rather than through behavior/policy.js, so the mindserver
// does not pull mineflayer into its module graph for three file operations.
const PROFILE_NAME = /^[\w-]+$/; // no path separators: these become filenames
function profilePath(name) {
    return PROFILE_NAME.test(name ?? '') ? `./policies/${name}.json` : null;
}
function readProfile(name) {
    const path = profilePath(name);
    if (!path || !existsSync(path)) return null;
    try {
        const data = JSON.parse(readFileSync(path, 'utf8'));
        if (typeof data.source === 'string') data.source = [data.source];
        // Attribute profiles are often prose only -- a few source lines the LLM
        // folds into the base -- so a profile is valid with either half.
        return (data?.policy || data?.source?.length) ? data : null;
    } catch {
        return null;
    }
}

export function loadSettingsOverrides(agentName) {
    if (!existsSync(overridesPath(agentName))) return null;
    try {
        return JSON.parse(readFileSync(overridesPath(agentName), 'utf8'));
    } catch (err) {
        console.warn(`Failed to read saved settings for ${agentName}:`, err);
        return null;
    }
}

class AgentConnection {
    constructor(settings, viewer_port) {
        this.socket = null;
        this.settings = settings;
        this.in_game = false;
        this.full_state = null;
        this.viewer_port = viewer_port;
        this.login_time = null; // set on login-agent, cleared on logout/disconnect
        this.alive_since = null; // last death, as reported by the agent (survives its restarts)
    }
    setSettings(settings) {
        // Merge, don't replace. The UI form only knows the keys in
        // settings_spec.json, so it posts back a subset; replacing wholesale
        // silently drops everything else. mod_data is one of the casualties,
        // and the next agent restart then reads a modded server with a vanilla
        // registry -- every block name wrong, snow reported as a trapdoor.
        this.settings = { ...this.settings, ...settings };
        saveSettingsOverrides(this.settings.profile.name, this.settings);
    }
}

export function registerAgent(settings, viewer_port) {
    let agentConnection = new AgentConnection(settings, viewer_port);
    agent_connections[settings.profile.name] = agentConnection;
}

export function logoutAgent(agentName) {
    if (agent_connections[agentName]) {
        agent_connections[agentName].in_game = false;
        agent_connections[agentName].login_time = null;
        agentsStatusUpdate();
    }
}

// Loopback addresses need no auth token, since only this machine can reach them.
function isLoopbackHost(host) {
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

// Initialize the server
// host may be a hostname/address string. `true`/`false` are still accepted for
// the old host_public boolean and mapped onto the equivalent address.
export function createMindServer(host = 'localhost', port = 8080, auth_token = null) {
    if (host === true) host = '0.0.0.0';
    else if (host === false) host = 'localhost';

    // Binding beyond loopback exposes full agent control -- creating agents,
    // sending messages, and with allow_insecure_coding, running code. Refuse
    // rather than quietly publish that.
    if (!isLoopbackHost(host) && !auth_token) {
        throw new Error(
            `mindserver_host is "${host}", which is reachable from other machines, ` +
            'but mindserver_auth_token is not set. The mindserver UI grants full ' +
            'control over every agent, so it must not be exposed without a token. ' +
            'Set mindserver_auth_token in settings.js, or set mindserver_host back ' +
            'to "localhost".'
        );
    }

    const app = express();
    server = http.createServer(app);
    io = new Server(server);

    // Authenticate socket connections. This is the whole control surface: agent
    // creation, messaging, shutdown and all state flow over it. The static UI
    // files stay public, as they are only client code and carry no data.
    if (auth_token) {
        io.use((socket, next) => {
            const provided = socket.handshake.auth?.token;
            if (provided === auth_token) return next();
            console.warn(`Rejected unauthenticated mindserver connection from ${socket.handshake.address}`);
            next(new Error('unauthorized'));
        });
    }

    // prismarine-viewer ships a prebuilt 1.2MB bundle that dumps a stack trace
    // for every entity it has no model for, which on a modded server is every
    // mob, every tick. Upstream already falls back to drawing a plain box, so
    // the only problem is the noise: log each unknown type once. Rewriting the
    // one call here beats a two-megabyte patch of a minified file.
    const ENTITY_LOG = 'catch(t){console.log(t)}';
    const ENTITY_LOG_ONCE = 'catch(t){const e=globalThis.__pvWarned||(globalThis.__pvWarned=new Set);' +
        'e.has(t.message)||(e.add(t.message),console.log("prismarine-viewer: "+t.message+", drawing a box instead"))}';
    const dedupeEntityLogging = (js) => {
        if (!js.includes(ENTITY_LOG)) {
            console.warn('prismarine-viewer bundle changed; entity log dedupe no longer applies');
            return js;
        }
        return js.replace(ENTITY_LOG, ENTITY_LOG_ONCE);
    };

    // Retries for about 15 seconds, which covers an agent restart, then stops
    // rather than reloading forever against a viewer that is never coming up.
    // The window restarts if the last attempt was long enough ago, so a later
    // outage gets its own budget instead of inheriting an exhausted one.
    const VIEWER_RETRY_PAGE = `<!doctype html><meta charset="utf-8"><title>Prismarine Viewer</title>
<body style="margin:0;background:#1e1e1e;color:#888;font:12px sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
<span id="m">waiting for the bot's view…</span><script>
const key = 'viewer-retry:' + location.pathname;
let state = {}; try { state = JSON.parse(sessionStorage.getItem(key) || '{}'); } catch (e) {}
const now = Date.now();
if (!state.at || now - state.at > 15000) state = { n: 0 };
if (state.n < 15) {
  sessionStorage.setItem(key, JSON.stringify({ n: state.n + 1, at: now }));
  setTimeout(() => location.reload(), 1000);
} else {
  document.getElementById('m').textContent = 'viewer unavailable';
}
</script>`;

    // Proxy each agent's prismarine-viewer, which listens on its own port in the
    // agent process, under /viewer/<name>/ here. That keeps the mindserver port
    // the only one that has to be reachable, and keeps the viewer behind the
    // same auth token as everything else.
    const viewerTarget = (url) => {
        const match = /^\/viewer\/([^/?#]+)/.exec(url);
        return match ? agent_connections[decodeURIComponent(match[1])]?.viewer_port ?? null : null;
    };
    // The viewer's own requests (assets, socket.io) are relative and carry no
    // query string, so the token comes in once on the frame URL and is kept in
    // a cookie for the rest of the session.
    const viewerAuthorized = (req) => {
        if (!auth_token) return true;
        const url = new URL(req.url, 'http://x');
        if (url.searchParams.get('token') === auth_token) return true;
        return (req.headers.cookie || '').split(';').some(c => c.trim() === 'mindserver_token=' + auth_token);
    };

    app.use('/viewer', (req, res) => {
        const port = viewerTarget(req.originalUrl);
        if (!port) {
            // Also transient: the agent deregisters while it restarts, so a
            // document request here deserves the same self-retry as a refused
            // upstream rather than a dead end.
            if ((req.headers.accept || '').includes('text/html'))
                return res.status(404).type('html').send(VIEWER_RETRY_PAGE);
            return res.status(404).send('no viewer for that agent');
        }
        if (!viewerAuthorized({ url: req.originalUrl, headers: req.headers }))
            return res.status(401).send('unauthorized');
        if (new URL(req.originalUrl, 'http://x').searchParams.get('token'))
            res.setHeader('Set-Cookie', `mindserver_token=${auth_token}; Path=/viewer; SameSite=Strict`);
        const isBundle = /\/index\.js(\?|$)/.test(req.originalUrl);
        // The bundle is rewritten below, so upstream's etag/mtime describe the
        // wrong bytes: don't let either side cache or revalidate against them.
        const headers = { ...req.headers };
        if (isBundle) {
            headers['accept-encoding'] = 'identity';
            delete headers['if-none-match'];
            delete headers['if-modified-since'];
        }
        const upstream = http.request(
            { host: '127.0.0.1', port, path: req.originalUrl, method: req.method, headers },
            (r) => {
                if (!isBundle) { res.writeHead(r.statusCode, r.headers); return r.pipe(res); }
                const chunks = [];
                r.on('data', (c) => chunks.push(c));
                r.on('end', () => {
                    const body = dedupeEntityLogging(Buffer.concat(chunks).toString());
                    const out = { ...r.headers, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' };
                    delete out.etag;
                    delete out['last-modified'];
                    res.writeHead(r.statusCode, out);
                    res.end(body);
                });
            }
        );
        upstream.on('error', () => {
            // Nearly always "the agent is restarting and has not bound its
            // viewer port yet". The dashboard builds the iframe the moment the
            // agent reports in_game, so it loses that race routinely -- and an
            // empty 502 is final: nothing retried, so the pane stayed blank
            // until someone refreshed the whole page by hand. Answer document
            // requests with a page that retries itself. Asset requests still
            // get a bare 502, since HTML in place of the bundle is worse.
            if (isBundle || !(req.headers.accept || '').includes('text/html'))
                return res.status(502).end();
            res.status(502).type('html').end(VIEWER_RETRY_PAGE);
        });
        req.pipe(upstream);
    });

    // socket.io's own upgrades are left to its listener; only /viewer/ is ours.
    server.on('upgrade', (req, socket, head) => {
        const port = viewerTarget(req.url);
        if (!port) return;
        if (!viewerAuthorized(req)) return socket.destroy();
        const upstream = net.connect(port, '127.0.0.1', () => {
            upstream.write(`GET ${req.url} HTTP/1.1\r\n${req.rawHeaders.reduce((s, v, i) => i % 2 ? s + v + '\r\n' : s + v + ': ', '')}\r\n`);
            if (head?.length) upstream.write(head);
            upstream.pipe(socket);
            socket.pipe(upstream);
        });
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
    });

    // Serve static files
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    app.use(express.static(path.join(__dirname, 'public')));

    // Texture proxy: resolve item/block textures using minecraft-assets with version fallback
    app.get('/assets/item/:agent/:name.png', async (req, res) => {
        try {
            const agentName = req.params.agent;
            const rawName = req.params.name;
            const itemName = String(rawName).toLowerCase();
            const conn = agent_connections[agentName];
            const preferred = conn?.settings?.minecraft_version;
            const candidates = [];
            if (preferred && preferred !== 'auto') candidates.push(preferred);
            candidates.push('1.21.8');

            // Lazy import to avoid ESM/CJS conflicts
            const mod = await import('minecraft-assets');
            const mcAssetsFactory = mod.default || mod;

            for (const ver of candidates) {
                try {
                    const assets = mcAssetsFactory(ver);
                    // Prefer items path first, then blocks
                    const item = assets.items[itemName];
                    const block = assets.blocks[itemName];
                    const tex = assets.textureContent?.[itemName]?.texture
                        || (item ? assets.textureContent?.[itemName]?.texture : null)
                        || (block ? assets.textureContent?.[itemName]?.texture : null);
                    if (tex) {
                        // textureContent already provides a data URL in many versions
                        if (tex.startsWith('data:image')) {
                            const base64 = tex.split(',')[1];
                            const img = globalThis.Buffer.from(base64, 'base64');
                            res.setHeader('Content-Type', 'image/png');
                            return res.end(img);
                        }
                    }
                    // If textureContent missing, try static path resolution inside package
                    // Helps with some strange blocks like Leaf Litter
                    const guessPaths = [];
                    const base = assets.directory;
                    guessPaths.push(path.join(base, 'items', `${itemName}.png`));
                    guessPaths.push(path.join(base, 'blocks', `${itemName}.png`));
                    for (const p of guessPaths) {
                        try {
                            const fsMod = await import('fs');
                            const buf = fsMod.readFileSync(p);
                            res.setHeader('Content-Type', 'image/png');
                            return res.end(buf);
                        } catch { /* ignore */ }
                    }
                } catch { /* ignore */ }
            }
            // Not found, fallback svg
            res.setHeader('Content-Type', 'image/svg+xml');
            res.status(404).send('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/><text x="50%" y="55%" font-size="12" fill="#bbb" text-anchor="middle">?</text></svg>');
        } catch (e) {
            res.setHeader('Content-Type', 'image/svg+xml');
            res.status(500).send('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/><text x="50%" y="55%" font-size="12" fill="#bbb" text-anchor="middle">!</text></svg>');
        }
    });

    // Socket.io connection handling
    io.on('connection', (socket) => {
        let curAgentName = null;
        console.log('Client connected');

        agentsStatusUpdate(socket);

        socket.on('create-agent', async (settings, callback) => {
            console.log('API create agent...');
            for (let key in settings_spec) {
                if (!(key in settings)) {
                    if (settings_spec[key].required) {
                        callback({ success: false, error: `Setting ${key} is required` });
                        return;
                    }
                    else {
                        settings[key] = settings_spec[key].default;
                    }
                }
            }
            for (let key in settings) {
                if (!(key in settings_spec)) {
                    delete settings[key];
                }
            }
            if (settings.profile?.name) {
                if (settings.profile.name in agent_connections) {
                    callback({ success: false, error: 'Agent already exists' });
                    return;
                }
                let returned = await mindcraft.createAgent(settings);
                callback({ success: returned.success, error: returned.error });
                let name = settings.profile.name;
                if (!returned.success && agent_connections[name]) {
                    mindcraft.destroyAgent(name);
                    delete agent_connections[name];
                }
                agentsStatusUpdate();
            }
            else {
                console.error('Agent name is required in profile');
                callback({ success: false, error: 'Agent name is required in profile' });
            }
        });

        socket.on('get-settings', (agentName, callback) => {
            if (agent_connections[agentName]) {
                callback({ settings: agent_connections[agentName].settings });
            } else {
                callback({ error: `Agent '${agentName}' not found.` });
            }
        });

        socket.on('connect-agent-process', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agentsStatusUpdate();
            }
        });

        socket.on('login-agent', (agentName, alive_ms) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agent_connections[agentName].in_game = true;
                agent_connections[agentName].login_time = Date.now();
                // the agent reports elapsed ms, not a timestamp: its clock need
                // not match ours. No death on record means alive since login.
                agent_connections[agentName].alive_since = alive_ms == null ? Date.now() : Date.now() - alive_ms;
                curAgentName = agentName;
                agentsStatusUpdate();
            }
            else {
                console.warn(`Unregistered agent ${agentName} tried to login`);
            }
        });

        socket.on('agent-died', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].alive_since = Date.now();
                agentsStatusUpdate();
            }
        });

        socket.on('disconnect', () => {
            // Only if THIS socket is still the registered one. The agent proxy
            // reconnects by name, so after a blip the connection holds socket B
            // while socket A is still pending cleanup -- and A's handler used to
            // null out B. The agent then ran on happily while the server
            // believed it was gone: the UI showed it offline and every relayed
            // command answered "Agent not connected", which is what blocked a
            // policy regeneration for half an hour with the bot alive the whole
            // time. Seen once as a lone "Agent Andy disconnected" with no
            // matching agent exit.
            const conn = agent_connections[curAgentName];
            if (conn && conn.socket === socket) {
                console.log(`Agent ${curAgentName} disconnected`);
                conn.in_game = false;
                conn.login_time = null;
                conn.socket = null;
                agentsStatusUpdate();
            } else if (conn) {
                console.log(`Stale socket for ${curAgentName} closed; it has already reconnected.`);
            }
            if (agent_listeners.includes(socket)) {
                removeListener(socket);
            }
        });

        socket.on('chat-message', (agentName, json) => {
            if (!agent_connections[agentName]) {
                console.warn(`Agent ${agentName} tried to send a message but is not logged in`);
                return;
            }
            console.log(`${curAgentName} sending message to ${agentName}: ${json.message}`);
            agent_connections[agentName].socket.emit('chat-message', curAgentName, json);
        });

        socket.on('set-agent-settings', (agentName, settings) => {
            const agent = agent_connections[agentName];
            if (agent) {
                agent.setSettings(settings);
                agent.socket.emit('restart-agent');
            }
        });

        socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            agent_connections[agentName].socket.emit('restart-agent');
        });

        socket.on('stop-agent', (agentName) => {
            mindcraft.stopAgent(agentName);
        });

        socket.on('start-agent', (agentName) => {
            mindcraft.startAgent(agentName);
        });

        socket.on('destroy-agent', (agentName) => {
            if (agent_connections[agentName]) {
                mindcraft.destroyAgent(agentName);
                delete agent_connections[agentName];
            }
            agentsStatusUpdate();
        });

        socket.on('stop-all-agents', () => {
            console.log('Killing all agents');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
        });

        socket.on('shutdown', () => {
            console.log('Shutting down');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
            // wait 2 seconds
            setTimeout(() => {
                console.log('Exiting MindServer');
                globalThis.process.exit(0);
            }, 2000);
            
        });

		socket.on('send-message', (agentName, data) => {
			if (!agent_connections[agentName]) {
				console.warn(`Agent ${agentName} not in game, cannot send message via MindServer.`);
                return;
			}
			try {
                agent_connections[agentName].socket.emit('send-message', data);
			} catch (error) {
				console.error('Error: ', error);
			}
		});

        socket.on('get-policy', (agentName, callback) => {
            const agent = agent_connections[agentName];
            if (!agent?.socket) return callback(null);
            agent.socket.timeout(5000).emit('get-policy', (err, res) => callback(err ? null : res));
        });

        socket.on('get-memory', (agentName, callback) => {
            const agent = agent_connections[agentName];
            if (!agent?.socket) return callback(null);
            agent.socket.timeout(5000).emit('get-memory', (err, res) => callback(err ? null : res));
        });

        socket.on('set-memory', (agentName, text, callback) => {
            const agent = agent_connections[agentName];
            if (!agent?.socket) return callback({ success: false, error: 'Agent not connected' });
            agent.socket.timeout(5000).emit('set-memory', text, (err, res) => {
                callback(err ? { success: false, error: 'Agent did not respond' } : res);
            });
        });

        socket.on('set-policy', (agentName, data, callback) => {
            const agent = agent_connections[agentName];
            if (!agent?.socket) return callback({ success: false, error: 'Agent not connected' });
            agent.socket.timeout(5000).emit('set-policy', data, (err, res) => {
                callback(err ? { success: false, error: 'Agent did not respond' } : res);
            });
        });

        // The agent merges a base profile plus attributes with an LLM call, which
        // is far slower than the rest of these relays -- minutes, not seconds.
        socket.on('generate-policy', (agentName, selection, callback) => {
            const agent = agent_connections[agentName];
            if (!agent?.socket) return callback({ success: false, error: 'Agent not connected' });
            // 120s was not enough: a local model behind a gateway takes two to
            // three minutes to emit a merged policy, so the relay gave up and
            // reported failure while the merge went on to succeed and install
            // itself -- the UI said it was still generating something that had
            // already been running for a minute.
            // And 600s stopped being enough once the merge grew to two full
            // profiles: same failure mode, one order of magnitude later.
            agent.socket.timeout(1800000).emit('generate-policy', selection, (err, res) => {
                callback(err ? { success: false, error: 'Agent did not respond' } : res);
            });
        });

        socket.on('set-policy-lock', (agentName, locked, callback) => {
            const agent = agent_connections[agentName];
            if (!agent?.socket) return callback({ success: false, error: 'Agent not connected' });
            agent.socket.timeout(5000).emit('set-policy-lock', !!locked, (err, res) => {
                if (!err && res?.success) agentsStatusUpdate();
                callback(err ? { success: false, error: 'Agent did not respond' } : res);
            });
        });

        socket.on('list-profiles', (callback) => {
            try {
                if (!existsSync('./policies')) return callback([]);
                const profiles = readdirSync('./policies')
                    .filter(f => f.endsWith('.json'))
                    .map(f => {
                        const name = f.slice(0, -5);
                        const data = readProfile(name);
                        if (!data) return null;
                        // mtime lets the UI tell whether a profile was edited since
                        // the running policy was generated from it.
                        return {
                            name,
                            kind: data.kind ?? 'base',
                            source: data.source ?? [],
                            mtime: statSync(profilePath(name)).mtimeMs,
                        };
                    })
                    .filter(Boolean);
                callback(profiles);
            } catch (error) {
                console.error('Error listing profiles:', error);
                callback([]);
            }
        });

        socket.on('get-profile', (name, callback) => {
            const data = readProfile(name);
            callback(data ? { success: true, profile: data } : { success: false, error: `No profile named "${name}"` });
        });

        socket.on('save-profile', (name, data, callback) => {
            const path = profilePath(name);
            if (!path) return callback({ success: false, error: 'Use letters, numbers, - and _ in profile names.' });
            // An attribute may be nothing but prose for the LLM to fold in, so
            // source lines alone are enough; a policy with rules is also enough.
            const source = (Array.isArray(data?.source) ? data.source : [data?.source])
                .filter(s => typeof s === 'string' && s.trim());
            if (!source.length && !data?.policy?.rules?.length)
                return callback({ success: false, error: 'A profile needs at least one source line or a policy with rules.' });
            try {
                mkdirSync('./policies', { recursive: true });
                const out = { source, kind: data.kind === 'attribute' ? 'attribute' : 'base' };
                if (typeof data.goal === 'string' && data.goal.trim()) out.goal = data.goal.trim();
                if (data.policy) out.policy = data.policy;
                writeFileSync(path, JSON.stringify(out, null, 2));
                callback({ success: true });
            } catch (error) {
                console.error('Error saving profile:', error);
                callback({ success: false, error: error.message });
            }
        });

        socket.on('bot-output', (agentName, message) => {
            io.emit('bot-output', agentName, message);
        });

        socket.on('listen-to-agents', () => {
            addListener(socket);
        });
    });

    server.listen(port, host, () => {
        console.log(`MindServer running on port ${port} on host ${host}`);
        if (!isLoopbackHost(host)) {
            console.warn(`MindServer is reachable from other machines on ${host}:${port}. Connections require the auth token.`);
        }
    });

    return server;
}

function agentsStatusUpdate(socket) {
    if (!socket) {
        socket = io;
    }
    let agents = [];
    for (let agentName in agent_connections) {
        const conn = agent_connections[agentName];
        agents.push({
            name: agentName, 
            in_game: conn.in_game,
            viewerPort: conn.viewer_port,
            socket_connected: !!conn.socket,
            policy_locked: isPolicyLocked(agentName),
            // ms, not a timestamp: the browser's clock need not match the server's
            active_ms: conn.login_time ? Date.now() - conn.login_time : null,
            alive_ms: conn.login_time && conn.alive_since ? Date.now() - conn.alive_since : null
        });
    };
    socket.emit('agents-status', agents);
}


let listenerInterval = null;
function addListener(listener_socket) {
    agent_listeners.push(listener_socket);
    if (agent_listeners.length === 1) {
        listenerInterval = setInterval(async () => {
            const states = {};
            for (let agentName in agent_connections) {
                let agent = agent_connections[agentName];
                if (agent.in_game) {
                    try {
                        const state = await new Promise((resolve) => {
                            agent.socket.emit('get-full-state', (s) => resolve(s));
                        });
                        states[agentName] = state;
                    } catch (e) {
                        states[agentName] = { error: String(e) };
                    }
                }
            }
            for (let listener of agent_listeners) {
                listener.emit('state-update', states);
            }
        }, 1000);
    }
}

function removeListener(listener_socket) {
    agent_listeners.splice(agent_listeners.indexOf(listener_socket), 1);
    if (agent_listeners.length === 0) {
        clearInterval(listenerInterval);
        listenerInterval = null;
    }
}

// Optional: export these if you need access to them from other files
export const getIO = () => io;
export const getServer = () => server;
export const numStateListeners = () => agent_listeners.length;