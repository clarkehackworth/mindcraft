# Chunk sections wider than vanilla's palette

**Commit:** `a9c29bb` · 2026-07-30 · shipped

## Problem

prismarine-chunk threw `Bits per block is too big: 20` on this server and
dropped the chunk.

The direct palette is `ceil(log2(block states))` wide. That's 15 for vanilla but
**20 for Prominence 2**, whose highest block state id is 618022. `ChunkColumn`
already derives its own width from the registry and got 20 right; the read path
then rejected it against a hardcoded 16.

## Change

A patch (`patches/prismarine-chunk+1.40.0.patch`) raising the ceiling from 16 to
32.

## Decisions

- **32, not 20.** 32 is the *actual* limit — `BitArray` packs into 32-bit words.
  Picking a number that fits this modpack would just move the wall.
- **Nothing else needed changing.** Because the column already sized itself
  correctly from the registry, the palette container was being built at the same
  width the wire uses, so the data decodes as-is. The check was the only thing
  wrong.
- **patch-package rather than a fork.** One-line-ish upstream bug; a patch is
  reversible and visible in review.

**Files:** `patches/prismarine-chunk+1.40.0.patch`
