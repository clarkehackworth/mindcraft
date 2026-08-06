# AGENTS.md

- **Write a devlog entry for large changes or decisions.** New file in
  `devlog/` named `YYYY-MM-DD-slug.md`, add a row to `devlog/README.md`.
  Cover the problem, the change, and the decisions — especially the options
  rejected and why. Applies to reverts too; a feature that got deleted is worth
  writing up.
- `ARCHITECTURE.md` is the map. Read it before changing anything cross-cutting.
- **Never `cleanKill` as an error strategy.** Memory persists across restarts,
  so crash-on-failure becomes a crash loop. Degrade, log, or hand the problem to
  the LLM.
- **Nothing in the tick or packet path may throw.** It runs where nothing
  catches, and an uncaught throw takes down the agent process.
- **Don't trust `minecraft-data` on a modded server.** Prefer server-sent data
  from `bot.registry`; fall back to a harmless placeholder rather than throwing.
- Agent name ≠ `bot.username` under Microsoft auth. Check both.
- Non-trivial logic leaves one runnable check behind — a `*.test.js` next to it
  or an assert-based script in `tools/`. No new frameworks.
- Dependency fixes go in `patches/` via patch-package, not a fork.
- `npm start` runs it. Deliberate shortcuts are marked with a `ponytail:`
  comment naming the ceiling.
