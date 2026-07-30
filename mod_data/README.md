# Mod data packs

Drop registry dumps from modded servers here (`*.json`); mindcraft loads every
pack in this directory at login, per the `mod_data` setting in `settings.js`.

Without a pack, a modded server's blocks reach the bot as block state ids
minecraft-data has never seen, and mineflayer reports them as nameless,
shapeless, undiggable air — the bot walks into modded trees and can't break out.
A pack tells it which state id is which block, along with per-state collision
shapes, the tools that drop each block, and the pack's crafting recipes (which
replace vanilla's wherever the modpack rewrote them).

It also fixes vanilla blocks: a mod that adds a property to leaves shifts every
vanilla state id after them, so without a pack the bot reads spruce leaves as
birch leaves and so on through most of the vanilla registry.

Generate one with `tools/mod-data-dumper` (a Fabric mod: build it, put it in the
server's `mods/`, restart, then copy the `mindcraft_mod_data.json` it writes
here). One pack per modpack; name them accordingly, e.g. `prominence2.json`.

Packs are gitignored — they're megabytes of server-specific data.
