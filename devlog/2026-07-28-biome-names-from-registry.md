# Biome names from the server registry

**Commit:** `5201f71` · 2026-07-28 · shipped

## Problem

`getBiomeName()` looked biomes up in `mc.getAllBiomes()`, minecraft-data's
static table for the protocol version. On a modded server most biomes aren't in
that table, the lookup returned `undefined`, and reading `.name` threw a
TypeError. The throw propagated out of the agent's tick and killed the process —
so on a worldgen-replacing modpack the bot died on spawn.

## Change

Read `bot.registry.biomes` first, fall back to the static table.

mineflayer already has the right data: on login it calls
`bot.registry.loadDimensionCodec(packet.dimensionCodec)` and prismarine-registry
fills in every biome the server actually sent, modded ones included.

## Decisions

- **Registry first, static table second** rather than replacing the lookup —
  vanilla servers behave exactly as before, no regression surface.
- **Fall back to `biome_<id>` instead of throwing.** An unknown id should
  degrade to a useless-but-harmless string, not take down the agent. This is the
  first instance of what became a standing rule on this branch: nothing in the
  tick path may throw.

## Verification

Against the 443-mod Fabric server the bot now reports `frozen pine taiga`, which
does not exist in minecraft-data for 1.20.1.

**Files:** `src/agent/library/world.js`
