# A test harness for the live agent

**Commit:** uncommitted · 2026-08-05 · `tools/live_test.sh`

## Why

Every bug in [the code-issues log](2026-08-05-observed-code-issues.md) was found
by watching the agent play and waiting for it to fail. That works, and it found
real things, but it has two problems.

It is slow. A single sample of "the collect banked nothing" took anywhere from
two minutes to half an hour, and the interesting cases were the rare ones.

Worse, it produces hypotheses faster than evidence. Two were shipped before they
were checked, and both were wrong: that lost drops were a sweep-radius problem
(they were three different problems, one of which was the opposite direction),
and that a block yielding nothing meant a missing tool (the agent had banked
sixteen logs bare-handed, in a log file already on disk). Passive observation
tells you what happened, never what would happen if.

This harness puts the bot in the state under test on purpose.

## What it needs

The Minecraft server has RCON enabled, so the game world is scriptable:

```
ENABLE_RCON=TRUE   RCON_PORT=25575   (password in the container env)
```

`docker exec minecraft-prominence2 rcon-cli "<command>"` runs any server command.
Everything here is built on that plus `docker logs` on the agent container. No
framework — each scenario is one server command and a log grep, and a framework
would be more code than the tests.

## Usage

```sh
tools/live_test.sh pos                  # where is the bot, per the SERVER
tools/live_test.sh rcon "<command>"     # raw server command
tools/live_test.sh freeze               # pen it in powder snow, watch is_freezing
tools/live_test.sh wood                 # give it a tree to fell, watch the drops
tools/live_test.sh raider [mob]         # summon a raider, check the flee rule fires
tools/live_test.sh watch <pattern> [s]  # tail the agent log for a pattern
```

Overridable by env: `MC_HOST`, `MC_CONTAINER`, `BOT_CONTAINER`, `MC_PLAYER`.

## The three pieces worth knowing about

**`pos` asks the server, not the agent.** The agent's own idea of where it is
comes through the same machinery that is often the thing under test, and it is
unavailable entirely when the agent is wedged. `data get entity <player> Pos` is
ground truth.

**`await` fails when the scenario does not reproduce.** It returns non-zero if
the pattern never appears, so "set up a situation and saw nothing" is a failure
rather than a silent pass. This matters more than it sounds: a scenario that
fails to *set up* looks exactly like a scenario that set up fine and disproved
something.

**`require_pos` retries.** This bot dies every few minutes, and a dead bot has no
position — which is how the first freeze run silently did nothing at all (see
below).

## The scenarios, and what they found

### `freeze` — confirming `is_freezing`

`is_freezing` originally read entity metadata key 7 (`ticks_frozen`). A server
only sends a metadata field once it changes from its default, so an absent slot
means "not currently freezing" and proves nothing. The condition could only be
confirmed by making the bot actually freeze.

The scenario floors a 3×3 area with packed ice, fills it with powder snow, and
teleports the bot back into it every five seconds so it cannot walk out. It reads
**both** the server's `TicksFrozen` NBT and the agent's log, which is the point:
that separates *did the mechanic fire* from *did mineflayer see it*, and the
agent log alone cannot answer the first.

**First result: the metadata approach did not work.** Penned in powder snow the
bot froze to death three times in a row and the condition never fired once.
Rather than guess another index, `frozenTicks` grew a bounded probe printing
every non-zero numeric metadata slot. It settled the question, including one
sample taken as the bot died:

```
[freeze probe 1/40] health=52 non-zero numeric metadata: 9=52 10=4802351 20=915 21=127
[freeze probe 6/40] health=0  non-zero numeric metadata: 9=2  10=4802351 20=915 21=127
```

Key 7 never appears, not even while freezing to death. This server does not send
it. (Key 9 is health, reading **52** — worth knowing on its own, since the modded
maximum is not 20 and anything assuming vanilla health ranges is wrong here.)

**Second result: rebuilt on observable signals, and confirmed.** `is_freezing`
now reads the *cause* rather than a meter: standing in powder snow (certain), or
snowfall in a cold biome via `world.getBiomeName` — which reads the server
registry, so modded biome names arrive intact. The biome half deliberately
requires weather too: this agent lives in a snowy forest permanently, and firing
on biome alone would mean a pinned `interrupts: all` rule that never stops.

Re-running the pen against the new version:

```
FOUND: (POLICY RULE 'active:get_out_of_the_cold') YOU ARE FREEZING...
-- agent side: mineflayer sees it, is_freezing is live
```

Two hours of passive watching could not have told me the first version was
broken, because a condition that never fires looks exactly like a condition
whose situation never arose.

### `raider` — does a rule's mob name actually match?

`flee_ranged_raiders` names its mobs as `entity_nearby` strings. A name the
client spells differently matches nothing and fails **silently** — the same
failure this repo already hit with block names, where "log" was rejected and the
suggestion pointed at a tree that does not exist in the biome. The agent had been
dying to `entity.frostiful.chillager` repeatedly, which was reason enough to stop
trusting the spelling in a rule I had written.

Summons the mob ten blocks away and waits for the rule to fire. Result: it does,
so `frostiful:chillager` is right. Worth having as a check for every mob name
added to that rule in future — `stray`, `pillager`, `vindicator` and `ravager`
are all still only assumed.

### `wood` — drops that never arrive

Builds a five-block spruce trunk two blocks from the bot, on ground the bot is
already standing on, deliberately away from the canopy and pathing problems that
explain the other two drop failures. Not yet run to a conclusion.

## The bug this harness had, which is the lesson

The first `freeze` run printed:

```
penning the bot in powder snow at
-- server side: meter never rose; the pen did not work
```

The bot had just respawned, `pos` returned an empty string, and `setblock` ran
with no coordinates. The test changed nothing, observed nothing, and reported a
negative result — which, had I not noticed the blank coordinates in the echo,
would have read as evidence that freezing does not raise the meter.

A harness that can fail to set up must say so distinctly from a harness that set
up and found nothing. `pos` now returns non-zero and explains itself when the bot
is not locatable, and `require_pos` waits for a respawn rather than proceeding
into a meaningless run.

## Cost, and the standing caveat

`freeze` kills the bot. That is the mechanic working as intended, and this bot
dies routinely anyway, but it is a real side effect on a live world: it drops the
agent's inventory at the pen. Both scenarios clean up the blocks they place.
Neither restores anything the bot dropped on dying. `raider` summons a live
hostile next to the agent and does not despawn it afterwards.

Run these deliberately, not on a loop. Between them they killed the agent about
half a dozen times in one session — which was worth it to turn "is_freezing is
correct by the spec but unconfirmed" into "the first version never fired once,
here is one that does", but it is a real cost paid in a live world.
