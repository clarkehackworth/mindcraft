# Agent name vs. account name

**Commits:** `03ebd4c`, `e8cb99b` · 2026-07-28 / 2026-07-30 · shipped

## Problem

Two bugs, one root cause. The codebase assumed the agent's configured name and
its in-game username are the same string. That holds for offline-mode logins,
where mineflayer uses the username we pass it. It does **not** hold under
Microsoft authentication — there mineflayer ignores the requested username and
uses the name on the Minecraft account, so an agent configured as "Andy" appears
in chat as whatever the account is called.

Consequences:

1. `respondFunc()` dropped the bot's own chat by comparing the sender against
   `this.name`. The guard never matched, so the bot saw its own messages as
   player messages **and answered itself**.
2. The death-message prefix check missed too, so the bot was never told it died
   and never saved `last_death_position` — leaving it unable to find its own
   grave.

## Change

Compare against `bot.username` as well as `this.name`, in both places.

## Decisions

- **Both names, not just `bot.username`.** Cheap, and keeps offline-mode
  behaviour identical whatever mineflayer does with the requested name.
- **Optional chaining on `bot.username`** — `respondFunc` is installed before
  login completes, so the field may not exist yet.
- Fixed in two commits because the death-detection instance wasn't found until
  the bot actually died on the live server and couldn't retrieve its stuff.

**Files:** `src/agent/agent.js`
