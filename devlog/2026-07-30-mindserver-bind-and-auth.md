# MindServer bind host + auth token

**Commit:** `a3064fe` · 2026-07-30 · shipped
(the branch is named after this one)

## Problem

The MindServer UI grants full control of every agent, so it was hardcoded to
loopback. That makes it unreachable when the bot runs in a container or on
another box — which is exactly the deployment we're running. The obvious
workaround, binding to `0.0.0.0`, hands full agent control to anything on the
network.

## Change

- `mindserver_host` selects the interface.
- `mindserver_auth_token` gates the socket.
- The UI passes the token as `?token=` on the query string.

## Decisions

- **Non-loopback binds *require* a token.** Not "recommend", not "warn" —
  refuse to start. The failure mode we're guarding against is someone widening
  the bind and silently dropping the only thing protecting it. Making the two
  settings interlock means that can't happen by omission.
- **Loopback stays token-free** so the default single-machine experience is
  unchanged.
- **Query-string token rather than a login page.** The UI is a single static
  page with a socket.io connection; a session layer would be real
  infrastructure for what is one shared secret. The token is visible in the URL,
  which is acceptable for a LAN control panel and is documented as such.

**Files:** `main.js`, `settings.js`, `src/agent/mindserver_proxy.js`,
`src/mindcraft/mindcraft.js`, `src/mindcraft/mindserver.js`,
`src/mindcraft/public/index.html`
