# Mod data packs

**Commit:** `fe52db1` · 2026-07-30 · shipped

## Problem

Against a modded server the vanilla 1.20.1 registry is wrong in two ways:

1. Modded blocks and items are unknown entirely.
2. Mods **shift vanilla block state ids**, so the bot reads ordinary blocks as
   the wrong thing.

Everything it can't resolve looks like nameless undiggable air. The bot was
effectively blind.

## Change

A `mod_data` setting pointing at registry dumps taken from the server itself —
a directory of packs, a single file, or a list. `src/utils/mod_data.js` loads
them and overlays the vanilla registry.

`tools/mod-data-dumper/` is a small Fabric mod that produces a dump.

## Decisions

- **Dump from the server, don't guess.** The state-id shift depends on the exact
  mod set and load order; nothing can be inferred from the mod list alone.
- **A dumper mod rather than scraping the wire.** The registry sync packet
  doesn't carry everything we need, and a Fabric mod can just ask the game.
- **Only the README is tracked.** Dumps are large and specific to one modpack —
  `.gitignore` covers the rest. Users bring their own.
- **Accept a directory, file, or list** so a modpack's dump can be split by mod
  or shipped as one blob without the config caring.

**Files:** `settings.js`, `src/utils/mod_data.js`, `mod_data/README.md`,
`tools/mod-data-dumper/`, `.gitignore`
