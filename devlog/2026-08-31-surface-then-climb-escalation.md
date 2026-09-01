# Surface() escalation: pillar-and-dig when there's no path up

## Problem

The `surface_when_night_finds_you_underground` policy rule called
`go_to_surface` (a flat pathfinder toward the sky). When the bot is in an
enclosed water pocket with no path up, that silently fails — the bot just
keeps swimming in circles until it drowns. The `surface()` skill from
2026-08-31 correctly *reports* the failure ("enclosed pocket, no path up")
but the policy had no next step after that. It logged the failure and moved
on.

## Change

New policy action `surface_then_climb` in `src/agent/behavior/policy.js`:

1. Calls `skills.surface(bot)`. If it succeeds, done.
2. If it fails, escalates to `climbOut(bot, { blocks: 8 })` — the existing
   pillar-and-dig routine from the arming skill set. This is the in-bot
tp-rescue: a vanilla player can't teleport itself, but it *can* pillar
   upward and dig out of the ceiling.
3. No-throw: if either step throws, the action degrades to a log and
   releases the action slot (no cleanKill, no crash loop).

The policy rule was updated in all three locations:

- **Live** (`/app/bots/Andy/policy.json` in the container): rule
  `surface_when_night_finds_you_underground` now does
  `[{act: surface_then_climb, blocks: 8}]` instead of
  `[{act: go_to_surface}]`. Revision bumped to 853.
- **Repo** (`policies/survive_upgrade.json`): same rule change.
- **Repo** (`policies/stayin_alive.json`): same rule change.

## Rejected options

- **rcon tp-rescue on failure**: requires an external operator in the loop.
  The bot should be able to self-rescue. The tp-rescue is still a manual
  fallback (RUNBOOK.md), but the policy should try the in-bot option first.
- **Make surface() itself dig**: surface() is a skill in `skills.js` that
  owns water-escape semantics. Mixing pillar-dig into it would conflate two
  distinct failure modes (trapped in water vs. trapped under stone). Keeping
  them as separate actions in the policy layer is cleaner and lets the
  policy tune the dig depth independently.
- **Just increase go_to_surface's timeout**: the problem isn't that the
  pathfinder gave up too early; it's that there *is* no path. Waiting
  longer doesn't create a path.

## Verification

- `node tools/surface_then_climb_check.js` — 4/4 pass (mock bot: surface
  succeeds → no climb; surface fails → climb called with blocks:8; both
  throw → no-throw, action released)
- All 10 prior suites green: surface, surface_noop, surface_drown,
  drowning_debounce, oxygen_scope, water_aware_path, stay, boss_tier,
  huntable, policy_check
- `node --check src/agent/behavior/policy.js` — syntax OK
- Deployed live: `docker exec mindcraft grep surface_then_climb
  /app/bots/Andy/policy.json` — confirmed in the running container
- Bot alive post-deploy at full health (24.0f)

## Open items

- Observe whether the bot actually triggers the escalation in a real
  enclosed pocket. The pocket at (-10, 50-52, 9) is the test case. If the
  bot respawns there (spawnpoint is now at Base, but the pocket still
  exists), the policy should fire surface → fail → climbOut(8).
- `climbOut` with `blocks: 8` digs at most 8 blocks up. If the ceiling is
  higher, the bot may still be trapped after the climb. The policy could
  retry with a larger `blocks` value, but that's a tuning decision for a
  future entry.
