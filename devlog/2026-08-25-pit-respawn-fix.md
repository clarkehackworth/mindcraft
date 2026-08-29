# 2026-08-25 — Pit-Respawn Fix: Move the Respawn Out of the Death Pit

## Problem

A 7h check-in (12:05 → 19:22 CDT) showed P1–P5 all holding (cold-rule churn
10→3, log-spam 0, no night-lock, 0 crashes) but the death rate had
**accelerated** to **16 deaths / 7h** (~2.3/h) vs ~0.9/h pre-deploy. The
log told us why.

He was **pinned to one 4-block area** `(-5..-9, 51-53, 2..9)` for the entire
7h — the origin **pit complex**: a dry gravel pit at ~`(-5,51,2)` plus an
adjacent water pit at ~`(5,55,-6)`. The pathfinder log was a wall of
`noPath:visited=167 → path_reset` loops at the same spot. His own self-talk:

- *"I'm stuck in a loop at my death spot, unarmed. Let me get out and find food."*
- `gained no height, nothing to pillar with` — **149×**
- `nowhere to go / you may be stranded` — **144×**
- `leave_your_death_spot` **48×** · `go_back_for_your_grave` **31×** · `keep_out_of_water` **25×**

His LLM memory (pulled from the container) states it plainly:

> *"DROWNED at (6,55,-7). CRITICAL: Water pit at (5,55,-6) has stone ceiling
> 6 blocks up; pathfinding & climbing FAIL. DO NOT RETURN."* and
> *"Stuck x-9,y52,z11; auto-escape failed. Need manual escape. No food."*

**Root cause:** his **respawn point (world spawn) is the pit complex**.
Every death dumped him — unarmed, 0 items — back into a pit he **physically
cannot climb out of**: no blocks to pillar and no tool to dig, so `unstuck`
and every escape rule re-fires forever. 10 of the 16 deaths in the 7h window
occurred *inside* the pit complex (starve ×2 + drown ×6 clustered at
`x -5..5, y 51..56`); the other 6 were surface arrow deaths (he does get out
sometimes, dies, and respawns back in the hole).

This is a **spawn/physics problem, not a policy problem.** No policy action
can give an empty-handed bot blocks or a pickaxe to pillar out of an empty
pit. The death-spot rules are also fighting each other (`leave` 48 vs `grave`
31). And it sits **upstream of the arming chain**: `arm_yourself` and
`arm_gate_closed` both require `chest < 32`, which is never true from a pit
~30+ blocks from Base — so the 24h gate measurement was blocked by it.

## Change

A live host change (sanctioned command surface, no repo edit) plus one
emergency item grant:

1. **Unstuck now:** `tp` him to Base/home `(-29.7, 64, 89.4)` (his own
   `memory.json` `places.home`).
2. **Spawn fix (the proper fix):** `spawnpoint clarkhackworth -29 63 89`
   → server confirmed *"Set spawn point to -29, 63, 89 in
   minecraft:overworld for clarkhackworth."* Per-player, persists across
   restarts (player NBT), so the **next death respawns him at Base, not the
   pit.**
3. **Emergency food:** `give cooked_beef 4` (hunger was 5/20 — he was
   actively starving in the pit). Reversible, reported.

## Decisions

- **Why `spawnpoint` (per-player) and not `setworldspawn`?** `setworldspawn`
  moves the spawn for **all** players on a shared 443-mod server — a
  host-side side effect I won't apply without explicit ask. `spawnpoint
  <player>` is scoped to Andy's account, is the vanilla per-player respawn
  override, and is exactly the blast radius this bug has. Rejected: global
  spawn change.
- **Why a spawn move and not a policy reflex for "stranded in a pit with no
  blocks"?** The state is unreachable from any policy action: `move_away` and
  `unstuck` need a path that doesn't exist, `dig` needs a tool he doesn't
  have, `pillar` needs blocks he doesn't have. A new rule would just add an
  11th re-firing rule to the same unresolvable state (the existing 48+31+25
  are already doing that). Moving the spawn **removes the state entirely** —
  he no longer spawns in a pit, so the pit never becomes his respawn. Rejected:
  policy reflex.
- **Why `tp` + `spawnpoint` together?** `tp` alone is a one-shot relief; the
  next death re-dumps him in the pit. `spawnpoint` alone doesn't help the
  bot that is *currently* in the pit. Both are needed. Rejected: either alone.
- **Why not `give` him blocks/a pickaxe to self-escape?** That papers over the
  respawn bug — the next death still dumps him in the pit, and he'd still need
  to find the blocks again. The spawn fix is the durable one. Rejected.

## Verification

- `pos` after `tp`: **`-29 61 89`** = home/Base (was `-5 52 3` in the pit). ✅
- Server confirmed spawnpoint set for `clarkhackworth`. ✅
- Post-`tp` 10-min log slice: **0 deaths**, **0** `gained no height`,
  **0** `nowhere to go`, death-spot churn gone; `move:pos` events show him on
  surface at Base (y 60–63). ✅
- Bonus: at Base, `chest < 32` is finally true — the **arming chain gets its
  first real chance to fire**, which is the end-to-end proof the whole P1–P5
  line has been chasing.

## Follow-ups

- **Watch the arming chain at Base.** If `arm_yourself_from_the_chest` →
  `wooden_sword` crafted → equipped fires now, the chain is **verified** and
  the 24h gate question (P5 telemetry) becomes moot or confirmable. If it
  still doesn't fire from Base, the hostile gate (24) or the chest trigger is
  the next thing to measure.
- **The pit is now a hazard, not a respawn.** He can still path there by
  accident. The death-spot rules (`leave_your_death_spot` pinned) remain the
  defense for that. If he keeps getting *pulled* back (grave rule vs leave
  rule), that fight is the next policy cleanup.
- **P6 levers (after arming is proven):** ranged-killer handling (arrows now
  the #1 surface cause) and food rules (starve in the pit). De-dupe
  `death.attack.drown` (double-labeled).
