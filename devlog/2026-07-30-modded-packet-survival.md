# Surviving modded packets

**Commit:** `f092339` · 2026-07-30 · shipped

## Problem

Three separate ways a modded server took the agent process down. All in the
packet path, all fatal for the same reason: mineflayer dereferences the result
inside a packet handler, where nothing catches.

1. **Unknown window types.** A re-skinned station registers its own MenuType
   past the vanilla range; prismarine-windows has no layout for it and returns
   `null`. VisualWorkbench does this to the crafting table, so *every craft
   crashed*.
2. **Unparseable packets.** Covered in [packet error logging](2026-07-28-packet-error-logging.md) — the
   error spam buried real problems.
3. **NaN in a move packet — an instant kick.** The server checks for non-finite
   values before anything else. Generated code reaches for `block.x`, which is
   `undefined` on a prismarine Block (coords live on `.position`), and `lookAt`
   turns that into a NaN yaw.

## Change

- Unknown window types: recover the window by its **title** when the layout is
  identical (the VisualWorkbench case), and decline unrecognized types rather
  than crashing.
- NaN fields: restore non-finite fields from the last known good value.

## Decisions

- **Recover by title rather than registering the modded MenuType.** We can't
  know the layout of an arbitrary modded menu; we *can* know that a thing
  calling itself a crafting table has a crafting table's layout. Anything not
  recognized is declined — a failed craft is recoverable, a dead process is not.
- **Patch `bot.entity` as well as the outgoing packet.** Fixing only the packet
  isn't enough: the NaN stays in the entity, so every subsequent packet carries
  it too.
- The upstream cause — generated code reading `block.x` — is fixed separately in
  [prompt example fixes](2026-07-30-prompt-example-fixes.md). This layer is the seatbelt, not the fix.

**Files:** `src/utils/mcdata.js`
