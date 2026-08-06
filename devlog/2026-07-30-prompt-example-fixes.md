# Prompt examples taught broken code

**Commit:** `4abc179` · 2026-07-30 · shipped

## Problem

The "go to the nearest oak log" coding example read coordinates straight off the
Block that `getNearestBlock` returns:

```js
let position = world.getNearestBlock(bot, 'oak_log', 20);
await skills.goToPosition(bot, position.x, position.y, position.z);
```

A Block keeps its coordinates on `.position`, so **every argument was
`undefined`**. Naming the variable `position` is what hid it. Generated code
copied the pattern faithfully, and undefined coordinates reach the wire as NaN —
which the server treats as an invalid move packet and disconnects for. This is
the upstream cause of the NaN seatbelt in
[modded packet survival](2026-07-30-modded-packet-survival.md).

Separately, the examples demonstrate vanilla materials throughout, which reads
to a model as a *vocabulary* rather than as *syntax*. On a modded server the bot
would ask for blocks that don't exist while the real ones sat in front of it.

## Change

Fix the accessor in the examples. Both prompts already receive the nearby-blocks
list and the inventory, so they now say to take names from those rather than
assuming.

## Decisions

- **The examples stay vanilla on purpose.** They teach syntax. Swapping in
  modded names would only trade one hardcoded vocabulary for another — the fix
  is telling the model where to *look up* names, not giving it a different list.
- Defence in depth: the example is fixed here, `goToPosition` rejects non-finite
  coordinates ([adaptive view distance](2026-07-30-adaptive-view-distance.md)), and the packet layer
  restores NaN fields ([modded packet survival](2026-07-30-modded-packet-survival.md)).

**Files:** `profiles/defaults/_default.json`
