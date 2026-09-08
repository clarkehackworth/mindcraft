# Crafting: every 3x3 craft failed because the bot clicked the table from 12 blocks away

**Status:** shipped; open question on where AndyB's tools went.

## Symptom

Both bots survived but never armed. Three hours of log: "Crafting
wooden_sword FAILED: the crafting table never produced the result" nine times
per bot, pickaxe six, furnace two. The 2x2 craft worked, so both kept
producing crafting tables (eight each) and nothing else. The message blamed
VisualWorkbench.

## What it actually was

Four instrumented crafts on Andy, in order:

1. No `open_window` packet ever arrived, and no Fabric screen-handler
   payload either. The server was sending nothing back.
2. The activation happened at `dist=12.3`: `goToNearestBlock` failed to get
   within reach, `craftRecipe` ignored that and called `openBlock` anyway,
   and the server silently drops an out-of-reach interaction. mineflayer then
   waits its full 20s twice for a windowOpen that never comes.
3. Placing a fresh table instead failed with "blockUpdate did not fire" --
   `getNearestFreeSpace` returns the bot's own feet first and a block cannot
   be placed where an entity stands.
4. Placing on a neighbour then failed with "no free block with solid ground":
   Andy was standing on a **barrier** block inside a water-logged structure,
   which is also why every walk to a table or chest (chests at 15-29 blocks)
   fell short. Teleported out, the sword crafted first try.

VisualWorkbench was innocent: AndyB, on open ground, crafted a wooden sword,
a wooden pickaxe and a stone pickaxe through its table with the same code.

## Changes (skills.js)

- `openWithRetry` checks distance first and returns null with a clear
  message instead of a 40s stall. Every block-menu path (table, chests,
  furnace) benefits.
- `tableWithinReach(bot, range)`: nearest table if in reach, else walk to it,
  else craft one (4 planks) and place it on a neighbouring block with ground
  under it. Both craft branches (vanilla recipe and mod-data recipe) use it.
- `placeBlock`'s "Failed to place" now carries mineflayer's error text.
- Runnable check: `table_craft.test.js` gained the reach-guard case.

## Open

- AndyB's crafted sword and pickaxes were gone twenty minutes later with no
  death logged and no deposit rule fired (`dig_in_out_of_the_cold` fired
  four times in between). Not explained yet. Check its next craft with
  `AGENT_NAME=AndyB MC_PLAYER=clarke_hackworth live_test.sh incidents` and an
  rcon inventory read right after "Crafted".
- Andy's whole home area is a flooded village: two drownings today at
  (-30,53,96) and (-24,58,93), one of them minutes after being placed there.
  Moved to dry land at -268,63,124 with spawnpoint and home set.
- docker `-t` stamps and the container's `Date.now()` disagreed by ~3h
  tonight; `rawlog` windows may be wider than asked. Check before trusting a
  narrow scorecard window.
