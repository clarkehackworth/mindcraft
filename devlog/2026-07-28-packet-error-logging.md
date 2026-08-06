# Packet error logging

**Commits:** `d1ede22`, `dea48af` · 2026-07-28 · shipped

## Problem

Modded servers add packet ids and payloads with no vanilla schema, so
node-minecraft-protocol can never parse them and logs a read error for each one.
On a large modpack that's a steady stream of noise no user action can resolve —
roughly 20 parse errors per session — burying real problems.

The existing suppressor didn't work either: it tested `err.message` for the
substring `'PartialReadError'`, which is never in the message. That's the
error's *name*. protodef sets the message to `Read error for <field> : <reason>`
and nmp's `client.js` rewrites it to `Parse error for <field> : <reason>`. The
console output reads `PartialReadError: Read error for ...` only because that's
how node renders name and message together. The guard had never matched once.

## Change

Fix the guard to match on `err.name` and both message forms, then add a
`packet_error_logging` setting with three values:

| value | behaviour |
|---|---|
| `full` | unchanged upstream behaviour — **the default** |
| `summary` | log the first error with detail, then a count every 5 minutes |
| `off` | silent |

## Decisions

- **Dropping the packets was already correct** and was never the problem.
  Framing is length-prefixed, so an unparseable body cannot desync the stream,
  and the deserializer is re-piped after each error. Only the *reporting* was
  worth making configurable.
- **`summary` exists because silence is a bad trade on its own.** Going quiet
  makes a genuine protocol problem look exactly like ordinary modded noise. A
  periodic count preserves the signal — packets are being dropped, roughly this
  many — without the spam.
- **`full` stays the default** so vanilla users lose no diagnostics.
- **Suppression has to happen upstream.** The noise comes from protodef, not
  from our handler — `client.js` passes `noErrorLogging: this.hideErrors` to the
  deserializer — so silencing our own error event can't stop it. `summary` and
  `off` therefore set `hideErrors` on the client. The error is still *emitted*,
  so our handler still counts it.
- **Known side effect, documented on the setting:** `client.hideErrors` is also
  read by `createDecompressor()`, so `summary`/`off` additionally silence
  decompression warnings — which would indicate real stream corruption rather
  than a mod.
- In `full` mode our handler no longer logs its own line; protodef already
  printed the detail and doing both only duplicates it.

**Files:** `src/utils/mcdata.js`, `settings.js`
