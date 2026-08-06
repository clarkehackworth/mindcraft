# The bot drowned reaching for a command that didn't exist

**Commit:** uncommitted · 2026-08-01

## Problem

Andy pathfound to a block underwater and drowned. The model noticed
("I'm stuck underwater; I'll head to the surface") and called `!goToSurface`
— which didn't exist. Separately, the automatic drowning handling in
`self_preservation` only jumped when no pathfinder goal was set, so it never
fired while the bot was actively pathfinding (i.e. the exact case that
killed it), and it keyed off "is there water overhead" rather than actual
oxygen.

## Change

- New `surface()` skill: abandons the current pathfinder goal and swims
  straight up until clear of water, with a timeout so a bot sealed under an
  overhang doesn't hold the action forever.
- `self_preservation` now checks real oxygen level and interrupts whatever
  the bot is doing once it's actually low, same as the existing lava
  handling.
- New `!goToSurface` command wraps the skill for deliberate use, separate
  from the automatic emergency handling.

## Files

`src/agent/library/skills.js`, `src/agent/modes.js`,
`src/agent/commands/actions.js`, `src/agent/library/surface.test.js`
