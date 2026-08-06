# Code changes needed — policy prompt storm (2026-08-04)

Observed live on docker.lan. Andy spent the whole session unarmed at night with
spiders on him, repeatedly generating exactly the right command
(`!craftRecipe("wooden_sword", 1)`) and having it thrown away. Nothing in the
rules was wrong; the engine never let a decision finish.

These are code fixes. Rule-level mitigations are already deployed (see bottom).

## 1. `interrupts: "idle"` is a silent no-op for prompt-only rules

`Rule.update()` (src/agent/behavior/policy.js:727) splits `do` into steps and
prompts. Only `steps` goes through `execute()` — the ActionManager arbiter that
honours `interrupts`. A rule whose `do` is nothing but `prompt_self` has
`steps.length === 0`, so `execute()` is never called and the prompts are
dispatched directly at :771.

`eligible()` (:706) checks cooldown and conditions only. It never looks at
`this.interrupts`.

So every one of the 12 prompt-only rules in stayin_alive + food_gathering
declares `interrupts: "idle"` and none of them means it. They fire mid-action,
mid-generation, whenever the cooldown is up.

Fix: either make `eligible()` reject non-`all` rules when `!agent.isIdle()`, or
route prompt-only rules through `execute()` too. The first is smaller.

## 2. `isIdle()` is true while the agent is generating

`Agent.isIdle()` (src/agent/agent.js:585) is `!this.actions.executing`. A 30s+
LLM call is not an action, so the bot reads as idle for the entire time it is
thinking. Every `is_idle`-gated rule therefore fires *into* the generation it
is meant to wait for.

This is what makes #1 unfixable at the rule layer: adding `{"cond":"is_idle"}`
to a prompt rule does not stop it landing on a pending response.

Fix: `isIdle()` should be `!this.actions.executing && !this.prompter.isBusy()`
(prompter already tracks `_convo_inflight` / `awaiting_coding`). Callers that
want the narrower "no action running" meaning should ask `actions.executing`
directly — audit the 2 call sites at agent.js:552 and policy.js:113.

## 3. Any inbound message discards a completed generation

`Prompter.promptConvo` (src/models/prompter.js:268) compares
`current_msg_time !== most_recent_msg_time` *after* the API call returns and
throws the whole response away. The generation is already paid for and, in
every case seen live, was still correct — the "new message" was a policy prompt
or a `Recent behaviors log: Aaa! A spider!` from cowardice mode, neither of
which invalidates "craft a sword".

Discarding is right for a *user* message (the conversation moved on). It is
wrong for system-injected policy prompts and behaviour logs, which are context,
not a new turn.

Fix: tag messages with a source. Only user/other-agent messages should bump
`most_recent_msg_time`. Policy prompts and behaviour logs should append to
history and let the in-flight response land.

Cheapest partial: in `Agent.handleMessage`, don't bump the timestamp for
`source === 'system'` messages that start with `(POLICY RULE`.

## 4. Behaviour logs are chatty enough to be a denial of service on their own

`Recent behaviors log: Aaa! A spider!` arrived repeatedly while cowardice mode
re-fired every few seconds. Each one is a message, and by #3 each one kills a
generation. Even with #1 and #2 fixed, a spider standing next to the bot can
starve it of thought indefinitely.

Fix: rate-limit or coalesce behaviour-log injection, and/or fold it into #3's
"doesn't bump the clock" category.

## 5. Prompt-only rules have no shared budget

Six prompt rules can be eligible in the same tick (seen: shelter_when_night,
craft_a_weapon, get_a_bed, build_storage_chests, take_stock_when_idle, plus
food_gathering's). All six dispatch back-to-back at :771 with no arbitration —
the model receives five instructions it will never read and acts on, at best,
the last.

Fix: at most one `prompt_self` dispatched per tick, chosen by pinned-then-
RULE_ORDER like the mode arbiter already does for actions. Drop the rest;
their cooldowns will bring them back.

---

## Rule-level mitigations deployed 2026-08-04

Workarounds for the above, not fixes. Revisit once #1–#5 land — most of these
guards exist only to keep the prompt count down and can be relaxed.

- Added explicit `{"cond":"is_idle"}` to every prompt-only rule in both
  profiles, since `interrupts: "idle"` does nothing (#1).
- Serialised the prompt chain behind a "has a sword" gate: `get_a_bed`,
  `build_storage_chests`, `take_stock_when_idle` and food_gathering's four
  prompt rules now require a sword in inventory. Unarmed, `craft_a_weapon` is
  the only rule allowed to speak.
- `take_stock_when_idle` keeps an escape hatch: it also fires when there is no
  log and no planks, i.e. when `craft_a_weapon` cannot fire either and the
  sword gate would otherwise leave the bot silent.
- `craft_a_weapon`: cooldown 180 -> 90 (it is the head of the chain now), and
  its trigger widened from `log >= 1` to `log >= 1 or planks >= 2` — a bot that
  had already crafted its logs into planks could never satisfy the old one.
- Destaggered cooldowns so independent rules stop re-aligning: get_a_bed
  300->360, build_storage_chests 300->420, take_stock_when_idle 300->480,
  bake_bread 120->300, hunt_when_meat_is_short 120->240, cook_raw_meat 90->180.

Note: `bots/<name>/policy.json` holds a *compiled snapshot* of the merged
profiles, so editing `policies/*.json` alone changes nothing at runtime. The
deploy patched the compiled active layer directly (backup at
`policy.json.bak` in the container) rather than re-running the LLM merge, which
is nondeterministic and could have dropped the edits. A `!policy` regen command
that recompiles from disk without an LLM call when the merge is a plain union
would be worth having.

---

# Second pass — after the prompt storm cleared (2026-08-04, same session)

With the prompt storm gone the bot immediately made real progress for the first
time: pine_planks -> sticks -> wooden_sword -> wooden_pickaxe -> mined stone ->
attempted stone_sword. The sword gate then opened and `get_a_bed` /
`build_storage_chests` started firing as intended. Discards dropped from
constant to zero over the first four minutes.

That exposed the next layer of problems.

## 6. `!newAction` can produce no output, and the model reads that as success

Repeatedly in the log:

    Generated response: I'm stuck ... !newAction("...dig up to open space...")
    Action output:
    Generated response: Great, I'm out. !searchForEntity("sheep", 64)
    Action output:
    Could not search for sheep: every attempt to travel failed ...

`Action output:` with nothing after it. The generated code itself is fine —
checked the full block in the log, it is complete and sensible (equips the
shovel, scans upward, digs). It simply never calls `skills.log`, so it produces
no output even when it runs to completion.

An empty action output is indistinguishable from success to the model, so it
declared "Great, I'm out" three times without having moved. That is what made
the stuck loop unbreakable.

Fix: never return an empty action output. When generated code finishes having
logged nothing, synthesise a result from observable state — at minimum whether
the bot's position changed: "the code ran but reported nothing, and you are
standing where you started." Silence currently reads as success, which is the
worst possible default for an escape action.

## 7. Wood families are correct on modded servers, but expand to 315 names

I suspected `has_item log` was blind to the bot's `regions_unexplored:pine_log`.
It is not — verified in-container against the real registry with the mod pack
applied:

    WOOD_TYPES: 315 | pine: ["regions_unexplored:pine","pine",
                             "snifferplus:stone_pine","stone_pine"]
    expandBlockName("log")    -> 315 names, incl. regions_unexplored:pine_log
    expandBlockName("planks") -> 315 names, incl. regions_unexplored:pine_planks

`deriveWoodTypes()` works, and both namespaced and bare spellings are kept as
the comment at mcdata.js:76 promises. No correctness bug here. Recording it
because it was the obvious suspect and ruling it out costs someone an hour.

The real cost is CPU. 315 is not a family, it is a catalogue:

- `chipped:` alone contributes ~11 cosmetic variants per vanilla wood
  (`chipped:damaged_oak_log`, `chipped:firewood_birch_log`, ...), all ending in
  `_log`, all becoming "wood types".
- Every name is doubled by the bare/namespaced pair.
- Most have no corresponding `_planks` block at all, so ~300 of the 315 names
  `expandBlockName("planks")` returns match nothing anywhere.

`block_nearby {name: "log"}` resolves that list and scans for all of it, and
`gather_wood_for_base` runs exactly that at range 24. Given how hard the rest of
this file fights per-block scan cost (see the `getNearestBlocks` comment at
mcdata.js:419 — one scan profiled at 56.9% of agent CPU), a 315-name family
lookup inside a rule condition is worth measuring.

Fix: filter derived wood types to those that actually have a matching `_planks`
block, which drops the `chipped:` cosmetics and most of the tail. Consider
resolving to state ids once per registry rather than per call.

## 8. The pathfinder cannot move at all in this biome, and dig cost is not why

**RESOLVED — see the sixth pass below. The bot had sealed itself inside its own
shelter, on the instructions of `shelter_when_night_and_no_bed`. The pathfinder
was never at fault. Leaving the investigation below because the eliminations in
it are still useful.**

Every travel attempt failed for the entire second half of the session —
`searchForEntity`, `moveAway`, and the halved-distance fallback in
`searchForEntity` (skills.js:1707) all returned "you never left where you are
standing".

Ruled out: dig cost. Checked the mod data for every block in this biome —
`minecraft:snow_block` (0.2), `regions_unexplored:frozen_grass` (0),
`regions_unexplored:pine_leaves` (0.2), `regions_unexplored:pine_log` (2),
`minecraft:powder_snow` (0.25) — all `diggable: true`, all far under
`MAX_HAND_DIG_MS`. The `harvestCheck` exclusion at mcdata.js:493 should not be
firing on any of them. The extensive existing comments about snow and A*
(mcdata.js:480-495) describe a problem that appears to be already fixed.

Leading hypothesis, untested: the bot dug straight up three times on its own
initiative and is now standing in a pine canopy. `NOT_GROUND` (skills.js:2627)
lists both `leaves` and `snow`, so if it is standing on leaves there may be no
valid ground goal anywhere near it and every goal is rejected before A* runs.
That would explain why digging up made it worse each time.

Next step when picking this up: get the bot's actual position and the blocks
under it at the moment of failure. The failure message should include them —
"every attempt to travel failed" should say where it was standing and what it
was standing on, otherwise this is undiagnosable from logs alone. That
diagnostic is worth adding regardless of the root cause.

## 9. `searchForEntity` spends the whole session on an unwinnable search

Independent of the pathfinder bug: a taiga has very few sheep, and
`!searchForEntity sheep 500` is a long operation that the bot re-ran on failure
because `get_a_bed` told it to. The repeat-command guard did fire
("(REPEATED COMMAND) You have run !searchForEntity with the same arguments 3
times") but the rule's own text overrode it — the message said "Coming up empty
is never a reason to start mining, crafting, or anything else", which is exactly
what the bot obeyed.

Lesson for rule text generally: an absolute "do not do anything else until X"
is only safe if X is always achievable. Every such clause needs an escape for
the case where the world does not cooperate.

---

## Rule changes deployed in the second pass

- `get_a_bed`: dropped the "do not start anything else until the bed is placed"
  clause and replaced it with failure-mode triage — distinguish "searched and
  found nothing" (retry, different pattern) from "could not travel at all"
  (stop; this cannot work), tell it not to dig up, tell it to dig sideways 10+
  blocks, and permit abandoning the bed for the night if travel still fails.
- `take_stock_when_idle`: added the same don't-dig-up guidance plus "an empty
  action result means nothing happened, not that it worked" — a direct
  workaround for #6 until that is fixed properly.

Both mitigate symptoms only. #6 and #8 are the real bugs.

## Deploy notes for whoever picks this up

`policies/*.json` is not what runs. `bots/<name>/policy.json` holds a compiled
snapshot (`layers.active`), and regenerating it normally goes through an LLM
merge (`compilePolicy`). For these two profiles the merge is a plain union, so
the deploy rebuilt the active layer deterministically in Python and patched it
in, then restarted the container. Backup at `bots/Andy/policy.json.bak`.

---

# Third pass (2026-08-04, same session)

The bed livelock cleared. The bot stopped re-running the impossible sheep search,
fled a vindicator, relocated, and started sealing itself in for the night —
which is exactly what stayin_alive is supposed to produce. Travel also worked
fine from the new location, which supports the canopy hypothesis in #8: the
pathfinder was not broken, the bot had climbed somewhere with no valid ground
goal near it.

## 10. `hold_weapon_when_threatened` is a denial of service on long actions

Seen repeatedly in the log:

    action "mode:policy:active:hold_weapon_when_threatened" trying to interrupt
      current action "action:searchForEntity"
    ... trying to interrupt current action "action:moveAway"
    ... trying to interrupt current action "action:newAction"

The rule is `interrupts: all`, `pinned`, cooldown 6, condition
`hostile_nearby range 12`. A weapon stays equipped once equipped, so every fire
after the first is a no-op that still cancels whatever was running. In a modded
world where something hostile is within 12 blocks more or less permanently, that
is one cancelled action every 6 seconds, forever. No travel or dig that takes
longer than 6s can ever complete.

Deployed mitigation: cooldown 6 -> 45.

The real fix is a condition for what the bot is holding, so the rule can be
`hostile_nearby AND NOT holding_weapon`. There is no such condition today —
CONDITIONS is `hostile_nearby, entity_nearby, block_nearby, animal_nearby,
player_nearby, health_below, hunger_below, has_item, has_food, at_position,
drowning, is_night, is_idle, always`. Adding `holding` / `equipped` would let
this rule and others become genuinely self-limiting instead of cooldown-tuned.

Related: actions could declare that they satisfy their own trigger. `equip_weapon`
already has a `clears` mechanism available (other actions use it) — if firing
`equip_weapon` cleared `hostile_nearby` for that rule's purposes, or if the rule
engine skipped a fire whose action is already satisfied, no cooldown tuning
would be needed at all.

## Rule changes deployed in the third pass

- `hold_weapon_when_threatened`: cooldown 6 -> 45 (see #10).
- `find_food_when_low`: hunger threshold 13 -> 15. Finding food in a frozen
  taiga takes many minutes and this bot travels badly; at 13 it reached
  `eat_when_starving` (7) before a search could finish.

## Still open at end of session

- The bot has no food at all and none of the food_gathering rules have fired
  once. `hunt_when_meat_is_short` needs `animal_nearby 24`, and there is no
  livestock in this taiga. The forage rules need carrots/potatoes/berries/wheat
  nearby, none of which grow here either. food_gathering as written assumes a
  temperate biome; in a frozen taiga it is inert. If the bot is meant to survive
  here it needs a rule for the food sources that actually exist in this biome
  (fishing is the obvious one — needs a `craft a fishing rod` and a `fish when
  water is nearby` rule, neither of which exist).
- Still no bed. Sheep genuinely may not exist within range.
- Discards dropped from constant to ~5 per 9 minutes, all attributable to #2/#3.

---

# Fourth pass (2026-08-04, same session)

## Evidence for #5 from the full container log history

Counting rule fires across the whole retained log (many restarts, not just this
session) puts a number on the prompt-budget problem:

    959  POLICY RULE 'active:avoid_death_spot_unarmed_pinned'
    212  POLICY RULE 'self:avoid_death_spot_unarmed_pinned'
     74  POLICY RULE 'self:craft_wooden_sword_if_possible'
     74  POLICY RULE 'active:take_stock_when_idle'
     71  POLICY RULE 'self:craft_crafting_table_if_needed'
     69  POLICY RULE 'self:craft_wooden_pickaxe_if_possible'
     ... 2077 discards, 4317 interrupts over the same span

One rule fired 959 times. Whatever it was meant to accomplish, it did not, and
it spent 959 generations to not accomplish it.

Note how many of these are `self:` — rules the agent wrote for itself. The
self-authored layer is at least as big a storm source as the curated profiles,
and it is not covered by any of the rule-level mitigations deployed here, since
those only touch `policies/*.json`. A per-tick prompt budget (#5) is the only
thing that bounds the self layer, which is a further argument for fixing it in
the engine rather than by tuning rule text.

Also worth a look: a rule that has fired hundreds of times without its trigger
condition ever going false is by definition not working. The engine already has
a `backoff` field on Rule that doubles up to 200x when a rule's steps make no
progress — but prompt-only rules never run steps, so they never back off. They
should: if a prompt-only rule fires N times and its condition is still true,
double its cooldown too.

## Verification of the deployed rule changes

Measured over the last clean restart window:

    interrupts: 0        (was constant, one every ~6s)
    discards:   2        (was one per generation)
    go_find_food_when_none_in_reach fired as intended

Behaviour over the session went from "unarmed, standing in the open at night,
every decision discarded" to: crafted planks -> sticks -> wooden sword ->
wooden pickaxe -> mined stone -> fled a vindicator -> dug and sealed a shelter
-> placed a torch -> `!rememberHere base` -> crafted a crafting table -> started
on chests. That is the intended stayin_alive arc and it had never previously
got past step one.

Still no bed and still no food, but both are now blocked on the world (no sheep
found, biome has no forage) rather than on the agent cancelling itself.

## Full list of rule changes deployed this session

`policies/stayin_alive.json`:
- `craft_a_weapon`: cooldown 180->90; trigger widened `log>=1` -> `log>=1 or planks>=2`; added `is_idle`
- `get_a_bed`: +sword gate, +`is_idle`, cooldown 300->360, message rewritten for travel-failure triage
- `build_storage_chests`: +sword gate, +`is_idle`, cooldown 300->420
- `take_stock_when_idle`: +sword-or-no-wood gate, cooldown 300->480, message rewritten (don't dig up; empty output != success)
- `hold_weapon_when_threatened`: cooldown 6->45
- `find_food_when_low`: hunger threshold 13->15
- `craft_shovel_for_snow`, `shelter_when_night_and_no_bed`, `take_food_from_storage`, `expand_storage_room`: +`is_idle`

`policies/food_gathering.json`:
- `bake_bread` (cd 120->300), `hunt_when_meat_is_short` (120->240), `cook_raw_meat` (90->180), `build_a_furnace_for_cooking`: +`is_idle`, +sword gate
- NEW `go_find_food_when_none_in_reach` (cd 240): the only rule in the profile that does not require food to already be within 24 blocks

All 28 composed rules pass `validatePolicy`.

---

# Fifth pass (2026-08-04, same session)

With interrupts eliminated the bot finally got to attempt a large `!newAction`
(build a base: place crafting table, craft chests and furnace, wall a room,
torch it, save the location). It then spent ~20 minutes producing nothing.

## 11. Skill-doc selection omits movement skills, and the lint loop can't recover

The generated code failed linting:

    Linting error: 'goals' is not defined.
    Line 28: await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1));

The docs selected for this task were:

    skills.clearNearestFurnace, skills.putInChest, world.getNearestFreeSpace,
    skills.smeltItem, skills.placeBlock, skills.wait, skills.breakBlockAt

Not one movement skill — for a task whose first instruction is "Move a few
blocks to a clear, flat spot nearby." There are eight to choose from
(`goToPosition`, `goToGoal`, `goToXZ`, `goToNearestBlock`, `goToNearestEntity`,
`goToPlayer`, `goToBed`, `goToSurface`, skills.js:1347-2659). With none of them
documented, the model reasonably reached for the raw pathfinder API and guessed
at `goals` — which is not in the codegen scope. `Vec3` is injected
(coder.js:7, :245); `goals` is not.

Two separate bugs:

1. **Doc selection.** A task containing "move to" should always surface at least
   one movement skill. Whatever the selector scores on, it missed the single
   most important verb in the prompt.

2. **The retry loop cannot converge.** `MAX_ATTEMPTS = 5` (coder.js:79) and the
   selected docs do not change between attempts, so the model retries the same
   task with the same incomplete API surface and makes the same class of
   mistake. Each attempt is a full generation of a ~100-line program, so five
   attempts is 20+ minutes of wall clock to produce nothing. The comment at
   coder.js:175 records this exact failure happening before ("gave up with
   'Code generation failed after 5 attempts' four times in half an hour"), so
   this is a known-recurring dead end, not a one-off.

   Cheapest fix: when the lint error is `'X' is not defined`, feed X back into
   doc selection for the retry. `goals` -> movement skills. That turns a blind
   retry into a targeted one, which is exactly what the comment at coder.js:170
   says the code already tries to do for a different error class — it just does
   not cover undefined identifiers.

   Also worth simply putting `goals` in the codegen scope alongside `Vec3`. The
   model keeps reaching for it because it is the natural mineflayer API, and it
   is one line to stop being a trap.

## Session end state

Bot is alive, armed, sheltered, and burning attempts on the base-building
newAction above. No bed (no sheep found in range), no food (biome has none of
what food_gathering looks for, and the new search rule had just started firing).

The rule changes did what they were meant to: the agent now completes its
decisions instead of cancelling them, and every remaining blocker is either the
world being unhelpful or one of the code bugs listed here.

---

# Sixth pass — the actual cause of #8 (2026-08-04/05, same session)

Found it in the retained container log, in the bot's own saved memory:

    Name:Andy. Goal:Survive. Died 10x. Loc:frozen pine taiga.
    ... NEVER wall yourself in: you built 3x3 shelters around yourself
    repeatedly and then could not travel. Always leave an exit.

That is #8. The pathfinder was never broken and it was not a tree canopy. The
bot had sealed itself inside its own shelter and then spent the session unable
to travel anywhere, which is exactly the "every attempt to travel failed"
message, repeated for as long as it stayed in the box.

And the rule that told it to do this was `shelter_when_night_and_no_bed`:

    "...seal the hole above you with dirt, cobblestone or planks, leaving no
     opening a mob can path through."

Written to keep mobs out, read as "build a box with no way out". The bot obeyed
it correctly. The rule was wrong.

Fixed and deployed: the message now says explicitly that a shelter it cannot
leave is worse than the mob, tells it to use only breakable blocks, not to seal
all four sides plus a roof, to know in advance which single block it will break
to get out, to leave at first light, and — because this is the failure it
actually hits — that "I cannot travel anywhere" should make it suspect it is
still inside one of these shelters and break out sideways at feet level first.

## 12. The agent's self-memory outlives and overrides corrected rule text

The same memory dump contains:

    CRITICAL: NEED BED NOW. ... NEVER start anything else until bed placed.

That sentence is the clause I *removed* from `get_a_bed` in the second pass. The
agent had already copied it into its persistent memory, where it survives
policy edits, container restarts, and the rule text no longer saying it.

This is a real limit on fixing behaviour through rule text alone: a bad
instruction that has been live for a while has already been laundered into
memory, and correcting the rule does not correct the memory. The bot is still
carrying "never start anything else until bed placed" for a bed it may never be
able to get.

Worth having: when a policy rule's text changes materially, a way to invalidate
or flag memory entries that were derived from the old text. At minimum, a manual
`!forget` so an operator can clear a specific bad belief without wiping the
whole memory.

Also seen and not yet chased:
- `Agent process exited with code 1 and signal null` — a crash, cause not
  determined.
- A self-authored policy failed to compile: rule `night_frozen_biome_relocate`
  produced `"until": "(block_nearby ..."` — an unparenthesised-condition bug in
  whatever generates `stay.until` strings for self-issued rules. The validator
  caught it, so it is not dangerous, but that rule was silently lost.
- "Died 10x" in memory, and a later entry says 26 deaths in 6 minutes. Worth
  pulling death events out of the log as their own timeline.

**Follow-up on #12:** checked the live memory afterwards and the bad clause is
gone — the agent had rewritten its memory to:

    Base at (62,63,119): sealed pine shelter, torch inside. Goal: bed ASAP
    (3 wool+3 planks); always carry weapon; use wooden tools. ...

So the contamination is self-limiting rather than permanent: memory gets
rewritten often enough that a removed instruction washes out on its own. #12 is
still worth knowing about — the clause did survive several restarts and was
actively steering behaviour while the corrected rule was already live — but it
does not need a `!forget` command to recover from. Downgrade it from "needs a
fix" to "expect a lag between changing rule text and seeing the behaviour
change, and do not conclude a rule edit failed until the memory has turned over."

---

# Seventh pass — stability (2026-08-05, same session)

The container kept coming back up on its own. It is not the container crashing —
the agent process inside exits and the `unless-stopped` policy restarts it.
Counts over the full retained log:

    222  Agent process exited
    190  "nowhere to go. You may be stranded"
     15  Disconnected: {"translate":"disconnect.timeout"}
      3  TypeError: stateGoal.isValid is not a function

    247  Error: PathStopped
     70  Error: missing ingredient   (+51 double-wrapped "Error: Error: missing ingredient")
     45  Error: Failed to obtain profile data for Andy, does the account own minecraft?
     31  Error: write EPIPE
     25  Error: GoalChanged
     23  Error: Event windowOpen did not fire within timeout of 20000ms
     17  Error: write ECONNRESET
     16  Error: NoPath
     10  Error: Timeout: Took to long to decide path to goal

## 13. `stateGoal.isValid is not a function` is an uncaught crash

    TypeError: stateGoal.isValid is not a function
      at monitorMovement (node_modules/mineflayer-pathfinder/index.js:450:22)
      at tickPhysics (node_modules/mineflayer/lib/plugins/physics.js:83:11)

Thrown from inside a physics tick, so nothing catches it and the process dies.
Something is handing the pathfinder a goal object that is not a real Goal —
worth auditing every `setGoal`/`goto` call for a plain object or a goal built
from a constructor that failed. Only 3 occurrences, but each one is a hard kill.

## 14. Being stranded correlates with getting kicked off the server

The timeout disconnects follow immediately after a stranded `!moveAway`:

    Agent executed: !moveAway and got: Action output:
    Could not move away from (12, 55, -3): nowhere to go. You may be stranded...
    Agent Andy disconnected
    Disconnected: {"translate":"disconnect.timeout"}
    [LoginGuard] Network Error: Connection timed out or was lost.
    Agent process exited with code 1

My first reading was that entombment causes this — walled in, the escape paths
run repeated synchronous world scans, block the event loop, the bot misses
keepalives and gets kicked.

**That is at most partial.** A later `disconnect.timeout` occurred with no
stranding anywhere near it: the bot was moving normally, a policy prompt was
delivered, memory was saved, and then:

    Saved memory to: ./bots/Andy/memory.json
    Disconnected: {"translate":"disconnect.timeout"}
    [LoginGuard] Network Error: Connection timed out or was lost.
    Agent process exited with code 1

So the timeout is an independent failure, not purely a symptom of #8. Something
in the normal path — plausibly the synchronous memory save, or the history
serialisation that precedes it — blocks long enough to miss keepalives.
Entombment probably makes it much more likely; it is not the only cause.

Worth timing `Saved memory to:` — it appears immediately before this
disconnect and before several others, which makes it the obvious first suspect
for an event-loop stall.

**Found it.** `History.appendFullHistory` (src/agent/history.js:63-77):

    const data = readFileSync(this.full_history_fp, 'utf8');
    let full_history = JSON.parse(data);
    full_history.push(...to_store);
    writeFileSync(this.full_history_fp, JSON.stringify(full_history, null, 4), 'utf8');

Every message read the **entire** history file, parse it, append, re-serialise
it with 4-space indent, and write it all back — synchronously, on the main
thread. The file only grows. Actual sizes in the container right now:

    562043  7-31-2026_8-55-08AM.json
    304021  8-3-2026_5-22-34PM.json
    264864  7-30-2026_2-41-25PM.json
    ...     2.6M total across histories/

**I initially concluded this was the main cause of the 222 deaths. That was
wrong — see "The actual cause" below.** The recent history files are 2.8-20 KB,
because each agent respawn starts a fresh file and the runs are short. At that
size the read+parse+write is sub-millisecond and cannot stall anything. The
562 KB file dates from a long uninterrupted session on Jul 31.

So this is a real inefficiency that would bite a long-lived session, and it is
worth fixing on its own merits, but it is not what is killing the bot now.

Fix (still worth doing, just not urgent): append instead of rewrite. JSONL —
one record per line via `appendFileSync`, or better an async write queue —
makes it O(1) per message instead of O(n) and drops the pretty-printing that
doubles the write.

## The actual cause: the Minecraft server is unhealthy

    $ docker ps --filter name=minecraft-prominence2
    Up 41 hours (unhealthy)

    FailingStreak: 3277
    "failed to ping localhost:25565 : i/o timeout"   (repeating for 41 hours)

    [Server thread/WARN]: Can't keep up! Is the server overloaded?
      Running 2062ms or 41 ticks behind

The `minecraft-prominence2` container has been failing its healthcheck for
**41 hours straight** — 3277 consecutive failures — and is running two full
seconds behind. A server that far behind drops clients, which is exactly the
`disconnect.timeout` the agent then exits on. One of the three recent exits
says so outright:

    Disconnected: socketclosed
    [LoginGuard] Connection Failed: Server is under maintenance or restarting.

So the disconnect/timeout family of failures is **environmental**. No amount of
agent-side work fixes it. This also means the historical 222-death count is
inflated by however long the server has been in this state, and any stability
measurement taken against this server is measuring the server, not the agent.

Two consequences for anyone reading this file:

1. Do not tune agent stability against this server until it is healthy. Restart
   or investigate `minecraft-prominence2` first — a modpack this size running
   41 ticks behind usually means it needs more heap or has a runaway chunk
   loader.
2. The agent-side finding that survives is #14's *original* narrow point: on a
   `disconnect.timeout` the agent process **exits** rather than reconnecting.
   Given a server that drops clients regularly, a reconnect-with-backoff would
   turn every one of these into a blip instead of a death that loses all
   in-memory state. That is the real fix here, and it is more valuable than it
   looked when I thought the timeouts were self-inflicted.

This raises the priority of the shelter rule fix considerably: self-entombment
was not a behavioural wart, it was the main driver of a 222-restart loop.

Worth checking whether `disconnect.timeout` should be survivable at all — the
process exits on it rather than reconnecting, and there is already a
`LoginGuard` that notices. A reconnect with backoff would turn 222 process
deaths into 222 reconnects and preserve in-memory state.

## 15. Lower priority but noisy

- `Failed to obtain profile data for Andy, does the account own minecraft?` x45
  — Mojang auth flakiness. Should be retried, not fatal.
- `Error: Error: missing ingredient` x51 — double-wrapped error string; something
  is doing `new Error(err)` on an Error. Cosmetic but makes grepping harder.
- `Event windowOpen did not fire within timeout of 20000ms` x23 — chest/furnace
  interaction hanging for 20s at a time.
- 247 `PathStopped` vs 25 `GoalChanged`: most path abandonment is the bot
  interrupting itself, which is what the `hold_weapon_when_threatened` cooldown
  fix (#10) targets. Worth re-counting after that change has been live a while
  — it should drop sharply, and if it does not, there is another interrupter.

---

## 16. The supervisor's backoff can never engage for a slow death loop

`src/process/agent_process.js`:

    :48  this.restart_attempts++;
    :49  const delay = Math.min(5000 * 2 ** (this.restart_attempts - 1), MAX_BACKOFF_MS);
    :50  "Agent process exited too quickly. Retrying in Ns..."
    ...
    :54  this.restart_attempts = 0;
    :56  this.start(true, 'Agent process restarted.', count_id);

Backoff applies only when the process exits *too quickly*. Any exit after that
threshold resets `restart_attempts` to 0 and respawns immediately. So a bot that
runs for a few minutes and then dies — which is exactly this bot's failure mode —
respawns instantly, forever, and the backoff branch is never reached. 222 deaths,
no throttle, no escalating signal, nothing above `console.log`.

The quick-exit guard is the right idea aimed at the wrong failure. A crash loop
that takes four minutes per cycle is still a crash loop. Suggest tracking deaths
per rolling window rather than consecutive-fast-exits, and escalating loudly
(and visibly outside the log) when the rate stays high.

---

# Closing state (2026-08-05 ~05:07Z)

Over a continuous 15-minute window after the last deploy:

    Agent process exits:  0   (was 222 over the container's life)
    "nowhere to go":      1   (was 190)
    "travel failed":      0
    interrupts:           9   (was one every ~6s)
    discards:             5   (was one per generation)

Precision on that window: the container started at 05:00:21Z (my own shelter-fix
deploy restart) and these numbers were read at ~05:06Z, so it is ~6 minutes of
*uninterrupted* runtime plus a clean stretch of the previous run before it —
15 minutes of wall clock with zero agent deaths, spanning one deliberate
restart. Not "survived 15 minutes straight". Against 222 prior deaths it is
still a clear signal, but it is a short window and wants re-checking over hours
before anyone calls it fixed.

In that window the bot worked through a coherent tool chain unprompted —
crafting_table -> stick -> wooden_sword -> wooden_shovel — and said why:
"Got a wooden sword. Now I'll make a shovel so I can actually move through
snow." That is `craft_shovel_for_snow` doing exactly its job, which it had
never previously survived long enough to reach. It then set a base and began
building out.

Caveat: 3 more `Linting error` events in the same window, so #11 is still
live and still burning generations.

And the shelter behaviour changed in the way the rule fix intended — the bot's
own newAction now reads:

    "Build a small safe pine shelter here: clear a 5x5 area, place pine log
     walls 3 blocks high, pine plank roof, 1x2 [entrance]..."

It is asking for an entrance. Before the fix it was asking to "place pine_planks
on all four sides and on top to completely seal the hole, leaving no openings",
which is the instruction that produced the 190 stranded events.

**Correction on the "container keeps restarting" worry:** it does not. I was
reading successive `docker ps` "Up 2 minutes" / "Up 4 minutes" as separate
restarts when it was one container aging normally. `RestartCount=0` and a single
unchanging `StartedAt=2026-08-05T05:00:21Z` confirm it — the only restart was my
own shelter-fix deploy, and it has been stable since.

That also reframes #13/#14. `docker logs` persists across the container's whole
life (466k lines), and `RestartCount` is 0, so the 222 `Agent process exited`
events were never container deaths — they are the **inner** supervisor
(`src/process/agent_process.js`) respawning the agent child process. The bot
died and was resurrected 222 times without the container noticing.

That is better news for stability and worse news for observability: 222 agent
deaths produced no container-level signal at all, so nothing outside the log
would ever have flagged it. Worth emitting a metric or at least a loud,
greppable line with a running count when the supervisor respawns — "agent
respawn #47" would have made this session's diagnosis five minutes long.

## Cleanest measurement — current run only

Later in the session, counting only the log since the most recent
`Andy logged in` (no pre-restart contamination):

    lines:        1292
    exits:           0
    "nowhere to go": 0
    travel failed:   0
    discards:        1
    interrupts:      5
    lint errors:     3

    Rules fired:  craft_a_weapon        x1
                  craft_shovel_for_snow x1
                  get_a_bed             x1

That rule pattern is the whole point. Each rule fired **once**, the bot acted on
it, and the condition went false — sword, then shovel, then off to find a sheep.
Compare the historical counts: one rule at 959 fires, `take_stock_when_idle` at
74, all of them re-firing forever because nothing they asked for ever completed.
The storm is gone and the rules are behaving as a priority chain rather than a
shouting match.

Remaining in this window: 3 lint errors (#11, unfixed) and 5 interrupts.

## Confirmation of the one net-new rule

`go_find_food_when_none_in_reach` was the only rule added rather than tuned, and
it produced the reasoning it was written to produce. Unprompted, from the log:

    "I'm stuck in snow -- moving out of it first, then hunting for food."
      !moveAway(20)
    "I'm out of snow; now let's find food that actually fits this biome.
      I'll search for sweet_berry_bush first."
    "this biome's a pine taiga, so sweet berry bushes are [the food here]"
      !searchForBlock("sweet_berry_bush", 128)

That is the whole point of the rule: every other rule in food_gathering waits
for cows, wheat, carrots or potatoes to appear within 24 blocks, none of which
exist in a frozen taiga, so the profile was inert. This rule sends the bot
looking, and the message deliberately names what grows *here* rather than what
the profile wishes were here.

Note it also recovered from a stuck-in-snow state on its own (`!moveAway(20)`)
instead of digging upward into a tree — the behaviour the second-pass message
edits were aimed at.

Run totals at this point: 1430 lines, 0 exits, 0 strandings, 0 travel failures,
3 discards, and every policy rule fired exactly once.

## Post-death recovery behaves correctly

After dying to a zombie and losing its inventory, the bot rebuilt from nothing
without any prompting beyond the rules:

    "I'm at (22.49,70,1.66) with pine_log:19, no planks, no sticks, no sword,
     no shovel. I need to craft basic tools and head back to my base. First
     I'll craft pine planks from logs, then sticks, then a wooden sword and
     wooden shovel, then return to base."

`craft_a_weapon` fired once, `craft_shovel_for_snow` fired once, and the bot
executed the chain. This is the same clean single-fire pattern as before the
death — the rules re-arm correctly after an inventory wipe and do not storm.

Note this also exercised the widened `craft_a_weapon` trigger: the bot had
`pine_log:19` and no planks, and the original `log >= 1` condition would have
matched here too — but had it died holding planks instead of logs, the old
condition would have left it permanently unarmed. That is the case the
`log >= 1 or planks >= 2` widening covers.

## Caveat on every duration in this file

The docker host's clock advanced only ~30 seconds across wall-clock intervals
where I had waited many minutes, so `StartedAt`/`date` deltas from that host are
not trustworthy and every "N minutes" here should be read as approximate. The
*event counts* (exits, strandings, travel failures, rule fires) come straight
from the log and are reliable; the durations they are divided by are not. If
someone wants a real soak measurement, count events between two known log
markers rather than trusting host timestamps.

## What to pick up first

0. **Fix the Minecraft server, then re-measure.** `minecraft-prominence2` has
   been unhealthy for 41 hours and runs 41 ticks behind; it is dropping clients.
   Every stability number in this file is contaminated by it. Nothing else on
   this list can be evaluated honestly until that is sorted.
1. **Reconnect instead of exiting on `disconnect.timeout`** (#14). With a flaky
   server this converts a death into a blip and preserves in-memory state.
3. #10's root fix — a `holding`/`equipped` condition — is the single highest
   leverage item. The cooldown bump works but is a tuning hack.
4. #1 and #2 together: make `interrupts: "idle"` real for prompt-only rules and
   make `isIdle()` false during generation. Most of the deployed rule guards
   exist only to work around these and can be deleted afterwards.
5. #11's targeted retry (feed the undefined identifier back into doc selection,
   and put `goals` in the codegen scope) — cheap, and it recovers 20-minute
   dead ends.
6. #13 `stateGoal.isValid` — rare but a hard kill.
