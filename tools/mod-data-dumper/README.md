# Mod data dumper

A Fabric mod that dumps a modded server's blocks (with per-state collision
shapes and harvest tools), items, entities and crafting recipes to
`<server dir>/mindcraft_mod_data.json`, in the shape mindcraft's `mod_data`
setting expects.

Why it has to run on the server: mineflayer decodes chunks by *block state id*,
and a modpack appends its own states past the end of the vanilla palette. Only
the running server knows which id each modded block landed on. Without this,
minecraft-data can't resolve those ids and mineflayer reports every modded
block as nameless, shapeless, undiggable air — the bot walks into modded trees
and can't break its way out.

## Build

Requires Java 17. No local install needed if you have docker:

```bash
docker run --rm -v "$PWD":/work:Z -v mindcraft-gradle:/home/gradle/.gradle \
  -w /work gradle:8.7-jdk17 gradle build --no-daemon
```

Jar lands in `build/libs/`.

## Use

1. Drop the jar in the server's `mods/` folder.
2. Restart the server. It writes `mindcraft_mod_data.json` on startup.
3. Copy that file into mindcraft's `mod_data/` directory.

The dump runs once and then leaves the file alone; delete it and restart to
regenerate after changing the pack. It runs on its own thread, not the server
thread — collision shapes make Lithium log a warning per modded block class,
and a 400-mod pack spends long enough inside log4j to trip the 60s watchdog and
kill the server. On Prominence 2 it takes about 2.5 minutes and the server ticks
normally throughout.

The mod is server-only and does nothing else, so it can stay installed.

## Ingredient slots

A slot that accepts more than one item — anything taking a tag, like the
`#minecraft:planks` in every wooden recipe — is dumped as `{"any": [ids...]}`
listing everything it accepts. Single-item slots stay bare ids.

This matters more than it looks. The dumper used to write only the tag's first
item, so a `wooden_pickaxe` came out demanding `minecraft:oak_planks`
specifically. mineflayer's `recipesFor()` reads the same table the crafting
planner does, so a bot in a frozen pine taiga holding 20 `pine_planks` could
neither plan nor craft a pickaxe — it died 18+ times without one and recorded
"pine unusable" in its own memory, which was true of the dump and false of the
server.

`mod_data.js` resolves these into concrete recipes at load, one variant per
candidate, with slots sharing a set moving together (all three plank slots
become pine, or all three become oak). Minecraft would also accept one of each,
but enumerating that is the combinatorial explosion worth avoiding: 70 woods
over 3 slots is 70 recipes this way and 343,000 the other.

Packs dumped before this change have no `any` slots; `mod_data.js` detects that
and falls back to a planks-only heuristic, so old packs keep working.

Built for Fabric 1.20.1. For other versions bump `minecraft`, `fabric-api` and
`~1.20` in `build.gradle` / `fabric.mod.json`; the code uses only long-lived
vanilla APIs. For NeoForge/Forge packs the same ~150 lines need a different
mod loader shell.
