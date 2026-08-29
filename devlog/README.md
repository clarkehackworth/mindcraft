# Devlog

One file per major change, oldest first. Covers work on the
`feat/mindserver-bind-auth` line only — changes made by Clarke Hackworth and
Claude, not by upstream Mindcraft developers.

The driving context for nearly all of it: running an agent against a
443-mod Fabric server (Prominence 2) rather than vanilla. Almost every entry
below started as "the bot died again" on that server.

| Date | Change | Status |
|---|--------|--------|
| 2026-07-28 | [Biome names from the server registry](2026-07-28-biome-names-from-registry.md) | shipped |
| 2026-07-28 | [Agent name vs. account name](2026-07-28-agent-name-vs-account-name.md) | shipped |
| 2026-07-28 | [Packet error logging](2026-07-28-packet-error-logging.md) | shipped |
| 2026-07-30 | [Surviving modded packets](2026-07-30-modded-packet-survival.md) | shipped |
| 2026-07-30 | [Mod data packs](2026-07-30-mod-data-packs.md) | shipped |
| 2026-07-30 | [MindServer bind host + auth token](2026-07-30-mindserver-bind-and-auth.md) | shipped |
| 2026-07-30 | [Chunk sections wider than vanilla's palette](2026-07-30-wide-chunk-palette.md) | shipped |
| 2026-07-30 | [Abandoning actions instead of killing the process](2026-07-30-abandon-stuck-actions.md) | shipped |
| 2026-07-30 | [Removing the model's self-destruct buttons](2026-07-30-no-self-destruct.md) | shipped |
| 2026-07-30 | [Prompt examples taught broken code](2026-07-30-prompt-example-fixes.md) | shipped |
| 2026-07-30 | [Adaptive view distance](2026-07-30-adaptive-view-distance.md) | **reverted** |
| 2026-07-31 | [`!stfu` stops the chatting, not the working](2026-07-31-stfu-scope.md) | shipped |
| 2026-07-31 | [Unstuck without suicide](2026-07-31-unstuck-without-suicide.md) | uncommitted |
| 2026-07-31 | [User messages superseding an active goal](2026-07-31-goal-supersede.md) | uncommitted |
| 2026-07-31 | [Behavior policy layer](2026-07-31-behavior-policy.md) | uncommitted |
| 2026-08-01 | [Compiled policy rules that retreat forever](2026-08-01-retreat-loop-in-policy.md) | uncommitted |
| 2026-08-01 | [`!stayUntil` replaces guessing with `!stay(-1)`](2026-08-01-stay-until.md) | uncommitted |
| 2026-08-01 | [Idle-only modes were discarding every self-prompted command](2026-08-01-modes-eating-commands.md) | uncommitted |
| 2026-08-25 | [Cold-rule state gap, log spam, night-lock, gate telemetry](2026-08-25-P1-P5-cold-arming-gate.md) | shipped |
| 2026-08-01 | [The bot drowned reaching for a command that didn't exist](2026-08-01-drowning-handling.md) | uncommitted |
| 2026-08-01 | [`!stats` and the policy engine disagreed about night](2026-08-01-two-definitions-of-night.md) | uncommitted |
| 2026-08-05 | [Code issues seen while tuning the survival policies](2026-08-05-observed-code-issues.md) | **open** |
| 2026-08-18 | [Arm, mine, and actually recover the grave](2026-08-18-gear-and-mining-activation.md) | shipped |
| 2026-08-22 | [Self-layer clear unblocks the deep gear ladder](2026-08-22-self-layer-clear.md) | shipped |
| 2026-08-23 | [Arming fix: chest fallback crafts and equips a starter sword](2026-08-23-arming-fix.md) | shipped |
| 2026-08-23 | [Arm self-sufficiently: `collect log` before the craft](2026-08-23-arming-collect-wood.md) | shipped |
| 2026-08-24 | [Trim the three dead chest-withdraw steps from arming](2026-08-24-arming-trim-dead-withdraw.md) | shipped |
| 2026-08-24 | [Arm gate against mid-raid pre-emption + a check that means it](2026-08-24-arming-gate-and-check.md) | shipped |
| 2026-08-24 | [Wood family verified: no bug, oak was the GoalChanged consequence](2026-08-24-wood-family-verified.md) | verified, no deploy needed |
| 2026-08-25 | [Pit-respawn fix: move the respawn out of the death pit](2026-08-25-pit-respawn-fix.md) | shipped (live host change) |
| 2026-08-25 | [Arming: remove the water gate + inject inventory ground truth](2026-08-25-arming-water-gate-and-inventory-truth.md) | shipped |
| 2026-08-29 | [Auth-race fix, spawn pocket solidified, stuck-command deadlock](2026-08-29-p8-p9-p10-auth-pocket-deadlock.md) | shipped |

`ARCHITECTURE.md` at the repo root was written alongside the behavior policy
layer — the arbiter needed a written model of where it sits before it could be
designed.

## Recurring themes

- **Never kill the process as an error strategy.** The two stuck-action entries
  and the self-destruct one all delete a `cleanKill` path. Memory persists
  across restarts, so a crash-on-failure becomes a crash *loop*, and the bot's
  summary carries the failure forward into the next life.
- **The vanilla registry is a lie on a modded server.** Biome names, packet
  survival, mod data packs, chunk palette width. Where mineflayer already has
  server-sent data, prefer it over `minecraft-data`; fall back rather than
  throw.
- **Agent name ≠ in-game username** under Microsoft auth.
- **Measure before believing.** Adaptive view distance is a feature that
  survived four iterations and then got deleted, because an A/B/A test showed
  run-to-run variance exceeded the effect.
